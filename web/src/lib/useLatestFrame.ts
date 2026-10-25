import { useEffect, useState } from "react";

const POLL_MS = 1000;

/**
 * The phone's newest raw camera frame from the camera server, polled about once a second while
 * `enabled`. Analysis only runs during a task, so this keeps the camera visible the rest of the time.
 */
export function useLatestFrame(enabled: boolean): { url: string; at: number } | null {
  const [frame, setFrame] = useState<{ url: string; at: number } | null>(null);

  useEffect(() => {
    if (!enabled) {
      setFrame(null);
      return;
    }
    let stopped = false;
    let current = "";
    let timer = 0;
    const tick = async () => {
      try {
        const res = await fetch(`/api/frames/latest.jpg?t=${Date.now()}`, { cache: "no-store" });
        if (res.ok && !stopped) {
          const url = URL.createObjectURL(await res.blob());
          const previous = current;
          current = url;
          setFrame({ url, at: Date.now() });
          if (previous) setTimeout(() => URL.revokeObjectURL(previous), 2000);
        }
      } catch {
        // The camera server is briefly unreachable; try again on the next tick.
      }
      if (!stopped) timer = window.setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      if (current) setTimeout(() => URL.revokeObjectURL(current), 2000);
    };
  }, [enabled]);

  return frame;
}
