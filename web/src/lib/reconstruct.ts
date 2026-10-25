import type { Box, Distance, SessionSnapshot } from "../../../shared/types.ts";
import type { Frame } from "./lumi.tsx";
import { CAMERA_HEIGHT_M, clockFor, clockLabel, HORIZONTAL_FOV_DEG, VERTICAL_FOV_DEG } from "./spatial.ts";

/**
 * observed: in the live camera frame right now. estimated: from the latest room survey.
 * earlier: seen in an older view; the phone may have pointed elsewhere since.
 */
export type Provenance = "observed" | "estimated" | "earlier";

export type DistanceBasis = "distance class" | "ground plane" | "unclear";

export interface Placed {
  id: string;
  label: string;
  provenance: Provenance;
  role?: "target" | "destination" | "hand";
  /** Floor position in meters: x to the right, z negative ahead of the user. */
  x: number;
  z: number;
  /** Height of the object's center above the floor, in meters. */
  y: number;
  width: number;
  height: number;
  /** True when the box gave a usable extent; earlier sightings only have a position. */
  sized: boolean;
  distance: { min: number; mid: number; max: number; basis: DistanceBasis };
  azimuthDeg: number;
  angularWidthDeg: number;
  clock: number;
  heightBand: string;
  confidence?: number;
  note: string;
  hazard?: string;
  /** Quest step indexes that happen at this object. */
  missions: number[];
}

export interface Reconstruction {
  objects: Placed[];
  /** Things the task expects that the camera has not seen: deliberately not placed. */
  unlocated: { label: string; missions: number[] }[];
  /** Hazards the Vision Agent named but did not tie to a recognized object. */
  hazards: string[];
  coverage: { source: "frame" | "survey" | "none"; fovDeg: number; rangeM: number };
  /** Field of view assumed for the phone camera, from the frame's orientation. */
  fov: Fov;
  frame: { image: string; at: number; fresh: boolean } | null;
}

export const MAX_RANGE_M = 6;

export interface Fov {
  h: number;
  v: number;
}

/** Landscape frames see wider than tall; a phone held upright swaps the two. */
export const fovFor = (aspect: number | null): Fov =>
  aspect !== null && aspect < 1 ? { h: VERTICAL_FOV_DEG, v: HORIZONTAL_FOV_DEG } : { h: HORIZONTAL_FOV_DEG, v: VERTICAL_FOV_DEG };
const LIVE_MS = 12_000;

const rad = (deg: number) => (deg * Math.PI) / 180;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const norm = (label: string) => label.toLowerCase().replace(/^(the|a|an)\s+/, "").trim();

/** The Vision Agent's distance class for the current target, as a range in meters. */
const CLASS_RANGE: Record<Distance, [number, number]> = { far: [2, 5], near: [1, 2], within_reach: [0.4, 0.9], touching: [0.1, 0.4] };

const fromClass = (d: Distance): Placed["distance"] => {
  const [min, max] = CLASS_RANGE[d];
  return { min, max, mid: (min + max) / 2, basis: "distance class" };
};

const TABLE_HEIGHT_M = 0.75;
const UNCLEAR: Placed["distance"] = { min: 2, mid: 4, max: MAX_RANGE_M, basis: "unclear" };

/**
 * Distance from how far below the horizon the bottom of the box sits. The object rests somewhere between
 * the floor (farthest reading) and table height (nearest reading), so the range spans both.
 */
function fromGroundPlane(box: Box, fov: Fov): Placed["distance"] {
  const below = rad((box.y1 - 0.5) * fov.v);
  if (below < rad(2)) return UNCLEAR;
  const near = (CAMERA_HEIGHT_M - TABLE_HEIGHT_M) / Math.tan(below);
  const far = CAMERA_HEIGHT_M / Math.tan(below);
  if (near > MAX_RANGE_M) return UNCLEAR;
  const min = clamp(near, 0.3, MAX_RANGE_M);
  const max = clamp(far, min + 0.2, MAX_RANGE_M + 2);
  return { min, max, mid: Math.sqrt(min * max), basis: "ground plane" };
}

function place(id: string, label: string, box: Box, distance: Placed["distance"], provenance: Provenance, fov: Fov, sized = true): Placed {
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  const azimuthDeg = (cx - 0.5) * fov.h;
  const d = distance.mid;
  const angularWidthDeg = Math.max(2, (box.x1 - box.x0) * fov.h);
  const width = clamp(2 * d * Math.tan(rad(angularWidthDeg / 2)), 0.08, 3);
  const height = clamp(2 * d * Math.tan(rad(((box.y1 - box.y0) * fov.v) / 2)), 0.08, 2.5);
  const elevationDeg = (0.5 - cy) * fov.v;
  const y = clamp(CAMERA_HEIGHT_M + d * Math.tan(rad(elevationDeg)), sized ? height / 2 : 0.1, 2.6);
  return {
    id,
    label,
    provenance,
    x: d * Math.sin(rad(azimuthDeg)),
    z: -d * Math.cos(rad(azimuthDeg)),
    y,
    width,
    height,
    sized,
    distance,
    azimuthDeg,
    angularWidthDeg,
    clock: clockFor(azimuthDeg),
    heightBand: cy < 0.33 ? "above chest height" : cy < 0.66 ? "around chest height" : "below waist height",
    note: "",
    missions: [],
  };
}

/** Builds the approximate 3D layout from what the camera has actually reported. Nothing is placed without an observation. */
export function reconstruct(snapshot: SessionSnapshot | null, frame: Frame | null, now: number, frameAspect: number | null): Reconstruction {
  const fov = fovFor(frameAspect);
  const objects: Placed[] = [];
  const taken = new Set<string>();
  const step = snapshot?.quest?.steps[snapshot.stepIndex] ?? null;
  const o = frame?.observation ?? null;
  const live = frame !== null && now - frame.at < LIVE_MS;

  const add = (p: Placed) => {
    objects.push(p);
    taken.add(norm(p.label));
  };

  if (step && o && live) {
    if (o.targetBox) add({ ...place("live:target", step.target, o.targetBox, fromClass(o.distance), "observed", fov), role: "target", confidence: o.confidence });
    if (o.destinationBox && step.destination) {
      add({
        ...place("live:destination", step.destination, o.destinationBox, fromGroundPlane(o.destinationBox, fov), "observed", fov),
        role: "destination",
        confidence: o.confidence,
      });
    }
    if (o.handBox) {
      add({ ...place("live:hand", "Hand", o.handBox, { min: 0.2, mid: 0.45, max: 0.75, basis: "unclear" }, "observed", fov), role: "hand", confidence: o.confidence });
    }
  }

  for (const [i, so] of (snapshot?.scene?.objects ?? []).entries()) {
    if (taken.has(norm(so.label))) continue;
    add({ ...place(`scene:${i}:${norm(so.label)}`, so.label, so.box, fromGroundPlane(so.box, fov), "estimated", fov), note: so.note });
  }

  for (const l of snapshot?.map.landmarks ?? []) {
    if (!l.seen || taken.has(norm(l.label))) continue;
    // Map x is where it sat across the frame; map y encodes how low its box reached (see server/map.ts).
    const cx = l.x / 100;
    const bottom = clamp((l.y - 12) / 68, 0, 1);
    const box = { x0: cx - 0.03, x1: cx + 0.03, y0: Math.max(0, bottom - 0.08), y1: bottom };
    add({ ...place(`earlier:${l.id}`, l.label, box, fromGroundPlane(box, fov), "earlier", fov, false), note: l.note });
  }

  // Tie quest steps to placed objects through their map landmarks.
  const landmarkLabel = new Map((snapshot?.map.landmarks ?? []).map((l) => [l.id, l.label]));
  const unlocated = new Map<string, number[]>();
  snapshot?.missions.forEach((m, i) => {
    const label = m.landmarkId ? landmarkLabel.get(m.landmarkId) : undefined;
    if (!label) return;
    const hit = objects.find((p) => norm(p.label) === norm(label));
    if (hit) hit.missions.push(i);
    else unlocated.set(label, [...(unlocated.get(label) ?? []), i]);
  });
  for (const l of snapshot?.map.landmarks ?? []) if (!l.seen && !taken.has(norm(l.label)) && !unlocated.has(l.label)) unlocated.set(l.label, []);

  const hazards: string[] = [];
  for (const h of [...(snapshot?.scene?.hazards ?? []), ...(live && o?.hazard ? [o.hazard] : [])]) {
    const hit = objects.find((p) => p.role !== "hand" && h.toLowerCase().includes(norm(p.label)));
    if (hit) hit.hazard = h;
    else if (!hazards.includes(h)) hazards.push(h);
  }

  return {
    objects,
    unlocated: [...unlocated].map(([label, missions]) => ({ label, missions })),
    hazards,
    coverage: { source: live ? "frame" : snapshot?.scene ? "survey" : "none", fovDeg: fov.h, rangeM: MAX_RANGE_M },
    fov,
    frame: frame ? { image: frame.image, at: frame.at, fresh: live } : null,
  };
}

export const PROVENANCE_LABEL: Record<Provenance, string> = { observed: "Observed now", estimated: "Estimated from survey", earlier: "Earlier view" };

const meters = (m: number) => (m < 1 ? `${Math.round(m * 100)} cm` : `${m.toFixed(1)} m`);
export const distanceText = (p: Placed) =>
  p.distance.basis === "unclear" ? "distance unclear" : `about ${meters(p.distance.min)} to ${meters(p.distance.max)} away`;

/** One sentence per object, the same information the 3D view shows. */
export function describePlaced(p: Placed): string {
  const parts = [`${p.label}: ${PROVENANCE_LABEL[p.provenance].toLowerCase()}`, `around ${clockLabel(p.clock)}`, distanceText(p)];
  if (p.provenance !== "earlier") parts.push(p.heightBand);
  if (p.hazard) parts.push(`caution: ${p.hazard}`);
  return `${parts.join(", ")}.`;
}

export function coverageText(rec: Reconstruction): string {
  if (rec.coverage.source === "none") return "Nothing has been observed yet. Point the phone around the room to begin.";
  return `Built from a single camera viewpoint covering about ${rec.coverage.fovDeg} degrees ahead${
    rec.coverage.source === "survey" ? " (the latest room survey)" : " (the live frame)"
  }. Everything outside that view is unobserved. Directions come from the camera; distances are estimates.`;
}
