import type { AskResponse, ServerEvent, SessionSnapshot, VisionCheck } from "../../../shared/types.ts";

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `${url} failed (${res.status})`);
  return res.json() as Promise<T>;
}

export interface Health {
  agent: { name: string; wakePhrase: string };
  muse: string;
  transcribe: string;
  speak?: string;
  vision: string;
  quest: string;
  gemini: boolean;
  verifySteps: boolean;
  visionNote?: string;
  visionQueue?: { interactive: number; background: number };
  cameraLink: { url: string; reachable: boolean; lastFrameAgeMs: number | null } | null;
}

/** The Python camera server's pairing info (proxied by Vite). */
export interface CameraInfo {
  phone_url: string;
  gateway_url: string;
  peers: string[];
}

const getJson = <T,>(url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${url} failed (${r.status})`);
    return r.json() as Promise<T>;
  });

export const api = {
  health: () => getJson<Health>("/api/health"),
  cameraInfo: () => getJson<CameraInfo>("/api/info"),
  ask: (sessionId: string, text: string) => post<AskResponse>("/api/agent/ask", { sessionId, text }),
  verifyMission: (sessionId: string, stepId: string) =>
    post<{ check: VisionCheck; snapshot: SessionSnapshot }>("/api/mission/verify", { sessionId, stepId }),
};

/** Subscribe to session events. Returns an unsubscribe function. EventSource reconnects on its own. */
export function subscribeEvents(sessionId: string, role: "stage" | "phone", onEvent: (e: ServerEvent) => void): () => void {
  const source = new EventSource(`/api/session/${encodeURIComponent(sessionId)}/events?role=${role}`);
  source.onmessage = (msg) => onEvent(JSON.parse(msg.data) as ServerEvent);
  return () => source.close();
}

export function sessionIdFromUrl(): string {
  return new URLSearchParams(location.search).get("session") ?? "demo";
}

export const SOURCE_LABEL: Record<string, string> = { gemini: "Gemini Quest Agent", openai: "OpenAI Quest Agent", muse: "Muse Spark", system: "Lumi" };
