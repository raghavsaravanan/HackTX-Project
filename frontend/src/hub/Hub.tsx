import { useEffect, useRef, useState } from "react";

import { api, type CameraInfo, type Health } from "../lib/api.ts";
import { sessionIdFromUrl } from "../lib/api.ts";
import { useSession } from "../lib/useSession.ts";
import { Stage } from "../stage/Stage.tsx";

const POLL_MS = 2000;
const FRESH_FRAME_MS = 4500;
const RETURN_TO_PAIRING_MS = 12000;

export function Hub() {
  const sessionId = sessionIdFromUrl();
  const session = useSession(sessionId, "stage");
  const [health, setHealth] = useState<Health | null>(null);
  const [camera, setCamera] = useState<CameraInfo | null>(null);
  const [live, setLive] = useState(false);
  const lastLiveAt = useRef(0);

  useEffect(() => {
    const poll = () => {
      api.health().then(setHealth).catch(() => setHealth(null));
      api.cameraInfo().then(setCamera).catch(() => setCamera(null));
    };
    poll();
    const timer = window.setInterval(poll, POLL_MS);
    return () => window.clearInterval(timer);
  }, []);

  const frameAge = health?.cameraLink?.lastFrameAgeMs;
  const streaming = frameAge !== null && frameAge !== undefined && frameAge < FRESH_FRAME_MS;
  const phoneConnected = session?.phoneConnected ?? false;
  const clientState = session?.clientState ?? "stopped";
  // Do not leave setup mode merely because SSE has connected. The phone can still be completing
  // permissions and trusted-people setup; the live dashboard begins only with a fresh camera frame.
  const connected = streaming;

  useEffect(() => {
    if (connected) {
      lastLiveAt.current = Date.now();
      setLive(true);
      return;
    }
    if (!live) return;
    const wait = Math.max(0, RETURN_TO_PAIRING_MS - (Date.now() - lastLiveAt.current));
    const timer = window.setTimeout(() => setLive(false), wait);
    return () => window.clearTimeout(timer);
  }, [connected, live]);

  if (!live) return <Pairing camera={camera} health={health} streaming={streaming} phoneConnected={phoneConnected} clientState={clientState} />;

  return <div className="lumi-live app-content-quest">
    <div className="lumi-topbar"><Brand /><span className={`lumi-connection ${streaming ? "on" : "waiting"}`}><i />{streaming ? "iPhone live" : "Reconnecting"}</span></div>
    <Stage health={health} />
  </div>;
}

function Pairing({ camera, health, streaming, phoneConnected, clientState }: { camera: CameraInfo | null; health: Health | null; streaming: boolean; phoneConnected: boolean; clientState: string }) {
  const phoneOpen = phoneConnected || (camera?.peers.includes("sender") ?? false);
  const current = streaming ? 4 : clientState === "people" ? 3 : clientState === "permissions" ? 2 : 1;
  const setupLabel = !phoneOpen
    ? "Waiting for your iPhone"
    : clientState === "people"
      ? "Phone connected—adding trusted people"
      : clientState === "permissions"
        ? "Phone connected—enabling permissions"
        : "Phone connected—finish setup in Lumi";
  return <main className="lumi-pairing">
    <header className="pairing-header"><Brand /><span className="pairing-safety">Private, local pairing</span></header>
    <section className="pairing-copy">
      <div className="page-kicker">Meet Lumi</div>
      <h1>Your hands-free<br />visual companion.</h1>
      <p>Lumi turns what your phone sees into short, trustworthy spoken directions. Pair once, then start every session with a conversation.</p>
      <div className="pairing-status"><i className={streaming ? "on" : phoneOpen ? "waiting" : ""} /><span>{streaming ? "Connected—opening the live session" : setupLabel}</span></div>
    </section>
    <section className="pairing-card">
      <div className="qr-card">
        <div className="qr-top"><span className="live-pill"><i /> The Lumi pairing code</span><span>Scan once with iPhone Camera</span></div>
        <div className="qr-frame">{camera ? <img src="/api/pairing/qr.svg" alt="The single QR code that opens Lumi in Expo Go and pairs this laptop" /> : <div className="qr-placeholder"><LogoMark /><span>Start the camera service<br />to reveal the Lumi code</span></div>}<span className="corner tl" /><span className="corner tr" /><span className="corner bl" /><span className="corner br" /></div>
        {camera && <code>{camera.gateway_url}</code>}
      </div>
      <div className="connect-steps">
        <ConnectStep index={1} state={current > 1 ? "done" : "current"} title="Get started in Lumi" text="Scan once with the iPhone Camera. Expo Go opens Lumi’s welcome page and pairs this laptop securely in the background." />
        <ConnectStep index={2} state={current > 2 ? "done" : current === 2 ? "current" : "waiting"} title="Allow access" text="Approve camera, microphone, and on-device speech recognition. No second QR is needed." />
        <ConnectStep index={3} state={current > 3 ? "done" : current === 3 ? "current" : "waiting"} title="Add trusted people" text="Add two people Lumi may offer to notify. Nothing is sent without the user’s confirmation." />
        <ConnectStep index={4} state={current === 4 ? "current" : "waiting"} title="Start talking" text={`The live view opens with the first camera frame. Lumi greets you automatically; say “${health?.agent.wakePhrase ?? "Hi Lumi"}” anytime.`} />
      </div>
    </section>
    <footer className="pairing-footer">Lumi supplements normal mobility techniques and is not an obstacle-avoidance system.</footer>
  </main>;
}

function ConnectStep({ index, state, title, text }: { index: number; state: "current" | "done" | "waiting"; title: string; text: string }) {
  return <div className={`connect-step ${state}`}><span>{state === "done" ? "✓" : index}</span><div><strong>{title}</strong><p>{text}</p></div></div>;
}

function Brand() {
  return <div className="lumi-brand"><LogoMark /><span>Lumi</span></div>;
}

function LogoMark() {
  return <svg className="logo-mark" viewBox="0 0 32 32" aria-hidden><path d="M6.8 20.2c0-7.4 4.8-13.1 11.6-13.1 4.3 0 7.5 2.1 7.5 5.6 0 3.1-2.3 5.1-5.9 5.1h-2.5c-2.2 0-3.4 1.1-3.4 2.9 0 2 1.6 3.4 4 3.4 2.8 0 5.1-1.3 7-3.8-.7 6-4.5 9.2-10 9.2-5 0-8.3-3.6-8.3-9.3Z" fill="currentColor"/><path d="M5.4 7.7c2.3.6 4 2.3 4.6 4.6.6-2.3 2.3-4 4.6-4.6-2.3-.6-4-2.3-4.6-4.6-.6 2.3-2.3 4-4.6 4.6Z" fill="currentColor"/></svg>;
}
