// Phone page: capture the camera with getUserMedia() and send it to the viewer
// over a direct WebRTC peer connection, falling back to JPEG frames relayed
// through the server whenever the direct link isn't connected.
import { RTC_CONFIG, Signaling, roomFromUrl, setStatus, wsUrl } from "./common.js";

const preview = document.getElementById("preview");
const statusEl = document.getElementById("status");
const startBtn = document.getElementById("start");
const flipBtn = document.getElementById("flip");
const resolutionSel = document.getElementById("resolution");

const room = roomFromUrl();
let stream = null;
let pc = null;
let facingMode = "environment";
let viewerPresent = false;
// ?mode=relay skips WebRTC entirely (for networks that block device-to-device traffic).
const relayOnly = new URLSearchParams(location.search).get("mode") === "relay";

const signaling = new Signaling(room, "sender", onSignal, (s) => {
  if (s === "closed") setStatus(statusEl, "Reconnecting to server…", "warn");
});

function constraints() {
  const [w, h] = resolutionSel.value.split("x").map(Number);
  return {
    audio: false,
    video: { facingMode: { ideal: facingMode }, width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 30, max: 30 } },
  };
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus(statusEl, "Camera API unavailable. Open this page over https:// (accept the certificate warning).", "error");
    return;
  }
  stream?.getTracks().forEach((t) => t.stop());
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints());
  } catch (err) {
    setStatus(statusEl, `Camera error: ${err.name} – ${err.message}`, "error");
    return;
  }
  preview.srcObject = stream;
  startBtn.textContent = "Restart camera";
  flipBtn.disabled = false;
  if (pc?.connectionState !== "connected") startRelay();

  const track = stream.getVideoTracks()[0];
  const sender = pc?.getSenders().find((s) => s.track?.kind === "video");
  if (sender && pc.connectionState === "connected") {
    await sender.replaceTrack(track); // swap camera without renegotiating
  } else if (viewerPresent) {
    await call();
  } else {
    setStatus(statusEl, "Camera on. Waiting for the laptop viewer to connect…", "warn");
  }
}

async function call() {
  if (!stream || relayOnly) return;
  pc?.close();
  const peer = (pc = new RTCPeerConnection(RTC_CONFIG));
  const transceiver = pc.addTransceiver(stream.getVideoTracks()[0], { direction: "sendonly", streams: [stream] });
  preferHardwareCodec(transceiver);

  pc.onicecandidate = (e) => e.candidate && signaling.send({ type: "candidate", candidate: e.candidate });
  pc.onconnectionstatechange = () => {
    if (peer !== pc) return;
    const s = peer.connectionState;
    if (s === "connected") {
      stopRelay();
      setStatus(statusEl, "Streaming to laptop ✓ (direct)", "ok");
      return;
    }
    if (s === "failed" || s === "disconnected" || s === "closed") startRelay();
    if (relayTimer) setStatus(statusEl, "Streaming to laptop ✓ (via server relay)", "ok");
    else setStatus(statusEl, `WebRTC: ${s}`, "warn");
  };

  // Keep motion smooth: if bandwidth or CPU gets tight, drop resolution, not frames.
  const params = transceiver.sender.getParameters();
  params.degradationPreference = "maintain-framerate";
  params.encodings = params.encodings?.length ? params.encodings : [{}];
  params.encodings[0].maxBitrate = 8_000_000; // plenty of headroom on a LAN / hotspot
  params.encodings[0].maxFramerate = 30;
  try { await transceiver.sender.setParameters(params); } catch { /* not supported everywhere */ }

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  signaling.send({ type: "offer", sdp: pc.localDescription });
  if (!relayTimer) setStatus(statusEl, "Connecting to laptop…", "warn");
}

// --------------------------------------------------------- relay fallback
const RELAY_FPS = 8;
const RELAY_MAX_SIDE = 640;
const relayCanvas = document.createElement("canvas");
let relayWs = null;
let relayTimer = null;

function openRelay() {
  relayWs = new WebSocket(wsUrl(`/ws/relay/${encodeURIComponent(room)}?role=sender`));
  relayWs.onclose = () => {
    relayWs = null;
    if (relayTimer) setTimeout(() => relayTimer && !relayWs && openRelay(), 1500);
  };
}

function startRelay() {
  if (relayTimer || !stream) return;
  if (!relayWs) openRelay();
  relayTimer = setInterval(sendRelayFrame, 1000 / RELAY_FPS);
  setStatus(statusEl, "Streaming to laptop ✓ (via server relay)", "ok");
}

function stopRelay() {
  clearInterval(relayTimer);
  relayTimer = null;
  relayWs?.close();
}

function sendRelayFrame() {
  // Skip frames while the socket is backed up so latency stays low on slow Wi-Fi.
  if (relayWs?.readyState !== WebSocket.OPEN || relayWs.bufferedAmount > 256_000 || !preview.videoWidth) return;
  const scale = Math.min(1, RELAY_MAX_SIDE / Math.max(preview.videoWidth, preview.videoHeight));
  relayCanvas.width = Math.round(preview.videoWidth * scale);
  relayCanvas.height = Math.round(preview.videoHeight * scale);
  relayCanvas.getContext("2d").drawImage(preview, 0, 0, relayCanvas.width, relayCanvas.height);
  relayCanvas.toBlob((blob) => {
    if (blob && relayWs?.readyState === WebSocket.OPEN) relayWs.send(blob);
  }, "image/jpeg", 0.7);
}

// Phones encode H.264 in hardware; VP8 (Chrome's default pick) is software-encoded
// on iPhones and stutters. Put H.264 first so both browsers negotiate it.
function preferHardwareCodec(transceiver) {
  const codecs = RTCRtpSender.getCapabilities?.("video")?.codecs;
  if (!codecs || !transceiver.setCodecPreferences) return;
  const h264 = codecs.filter((c) => c.mimeType.toLowerCase() === "video/h264");
  if (!h264.length) return;
  transceiver.setCodecPreferences([...h264, ...codecs.filter((c) => !h264.includes(c))]);
}

async function onSignal(msg) {
  switch (msg.type) {
    case "welcome":
      viewerPresent = msg.peers.includes("viewer");
      if (viewerPresent && stream) await call();
      else if (!stream) setStatus(statusEl, "Connected to server. Tap “Start camera”.", "idle");
      break;
    case "peer-joined":
      viewerPresent = true;
      if (stream) await call();
      break;
    case "peer-left":
      viewerPresent = false;
      pc?.close();
      pc = null;
      startRelay();
      setStatus(statusEl, "Laptop viewer disconnected. Waiting…", "warn");
      break;
    case "answer":
      // An answer to an offer we've since replaced would break the newer connection.
      if (pc?.signalingState === "have-local-offer") await pc.setRemoteDescription(msg.sdp);
      break;
    case "request-offer":
      // The viewer's connection failed or stalled; start a fresh negotiation.
      if (stream) await call();
      break;
    case "candidate":
      try { await pc?.addIceCandidate(msg.candidate); } catch (e) { console.warn("ICE candidate rejected", e); }
      break;
  }
}

startBtn.addEventListener("click", startCamera);
resolutionSel.addEventListener("change", () => stream && startCamera());
flipBtn.addEventListener("click", () => {
  facingMode = facingMode === "environment" ? "user" : "environment";
  preview.classList.toggle("mirrored", facingMode === "user");
  startCamera();
});
document.getElementById("room").textContent = room;
