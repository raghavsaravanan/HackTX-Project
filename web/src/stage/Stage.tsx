import { useEffect, useState } from "react";
import type { Box, Guidance, Reward, ServerEvent, SessionSnapshot, StepObservation, VisionTiming } from "../../../shared/types.ts";
import { api, sessionIdFromUrl, type Health } from "../lib/api.ts";
import { playSfx, unlockAudio } from "../lib/sfx.ts";
import { narrator } from "../lib/speech.ts";
import { useSession } from "../lib/useSession.ts";

type PipelineStage = "transcribe" | "vision" | "plan" | "narrate" | "hint";
type PipelineState = Record<PipelineStage, { status: "idle" | "start" | "done" | "error"; ms?: number; detail?: string }>;

interface Frame {
  image: string;
  observation: StepObservation | null;
  guidance: Guidance;
  timing: VisionTiming | null;
}

interface Toast {
  id: number;
  reward: Reward;
  quest: boolean;
}

interface QuestDone {
  title: string;
  recap: string;
  durationMs: number;
  stats: SessionSnapshot["stats"];
}

const initialPipeline: PipelineState = {
  transcribe: { status: "idle" },
  vision: { status: "idle" },
  plan: { status: "idle" },
  narrate: { status: "idle" },
  hint: { status: "idle" },
};

export function Stage() {
  const sessionId = sessionIdFromUrl();
  const [health, setHealth] = useState<Health | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [subtitle, setSubtitle] = useState<{ text: string; source: string; key: number } | null>(null);
  const [transcript, setTranscript] = useState("");
  const [pipeline, setPipeline] = useState<PipelineState>(initialPipeline);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [levelUp, setLevelUp] = useState<number | null>(null);
  const [questDone, setQuestDone] = useState<QuestDone | null>(null);
  const [sound, setSound] = useState({ sfx: false, voice: false });
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, []);

  const snapshot = useSession(sessionId, "stage", (e: ServerEvent) => {
    switch (e.type) {
      case "frame":
        setFrame(e);
        if (e.timing) {
          const timing = e.timing;
          setPipeline((p) => ({ ...p, vision: { status: "done", ms: timing.ms, detail: e.guidance.phase } }));
        }
        break;
      case "say":
        setSubtitle({ text: e.text, source: e.source, key: Date.now() });
        if (sound.voice) narrator.say(e.text, e.priority);
        if (sound.sfx) playSfx(e.sfx);
        break;
      case "transcript":
        setTranscript(e.text);
        break;
      case "pipeline":
        setPipeline((p) => ({ ...p, [e.stage]: { status: e.status, ms: e.ms ?? p[e.stage].ms, detail: e.detail } }));
        break;
      case "reward": {
        const id = Date.now() + Math.random();
        setToasts((t) => [...t, { id, reward: e.reward, quest: e.stepId === "quest" }]);
        window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3800);
        if (e.reward.leveledUp) {
          setLevelUp(e.reward.level);
          window.setTimeout(() => setLevelUp(null), 3200);
        }
        if (sound.sfx) playSfx(e.reward.sfx);
        break;
      }
      case "quest_complete":
        setQuestDone({ title: e.title, recap: e.recap, durationMs: e.durationMs, stats: e.stats });
        break;
      case "snapshot":
        if (e.snapshot.status === "planning" || e.snapshot.status === "active") setQuestDone(null);
        break;
    }
  });

  const enableSound = () => {
    unlockAudio();
    narrator.unlock();
    setSound({ sfx: true, voice: sound.voice });
  };

  return (
    <div className="stage">
      <header className="stage-header">
        <div className="brand">
          <span className="brand-mark">SIDEQUEST</span>
          <span className="brand-tag">Gemini sees. Muse thinks. You conquer.</span>
        </div>
        <div className="header-right">
          <StatusPill status={snapshot?.status ?? "idle"} />
          {!sound.sfx ? (
            <button className="ghost" onClick={enableSound}>
              Enable stage sound
            </button>
          ) : (
            <label className="toggle">
              <input type="checkbox" checked={sound.voice} onChange={(e) => setSound({ ...sound, voice: e.target.checked })} />
              Narrator on speakers
            </label>
          )}
        </div>
      </header>

      <main className="stage-main">
        <CameraPanel frame={frame} />
        <aside className="stage-side">
          <QuestPanel snapshot={snapshot} now={now} />
          <PlayerPanel snapshot={snapshot} />
          <PipelinePanel pipeline={pipeline} health={health} />
        </aside>
      </main>

      <footer className="subtitle-bar">
        {transcript && <div className="you-said">Player: “{transcript}”</div>}
        <div className="subtitle-speaker">
          {snapshot?.narratorName ?? "Sir Echo"}
          <span className="subtitle-source">{subtitle?.source === "muse" ? "Muse Spark" : "system"}</span>
        </div>
        <div key={subtitle?.key} className="subtitle-text">
          {subtitle?.text ?? "Awaiting a hero..."}
        </div>
      </footer>

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.quest ? "toast-quest" : ""}`}>
            <div className="toast-xp">+{t.reward.xpGained} XP</div>
            <div className="toast-chips">
              {t.reward.breakdown.map((b) => (
                <span key={b.label}>
                  {b.label} +{b.xp}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

      {levelUp !== null && (
        <div className="levelup">
          <div className="levelup-label">LEVEL UP</div>
          <div className="levelup-number">{levelUp}</div>
        </div>
      )}

      {questDone && (
        <div className="quest-done" onClick={() => setQuestDone(null)}>
          <div className="quest-done-card">
            <div className="quest-done-kicker">Quest complete</div>
            <h2>{questDone.title}</h2>
            <p className="quest-done-recap">{questDone.recap}</p>
            <div className="quest-done-stats">
              <Stat label="Time" value={formatDuration(questDone.durationMs)} />
              <Stat label="Level" value={String(questDone.stats.level)} />
              <Stat label="Total XP" value={String(questDone.stats.xp)} />
              <Stat label="Best combo" value={`x${questDone.stats.bestCombo}`} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const label: Record<string, string> = {
    idle: "Waiting for a quest",
    planning: "Planning quest",
    active: "Quest in progress",
    paused: "Paused",
    complete: "Victory",
  };
  return <span className={`pill pill-${status}`}>{label[status] ?? status}</span>;
}

const PHASE_LABEL: Record<Guidance["phase"], string> = {
  idle: "Idle",
  scan: "Scanning",
  aim: "Aiming",
  approach: "Approaching",
  reach: "Reaching",
  verify: "Verifying",
};

function CameraPanel({ frame }: { frame: Frame | null }) {
  const g = frame?.guidance;
  const o = frame?.observation;
  return (
    <section className="camera-panel">
      <div className="panel-title">
        What the AI sees
        {frame?.timing && (
          <span className="latency">
            {frame.timing.model} · {frame.timing.ms} ms
          </span>
        )}
      </div>
      <div className="camera-frame">
        {frame ? (
          <div className="camera-inner">
            <img src={frame.image} alt="" />
            <svg viewBox="0 0 1 1" preserveAspectRatio="none">
              {o?.destinationBox && <BoxRect box={o.destinationBox} className="box-dest" />}
              {o?.targetBox && <BoxRect box={o.targetBox} className="box-target" />}
              {o?.handBox && <BoxRect box={o.handBox} className="box-hand" />}
              <line x1="0.5" y1="0" x2="0.5" y2="1" className="crosshair" />
            </svg>
            {o?.targetBox && <BoxLabel box={o.targetBox} text="target" className="label-target" />}
            {o?.destinationBox && <BoxLabel box={o.destinationBox} text="destination" className="label-dest" />}
            {o?.handBox && <BoxLabel box={o.handBox} text="hand" className="label-hand" />}
          </div>
        ) : (
          <div className="camera-empty">Waiting for the phone camera...</div>
        )}
        {g && <div className={`phase phase-${g.phase}`}>{PHASE_LABEL[g.phase]}</div>}
        {o?.hazard && <div className="hazard">Hazard: {o.hazard}</div>}
      </div>

      <div className="guidance-row">
        <div className="meter">
          <div className="meter-label">Direction</div>
          <div className="pan-track">
            <span>L</span>
            <div className="pan-bar">
              <div className="pan-dot" style={{ left: `${50 + (g?.pan ?? 0) * 50}%` }} />
            </div>
            <span>R</span>
          </div>
        </div>
        <div className="meter">
          <div className="meter-label">Proximity</div>
          <div className="prox-bar">
            <div className="prox-fill" style={{ width: `${Math.round((g?.proximity ?? 0) * 100)}%` }} />
          </div>
        </div>
        <div className="meter meter-wide">
          <div className="meter-label">Spoken cue</div>
          <div className="cue-text">{g?.say || "—"}</div>
        </div>
      </div>
    </section>
  );
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

function QuestPanel({ snapshot, now }: { snapshot: SessionSnapshot | null; now: number }) {
  const quest = snapshot?.quest;
  if (!quest) {
    return (
      <section className="card">
        <div className="panel-title">Quest</div>
        <p className="muted">Say a goal like “help me clean my desk” to begin.</p>
      </section>
    );
  }
  const stepElapsed = snapshot.stepStartedAt ? now - snapshot.stepStartedAt : 0;
  const questElapsed = snapshot.questStartedAt ? (snapshot.questEndedAt ?? now) - snapshot.questStartedAt : 0;
  return (
    <section className="card">
      <div className="panel-title">
        {quest.type === "boss" ? <span className="tag tag-boss">Boss quest</span> : <span className="tag">Side quest</span>}
        <span className="timer">{formatDuration(questElapsed)}</span>
      </div>
      <h2 className="quest-title">{quest.title}</h2>
      <ol className="steps">
        {quest.steps.map((step, i) => {
          const state = i < snapshot.stepIndex || snapshot.status === "complete" ? "done" : i === snapshot.stepIndex ? "current" : "todo";
          return (
            <li key={step.id} className={`step step-${state}`}>
              <span className="step-icon">{state === "done" ? "✓" : i + 1}</span>
              <span className="step-body">
                <span className="step-action">{step.action}</span> {step.target}
                {step.destination && <span className="step-dest"> → {step.destination}</span>}
              </span>
              {state === "current" && snapshot.status === "active" && <span className="step-timer">{formatDuration(stepElapsed)}</span>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function PlayerPanel({ snapshot }: { snapshot: SessionSnapshot | null }) {
  const s = snapshot?.stats;
  if (!s) return null;
  const pct = Math.min(100, Math.round((s.xpIntoLevel / s.xpForNextLevel) * 100));
  return (
    <section className="card player">
      <div className="level-badge">
        <div className="level-label">LVL</div>
        <div className="level-number">{s.level}</div>
      </div>
      <div className="player-body">
        <div className="xp-row">
          <span>{s.xp} XP</span>
          <span className="muted">
            {s.xpIntoLevel}/{s.xpForNextLevel} to next
          </span>
        </div>
        <div className="xp-bar">
          <div className="xp-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="player-stats">
          <span className={`combo ${s.combo >= 3 ? "combo-hot" : ""}`}>Combo x{s.combo}</span>
          <span>{s.stepsCompleted} steps</span>
          <span>{s.questsCompleted} quests</span>
        </div>
      </div>
    </section>
  );
}

function PipelinePanel({ pipeline, health }: { pipeline: PipelineState; health: Health | null }) {
  const rows: { key: PipelineStage; verb: string; model: string }[] = [
    { key: "transcribe", verb: "Hear", model: health?.transcribe ?? "Muse Voice Transcribe" },
    { key: "vision", verb: "See", model: health?.vision ?? "Gemini" },
    { key: "plan", verb: "Plan", model: health?.muse ?? "Muse Spark" },
    { key: "narrate", verb: "Narrate", model: health?.muse ?? "Muse Spark" },
    { key: "hint", verb: "Hint", model: health?.muse ?? "Muse Spark" },
  ];
  return (
    <section className="card">
      <div className="panel-title">AI pipeline</div>
      <ul className="pipeline">
        {rows.map((r) => {
          const p = pipeline[r.key];
          return (
            <li key={r.key} className={`pipe pipe-${p.status}`}>
              <span className="pipe-dot" />
              <span className="pipe-verb">{r.verb}</span>
              <span className="pipe-model">{r.model}</span>
              <span className="pipe-ms">{p.status === "start" ? "…" : p.ms !== undefined ? `${p.ms} ms` : ""}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function formatDuration(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
