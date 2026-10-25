import { config } from "../config.ts";
import { parseJson, stripDataUrl, withTimeout } from "../util.ts";

/** After a 429, skip Gemini briefly so a frame loop can't drown out transcription. */
let cooldownUntil = 0;
let quotaExhausted = false;
const COOLDOWN_MS = 30_000;
const QUOTA_COOLDOWN_MS = 5 * 60_000;

export const geminiCoolingDown = () => Date.now() < cooldownUntil;

export function geminiStatus() {
  return {
    coolingDown: geminiCoolingDown(),
    quotaExhausted,
    until: cooldownUntil > Date.now() ? cooldownUntil : null,
  };
}

interface GeminiOptions {
  system: string;
  prompt: string;
  /** JPEG/PNG data URL or bare base64. Omit for text-only calls. */
  image?: string;
  /** JSON schema for structured output. Omit for plain text. */
  schema?: object;
  model?: string;
  apiKey?: string;
  maxOutputTokens?: number;
  timeoutMs?: number;
  /** Overrides GEMINI_THINKING_LEVEL for this call (e.g. more thinking for quest planning). */
  thinkingLevel?: string;
}

/** Gemini generateContent: optional inline image, optional schema-constrained JSON. Returns the answer text. */
export async function geminiGenerate({
  system,
  prompt,
  image,
  schema,
  model = config.gemini.model,
  apiKey = config.gemini.apiKey,
  maxOutputTokens,
  timeoutMs = 15000,
  thinkingLevel = config.gemini.thinkingLevel,
}: GeminiOptions): Promise<string> {
  if (geminiCoolingDown()) throw new Error("Gemini cooling down after quota limit");
  const parts: object[] = [];
  if (image) {
    const { mimeType, data } = stripDataUrl(image);
    parts.push({ inlineData: { mimeType, data } });
  }
  parts.push({ text: prompt });

  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts }],
    generationConfig: {
      ...(schema ? { responseMimeType: "application/json", responseJsonSchema: stripAdditionalProperties(schema) } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
      thinkingConfig: { thinkingLevel },
      ...(image ? { mediaResolution: "MEDIA_RESOLUTION_MEDIUM" } : {}),
    },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const res = await withTimeout(
    fetch(url, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    timeoutMs,
    "Gemini",
  );
  if (!res.ok) {
    const errText = await res.text();
    if (res.status === 429) {
      const exhausted = /RESOURCE_EXHAUSTED|quota/i.test(errText);
      quotaExhausted = exhausted;
      cooldownUntil = Date.now() + (exhausted ? QUOTA_COOLDOWN_MS : COOLDOWN_MS);
    }
    throw new Error(`Gemini ${res.status}: ${errText.slice(0, 300)}`);
  }
  quotaExhausted = false;
  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
  };
  const text = json.candidates?.[0]?.content?.parts?.filter((p) => !p.thought && p.text).map((p) => p.text).join("");
  if (!text) throw new Error("Gemini returned no content");
  return text.trim();
}

export async function geminiJson<T>(opts: GeminiOptions & { schema: object }): Promise<T> {
  return parseJson<T>(await geminiGenerate(opts));
}

function stripAdditionalProperties(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(stripAdditionalProperties);
  if (schema && typeof schema === "object") {
    return Object.fromEntries(
      Object.entries(schema)
        .filter(([key]) => key !== "additionalProperties")
        .map(([key, value]) => [key, stripAdditionalProperties(value)]),
    );
  }
  return schema;
}
