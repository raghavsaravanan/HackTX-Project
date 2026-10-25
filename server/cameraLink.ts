// Reads the phone's newest frame from the Python camera server (app/). The phone pushes
// one JPEG a second to its /ws/frames.
import { config } from "./config.ts";
import { withTimeout } from "./util.ts";

interface CameraFrame {
  frameId: number;
  image: string;
  ageMs: number;
}

interface CameraLinkStatus {
  url: string;
  reachable: boolean;
  /** Age of the newest frame, or null when none has arrived. */
  lastFrameAgeMs: number | null;
}

interface LatestFrame {
  frame_id: number;
  timestamp: number;
  data_url?: string;
}

export const cameraLinkEnabled = () => config.cameraLink.url.length > 0;

/** The camera server's newest frame metadata (plus the image when asked), null if none yet. Throws when unreachable. */
async function latest(withImage: boolean): Promise<LatestFrame | null> {
  const query = withImage ? `max_side=${config.cameraLink.maxSide}` : "include_image=false";
  const res = await withTimeout(fetch(`${config.cameraLink.url}/api/frames/latest?${query}`), 2000, "Camera link");
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Camera link ${res.status}`);
  return (await res.json()) as LatestFrame;
}

const ageOf = (frame: LatestFrame) => Math.max(0, Date.now() - frame.timestamp * 1000);

/** Newest phone frame, or null if the link is off, unreachable, empty, or stale. */
export async function fetchCameraFrame(): Promise<CameraFrame | null> {
  if (!cameraLinkEnabled()) return null;
  try {
    const frame = await latest(true);
    if (!frame?.data_url) return null;
    const ageMs = ageOf(frame);
    return ageMs <= config.cameraLink.maxAgeMs ? { frameId: frame.frame_id, image: frame.data_url, ageMs } : null;
  } catch {
    return null;
  }
}

export async function cameraLinkStatus(): Promise<CameraLinkStatus> {
  const url = config.cameraLink.url;
  try {
    const frame = await latest(false);
    return { url, reachable: true, lastFrameAgeMs: frame ? Math.round(ageOf(frame)) : null };
  } catch {
    return { url, reachable: false, lastFrameAgeMs: null };
  }
}
