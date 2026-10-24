import type { QuestStep, Scene, StepObservation } from "../shared/types.ts";

export const NARRATOR = {
  name: "Sir Echo",
  persona:
    "You are Sir Echo, a warm, witty knight who narrates everyday tasks as heroic quests for a blind player. " +
    "You speak in short, vivid, encouraging lines. Light medieval flavor, never cheesy for more than one phrase. " +
    "The player cannot see: never rely on color or visual-only details; describe direction, distance, shape, and touch. " +
    "Plain spoken English only. No emojis, no markdown, no lists.",
};

// ---------- Vision (Gemini, or Muse Spark as fallback) ----------

const BOX_RULES =
  "Boxes are box_2d = [y_min, x_min, y_max, x_max] as integers 0-1000 relative to the image, origin top-left. " +
  "Use an empty array when the thing is not visible.";

export const VISION_SYSTEM =
  "You are the eyes of a blind player in an audio guidance game. The phone camera is held at chest height facing forward, like a flashlight. " +
  "Report only what is visible in this single frame. Never guess about things out of frame. " +
  "Left and right of the image are the player's left and right. " +
  BOX_RULES;

const DONE_RULES: Record<QuestStep["action"], string> = {
  find: "step_done when the target is clearly visible and roughly centered horizontally (x between 300 and 700).",
  grab: "step_done only when a hand is clearly holding or lifting the target.",
  drop: "step_done when the target is inside the destination, or the hand is releasing it directly over the destination.",
  place: "step_done when the target is resting in or on the destination.",
  press: "step_done when a fingertip is pressing the target.",
  open: "step_done when the target (door, drawer, lid) is visibly open.",
  sit: "step_done when the view has lowered to seated height directly in front of or on the target seat.",
};

export function stepVisionPrompt(step: QuestStep): string {
  const dest = step.destination ? ` Destination: "${step.destination}".` : "";
  return [
    `Current step: ${step.action} — target: "${step.target}".${dest}`,
    `Success criteria: ${step.success}`,
    DONE_RULES[step.action],
    "Be strict: if unsure, step_done is false and confidence is low.",
    "distance describes how far the target (or the destination, if the player is already holding the target) is from the camera: " +
      "far = more than two steps away, near = one or two steps, within_reach = arm's length, touching = hand on it.",
    "instruction: at most 10 words, second person, a single concrete direction for the player's next move " +
      '(e.g. "Turn slightly left.", "Reach forward and a bit lower.", "Lift it up."). Never mention the camera, image, or frame.',
    'hazard: a few words if something unsafe is near the path (sharp, hot, fragile, trip hazard), otherwise "".',
  ].join("\n");
}

export const SCAN_PROMPT = [
  "List up to 15 distinct physical objects useful for everyday tasks: things that can be picked up, containers (trash can, bag, box, drawer), furniture, doors, switches, and buttons.",
  "Use short common names a player would say aloud.",
  'note: a few words on where it is relative to other things ("on the desk, left of the laptop").',
  "hazards: anything sharp, hot, fragile, or a trip risk. Empty array if none.",
].join("\n");

const boxSchema = { type: "array", items: { type: "integer" }, maxItems: 4 } as const;

export const OBSERVATION_SCHEMA = {
  type: "object",
  properties: {
    target_visible: { type: "boolean" },
    target_box: boxSchema,
    hand_visible: { type: "boolean" },
    hand_box: boxSchema,
    destination_visible: { type: "boolean" },
    destination_box: boxSchema,
    holding_target: { type: "boolean" },
    distance: { type: "string", enum: ["far", "near", "within_reach", "touching"] },
    step_done: { type: "boolean" },
    confidence: { type: "number" },
    instruction: { type: "string" },
    hazard: { type: "string" },
  },
  required: [
    "target_visible",
    "target_box",
    "hand_visible",
    "hand_box",
    "destination_visible",
    "destination_box",
    "holding_target",
    "distance",
    "step_done",
    "confidence",
    "instruction",
    "hazard",
  ],
  additionalProperties: false,
} as const;

export const SCENE_SCHEMA = {
  type: "object",
  properties: {
    objects: {
      type: "array",
      maxItems: 15,
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          box_2d: boxSchema,
          note: { type: "string" },
        },
        required: ["label", "box_2d", "note"],
        additionalProperties: false,
      },
    },
    hazards: { type: "array", items: { type: "string" } },
  },
  required: ["objects", "hazards"],
  additionalProperties: false,
} as const;

// ---------- Planning, narration, hints (Muse Spark) ----------

export const QUEST_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    type: { type: "string", enum: ["side", "boss"] },
    intro: { type: "string" },
    steps: {
      type: "array",
      minItems: 1,
      maxItems: 6,
      items: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["find", "grab", "drop", "place", "press", "open", "sit"] },
          target: { type: "string" },
          destination: { type: "string" },
          instruction: { type: "string" },
          success: { type: "string" },
        },
        required: ["action", "target", "destination", "instruction", "success"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "type", "intro", "steps"],
  additionalProperties: false,
} as const;

export function planPrompt(goal: string, scene: Scene): string {
  const objects = scene.objects.map((o) => `- ${o.label} (${o.note})`).join("\n") || "- (nothing detected)";
  return [
    `The player said: "${goal}"`,
    "Objects currently visible:",
    objects,
    scene.hazards.length ? `Hazards: ${scene.hazards.join("; ")}` : "Hazards: none",
    "",
    "Design a quest that accomplishes the goal using only the objects listed (a destination the player names is allowed even if not visible).",
    "Rules:",
    "- 2 to 6 steps. Use type boss for 4 or more steps, otherwise side.",
    "- Pair manipulation steps: grab X, then drop or place X into the destination. Each grab or drop step includes finding the thing, so do not add separate find steps before them.",
    "- Use find only to locate something without touching it. Use press, open, sit when the goal calls for them.",
    "- Skip anything unsafe: knives, scissors, glass, hot items, stoves, outlets.",
    "- target and destination are short common names matching the object list. destination is an empty string unless the action is drop or place.",
    "- instruction: one spoken line in your narrator voice, at most 18 words, telling the player what to do and roughly where it is.",
    "- success: a precise visual check a camera could verify.",
    "- title: a playful quest name, at most 6 words. intro: one spoken line, at most 25 words, kicking off the quest.",
  ].join("\n");
}

export function narrationPrompt(event: string, details: string): string {
  return `${event}\n${details}\nRespond with one spoken line, at most 30 words.`;
}

export function hintPrompt(step: QuestStep, recent: StepObservation[]): string {
  const history = recent
    .map(
      (o, i) =>
        `${i + 1}. target ${o.targetVisible ? "visible" : "not visible"}, hand ${o.handVisible ? "visible" : "not visible"}, ` +
        `distance ${o.distance}, holding ${o.holdingTarget}, vision said: "${o.instruction}"`,
    )
    .join("\n");
  return [
    `The player is stuck on this step: ${step.action} the ${step.target}${step.destination ? ` into the ${step.destination}` : ""}.`,
    "Recent camera observations, oldest first:",
    history || "(none)",
    "Give one encouraging, specific hint, at most 22 words, with a concrete physical direction. Do not repeat the vision instruction word for word.",
  ].join("\n");
}

export function describePrompt(scene: Scene): string {
  const objects = scene.objects.map((o) => `- ${o.label}: ${o.note}`).join("\n") || "- nothing clear";
  return [
    "The player asked what is in front of them. Here is what the camera sees:",
    objects,
    scene.hazards.length ? `Hazards: ${scene.hazards.join("; ")}` : "",
    "Describe the scene in at most 40 spoken words, nearest and most useful things first, using left, right, ahead, and rough distances. Mention hazards first if any.",
  ].join("\n");
}
