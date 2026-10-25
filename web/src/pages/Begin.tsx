import { useEffect, useState, type FormEvent } from "react";
import { api, type Preset } from "../lib/api.ts";
import { navigate } from "../lib/journey.ts";
import { useLumi } from "../lib/lumi.tsx";
import { LogoMark } from "../ui/Brand.tsx";
import { Icon } from "../ui/Icon.tsx";

const SUGGESTIONS = ["Help me tidy my desk", "Find my water bottle", "Describe what's around me"];

export function Begin() {
  const { camera, health, phoneOpen, streaming, snapshot, sessionId } = useLumi();
  const wake = health?.agent.wakePhrase ?? "Hi Lumi";
  const current = streaming ? 3 : phoneOpen ? 2 : 1;
  const step = (index: number) => (current > index ? "done" : current === index ? "current" : "waiting");
  const running = snapshot?.quest && (snapshot.status === "active" || snapshot.status === "paused" || snapshot.status === "planning");

  return (
    <div className="begin">
      <section className="begin-intro">
        <div className="page-kicker">Connect</div>
        <h1 tabIndex={-1}>Connect the phone.</h1>
        <p className="page-lede">
          A helper pairs the phone once. From then on, the person using Lumi only needs their voice. Starting a task here works too, for loud rooms or demos.
        </p>
        <div className="pairing-status" role="status">
          <i className={streaming ? "on" : phoneOpen ? "waiting" : ""} aria-hidden />
          <span>{streaming ? "Camera live. Lumi can see." : phoneOpen ? "Phone connected. Tap Start on the phone." : "Waiting for the phone"}</span>
        </div>
      </section>

      <section className="begin-grid">
        <div className="qr-card">
          <div className="qr-top">
            <span className={`live-pill ${camera ? "" : "offline"}`}>
              <i aria-hidden /> Lumi pairing code
            </span>
            <span>Scan with the phone camera</span>
          </div>
          <div className="qr-frame">
            {camera ? (
              <img src="/api/qr.svg" alt="QR code that opens the Lumi phone controller" />
            ) : (
              <div className="qr-placeholder">
                <LogoMark />
                <span>
                  Start the camera server with
                  <br />
                  <code>python run.py</code> to show the code
                </span>
              </div>
            )}
            <span className="corner tl" />
            <span className="corner tr" />
            <span className="corner bl" />
            <span className="corner br" />
          </div>
          {camera && <CopyLink url={camera.phone_url} />}
        </div>

        <div className="begin-side">
          <ol className="connect-steps">
            <ConnectStep index={1} state={step(1)} title="Open Lumi on the phone" text="Scan the code on the same Wi-Fi as this laptop, then accept the certificate warning once." />
            <ConnectStep index={2} state={step(2)} title="Tap Start" text="It allows the camera and microphone and keeps the screen awake. That's the only tap." />
            <ConnectStep index={3} state={step(3)} title="Start a task" text={`Say “${wake}, help me tidy my desk,” or type a task below.`} />
          </ol>
          {running ? (
            <div className="begin-running">
              <div>
                <span className="page-kicker">In progress</span>
                <strong>{snapshot!.quest!.title}</strong>
              </div>
              <button type="button" className="primary" onClick={() => navigate("live")}>
                Continue <Icon name="arrow" />
              </button>
            </div>
          ) : (
            <StartTask sessionId={sessionId} streaming={streaming} />
          )}
        </div>
      </section>

      <p className="begin-foot">Lumi supplements normal mobility techniques and is not an obstacle-avoidance system.</p>
    </div>
  );
}

function StartTask({ sessionId, streaming }: { sessionId: string; streaming: boolean }) {
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [presets, setPresets] = useState<Preset[]>([]);

  useEffect(() => {
    api.presets().then(setPresets).catch(() => setPresets([]));
  }, []);

  const run = async (task: { goal: string } | { presetId: string }) => {
    setBusy(true);
    setError("");
    try {
      if ("goal" in task) await api.say(sessionId, task.goal);
      else await api.startTask(sessionId, task);
      navigate("live");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (goal.trim()) void run({ goal: goal.trim() });
  };

  return (
    <div className="start-task">
      <form onSubmit={submit} className="start-form">
        <label htmlFor="goal">What should Lumi help with?</label>
        <div className="start-row">
          <input id="goal" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Help me tidy my desk" autoComplete="off" disabled={busy} />
          <button type="submit" className="primary" disabled={busy || !goal.trim()}>
            {busy ? "Starting…" : "Start"}
          </button>
        </div>
      </form>
      <div className="chips" aria-label="Suggestions">
        {SUGGESTIONS.map((s) => (
          <button type="button" key={s} className="chip" disabled={busy} onClick={() => void run({ goal: s })}>
            {s}
          </button>
        ))}
      </div>
      {presets.length > 0 && (
        <div className="chips" aria-label="Scripted demo tasks">
          <span className="chips-label">Scripted demo:</span>
          {presets.map((p) => (
            <button type="button" key={p.id} className="chip chip-quiet" disabled={busy} onClick={() => void run({ presetId: p.id })}>
              {p.title} · {p.steps} steps
            </button>
          ))}
        </div>
      )}
      {!streaming && <p className="hint">Lumi plans from what the camera sees, so tasks work best once the camera is live.</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    });
  };
  return (
    <div className="copy-link">
      <code>{url}</code>
      <button type="button" className="small" onClick={copy}>
        {copied ? "Copied" : "Copy link"}
      </button>
    </div>
  );
}

function ConnectStep({ index, state, title, text }: { index: number; state: "current" | "done" | "waiting"; title: string; text: string }) {
  return (
    <li className={`connect-step ${state}`} aria-current={state === "current" ? "step" : undefined}>
      <span aria-hidden>{state === "done" ? "✓" : index}</span>
      <div>
        <strong>
          {title}
          {state === "done" && <span className="sr-only"> (done)</span>}
        </strong>
        <p>{text}</p>
      </div>
    </li>
  );
}
