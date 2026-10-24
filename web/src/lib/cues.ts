import type { Guidance } from "../../../shared/types.ts";
import { audioContext, playNotes } from "./sfx.ts";

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Continuous spatial audio driven by the latest Guidance:
 * scan = slow sonar ping, aim = panned beep toward the target,
 * approach = beeps speed up with proximity, reach = rising pitch, verify = silence.
 */
export class GuidanceCues {
  private guidance: Guidance | null = null;
  private timer: number | null = null;
  private lastPhase: Guidance["phase"] = "idle";
  enabled = true;

  update(g: Guidance) {
    if (this.lastPhase === "aim" && g.phase === "approach") {
      playNotes([{ freq: 1318, at: 0, dur: 0.15, type: "sine", gain: 0.12 }]);
    }
    this.lastPhase = g.phase;
    this.guidance = g;
    if (this.timer === null) this.schedule(0);
  }

  stop() {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.guidance = null;
  }

  private schedule(ms: number) {
    this.timer = window.setTimeout(() => this.beat(), ms);
  }

  private beat() {
    const g = this.guidance;
    if (!g || !this.enabled || audioContext().state !== "running") {
      this.schedule(300);
      return;
    }
    const p = g.proximity;
    switch (g.phase) {
      case "scan":
        playNotes([{ freq: 880, at: 0, dur: 0.6, type: "sine", gain: 0.06 }]);
        this.schedule(1400);
        return;
      case "aim":
        playNotes([{ freq: 520, at: 0, dur: 0.09, type: "triangle", gain: 0.14, pan: g.pan }]);
        this.schedule(520);
        return;
      case "approach":
        playNotes([{ freq: 660, at: 0, dur: 0.07, type: "triangle", gain: 0.14, pan: g.pan }]);
        this.schedule(lerp(700, 160, p));
        return;
      case "reach":
        playNotes([{ freq: lerp(500, 1300, p), at: 0, dur: 0.06, type: "sine", gain: 0.13, pan: g.pan }]);
        this.schedule(130);
        return;
      default:
        this.schedule(300);
    }
  }
}
