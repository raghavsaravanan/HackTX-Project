import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { SessionSnapshot } from "../../../shared/types.ts";
import type { Frame } from "../lib/lumi.tsx";
import { coverageText, describePlaced, distanceText, PROVENANCE_LABEL, reconstruct, type Placed, type Reconstruction } from "../lib/reconstruct.ts";
import { clockLabel } from "../lib/spatial.ts";
import { narrator } from "../lib/speech.ts";
import { Icon } from "../ui/Icon.tsx";
import type { Spatial3DHandle, ViewPreset } from "./Spatial3D.tsx";

const Spatial3D = lazy(() => import("./Spatial3D.tsx"));

const LIVE_MS = 12_000;

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

/** Width / height of the camera frames, to tell a phone held upright from one held sideways. */
function useFrameAspect(image: string | undefined) {
  const [aspect, setAspect] = useState<number | null>(null);
  const checkedAt = useRef(0);
  useEffect(() => {
    if (!image || Date.now() - checkedAt.current < 5000) return;
    checkedAt.current = Date.now();
    const img = new Image();
    img.onload = () => img.naturalHeight && setAspect(img.naturalWidth / img.naturalHeight);
    img.src = image;
  }, [image]);
  return aspect;
}

/** The approximate spatial model, recomputed when observations change or the live frame goes stale. */
export function useReconstruction(snapshot: SessionSnapshot | null, frame: Frame | null, now: number): Reconstruction {
  const aspect = useFrameAspect(frame?.image);
  const live = frame !== null && now - frame.at < LIVE_MS;
  // `live` flips when the latest frame goes stale, which demotes observed objects.
  return useMemo(() => reconstruct(snapshot, frame, Date.now(), aspect), [snapshot, frame, live, aspect]);
}

/** The 3D Quest Map with viewpoints, zoom, and a details strip for the selected object. */
export function SpatialView({ rec, snapshot }: { rec: Reconstruction; snapshot: SessionSnapshot | null }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<ViewPreset>("overview");
  const [showImage, setShowImage] = useState(true);
  const [error, setError] = useState("");
  const viewer = useRef<Spatial3DHandle>(null);
  const reduced = useReducedMotion();
  const selected = rec.objects.find((p) => p.id === selectedId) ?? null;

  const route = useMemo(() => {
    const order: string[] = [];
    (snapshot?.missions ?? []).forEach((_, i) => {
      const hit = rec.objects.find((p) => p.missions.includes(i));
      if (hit && order.at(-1) !== hit.id) order.push(hit.id);
    });
    return order;
  }, [rec, snapshot?.missions]);

  const choose = (preset: ViewPreset) => {
    setView(preset);
    viewer.current?.view(preset);
  };

  return (
    <div className="spatial-view">
      <div className="spatial-tools" role="toolbar" aria-label="3D view controls">
        <div className="segmented" role="group" aria-label="Viewpoint">
          {(
            [
              ["overview", "Overview"],
              ["user", "From the user"],
              ["top", "Top down"],
            ] as [ViewPreset, string][]
          ).map(([id, text]) => (
            <button type="button" key={id} aria-pressed={view === id} onClick={() => choose(id)}>
              {text}
            </button>
          ))}
        </div>
        <button type="button" className="small icon-only" aria-label="Zoom out" onClick={() => viewer.current?.zoom(1.2)}>
          −
        </button>
        <button type="button" className="small icon-only" aria-label="Zoom in" onClick={() => viewer.current?.zoom(0.83)}>
          +
        </button>
        <label className="switch">
          <input type="checkbox" checked={showImage} onChange={(e) => setShowImage(e.target.checked)} />
          <span>Camera image</span>
        </label>
      </div>
      <div className="viewer-stage">
        {error ? (
          <div className="viewer-message">{error}</div>
        ) : (
          <Suspense fallback={<div className="viewer-message">Loading the 3D view…</div>}>
            <Spatial3D
              ref={viewer}
              rec={rec}
              selectedId={selectedId}
              onSelect={setSelectedId}
              route={route}
              showImage={showImage}
              reducedMotion={reduced}
              onError={setError}
            />
          </Suspense>
        )}
        {rec.coverage.source === "none" && (
          <div className="viewer-overlay">
            <strong>Nothing observed yet</strong>
            <span>Objects appear as the Vision Agent recognizes them.</span>
          </div>
        )}
      </div>
      <p className="spatial-note" aria-live="polite">
        {selected ? <SelectedLine p={selected} /> : "Approximate model from one camera viewpoint: directions are observed, distances are estimated ranges. Select an object to inspect it."}
      </p>
    </div>
  );
}

function SelectedLine({ p }: { p: Placed }) {
  return (
    <>
      <span className={`prov-badge prov-${p.provenance}`}>{PROVENANCE_LABEL[p.provenance]}</span> <strong>{p.label}</strong>: around {clockLabel(p.clock)},{" "}
      {distanceText(p)}
      {p.provenance !== "earlier" ? `, ${p.heightBand}` : ""}
      {p.hazard ? ` · caution: ${p.hazard}` : ""}
    </>
  );
}

/** The same spatial information as the 3D view, as text and a table, with a read-aloud option. */
export function SpatialText({ rec }: { rec: Reconstruction }) {
  const sorted = [...rec.objects].sort((a, b) => a.distance.mid - b.distance.mid);
  const readAloud = () => {
    narrator.unlock();
    const lines = [coverageText(rec), ...sorted.map(describePlaced)];
    if (rec.unlocated.length) lines.push(`Not located yet: ${rec.unlocated.map((u) => u.label).join(", ")}.`);
    if (rec.hazards.length) lines.push(`Cautions: ${rec.hazards.join("; ")}.`);
    narrator.say(lines.join(" "), true);
  };
  return (
    <div className="spatial-text">
      <div className="summary-head">
        <p className="summary-coverage">{coverageText(rec)}</p>
        <button type="button" className="small" onClick={readAloud} disabled={rec.coverage.source === "none"}>
          <Icon name="volume" /> Read aloud
        </button>
      </div>
      {sorted.length > 0 ? (
        <div className="table-wrap">
          <table className="summary-table">
            <caption className="sr-only">Recognized objects, nearest first</caption>
            <thead>
              <tr>
                <th scope="col">Object</th>
                <th scope="col">Source</th>
                <th scope="col">Direction</th>
                <th scope="col">Distance (estimated)</th>
                <th scope="col">Notes</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((p) => (
                <tr key={p.id}>
                  <th scope="row">{p.label}</th>
                  <td>
                    <span className={`prov-badge prov-${p.provenance}`}>{PROVENANCE_LABEL[p.provenance]}</span>
                  </td>
                  <td>{clockLabel(p.clock)}</td>
                  <td>{distanceText(p)}</td>
                  <td>{[p.hazard && `Caution: ${p.hazard}`, p.missions.length ? `Step ${p.missions.map((i) => i + 1).join(", ")}` : "", p.note].filter(Boolean).join(" · ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">No objects placed yet.</p>
      )}
      {rec.unlocated.length > 0 && (
        <p className="summary-extra">
          <strong>Not located yet (not drawn):</strong> {rec.unlocated.map((u) => u.label).join(", ")}
        </p>
      )}
      {rec.hazards.length > 0 && (
        <p className="summary-extra">
          <strong>Cautions without a position:</strong> {rec.hazards.join("; ")}
        </p>
      )}
    </div>
  );
}
