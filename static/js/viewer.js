// Laptop page (the hub's Live camera tab): receive the phone's WebRTC stream and display it,
// falling back to JPEG frames relayed through the server.
import { RTC_CONFIG, Signaling, roomFromUrl, setStatus, wsUrl } from "./common.js";

const video = document.getElementById("remote");
const relayCanvas = document.getElementById("relay");
const placeholder = document.getElementById("placeholder");
const statusEl = document.getElementById("status");
const statsEl = document.getElementById("stats");

const room = roomFromUrl();
let pc = null;

// ------------------------------------------------------------ setup info
document.getElementById("qr").src = `/api/qr.svg?room=${encodeURIComponent(room)}`;
fetch(`/api/info?room=${encodeURIComponent(room)}`)
  .then((r) => r.json())
  .then((info) => {
    const a = document.getElementById("phone-url");
    a.href = a.textContent = info.phone_url;
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

// ---------------------------------------------------------- fullscreen
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else video.parentElement.requestFullscreen?.();
}
video.addEventListener("dblclick", toggleFullscreen);
document.getElementById("fullscreen").addEventListener("click", toggleFullscreen);
