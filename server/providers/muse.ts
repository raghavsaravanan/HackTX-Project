import { config } from "../config.ts";
import { parseJson, toDataUrl, withTimeout } from "../util.ts";

type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: "low" | "auto" | "high" } };

export interface MuseMessage {
  role: "developer" | "user" | "assistant";
  content: string | ContentPart[];
}

interface MuseChatOptions {
  messages: MuseMessage[];
  schema?: { name: string; schema: object };
  maxCompletionTokens?: number;
  timeoutMs?: number;
}

/** Muse Spark via Meta Model API chat completions (OpenAI-compatible). */
export async function museChat({ messages, schema, maxCompletionTokens = 4000, timeoutMs = 15000 }: MuseChatOptions): Promise<string> {
  const body: Record<string, unknown> = {
    model: config.muse.model,
    messages,
    reasoning_effort: config.muse.reasoningEffort,
    max_completion_tokens: maxCompletionTokens,
  };
  if (schema) {
    body.response_format = { type: "json_schema", json_schema: { name: schema.name, schema: schema.schema, strict: true } };
  }

  const res = await withTimeout(
    fetch(`${config.muse.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.muse.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    timeoutMs,
    "Muse Spark",
  );
  if (!res.ok) throw new Error(`Muse Spark ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error("Muse Spark returned no content");
  return content.trim();
}

export async function museJson<T>(opts: MuseChatOptions & { schema: { name: string; schema: object } }): Promise<T> {
  return parseJson<T>(await museChat(opts));
}

export function museImageMessage(text: string, image: string): MuseMessage {
  return {
    role: "user",
    content: [
      { type: "text", text },
      { type: "image_url", image_url: { url: toDataUrl(image), detail: "low" } },
    ],
  };
}

/** Muse Voice Transcribe, single-shot upload. Audio must be mono 16-bit PCM WAV at 16 or 24 kHz. */
export async function museTranscribe(wav: Buffer, keywords: string[] = []): Promise<string> {
  const form = new FormData();
  const request = {
    mode: "PUSH_TO_TALK",
    model: config.muse.transcribeModel,
    audioEncoding: "WAV",
    ...(keywords.length ? { keywords } : {}),
  };
  form.append("request", new Blob([JSON.stringify(request)], { type: "application/json" }));
  form.append("audio", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "speech.wav");

  const res = await withTimeout(
    fetch(`${config.muse.baseUrl}/asr/transcribe`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.muse.apiKey}`, Accept: "application/json" },
      body: form,
    }),
    15000,
    "Muse Voice Transcribe",
  );
  if (!res.ok) throw new Error(`Muse Voice Transcribe ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { transcript?: string };
  return (json.transcript ?? "").trim();
}
