import type { FrameResponse } from "../../../shared/types.ts";
import { api } from "./api.ts";

export async function startCamera(video: HTMLVideoElement): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
  });
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  return stream;
}

const canvas = document.createElement("canvas");

/** JPEG data URL with the long edge scaled to `maxEdge`. Small frames keep vision latency down. */
export function captureFrame(video: HTMLVideoElement, maxEdge = 512, quality = 0.6): string | null {
  const { videoWidth: w, videoHeight: h } = video;
  if (!w || !h) return null;
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

interface FrameLoopOptions {
  sessionId: string;
  video: HTMLVideoElement;
  intervalMs?: number;
  maxInFlight?: number;
  onResponse: (res: FrameResponse) => void;
  onError?: (err: Error) => void;
}

/**
 * Sends a frame every `intervalMs` with up to `maxInFlight` requests overlapping,
 * and only surfaces responses newer than the last one delivered.
 */
export class FrameLoop {
  private timer: number | null = null;
  private seq = 0;
  private inFlight = 0;
  private lastDelivered = -1;
  private readonly opts: Required<Omit<FrameLoopOptions, "onError">> & Pick<FrameLoopOptions, "onError">;

  constructor(opts: FrameLoopOptions) {
    this.opts = { intervalMs: 600, maxInFlight: 2, ...opts };
  }

  get running() {
    return this.timer !== null;
  }

  start() {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => this.tick(), this.opts.intervalMs);
    this.tick();
  }

  stop() {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  private tick() {
    if (this.inFlight >= this.opts.maxInFlight) return;
    const image = captureFrame(this.opts.video);
    if (!image) return;
    const seq = ++this.seq;
    this.inFlight++;
    api
      .frame({ sessionId: this.opts.sessionId, seq, image })
      .then((res) => {
        if (res.seq > this.lastDelivered) {
          this.lastDelivered = res.seq;
          this.opts.onResponse(res);
        }
      })
      .catch((err: Error) => this.opts.onError?.(err))
      .finally(() => this.inFlight--);
  }
}
