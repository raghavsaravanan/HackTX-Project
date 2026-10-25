import { useEffect, useRef, type MouseEvent } from "react";
import type { SessionStatus } from "../../shared/types.ts";
import { JOURNEY, navigate, useStage, type StageId } from "./lib/journey.ts";
import { formatDuration, LumiProvider, useLumi } from "./lib/lumi.tsx";
import { Begin } from "./pages/Begin.tsx";
import { Discover } from "./pages/Discover.tsx";
import { Live } from "./session/Live.tsx";
import { Brand } from "./ui/Brand.tsx";
import { Icon } from "./ui/Icon.tsx";

export function App() {
  return (
    <LumiProvider>
      <Shell />
    </LumiProvider>
  );
}

function Shell() {
  const stage = useStage();
  const { snapshot } = useLumi();
  const status = snapshot?.status ?? "idle";
  const prevStatus = useRef<SessionStatus | null>(null);
  const firstRender = useRef(true);

  // Starting a task from Connect (by voice on the phone, or typed here) opens the live dashboard.
  useEffect(() => {
    const prev = prevStatus.current;
    prevStatus.current = status;
    if (prev === null || prev === status) return;
    if (stage === "begin" && (status === "planning" || status === "active")) navigate("live");
  }, [status, stage]);

  // Move focus to the new page's heading so screen readers announce where they are.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    document.querySelector<HTMLElement>("main h1")?.focus({ preventScroll: true });
  }, [stage]);

  const skipToContent = (e: MouseEvent) => {
    e.preventDefault();
    document.getElementById("main")?.focus();
  };

  return (
    <div className={`app app-${stage}`}>
      <a className="skip-link" href="#" onClick={skipToContent}>
        Skip to content
      </a>
      <TopBar stage={stage} />
      <main id="main" tabIndex={-1}>
        {stage === "discover" && <Discover />}
        {stage === "begin" && <Begin />}
        {stage === "live" && <Live />}
      </main>
      <ProgressNotes />
      <QuestDoneDialog />
    </div>
  );
}

function TopBar({ stage }: { stage: StageId }) {
  return (
    <header className="topbar">
      <Brand onClick={() => navigate("discover")} />
      <nav className="tabs" aria-label="Lumi">
        {JOURNEY.map((s) => (
          <button key={s.id} type="button" className={`tab ${stage === s.id ? "tab-on" : ""}`} aria-current={stage === s.id ? "page" : undefined} onClick={() => navigate(s.id)}>
            {s.label}
          </button>
        ))}
      </nav>
      <div className="topbar-end">
        <ConnectionPill />
      </div>
    </header>
  );
}

function ConnectionPill() {
  const { streaming, phoneOpen } = useLumi();
  const state = streaming ? "on" : phoneOpen ? "waiting" : "off";
  return (
    <span className={`connection connection-${state}`} role="status">
      <i aria-hidden />
      {streaming ? "Camera live" : phoneOpen ? "Phone open" : "No phone yet"}
    </span>
  );
}

function ProgressNotes() {
  const { notes } = useLumi();
  return (
    <div className="notes" role="status" aria-live="polite">
      {notes.map((n) => (
        <div key={n.id} className={`note ${n.quest ? "note-quest" : ""}`}>
          <span className="note-icon">
            <Icon name="check" />
          </span>
          <div>
            <strong>{n.quest ? "Task complete" : "Step confirmed"}</strong>
            <span>{n.label}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function QuestDoneDialog() {
  const { questDone, dismissQuestDone, snapshot } = useLumi();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!questDone) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && dismissQuestDone();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [questDone, dismissQuestDone]);

  if (!questDone) return null;
  const goal = snapshot?.map.goalCheck;
  return (
    <div className="dialog-backdrop" onClick={dismissQuestDone}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="done-title" onClick={(e) => e.stopPropagation()}>
        <div className="page-kicker">Task complete</div>
        <h2 id="done-title">{questDone.title}</h2>
        <p className="dialog-recap">{questDone.recap}</p>
        <dl className="dialog-facts">
          <div>
            <dt>Time</dt>
            <dd>{formatDuration(questDone.durationMs)}</dd>
          </div>
          <div>
            <dt>Steps confirmed</dt>
            <dd>
              {questDone.stepsDone} of {questDone.stepsTotal}
            </dd>
          </div>
          <div>
            <dt>Final check</dt>
            <dd>{goal ? goal.verdict : "Pending"}</dd>
          </div>
        </dl>
        <div className="dialog-actions">
          <button type="button" className="primary" ref={closeRef} onClick={dismissQuestDone}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
