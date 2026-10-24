// Contract between the phone (Person A), the server, and the stage view.
// Import with `import type` so nothing here ships at runtime.

/** Normalized box, 0..1, origin top-left. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type StepAction = "find" | "grab" | "drop" | "place" | "press" | "open" | "sit";

export interface QuestStep {
  id: string;
  action: StepAction;
  /** Object the player must interact with, e.g. "water bottle". */
  target: string;
  /** Where the target goes for drop/place, e.g. "trash can". Empty otherwise. */
  destination: string;
  /** Spoken when the step begins. */
  instruction: string;
  /** What the verifier looks for to mark the step done. */
  success: string;
}

export type QuestType = "side" | "boss";

export interface Quest {
  id: string;
  title: string;
  type: QuestType;
  intro: string;
  steps: QuestStep[];
}

export type Distance = "far" | "near" | "within_reach" | "touching";

/** One vision-model read of a single frame for the current step. */
export interface StepObservation {
  targetVisible: boolean;
  targetBox: Box | null;
  handVisible: boolean;
  handBox: Box | null;
  destinationVisible: boolean;
  destinationBox: Box | null;
  holdingTarget: boolean;
  distance: Distance;
  stepDone: boolean;
  confidence: number;
  /** Short directional instruction from the vision model. */
  instruction: string;
  hazard: string;
}

export type GuidancePhase = "scan" | "aim" | "approach" | "reach" | "verify" | "idle";

/** What the phone should do with its audio cues right now. */
export interface Guidance {
  phase: GuidancePhase;
  /** -1 (hard left) .. 1 (hard right). Drive a StereoPannerNode with this. */
  pan: number;
  /** 0 (far / not seen) .. 1 (touching). Drive beep rate or pitch with this. */
  proximity: number;
  /** Short line to speak; the phone throttles repeats. */
  say: string;
  /** Which box the cues point at. */
  navBox: Box | null;
}

export interface SceneObject {
  label: string;
  box: Box;
  note: string;
}

export interface Scene {
  objects: SceneObject[];
  hazards: string[];
}

export type Sfx = "step" | "quest" | "levelup" | "fail" | "start" | "combo" | "hint";

export interface Reward {
  xpGained: number;
  breakdown: { label: string; xp: number }[];
  totalXp: number;
  level: number;
  leveledUp: boolean;
  combo: number;
  sfx: Sfx[];
}

export interface PlayerStats {
  xp: number;
  level: number;
  xpIntoLevel: number;
  xpForNextLevel: number;
  combo: number;
  bestCombo: number;
  questsCompleted: number;
  stepsCompleted: number;
}

export type SessionStatus = "idle" | "planning" | "active" | "paused" | "complete";

export interface SessionSnapshot {
  id: string;
  status: SessionStatus;
  quest: Quest | null;
  stepIndex: number;
  stepStartedAt: number | null;
  questStartedAt: number | null;
  questEndedAt: number | null;
  stats: PlayerStats;
  narratorName: string;
  lastTranscript: string;
}

export interface VisionTiming {
  provider: string;
  model: string;
  ms: number;
}

// ---------- HTTP payloads ----------

export interface FrameRequest {
  sessionId: string;
  /** Monotonic per-client counter; stale responses are ignored for progression. */
  seq: number;
  /** JPEG as a data URL or bare base64. ~512px long edge recommended. */
  image: string;
}

export interface FrameResponse {
  seq: number;
  observation: StepObservation | null;
  guidance: Guidance;
  timing: VisionTiming | null;
  /** Present when this frame completed a step. */
  stepCompleted: { stepId: string; reward: Reward } | null;
  questCompleted: boolean;
  snapshot: SessionSnapshot;
}

export interface StartQuestRequest {
  sessionId: string;
  /** Free-form goal, e.g. "help me clean my desk". */
  goal?: string;
  /** Skip planning and use a scripted quest (demo safety net). */
  presetId?: string;
  /** Wide-angle frame for planning. Required with `goal`. */
  image?: string;
}

export type CommandType = "repeat" | "skip" | "pause" | "resume" | "stop" | "describe" | "reset";

export interface CommandRequest {
  sessionId: string;
  type: CommandType;
  image?: string;
}

export type VoiceIntent =
  | { type: "start_quest"; goal: string }
  | { type: CommandType }
  | { type: "unknown" };

export interface VoiceResponse {
  transcript: string;
  intent: VoiceIntent;
}

// ---------- Server-sent events (/api/session/:id/events) ----------

export type ServerEvent =
  | { type: "snapshot"; snapshot: SessionSnapshot }
  | { type: "say"; text: string; source: "muse" | "system"; sfx?: Sfx[]; priority?: boolean }
  | { type: "reward"; stepId: string; reward: Reward }
  | { type: "quest_complete"; questId: string; title: string; recap: string; durationMs: number; stats: PlayerStats }
  | { type: "pipeline"; stage: "vision" | "plan" | "narrate" | "transcribe" | "hint"; status: "start" | "done" | "error"; detail?: string; ms?: number }
  /** Stage-only: the latest analyzed frame. */
  | { type: "frame"; image: string; observation: StepObservation | null; guidance: Guidance; timing: VisionTiming | null }
  | { type: "transcript"; text: string };
