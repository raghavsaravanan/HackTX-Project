import type { Response } from "express";
import type {
  AskResponse,
  ListenResponse,
  CommandType,
  LineSource,
  MissionState,
  PipelineStage,
  PlayerStats,
  Quest,
  QuestMap,
  QuestStep,
  SavedQuestSummary,
  Scene,
  ShareState,
  ServerEvent,
  SessionSnapshot,
  SessionStatus,
  Sfx,
  StepObservation,
  VisionCheck,
  VoiceIntent,
} from "../shared/types.ts";
import { fetchCameraFrame } from "./cameraLink.ts";
import { config, questMode, redact, visionMode } from "./config.ts";
import { freshStats, rewardQuest, rewardStep } from "./game.ts";
import { computeGuidance, type SeenAt } from "./guidance.ts";
import { anchorLabel, applyNotes, buildMap, findLandmark, markSeen, mergeScene, setPlayerAt } from "./map.ts";
import { NARRATOR } from "./prompts.ts";
import {
  askAgent,
  describeScene,
  hint,
  narrate,
  looksAddressed,
  parseIntent,
  planQuest,
  quickCommand,
  reactToVerdict,
  understand,
  type AgentState,
  type AgentTurn,
  type Understanding,
} from "./questAgent.ts";
import { cloudVoiceEnabled, registerSpeakLine } from "./tts.ts";
import { messagesAvailable } from "./providers/messages.ts";
import { SHARE_QUESTION, handleShareReply, shareConsumes, shareOffer } from "./share.ts";
import { timed, uid } from "./util.ts";
import { inspect, observeStep, scanScene } from "./vision.ts";
import { matchWake, wakePhrase } from "./wake.ts";

type Role = "stage" | "phone";

interface Session {
  id: string;
  status: SessionStatus;
  quest: Quest | null;
  stepIndex: number;
  stepStartedAt: number | null;
  questStartedAt: number | null;
  questEndedAt: number | null;
  stats: PlayerStats;
  lastSay: string;
  lastSayAt: number;
  lastTranscript: string;
  /** Sequence of the newest analyzed camera frame; older results are ignored for progression. */
  lastSeq: number;
  doneStreak: number;
  recent: StepObservation[];
  mockTick: number;
  hintsThisStep: number;
  hintsThisQuest: number;
  lastHintAt: number;
  hintInFlight: boolean;
  missions: MissionState[];
  map: QuestMap;
  /** The Vision Agent's most recent survey of the surroundings. */
  scene: Scene | null;
  surveyFrameId: number;
  verifying: boolean;
  lastVerifyAt: number;
  /** What the player asked for, used to plan follow-up steps if the goal check fails. */
  goal: string;
  /** Rounds of extra steps added because the goal check found the task unfinished. */
  followUps: number;
  /** Where quest objects were last seen in the frame, for steering when they leave the view. */
  lastSeen: Record<string, SeenAt>;
  /** Quests paused for newer requests, most recent first, with their progress and map. */
  saved: SavedQuest[];
  /** Bumped on every new plan request, so a slower, older plan can't replace a newer one. */
  planToken: number;
  /** Offering to share a finished quest with a contact through Messages; null otherwise. */
  share: ShareState | null;
  link: { seq: number; frameId: number; inFlight: boolean };
  /** Hands-free listening: follow-ups need no wake phrase until this time. */
  awakeUntil: number;
  /** The last utterance was the bare wake phrase, so the next one is trusted fully. */
  armed: boolean;
  subscribers: Set<{ res: Response; role: Role; clientId: string }>;
  /** The phone page that speaks and listens; other open phone pages for this session stay quiet. */
  speakerId: string;
}

/** Everything needed to pick a paused quest back up where it left off. */
interface SavedQuest {
  quest: Quest;
  stepIndex: number;
  missions: MissionState[];
  map: QuestMap;
  goal: string;
  followUps: number;
  questStartedAt: number | null;
  hintsThisQuest: number;
  savedAt: number;
}

const MAX_SAVED = 3;

const sessions = new Map<string, Session>();

export function getSession(id: string): Session {
  let s = sessions.get(id);
  if (!s) {
    s = {
      id,
      status: "idle",
      quest: null,
      stepIndex: 0,
      stepStartedAt: null,
      questStartedAt: null,
      questEndedAt: null,
      stats: freshStats(),
      lastSay: "",
      lastSayAt: 0,
      lastTranscript: "",
      lastSeq: -1,
      doneStreak: 0,
      recent: [],
      mockTick: 0,
      hintsThisStep: 0,
      hintsThisQuest: 0,
      lastHintAt: 0,
      hintInFlight: false,
      missions: [],
      map: buildMap(null, null),
      scene: null,
      surveyFrameId: -1,
      verifying: false,
      lastVerifyAt: 0,
      goal: "",
      followUps: 0,
      lastSeen: {},
      saved: [],
      planToken: 0,
      share: null,
      link: { seq: 0, frameId: -1, inFlight: false },
      awakeUntil: 0,
      armed: false,
      subscribers: new Set(),
      speakerId: "",
    };
    sessions.set(id, s);
  }
  return s;
}

export function snapshot(s: Session): SessionSnapshot {
  return {
    id: s.id,
    status: s.status,
    quest: s.quest,
    stepIndex: s.stepIndex,
    stepStartedAt: s.stepStartedAt,
    questStartedAt: s.questStartedAt,
    questEndedAt: s.questEndedAt,
    stats: s.stats,
    narratorName: NARRATOR.name,
    wakePhrase: wakePhrase(),
    cloudVoice: cloudVoiceEnabled(),
    lastTranscript: s.lastTranscript,
    missions: s.missions,
    map: s.map,
    savedQuests: s.saved.map(summarizeSaved),
    share: s.share,
  };
}

function summarizeSaved(q: SavedQuest): SavedQuestSummary {
  const next = q.quest.steps[q.stepIndex];
  return {
    questId: q.quest.id,
    title: q.quest.title,
    goal: q.goal,
    done: q.missions.filter((m) => m.status === "done" || m.status === "skipped").length,
    total: q.quest.steps.length,
    next: next ? next.summary || `${next.action} ${next.target}` : "final check",
    savedAt: q.savedAt,
  };
}

const currentStep = (s: Session): QuestStep | null => s.quest?.steps[s.stepIndex] ?? null;

const agentState = (s: Session): AgentState => ({
  quest: s.quest,
  stepIndex: s.stepIndex,
  missions: s.missions,
  setting: s.map.setting,
  landmarks: s.map.landmarks,
  recent: s.recent,
  saved: s.saved.map(summarizeSaved),
});

// ---------- Server-sent events ----------

export function subscribe(s: Session, res: Response, role: Role) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  const sub = { res, role, clientId: uid("ph") };
  s.subscribers.add(sub);
  write(res, { type: "snapshot", snapshot: snapshot(s) });
  if (role === "phone") {
    // The newest phone page takes over speaking and listening (e.g. after rescanning the QR code).
    write(res, { type: "hello", clientId: sub.clientId });
    s.speakerId = sub.clientId;
    broadcast(s, { type: "speaker", clientId: s.speakerId }, "phone");
  }
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
  res.on("close", () => {
    clearInterval(heartbeat);
    s.subscribers.delete(sub);
    if (sub.clientId === s.speakerId) {
      // Hand speaking to the most recent phone page still open.
      const phones = [...s.subscribers].filter((x) => x.role === "phone");
      s.speakerId = phones.at(-1)?.clientId ?? "";
      if (s.speakerId) broadcast(s, { type: "speaker", clientId: s.speakerId }, "phone");
    }
  });
}

function write(res: Response, event: ServerEvent) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function broadcast(s: Session, event: ServerEvent, only?: Role) {
  for (const sub of s.subscribers) if (!only || sub.role === only) write(sub.res, event);
}

const pushSnapshot = (s: Session) => broadcast(s, { type: "snapshot", snapshot: snapshot(s) });

function say(s: Session, text: string, source: LineSource, sfx?: Sfx[], priority = false) {
  s.lastSay = text;
  s.lastSayAt = Date.now();
  // A reply keeps the conversation open so the player can answer without the wake phrase.
  if (Date.now() < s.awakeUntil) s.awakeUntil = Date.now() + config.agent.awakeMs;
  broadcast(s, { type: "say", id: registerSpeakLine(text), text, source, sfx, priority });
}

async function narrateTracked(s: Session, event: string, details: string, fallback: string) {
  broadcast(s, { type: "pipeline", stage: "narrate", status: "start" });
  const start = Date.now();
  const line = await narrate(event, details, fallback);
  broadcast(s, { type: "pipeline", stage: "narrate", status: "done", ms: Date.now() - start, detail: line.source });
  return line;
}

export function trackPipeline(s: Session, stage: PipelineStage, status: "start" | "done" | "error", ms?: number, detail?: string) {
  broadcast(s, { type: "pipeline", stage, status, ms, detail });
}

// ---------- Missions ----------

function setMission(s: Session, index: number, patch: Partial<MissionState>) {
  const mission = s.missions[index];
  if (mission) s.missions[index] = { ...mission, ...patch };
}

/** Apply the Quest Agent's status and map updates. Returns true if anything changed. */
function applyTurn(s: Session, turn: AgentTurn): boolean {
  let changed = false;
  if (turn.missionNote && s.missions[s.stepIndex] && s.status === "active") {
    setMission(s, s.stepIndex, { note: turn.missionNote.slice(0, 120) });
    changed = true;
  }
  if (applyNotes(s.map, turn.mapNotes)) changed = true;
  if (setPlayerAt(s.map, turn.playerNear)) changed = true;
  return changed;
}

// ---------- Frames ----------

/** The phone's newest frame from the camera server, or null when the camera is off. */
async function cameraFrame(): Promise<string | null> {
  return (await fetchCameraFrame())?.image ?? null;
}

// ---------- Quest lifecycle ----------

function resetStepState(s: Session) {
  s.stepStartedAt = Date.now();
  s.doneStreak = 0;
  s.recent = [];
  s.mockTick = 0;
  s.hintsThisStep = 0;
  s.lastHintAt = 0;
  s.lastVerifyAt = 0;
}

const STEP_PHRASE: Record<QuestStep["action"], (step: QuestStep) => string> = {
  find: (st) => `find the ${st.target}`,
  grab: (st) => `pick up the ${st.target}`,
  drop: (st) => `drop the ${st.target} in the ${st.destination}`,
  place: (st) => `put the ${st.target} ${into(st.destination)} the ${st.destination}`,
  press: (st) => `press the ${st.target}`,
  open: (st) => `open the ${st.target}`,
  sit: (st) => `sit on the ${st.target}`,
  wipe: (st) => `wipe the ${st.target}`,
  go: (st) => `go to the ${st.target}`,
  do: (st) => st.target,
};

const TRASH = /trash|bin|garbage|rubbish|waste/i;
const CONTAINER = /bag|backpack|box|drawer|basket|bin|can|cabinet|case|pocket|cup|jar|bowl|tray/i;
const into = (destination: string) => (CONTAINER.test(destination) ? "in" : "on");

/** One phrase per task: "pick up X" followed by "drop X in Y" is spoken as "throw the X in the Y". */
function taskPhrases(steps: QuestStep[]): string[] {
  const phrases: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    const next = steps[i + 1];
    if (st.action === "grab" && next && (next.action === "drop" || next.action === "place") && next.target === st.target && next.destination) {
      phrases.push(
        next.summary ||
          (next.action === "drop" && TRASH.test(next.destination)
            ? `throw the ${st.target} in the ${next.destination}`
            : `put the ${st.target} ${into(next.destination)} the ${next.destination}`),
      );
      i++;
      continue;
    }
    phrases.push(st.summary || STEP_PHRASE[st.action](st));
  }
  return phrases;
}

/** The whole plan as one spoken line, e.g. "Three tasks: first throw the cup in the trash can, then ..., and finally ...". */
export function planOverview(steps: QuestStep[]): string {
  const phrases = taskPhrases(steps);
  if (phrases.length < 2) return "";
  const counts = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"];
  const parts = phrases.map((phrase, i) => {
    if (i === 0) return `first ${phrase}`;
    return i === phrases.length - 1 ? `and finally ${phrase}` : `then ${phrase}`;
  });
  return `${counts[phrases.length] ?? phrases.length} tasks: ${parts.join(", ")}.`;
}

export function startQuest(s: Session, quest: Quest, source: LineSource, scene: Scene | null = null, goal = "") {
  if (s.quest && s.quest.id !== quest.id) saveCurrentQuest(s);
  if (s.share?.stage !== "sending") s.share = null;
  if (scene) s.scene = scene;
  s.quest = quest;
  s.status = "active";
  s.stepIndex = 0;
  s.questStartedAt = Date.now();
  s.questEndedAt = null;
  s.hintsThisQuest = 0;
  s.stats = { ...s.stats, combo: 0 };
  s.map = buildMap(quest, s.scene);
  s.missions = quest.steps.map((step, i) => ({
    stepId: step.id,
    status: i === 0 ? "active" : "locked",
    landmarkId: findLandmark(s.map, anchorLabel(step))?.id ?? null,
    note: "",
    attempts: 0,
    lastCheck: null,
  }));
  s.verifying = false;
  s.goal = goal || quest.goalCheck;
  s.followUps = 0;
  s.lastSeen = {};
  resetStepState(s);
  pushSnapshot(s);
  const overview = planOverview(quest.steps);
  say(s, [quest.intro, overview, `Let's start. ${quest.steps[0].instruction}`].filter(Boolean).join(" "), source, ["start"], true);
}

// ---------- Switching between quests ----------

/** Pause the unfinished quest and keep its progress and map, so a newer request can take over. Returns its title. */
function saveCurrentQuest(s: Session): string | null {
  const quest = s.quest;
  if (!quest || s.status === "complete" || s.stepIndex >= quest.steps.length) return null;
  s.saved = [
    {
      quest,
      stepIndex: s.stepIndex,
      missions: s.missions.map((m, i) => (i === s.stepIndex && m.status === "verifying" ? { ...m, status: "active" as const } : m)),
      map: s.map,
      goal: s.goal,
      followUps: s.followUps,
      questStartedAt: s.questStartedAt,
      hintsThisQuest: s.hintsThisQuest,
      savedAt: Date.now(),
    },
    ...s.saved.filter((q) => q.quest.id !== quest.id),
  ].slice(0, MAX_SAVED);
  s.quest = null;
  s.status = "idle";
  s.stepIndex = 0;
  s.stepStartedAt = null;
  s.missions = [];
  s.verifying = false;
  s.map = buildMap(null, s.scene);
  return quest.title;
}

/** Find the paused quest the player means by name or goal words; the most recent when unclear. */
function pickSaved(s: Session, which: string): SavedQuest | undefined {
  const words = which.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const score = (q: SavedQuest) => words.filter((w) => `${q.quest.title} ${q.goal}`.toLowerCase().includes(w)).length;
  const best = [...s.saved].sort((a, b) => score(b) - score(a))[0];
  return best && score(best) > 0 ? best : s.saved[0];
}

/** Pick a paused quest back up (pausing the current one first, so nothing is lost). Returns false if none is saved. */
export function resumeSaved(s: Session, which = "", opener = "Back to"): boolean {
  const target = pickSaved(s, which);
  if (!target) return false;
  s.planToken++; // a plan still in progress for an older request must not replace this
  s.saved = s.saved.filter((q) => q !== target);
  saveCurrentQuest(s);
  s.quest = target.quest;
  s.stepIndex = target.stepIndex;
  s.missions = target.missions;
  s.map = target.map;
  s.goal = target.goal;
  s.followUps = target.followUps;
  s.questStartedAt = target.questStartedAt;
  s.hintsThisQuest = target.hintsThisQuest;
  s.status = "active";
  s.questEndedAt = null;
  s.lastSeen = {};
  resetStepState(s);
  if (s.missions[s.stepIndex]) setMission(s, s.stepIndex, { status: "active" });
  pushSnapshot(s);
  const step = currentStep(s);
  const done = summarizeSaved(target).done;
  say(
    s,
    `${opener} "${target.quest.title}". ${done ? `You've done ${done} of ${target.quest.steps.length}. ` : ""}${step ? step.instruction : "Let's do the final check."}`,
    "system",
    ["start"],
    true,
  );
  if (!step) void confirmGoal(s, target.quest);
  return true;
}

function setPlanning(s: Session, transcript?: string, lookingAround = true, paused: string | null = null) {
  s.status = "planning";
  if (transcript) s.lastTranscript = transcript;
  pushSnapshot(s);
  const pausedNote = paused ? `Okay, I've paused "${paused}" and saved your progress. ` : "";
  say(s, pausedNote + (lookingAround ? "Give me a moment to look around. Hold the phone steady." : "Give me a moment to work out a plan."), "system", undefined, true);
}

const isNetworkError = (message: string) => /fetch failed|timed out|ECONN|ENOTFOUND|socket|network/i.test(message);

function planningFailed(s: Session, message: string) {
  s.status = s.quest ? "active" : "idle";
  pushSnapshot(s);
  broadcast(s, { type: "pipeline", stage: "plan", status: "error", detail: redact(message) });
  const line = isNetworkError(message)
    ? "I can't reach the internet right now, so I couldn't make a plan. Ask me again in a moment."
    : "I couldn't make a plan for that. Try asking again.";
  say(s, line, "system", ["fail"], true);
}

/** Plan, retrying through brief internet drops (common on a phone hotspot). */
async function planWithRetry(s: Session, goal: string, scene: Scene | null): Promise<Quest> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await planQuest(goal, scene);
    } catch (err) {
      const message = (err as Error).message;
      if (attempt >= 3 || !isNetworkError(message)) throw err;
      console.warn(`[plan] attempt ${attempt} failed, retrying:`, redact(message).slice(0, 120));
      if (attempt === 1) say(s, "The connection is slow. Still working on your plan.", "system", undefined, true);
      await sleep(1500 * attempt);
    }
  }
}

export function recordTranscript(s: Session, text: string) {
  s.lastTranscript = text;
  broadcast(s, { type: "transcript", text });
}

function completeStep(s: Session, check: VisionCheck | null = null) {
  const quest = s.quest!;
  const step = currentStep(s)!;
  const { stats, reward } = rewardStep(s.stats, {
    usedHint: s.hintsThisStep > 0,
    durationMs: Date.now() - (s.stepStartedAt ?? Date.now()),
  });
  s.stats = stats;
  setMission(s, s.stepIndex, { status: "done", ...(check ? { lastCheck: check } : {}) });
  setPlayerAt(s.map, anchorLabel(step));
  broadcast(s, { type: "reward", stepId: step.id, reward });

  s.stepIndex++;
  const next = currentStep(s);
  if (!next) {
    pushSnapshot(s);
    void confirmGoal(s, quest);
    return reward;
  }
  setMission(s, s.stepIndex, { status: "active" });
  resetStepState(s);
  pushSnapshot(s);

  const comboNote = reward.combo >= 3 ? ` The player is on a ${reward.combo}-step combo.` : "";
  const evidence = check?.evidence.length ? ` The Vision Agent confirmed it: ${check.evidence.join("; ")}.` : "";
  void narrateTracked(
    s,
    "STEP_COMPLETE",
    `Quest: ${quest.title}. The player just finished: ${step.action} the ${step.target}.${evidence}${comboNote} ` +
      `Briefly celebrate, then give this next instruction in your voice: "${next.instruction}"`,
    `Well done! ${next.instruction}`,
  ).then((line) => {
    if (currentStep(s)?.id === next.id) say(s, line.text, line.source);
  });
  return reward;
}

const MAX_FOLLOW_UPS = 2;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Every step is done, but that doesn't prove the goal is: the Vision Agent checks the whole goal
 * first. FAIL adds follow-up steps for what is still unfinished; UNCERTAIN asks the player to show
 * more and looks again; PASS (or no vision available) finishes the quest.
 */
async function confirmGoal(s: Session, quest: Quest) {
  if (!quest.goalCheck || !shouldVerify()) {
    finishQuest(s, quest);
    return;
  }
  s.verifying = true;
  say(s, "That's every step. Let me check the whole thing. Hold the phone up and pan slowly across it.", "system", undefined, true);
  try {
    let check: VisionCheck | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      await sleep(attempt === 0 ? 2500 : 4000); // let fresh frames of the whole area arrive
      check = await runCheck(s, quest.goalCheck, await cameraFrame(), `The player finished every step of "${quest.title}". Goal: ${s.goal}`, "goal");
      if (s.quest?.id !== quest.id) return;
      if (check?.verdict !== "UNCERTAIN") break;
      if (attempt === 0) say(s, `${check.summary || "I can't see all of it."} Step back a little and pan slowly.`, "system", undefined, true);
    }
    if (check) s.map = { ...s.map, goalCheck: check, updatedAt: Date.now() };
    if (check?.verdict === "FAIL" && s.followUps < MAX_FOLLOW_UPS) {
      s.followUps++;
      const what = check.summary || check.evidence[0] || "it isn't finished yet";
      const change = `Every mission is done, but the goal check "${quest.goalCheck}" failed: ${check.evidence.join("; ") || check.summary}.`;
      if (await revisePlan(s, quest, change, `Not quite. ${what}`)) return;
    }
    finishQuest(s, quest, true);
    if (check?.verdict === "FAIL") say(s, `One thing still needs attention: ${check.summary || check.evidence[0] || "it isn't quite done."}`, "system");
  } finally {
    s.verifying = false;
  }
}

/**
 * Re-plan every mission from the current one onward: after a correction, changed conditions, or a
 * failed goal check (then the current index is past the end, so new missions are appended).
 * Finished missions stay; the mission list and map update in place. Returns false if planning failed.
 */
async function revisePlan(s: Session, quest: Quest, change: string, opener: string): Promise<boolean> {
  try {
    const image = await cameraFrame();
    const scanned = image ? await scanScene(image, "interactive").catch(() => null) : null;
    const scene = scanned?.scene ?? s.scene;
    if (s.quest?.id !== quest.id) return false;
    const done = quest.steps.slice(0, s.stepIndex).map((st) => st.summary || `${st.action} ${st.target}`);
    const context = `Already done: ${done.join("; ") || "nothing yet"}. What changed: ${change} Plan only the missions still needed from now on.`;
    const remaining = await planQuest(s.goal, scene, context);
    if (s.quest?.id !== quest.id || !remaining.steps.length) return false;

    if (scene) {
      s.scene = scene;
      mergeScene(s.map, scene);
    }
    const first = Math.min(s.stepIndex, quest.steps.length);
    const added = remaining.steps.map((step) => ({ ...step, id: uid("s") }));
    quest.steps.splice(first, quest.steps.length - first, ...added);
    if (remaining.goalCheck) quest.goalCheck = remaining.goalCheck;
    if (remaining.analysis) quest.analysis = remaining.analysis;
    s.missions.splice(
      first,
      s.missions.length - first,
      ...added.map((step, i) => ({
        stepId: step.id,
        status: (i === 0 ? "active" : "locked") as MissionState["status"],
        landmarkId: findLandmark(s.map, anchorLabel(step))?.id ?? null,
        note: "",
        attempts: 0,
        lastCheck: null,
      })),
    );
    s.status = "active";
    s.stepIndex = first;
    resetStepState(s);
    pushSnapshot(s);
    const mode = questMode();
    say(s, [opener, planOverview(added), added[0].instruction].filter(Boolean).join(" "), mode === "mock" ? "system" : mode, undefined, true);
    return true;
  } catch (err) {
    console.warn("[replan]", redact((err as Error).message).slice(0, 160));
    return false;
  }
}

function finishQuest(s: Session, quest: Quest, inspected = false, saidDone = false) {
  const durationMs = Date.now() - (s.questStartedAt ?? Date.now());
  const { stats, reward } = rewardQuest(s.stats, { type: quest.type, hintsUsed: s.hintsThisQuest });
  s.stats = stats;
  s.status = "complete";
  s.stepStartedAt = null;
  s.questEndedAt = Date.now();
  broadcast(s, { type: "reward", stepId: "quest", reward });
  pushSnapshot(s);

  const seconds = Math.round(durationMs / 1000);
  void narrateTracked(
    s,
    "QUEST_COMPLETE",
    saidDone
      ? `The player just told you they finished "${quest.title}" (goal: ${s.goal || quest.title}), earning ${reward.xpGained} XP and reaching level ${stats.level}. ` +
          "Congratulate them warmly in two sentences on getting it done. Don't mention step counts or how long it took."
      : `The player completed "${quest.title}" (${quest.steps.length} steps) in ${seconds} seconds using ${s.hintsThisQuest} hints, ` +
          `earning ${reward.xpGained} XP and reaching level ${stats.level}. Give a triumphant two-sentence recap of their deeds.`,
    `Quest complete! ${quest.title} is conquered in ${seconds} ${seconds === 1 ? "second" : "seconds"}. You are now level ${stats.level}.`,
  ).then((line) => {
    say(s, line.text, line.source, undefined, true);
    broadcast(s, { type: "quest_complete", questId: quest.id, title: quest.title, recap: line.text, durationMs, stats: s.stats });
    if (!inspected) void finalInspection(s, quest);
    if (messagesAvailable()) {
      // Celebrate, then offer to share it. Paused quests wait until the share is done.
      offerShare(s, quest);
      return;
    }
    // Then pick the most recent paused quest back up, unless the player has moved on meanwhile.
    if (s.saved.length) {
      setTimeout(() => {
        if (s.quest?.id === quest.id && s.status === "complete") resumeSaved(s, "", "Now, back to");
      }, 4000);
    }
  });
}

// ---------- Finishing on the player's word ----------

/**
 * The player says the whole task is done: stop what's in progress (speech, checks, plans), mark the
 * remaining missions done, then celebrate and offer to share. Returns false when no task is running.
 */
function finishTaskNow(s: Session): boolean {
  const quest = s.quest;
  if (!quest || (s.status !== "active" && s.status !== "paused")) return false;
  s.planToken++; // drop any plan still in progress
  s.verifying = false;
  for (let i = s.stepIndex; i < s.missions.length; i++) setMission(s, i, { status: "done" });
  s.stepIndex = quest.steps.length;
  // A priority line cuts off whatever Lumi was saying on the phone right away.
  say(s, "You're done. Nice work.", "system", undefined, true);
  finishQuest(s, quest, true, true);
  return true;
}

// ---------- Sharing a finished quest ----------

/** Ask whether to share the finished quest with a contact. The reply is handled by `handleShareReply`. */
function offerShare(s: Session, quest: Quest) {
  s.share = shareOffer({
    title: quest.title,
    goal: s.goal || quest.title,
    steps: quest.steps.map((st) => st.summary || `${st.action} ${st.target}`),
  });
  // The player answers without the wake phrase.
  s.awakeUntil = Date.now() + config.agent.awakeMs * 3;
  pushSnapshot(s);
  say(s, SHARE_QUESTION, "system");
  const offered = s.share;
  // If nobody answers, end the offer quietly when it expires.
  setTimeout(() => {
    if (s.share && s.share.stage === offered.stage && Date.now() > s.share.expiresAt) endShare(s);
  }, offered.expiresAt - Date.now() + 500);
}

/** The share is over (sent, cancelled, or expired): pick a paused quest back up if this one is finished. */
function endShare(s: Session) {
  s.share = null;
  pushSnapshot(s);
  if (s.status === "complete" && s.saved.length) setTimeout(() => s.status === "complete" && !s.share && resumeSaved(s, "", "Now, back to"), 3000);
}

async function replyToShare(s: Session, text: string) {
  const state = s.share;
  if (!state) return;
  await handleShareReply(state, text, {
    say: (line, source = "system") => {
      s.awakeUntil = Date.now() + config.agent.awakeMs * 3;
      say(s, line, source, undefined, true);
    },
    update: (next) => {
      if (!next) {
        endShare(s);
        return;
      }
      s.share = next;
      pushSnapshot(s);
    },
  });
}

/** After victory, the Vision Agent checks the whole goal once and pins the verdict on the map. */
async function finalInspection(s: Session, quest: Quest) {
  if (!quest.goalCheck) return;
  const image = await cameraFrame();
  if (!image) return;
  const check = await runCheck(s, quest.goalCheck, image, `The player just finished the quest "${quest.title}".`, "goal");
  if (!check || s.quest?.id !== quest.id) return;
  s.map = { ...s.map, goalCheck: check, updatedAt: Date.now() };
  pushSnapshot(s);
  if (check.verdict === "FAIL") say(s, `One last look: ${check.summary || check.evidence[0] || "something still needs attention."}`, "system");
}

function maybeHint(s: Session, step: QuestStep) {
  const now = Date.now();
  const waitMs = config.game.hintAfterSec * 1000;
  if (s.hintInFlight || s.verifying || !s.stepStartedAt || now - s.stepStartedAt < waitMs || now - s.lastHintAt < waitMs) return;
  s.hintInFlight = true;
  s.lastHintAt = now;
  broadcast(s, { type: "pipeline", stage: "hint", status: "start" });
  void hint(step, s.recent.slice(-4))
    .then((line) => {
      if (currentStep(s)?.id !== step.id) return;
      s.hintsThisStep++;
      s.hintsThisQuest++;
      broadcast(s, { type: "pipeline", stage: "hint", status: "done", detail: line.source });
      say(s, line.text, line.source, ["hint"], true);
    })
    .finally(() => {
      s.hintInFlight = false;
    });
}

// ---------- Vision Agent checks ----------

/** Run one Vision Agent check, publish it, and record it on the mission it belongs to. */
async function runCheck(s: Session, question: string, image: string | null, context: string, stepId: string | null): Promise<VisionCheck | null> {
  trackPipeline(s, "verify", "start");
  try {
    const check = await inspect(question, image, context);
    trackPipeline(s, "verify", "done", check.ms, check.verdict);
    broadcast(s, { type: "vision_check", check, stepId });
    const index = stepId ? s.missions.findIndex((m) => m.stepId === stepId) : -1;
    if (index >= 0) setMission(s, index, { lastCheck: check });
    return check;
  } catch (err) {
    const message = redact((err as Error).message);
    console.warn("[verify]", message.slice(0, 160));
    trackPipeline(s, "verify", "error", undefined, message.slice(0, 80));
    return null;
  }
}

const shouldVerify = () => config.game.verifySteps && visionMode() !== "mock";

/** The frame loop thinks the step is done; the Vision Agent must agree before XP is awarded. */
async function verifyStep(s: Session, step: QuestStep, image: string) {
  const index = s.stepIndex;
  s.verifying = true;
  setMission(s, index, { status: "verifying" });
  pushSnapshot(s);
  try {
    const check = await runCheck(s, step.check, image, `Current step: ${step.action} the ${step.target}. ${step.success}`, step.id);
    if (currentStep(s)?.id !== step.id || s.status !== "active") return;
    if (!check) {
      // No verdict is not a PASS: keep the step open and look again after the cooldown.
      s.doneStreak = 0;
      s.lastVerifyAt = Date.now();
      setMission(s, index, { status: "active" });
      pushSnapshot(s);
      say(s, "I couldn't confirm that yet. Hold the phone steady on it for a moment.", "system", undefined, true);
      return;
    }
    if (check.verdict === "PASS") {
      completeStep(s, check);
      return;
    }
    s.doneStreak = 0;
    s.lastVerifyAt = Date.now();
    const attempts = (s.missions[index]?.attempts ?? 0) + 1;
    setMission(s, index, { status: check.verdict === "FAIL" ? "retry" : "active", attempts });
    pushSnapshot(s);

    trackPipeline(s, "agent", "start");
    const started = Date.now();
    const turn = await reactToVerdict(agentState(s), "The frame loop believed the current mission was done, so you asked the Vision Agent to confirm.", check);
    trackPipeline(s, "agent", "done", Date.now() - started, turn.source);
    if (currentStep(s)?.id !== step.id) return;
    if (applyTurn(s, turn)) pushSnapshot(s);
    if (turn.reply) say(s, turn.reply, turn.source, check.verdict === "FAIL" ? ["fail"] : undefined, true);
  } finally {
    s.verifying = false;
  }
}

/** Player tapped a mission on the quest map (or asked to re-check one). */
export async function verifyMission(s: Session, stepId: string): Promise<VisionCheck | null> {
  const index = s.quest?.steps.findIndex((step) => step.id === stepId) ?? -1;
  if (!s.quest || index < 0) return null;
  const step = s.quest.steps[index];
  const check = await runCheck(s, step.check, await cameraFrame(), `Mission: ${step.action} the ${step.target}. ${step.success}`, step.id);
  if (!check) return null;
  const isCurrent = index === s.stepIndex && s.status === "active";
  if (isCurrent && check.verdict === "PASS") {
    completeStep(s, check);
    return check;
  }
  if (!isCurrent) {
    pushSnapshot(s);
    say(s, check.summary || `${check.verdict}: ${check.evidence[0] ?? ""}`, "system", undefined, true);
    return check;
  }
  if (check.verdict === "FAIL") setMission(s, index, { status: "retry", attempts: s.missions[index].attempts + 1 });
  pushSnapshot(s);
  const turn = await reactToVerdict(agentState(s), "The player asked you to verify the current mission from the quest map.", check);
  if (applyTurn(s, turn)) pushSnapshot(s);
  say(s, turn.reply || check.summary, turn.source, check.verdict === "FAIL" ? ["fail"] : undefined, true);
  return check;
}

// ---------- Quest Agent conversation ----------

export async function askQuestion(s: Session, text: string): Promise<AskResponse> {
  if (s.lastTranscript !== text) recordTranscript(s, text);
  trackPipeline(s, "agent", "start");
  const started = Date.now();
  const first = await askAgent(agentState(s), text);

  let reply = first.reply;
  let source = first.source;
  let check: VisionCheck | null = null;
  let missionCompleted = false;
  let changed = applyTurn(s, first);

  const firstStep = currentStep(s);
  if (await adapt(s, first)) {
    trackPipeline(s, "agent", "done", Date.now() - started, source);
    return { reply, source, check, missionCompleted: false, snapshot: snapshot(s) };
  }
  // The player's word completes a mission the camera can't confirm.
  if (first.completeCurrent && firstStep && firstStep.verify === "voice" && s.status === "active") {
    trackPipeline(s, "agent", "done", Date.now() - started, source);
    completeStep(s);
    return { reply, source, check, missionCompleted: true, snapshot: snapshot(s) };
  }

  if (first.visionQuestion) {
    const step = currentStep(s);
    const isMission = !!step && s.status === "active" && first.visionQuestion === step.check;
    check = await runCheck(s, first.visionQuestion, await cameraFrame(), `The player asked: "${text}"`, isMission ? step.id : null);
    if (check) {
      const second = await reactToVerdict(agentState(s), `The player said: "${text}"`, check);
      reply = second.reply || check.summary;
      source = second.source;
      changed = applyTurn(s, second) || changed;
      if (await adapt(s, second)) {
        trackPipeline(s, "agent", "done", Date.now() - started, source);
        return { reply, source, check, missionCompleted: false, snapshot: snapshot(s) };
      }
      const stillCurrent = !!step && currentStep(s)?.id === step.id && s.status === "active";
      if ((second.completeCurrent || isMission) && check.verdict === "PASS" && stillCurrent) {
        completeStep(s, check);
        missionCompleted = true;
        changed = false;
      } else if (stillCurrent && check.verdict === "FAIL" && isMission) {
        setMission(s, s.stepIndex, { status: "retry", attempts: (s.missions[s.stepIndex]?.attempts ?? 0) + 1 });
        changed = true;
      }
    } else {
      reply = "I lost the picture for a second. Ask me again in a moment.";
      source = "system";
    }
  }
  trackPipeline(s, "agent", "done", Date.now() - started, source);
  if (changed) pushSnapshot(s);
  reply ||= "I'm here. What would you like to do?";
  if (!missionCompleted) say(s, reply, source, undefined, true);
  return { reply, source, check, missionCompleted, snapshot: snapshot(s) };
}

/**
 * The Quest Agent asked to skip the current mission or re-plan the rest (a correction or changed
 * conditions). Returns true when it handled the reply itself.
 */
async function adapt(s: Session, turn: AgentTurn): Promise<boolean> {
  const quest = s.quest;
  if (!quest || (s.status !== "active" && s.status !== "paused")) return false;
  if (turn.replan) {
    say(s, turn.reply || "Got it. Let me rework the plan.", turn.source, undefined, true);
    if (await revisePlan(s, quest, turn.replan, "Here's the new plan.")) return true;
    say(s, "I couldn't rework the plan just now. Let's keep going, or tell me what to change.", "system", undefined, true);
    return true;
  }
  if (turn.skipCurrent && currentStep(s)) {
    if (turn.reply) say(s, turn.reply, turn.source, undefined, true);
    await runCommand(s, "skip");
    return true;
  }
  return false;
}

/** One camera frame through the frame loop: guidance for the phone, boxes for the stage, step progress. */
async function handleFrame(s: Session, seq: number, image: string): Promise<void> {
  const step = currentStep(s);

  // Voice-verified missions don't need frame-by-frame vision; the player says when they're done.
  if (s.status !== "active" || !step || step.verify === "voice") {
    const guidance = computeGuidance(null, null);
    broadcast(s, { type: "frame", image: image, observation: null, guidance, timing: null }, "stage");
    return;
  }

  s.mockTick++;
  let result: Awaited<ReturnType<typeof observeStep>>;
  try {
    result = await observeStep(image, step, s.mockTick);
    if (!result) return;
  } catch (err) {
    const message = redact((err as Error).message);
    console.warn("[frame]", message.slice(0, 160));
    broadcast(s, { type: "pipeline", stage: "vision", status: "error", detail: message.slice(0, 80) });
    return;
  }
  const { observation, timing } = result;
  const now = Date.now();
  const center = (box: { x0: number; x1: number }) => (box.x0 + box.x1) / 2 - 0.5;
  if (observation.targetBox) s.lastSeen[step.target] = { dx: center(observation.targetBox), at: now };
  if (observation.destinationBox && step.destination) s.lastSeen[step.destination] = { dx: center(observation.destinationBox), at: now };
  const guidance = computeGuidance(step, observation, s.lastSeen, now);
  broadcast(s, { type: "frame", image: image, observation, guidance, timing }, "stage");
  broadcast(
    s,
    {
      type: "guide",
      guidance,
      speakId: guidance.say ? registerSpeakLine(guidance.say) : undefined,
    },
    "phone",
  );

  // Ignore results for a step that already ended, or that arrived out of order.
  const stillCurrent = currentStep(s)?.id === step.id && s.status === "active";
  if (!stillCurrent || seq <= s.lastSeq) {
    return;
  }
  s.lastSeq = seq;
  s.recent = [...s.recent.slice(-5), observation];

  let mapChanged = false;
  if (observation.targetVisible) mapChanged = markSeen(s.map, step.target, observation.targetBox) || mapChanged;
  if (observation.destinationVisible && step.destination) mapChanged = markSeen(s.map, step.destination, observation.destinationBox) || mapChanged;
  if (observation.distance === "within_reach" || observation.distance === "touching") {
    mapChanged = setPlayerAt(s.map, observation.holdingTarget && step.destination ? step.destination : step.target) || mapChanged;
  }

  const { instantDoneConfidence, doneConfidence } = config.game;
  s.doneStreak = observation.stepDone && observation.confidence >= doneConfidence ? s.doneStreak + 1 : 0;
  const done = (observation.stepDone && observation.confidence >= instantDoneConfidence) || s.doneStreak >= 2;

  if (done && shouldVerify()) {
    if (!s.verifying && Date.now() - s.lastVerifyAt >= config.game.verifyCooldownMs) void verifyStep(s, step, image);
    else if (mapChanged) pushSnapshot(s);
    return;
  }

  if (done) {
    completeStep(s);
    return;
  }

  if (mapChanged) pushSnapshot(s);
  maybeHint(s, step);
}

// ---------- Voice before vision ----------

let visionHolds = 0;

/** Pause frame and survey uploads (e.g. while a voice clip is transcribed). Call the result to resume. */
export function holdVision(): () => void {
  visionHolds++;
  let released = false;
  return () => {
    if (!released) visionHolds--;
    released = true;
  };
}

/** Feed the camera server's newest phone frame into every active quest. */
export async function pollCameraLink() {
  if (visionHolds > 0) return;
  const idle = [...sessions.values()].filter((s) => s.status === "active" && !s.link.inFlight);
  if (!idle.length) return;
  const frame = await fetchCameraFrame();
  if (!frame) return;
  for (const s of idle) {
    if (frame.frameId === s.link.frameId) continue;
    s.link.frameId = frame.frameId;
    s.link.inFlight = true;
    void handleFrame(s, ++s.link.seq, frame.image).finally(() => {
      s.link.inFlight = false;
    });
  }
}

// ---------- Planning and voice dispatch ----------

/** Survey the surroundings, then have the Quest Agent plan a quest for `goal`. Returns null when there is no camera frame. */
export async function planFromGoal(s: Session, goal: string): Promise<SessionSnapshot> {
  // The latest request always wins: pause and save the current quest, and outdate any older plan in progress.
  const token = ++s.planToken;
  const paused = saveCurrentQuest(s);
  const image = await cameraFrame();
  if (token !== s.planToken) return snapshot(s);
  setPlanning(s, goal, Boolean(image), paused);
  try {
    // The camera makes plans concrete, but any goal can be planned without it.
    let scene: Scene | null = null;
    if (image) {
      trackPipeline(s, "vision", "start");
      const scanned = await scanScene(image, "interactive").catch((err) => {
        console.warn("[plan] survey failed, planning without the camera:", redact((err as Error).message).slice(0, 120));
        return null;
      });
      scene = scanned?.scene ?? null;
      trackPipeline(s, "vision", scanned ? "done" : "error", scanned?.timing.ms, scanned ? `${scanned.scene.objects.length} objects` : "no survey");
    }

    trackPipeline(s, "plan", "start");
    const { value: quest, ms } = await timed(() => planWithRetry(s, goal, scene));
    trackPipeline(s, "plan", "done", ms, `${quest.steps.length} steps`);
    if (token !== s.planToken) {
      console.log(`[plan] dropped "${goal.slice(0, 60)}": a newer request took over`);
      return snapshot(s);
    }

    const mode = questMode();
    startQuest(s, quest, mode === "mock" ? "system" : mode, scene, goal);
    return snapshot(s);
  } catch (err) {
    if (token !== s.planToken) return snapshot(s);
    planningFailed(s, (err as Error).message);
    // Don't leave the player with nothing: go back to what they paused for this request.
    if (paused) resumeSaved(s, paused, "Let's get back to");
    throw err;
  }
}

/**
 * Hands-free listening. Each utterance is read by the Quest Agent's understanding step: is it
 * for Lumi, and is it a new goal, a question, progress, a correction, or a command? Speech
 * recognition often mangles "Hi Lumi", so the wake phrase helps but isn't required; background
 * chatter is ignored. Without a reachable model, the wake-phrase rules alone decide.
 * `typed` text comes from the phone's type box and is always meant for Lumi.
 */
export async function hearUtterance(s: Session, transcript: string, typed = false): Promise<ListenResponse> {
  const now = Date.now();
  const { woke: wakeHeard, rest } = typed ? { woke: true, rest: transcript.trim() } : matchWake(transcript);
  const awake = wakeHeard || now < s.awakeUntil;
  const ignore = (): ListenResponse => ({ transcript, heard: awake ? "ignored" : "asleep", intent: null, awakeMs: Math.max(0, s.awakeUntil - now) });

  if (wakeHeard && !rest) {
    s.armed = true;
    s.awakeUntil = now + config.agent.awakeMs;
    recordTranscript(s, transcript);
    say(s, "Yes?", "system", undefined, true);
    return { transcript, heard: "woke", intent: null, awakeMs: config.agent.awakeMs };
  }
  const text = rest || transcript.trim();
  // While sharing a finished quest, replies (yes, a name, "send it") go to the share first.
  if (s.share && text) {
    if (shareConsumes(s.share, text)) {
      const intent: VoiceIntent = { type: "share_reply", text };
      console.log(`[understood] share_reply from "${text.slice(0, 80)}"`);
      s.awakeUntil = Date.now() + config.agent.awakeMs * 3;
      recordTranscript(s, text);
      void dispatchIntent(s, intent);
      return { transcript, heard: "command", intent, awakeMs: config.agent.awakeMs };
    }
    // Not a reply to the share: the player's new request wins and the share is dropped (nothing was sent).
    if (s.share.stage !== "sending") endShare(s);
  }
  // Unprompted fragments ("200", "in a") aren't worth a model call.
  if (!text || (!awake && text.split(/\s+/).length < 3)) return ignore();

  const trusted = wakeHeard || s.armed;
  let intent: VoiceIntent | null = awake ? quickCommand(text) : null;
  if (!intent) {
    const understood = await understand(agentState(s), text, trusted, awake);
    if (understood) {
      if (!understood.addressed && !trusted) return ignore();
      intent = intentFrom(s, understood, text, trusted);
    } else {
      // No model reachable: the wake phrase, or an obvious direct request, decides.
      const addressed = trusted || looksAddressed(text);
      if (!awake && !addressed) return ignore();
      intent = parseIntent(text);
      if (!addressed && (intent.type === "start_quest" || intent.type === "unknown")) return ignore();
    }
  }
  if (!intent) return ignore();
  console.log(`[understood] ${intent.type}${"goal" in intent ? ` "${intent.goal}"` : ""} from "${text.slice(0, 80)}"`);
  s.armed = false;
  s.awakeUntil = Date.now() + config.agent.awakeMs;
  recordTranscript(s, text);
  void dispatchIntent(s, intent);
  return { transcript, heard: "command", intent, awakeMs: config.agent.awakeMs };
}

/** Turn the understanding into something to do. */
function intentFrom(s: Session, u: Understanding, text: string, trusted: boolean): VoiceIntent | null {
  switch (u.kind) {
    case "chatter":
      return trusted ? { type: "ask", text } : null;
    case "command":
      return u.command !== "none" ? { type: u.command } : { type: "ask", text };
    case "new_goal":
      // The latest request always wins; the current quest is paused and saved, not lost.
      return { type: "start_quest", goal: u.goal || text };
    case "return_to_saved":
      return s.saved.length ? { type: "return_to_saved", which: u.goal } : { type: "ask", text };
    case "task_done":
      return { type: "finish_task" };
    default:
      return { type: "ask", text };
  }
}

/** Run a spoken or typed intent on the server; replies reach the phone and stage as `say` events. */
export async function dispatchIntent(s: Session, intent: VoiceIntent): Promise<void> {
  const needsAck =
    intent.type === "start_quest" || intent.type === "ask" || intent.type === "describe";
  const startedAt = s.lastSayAt;
  const ack = needsAck
    ? setTimeout(() => {
        if (s.lastSayAt <= startedAt) {
          say(s, intent.type === "describe" ? "Let me look." : "One sec.", "system", undefined, true);
        }
      }, 1500)
    : null;
  try {
    switch (intent.type) {
      case "start_quest":
        await planFromGoal(s, intent.goal);
        return;
      case "ask":
        await askQuestion(s, intent.text);
        return;
      case "return_to_saved":
        if (!resumeSaved(s, intent.which)) say(s, "There's nothing paused right now. What would you like to do?", "system", undefined, true);
        return;
      case "share_reply":
        await replyToShare(s, intent.text);
        return;
      case "finish_task":
        if (!finishTaskNow(s)) await askQuestion(s, s.lastTranscript || "I'm done");
        return;
      case "unknown":
        say(s, `I did not catch that. Say ${wakePhrase()} and try again.`, "system", undefined, true);
        return;
      default:
        await runCommand(s, intent.type);
    }
  } catch (err) {
    console.warn("[voice]", redact((err as Error).message).slice(0, 160));
    say(s, "Sorry, I lost that one. Can you say it again?", "system", undefined, true);
  } finally {
    if (ack) clearTimeout(ack);
  }
}

// ---------- Surroundings survey ----------

let surveying = false;

/**
 * Periodically scan the newest camera frame and fold what the Vision Agent recognizes
 * into each watched session's map, so landmarks and the setting track the real room.
 * `only` forces an immediate survey of one session.
 */
export async function surveySurroundings(only?: Session) {
  if (surveying || visionMode() === "mock" || (!only && visionHolds > 0)) return;
  const targets = only
    ? [only]
    : [...sessions.values()].filter((s) => s.status !== "planning" && s.status !== "active" && s.subscribers.size > 0);
  if (!targets.length) return;
  const frame = await fetchCameraFrame();
  const image = frame?.image;
  if (!image) return;
  const fresh = targets.filter((s) => only || frame?.frameId !== s.surveyFrameId);
  if (!fresh.length) return;

  surveying = true;
  try {
    const scanned = await scanScene(image, "background");
    if (!scanned) return;
    const { scene } = scanned;
    for (const s of fresh) {
      if (frame) s.surveyFrameId = frame.frameId;
      s.scene = scene;
      if (mergeScene(s.map, scene)) pushSnapshot(s);
    }
  } catch (err) {
    console.warn("[survey]", redact((err as Error).message).slice(0, 160));
  } finally {
    surveying = false;
  }
}

// ---------- Commands ----------

export async function runCommand(s: Session, type: CommandType): Promise<void> {
  switch (type) {
    case "repeat":
      say(s, s.lastSay || currentStep(s)?.instruction || "No quest yet. Tell me what you want to do.", "system", undefined, true);
      return;
    case "skip": {
      const step = currentStep(s);
      if (!step || s.status !== "active") return;
      s.stats = { ...s.stats, combo: 0 };
      setMission(s, s.stepIndex, { status: "skipped" });
      s.stepIndex++;
      const next = currentStep(s);
      if (!next) {
        finishQuest(s, s.quest!);
        return;
      }
      setMission(s, s.stepIndex, { status: "active" });
      resetStepState(s);
      pushSnapshot(s);
      say(s, `Skipping ahead. ${next.instruction}`, "system", undefined, true);
      return;
    }
    case "pause":
      if (s.status === "active") {
        s.status = "paused";
        pushSnapshot(s);
        say(s, "Quest paused. Say resume when ready.", "system", undefined, true);
      }
      return;
    case "resume":
      if (s.status === "paused") {
        s.status = "active";
        resetStepState(s);
        pushSnapshot(s);
        say(s, `Next step. ${currentStep(s)?.instruction ?? ""}`, "system", undefined, true);
      } else if (s.status !== "active" && s.status !== "planning" && !resumeSaved(s)) {
        say(s, "There's nothing paused. Tell me what you'd like to do.", "system", undefined, true);
      }
      return;
    case "stop":
      s.status = "idle";
      s.quest = null;
      s.stepIndex = 0;
      s.stepStartedAt = null;
      s.missions = [];
      s.map = buildMap(null, s.scene);
      pushSnapshot(s);
      say(
        s,
        s.saved.length ? `Quest stopped. "${s.saved[0].quest.title}" is still paused; say "go back" to pick it up.` : "Quest stopped. I'm here if you need me.",
        "system",
        undefined,
        true,
      );
      return;
    case "reset":
      s.status = "idle";
      s.quest = null;
      s.stepIndex = 0;
      s.stepStartedAt = null;
      s.stats = freshStats();
      s.lastTranscript = "";
      s.saved = [];
      s.planToken++;
      s.missions = [];
      s.map = buildMap(null, s.scene);
      pushSnapshot(s);
      return;
    case "describe": {
      const frame = await cameraFrame();
      if (!frame) {
        say(s, "Point the phone ahead and ask again.", "system", undefined, true);
        return;
      }
      trackPipeline(s, "vision", "start");
      const scanned = await scanScene(frame, "interactive");
      if (!scanned) {
        say(s, "Give me a second and try again.", "system", undefined, true);
        return;
      }
      const { scene, timing } = scanned;
      trackPipeline(s, "vision", "done", timing.ms, `${scene.objects.length} objects`);
      const line = await describeScene(scene);
      say(s, line.text, line.source, undefined, true);
      return;
    }
  }
}
