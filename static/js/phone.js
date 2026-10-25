// Phone controller: capture the camera and send one frame a second to the camera server for
// the agents. The signaling socket tells the laptop hub this phone is open.
import { Signaling, roomFromUrl, setStatus, wsUrl } from "./common.js";
import { initGameVoice } from "./voice.js";

const preview = document.getElementById("preview");
const statusEl = document.getElementById("status");
const startBtn = document.getElementById("start");
const flipBtn = document.getElementById("flip");
const resolutionSel = document.getElementById("resolution");

const room = roomFromUrl();
let stream = null;
let facingMode = "environment";
const CAMERA_ON = "Camera on. The laptop is receiving frames.";

new Signaling(room, "sender", onSignal, (s) => {
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
  startAnalysis();
  setStatus(statusEl, CAMERA_ON, "ok");
}

// ------------------------------------------------- frames for the Vision Agent
// One modest JPEG a second, straight into the camera server's frame buffer, so the
// agents see the phone without anyone ticking a box on the laptop.
const ANALYSIS_MS = 1000;
const analysisCanvas = document.createElement("canvas");
let analysisWs = null;
let analysisTimer = null;

function openAnalysis() {
  analysisWs = new WebSocket(wsUrl("/ws/frames"));
  analysisWs.onmessage = () => {};
  analysisWs.onclose = () => {
    analysisWs = null;
    if (analysisTimer) setTimeout(() => analysisTimer && !analysisWs && openAnalysis(), 1500);
  };
}

function startAnalysis() {
  if (analysisTimer) return;
  openAnalysis();
  analysisTimer = setInterval(() => {
    if (analysisWs?.readyState !== WebSocket.OPEN || analysisWs.bufferedAmount > 256_000 || !preview.videoWidth) return;
    const scale = Math.min(1, 640 / Math.max(preview.videoWidth, preview.videoHeight));
    analysisCanvas.width = Math.round(preview.videoWidth * scale);
    analysisCanvas.height = Math.round(preview.videoHeight * scale);
    analysisCanvas.getContext("2d").drawImage(preview, 0, 0, analysisCanvas.width, analysisCanvas.height);
    analysisCanvas.toBlob((blob) => {
      if (blob && analysisWs?.readyState === WebSocket.OPEN) blob.arrayBuffer().then((buf) => analysisWs?.send(buf));
    }, "image/jpeg", 0.6);
  }, ANALYSIS_MS);
}

function onSignal(msg) {
  if (msg.type === "welcome") setStatus(statusEl, stream ? CAMERA_ON : "Connected to the laptop. Tap Start.", stream ? "ok" : "idle");
}

resolutionSel.addEventListener("change", () => stream && startCamera());
flipBtn.addEventListener("click", () => {
  facingMode = facingMode === "environment" ? "user" : "environment";
  preview.classList.toggle("mirrored", facingMode === "user");
  startCamera();
});
document.getElementById("room").textContent = room;

const voice = initGameVoice(
  {
    speakToggle: document.getElementById("speak"),
    listenToggle: document.getElementById("listen"),
    said: document.getElementById("said"),
    line: document.getElementById("line"),
    state: document.getElementById("voice-state"),
    questTitle: document.getElementById("quest-title"),
    instruction: document.getElementById("instruction"),
    steps: document.getElementById("steps"),
    verdict: document.getElementById("verdict"),
    typedForm: document.getElementById("typed"),
    typedInput: document.getElementById("typed-text"),
  },
  new URLSearchParams(location.search).get("session"),
);

// The screen turning off stops the camera and microphone, so hold a wake lock while running.
let wakeLock = null;
async function keepScreenOn() {
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
  } catch { /* unsupported or denied; the hint asks to keep the screen on */ }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && stream && wakeLock?.released !== false) keepScreenOn();
});

// One tap: sound unlocked, camera on, microphone listening for the wake phrase.
startBtn.addEventListener("click", async () => {
  voice.unlock();
  await startCamera();
  await voice.listen();
  keepScreenOn();
});
