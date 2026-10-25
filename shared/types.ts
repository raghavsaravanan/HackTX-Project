// Contract between the phone (Person A), the server, and the stage view.
// Import with `import type` so nothing here ships at runtime.

/** Normalized box, 0..1, origin top-left. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type StepAction = "find" | "grab" | "drop" | "place" | "press" | "open" | "sit" | "wipe" | "go" | "do";

/** How a step is confirmed: by the Vision Agent through the camera, or by the player saying it's done. */
export type StepVerify = "vision" | "voice";

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
  /** Why this step serves the goal, from the Quest Agent's plan (e.g. "the cup is empty, so it's trash"). */
  reason?: string;
  /** A few words for the spoken plan and the quest map, e.g. "boil the water". */
  summary?: string;
  /** vision: the camera confirms it. voice: the player says when it's done. Defaults to vision. */
  verify?: StepVerify;
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
  /** The Quest Agent's reasoning behind the plan: what the goal means here and what counts as done. */
  analysis?: string;
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

export type Sfx = "step" | "quest" | "fail" | "start" | "hint";

export type SessionStatus = "idle" | "planning" | "active" | "paused" | "complete";

export interface SessionSnapshot {
  id: string;
  status: SessionStatus;
  quest: Quest | null;
  stepIndex: number;
  stepStartedAt: number | null;
  questStartedAt: number | null;
  questEndedAt: number | null;
  narratorName: string;
  /** Say this, e.g. "Hi Lumi", to wake hands-free listening. */
  wakePhrase: string;
  /** ElevenLabs TTS is available for narration on the phone and hub. */
  cloudVoice: boolean;
  lastTranscript: string;
  /** One entry per quest step, same order. Empty without a quest. */
  missions: MissionState[];
  map: QuestMap;
  /** The Vision Agent's latest survey of the surroundings: objects with their boxes, and hazards. */
  scene: Scene | null;
  /** Quests set aside for newer requests, most recent first. Lumi returns to them afterwards. */
  savedQuests: SavedQuestSummary[];
  /** Sharing a finished quest with a contact through Messages; null when not sharing. */
  share: ShareState | null;
}

/**
 * Sharing a finished quest: offer -> choose a contact (or pick between matches) -> preview -> send.
 * Nothing is sent until the player explicitly confirms the previewed message.
 */
export interface ShareState {
  stage: "offer" | "choose_contact" | "pick_option" | "confirm" | "sending";
  task: { title: string; goal: string; steps: string[] };
  /** Matching contacts to pick from (pick_option). */
  options: { name: string; handle: string; label: string; kind: "phone" | "email" }[];
  contactName: string;
  handle: string;
  handleKind: "phone" | "email" | "";
  service: "iMessage" | "SMS" | "";
  /** Services the laptop's Messages app can use, checked when a contact is chosen. */
  services: ("iMessage" | "SMS")[];
  /** The message previewed for confirmation. */
  message: string;
  /** The flow quietly ends after this; a stale preview can never be sent. */
  expiresAt: number;
}

/** A quest paused because the player asked for something else; it keeps its progress and map. */
export interface SavedQuestSummary {
  questId: string;
  title: string;
  goal: string;
  /** Missions already done. */
  done: number;
  total: number;
  /** The mission to pick up from. */
  next: string;
  savedAt: number;
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
  /** Go back to a paused quest; `which` is the player's words for it ("" for the most recent). */
  | { type: "return_to_saved"; which: string }
  /** A reply while Lumi is offering to share a finished quest (yes/no, a contact name, "send it"). */
  | { type: "share_reply"; text: string }
  /** The player says the whole task is done ("I'm done"): wrap it up, congratulate, offer to share. */
  | { type: "finish_task" }
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
export type LineSource = "gemini" | "muse" | "openai" | "system";

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

// ---------- API call telemetry ----------

export type ApiProvider = "gemini" | "openai" | "muse" | "elevenlabs";

/** What a call was for. Each maps to one pipeline stage. */
export type ApiOperation =
  | "plan"
  | "agent_turn"
  | "interpret"
  | "narrate"
  | "hint"
  | "step_observation"
  | "scene_survey"
  | "vision_check"
  | "transcribe"
  | "speech"
  | "share_message";

/**
 * One outbound call to a model or speech service, sent when it starts and again when it ends.
 * Never carries prompts, images, audio, or credentials; `summary` is a short description of the result.
 */
export interface ApiCall {
  id: string;
  provider: ApiProvider;
  model: string;
  operation: ApiOperation;
  status: "running" | "ok" | "error";
  startedAt: number;
  ms?: number;
  summary?: string;
  error?: string;
  /** Set when this call replaced a failed or unavailable provider. */
  fallbackFrom?: ApiProvider;
  fallbackReason?: string;
  /** 2 or more when the same request is being retried. */
  attempt?: number;
}

// ---------- Server-sent events (/api/session/:id/events) ----------

export type ServerEvent =
  | { type: "snapshot"; snapshot: SessionSnapshot }
  /** Sent once to each phone page: its own id, to compare with `speaker`. */
  | { type: "hello"; clientId: string }
  /** Only this phone page speaks and listens (the newest one), so two open pages never talk over each other. */
  | { type: "speaker"; clientId: string }
  | { type: "say"; id: string; text: string; source: LineSource; sfx?: Sfx[]; priority?: boolean }
  /** A step was confirmed (`stepId`), or the whole quest finished (`stepId` "quest"). */
  | { type: "progress"; stepId: string; label: string; sfx: Sfx[] }
  | { type: "quest_complete"; questId: string; title: string; recap: string; durationMs: number; stepsDone: number; stepsTotal: number }
  | { type: "pipeline"; stage: PipelineStage; status: "start" | "done" | "error"; detail?: string; ms?: number }
  /** Stage-only: an outbound model or speech API call started or finished (process-wide). */
  | { type: "api_call"; call: ApiCall }
  /** A Vision Agent verdict; `stepId` is set when it was checking a mission, "goal" for the final inspection. */
  | { type: "vision_check"; check: VisionCheck; stepId: string | null }
  /** Stage-only: the latest analyzed frame. */
  | { type: "frame"; image: string; observation: StepObservation | null; guidance: Guidance; timing: VisionTiming | null }
  /** Phone-only: the same guidance without the image, for spoken cues. */
  | { type: "guide"; guidance: Guidance; speakId?: string }
  | { type: "transcript"; text: string };
