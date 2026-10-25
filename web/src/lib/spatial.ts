import type { Box, Distance, MapLandmark } from "../../../shared/types.ts";

// Phone main cameras see roughly 65 degrees across and 50 degrees up and down. Bearings derived
// from a frame are estimates; the phone is held at chest height, facing forward.
export const HORIZONTAL_FOV_DEG = 65;
export const VERTICAL_FOV_DEG = 50;
export const CAMERA_HEIGHT_M = 1.3;

export type Side = "left" | "ahead" | "right";

export const centerOf = (box: Box) => ({ x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 });

/** Clock position (9 to 3) for a horizontal angle in degrees, 0 = straight ahead. */
export function clockFor(angleDeg: number): number {
  const hour = Math.round(12 + angleDeg / 30);
  return ((hour + 11) % 12) + 1;
}

export const clockLabel = (hour: number) => `${hour} o'clock`;

/** Where a box sits from the camera's point of view: side, clock position, and height. */
export function bearingOfBox(box: Box): { side: Side; sideLabel: string; clock: number; height: string } {
  const { x, y } = centerOf(box);
  const dx = x - 0.5;
  const side: Side = dx < -0.12 ? "left" : dx > 0.12 ? "right" : "ahead";
  const sideLabel = side === "ahead" ? "straight ahead" : `${Math.abs(dx) > 0.3 ? "" : "slightly "}to the ${side}`;
  const height = y < 0.33 ? "above chest height" : y < 0.66 ? "around chest height" : "below waist height";
  return { side, sideLabel, clock: clockFor(dx * HORIZONTAL_FOV_DEG), height };
}

/** How one box sits relative to another, e.g. "left of", "on top of". Null when it can't be told. */
export function relationBetween(a: Box, b: Box): string | null {
  const ca = centerOf(a);
  const cb = centerOf(b);
  const overlapX = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const overlapY = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (overlapX > 0 && overlapY > 0) {
    if (a.y1 <= b.y0 + (b.y1 - b.y0) * 0.35) return "on top of";
    return "next to";
  }
  const dx = ca.x - cb.x;
  const dy = ca.y - cb.y;
  if (Math.abs(dx) < 0.04 && Math.abs(dy) < 0.04) return null;
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? "left of" : "right of";
  return dy < 0 ? "above" : "below";
}

export const DISTANCE_LABEL: Record<Distance, string> = {
  far: "a few steps away",
  near: "close by",
  within_reach: "within arm's reach",
  touching: "at the user's hand",
};

/** Words that qualify a reading by how sure the model is. */
export function qualifier(confidence: number): { word: string; level: "high" | "medium" | "low" } {
  if (confidence >= 0.8) return { word: "Confident", level: "high" };
  if (confidence >= 0.55) return { word: "Likely", level: "medium" };
  return { word: "Uncertain", level: "low" };
}

/**
 * Bearing of a Quest Map landmark from the user. Map x comes from where it appeared across a frame,
 * map y from how low it sat (lower = nearer), so this is an estimate from the last time it was seen.
 */
export function bearingOfLandmark(l: MapLandmark): { clock: number; distance: string } {
  const forward = Math.max(4, 100 - l.y);
  const angle = (Math.atan2(l.x - 50, forward) * 180) / Math.PI;
  const distance = l.y >= 62 ? "close by" : l.y >= 38 ? "a few steps away" : "across the room";
  return { clock: clockFor(angle), distance };
}

export const sideOfLandmark = (l: MapLandmark): Side => (l.x < 40 ? "left" : l.x > 60 ? "right" : "ahead");
