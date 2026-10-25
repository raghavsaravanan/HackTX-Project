import type { Box } from "../shared/types.ts";

export function stripDataUrl(image: string): { mimeType: string; data: string } {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(image);
  if (match) return { mimeType: match[1], data: match[2] };
  return { mimeType: "image/jpeg", data: image };
}

export function toDataUrl(image: string): string {
  return image.startsWith("data:") ? image : `data:image/jpeg;base64,${image}`;
}

/** Gemini-style [y_min, x_min, y_max, x_max] on 0..1000 -> normalized Box. */
export function boxFrom1000(raw: unknown): Box | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const [y0, x0, y1, x1] = raw.map((v) => clamp(Number(v) / 1000, 0, 1));
  if ([y0, x0, y1, x1].some(Number.isNaN) || x1 <= x0 || y1 <= y0) return null;
  return { x0, y0, x1, y1 };
}

export function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

export async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await fn();
  return { value, ms: Math.round(performance.now() - start) };
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function parseJson<T>(text: string): T {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  return JSON.parse(trimmed) as T;
}

export const uid = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 9)}`;

/** Error text plus the underlying socket code, which `fetch` hides behind "fetch failed". */
export function errorDetail(err: unknown): string {
  const e = err as { message?: string; cause?: { code?: string; message?: string } };
  const code = e.cause?.code || e.cause?.message;
  return `${e.message ?? "unknown error"}${code ? ` (${code})` : ""}`;
}
