import type { QuestStep, Scene, SceneObject, StepObservation, VisionTiming } from "../shared/types.ts";
import { config, hasMuse, visionMode } from "./config.ts";
import { MOCK_SCENE, mockObservation } from "./mock.ts";
import { OBSERVATION_SCHEMA, SCAN_PROMPT, SCENE_SCHEMA, VISION_SYSTEM, stepVisionPrompt } from "./prompts.ts";
import { geminiJson } from "./providers/gemini.ts";
import { museImageMessage, museJson } from "./providers/muse.ts";
import { boxFrom1000, clamp, timed } from "./util.ts";

interface RawObservation {
  target_visible: boolean;
  target_box: number[];
  hand_visible: boolean;
  hand_box: number[];
  destination_visible: boolean;
  destination_box: number[];
  holding_target: boolean;
  distance: StepObservation["distance"];
  step_done: boolean;
  confidence: number;
  instruction: string;
  hazard: string;
}

interface RawScene {
  objects: { label: string; box_2d: number[]; note: string }[];
  hazards: string[];
}

/** Gemini first; on failure (quota, timeout) fall back to Muse Spark vision when a Meta key is present. */
async function visionJson<T>(prompt: string, image: string, schema: object, name: string): Promise<{ value: T; provider: "gemini" | "muse" }> {
  const viaMuse = async () => ({
    value: await museJson<T>({
      messages: [{ role: "developer", content: VISION_SYSTEM }, museImageMessage(prompt, image)],
      schema: { name, schema },
    }),
    provider: "muse" as const,
  });
  if (visionMode() !== "gemini") return viaMuse();
  try {
    return { value: await geminiJson<T>({ system: VISION_SYSTEM, prompt, image, schema }), provider: "gemini" };
  } catch (err) {
    if (!hasMuse()) throw err;
    console.warn("[vision] Gemini failed, using Muse Spark:", (err as Error).message.slice(0, 120));
    return viaMuse();
  }
}

const modelFor = (provider: "gemini" | "muse") => (provider === "gemini" ? config.gemini.model : config.muse.model);

export async function observeStep(
  image: string,
  step: QuestStep,
  mockTick: number,
): Promise<{ observation: StepObservation; timing: VisionTiming }> {
  const mode = visionMode();
  if (mode === "mock") {
    return { observation: mockObservation(step, mockTick), timing: { provider: "mock", model: "mock", ms: 0 } };
  }
  const {
    value: { value: raw, provider },
    ms,
  } = await timed(() => visionJson<RawObservation>(stepVisionPrompt(step), image, OBSERVATION_SCHEMA, "step_observation"));
  const targetBox = boxFrom1000(raw.target_box);
  const handBox = boxFrom1000(raw.hand_box);
  const destinationBox = boxFrom1000(raw.destination_box);
  return {
    observation: {
      targetVisible: raw.target_visible && targetBox !== null,
      targetBox,
      handVisible: raw.hand_visible && handBox !== null,
      handBox,
      destinationVisible: raw.destination_visible && destinationBox !== null,
      destinationBox,
      holdingTarget: raw.holding_target,
      distance: raw.distance,
      stepDone: raw.step_done,
      confidence: clamp(Number(raw.confidence) || 0, 0, 1),
      instruction: raw.instruction ?? "",
      hazard: raw.hazard ?? "",
    },
    timing: { provider, model: modelFor(provider), ms },
  };
}

export async function scanScene(image: string): Promise<{ scene: Scene; timing: VisionTiming }> {
  const mode = visionMode();
  if (mode === "mock") return { scene: MOCK_SCENE, timing: { provider: "mock", model: "mock", ms: 0 } };

  const {
    value: { value: raw, provider },
    ms,
  } = await timed(() => visionJson<RawScene>(SCAN_PROMPT, image, SCENE_SCHEMA, "scene"));
  const objects = raw.objects
    .map((o): SceneObject | null => {
      const box = boxFrom1000(o.box_2d);
      return box ? { label: o.label, box, note: o.note } : null;
    })
    .filter((o): o is SceneObject => o !== null);
  return { scene: { objects, hazards: raw.hazards ?? [] }, timing: { provider, model: modelFor(provider), ms } };
}
