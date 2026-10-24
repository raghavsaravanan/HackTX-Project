import type { Distance, Guidance, QuestStep, StepObservation } from "../shared/types.ts";
import { clamp } from "./util.ts";

const IDLE: Guidance = { phase: "idle", pan: 0, proximity: 0, say: "", navBox: null };

const DISTANCE_PROXIMITY: Record<Distance, number> = { far: 0.15, near: 0.4, within_reach: 0.72, touching: 0.95 };

/** Turns one observation into audio-cue parameters. Pure, so the phone can mirror it if needed. */
export function computeGuidance(step: QuestStep | null, obs: StepObservation | null): Guidance {
  if (!step || !obs) return IDLE;

  const toDestination = (step.action === "drop" || step.action === "place") && step.destination !== "";
  const navName = toDestination ? step.destination : step.target;
  const navBox = toDestination ? obs.destinationBox : obs.targetBox;
  const hazard = obs.hazard ? `Careful, ${obs.hazard}. ` : "";

  if (obs.stepDone) return { phase: "verify", pan: 0, proximity: 1, say: "", navBox };

  if (!navBox) {
    return { phase: "scan", pan: 0, proximity: 0, say: `${hazard}Sweep slowly to find the ${navName}.`, navBox: null };
  }

  const dx = (navBox.x0 + navBox.x1) / 2 - 0.5;
  const pan = clamp(dx * 2.2, -1, 1);
  const area = (navBox.x1 - navBox.x0) * (navBox.y1 - navBox.y0);
  const proximity = clamp(0.7 * DISTANCE_PROXIMITY[obs.distance] + 0.3 * Math.sqrt(area) * 1.4, 0, 1);

  if (obs.distance === "within_reach" || obs.distance === "touching") {
    return { phase: "reach", pan, proximity, say: hazard + (obs.instruction || "Reach forward slowly."), navBox };
  }
  if (Math.abs(dx) > 0.15) {
    const side = dx < 0 ? "left" : "right";
    const amount = Math.abs(dx) > 0.3 ? "" : " a little";
    return { phase: "aim", pan, proximity, say: `${hazard}Turn${amount} ${side}.`, navBox };
  }
  return { phase: "approach", pan, proximity, say: hazard + (obs.instruction || `The ${navName} is ahead. Step forward slowly.`), navBox };
}
