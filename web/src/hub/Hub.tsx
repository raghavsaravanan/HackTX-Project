import { useEffect, useRef, useState } from "react";
import { Stage } from "../stage/Stage.tsx";
import { api, type CameraInfo, type Health } from "../lib/api.ts";

type Tab = "connect" | "quest" | "camera" | "apis";

const TABS: { id: Tab; label: string }[] = [
  { id: "connect", label: "Connect phone" },
  { id: "quest", label: "Quest" },
  { id: "camera", label: "Live camera" },
  { id: "apis", label: "APIs" },
];

const POLL_MS = 3000;
const FRESH_FRAME_MS = 4000;

const tabFromHash = (): Tab | null => {
  const id = location.hash.slice(1);
  return TABS.some((t) => t.id === id) ? (id as Tab) : null;
};

/** The single laptop page: pair the phone, watch the quest, see the live camera, check the APIs. */
export function Hub() {
  const [tab, setTab] = useState<Tab>(() => tabFromHash() ?? (location.pathname.startsWith("/stage") ? "quest" : "connect"));
  const [health, setHealth] = useState<Health | null>(null);
  const [camera, setCamera] = useState<CameraInfo | null>(null);
  const picked = useRef(tabFromHash() !== null);

  useEffect(() => {
    const poll = () => {
      api.health().then(setHealth).catch(() => setHealth(null));
      api.cameraInfo().then(setCamera).catch(() => setCamera(null));
    };
    poll();
    const timer = window.setInterval(poll, POLL_MS);
    const onHash = () => {
      const next = tabFromHash();
      if (next) setTab(next);
    };
    window.addEventListener("hashchange", onHash);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("hashchange", onHash);
    };
  }, []);

  const age = health?.cameraLink?.lastFrameAgeMs;
  const streaming = age !== null && age !== undefined && age < FRESH_FRAME_MS;
  const phoneOpen = camera?.peers.includes("sender") ?? false;

  // Once the phone is streaming, move from pairing to the quest unless a tab was chosen by hand.
  useEffect(() => {
    if (streaming && tab === "connect" && !picked.current) setTab("quest");
  }, [streaming, tab]);

  const choose = (id: Tab) => {
    picked.current = true;
    history.replaceState(null, "", `#${id}`);
    setTab(id);
  };

  return (
    <div className="hub">
      <header className="lumi-topbar">
        <Brand />
        <nav className="hub-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={`hub-tab ${tab === t.id ? "hub-tab-on" : ""}`} onClick={() => choose(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <span className={`lumi-connection ${streaming ? "on" : phoneOpen ? "waiting" : ""}`}>
          <i />
          {streaming ? "Phone camera live" : phoneOpen ? "Phone open, camera off" : "No phone yet"}
        </span>
      </header>
      <div className="hub-panel">
        {tab === "connect" && <Pairing camera={camera} health={health} phoneOpen={phoneOpen} streaming={streaming} />}
        {tab === "quest" && <Stage health={health} />}
        {tab === "camera" && (
          <div className="hub-camera">
            <iframe className="hub-frame" src="/viewer" title="Live phone camera" allow="fullscreen" />
          </div>
        )}
        {tab === "apis" && <Apis health={health} />}
      </div>
    </div>
  );
}

function Pairing({ camera, health, phoneOpen, streaming }: { camera: CameraInfo | null; health: Health | null; phoneOpen: boolean; streaming: boolean }) {
  const wake = health?.agent.wakePhrase ?? "Hi Lumi";
  const current = streaming ? 3 : phoneOpen ? 2 : 1;
  const step = (index: number) => (current > index ? "done" : current === index ? "current" : "waiting");
  return (
    <main className="lumi-pairing">
      <section className="pairing-copy">
        <div className="page-kicker">Meet {health?.agent.name ?? "Lumi"}</div>
        <h1>
          Your <span className="nowrap">hands-free</span>
          <br />
          visual companion.
        </h1>
        <p>Lumi turns what your phone sees into short, trustworthy spoken directions. Pair once, then start every session with a conversation.</p>
        <div className="pairing-status">
          <i className={streaming ? "on" : phoneOpen ? "waiting" : ""} />
          <span>{streaming ? "Connected. Opening the live session…" : phoneOpen ? "Phone connected. Tap Start on the phone." : "Waiting for your phone"}</span>
        </div>
      </section>
      <section className="pairing-card">
        <div className="qr-card">
          <div className="qr-top">
            <span className={`live-pill ${camera ? "" : "offline"}`}>
              <i /> The Lumi pairing code
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
                  <code>python run.py</code> to reveal the code
                </span>
              </div>
            )}
            <span className="corner tl" />
            <span className="corner tr" />
            <span className="corner bl" />
            <span className="corner br" />
          </div>
          {camera && <code>{camera.phone_url}</code>}
        </div>
        <div className="connect-steps">
          <ConnectStep index={1} state={step(1)} title="Open Lumi on your phone" text="Scan the code on the same Wi-Fi as this laptop and accept the certificate warning once." />
          <ConnectStep index={2} state={step(2)} title="Tap Start" text="Allow the camera and microphone. The screen stays awake while Lumi guides you." />
          <ConnectStep index={3} state={step(3)} title="Start talking" text={`Say “${wake}, help me tidy my desk.” Lumi plans from what the camera sees and talks you through it.`} />
          <ConnectStep index={4} state="waiting" title="Ask anything" text={`Ask “${wake}, is the room clean?” or say “I'm done” after a step. Follow-ups right after a reply need no wake phrase.`} />
        </div>
      </section>
      <footer className="pairing-footer">Lumi supplements normal mobility techniques and is not an obstacle-avoidance system. This tab switches to the quest once the phone camera is live.</footer>
    </main>
  );
}

function ConnectStep({ index, state, title, text }: { index: number; state: "current" | "done" | "waiting"; title: string; text: string }) {
  return (
    <div className={`connect-step ${state}`}>
      <span>{state === "done" ? "✓" : index}</span>
      <div>
        <strong>{title}</strong>
        <p>{text}</p>
      </div>
    </div>
  );
}

function Apis({ health }: { health: Health | null }) {
  const rows: { job: string; service: string; model: string; where: string }[] = [
    { job: "Hear", service: "Meta Muse Voice Transcribe", model: health?.transcribe ?? "…", where: "Phone mic → camera server /api/game/voice → game API /api/voice/listen" },
    { job: "Wake", service: "Wake phrase match (no API)", model: health?.agent.wakePhrase ?? "Hi Lumi", where: "Game API, server/wake.ts, on each transcript" },
    { job: "Plan, guide, answer", service: "Gemini Quest Agent", model: health?.quest ?? "…", where: "server/questAgent.ts" },
    { job: "See, verify", service: "Gemini Vision Agent", model: health?.vision ?? "…", where: "server/vision.ts, on 1 frame per second from the phone" },
    { job: "Fallback brain", service: "Meta Muse Spark", model: health?.muse ?? "…", where: "Used when Gemini is rate-limited or down" },
    {
      job: "Speak",
      service: health?.speak && !/on-device/i.test(health.speak) ? "ElevenLabs TTS" : "Browser speech (fallback)",
      model: health?.speak ?? "on-device",
      where: "Game API /api/tts/:id → phone /api/game/tts/:id; Quest tab uses the same proxy",
    },
    { job: "Video", service: "WebRTC, server relay fallback (no API)", model: "LAN only", where: "Camera server signaling, Live camera tab" },
  ];
  const link = health?.cameraLink;
  return (
    <section className="apis">
      <div className="page-kicker">Under the hood</div>
      <h1>The services behind Lumi</h1>
      <p className="page-lede">Which service does each job, and the model it is using right now.</p>
      <div className="apis-card">
        <table>
          <thead>
            <tr>
              <th>Job</th>
              <th>Service</th>
              <th>Model in use</th>
              <th>Where</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.job}>
                <td className="apis-job">{r.job}</td>
                <td>{r.service}</td>
                <td className="mono">{r.model}</td>
                <td className="muted">{r.where}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted apis-foot">
        Camera link: {link ? (link.reachable ? `reachable, newest frame ${link.lastFrameAgeMs === null ? "none yet" : `${Math.round(link.lastFrameAgeMs / 100) / 10}s old`}` : "camera server unreachable") : "off"}
        {" · "}Step verification: {health?.verifySteps ? "on" : "off"}
        {" · "}API keys stay in .env on this laptop; the phone never sees them.
      </p>
    </section>
  );
}

function Brand() {
  return (
    <div className="lumi-brand">
      <LogoMark />
      <span>Lumi</span>
    </div>
  );
}

function LogoMark() {
  return (
    <svg className="logo-mark" viewBox="0 0 32 32" aria-hidden>
      <path d="M6.8 20.2c0-7.4 4.8-13.1 11.6-13.1 4.3 0 7.5 2.1 7.5 5.6 0 3.1-2.3 5.1-5.9 5.1h-2.5c-2.2 0-3.4 1.1-3.4 2.9 0 2 1.6 3.4 4 3.4 2.8 0 5.1-1.3 7-3.8-.7 6-4.5 9.2-10 9.2-5 0-8.3-3.6-8.3-9.3Z" fill="currentColor" />
      <path d="M5.4 7.7c2.3.6 4 2.3 4.6 4.6.6-2.3 2.3-4 4.6-4.6-2.3-.6-4-2.3-4.6-4.6-.6 2.3-2.3 4-4.6 4.6Z" fill="currentColor" />
    </svg>
  );
}
