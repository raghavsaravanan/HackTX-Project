import type { ApiCall, ApiOperation, ApiProvider } from "../shared/types.ts";
import { redact } from "./config.ts";
import { uid } from "./util.ts";

type Listener = (call: ApiCall) => void;

const listeners = new Set<Listener>();
const finished: ApiCall[] = [];
const MAX_FINISHED = 40;

export function onApiCall(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The most recent finished calls, oldest first, so a page that opens late still sees them. */
export const recentApiCalls = (): readonly ApiCall[] => finished;

function emit(call: ApiCall) {
  if (call.status !== "running") {
    finished.push(call);
    if (finished.length > MAX_FINISHED) finished.shift();
  }
  for (const listener of listeners) listener(call);
}

export interface CallMeta {
  provider: ApiProvider;
  model: string;
  operation: ApiOperation;
  fallbackFrom?: ApiProvider;
  fallbackReason?: string;
  attempt?: number;
}

/** Run one outbound API call and report it as it starts and when it succeeds or fails. */
export async function trackApiCall<T>(meta: CallMeta, fn: () => Promise<T>, summarize?: (value: T) => string): Promise<T> {
  const call: ApiCall = { id: uid("api"), status: "running", startedAt: Date.now(), ...meta };
  if (call.fallbackReason) call.fallbackReason = redact(call.fallbackReason).slice(0, 120);
  emit(call);
  try {
    const value = await fn();
    let summary: string | undefined;
    try {
      summary = summarize?.(value)?.slice(0, 140);
    } catch {
      summary = undefined;
    }
    emit({ ...call, status: "ok", ms: Date.now() - call.startedAt, summary });
    return value;
  } catch (err) {
    emit({ ...call, status: "error", ms: Date.now() - call.startedAt, error: redact((err as Error).message).slice(0, 160) });
    throw err;
  }
}

export const shortError = (err: unknown) => redact((err as Error)?.message ?? String(err)).slice(0, 120);
