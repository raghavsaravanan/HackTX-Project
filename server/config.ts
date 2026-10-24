const env = process.env;

export const config = {
  port: Number(env.API_PORT ?? 8787),
  muse: {
    apiKey: env.MODEL_API_KEY ?? "",
    baseUrl: (env.MUSE_BASE_URL ?? "https://api.meta.ai/v1").replace(/\/$/, ""),
    model: env.MUSE_MODEL ?? "muse-spark-1.3",
    reasoningEffort: env.MUSE_REASONING_EFFORT ?? "low",
    transcribeModel: env.MUSE_TRANSCRIBE_MODEL ?? "muse-voice-transcribe-1.0",
  },
  gemini: {
    apiKey: env.GEMINI_API_KEY ?? "",
    model: env.GEMINI_MODEL ?? "gemini-4-argon",
    thinkingLevel: env.GEMINI_THINKING_LEVEL ?? "LOW",
  },
  visionProvider: (env.VISION_PROVIDER ?? "gemini") as "gemini" | "muse",
  game: {
    /** A single observation at or above this confidence completes a step. */
    instantDoneConfidence: 0.85,
    /** Two consecutive observations at or above this confidence complete a step. */
    doneConfidence: 0.6,
    /** Seconds on a step before the narrator offers a hint. */
    hintAfterSec: 14,
  },
};

export const hasMuse = () => config.muse.apiKey.length > 0;
export const hasGemini = () => config.gemini.apiKey.length > 0;

export function visionMode(): "gemini" | "muse" | "mock" {
  if (config.visionProvider === "muse") return hasMuse() ? "muse" : "mock";
  return hasGemini() ? "gemini" : hasMuse() ? "muse" : "mock";
}
