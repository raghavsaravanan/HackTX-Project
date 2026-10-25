// Reads frames from the Python phone camera link (app/, static/). Its laptop viewer pushes
// snapshots of the WebRTC stream to /ws/frames when "Send frames to server" is ticked.
import { config } from "./config.ts";
import { withTimeout } from "./util.ts";

export interface CameraFrame {
  frameId: number;
  image: string;
  ageMs: number;
}

export interface CameraLinkStatus {
  url: string;
  reachable: boolean;
  /** Age of the newest frame, or null when none has arrived. */
  lastFrameAgeMs: number | null;
}

let lastStatus: CameraLinkStatus = { url: config.cameraLink.url, reachable: false, lastFrameAgeMs: null };

export const cameraLinkEnabled = () => config.cameraLink.url.length > 0;

/** Newest camera-link frame, or null if the link is off, unreachable, empty, or stale. */
export async function fetchCameraFrame(maxAgeMs = config.cameraLink.maxAgeMs): Promise<CameraFrame | null> {
  if (!cameraLinkEnabled()) return null;
  try {
    const res = await withTimeout(
      fetch(`${config.cameraLink.url}/api/frames/latest?max_side=${config.cameraLink.maxSide}`),
      2000,
      "Camera link",
    );
    if (res.status === 404) {
      lastStatus = { url: config.cameraLink.url, reachable: true, lastFrameAgeMs: null };
      return null;
    }
    if (!res.ok) throw new Error(`Camera link ${res.status}`);
    const body = (await res.json()) as { frame_id: number; timestamp: number; data_url: string };
    const ageMs = Math.max(0, Date.now() - body.timestamp * 1000);
    lastStatus = { url: config.cameraLink.url, reachable: true, lastFrameAgeMs: Math.round(ageMs) };
    return ageMs <= maxAgeMs ? { frameId: body.frame_id, image: body.data_url, ageMs } : null;
  } catch {
    lastStatus = { url: config.cameraLink.url, reachable: false, lastFrameAgeMs: null };
    return null;
  }
}

export async function cameraLinkStatus(): Promise<CameraLinkStatus> {
  await fetchCameraFrame(Infinity);
  return lastStatus;
}
