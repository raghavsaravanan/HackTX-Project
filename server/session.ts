import type { Response } from "express";
import type {
  AskResponse,
  ListenResponse,
  CommandType,
  FrameRequest,
  FrameResponse,
  LineSource,
  MissionState,
  PipelineStage,
  PlayerStats,
  Quest,
  QuestMap,
  QuestStep,
  Scene,
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
import { computeGuidance } from "./guidance.ts";
import { anchorLabel, applyNotes, buildMap, findLandmark, markSeen, mergeScene, setPlayerAt } from "./map.ts";
import { NARRATOR } from "./prompts.ts";
import { askAgent, describeScene, hint, narrate, parseIntent, planQuest, reactToVerdict, type AgentState, type AgentTurn } from "./questAgent.ts";
import { timed } from "./util.ts";
import { inspect, observeStep, scanScene } from "./vision.ts";
import { matchWake, wakePhrase } from "./wake.ts";

type Role = "stage" | "phone";
type FrameSource = "client" | "link";

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
  lastTranscript: string;
  /** Per source, so console frames and camera-link frames don't reject each other as stale. */
  lastSeq: Record<FrameSource, number>;
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
  lastImage: { image: string; at: number } | null;
  lastClientFrameAt: number;
  link: { seq: number; frameId: number; inFlight: boolean };
  /** Hands-free listening: follow-ups need no wake phrase until this time. */
  awakeUntil: number;
  /** The last utterance was the bare wake phrase, so the next one is trusted fully. */
  armed: boolean;
  subscribers: Set<{ res: Response; role: Role }>;
}

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
      lastTranscript: "",
      lastSeq: { client: -1, link: -1 },
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
      lastImage: null,
      lastClientFrameAt: 0,
      link: { seq: 0, frameId: -1, inFlight: false },
      awakeUntil: 0,
      armed: false,
      subscribers: new Set(),
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
    lastTranscript: s.lastTranscript,
    missions: s.missions,
    map: s.map,
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
  const sub = { res, role };
  s.subscribers.add(sub);
  write(res, { type: "snapshot", snapshot: snapshot(s) });
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
  res.on("close", () => {
    clearInterval(heartbeat);
    s.subscribers.delete(sub);
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
  // A reply keeps the conversation open so the player can answer without the wake phrase.
  if (Date.now() < s.awakeUntil) s.awakeUntil = Date.now() + config.agent.awakeMs;
  broadcast(s, { type: "say", text, source, sfx, priority });
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

// ---------- Frame sources ----------

/** Best frame for an on-demand check: the caller's, then the live camera link, then the console's last frame. */
export async function resolveFrame(s: Session, provided?: string): Promise<string | null> {
  if (provided) return provided;
  const linked = await fetchCameraFrame();
  if (linked) return linked.image;
  if (s.lastImage && Date.now() - s.lastImage.at < config.cameraLink.maxAgeMs) return s.lastImage.image;
  return null;
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

export function startQuest(s: Session, quest: Quest, source: LineSource, scene: Scene | null = null) {
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
  resetStepState(s);
  pushSnapshot(s);
  say(s, `${quest.intro} ${quest.steps[0].instruction}`, source, ["start"], true);
}

export function setPlanning(s: Session, transcript?: string) {
  s.status = "planning";
  if (transcript) s.lastTranscript = transcript;
  pushSnapshot(s);
  say(s, "Let me survey the realm. Hold the phone steady.", "system", undefined, true);
}

export function planningFailed(s: Session, message: string) {
  s.status = s.quest ? "active" : "idle";
  pushSnapshot(s);
  broadcast(s, { type: "pipeline", stage: "plan", status: "error", detail: redact(message) });
  say(s, "My crystal ball clouded over. Try asking again.", "system", ["fail"], true);
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
    finishQuest(s, quest);
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

function finishQuest(s: Session, quest: Quest) {
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
    `The player completed "${quest.title}" (${quest.steps.length} steps) in ${seconds} seconds using ${s.hintsThisQuest} hints, ` +
      `earning ${reward.xpGained} XP and reaching level ${stats.level}. Give a triumphant two-sentence recap of their deeds.`,
    `Quest complete! ${quest.title} is conquered in ${seconds} ${seconds === 1 ? "second" : "seconds"}. You are now level ${stats.level}.`,
  ).then((line) => {
    say(s, line.text, line.source, undefined, true);
    broadcast(s, { type: "quest_complete", questId: quest.id, title: quest.title, recap: line.text, durationMs, stats: s.stats });
    void finalInspection(s, quest);
  });
}

/** After victory, the Vision Agent checks the whole goal once and pins the verdict on the map. */
async function finalInspection(s: Session, quest: Quest) {
  if (!quest.goalCheck) return;
  const image = await resolveFrame(s);
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
    // If the Vision Agent itself is down, fall back to the frame loop's judgement.
    if (!check || check.verdict === "PASS") {
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
export async function verifyMission(s: Session, stepId: string, image?: string): Promise<VisionCheck | null> {
  const index = s.quest?.steps.findIndex((step) => step.id === stepId) ?? -1;
  if (!s.quest || index < 0) return null;
  const step = s.quest.steps[index];
  const frame = await resolveFrame(s, image);
  const check = await runCheck(s, step.check, frame, `Mission: ${step.action} the ${step.target}. ${step.success}`, step.id);
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

/** A free-form check ("Is the room clean?") that isn't tied to a mission. */
export async function visionCheck(s: Session, question: string, image?: string): Promise<VisionCheck | null> {
  return runCheck(s, question, await resolveFrame(s, image), s.quest ? `Quest: ${s.quest.title}` : "", null);
}

// ---------- Quest Agent conversation ----------

export async function askQuestion(s: Session, text: string, image?: string): Promise<AskResponse> {
  if (s.lastTranscript !== text) recordTranscript(s, text);
  trackPipeline(s, "agent", "start");
  const started = Date.now();
  const first = await askAgent(agentState(s), text);

  let reply = first.reply;
  let source = first.source;
  let check: VisionCheck | null = null;
  let missionCompleted = false;
  let changed = applyTurn(s, first);

  if (first.visionQuestion) {
    const step = currentStep(s);
    const isMission = !!step && s.status === "active" && first.visionQuestion === step.check;
    check = await runCheck(s, first.visionQuestion, await resolveFrame(s, image), `The player asked: "${text}"`, isMission ? step.id : null);
    if (check) {
      const second = await reactToVerdict(agentState(s), `The player said: "${text}"`, check);
      reply = second.reply || check.summary;
      source = second.source;
      changed = applyTurn(s, second) || changed;
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
      reply = "My scrying glass flickered. Ask me again in a moment.";
      source = "system";
    }
  }
  trackPipeline(s, "agent", "done", Date.now() - started, source);
  if (changed) pushSnapshot(s);
  reply ||= "I am here, hero. What would you like to do?";
  if (!missionCompleted) say(s, reply, source, undefined, true);
  return { reply, source, check, missionCompleted, snapshot: snapshot(s) };
}

// ---------- Frames ----------

export async function handleFrame(s: Session, req: FrameRequest, source: FrameSource = "client"): Promise<FrameResponse> {
  const step = currentStep(s);
  const base = { seq: req.seq, stepCompleted: null, questCompleted: false };
  s.lastImage = { image: req.image, at: Date.now() };
  if (source === "client") s.lastClientFrameAt = Date.now();

  if (s.status !== "active" || !step) {
    const guidance = computeGuidance(null, null);
    broadcast(s, { type: "frame", image: req.image, observation: null, guidance, timing: null }, "stage");
    return { ...base, observation: null, guidance, timing: null, snapshot: snapshot(s) };
  }

  s.mockTick++;
  let result: Awaited<ReturnType<typeof observeStep>>;
  try {
    result = await observeStep(req.image, step, s.mockTick);
  } catch (err) {
    const message = redact((err as Error).message);
    console.warn("[frame]", message.slice(0, 160));
    broadcast(s, { type: "pipeline", stage: "vision", status: "error", detail: message.slice(0, 80) });
    return { ...base, observation: null, guidance: computeGuidance(null, null), timing: null, snapshot: snapshot(s) };
  }
  const { observation, timing } = result;
  const guidance = computeGuidance(step, observation);
  broadcast(s, { type: "frame", image: req.image, observation, guidance, timing }, "stage");
  broadcast(s, { type: "guide", guidance }, "phone");

  // Ignore results for a step that already ended, or that arrived out of order.
  const stillCurrent = currentStep(s)?.id === step.id && s.status === "active";
  if (!stillCurrent || req.seq <= s.lastSeq[source]) {
    return { ...base, observation, guidance, timing, snapshot: snapshot(s) };
  }
  s.lastSeq[source] = req.seq;
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
    if (!s.verifying && Date.now() - s.lastVerifyAt >= config.game.verifyCooldownMs) void verifyStep(s, step, req.image);
    else if (mapChanged) pushSnapshot(s);
    return { ...base, observation, guidance, timing, snapshot: snapshot(s) };
  }

  if (done) {
    const reward = completeStep(s);
    return {
      ...base,
      observation,
      guidance,
      timing,
      stepCompleted: { stepId: step.id, reward },
      questCompleted: currentStep(s) === null,
      snapshot: snapshot(s),
    };
  }

  if (mapChanged) pushSnapshot(s);
  maybeHint(s, step);
  return { ...base, observation, guidance, timing, snapshot: snapshot(s) };
}

/**
 * Feed the Python camera link's newest frame into every active quest whose console isn't
 * sending its own frames, so the phone-to-laptop stream alone can drive the game.
 */
export async function pollCameraLink() {
  const idle = [...sessions.values()].filter(
    (s) => s.status === "active" && !s.link.inFlight && Date.now() - s.lastClientFrameAt > config.cameraLink.maxAgeMs,
  );
  if (!idle.length) return;
  const frame = await fetchCameraFrame();
  if (!frame) return;
  for (const s of idle) {
    if (frame.frameId === s.link.frameId) continue;
    s.link.frameId = frame.frameId;
    s.link.inFlight = true;
    void handleFrame(s, { sessionId: s.id, seq: ++s.link.seq, image: frame.image }, "link").finally(() => {
      s.link.inFlight = false;
    });
  }
}

// ---------- Planning and voice dispatch ----------

/** Survey the surroundings, then have the Quest Agent plan a quest for `goal`. Returns null when there is no camera frame. */
export async function planFromGoal(s: Session, goal: string, provided?: string): Promise<SessionSnapshot | null> {
  const image = await resolveFrame(s, provided);
  if (!image) return null;
  setPlanning(s, goal);
  try {
    trackPipeline(s, "vision", "start");
    const { scene, timing } = await scanScene(image);
    trackPipeline(s, "vision", "done", timing.ms, `${scene.objects.length} objects`);

    trackPipeline(s, "plan", "start");
    const { value: quest, ms } = await timed(() => planQuest(goal, scene));
    trackPipeline(s, "plan", "done", ms, `${quest.steps.length} steps`);

    const mode = questMode();
    startQuest(s, quest, mode === "mock" ? "system" : mode, scene);
    return snapshot(s);
  } catch (err) {
    planningFailed(s, (err as Error).message);
    throw err;
  }
}

/**
 * Hands-free listening. Speech counts only after the wake phrase ("hi Echo, ...") or within the
 * awake window that follows it. Inside the window, a new quest still needs the wake phrase, so
 * nearby chatter can't replace the player's quest.
 */
export function hearUtterance(s: Session, transcript: string): ListenResponse {
  const now = Date.now();
  const { woke, rest } = matchWake(transcript);
  if (!woke && now >= s.awakeUntil) return { transcript, heard: "asleep", intent: null, awakeMs: 0 };

  const trusted = woke || s.armed;
  const intent = parseIntent(rest);
  if (!trusted && (intent.type === "start_quest" || intent.type === "unknown")) {
    return { transcript, heard: "ignored", intent: null, awakeMs: s.awakeUntil - now };
  }
  s.armed = false;
  s.awakeUntil = now + config.agent.awakeMs;
  if (woke && !rest) {
    s.armed = true;
    recordTranscript(s, transcript);
    say(s, "Yes?", "system", undefined, true);
    return { transcript, heard: "woke", intent: null, awakeMs: config.agent.awakeMs };
  }
  recordTranscript(s, rest);
  void dispatchIntent(s, intent);
  return { transcript, heard: "command", intent, awakeMs: config.agent.awakeMs };
}

/** Run a spoken or typed intent on the server; replies reach the phone and stage as `say` events. */
export async function dispatchIntent(s: Session, intent: VoiceIntent): Promise<void> {
  try {
    switch (intent.type) {
      case "start_quest":
        if (!(await planFromGoal(s, intent.goal))) say(s, "I cannot see anything yet. Start the phone camera, then ask again.", "system", undefined, true);
        return;
      case "ask":
        await askQuestion(s, intent.text);
        return;
      case "unknown":
        say(s, `I did not catch that. Say ${wakePhrase()} and try again.`, "system", undefined, true);
        return;
      default:
        await runCommand(s, intent.type);
    }
  } catch (err) {
    console.warn("[voice]", redact((err as Error).message).slice(0, 160));
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
  if (surveying || visionMode() === "mock") return;
  const targets = only
    ? [only]
    : [...sessions.values()].filter((s) => s.status !== "planning" && (s.status === "active" || s.subscribers.size > 0));
  if (!targets.length) return;
  const frame = await fetchCameraFrame();
  const image = frame?.image ?? (only ? await resolveFrame(only) : null);
  if (!image) return;
  const fresh = targets.filter((s) => only || frame?.frameId !== s.surveyFrameId);
  if (!fresh.length) return;

  surveying = true;
  try {
    const { scene } = await scanScene(image);
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

export async function runCommand(s: Session, type: CommandType, image?: string): Promise<void> {
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
        say(s, `Onward. ${currentStep(s)?.instruction ?? ""}`, "system", undefined, true);
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
      say(s, "Quest abandoned. Rest well, hero.", "system", undefined, true);
      return;
    case "reset":
      s.status = "idle";
      s.quest = null;
      s.stepIndex = 0;
      s.stepStartedAt = null;
      s.stats = freshStats();
      s.lastTranscript = "";
      s.missions = [];
      s.map = buildMap(null, s.scene);
      pushSnapshot(s);
      return;
    case "describe": {
      const frame = await resolveFrame(s, image);
      if (!frame) {
        say(s, "Point the phone ahead and ask again.", "system", undefined, true);
        return;
      }
      trackPipeline(s, "vision", "start");
      const { scene, timing } = await scanScene(frame);
      trackPipeline(s, "vision", "done", timing.ms, `${scene.objects.length} objects`);
      const line = await describeScene(scene);
      say(s, line.text, line.source, undefined, true);
      return;
    }
  }
}
