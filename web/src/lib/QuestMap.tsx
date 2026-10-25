import { useState } from "react";
import type { MapLandmark, MissionState, QuestStep, SessionSnapshot, VisionCheck } from "../../../shared/types.ts";
import { api } from "./api.ts";

// Map coordinates are 0..100 on both axes; the SVG is wider than tall.
const W = 160;
const H = 100;
const px = (x: number) => 8 + (x / 100) * (W - 16);
const py = (y: number) => 6 + (y / 100) * (H - 12);
const START = { x: px(50), y: py(97) };

type Selection = { kind: "mission"; index: number } | { kind: "landmark"; id: string } | null;

export function QuestMap({ snapshot, sessionId, compact = false }: { snapshot: SessionSnapshot | null; sessionId: string; compact?: boolean }) {
  const [selected, setSelected] = useState<Selection>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const quest = snapshot?.quest ?? null;
  if (!snapshot || (!quest && snapshot.map.landmarks.length === 0)) {
    return (
      <section className="card quest-map">
        <div className="panel-title">Quest map</div>
        <p className="muted">The Vision Agent maps your surroundings once the phone camera is streaming.</p>
      </section>
    );
  }

  const { map, missions } = snapshot;
  const steps = quest?.steps ?? [];
  const byId = new Map(map.landmarks.map((l) => [l.id, l]));
  const player = map.playerAt ? byId.get(map.playerAt) : undefined;
  const playerPos = player ? { x: px(player.x) - 8, y: py(player.y) } : START;

  // Missions at the same landmark fan out so their badges don't overlap.
  const seenAt = new Map<string, number>();
  const nodes = steps.map((step, i) => {
    const mission = missions[i];
    const landmark = mission?.landmarkId ? byId.get(mission.landmarkId) : undefined;
    const base = landmark ? { x: px(landmark.x), y: py(landmark.y) } : { x: px(15 + (i * 70) / Math.max(1, steps.length - 1)), y: py(45) };
    const n = seenAt.get(mission?.landmarkId ?? `none${i}`) ?? 0;
    seenAt.set(mission?.landmarkId ?? `none${i}`, n + 1);
    return { step, mission, x: base.x + 6 + n * 7, y: base.y - 6 };
  });

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const route = [START, ...nodes].map((p) => `${p.x},${p.y}`).join(" ");

  return (
    <section className={`card quest-map ${compact ? "quest-map-compact" : ""}`}>
      <div className="panel-title">
        {quest ? "Quest map" : "Surroundings"}
        {map.goalCheck && <VerdictChip check={map.goalCheck} label="Goal" />}
      </div>
      {map.setting && <p className="map-setting">{map.setting}</p>}
      <svg viewBox={`0 0 ${W} ${H}`} className="map-svg" role="img" aria-label="Quest map">
        {nodes.length > 0 && <polyline points={route} className="map-route" />}
        {nodes.map((node, i) => {
          const prev = i === 0 ? START : nodes[i - 1];
          return <line key={node.step.id} x1={prev.x} y1={prev.y} x2={node.x} y2={node.y} className={`map-leg map-leg-${node.mission?.status ?? "locked"}`} />;
        })}

        {map.landmarks.map((l) => (
          <g
            key={l.id}
            className={`map-landmark ${l.seen ? "seen" : "unseen"} ${map.playerAt === l.id ? "here" : ""} ${selected?.kind === "landmark" && selected.id === l.id ? "selected" : ""}`}
            transform={`translate(${px(l.x)} ${py(l.y)})`}
            onClick={() => setSelected({ kind: "landmark", id: l.id })}
          >
            <rect x={-3} y={-3} width={6} height={6} transform="rotate(45)" />
            <text y={8} textAnchor="middle">
              {l.label}
            </text>
          </g>
        ))}

        {nodes.map((node, i) => (
          <g
            key={node.step.id}
            className={`map-mission map-mission-${node.mission?.status ?? "locked"} ${selected?.kind === "mission" && selected.index === i ? "selected" : ""}`}
            transform={`translate(${node.x} ${node.y})`}
            onClick={() => setSelected({ kind: "mission", index: i })}
          >
            <circle r={4.2} />
            <text dy={1.6} textAnchor="middle">
              {node.mission?.status === "done" ? "✓" : i + 1}
            </text>
          </g>
        ))}

        <g className="map-player" transform={`translate(${playerPos.x} ${playerPos.y})`}>
          <circle r={2.6} />
          <circle r={5} className="map-player-ring" />
        </g>
      </svg>

      <Legend />

      {selected?.kind === "mission" && steps[selected.index] && (
        <MissionDetail
          index={selected.index}
          step={steps[selected.index]}
          mission={missions[selected.index]}
          busy={busy}
          onVerify={() => run(() => api.verifyMission(sessionId, steps[selected.index].id))}
        />
      )}
      {selected?.kind === "landmark" && byId.get(selected.id) && (
        <LandmarkDetail
          landmark={byId.get(selected.id)!}
          here={map.playerAt === selected.id}
          busy={busy}
          onAsk={() => run(() => api.ask(sessionId, `Where is the ${byId.get(selected.id)!.label}?`))}
        />
      )}
      {error && <div className="error">{error}</div>}
    </section>
  );
}

const STATUS_LABEL: Record<MissionState["status"], string> = {
  locked: "Locked",
  active: "In progress",
  verifying: "Vision Agent checking…",
  retry: "Needs another try",
  done: "Complete",
  skipped: "Skipped",
};

function MissionDetail({ index, step, mission, busy, onVerify }: { index: number; step: QuestStep; mission?: MissionState; busy: boolean; onVerify: () => void }) {
  return (
    <div className="map-detail">
      <div className="map-detail-head">
        <strong>
          {index + 1}. {step.action} {step.target}
          {step.destination && ` → ${step.destination}`}
        </strong>
        <span className={`mission-status mission-${mission?.status ?? "locked"}`}>{STATUS_LABEL[mission?.status ?? "locked"]}</span>
      </div>
      <div className="muted">Check: “{step.check}”</div>
      {mission?.note && <div className="muted">Note: {mission.note}</div>}
      {mission?.lastCheck && <CheckDetail check={mission.lastCheck} />}
      <button className="small" disabled={busy || mission?.status === "verifying"} onClick={onVerify}>
        {busy ? "Checking…" : "Verify with Vision Agent"}
      </button>
    </div>
  );
}

function LandmarkDetail({ landmark, here, busy, onAsk }: { landmark: MapLandmark; here: boolean; busy: boolean; onAsk: () => void }) {
  return (
    <div className="map-detail">
      <div className="map-detail-head">
        <strong>{landmark.label}</strong>
        <span className="muted">{here ? "You are here" : landmark.seen ? "Spotted by camera" : "Not seen yet"}</span>
      </div>
      {landmark.note && <div className="muted">{landmark.note}</div>}
      <button className="small" disabled={busy} onClick={onAsk}>
        {busy ? "Asking…" : "Ask the Quest Agent where it is"}
      </button>
    </div>
  );
}

export function CheckDetail({ check }: { check: VisionCheck }) {
  return (
    <div className="check-detail">
      <VerdictChip check={check} />
      <span className="muted">
        {Math.round(check.confidence * 100)}% · {check.model} · {check.ms} ms
      </span>
      {check.evidence.length > 0 && (
        <ul className="evidence">
          {check.evidence.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function VerdictChip({ check, label }: { check: VisionCheck; label?: string }) {
  return (
    <span className={`verdict verdict-${check.verdict.toLowerCase()}`} title={check.question}>
      {label ? `${label}: ` : ""}
      {check.verdict}
    </span>
  );
}

function Legend() {
  return (
    <div className="map-legend">
      <span className="lg lg-active">current</span>
      <span className="lg lg-verifying">checking</span>
      <span className="lg lg-retry">retry</span>
      <span className="lg lg-done">done</span>
      <span className="lg lg-player">you</span>
    </div>
  );
}
