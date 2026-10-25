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
      <nav className="hub-bar" role="tablist">
        <span className="brand-mark">SIDEQUEST</span>
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={`hub-tab ${tab === t.id ? "hub-tab-on" : ""}`} onClick={() => choose(t.id)}>
            {t.label}
          </button>
        ))}
        <span className={`hub-dot ${streaming ? "hub-dot-on" : phoneOpen ? "hub-dot-wait" : ""}`}>
          {streaming ? "Phone camera live" : phoneOpen ? "Phone open, camera off" : "No phone yet"}
        </span>
      </nav>
      <div className="hub-panel">
        {tab === "connect" && <Connect camera={camera} health={health} phoneOpen={phoneOpen} streaming={streaming} />}
        {tab === "quest" && <Stage health={health} />}
        {tab === "camera" && <iframe className="hub-frame" src="/viewer" title="Live phone camera" allow="fullscreen" />}
        {tab === "apis" && <Apis health={health} />}
      </div>
    </div>
  );
}

function Connect({ camera, health, phoneOpen, streaming }: { camera: CameraInfo | null; health: Health | null; phoneOpen: boolean; streaming: boolean }) {
  const wake = health?.agent.wakePhrase ?? "Hi Echo";
  return (
    <section className="connect">
      <div className="connect-qr">
        {camera ? <img src="/api/qr.svg" alt="QR code that opens the phone controller" /> : <p className="muted">Camera server not running. Start it with `python run.py`.</p>}
        {camera && <code>{camera.phone_url}</code>}
      </div>
      <div className="connect-steps">
        <h1>Pair your phone</h1>
        <ol>
          <li className={phoneOpen ? "done" : ""}>Scan the code with the phone camera. Same Wi-Fi as this laptop. Accept the certificate warning once.</li>
          <li className={streaming ? "done" : ""}>Tap Start on the phone and allow the camera and microphone.</li>
          <li>
            Say “{wake}, help me tidy my desk.” {health?.agent.name ?? "Echo"} plans a quest from what the camera sees and talks you through it.
          </li>
          <li>
            Ask anything after “{wake}”, such as “is the room clean?”, or say “I'm done” after a step. Follow-ups within a few seconds need no wake phrase.
          </li>
        </ol>
        <p className="muted">This tab switches to the quest once the phone camera is live.</p>
      </div>
    </section>
  );
}

function Apis({ health }: { health: Health | null }) {
  const rows: { job: string; service: string; model: string; where: string }[] = [
    { job: "Hear", service: "Meta Muse Voice Transcribe", model: health?.transcribe ?? "…", where: "Phone mic → camera server /api/game/voice → game API /api/voice/listen" },
    { job: "Wake", service: "Wake phrase match (no API)", model: health?.agent.wakePhrase ?? "Hi Echo", where: "Game API, server/wake.ts, on each transcript" },
    { job: "Plan, guide, answer", service: "Gemini Quest Agent", model: health?.quest ?? "…", where: "server/questAgent.ts" },
    { job: "See, verify", service: "Gemini Vision Agent", model: health?.vision ?? "…", where: "server/vision.ts, on 1 frame per second from the phone" },
    { job: "Fallback brain", service: "Meta Muse Spark", model: health?.muse ?? "…", where: "Used when Gemini is rate-limited or down" },
    { job: "Speak", service: "Phone speech synthesis (no API)", model: "on-device", where: "static/js/voice.js; the Quest tab can also speak" },
    { job: "Video", service: "WebRTC, server relay fallback (no API)", model: "LAN only", where: "Camera server signaling, Live camera tab" },
  ];
  const link = health?.cameraLink;
  return (
    <section className="apis">
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
              <td>{r.job}</td>
              <td>{r.service}</td>
              <td className="mono">{r.model}</td>
              <td className="muted">{r.where}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">
        Camera link: {link ? (link.reachable ? `reachable, newest frame ${link.lastFrameAgeMs === null ? "none yet" : `${Math.round(link.lastFrameAgeMs / 100) / 10}s old`}` : "camera server unreachable") : "off"}
        {" · "}Step verification: {health?.verifySteps ? "on" : "off"}
        {" · "}API keys stay in .env on this laptop; the phone never sees them.
      </p>
    </section>
  );
}
