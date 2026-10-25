import type { ApiOperation, LineSource } from "../shared/types.ts";
import { config, hasMuse, questMode, redact } from "./config.ts";
import { geminiCoolingDown, geminiGenerate, geminiJson } from "./providers/gemini.ts";
import { museChat, museJson } from "./providers/muse.ts";
import { openaiGenerate, openaiJson } from "./providers/openai.ts";
import { shortError, trackApiCall } from "./telemetry.ts";

interface AgentCall {
  system: string;
  prompt: string;
  timeoutMs?: number;
  /** Quest planning: allowed to think harder (Gemini plan thinking level, OpenAI plan reasoning effort). */
  planning?: boolean;
  /** Quick classification: OpenAI's fast model, no extra reasoning, and no slow Muse retry. */
  fast?: boolean;
  /** What the call is for, reported to the hub's workflow view. */
  operation: ApiOperation;
  /** 2 or more when the caller is retrying the same request. */
  attempt?: number;
}

interface Brains<T> {
  gemini: () => Promise<T>;
  openai: () => Promise<T>;
  muse: () => Promise<T>;
}

const questModel = (provider: "gemini" | "openai" | "muse", fast = false) =>
  provider === "gemini" ? config.gemini.questModel : provider === "openai" ? (fast ? config.openai.fastModel : config.openai.questModel) : config.muse.model;

/** A short, payload-free description of an agent result for the workflow view. */
function summarize(value: unknown): string {
  if (typeof value === "string") return `${value.length} characters of narration`;
  if (value && typeof value === "object") {
    const v = value as { steps?: unknown[]; kind?: string; reply?: string; vision_question?: string };
    if (Array.isArray(v.steps)) return `${v.steps.length} steps planned`;
    if (v.kind) return `Intent: ${v.kind.replace("_", " ")}`;
    if (v.vision_question) return "Reply plus a question for the Vision Agent";
    if (typeof v.reply === "string") return v.reply ? "Spoken reply" : "No reply needed";
  }
  return "Structured result";
}

/**
 * Text or JSON from the Quest Agent's brain: the configured provider (OpenAI or Gemini) first,
 * Muse Spark if it is missing or fails. Throws when nothing is configured; callers supply templates.
 */
async function withFallback<T>(call: AgentCall, brains: Brains<T>, allowMuse = true): Promise<{ value: T; source: LineSource }> {
  const mode = questMode();
  if (mode === "mock") throw new Error("No OpenAI, Gemini or Meta API key configured");
  const meta = { operation: call.operation, attempt: call.attempt };
  const viaMuse = (fallbackFrom?: "gemini" | "openai", fallbackReason?: string) =>
    trackApiCall({ ...meta, provider: "muse", model: config.muse.model, fallbackFrom, fallbackReason }, brains.muse, summarize);

  if (mode === "muse") return { value: await viaMuse(), source: "muse" };
  if (mode === "gemini" && geminiCoolingDown() && hasMuse()) {
    return { value: await viaMuse("gemini", "Gemini is cooling down after a quota limit"), source: "muse" };
  }
  try {
    return { value: await trackApiCall({ ...meta, provider: mode, model: questModel(mode, call.fast) }, brains[mode], summarize), source: mode };
  } catch (err) {
    if (!hasMuse() || !allowMuse) throw err;
    console.warn(`[${call.operation}] ${mode} failed, using Muse Spark:`, redact((err as Error).message).slice(0, 160));
    return { value: await viaMuse(mode, shortError(err)), source: "muse" };
  }
}

export function agentText(call: AgentCall) {
  const { system, prompt, timeoutMs = 8000 } = call;
  return withFallback(call, {
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

export function agentJson<T>(call: AgentCall & { schema: object; name: string }) {
  const { system, prompt, schema, name, timeoutMs = 15000, planning = false, fast = false } = call;
  return withFallback(
    call,
    {
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
    },
    !fast,
  );
}
