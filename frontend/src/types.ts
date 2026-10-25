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
  /** Yes/no question the Vision Agent answers to confirm the step, e.g. "Is the bottle inside the trash can?" */
  check: string;
}

export type QuestType = "side" | "boss";

export interface Quest {
  id: string;
  title: string;
  type: QuestType;
  intro: string;
  steps: QuestStep[];
  /** Whole-quest question for the final inspection, e.g. "Is the desk clear of clutter?" */
  goalCheck: string;
}

// ---------- Vision Agent checks ----------

export type Verdict = "PASS" | "FAIL" | "UNCERTAIN";

export interface VisionCheck {
  question: string;
  verdict: Verdict;
  confidence: number;
  /** Short, concrete things visible in the frame that justify the verdict. */
  evidence: string[];
  /** One spoken-friendly sentence. */
  summary: string;
  provider: string;
  model: string;
  ms: number;
  at: number;
}

// ---------- Missions and the quest map ----------

export type MissionStatus = "locked" | "active" | "verifying" | "retry" | "done" | "skipped";

/** Live status of one quest step. */
export interface MissionState {
  stepId: string;
  status: MissionStatus;
  /** Map landmark where this mission happens (the destination for drop/place). */
  landmarkId: string | null;
  note: string;
  attempts: number;
  lastCheck: VisionCheck | null;
}

/** A named place or object on the quest map. x, y are 0..100; y=100 is nearest the player. */
export interface MapLandmark {
  id: string;
  label: string;
  x: number;
  y: number;
  seen: boolean;
  note: string;
}

export interface QuestMap {
  /** The Vision Agent's latest description of the surroundings. */
  setting: string;
  landmarks: MapLandmark[];
  /** Landmark id the player is currently at, if known. */
  playerAt: string | null;
  goalCheck: VisionCheck | null;
  updatedAt: number;
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
  /** One sentence on the place itself, e.g. "a small bedroom with a desk under a window and an open door on the right". */
  setting: string;
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
  /** Say this, e.g. "Hi Lumi", to wake hands-free listening. */
  wakePhrase: string;
  /** ElevenLabs TTS is available for narration on the phone and hub. */
  cloudVoice: boolean;
  lastTranscript: string;
  /** One entry per quest step, same order. Empty without a quest. */
  missions: MissionState[];
  map: QuestMap;
}

export interface VisionTiming {
  provider: string;
  model: string;
  ms: number;
}

// ---------- HTTP payloads ----------

export interface StartQuestRequest {
  sessionId: string;
  /** Free-form goal, e.g. "help me clean my desk". */
  goal?: string;
  /** Skip planning and use a scripted quest (demo safety net). */
  presetId?: string;
}

export type CommandType = "repeat" | "skip" | "pause" | "resume" | "stop" | "describe" | "reset";

export type VoiceIntent =
  | { type: "start_quest"; goal: string }
  /** A question or "I'm done" for the Quest Agent, e.g. "Is the room clean?" */
  | { type: "ask"; text: string }
  | { type: CommandType }
  | { type: "unknown" };

export interface VoiceResponse {
  transcript: string;
  intent: VoiceIntent;
}

/**
 * What hands-free listening did with one utterance.
 * asleep: no wake phrase, nothing happened. woke: just the wake phrase. command: acted on.
 * ignored: heard while awake, but a new quest needs the wake phrase.
 */
export interface ListenResponse {
  transcript: string;
  heard: "asleep" | "woke" | "command" | "ignored";
  intent: VoiceIntent | null;
  /** How long follow-ups need no wake phrase. 0 when asleep. */
  awakeMs: number;
}

/** Which model produced a line: a Gemini agent, Muse Spark (fallback brain), or a canned template. */
export type LineSource = "gemini" | "muse" | "system";

export interface AskRequest {
  sessionId: string;
  text: string;
}

export interface AskResponse {
  reply: string;
  source: LineSource;
  check: VisionCheck | null;
  missionCompleted: boolean;
  snapshot: SessionSnapshot;
}

export interface MissionVerifyRequest {
  sessionId: string;
  stepId: string;
}

export type PipelineStage = "vision" | "verify" | "plan" | "agent" | "narrate" | "transcribe" | "hint";

// ---------- Server-sent events (/api/session/:id/events) ----------

export type ServerEvent =
  | { type: "snapshot"; snapshot: SessionSnapshot }
  | { type: "say"; id: string; text: string; source: LineSource; sfx?: Sfx[]; priority?: boolean }
  | { type: "reward"; stepId: string; reward: Reward }
  | { type: "quest_complete"; questId: string; title: string; recap: string; durationMs: number; stats: PlayerStats }
  | { type: "pipeline"; stage: PipelineStage; status: "start" | "done" | "error"; detail?: string; ms?: number }
  /** A Vision Agent verdict; `stepId` is set when it was checking a mission, "goal" for the final inspection. */
  | { type: "vision_check"; check: VisionCheck; stepId: string | null }
  /** Stage-only: the latest analyzed frame. */
  | { type: "frame"; image: string; observation: StepObservation | null; guidance: Guidance; timing: VisionTiming | null }
  /** Phone-only: the same guidance without the image, for spoken cues. */
  | { type: "guide"; guidance: Guidance; speakId?: string }
  | { type: "transcript"; text: string };
