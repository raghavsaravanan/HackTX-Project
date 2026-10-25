import type { MapLandmark, MissionState, Quest, QuestStep, Scene, StepObservation, VisionCheck } from "../shared/types.ts";
import { config } from "./config.ts";

export const NARRATOR = {
  name: config.agent.name,
  persona:
    `You are ${config.agent.name}, a calm, friendly companion sitting next to the player. ` +
    "You help with everyday tasks through short spoken lines: one or two sentences, conversational English with contractions. " +
    "Never use exclamation marks, fantasy words, or hype. Let the player lead; you respond and gently suggest the next move. " +
    "The player cannot see: never rely on color or visual-only details; describe direction, distance, shape, and touch. " +
    "No emojis, no markdown, no lists.",
};

/** System prompt for every Quest Agent call (planning, narration, hints, answering questions). */
export const QUEST_AGENT_SYSTEM =
  NARRATOR.persona +
  " You are also the Quest Agent: you plan quests, guide the player step by step, answer their questions, " +
  "and work with a separate Vision Agent that looks through the player's phone camera. " +
  "You never see the camera yourself; trust only what the Vision Agent reports and never invent what is in the room.";

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
  "Survey the surroundings in this frame.",
  "setting: one sentence describing the place itself: what kind of room or area it is, the main furniture and surfaces, how tidy it is, and any open floor, doors, or walkways.",
  "objects: up to 15 distinct physical things you can actually see that matter for everyday tasks: items that can be picked up, containers, furniture, doors, switches, buttons, and clutter.",
  "Use short common names a player would say aloud. Only list what is visible; never assume typical objects.",
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
    setting: { type: "string" },
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
  required: ["setting", "objects", "hazards"],
  additionalProperties: false,
} as const;

// ---------- Vision Agent checks (PASS / FAIL / UNCERTAIN) ----------

export const VERIFY_SYSTEM =
  "You are the Vision Agent, a careful inspector looking through a phone camera held by a blind player. " +
  "You answer one yes/no question about the scene using only what is visible in this single frame. " +
  "Never guess about anything out of frame, hidden, or too blurry or dark to make out.";

export function verifyPrompt(question: string, context = ""): string {
  return [
    `Question: ${question}`,
    context && `Context: ${context}`,
    "verdict answers the question exactly as worded:",
    "- PASS: the frame clearly shows the answer is yes.",
    "- FAIL: the frame clearly shows the answer is no.",
    "- UNCERTAIN: you cannot tell from this frame (out of frame, blocked, blurry, too dark, too far).",
    "confidence: 0 to 1, how sure you are of the verdict.",
    'evidence: 1 to 4 short, concrete observations of visible things with where they are, e.g. "bottle on the desk, left of the laptop". ' +
      "For FAIL, say what is wrong. For UNCERTAIN, say what is missing from view.",
    "summary: one plain spoken sentence, at most 15 words, for a blind player. Never mention the camera, image, or frame.",
  ]
    .filter(Boolean)
    .join("\n");
}

export const VERIFY_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["PASS", "FAIL", "UNCERTAIN"] },
    confidence: { type: "number" },
    evidence: { type: "array", items: { type: "string" }, maxItems: 4 },
    summary: { type: "string" },
  },
  required: ["verdict", "confidence", "evidence", "summary"],
  additionalProperties: false,
} as const;

// ---------- Planning, narration, hints (Quest Agent) ----------

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
          check: { type: "string" },
        },
        required: ["action", "target", "destination", "instruction", "success", "check"],
        additionalProperties: false,
      },
    },
    goal_check: { type: "string" },
  },
  required: ["title", "type", "intro", "steps", "goal_check"],
  additionalProperties: false,
} as const;

export function planPrompt(goal: string, scene: Scene): string {
  const objects = scene.objects.map((o) => `- ${o.label} (${o.note})`).join("\n") || "- (nothing detected)";
  return [
    `The player said: "${goal}"`,
    `Surroundings: ${scene.setting || "unknown"}`,
    "Objects currently visible:",
    objects,
    scene.hazards.length ? `Hazards: ${scene.hazards.join("; ")}` : "Hazards: none",
    "",
    "Design a quest that accomplishes the goal using only the objects listed. Every target and destination must be one of those objects, " +
      "unless the player named it in what they said. Never invent furniture or containers (drawers, shelves, bins) that are not listed.",
    "Rules:",
    "- 2 to 6 steps. Use type boss for 4 or more steps, otherwise side.",
    "- Pair manipulation steps: grab X, then drop or place X into the destination. Each grab or drop step includes finding the thing, so do not add separate find steps before them.",
    "- Use find only to locate something without touching it. Use press, open, sit when the goal calls for them.",
    "- Skip anything unsafe: knives, scissors, glass, hot items, stoves, outlets.",
    "- target and destination are short common names matching the object list. destination is an empty string unless the action is drop or place.",
    "- instruction: one spoken line in your narrator voice, at most 18 words, telling the player what to do and roughly where it is.",
    "- success: a precise visual check a camera could verify.",
    '- check: the same check as a yes/no question for the Vision Agent where "yes" means done, e.g. "Is a hand holding the water bottle?"',
    '- goal_check: one yes/no question confirming the whole goal from a single photo, where "yes" means done, e.g. "Is the desk clear of clutter?"',
    "- title: a playful quest name, at most 6 words. intro: one spoken line, at most 25 words, kicking off the quest.",
  ].join("\n");
}

// ---------- Quest Agent turns (questions, verdict reactions) ----------

export const AGENT_TURN_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    vision_question: { type: "string" },
    complete_current_mission: { type: "boolean" },
    mission_note: { type: "string" },
    player_near: { type: "string" },
    map_notes: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        properties: { label: { type: "string" }, note: { type: "string" } },
        required: ["label", "note"],
        additionalProperties: false,
      },
    },
  },
  required: ["reply", "vision_question", "complete_current_mission", "mission_note", "player_near", "map_notes"],
  additionalProperties: false,
} as const;

export interface AgentState {
  quest: Quest | null;
  stepIndex: number;
  missions: MissionState[];
  setting: string;
  landmarks: MapLandmark[];
  recent: StepObservation[];
}

function describeState({ quest, stepIndex, missions, setting, landmarks, recent }: AgentState): string {
  const surroundings = [
    `Surroundings (from the Vision Agent's latest survey): ${setting || "not surveyed yet"}`,
    `Map landmarks: ${landmarks.map((l) => `${l.label}${l.note ? ` (${l.note})` : ""}`).join(", ") || "none"}`,
  ];
  if (!quest) return ["No quest is active.", ...surroundings].join("\n");
  const lines = quest.steps.map((step, i) => {
    const m = missions[i];
    const check = m?.lastCheck ? ` last check ${m.lastCheck.verdict}: ${m.lastCheck.evidence.join("; ")}` : "";
    const marker = i === stepIndex ? " <- CURRENT" : "";
    return `- [${step.id}] ${m?.status ?? "locked"}: ${step.action} ${step.target}${step.destination ? ` -> ${step.destination}` : ""}. ` +
      `Check: "${step.check}".${check}${m?.note ? ` Note: ${m.note}` : ""}${marker}`;
  });
  const last = recent.at(-1);
  return [
    `Quest: "${quest.title}". Goal check: "${quest.goalCheck}"`,
    "Missions:",
    ...lines,
    ...surroundings,
    last
      ? `Latest frame-loop read: target ${last.targetVisible ? "visible" : "not visible"}, distance ${last.distance}, holding ${last.holdingTarget}, "${last.instruction}"`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const TURN_RULES = [
  "Fields:",
  "- reply: what you say aloud next, at most 35 words, in your narrator voice, ending with one concrete next action when a quest is active.",
  "- mission_note: a few words to record on the current mission (empty string for none).",
  '- player_near: the map landmark the player is now at or holding, using its exact label, or "".',
  "- map_notes: notes to pin on landmarks the player told you about or the Vision Agent reported, e.g. {label: \"trash can\", note: \"by the door\"}. Use [] for none.",
].join("\n");

/** First pass over something the player said. The agent may ask the Vision Agent one question. */
export function agentAskPrompt(state: AgentState, utterance: string): string {
  return [
    describeState(state),
    "",
    `The player said: "${utterance}"`,
    "",
    "If answering needs a look through the camera (anything about what is where, whether something is done, clean, open, or present), " +
      "set vision_question to one yes/no question for the Vision Agent. Keep the player's meaning and scope: " +
      'if they ask about the whole room ("Is the room clean?"), ask about everything visible, not one part of it. ' +
      'Word it so "yes" is the outcome the player hopes for ("Is the visible room clean and tidy?"), never as its opposite or a negation. ' +
      "When the player says they are done or asks to check, use the current mission's check question exactly. " +
      'Otherwise set vision_question to "" and answer directly from the state above.',
    "Always set complete_current_mission to false in this pass; only a PASS from the Vision Agent can complete a mission.",
    TURN_RULES,
  ].join("\n");
}

/** Second pass: react to the Vision Agent's verdict. */
export function agentVerdictPrompt(state: AgentState, trigger: string, check: VisionCheck): string {
  return [
    describeState(state),
    "",
    trigger,
    `Vision Agent answered "${check.question}": ${check.verdict} (confidence ${check.confidence.toFixed(2)}).`,
    `Evidence: ${check.evidence.join("; ") || "none"}`,
    "",
    "Adapt your guidance to the verdict:",
    "- PASS on the current mission's check: celebrate briefly; set complete_current_mission to true.",
    "- FAIL: say what is still wrong using the evidence, then give one physical correction. complete_current_mission false.",
    "- UNCERTAIN: tell the player how to help you see (hold the phone steady at chest height, turn toward the object, step back). complete_current_mission false.",
    "- PASS on a question that is not the current mission's check: answer it; complete_current_mission false.",
    'Set vision_question to "".',
    TURN_RULES,
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
    `Surroundings: ${scene.setting || "unknown"}`,
    objects,
    scene.hazards.length ? `Hazards: ${scene.hazards.join("; ")}` : "",
    "Describe the scene in at most 40 spoken words, nearest and most useful things first, using left, right, ahead, and rough distances. Mention hazards first if any.",
  ].join("\n");
}
