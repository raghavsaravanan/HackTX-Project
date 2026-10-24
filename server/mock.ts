import type { QuestStep, Scene, StepObservation } from "../shared/types.ts";

const box = (cx: number, cy: number, w: number, h: number) => ({
  x0: cx - w / 2,
  y0: cy - h / 2,
  x1: cx + w / 2,
  y1: cy + h / 2,
});

/** Scripted progression so the whole loop can be demoed with no API keys. `tick` = frames since step start. */
export function mockObservation(step: QuestStep, tick: number): StepObservation {
  const carrying = step.action === "drop" || step.action === "place";
  const base: StepObservation = {
    targetVisible: false,
    targetBox: null,
    handVisible: false,
    handBox: null,
    destinationVisible: false,
    destinationBox: null,
    holdingTarget: carrying,
    distance: "far",
    stepDone: false,
    confidence: 0.3,
    instruction: "Sweep slowly to your right.",
    hazard: "",
  };
  if (tick < 2) return base;

  const path = [
    { cx: 0.15, size: 0.12, distance: "far", instruction: "Turn a little to your left." },
    { cx: 0.32, size: 0.16, distance: "near", instruction: "Almost centered. Step forward." },
    { cx: 0.48, size: 0.24, distance: "near", instruction: "Straight ahead. Keep going." },
    { cx: 0.5, size: 0.32, distance: "within_reach", instruction: "Reach forward and a bit lower." },
    { cx: 0.5, size: 0.34, distance: "touching", instruction: "Got it. Hold steady." },
  ] as const;
  const p = path[Math.min(tick - 2, path.length - 1)];
  const navBox = box(p.cx, 0.55, p.size, p.size * 1.1);
  const done = tick >= 2 + path.length;

  return {
    ...base,
    targetVisible: true,
    targetBox: carrying ? box(0.5, 0.75, 0.12, 0.14) : navBox,
    destinationVisible: carrying,
    destinationBox: carrying ? navBox : null,
    handVisible: tick >= 5,
    handBox: tick >= 5 ? box(p.cx - 0.05, 0.75, 0.16, 0.2) : null,
    distance: p.distance,
    stepDone: done,
    confidence: done ? 0.92 : 0.5,
    instruction: p.instruction,
  };
}

export const MOCK_SCENE: Scene = {
  objects: [
    { label: "water bottle", box: box(0.3, 0.55, 0.08, 0.2), note: "on the desk, left of the laptop" },
    { label: "laptop", box: box(0.55, 0.5, 0.3, 0.2), note: "center of the desk" },
    { label: "book", box: box(0.8, 0.6, 0.15, 0.08), note: "right side of the desk" },
    { label: "backpack", box: box(0.12, 0.85, 0.2, 0.25), note: "on the floor, left of the chair" },
    { label: "trash can", box: box(0.88, 0.9, 0.18, 0.2), note: "on the floor, right of the desk" },
  ],
  hazards: [],
};
