import type { Box, MapLandmark, Quest, QuestMap, QuestStep, Scene } from "../shared/types.ts";
import { clamp } from "./util.ts";

export const emptyMap = (): QuestMap => ({ setting: "", landmarks: [], playerAt: null, goalCheck: null, updatedAt: Date.now() });

const MAX_LANDMARKS = 18;

const norm = (label: string) => label.toLowerCase().replace(/^(the|a|an)\s+/, "").trim();

export function findLandmark(map: QuestMap, label: string): MapLandmark | undefined {
  const want = norm(label);
  if (!want) return undefined;
  return map.landmarks.find((l) => norm(l.label) === want) ?? map.landmarks.find((l) => norm(l.label).includes(want) || want.includes(norm(l.label)));
}

/** Where a step happens: the destination for drop/place, otherwise the target. */
export const anchorLabel = (step: QuestStep) => ((step.action === "drop" || step.action === "place") && step.destination ? step.destination : step.target);

// Image x maps to map x; the bottom edge of a box maps to depth (lower in the frame = nearer the player).
const fromBox = (box: Box) => ({ x: clamp(((box.x0 + box.x1) / 2) * 100, 6, 94), y: clamp(12 + box.y1 * 68, 12, 80) });

/** Nudge a new landmark away from existing ones so labels stay readable. */
function freeSpot(map: QuestMap, pos: { x: number; y: number }) {
  const spot = { ...pos };
  for (let tries = 0; tries < 8 && map.landmarks.some((l) => Math.abs(l.x - spot.x) < 9 && Math.abs(l.y - spot.y) < 7); tries++) {
    spot.x = clamp(spot.x + (tries % 2 ? -11 : 11) * Math.ceil((tries + 1) / 2), 6, 94);
    spot.y = clamp(spot.y + 4, 12, 80);
  }
  return spot;
}

function addLandmark(map: QuestMap, label: string, pos: { x: number; y: number }, seen: boolean, note = ""): MapLandmark {
  const existing = findLandmark(map, label);
  if (existing) return existing;
  const ids = map.landmarks.map((l) => Number(l.id.slice(2)) || 0);
  const landmark = { id: `lm${Math.max(0, ...ids) + 1}`, label, ...freeSpot(map, pos), seen, note };
  map.landmarks.push(landmark);
  return landmark;
}

/** Landmarks from what the Vision Agent recognized, plus placeholders for quest objects it hasn't seen yet. */
export function buildMap(quest: Quest | null, scene: Scene | null): QuestMap {
  const map = emptyMap();
  if (scene) mergeScene(map, scene);
  const wanted = quest ? [...new Set(quest.steps.flatMap((s) => [s.target, s.destination]).filter(Boolean))] : [];
  const missing = wanted.filter((l) => !findLandmark(map, l));
  missing.forEach((label, i) => {
    const x = 14 + ((i + 0.5) * 72) / missing.length;
    addLandmark(map, label, { x, y: 30 + (i % 2) * 22 }, false);
  });
  return map;
}

/** Fold a fresh survey into the map: new objects become landmarks, unplaced ones get positions. Returns true if anything changed. */
export function mergeScene(map: QuestMap, scene: Scene): boolean {
  let changed = false;
  if (scene.setting && scene.setting !== map.setting) {
    map.setting = scene.setting;
    changed = true;
  }
  for (const o of scene.objects) {
    const existing = findLandmark(map, o.label);
    if (existing) {
      if (!existing.seen) {
        Object.assign(existing, freeSpot({ ...map, landmarks: map.landmarks.filter((l) => l !== existing) }, fromBox(o.box)), { seen: true });
        changed = true;
      }
      if (!existing.note && o.note) {
        existing.note = o.note;
        changed = true;
      }
    } else if (map.landmarks.length < MAX_LANDMARKS) {
      addLandmark(map, o.label, fromBox(o.box), true, o.note);
      changed = true;
    }
  }
  if (changed) map.updatedAt = Date.now();
  return changed;
}

/** The Vision Agent spotted a landmark. Returns true if the map changed. */
export function markSeen(map: QuestMap, label: string, box: Box | null): boolean {
  const landmark = findLandmark(map, label);
  if (!landmark || landmark.seen) return false;
  landmark.seen = true;
  if (box) Object.assign(landmark, fromBox(box));
  map.updatedAt = Date.now();
  return true;
}

export function setPlayerAt(map: QuestMap, label: string): boolean {
  const id = label ? (findLandmark(map, label)?.id ?? null) : null;
  if (!id || id === map.playerAt) return false;
  map.playerAt = id;
  map.updatedAt = Date.now();
  return true;
}

/** Notes from the Quest Agent; unknown labels become new, unplaced landmarks. */
export function applyNotes(map: QuestMap, notes: { label: string; note: string }[]): boolean {
  let changed = false;
  for (const { label, note } of notes) {
    if (!label.trim()) continue;
    const landmark = findLandmark(map, label) ?? addLandmark(map, label.trim(), { x: 10 + ((map.landmarks.length * 17) % 80), y: 20 }, false);
    if (note && landmark.note !== note) {
      landmark.note = note.slice(0, 80);
      changed = true;
    }
  }
  if (changed) map.updatedAt = Date.now();
  return changed;
}
