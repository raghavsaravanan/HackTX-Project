import { useEffect, useRef, useState } from "react";
import type { ServerEvent, SessionSnapshot } from "../../../shared/types.ts";
import { subscribeEvents } from "./api.ts";

/** Keeps the latest snapshot and forwards every event to `onEvent`. */
export function useSession(sessionId: string, role: "stage" | "phone", onEvent?: (e: ServerEvent) => void) {
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(
    () =>
      subscribeEvents(sessionId, role, (e) => {
        if (e.type === "snapshot") setSnapshot(e.snapshot);
        handler.current?.(e);
      }),
    [sessionId, role],
  );

  return snapshot;
}
