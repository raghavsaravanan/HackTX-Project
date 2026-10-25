import type { MapLandmark, MissionState, Quest, QuestStep, SavedQuestSummary, Scene, StepObservation, VisionCheck } from "../shared/types.ts";
import { config } from "./config.ts";

/**
 * How to guide someone who is blind. Part of every Quest Agent prompt, so no plan, reply, hint, or
 * narration line ever assumes the player can see.
 */
export const BLIND_GUIDE = [
  "The player is blind. They cannot see anything, so every instruction must work by touch, hearing, smell, memory, and your voice alone.",
  "Never tell them to look, see, watch, spot, check visually, read a screen or label, or notice a color. Never say \"over there\" or \"this one\".",
  "Give directions from their body: left, right, ahead, behind, clock positions (\"at your two o'clock\"), arm's lengths, steps, and heights " +
    "(waist height, the table edge, knee level).",
  "Explain how to do the task, not just what to do: which hand to use, how to search by touch (rest one hand on a landmark like the table edge, " +
    "then sweep the other hand slowly in small overlapping strips, front to back), how to recognize the object by shape, size, weight, and texture, " +
    "and how to tell by touch or sound that the step is done.",
  "Keep them safe: move slowly with hands low and fingers relaxed, feel before grabbing, warn about anything hot, sharp, fragile, or wet, " +
    "and remind them to bend at the knees and protect their head near tables and shelves.",
  "Break a complex action into short spoken sub-steps in order (first, then, then). If a step needs reading or a screen, guide them to use VoiceOver or Siri, or to ask a sighted person.",
].join(" ");

export const NARRATOR = {
  name: config.agent.name,
  persona:
    `You are ${config.agent.name}, a calm, patient companion sitting next to a blind player. ` +
    "You help with everyday tasks by voice, in conversational English with contractions, clear enough to follow without seeing anything. " +
    "Never use exclamation marks, fantasy words, or hype. Let the player lead; you respond and gently suggest the next move. " +
    BLIND_GUIDE +
    " No emojis, no markdown, no bullet lists.",
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
  wipe: "step_done only when the target surface is visibly clear and clean (no crumbs, spills, or smudges) and a hand or cloth has just passed over it.",
  go: "step_done when the target place or object fills much of the view at close range (the player has arrived).",
  do: "step_done only when the success criteria are clearly met in this frame.",
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
    "instruction: at most 12 words, second person, a single physical direction for a blind player's next move, using body terms " +
      '(e.g. "Turn slightly left.", "Reach forward, a bit below waist height.", "Close your hand and lift."). ' +
      "Never mention the camera, image, frame, or anything they would have to see, like colors.",
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
    // First, so the model reasons about the room before committing to steps.
    analysis: { type: "string" },
    title: { type: "string" },
    type: { type: "string", enum: ["side", "boss"] },
    intro: { type: "string" },
    steps: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          reason: { type: "string" },
          summary: { type: "string" },
          action: { type: "string", enum: ["find", "grab", "drop", "place", "press", "open", "sit", "wipe", "go", "do"] },
          verify: { type: "string", enum: ["vision", "voice"] },
          target: { type: "string" },
          destination: { type: "string" },
          instruction: { type: "string" },
          success: { type: "string" },
          check: { type: "string" },
        },
        required: ["reason", "summary", "action", "verify", "target", "destination", "instruction", "success", "check"],
        additionalProperties: false,
      },
    },
    goal_check: { type: "string" },
  },
  required: ["analysis", "title", "type", "intro", "steps", "goal_check"],
  additionalProperties: false,
} as const;

/** Rough direction from where the player faces, from an object's box in the frame. */
function sideOf(box: { x0: number; x1: number }): string {
  const dx = (box.x0 + box.x1) / 2 - 0.5;
  return dx < -0.15 ? "to the player's left" : dx > 0.15 ? "to the player's right" : "straight ahead";
}

export function planPrompt(goal: string, scene: Scene | null, context = ""): string {
  const objects = scene?.objects.map((o) => `- ${o.label} (${sideOf(o.box)}; ${o.note})`).join("\n") || "- (nothing detected)";
  const surroundings = scene
    ? [
        `Surroundings (from the camera): ${scene.setting || "unknown"}`,
        "Objects currently visible:",
        objects,
        scene.hazards.length ? `Hazards: ${scene.hazards.join("; ")}` : "Hazards: none",
      ]
    : ["Surroundings: no camera view right now. Plan from the request alone; the player can confirm steps by voice."];
  return [
    `The player said: "${goal}"`,
    context && `Situation: ${context}`,
    ...surroundings,
    "",
    "The player may ask for anything: a physical chore, finding something, getting somewhere, a routine (getting ready, cooking), or a task with no objects at all. " +
      "Turn it into a quest of concrete missions they can do one at a time, guided only by your voice.",
    "Reason before you plan. In analysis (at most 90 words), work out:",
    "- what the player actually wants and what the situation looks like when it is truly done;",
    "- which visible objects matter and their role (trash, a belonging with a home, a tool, something that stays), and anything needed that is not visible;",
    "- the missions that requires, in an order that avoids backtracking, and which ones the camera can confirm.",
    "Then write steps that follow from your analysis. Do not use a template: the steps depend on this request and this situation.",
    "Rules:",
    "- 1 to 8 steps, only as many as the goal needs. Use type boss for 4 or more steps, otherwise side.",
    "- Never pretend an object is visible when it is not listed. If the goal needs something not listed, add a find step for it (or plan around it).",
    "- action: find (locate without touching), grab, drop or place (put the target into or onto the destination), press, open, sit, " +
      "wipe (clean a surface, after it is cleared), go (move to a place or object), or do (any other action; describe it in instruction).",
    "- Pair manipulation steps: grab X, then drop or place X. Each grab or drop step includes finding the thing, so no separate find step before them.",
    "- verify: vision when a single camera photo could confirm the step is done (the result is visible in front of the player); " +
      "voice when it cannot (the player's own body or knowledge, something out of view, waiting, information steps).",
    "- Skip anything unsafe: knives, scissors, glass, hot items, stoves, outlets. If the goal needs one, guide the player to ask a sighted person for that part.",
    "- target: the main object or place, short common name (matching the object list when visible). destination: empty unless action is drop or place.",
    "- summary: 2 to 6 natural spoken words with articles, e.g. \"find a trash bin\", \"throw the can away\", \"put on your shoes\".",
    "- reason: a few words on why this step serves the goal.",
    "- instruction: spoken in your narrator voice, 2 to 4 short sentences, at most 55 words, for a player who cannot see: where it is from their body " +
      "(left, right, clock position, arm's lengths) when known, how to find it and do it by touch (hand technique, what it feels like), " +
      "and how they'll know by touch or sound that the step is done. Include a safety note when relevant.",
    "- Each mission must be doable without sight. Searching steps say how to search by touch or sound (sweep in strips, retrace, make the phone ring).",
    "- Order steps so each one starts from where the previous one ended, and so the last step leaves the goal fully done.",
    "- success: what done looks like. check: the same as a yes/no question where \"yes\" means done (for voice steps, a question to ask the player).",
    '- goal_check: one yes/no question confirming the whole goal from a single photo, or "" if a photo cannot show it.',
    "- title: a short friendly quest name, at most 6 words. intro: one spoken line, at most 25 words, kicking off the quest.",
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------- Understanding what the player said ----------

export const INTERPRET_SCHEMA = {
  type: "object",
  properties: {
    addressed_to_agent: { type: "boolean" },
    kind: { type: "string", enum: ["new_goal", "return_to_saved", "question", "progress", "correction", "command", "chatter"] },
    goal: { type: "string" },
    command: { type: "string", enum: ["none", "repeat", "skip", "pause", "resume", "stop", "describe"] },
  },
  required: ["addressed_to_agent", "kind", "goal", "command"],
  additionalProperties: false,
} as const;

export function interpretPrompt(state: AgentState, utterance: string, wakeHeard: boolean, awake: boolean): string {
  const quest = state.quest;
  const step = quest?.steps[state.stepIndex];
  return [
    `You are ${NARRATOR.name}, a voice companion for a blind player. Their phone's speech recognition produced this transcript: "${utterance}"`,
    wakeHeard
      ? `It started with your name ("Hi ${NARRATOR.name}"), so it is addressed to you.`
      : awake
        ? "You just spoke with the player, so a follow-up is likely addressed to you."
        : `It did not clearly start with your name. Speech recognition often mangles "Hi ${NARRATOR.name}" (e.g. "Enemy", "Hi Lou me", "Me"), so judge by content.`,
    quest ? `Active quest: "${quest.title}". Current mission: ${step ? step.summary || `${step.action} ${step.target}` : "none"}.` : "No quest is active.",
    describeSaved(state.saved),
    "",
    "addressed_to_agent: true if this is the player talking to you (a request, question, answer, or update). " +
      "False for background speech, TV, fragments with no clear meaning (\"200\", \"in a\"), or talk to someone else.",
    "kind:",
    "- new_goal: they want help doing something new (\"help me clean my table\", \"I need to find my keys\", \"get me ready for class\"). " +
      "Their latest request always wins: if it differs from the active quest, it is a new_goal even mid-quest (the active quest is paused and saved).",
    "- return_to_saved: they want to go back to a paused quest (\"let's finish the table\", \"go back to what we were doing\").",
    "- question: they ask about the room, an object, the quest, or anything else.",
    "- progress: they report on the current mission (\"I did it\", \"done\", \"I can't find it\", \"got it\").",
    "- correction: they correct you or change the plan (\"that's not trash\", \"I don't have a cloth\", \"actually let's do the desk instead\").",
    "- command: one of the commands below.",
    "- chatter: not meant for you.",
    "goal: for new_goal, the request in the player's words, cleaned of the wake phrase and recognition errors. " +
      "For return_to_saved, the title of the paused quest they mean (\"\" for the most recent). Otherwise \"\".",
    "command: repeat (say that again), skip (skip this step), pause, resume, stop (end the quest), describe (what's around me); otherwise none.",
  ].join("\n");
}

// ---------- Quest Agent turns (questions, verdict reactions) ----------

export const AGENT_TURN_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    vision_question: { type: "string" },
    complete_current_mission: { type: "boolean" },
    skip_current_mission: { type: "boolean" },
    replan: { type: "string" },
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
  required: ["reply", "vision_question", "complete_current_mission", "skip_current_mission", "replan", "mission_note", "player_near", "map_notes"],
  additionalProperties: false,
} as const;

export interface AgentState {
  quest: Quest | null;
  stepIndex: number;
  missions: MissionState[];
  setting: string;
  landmarks: MapLandmark[];
  recent: StepObservation[];
  /** Quests paused for newer requests, most recent first. */
  saved: SavedQuestSummary[];
}

const describeSaved = (saved: SavedQuestSummary[]) =>
  saved.length
    ? `Paused quests (set aside for newer requests, most recent first): ${saved.map((q) => `"${q.title}" (${q.done} of ${q.total} done, next: ${q.next})`).join("; ")}.`
    : "";

function describeState({ quest, stepIndex, missions, setting, landmarks, recent, saved }: AgentState): string {
  const surroundings = [
    `Surroundings (from the Vision Agent's latest survey): ${setting || "not surveyed yet"}`,
    `Map landmarks: ${landmarks.map((l) => `${l.label}${l.note ? ` (${l.note})` : ""}`).join(", ") || "none"}`,
    describeSaved(saved),
  ].filter(Boolean);
  if (!quest) return ["No quest is active.", ...surroundings].join("\n");
  const lines = quest.steps.map((step, i) => {
    const m = missions[i];
    const check = m?.lastCheck ? ` last check ${m.lastCheck.verdict}: ${m.lastCheck.evidence.join("; ")}` : "";
    const marker = i === stepIndex ? " <- CURRENT" : "";
    return `- [${step.id}] ${m?.status ?? "locked"} (verify by ${step.verify ?? "vision"}): ${step.summary || `${step.action} ${step.target}`}${step.destination ? ` -> ${step.destination}` : ""}. ` +
      `${step.reason ? `Why: ${step.reason}. ` : ""}Check: "${step.check}".${check}${m?.note ? ` Note: ${m.note}` : ""}${marker}`;
  });
  const last = recent.at(-1);
  return [
    `Quest: "${quest.title}". Goal check: "${quest.goalCheck}"`,
    quest.analysis ? `Your plan's reasoning: ${quest.analysis}` : "",
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
  "Adapting the quest:",
  "- skip_current_mission: true only if the player asks to skip it or it is impossible (the thing is gone, they can't do it).",
  "- replan: if the player corrects you (\"that's not trash\", \"I don't have a cloth\", \"the bin is full\", \"actually, do X instead\") or conditions changed so " +
    "the remaining missions no longer fit, describe in one sentence what changed and what the player now wants. The remaining missions will be re-planned from it. Otherwise \"\".",
  "Fields:",
  "- reply: what you say aloud next, at most 60 words, in your narrator voice for a player who cannot see. When a quest is active, end with the next action " +
    "and how to do it by touch (where from their body, hand technique, how they'll know it's done). Never refer to anything only visible.",
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
      "When the player says they are done or asks to check a mission verified by vision, use the current mission's check question exactly. " +
      "A mission verified by voice needs no camera: take the player's word. " +
      'Otherwise set vision_question to "" and answer directly from the state above.',
    "complete_current_mission: for a mission verified by voice, true when the player says they did it. " +
      "For a mission verified by vision, always false in this pass: only a PASS from the Vision Agent can complete it.",
    "If no quest is active and the player asks for help with something, answer helpfully and practically for someone who cannot see.",
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
    "- FAIL: say what is still wrong in terms they can feel or locate (where it is from their body), then how to fix it by touch. complete_current_mission false.",
    "- UNCERTAIN: tell the player how to help you see, in physical terms (hold the phone flat against your chest, screen facing you, " +
      "then turn your whole body slowly toward your right; or take one small step back). complete_current_mission false.",
    "- PASS on a question that is not the current mission's check: answer it; complete_current_mission false.",
    'Set vision_question to "".',
    TURN_RULES,
  ].join("\n");
}

export function narrationPrompt(event: string, details: string): string {
  return (
    `${event}\n${details}\n` +
    "Respond with what you'd say aloud, at most 60 words. If you give an instruction, keep its touch-based detail " +
    "(where from their body, hand technique, how they'll know it's done); the player cannot see."
  );
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
    "Give one encouraging, specific hint for a player who cannot see, at most 40 words: where to move from their body, " +
      "and how to search or grip by touch (for example, rest your left hand on the table edge and sweep your right hand in slow strips). " +
      "Do not repeat the vision instruction word for word.",
  ].join("\n");
}

export function describePrompt(scene: Scene): string {
  const objects = scene.objects.map((o) => `- ${o.label}: ${o.note}`).join("\n") || "- nothing clear";
  return [
    "The player asked what is in front of them. Here is what the camera sees:",
    `Surroundings: ${scene.setting || "unknown"}`,
    objects,
    scene.hazards.length ? `Hazards: ${scene.hazards.join("; ")}` : "",
    "Describe the scene for someone who cannot see, in at most 60 spoken words: hazards first, then the nearest and most useful things, " +
      "each with where it is from their body (left, right, clock position, arm's lengths, height) and what it would feel like. No colors.",
  ].join("\n");
}
