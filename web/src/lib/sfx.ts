import type { Sfx } from "../../../shared/types.ts";

let ctx: AudioContext | null = null;

/** Shared AudioContext. Call `unlockAudio()` from a user gesture before the first sound. */
export function audioContext(): AudioContext {
  ctx ??= new AudioContext();
  return ctx;
}

export function unlockAudio() {
  void audioContext().resume();
}

interface Note {
  freq: number;
  at: number;
  dur: number;
  type?: OscillatorType;
  gain?: number;
  pan?: number;
}

export function playNotes(notes: Note[], destination?: AudioNode) {
  const ac = audioContext();
  const now = ac.currentTime + 0.01;
  for (const n of notes) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    const panner = ac.createStereoPanner();
    osc.type = n.type ?? "triangle";
    osc.frequency.value = n.freq;
    panner.pan.value = n.pan ?? 0;
    const peak = n.gain ?? 0.18;
    gain.gain.setValueAtTime(0, now + n.at);
    gain.gain.linearRampToValueAtTime(peak, now + n.at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + n.at + n.dur);
    osc.connect(gain).connect(panner).connect(destination ?? ac.destination);
    osc.start(now + n.at);
    osc.stop(now + n.at + n.dur + 0.05);
  }
}

const hz = (semitonesFromA4: number) => 440 * 2 ** (semitonesFromA4 / 12);
const C5 = hz(3), E5 = hz(7), G5 = hz(10), C6 = hz(15), E6 = hz(19), G6 = hz(22);

const SOUNDS: Record<Sfx, Note[]> = {
  start: [
    { freq: hz(-2), at: 0, dur: 0.25, type: "sawtooth", gain: 0.08 },
    { freq: hz(3), at: 0.22, dur: 0.5, type: "sawtooth", gain: 0.09 },
  ],
  step: [
    { freq: C5, at: 0, dur: 0.18 },
    { freq: E5, at: 0.08, dur: 0.18 },
    { freq: G5, at: 0.16, dur: 0.35 },
  ],
  combo: [
    { freq: E6, at: 0.3, dur: 0.12, type: "sine", gain: 0.12 },
    { freq: G6, at: 0.38, dur: 0.12, type: "sine", gain: 0.12 },
    { freq: hz(27), at: 0.46, dur: 0.3, type: "sine", gain: 0.12 },
  ],
  quest: [
    { freq: G5 / 2, at: 0, dur: 0.2, type: "square", gain: 0.07 },
    { freq: C5, at: 0.18, dur: 0.2, type: "square", gain: 0.07 },
    { freq: E5, at: 0.36, dur: 0.2, type: "square", gain: 0.07 },
    { freq: G5, at: 0.54, dur: 0.45, type: "square", gain: 0.07 },
    { freq: C6, at: 0.95, dur: 0.9, type: "triangle", gain: 0.16 },
    { freq: E5, at: 0.95, dur: 0.9, type: "triangle", gain: 0.1 },
  ],
  levelup: [0, 4, 7, 12, 16, 19, 24].map((s, i) => ({ freq: hz(3 + s), at: 0.9 + i * 0.07, dur: 0.4, type: "sine" as const, gain: 0.11 })),
  fail: [
    { freq: hz(-5), at: 0, dur: 0.25, type: "sawtooth", gain: 0.07 },
    { freq: hz(-9), at: 0.2, dur: 0.4, type: "sawtooth", gain: 0.07 },
  ],
  hint: [
    { freq: hz(10), at: 0, dur: 0.2, type: "sine", gain: 0.1 },
    { freq: hz(15), at: 0.12, dur: 0.3, type: "sine", gain: 0.1 },
  ],
};

export function playSfx(names: Sfx[] | undefined) {
  for (const name of names ?? []) playNotes(SOUNDS[name]);
}
