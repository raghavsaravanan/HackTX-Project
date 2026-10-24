// Laptop page: receive the phone's WebRTC stream, display it, and push sampled
// frames to the backend where they're prepared for a vision Llama model.
import { RTC_CONFIG, Signaling, roomFromUrl, setStatus, wsUrl } from "./common.js";

const video = document.getElementById("remote");
const relayCanvas = document.getElementById("relay");
const placeholder = document.getElementById("placeholder");
const statusEl = document.getElementById("status");
const statsEl = document.getElementById("stats");
const captureToggle = document.getElementById("capture");
const fpsInput = document.getElementById("fps");
const fpsLabel = document.getElementById("fps-label");
const frameInfo = document.getElementById("frame-info");
const lastFrame = document.getElementById("last-frame");
const askForm = document.getElementById("ask");
const answerEl = document.getElementById("answer");

const room = roomFromUrl();
let pc = null;

// ------------------------------------------------------------ setup info
document.getElementById("qr").src = `/api/qr.svg?room=${encodeURIComponent(room)}`;
fetch(`/api/info?room=${encodeURIComponent(room)}`)
  .then((r) => r.json())
  .then((info) => {
    const a = document.getElementById("phone-url");
    a.href = a.textContent = info.phone_url;
    document.getElementById("model").textContent = `${info.llama.model} @ ${info.llama.base_url}`;
  });

// -------------------------------------------------------------- WebRTC
const signaling = new Signaling(room, "viewer", onSignal, (s) => {
  if (s === "closed") setStatus(statusEl, "Reconnecting to server…", "warn");
});

async function onSignal(msg) {
  switch (msg.type) {
    case "welcome":
      setStatus(statusEl, msg.peers.includes("sender") ? "Phone connected, waiting for video…" : "Waiting for the phone…", "warn");
      break;
    case "peer-joined":
      setStatus(statusEl, "Phone joined, negotiating…", "warn");
      break;
    case "peer-left":
      closePeer();
      setStatus(statusEl, "Phone disconnected. Waiting…", "warn");
      break;
    case "offer":
      await answer(msg.sdp);
      break;
    case "candidate":
      try { await pc?.addIceCandidate(msg.candidate); } catch (e) { console.warn("ICE candidate rejected", e); }
      break;
  }
}

// Without this, a connection that fails or never completes stays dead until a page reload.
const CONNECT_TIMEOUT_MS = 10_000;
const DISCONNECT_GRACE_MS = 4_000;
let retryTimer = null;

function scheduleRetry(ms, reason) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    if (pc?.connectionState === "connected") return;
    if (relayCanvas.hidden) setStatus(statusEl, `${reason} – asking the phone to reconnect…`, "warn");
    signaling.send({ type: "request-offer" });
    scheduleRetry(CONNECT_TIMEOUT_MS, "Still not connected");
  }, ms);
}

async function answer(offer) {
  closePeer();
  const peer = (pc = new RTCPeerConnection(RTC_CONFIG));
  peer.onicecandidate = (e) => e.candidate && signaling.send({ type: "candidate", candidate: e.candidate });
  peer.ontrack = (e) => {
    video.srcObject = e.streams[0] ?? new MediaStream([e.track]);
  };
  peer.onconnectionstatechange = () => {
    if (peer !== pc) return;
    const s = peer.connectionState;
    if (s === "connected") {
      clearTimeout(retryTimer);
      showSource("direct");
      setStatus(statusEl, "Live from phone ✓ (direct)", "ok");
      return;
    }
    if (s === "failed") scheduleRetry(1_000, "Connection failed");
    else if (s === "disconnected") scheduleRetry(DISCONNECT_GRACE_MS, "Connection dropped");

    if (!relayCanvas.hidden) setStatus(statusEl, "Live from phone ✓ (via server relay)", "ok");
    else if (s === "failed") setStatus(statusEl, "Direct link failed – waiting for relay frames…", "warn");
    else setStatus(statusEl, `WebRTC: ${s}`, "warn");
  };
  scheduleRetry(CONNECT_TIMEOUT_MS, "Connection timed out");
  await peer.setRemoteDescription(offer);
  await peer.setLocalDescription(await peer.createAnswer());
  signaling.send({ type: "answer", sdp: peer.localDescription });
}

function closePeer() {
  clearTimeout(retryTimer);
  pc?.close();
  pc = null;
  video.srcObject = null;
  showSource(relayFresh() ? "relay" : "none");
}

// ------------------------------------------------------ relay fallback
// When the direct WebRTC link can't connect, the phone sends JPEG frames through
// the server instead; they're drawn here until the direct video takes over.
const relayCtx = relayCanvas.getContext("2d");
const RELAY_STALE_MS = 3000;
let lastRelayAt = 0;
let relayFrames = 0;

const directLive = () => pc?.connectionState === "connected" && video.videoWidth > 0;
const relayFresh = () => Date.now() - lastRelayAt < RELAY_STALE_MS;

function showSource(source) {
  video.hidden = source === "relay";
  relayCanvas.hidden = source !== "relay";
  placeholder.hidden = source !== "none";
}

function openRelay() {
  const ws = new WebSocket(wsUrl(`/ws/relay/${encodeURIComponent(room)}?role=viewer`));
  ws.binaryType = "blob";
  ws.onmessage = async (e) => {
    if (directLive()) return;
    const bitmap = await createImageBitmap(e.data);
    relayCanvas.width = bitmap.width;
    relayCanvas.height = bitmap.height;
    relayCtx.drawImage(bitmap, 0, 0);
    bitmap.close();
    lastRelayAt = Date.now();
    relayFrames++;
    if (relayCanvas.hidden) {
      showSource("relay");
      setStatus(statusEl, "Live from phone ✓ (via server relay)", "ok");
    }
  };
  ws.onclose = () => setTimeout(openRelay, 1500);
}
openRelay();

setInterval(() => {
  if (relayCanvas.hidden) return;
  if (directLive()) {
    showSource("direct");
    setStatus(statusEl, "Live from phone ✓ (direct)", "ok");
  } else if (!relayFresh()) {
    showSource("none");
    setStatus(statusEl, "Phone stopped sending video. Waiting…", "warn");
  }
}, 1000);

// Receive stats: resolution, fps, bitrate.
let lastBytes = 0, lastTs = 0;
setInterval(async () => {
  if (!relayCanvas.hidden) {
    statsEl.textContent = `${relayCanvas.width}×${relayCanvas.height} · ${relayFrames} fps · server relay`;
    relayFrames = 0;
    return;
  }
  relayFrames = 0;
  if (!pc) { statsEl.textContent = ""; return; }
  const report = await pc.getStats();
  report.forEach((s) => {
    if (s.type !== "inbound-rtp" || s.kind !== "video") return;
    const kbps = lastTs ? ((s.bytesReceived - lastBytes) * 8) / (s.timestamp - lastTs) : 0;
    lastBytes = s.bytesReceived; lastTs = s.timestamp;
    const codec = report.get(s.codecId)?.mimeType?.replace("video/", "") ?? "";
    statsEl.textContent = `${s.frameWidth ?? "?"}×${s.frameHeight ?? "?"} · ${Math.round(s.framesPerSecond ?? 0)} fps · ${Math.round(kbps)} kbps · ${codec}`;
  });
}, 1000);

// ------------------------------------------------------ frame capture
// Snapshots of the <video> element are JPEG-encoded and sent as binary
// WebSocket messages; the server normalises them for the Llama model.
const MAX_CAPTURE_SIDE = 1120; // matches the server's FRAME_MAX_SIDE default
const canvas = document.createElement("canvas");
const ctx = canvas.getContext("2d");
let frameWs = null;
let captureTimer = null;
let inFlight = false;
let sentCount = 0;

function openFrameSocket() {
  frameWs = new WebSocket(wsUrl("/ws/frames"));
  frameWs.binaryType = "arraybuffer";
  frameWs.onmessage = (e) => {
    inFlight = false;
    const msg = JSON.parse(e.data);
    if (msg.type === "frame") {
      sentCount++;
      frameInfo.textContent = `#${msg.frame_id} · ${msg.width}×${msg.height} (from ${msg.source_width}×${msg.source_height}) · ${(msg.bytes / 1024).toFixed(0)} KB · ${sentCount} sent`;
      lastFrame.src = `/api/frames/${msg.frame_id}.jpg`;
    } else {
      frameInfo.textContent = `Frame error: ${msg.detail}`;
    }
  };
  frameWs.onclose = () => { inFlight = false; if (captureToggle.checked) setTimeout(openFrameSocket, 1000); };
}

function grabFrame() {
  const useRelay = !relayCanvas.hidden;
  const [w, h] = useRelay ? [relayCanvas.width, relayCanvas.height] : [video.videoWidth, video.videoHeight];
  // Skip if no video yet, or the previous frame hasn't been acknowledged (back-pressure).
  if (inFlight || !w || frameWs?.readyState !== WebSocket.OPEN) return;
  // Downscale here (the server would anyway) so encoding stays cheap and never
  // steals time from video playback.
  const scale = Math.min(1, MAX_CAPTURE_SIDE / Math.max(w, h));
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  ctx.drawImage(useRelay ? relayCanvas : video, 0, 0, canvas.width, canvas.height);
  inFlight = true;
  canvas.toBlob(async (blob) => {
    if (blob && frameWs.readyState === WebSocket.OPEN) frameWs.send(await blob.arrayBuffer());
    else inFlight = false;
  }, "image/jpeg", 0.92);
}

function restartCapture() {
  clearInterval(captureTimer);
  captureTimer = null;
  if (!captureToggle.checked) { frameWs?.close(); frameWs = null; return; }
  if (!frameWs || frameWs.readyState > WebSocket.OPEN) openFrameSocket();
  captureTimer = setInterval(grabFrame, 1000 / Number(fpsInput.value));
}

captureToggle.addEventListener("change", restartCapture);
fpsInput.addEventListener("input", () => {
  fpsLabel.textContent = fpsInput.value;
  if (captureToggle.checked) restartCapture();
});
fpsLabel.textContent = fpsInput.value;

// ---------------------------------------------------------- fullscreen
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else video.parentElement.requestFullscreen?.();
}
video.addEventListener("dblclick", toggleFullscreen);
document.getElementById("fullscreen").addEventListener("click", toggleFullscreen);

// ---------------------------------------------------------- Ask Llama
askForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = askForm.querySelector("button");
  button.disabled = true;
  answerEl.textContent = "Thinking…";
  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: askForm.prompt.value, num_frames: Number(askForm.frames.value) }),
    });
    const body = await res.json();
    answerEl.textContent = res.ok ? body.answer : `Error: ${body.detail}`;
  } catch (err) {
    answerEl.textContent = `Error: ${err.message}`;
  } finally {
    button.disabled = false;
  }
});
