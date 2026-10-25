// The Vision Agent: everything that looks at camera frames. Gemini first, Muse Spark vision as fallback.
import type { QuestStep, Scene, SceneObject, StepObservation, Verdict, VisionCheck, VisionTiming } from "../shared/types.ts";
import { config, hasMuse, redact, visionMode } from "./config.ts";
import { MOCK_SCENE, mockObservation } from "./mock.ts";
import {
  OBSERVATION_SCHEMA,
  SCAN_PROMPT,
  SCENE_SCHEMA,
  VERIFY_SCHEMA,
  VERIFY_SYSTEM,
  VISION_SYSTEM,
  stepVisionPrompt,
  verifyPrompt,
} from "./prompts.ts";
import { geminiCoolingDown, geminiJson } from "./providers/gemini.ts";
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
  setting: string;
  objects: { label: string; box_2d: number[]; note: string }[];
  hazards: string[];
}

interface RawVerdict {
  verdict: Verdict;
  confidence: number;
  evidence: string[];
  summary: string;
}

/** One vision call at a time, so a frame loop can't open dozens of sockets and starve transcription. */
let pending: Promise<unknown> = Promise.resolve();
function queued<T>(fn: () => Promise<T>): Promise<T> {
  const run = pending.then(fn, fn);
  pending = run.then(() => undefined, () => undefined);
  return run;
}

/** Gemini first; on failure (quota, timeout) fall back to Muse Spark vision when a Meta key is present. */
function visionJson<T>(prompt: string, image: string, schema: object, name: string, system = VISION_SYSTEM) {
  return queued(() => visionJsonNow<T>(prompt, image, schema, name, system));
}

async function visionJsonNow<T>(
  prompt: string,
  image: string,
  schema: object,
  name: string,
  system = VISION_SYSTEM,
): Promise<{ value: T; provider: "gemini" | "muse" }> {
  const viaMuse = async () => ({
    value: await museJson<T>({
      messages: [{ role: "developer", content: system }, museImageMessage(prompt, image)],
      schema: { name, schema },
    }),
    provider: "muse" as const,
  });
  if (visionMode() !== "gemini" || geminiCoolingDown()) return viaMuse();
  try {
    return { value: await geminiJson<T>({ system, prompt, image, schema, model: config.gemini.visionModel, apiKey: config.gemini.visionApiKey }), provider: "gemini" };
  } catch (err) {
    if (!hasMuse()) throw err;
    console.warn("[vision] Gemini failed, using Muse Spark:", redact((err as Error).message).slice(0, 120));
    return viaMuse();
  }
}

const modelFor = (provider: "gemini" | "muse") => (provider === "gemini" ? config.gemini.visionModel : config.muse.model);

/**
 * Answer one yes/no question about a frame ("Is the room clean?") with PASS, FAIL, or
 * UNCERTAIN plus evidence. Without an image the answer is UNCERTAIN, never a guess.
 */
export async function inspect(question: string, image: string | null, context = ""): Promise<VisionCheck> {
  const base = { question, at: Date.now() };
  if (!image) {
    return {
      ...base,
      verdict: "UNCERTAIN",
      confidence: 0,
      evidence: ["No camera frame available"],
      summary: "I cannot see anything yet. Point the phone ahead.",
      provider: "none",
      model: "none",
      ms: 0,
    };
  }
  if (visionMode() === "mock") {
    return {
      ...base,
      verdict: "PASS",
      confidence: 0.9,
      evidence: ["Mock vision: no GEMINI_API_KEY or MODEL_API_KEY set"],
      summary: "It looks done.",
      provider: "mock",
      model: "mock",
      ms: 0,
    };
  }
  const {
    value: { value: raw, provider },
    ms,
  } = await timed(() => visionJson<RawVerdict>(verifyPrompt(question, context), image, VERIFY_SCHEMA, "vision_check", VERIFY_SYSTEM));
  const confidence = clamp(Number(raw.confidence) || 0, 0, 1);
  const claimed: Verdict = raw.verdict === "PASS" || raw.verdict === "FAIL" ? raw.verdict : "UNCERTAIN";
  return {
    ...base,
    verdict: claimed !== "UNCERTAIN" && confidence < config.game.verdictMinConfidence ? "UNCERTAIN" : claimed,
    confidence,
    evidence: (raw.evidence ?? []).filter(Boolean).slice(0, 4),
    summary: raw.summary ?? "",
    provider,
    model: modelFor(provider),
    ms,
  };
}

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
  return { scene: { setting: raw.setting ?? "", objects, hazards: raw.hazards ?? [] }, timing: { provider, model: modelFor(provider), ms } };
}
