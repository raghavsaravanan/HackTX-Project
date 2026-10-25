import { toDataUrl, withTimeout } from "../util.ts";

interface OpenAIOptions {
  system: string;
  prompt: string;
  /** JPEG/PNG data URL or base64; sent as a low-detail image for speed. */
  image?: string;
  /** JSON schema for structured output. Omit for plain text. */
  schema?: object;
  /** Name for the structured-output schema. */
  name?: string;
  model: string;
  apiKey: string;
  timeoutMs?: number;
  /** For reasoning models (gpt-5, o-series): none | minimal | low | medium | high. */
  reasoningEffort?: string;
  maxCompletionTokens?: number;
}

const isReasoningModel = (model: string) => /^(gpt-5|gpt-6|o\d)/.test(model);

/** OpenAI Chat Completions: optional image, optional schema-constrained JSON. Returns the answer text. */
export async function openaiGenerate({
  system,
  prompt,
  image,
  schema,
  name = "result",
  model,
  apiKey,
  timeoutMs = 15000,
  reasoningEffort,
  maxCompletionTokens = 4000,
}: OpenAIOptions): Promise<string> {
  const user = image
    ? [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: toDataUrl(image), detail: "low" } },
      ]
    : prompt;
  const body = {
    model,
    messages: [
      { role: "developer", content: system },
      { role: "user", content: user },
    ],
    max_completion_tokens: maxCompletionTokens,
    ...(schema ? { response_format: { type: "json_schema", json_schema: { name, schema, strict: true } } } : {}),
    ...(reasoningEffort && isReasoningModel(model) ? { reasoning_effort: reasoningEffort } : {}),
  };
  // A fresh request per attempt; a dropped connection gets one retry.
  const send = () =>
    withTimeout(
      fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      timeoutMs,
      "OpenAI",
    );
  let res: Response;
  try {
    res = await send();
  } catch (err) {
    if (!/fetch failed/i.test((err as Error).message)) throw err;
    res = await send();
  }
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string | null; refusal?: string | null } }[] };
  const message = json.choices?.[0]?.message;
  if (message?.refusal) throw new Error(`OpenAI refused: ${message.refusal.slice(0, 200)}`);
  const text = message?.content?.trim();
  if (!text) throw new Error("OpenAI returned an empty answer");
  return text;
}

export async function openaiJson<T>(opts: OpenAIOptions & { schema: object }): Promise<T> {
  return JSON.parse(await openaiGenerate(opts)) as T;
}
