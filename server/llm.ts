import type { LineSource } from "../shared/types.ts";
import { config, hasMuse, questMode, redact } from "./config.ts";
import { geminiCoolingDown, geminiGenerate, geminiJson } from "./providers/gemini.ts";
import { museChat, museJson } from "./providers/muse.ts";
import { openaiGenerate, openaiJson } from "./providers/openai.ts";

interface AgentCall {
  system: string;
  prompt: string;
  timeoutMs?: number;
  /** Quest planning: allowed to think harder (Gemini plan thinking level, OpenAI plan reasoning effort). */
  planning?: boolean;
  /** Quick classification: OpenAI's fast model, no extra reasoning, and no slow Muse retry. */
  fast?: boolean;
}

interface Brains<T> {
  gemini: () => Promise<T>;
  openai: () => Promise<T>;
  muse: () => Promise<T>;
}

/**
 * Text or JSON from the Quest Agent's brain: the configured provider (OpenAI or Gemini) first,
 * Muse Spark if it is missing or fails. Throws when nothing is configured; callers supply templates.
 */
async function withFallback<T>(label: string, brains: Brains<T>, allowMuse = true): Promise<{ value: T; source: LineSource }> {
  const mode = questMode();
  if (mode === "mock") throw new Error("No OpenAI, Gemini or Meta API key configured");
  if (mode === "muse" || (mode === "gemini" && geminiCoolingDown() && hasMuse())) return { value: await brains.muse(), source: "muse" };
  try {
    return { value: await brains[mode](), source: mode };
  } catch (err) {
    if (!hasMuse() || !allowMuse) throw err;
    console.warn(`[${label}] ${mode} failed, using Muse Spark:`, redact((err as Error).message).slice(0, 160));
    return { value: await brains.muse(), source: "muse" };
  }
}

export function agentText({ system, prompt, timeoutMs = 8000 }: AgentCall) {
  return withFallback("quest-agent", {
    gemini: () => geminiGenerate({ system, prompt, model: config.gemini.questModel, apiKey: config.gemini.questApiKey, timeoutMs }),
    openai: () =>
      openaiGenerate({ system, prompt, model: config.openai.questModel, apiKey: config.openai.questApiKey, timeoutMs, reasoningEffort: config.openai.reasoningEffort }),
    muse: () =>
      museChat({
        messages: [
          { role: "developer", content: system },
          { role: "user", content: prompt },
        ],
        maxCompletionTokens: 2000,
        timeoutMs,
      }),
  });
}

export function agentJson<T>({ system, prompt, schema, name, timeoutMs = 15000, planning = false, fast = false }: AgentCall & { schema: object; name: string }) {
  return withFallback("quest-agent", {
    gemini: () =>
      geminiJson<T>({
        system,
        prompt,
        schema,
        model: config.gemini.questModel,
        apiKey: config.gemini.questApiKey,
        timeoutMs,
        thinkingLevel: planning ? config.gemini.planThinkingLevel : config.gemini.thinkingLevel,
      }),
    openai: () =>
      openaiJson<T>({
        system,
        prompt,
        schema,
        name,
        model: fast ? config.openai.fastModel : config.openai.questModel,
        apiKey: config.openai.questApiKey,
        timeoutMs,
        reasoningEffort: fast ? "none" : planning ? config.openai.planReasoningEffort : config.openai.reasoningEffort,
      }),
    muse: () =>
      museJson<T>({
        messages: [
          { role: "developer", content: system },
          { role: "user", content: prompt },
        ],
        schema: { name, schema },
        timeoutMs,
      }),
  }, !fast);
}
