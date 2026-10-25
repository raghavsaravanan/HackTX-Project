import { useEffect, useState } from "react";

export type StageId = "discover" | "begin" | "live";

/** The three screens, in order: what Lumi is, connecting the phone, and the live dashboard. */
export const JOURNEY: { id: StageId; label: string }[] = [
  { id: "discover", label: "Overview" },
  { id: "begin", label: "Connect" },
  { id: "live", label: "Live" },
];

const LEGACY: Record<string, StageId> = {
  connect: "begin",
  quest: "live",
  camera: "live",
  apis: "live",
  perceive: "live",
  understand: "live",
  guide: "live",
  explore: "live",
  explain: "live",
};

function stageFromHash(): StageId {
  const id = location.hash.replace(/^#\/?/, "");
  if (JOURNEY.some((s) => s.id === id)) return id as StageId;
  if (LEGACY[id]) return LEGACY[id];
  return location.pathname.startsWith("/stage") ? "live" : "discover";
}

export function navigate(id: StageId) {
  if (location.hash !== `#${id}`) location.hash = id;
}

/** The current screen, kept in the URL hash so it survives reloads and works with back/forward. */
export function useStage(): StageId {
  const [stage, setStage] = useState<StageId>(stageFromHash);
  useEffect(() => {
    const onHash = () => {
      setStage(stageFromHash());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return stage;
}
