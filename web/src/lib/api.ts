import type {
  CommandType,
  FrameRequest,
  FrameResponse,
  ServerEvent,
  SessionSnapshot,
  StartQuestRequest,
  VoiceResponse,
} from "../../../shared/types.ts";

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
  muse: string;
  transcribe: string;
  vision: string;
  gemini: boolean;
}

export interface PresetSummary {
  id: string;
  title: string;
  type: string;
  steps: number;
}

export const api = {
  health: () => fetch("/api/health").then((r) => r.json() as Promise<Health>),
  presets: () => fetch("/api/presets").then((r) => r.json() as Promise<PresetSummary[]>),
  session: (id: string) => fetch(`/api/session/${id}`).then((r) => r.json() as Promise<SessionSnapshot>),
  frame: (body: FrameRequest) => post<FrameResponse>("/api/frame", body),
  startQuest: (body: StartQuestRequest) => post<SessionSnapshot>("/api/quest/start", body),
  command: (sessionId: string, type: CommandType, image?: string) =>
    post<SessionSnapshot>("/api/command", { sessionId, type, image }),
  intent: (sessionId: string, text: string) => post<VoiceResponse>("/api/intent", { sessionId, text }),
  voice: async (sessionId: string, wav: Blob): Promise<VoiceResponse> => {
    const res = await fetch(`/api/voice?sessionId=${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: wav,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `voice failed (${res.status})`);
    return res.json() as Promise<VoiceResponse>;
  },
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
