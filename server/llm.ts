import type { LineSource } from "../shared/types.ts";
import { config, hasMuse, questMode, redact } from "./config.ts";
import { geminiCoolingDown, geminiGenerate, geminiJson } from "./providers/gemini.ts";
import { museChat, museJson } from "./providers/muse.ts";

interface AgentCall {
  system: string;
  prompt: string;
  timeoutMs?: number;
}

/**
 * Text or JSON from the Quest Agent's brain: Gemini first, Muse Spark if Gemini is
 * missing or fails. Throws when neither is configured; callers supply templates.
 */
async function withFallback<T>(label: string, gemini: () => Promise<T>, muse: () => Promise<T>): Promise<{ value: T; source: LineSource }> {
  const mode = questMode();
  if (mode === "mock") throw new Error("No Gemini or Meta API key configured");
  if (mode === "muse" || (geminiCoolingDown() && hasMuse())) return { value: await muse(), source: "muse" };
  try {
    return { value: await gemini(), source: "gemini" };
  } catch (err) {
    if (!hasMuse()) throw err;
    console.warn(`[${label}] Gemini failed, using Muse Spark:`, redact((err as Error).message).slice(0, 160));
    return { value: await muse(), source: "muse" };
  }
}

export function agentText({ system, prompt, timeoutMs = 8000 }: AgentCall) {
  return withFallback(
    "quest-agent",
    () => geminiGenerate({ system, prompt, model: config.gemini.questModel, apiKey: config.gemini.questApiKey, timeoutMs }),
    () =>
      museChat({
        messages: [
          { role: "developer", content: system },
          { role: "user", content: prompt },
        ],
        maxCompletionTokens: 2000,
        timeoutMs,
      }),
  );
}

export function agentJson<T>({ system, prompt, schema, name, timeoutMs = 15000 }: AgentCall & { schema: object; name: string }) {
  return withFallback(
    "quest-agent",
    () => geminiJson<T>({ system, prompt, schema, model: config.gemini.questModel, apiKey: config.gemini.questApiKey, timeoutMs }),
    () =>
      museJson<T>({
        messages: [
          { role: "developer", content: system },
          { role: "user", content: prompt },
        ],
        schema: { name, schema },
        timeoutMs,
      }),
  );
}
