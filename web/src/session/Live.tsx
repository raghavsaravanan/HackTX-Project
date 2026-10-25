import { useState, type FormEvent } from "react";
import type { Guidance, MissionStatus, QuestStep, StepObservation } from "../../../shared/types.ts";
import { api, SOURCE_LABEL } from "../lib/api.ts";
import { navigate } from "../lib/journey.ts";
import { formatDuration, useLumi, type Frame } from "../lib/lumi.tsx";
import { useLatestFrame } from "../lib/useLatestFrame.ts";
import { bearingOfBox, clockLabel, DISTANCE_LABEL, qualifier, relationBetween } from "../lib/spatial.ts";
import { CameraLegend, CameraView } from "../ui/CameraView.tsx";
import { Icon } from "../ui/Icon.tsx";
import { VerdictChip } from "../ui/Verdict.tsx";
import { SpatialText, SpatialView, useReconstruction } from "./Spatial.tsx";

type ViewMode = "camera" | "map" | "text";

/** Analysis results come every few seconds during a task; within this window they stay on screen. */
const ANALYZED_FRESH_MS = 10_000;
const IDLE_GUIDANCE: Guidance = { phase: "idle", pan: 0, proximity: 0, say: "", navBox: null };

const STATUS_LABEL: Record<string, string> = {
  idle: "Ready for a task",
  planning: "Planning",
  active: "Guiding",
  paused: "Paused",
  complete: "Task complete",
};

const PHASE_COPY: Record<string, string> = {
  idle: "Waiting",
  scan: "Searching",
  aim: "Turning toward it",
  approach: "Moving closer",
  reach: "Within reach",
  verify: "Checking the step",
};

const FLAG: Partial<Record<MissionStatus, string>> = { verifying: "Checking", retry: "Try again", skipped: "Skipped" };

const SUGGESTIONS = ["Help me tidy my desk", "Find my water bottle", "Describe what's around me"];

/** The one live screen: what the camera sees, the task, what Lumi understood, and how it got there. */
export function Live() {
  const { snapshot } = useLumi();
  const status = snapshot?.status ?? "idle";
  return (
    <div className="session">
      <div className="session-body live">
        <header className="live-head">
          <h1 tabIndex={-1}>Live session</h1>
          <span className={`status-pill status-${status}`}>{STATUS_LABEL[status] ?? status}</span>
        </header>
        <div className="live-grid">
          <ViewPanel />
          <div className="live-side">
            <TaskCard />
            <UnderstandingCard />
          </div>
        </div>
      </div>
      <LiveBar />
    </div>
  );
}

function ViewPanel() {
  const { frame, snapshot, phoneOpen, streaming, now } = useLumi();
  const [mode, setMode] = useState<ViewMode>("camera");
  const rec = useReconstruction(snapshot, frame, now);
  // Analyzed frames only arrive during a task; otherwise show the phone's raw frames so the camera is always visible.
  const analyzedFresh = frame !== null && now - frame.at < ANALYZED_FRESH_MS;
  const preview = useLatestFrame(mode === "camera" && streaming && !analyzedFresh);
  const shown: Frame | null = analyzedFresh ? frame : preview ? { image: preview.url, observation: null, guidance: IDLE_GUIDANCE, timing: null, at: preview.at } : frame;
  const g = analyzedFresh ? frame.guidance : null;
  const o = analyzedFresh ? frame.observation : null;
  const bearing = g?.navBox ? bearingOfBox(g.navBox) : null;

  return (
    <section className="panel view-panel" aria-labelledby="view-title">
      <div className="view-head">
        <div className="panel-title" id="view-title">
          What Lumi sees
        </div>
        <div className="segmented" role="group" aria-label="View">
          {(
            [
              ["camera", "Camera"],
              ["map", "3D map"],
              ["text", "Text"],
            ] as [ViewMode, string][]
          ).map(([id, label]) => (
            <button type="button" key={id} aria-pressed={mode === id} onClick={() => setMode(id)}>
              {label}
            </button>
          ))}
        </div>
        {mode === "camera" && analyzedFresh && frame.timing && (
          <span className="mono-chip">
            {frame.timing.model} · {frame.timing.ms} ms
          </span>
        )}
        {mode === "camera" && !analyzedFresh && preview && <span className="mono-chip preview-chip">Live preview · analyzed once a task starts</span>}
      </div>

      {mode === "camera" && (
        <>
          <CameraView
            frame={shown}
            empty={
              <div className="empty-camera">
                <strong>{phoneOpen ? "The phone is open. Tap Start on it to turn the camera on." : "No camera yet."}</strong>
                {!phoneOpen && (
                  <button type="button" onClick={() => navigate("begin")}>
                    Connect a phone
                  </button>
                )}
              </div>
            }
          />
          <div className="meters">
            <div className="meter">
              <div className="meter-label">
                Direction <span>{bearing ? (bearing.side === "ahead" ? "straight ahead" : clockLabel(bearing.clock)) : "—"}</span>
              </div>
              <div className="pan-track" aria-hidden>
                <span>L</span>
                <div className="pan-bar">
                  <div className="pan-dot" style={{ left: `${50 + (g?.pan ?? 0) * 50}%` }} />
                </div>
                <span>R</span>
              </div>
            </div>
            <div className="meter">
              <div className="meter-label">
                Distance <span>{o?.targetVisible ? DISTANCE_LABEL[o.distance] : "—"}</span>
              </div>
              <div className="prox-bar" aria-hidden>
                <div className="prox-fill" style={{ width: `${Math.round((g?.proximity ?? 0) * 100)}%` }} />
              </div>
            </div>
          </div>
          {g?.say && (
            <p className="now-cue">
              <Icon name="wave" /> <span>Cue to the phone: {g.say}</span>
            </p>
          )}
          <CameraLegend />
        </>
      )}
      {mode === "map" && <SpatialView rec={rec} snapshot={snapshot} />}
      {mode === "text" && <SpatialText rec={rec} />}
    </section>
  );
}

function TaskCard() {
  const { snapshot, frame, sessionId, now } = useLumi();
  const [busy, setBusy] = useState("");
  const quest = snapshot?.quest ?? null;
  const status = snapshot?.status ?? "idle";
  const g = frame?.guidance ?? null;

  const send = async (label: string, text: string) => {
    setBusy(label);
    try {
      await api.say(sessionId, text);
    } finally {
      setBusy("");
    }
  };

  if (!quest) {
    return (
      <section className="panel task-card" aria-labelledby="task-title">
        <div className="panel-title" id="task-title">
          Task
        </div>
        <h2 className="task-empty-title">{status === "planning" ? "Planning the task…" : "No task yet"}</h2>
        <p className="muted">
          {status === "planning"
            ? "Lumi is turning what the camera sees into a few touch-based steps."
            : `On the phone, say “${snapshot?.wakePhrase ?? "Hi Lumi"}, help me tidy my desk,” or start one here.`}
        </p>
        {status !== "planning" && (
          <div className="chips">
            {SUGGESTIONS.map((s) => (
              <button type="button" key={s} className="chip" disabled={Boolean(busy)} onClick={() => void send(s, s)}>
                {s}
              </button>
            ))}
          </div>
        )}
      </section>
    );
  }

  const step = quest.steps[snapshot!.stepIndex] ?? null;
  const done = snapshot!.missions.filter((m) => m.status === "done").length;
  const elapsed = snapshot!.questStartedAt ? (snapshot!.questEndedAt ?? now) - snapshot!.questStartedAt : 0;
  const actions: [string, string][] = [
    ["Repeat", "repeat"],
    ["Is this step done?", "Is this step done?"],
    status === "paused" ? ["Resume", "resume"] : ["Pause", "pause"],
    ["Skip", "skip"],
  ];

  return (
    <section className="panel task-card" aria-labelledby="task-title">
      <div className="panel-title">
        <span id="task-title">{quest.title}</span>
        <span className="mono-chip">{formatDuration(elapsed)}</span>
      </div>
      <div className="task-now">
        <span className="page-kicker">
          {step ? `Step ${snapshot!.stepIndex + 1} of ${quest.steps.length}` : `${done} of ${quest.steps.length} confirmed`}
        </span>
        {g && step && <span className={`phase-chip phase-${g.phase}`}>{PHASE_COPY[g.phase]}</span>}
      </div>
      <p className="task-instruction">{step ? step.instruction : status === "complete" ? "All steps are done." : "Final check of the whole task…"}</p>
      <ol className="steps">
        {quest.steps.map((s, i) => {
          const mission = snapshot!.missions[i]?.status ?? "locked";
          const state = mission === "done" || mission === "skipped" ? "done" : i === snapshot!.stepIndex && status !== "complete" ? "current" : "todo";
          return (
            <li key={s.id} className={`step step-${state} mission-row-${mission}`} aria-current={state === "current" ? "step" : undefined}>
              <span className="step-icon" aria-hidden>
                {mission === "done" ? "✓" : i + 1}
              </span>
              <span className="step-body">{s.summary || `${s.action} the ${s.target}`}</span>
              {FLAG[mission] && <span className={`step-flag flag-${mission}`}>{FLAG[mission]}</span>}
            </li>
          );
        })}
      </ol>
      {status !== "complete" && (
        <div className="quick-actions" aria-label="Quick actions">
          {actions.map(([label, text]) => (
            <button type="button" key={label} className="chip" disabled={Boolean(busy)} onClick={() => void send(label, text)}>
              {busy === label ? "Sending…" : label}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function UnderstandingCard() {
  const { snapshot, frame, lastCheck } = useLumi();
  const scene = snapshot?.scene ?? null;
  const setting = scene?.setting || snapshot?.map.setting || "";
  const hazards = [...new Set([...(scene?.hazards ?? []), ...(frame?.observation?.hazard ? [frame.observation.hazard] : [])])].filter(Boolean);
  const step = snapshot?.quest?.steps[snapshot.stepIndex] ?? null;
  const check = lastCheck ?? snapshot?.map.goalCheck ?? null;
  const objects = scene?.objects.length ?? snapshot?.map.landmarks.filter((l) => l.seen).length ?? 0;

  return (
    <section className="panel understanding" aria-labelledby="understanding-title">
      <div className="panel-title">
        <span id="understanding-title">What Lumi understands</span>
        {objects > 0 && <span className="panel-meta">{objects} objects recognized</span>}
      </div>
      {setting ? <p className="scene-line">{setting}</p> : <p className="muted">Lumi describes the place after its first look around.</p>}
      {hazards.length > 0 && (
        <ul className="hazard-list" role="alert">
          {hazards.map((h) => (
            <li key={h}>
              <Icon name="alert" /> {h}
            </li>
          ))}
        </ul>
      )}
      {step && <Focus step={step} observation={frame?.observation ?? null} />}
      {check && (
        <div className="last-check">
          <VerdictChip check={check} />
          <span>
            “{check.question}” {check.evidence[0] ? `— ${check.evidence[0]}` : ""}
          </span>
        </div>
      )}
    </section>
  );
}

function Focus({ step, observation: o }: { step: QuestStep; observation: StepObservation | null }) {
  if (!o) return <p className="muted focus-wait">Waiting for the next analyzed frame.</p>;
  const q = qualifier(o.confidence);
  const lines: string[] = [];
  if (o.targetVisible && o.targetBox) {
    const b = bearingOfBox(o.targetBox);
    lines.push(`The ${step.target} is ${b.sideLabel}, around ${clockLabel(b.clock)}, ${DISTANCE_LABEL[o.distance]}.`);
  } else {
    lines.push(`The ${step.target} is not in view right now.`);
  }
  if (o.targetBox && o.destinationBox && step.destination) {
    const rel = relationBetween(o.targetBox, o.destinationBox);
    if (rel) lines.push(`It is ${rel} the ${step.destination}.`);
  }
  if (o.holdingTarget) lines.push(`The user is holding the ${step.target}.`);
  else if (o.handBox && o.targetBox) {
    const rel = relationBetween(o.handBox, o.targetBox);
    if (rel) lines.push(`The hand is ${rel} the ${step.target}.`);
  }
  return (
    <div className="focus">
      <div className={`qualifier qualifier-${q.level}`}>
        <span>{q.word}</span>
        <span className="confidence-track" aria-hidden>
          <span style={{ width: `${Math.round(o.confidence * 100)}%` }} />
        </span>
        <span className="mono">{Math.round(o.confidence * 100)}%</span>
      </div>
      <ul className="focus-lines">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </div>
  );
}

/** What Lumi is saying right now, with a typed way to talk back and the hub's sound switch. */
function LiveBar() {
  const { subtitle, transcript, sound, enableSound, setVoice, sessionId, health, now } = useLumi();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const speaking = subtitle && now - subtitle.key < 6000;
  const wake = health?.agent.wakePhrase ?? "Hi Lumi";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const said = text.trim();
    if (!said) return;
    setBusy(true);
    setError("");
    try {
      await api.say(sessionId, said);
      setText("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="livebar" aria-label="Live conversation">
      <div className="livebar-speech">
        <div className="livebar-who">
          <span className={`speaking-dot ${speaking ? "on" : ""}`} aria-hidden />
          Lumi
          {subtitle && subtitle.source !== "system" && <span className="livebar-source">{SOURCE_LABEL[subtitle.source] ?? subtitle.source}</span>}
        </div>
        <p className="livebar-text" key={subtitle?.key} aria-live="polite">
          {subtitle?.text ?? `Listening for “${wake}”.`}
        </p>
        {transcript && <p className="livebar-heard">You said “{transcript}”</p>}
      </div>
      <div className="livebar-side">
        <form className="composer" onSubmit={submit}>
          <label className="sr-only" htmlFor="ask">
            Ask or tell Lumi
          </label>
          <input id="ask" value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask or tell Lumi…" autoComplete="off" disabled={busy} />
          <button type="submit" className="primary icon-btn" aria-label="Send to Lumi" disabled={busy || !text.trim()}>
            <Icon name="send" />
          </button>
        </form>
        <div className="livebar-controls">
          {!sound.on ? (
            <button type="button" className="small" onClick={enableSound}>
              <Icon name="volume" /> Play Lumi on this laptop
            </button>
          ) : (
            <button type="button" className="small" aria-pressed={sound.voice} onClick={() => setVoice(!sound.voice)}>
              <Icon name={sound.voice ? "volume" : "mute"} /> {sound.voice ? "Laptop voice on" : "Laptop voice off"}
            </button>
          )}
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
