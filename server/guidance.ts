import type { Distance, Guidance, QuestStep, StepObservation } from "../shared/types.ts";
import { clamp } from "./util.ts";

const IDLE: Guidance = { phase: "idle", pan: 0, proximity: 0, say: "", navBox: null };

const DISTANCE_PROXIMITY: Record<Distance, number> = { far: 0.15, near: 0.4, within_reach: 0.72, touching: 0.95 };
/** How long a remembered position is trusted once the thing leaves the view. */
const MEMORY_MS = 10000;

/** Where something was last seen: horizontal offset from center (-0.5 left .. 0.5 right) and when. */
export interface SeenAt {
  dx: number;
  at: number;
}

/** Which thing the player should head for: the target until they hold it, then the destination. */
export function navTarget(step: QuestStep, obs: StepObservation | null): string {
  const carrying = (step.action === "drop" || step.action === "place") && step.destination !== "" && (obs?.holdingTarget ?? false);
  return carrying ? step.destination : step.target;
}

/**
 * Turns one observation into audio-cue parameters. `lastSeen` remembers where things were seen,
 * so the player is steered back toward a target that just left the view instead of told to sweep.
 */
export function computeGuidance(
  step: QuestStep | null,
  obs: StepObservation | null,
  lastSeen: Record<string, SeenAt> = {},
  now = Date.now(),
): Guidance {
  if (!step || !obs) return IDLE;

  const toDestination = navTarget(step, obs) === step.destination && step.destination !== "";
  const navName = toDestination ? step.destination : step.target;
  const navBox = toDestination ? obs.destinationBox : obs.targetBox;
  const hazard = obs.hazard ? `Careful, ${obs.hazard}. ` : "";

  if (obs.stepDone) return { phase: "verify", pan: 0, proximity: 1, say: "", navBox };

  if (!navBox) {
    const seen = lastSeen[navName];
    if (seen && now - seen.at < MEMORY_MS && Math.abs(seen.dx) > 0.05) {
      const side = seen.dx < 0 ? "left" : "right";
      return {
        phase: "scan",
        pan: seen.dx < 0 ? -0.6 : 0.6,
        proximity: 0,
        say: `${hazard}The ${navName} was to your ${side}. Turn your body slowly to the ${side}.`,
        navBox: null,
      };
    }
    return {
      phase: "scan",
      pan: 0,
      proximity: 0,
      say: `${hazard}Hold the phone at chest height and turn slowly left, then right, so I can find the ${navName}.`,
      navBox: null,
    };
  }

  const dx = (navBox.x0 + navBox.x1) / 2 - 0.5;
  const pan = clamp(dx * 2.2, -1, 1);
  const area = (navBox.x1 - navBox.x0) * (navBox.y1 - navBox.y0);
  const proximity = clamp(0.7 * DISTANCE_PROXIMITY[obs.distance] + 0.3 * Math.sqrt(area) * 1.4, 0, 1);

  if (obs.distance === "within_reach" || obs.distance === "touching") {
    return { phase: "reach", pan, proximity, say: hazard + (obs.instruction || "It's within reach. Slide your hand forward slowly, fingers relaxed."), navBox };
  }
  if (Math.abs(dx) > 0.15) {
    const side = dx < 0 ? "left" : "right";
    const amount = Math.abs(dx) > 0.3 ? "" : " a little";
    return { phase: "aim", pan, proximity, say: `${hazard}Turn${amount} ${side}.`, navBox };
  }
  return {
    phase: "approach",
    pan,
    proximity,
    say: hazard + (obs.instruction || `The ${navName} is straight ahead. Take small steps forward, one hand out at waist height.`),
    navBox,
  };
}
