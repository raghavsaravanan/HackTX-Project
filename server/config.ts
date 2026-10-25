const env = process.env;

type Provider = "gemini" | "muse" | "openai";
/** Which model family an agent is using right now; mock means no keys at all. */
export type AgentMode = Provider | "mock";

const geminiModel = env.GEMINI_MODEL ?? "gemini-4-argon";
const geminiKey = env.GEMINI_API_KEY ?? "";

export const config = {
  port: Number(env.API_PORT ?? 8787),
  /** Loopback by default: the hub's Vite server proxies /api, so nothing else on the LAN can spend your API quota. */
  host: env.API_HOST ?? "127.0.0.1",
  agent: {
    /** Wake phrase is "hi <name>"; the narrator persona uses this name (default Lumi). */
    name: env.AGENT_NAME?.trim() || "Lumi",
    /** After the wake phrase or a reply, follow-ups within this window need no wake phrase. */
    awakeMs: Number(env.AWAKE_MS ?? 20000),
  },
  muse: {
    apiKey: env.MODEL_API_KEY ?? "",
    baseUrl: (env.MUSE_BASE_URL ?? "https://api.meta.ai/v1").replace(/\/$/, ""),
    model: env.MUSE_MODEL ?? "muse-spark-1.3",
    reasoningEffort: env.MUSE_REASONING_EFFORT ?? "low",
    transcribeModel: env.MUSE_TRANSCRIBE_MODEL ?? "muse-voice-transcribe-1.0",
  },
  gemini: {
    apiKey: geminiKey,
    /** Per-agent keys (separate quotas); each falls back to GEMINI_API_KEY. */
    questApiKey: env.GEMINI_QUEST_API_KEY || geminiKey,
    visionApiKey: env.GEMINI_VISION_API_KEY || geminiKey,
    model: geminiModel,
    /** Quest Agent: planning, narration, hints, answering questions. */
    questModel: env.GEMINI_QUEST_MODEL || geminiModel,
    /** Vision Agent: per-frame step observations and PASS/FAIL/UNCERTAIN checks. */
    visionModel: env.GEMINI_VISION_MODEL || geminiModel,
    thinkingLevel: env.GEMINI_THINKING_LEVEL ?? "LOW",
    /** Quest planning runs once per quest, so it may think harder (MEDIUM is slower: ~10-30 s). */
    planThinkingLevel: env.GEMINI_PLAN_THINKING_LEVEL || env.GEMINI_THINKING_LEVEL || "LOW",
  },
  openai: {
    /** Per-agent keys (separate rate limits); each falls back to OPENAI_API_KEY. */
    questApiKey: env.OPENAI_QUEST_API_KEY || env.OPENAI_API_KEY || "",
    visionApiKey: env.OPENAI_VISION_API_KEY || env.OPENAI_API_KEY || "",
    /** Quest Agent: planning, narration, hints, answering questions. */
    questModel: env.OPENAI_QUEST_MODEL || "gpt-5.5",
    /** Vision Agent: runs on every analyzed frame, so a fast, cheaper model. */
    visionModel: env.OPENAI_VISION_MODEL || "gpt-5.4-mini",
    /** Quick judgments on every utterance (is this for Lumi, what kind of request). */
    fastModel: env.OPENAI_FAST_MODEL || "gpt-5.4-mini",
    /** Reasoning effort for gpt-5 models: none | minimal | low | medium | high. */
    reasoningEffort: env.OPENAI_REASONING_EFFORT || "low",
    /** Quest planning runs once per quest, so it may think harder. */
    planReasoningEffort: env.OPENAI_PLAN_REASONING_EFFORT || env.OPENAI_REASONING_EFFORT || "low",
  },
  visionProvider: (env.VISION_PROVIDER ?? "gemini") as Provider,
  questProvider: (env.QUEST_AGENT_PROVIDER ?? "gemini") as Provider,
  cameraLink: {
    /** The Python phone camera app's local HTTP port. Empty disables it. */
    url: (env.CAMERA_LINK_URL ?? "http://127.0.0.1:8000").replace(/\/$/, ""),
    /** Frames older than this are treated as "no camera". */
    maxAgeMs: Number(env.CAMERA_LINK_MAX_AGE_MS ?? 4000),
    /** Lower rates and smaller frames keep the uplink free for voice on a phone hotspot. */
    intervalMs: Number(env.CAMERA_LINK_INTERVAL_MS ?? 2500),
    maxSide: Number(env.CAMERA_LINK_MAX_SIDE ?? 512),
  },
  /** How often the Vision Agent re-surveys the surroundings for the quest map. 0 disables it. */
  surveyIntervalMs: Number(env.SURVEY_INTERVAL_MS ?? 60000),
  elevenlabs: {
    apiKey: env.ELEVENLABS_API_KEY ?? "",
    /** Premade voice; override in .env (ElevenLabs voice library). */
    voiceId: env.ELEVENLABS_VOICE_ID ?? "EXAVITQu4vr4xnSDxMaL",
    model: env.ELEVENLABS_MODEL ?? "eleven_flash_v2_5",
  },
  game: {
    /** A single observation at or above this confidence completes a step. */
    instantDoneConfidence: 0.85,
    /** Two consecutive observations at or above this confidence complete a step. */
    doneConfidence: 0.6,
    /** Seconds on a step before the narrator offers a hint. */
    hintAfterSec: 20,
    /** Ask the Vision Agent to confirm a step before awarding it. VERIFY_STEPS=0 trusts the frame loop alone. */
    verifySteps: env.VERIFY_STEPS !== "0",
    /** Minimum wait after a FAIL or UNCERTAIN before the same step is re-verified. */
    verifyCooldownMs: 3000,
    /** PASS/FAIL below this confidence is reported as UNCERTAIN. */
    verdictMinConfidence: 0.55,
  },
};

export const hasMuse = () => config.muse.apiKey.length > 0;
export const hasElevenLabs = () => config.elevenlabs.apiKey.length > 0;
export const hasGemini = () => config.gemini.questApiKey.length > 0 || config.gemini.visionApiKey.length > 0;

export function visionMode(): AgentMode {
  if (config.visionProvider === "openai" && config.openai.visionApiKey) return "openai";
  if (config.visionProvider === "muse") return hasMuse() ? "muse" : "mock";
  return config.gemini.visionApiKey ? "gemini" : hasMuse() ? "muse" : "mock";
}

export function questMode(): AgentMode {
  if (config.questProvider === "openai" && config.openai.questApiKey) return "openai";
  if (config.questProvider === "muse") return hasMuse() ? "muse" : "mock";
  return config.gemini.questApiKey ? "gemini" : hasMuse() ? "muse" : "mock";
}

const KEY_PATTERNS = [/sk-[0-9A-Za-z_-]{20,}/g, /AIza[0-9A-Za-z_-]{20,}/g, /AQ\.[0-9A-Za-z_-]{20,}/g, /LLM[|_][0-9A-Za-z|_-]{20,}/g];

/** Scrubs API keys from text that may reach logs or HTTP responses. */
export function redact(text: string): string {
  let out = text;
  const keys = [config.muse.apiKey, config.gemini.apiKey, config.gemini.questApiKey, config.gemini.visionApiKey, config.openai.questApiKey, config.openai.visionApiKey, config.elevenlabs.apiKey];
  for (const key of keys) if (key) out = out.split(key).join("[redacted]");
  for (const pattern of KEY_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}
