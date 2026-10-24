import type { Response } from "express";
import type {
  CommandType,
  FrameRequest,
  FrameResponse,
  PlayerStats,
  Quest,
  QuestStep,
  ServerEvent,
  SessionSnapshot,
  SessionStatus,
  Sfx,
  StepObservation,
} from "../shared/types.ts";
import { describeScene, hint, narrate } from "./brain.ts";
import { config } from "./config.ts";
import { freshStats, rewardQuest, rewardStep } from "./game.ts";
import { computeGuidance } from "./guidance.ts";
import { NARRATOR } from "./prompts.ts";
import { observeStep, scanScene } from "./vision.ts";

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
  lastTranscript: string;
  lastSeq: number;
  doneStreak: number;
  recent: StepObservation[];
  mockTick: number;
  hintsThisStep: number;
  hintsThisQuest: number;
  lastHintAt: number;
  hintInFlight: boolean;
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
      lastSeq: -1,
      doneStreak: 0,
      recent: [],
      mockTick: 0,
      hintsThisStep: 0,
      hintsThisQuest: 0,
      lastHintAt: 0,
      hintInFlight: false,
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
    lastTranscript: s.lastTranscript,
  };
}

const currentStep = (s: Session): QuestStep | null => s.quest?.steps[s.stepIndex] ?? null;

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

function say(s: Session, text: string, source: "muse" | "system", sfx?: Sfx[], priority = false) {
  s.lastSay = text;
  broadcast(s, { type: "say", text, source, sfx, priority });
}

async function narrateTracked(s: Session, event: string, details: string, fallback: string) {
  broadcast(s, { type: "pipeline", stage: "narrate", status: "start" });
  const start = Date.now();
  const line = await narrate(event, details, fallback);
  broadcast(s, { type: "pipeline", stage: "narrate", status: "done", ms: Date.now() - start, detail: line.source });
  return line;
}

// ---------- Quest lifecycle ----------

function resetStepState(s: Session) {
  s.stepStartedAt = Date.now();
  s.doneStreak = 0;
  s.recent = [];
  s.mockTick = 0;
  s.hintsThisStep = 0;
  s.lastHintAt = 0;
}

export function startQuest(s: Session, quest: Quest, source: "muse" | "system") {
  s.quest = quest;
  s.status = "active";
  s.stepIndex = 0;
  s.questStartedAt = Date.now();
  s.questEndedAt = null;
  s.hintsThisQuest = 0;
  s.stats = { ...s.stats, combo: 0 };
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
  broadcast(s, { type: "pipeline", stage: "plan", status: "error", detail: message });
  say(s, "My crystal ball clouded over. Try asking again.", "system", ["fail"], true);
}

export function trackPipeline(s: Session, stage: "plan" | "transcribe" | "vision", status: "start" | "done" | "error", ms?: number, detail?: string) {
  broadcast(s, { type: "pipeline", stage, status, ms, detail });
}

export function recordTranscript(s: Session, text: string) {
  s.lastTranscript = text;
  broadcast(s, { type: "transcript", text });
}

function completeStep(s: Session) {
  const quest = s.quest!;
  const step = currentStep(s)!;
  const { stats, reward } = rewardStep(s.stats, {
    usedHint: s.hintsThisStep > 0,
    durationMs: Date.now() - (s.stepStartedAt ?? Date.now()),
  });
  s.stats = stats;
  broadcast(s, { type: "reward", stepId: step.id, reward });

  s.stepIndex++;
  const next = currentStep(s);
  if (!next) {
    finishQuest(s, quest);
    return reward;
  }
  resetStepState(s);
  pushSnapshot(s);

  const comboNote = reward.combo >= 3 ? ` The player is on a ${reward.combo}-step combo.` : "";
  void narrateTracked(
    s,
    "STEP_COMPLETE",
    `Quest: ${quest.title}. The player just finished: ${step.action} the ${step.target}.${comboNote} ` +
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
  });
}

function maybeHint(s: Session, step: QuestStep) {
  const now = Date.now();
  const waitMs = config.game.hintAfterSec * 1000;
  if (s.hintInFlight || !s.stepStartedAt || now - s.stepStartedAt < waitMs || now - s.lastHintAt < waitMs) return;
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

// ---------- Frames ----------

export async function handleFrame(s: Session, req: FrameRequest): Promise<FrameResponse> {
  const step = currentStep(s);
  const base = { seq: req.seq, stepCompleted: null, questCompleted: false };

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
    const message = (err as Error).message;
    console.warn("[frame]", message.slice(0, 160));
    broadcast(s, { type: "pipeline", stage: "vision", status: "error", detail: message.slice(0, 80) });
    return { ...base, observation: null, guidance: computeGuidance(null, null), timing: null, snapshot: snapshot(s) };
  }
  const { observation, timing } = result;
  const guidance = computeGuidance(step, observation);
  broadcast(s, { type: "frame", image: req.image, observation, guidance, timing }, "stage");

  // Ignore results for a step that already ended, or that arrived out of order.
  const stillCurrent = currentStep(s)?.id === step.id && s.status === "active";
  if (!stillCurrent || req.seq <= s.lastSeq) {
    return { ...base, observation, guidance, timing, snapshot: snapshot(s) };
  }
  s.lastSeq = req.seq;
  s.recent = [...s.recent.slice(-5), observation];

  const { instantDoneConfidence, doneConfidence } = config.game;
  s.doneStreak = observation.stepDone && observation.confidence >= doneConfidence ? s.doneStreak + 1 : 0;
  const done = (observation.stepDone && observation.confidence >= instantDoneConfidence) || s.doneStreak >= 2;

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

  maybeHint(s, step);
  return { ...base, observation, guidance, timing, snapshot: snapshot(s) };
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
      s.stepIndex++;
      const next = currentStep(s);
      if (!next) {
        finishQuest(s, s.quest!);
        return;
      }
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
      pushSnapshot(s);
      return;
    case "describe": {
      if (!image) {
        say(s, "Point the phone ahead and ask again.", "system", undefined, true);
        return;
      }
      trackPipeline(s, "vision", "start");
      const { scene, timing } = await scanScene(image);
      trackPipeline(s, "vision", "done", timing.ms, `${scene.objects.length} objects`);
      const line = await describeScene(scene);
      say(s, line.text, line.source, undefined, true);
      return;
    }
  }
}
