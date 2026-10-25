// The Vision Agent: everything that looks at camera frames. OpenAI or Gemini first, Muse Spark vision as fallback.
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
import { openaiJson } from "./providers/openai.ts";
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

type VisionLane = "interactive" | "background";
type VisionProvider = "gemini" | "muse" | "openai";

/** Interactive work (player asked) runs first; background frame work is dropped while anything is queued or running. */
let interactiveTail: Promise<unknown> = Promise.resolve();
let running = 0;
let interactiveQueued = 0;

function visionBusy() {
  return running > 0 || interactiveQueued > 0;
}

function queueInteractive<T>(fn: () => Promise<T>): Promise<T> {
  interactiveQueued++;
  const run = interactiveTail.then(async () => {
    running++;
    try {
      return await fn();
    } finally {
      running--;
      interactiveQueued--;
    }
  });
  interactiveTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function runBackground<T>(fn: () => Promise<T>): Promise<T | null> {
  if (visionBusy()) return null;
  running++;
  try {
    return await fn();
  } finally {
    running--;
  }
}

function scheduleVision<T>(
  lane: VisionLane,
  fn: () => Promise<{ value: T; provider: VisionProvider }>,
): Promise<{ value: T; provider: VisionProvider } | null> {
  if (lane === "interactive") return queueInteractive(fn);
  return runBackground(fn);
}

/** Gemini first; on failure (quota, timeout) fall back to Muse Spark vision when a Meta key is present. */
function visionJson<T>(prompt: string, image: string, schema: object, name: string, lane: VisionLane, system = VISION_SYSTEM) {
  const work = () => visionJsonNow<T>(prompt, image, schema, name, system);
  return scheduleVision(lane, work);
}

async function visionJsonNow<T>(
  prompt: string,
  image: string,
  schema: object,
  name: string,
  system = VISION_SYSTEM,
): Promise<{ value: T; provider: VisionProvider }> {
  const viaMuse = async () => ({
    value: await museJson<T>({
      messages: [{ role: "developer", content: system }, museImageMessage(prompt, image)],
      schema: { name, schema },
    }),
    provider: "muse" as const,
  });
  if (visionMode() === "openai") {
    try {
      return {
        value: await openaiJson<T>({
          system,
          prompt,
          image,
          schema,
          name,
          model: config.openai.visionModel,
          apiKey: config.openai.visionApiKey,
          reasoningEffort: config.openai.reasoningEffort,
        }),
        provider: "openai",
      };
    } catch (err) {
      if (!hasMuse()) throw err;
      console.warn("[vision] OpenAI failed, using Muse Spark:", redact((err as Error).message).slice(0, 120));
      return viaMuse();
    }
  }
  if (visionMode() !== "gemini" || geminiCoolingDown()) return viaMuse();
  try {
    return {
      value: await geminiJson<T>({ system, prompt, image, schema, model: config.gemini.visionModel, apiKey: config.gemini.visionApiKey }),
      provider: "gemini",
    };
  } catch (err) {
    if (!hasMuse()) throw err;
    console.warn("[vision] Gemini failed, using Muse Spark:", redact((err as Error).message).slice(0, 120));
    return viaMuse();
  }
}

const modelFor = (provider: VisionProvider) =>
  provider === "openai" ? config.openai.visionModel : provider === "gemini" ? config.gemini.visionModel : config.muse.model;

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
  const wrapped = await timed(() => visionJson<RawVerdict>(verifyPrompt(question, context), image, VERIFY_SCHEMA, "vision_check", "interactive", VERIFY_SYSTEM));
  if (!wrapped.value) throw new Error("Vision unavailable");
  const {
    value: { value: raw, provider },
    ms,
  } = { value: wrapped.value, ms: wrapped.ms };
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
): Promise<{ observation: StepObservation; timing: VisionTiming } | null> {
  const mode = visionMode();
  if (mode === "mock") {
    return { observation: mockObservation(step, mockTick), timing: { provider: "mock", model: "mock", ms: 0 } };
  }
  const timedResult = await timed(() => visionJson<RawObservation>(stepVisionPrompt(step), image, OBSERVATION_SCHEMA, "step_observation", "background"));
  if (!timedResult.value) return null;
  const {
    value: { value: raw, provider },
    ms,
  } = timedResult;
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

export async function scanScene(image: string, lane: VisionLane = "interactive"): Promise<{ scene: Scene; timing: VisionTiming } | null> {
  const mode = visionMode();
  if (mode === "mock") return { scene: MOCK_SCENE, timing: { provider: "mock", model: "mock", ms: 0 } };

  const timedResult = await timed(() => visionJson<RawScene>(SCAN_PROMPT, image, SCENE_SCHEMA, "scene", lane));
  if (!timedResult.value) return null;
  const {
    value: { value: raw, provider },
    ms,
  } = timedResult;
  const objects = raw.objects
    .map((o): SceneObject | null => {
      const box = boxFrom1000(o.box_2d);
      return box ? { label: o.label, box, note: o.note } : null;
    })
    .filter((o): o is SceneObject => o !== null);
  return { scene: { setting: raw.setting ?? "", objects, hazards: raw.hazards ?? [] }, timing: { provider, model: modelFor(provider), ms } };
}

export const visionQueueStatus = () => ({ busy: visionBusy(), interactiveQueued, running });
