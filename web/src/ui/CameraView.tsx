import type { ReactNode } from "react";
import type { Box, Guidance } from "../../../shared/types.ts";
import type { Frame } from "../lib/lumi.tsx";

const PHASE_LABEL: Record<Guidance["phase"], string> = {
  idle: "Idle",
  scan: "Scanning",
  aim: "Aiming",
  approach: "Approaching",
  reach: "Reaching",
  verify: "Verifying",
};

/** The latest analyzed camera frame with the Vision Agent's boxes drawn over it. */
export function CameraView({ frame, compact = false, empty }: { frame: Frame | null; compact?: boolean; empty?: ReactNode }) {
  const g = frame?.guidance;
  const o = frame?.observation;
  return (
    <div className={`camera-frame ${compact ? "camera-compact" : ""}`}>
      {frame ? (
        <div className="camera-inner">
          <img src={frame.image} alt={describeFrame(frame)} />
          <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden>
            {o?.destinationBox && <BoxRect box={o.destinationBox} className="box-dest" />}
            {o?.targetBox && <BoxRect box={o.targetBox} className="box-target" />}
            {o?.handBox && <BoxRect box={o.handBox} className="box-hand" />}
            <line x1="0.5" y1="0" x2="0.5" y2="1" className="crosshair" />
          </svg>
          {!compact && o?.targetBox && <BoxLabel box={o.targetBox} text="target" className="label-target" />}
          {!compact && o?.destinationBox && <BoxLabel box={o.destinationBox} text="destination" className="label-dest" />}
          {!compact && o?.handBox && <BoxLabel box={o.handBox} text="hand" className="label-hand" />}
        </div>
      ) : (
        <div className="camera-empty">{empty ?? "Waiting for the phone camera…"}</div>
      )}
      {g && g.phase !== "idle" && <div className={`phase phase-${g.phase}`}>{PHASE_LABEL[g.phase]}</div>}
      {o?.hazard && (
        <div className="hazard" role="alert">
          Careful: {o.hazard}
        </div>
      )}
    </div>
  );
}

function describeFrame(frame: Frame): string {
  const o = frame.observation;
  if (!o) return "Latest camera frame from the phone.";
  const parts = [o.targetVisible ? "target in view" : "target not in view", o.handVisible ? "hand in view" : "", o.hazard ? `hazard: ${o.hazard}` : ""];
  return `Latest camera frame: ${parts.filter(Boolean).join(", ")}.`;
}

function BoxRect({ box, className }: { box: Box; className: string }) {
  return <rect x={box.x0} y={box.y0} width={box.x1 - box.x0} height={box.y1 - box.y0} className={className} vectorEffect="non-scaling-stroke" />;
}

function BoxLabel({ box, text, className }: { box: Box; text: string; className: string }) {
  return (
    <span className={`box-label ${className}`} style={{ left: `${box.x0 * 100}%`, top: `${box.y0 * 100}%` }}>
      {text}
    </span>
  );
}

export function CameraLegend() {
  return (
    <div className="camera-legend" aria-hidden>
      <span className="lg-box lg-target">Target</span>
      <span className="lg-box lg-dest">Destination</span>
      <span className="lg-box lg-hand">Hand</span>
    </div>
  );
}
