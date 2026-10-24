import { config } from "../config.ts";
import { parseJson, stripDataUrl, withTimeout } from "../util.ts";

interface GeminiJsonOptions {
  system: string;
  prompt: string;
  image: string;
  schema: object;
  timeoutMs?: number;
}

/** Gemini generateContent with an inline JPEG and schema-constrained JSON output. */
export async function geminiJson<T>({ system, prompt, image, schema, timeoutMs = 15000 }: GeminiJsonOptions): Promise<T> {
  const { mimeType, data } = stripDataUrl(image);
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ inlineData: { mimeType, data } }, { text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: stripAdditionalProperties(schema),
      thinkingConfig: { thinkingLevel: config.gemini.thinkingLevel },
      mediaResolution: "MEDIA_RESOLUTION_MEDIUM",
    },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.gemini.model}:generateContent`;
  const res = await withTimeout(
    fetch(url, {
      method: "POST",
      headers: { "x-goog-api-key": config.gemini.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    timeoutMs,
    "Gemini",
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
  };
  const text = json.candidates?.[0]?.content?.parts?.filter((p) => !p.thought && p.text).map((p) => p.text).join("");
  if (!text) throw new Error("Gemini returned no content");
  return parseJson<T>(text);
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
