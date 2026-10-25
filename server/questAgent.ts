// The Quest Agent: plans quests, narrates, hints, answers the player, and decides what to
// ask the Vision Agent. Gemini first, Muse Spark as fallback, templates with no keys.
import type { LineSource, Quest, QuestStep, Scene, StepObservation, VisionCheck, VoiceIntent } from "../shared/types.ts";
import { questMode, redact } from "./config.ts";
import { agentJson, agentText } from "./llm.ts";
import { PRESETS } from "./presets.ts";
import {
  AGENT_TURN_SCHEMA,
  QUEST_AGENT_SYSTEM,
  QUEST_SCHEMA,
  agentAskPrompt,
  agentVerdictPrompt,
  describePrompt,
  hintPrompt,
  narrationPrompt,
  planPrompt,
  type AgentState,
} from "./prompts.ts";
import { uid } from "./util.ts";

export type { AgentState } from "./prompts.ts";

interface Line {
  text: string;
  source: LineSource;
}

type PlannedQuest = Omit<Quest, "id" | "steps" | "goalCheck"> & { goal_check: string; steps: Omit<QuestStep, "id">[] };

export async function planQuest(goal: string, scene: Scene): Promise<Quest> {
  if (questMode() === "mock") return { id: uid("q"), ...structuredClone(PRESETS.desk) };
  const { value: planned } = await agentJson<PlannedQuest>({
    system: QUEST_AGENT_SYSTEM,
    prompt: planPrompt(goal, scene),
    schema: QUEST_SCHEMA,
    name: "quest",
    timeoutMs: 25000,
  });
  const { goal_check, ...rest } = planned;
  return {
    id: uid("q"),
    ...rest,
    goalCheck: goal_check || `Is this done: ${goal}?`,
    steps: planned.steps.map((s, i) => ({ ...s, id: `s${i + 1}`, check: s.check || `Is it true that ${s.success}` })),
  };
}

async function speak(label: string, prompt: string, fallback: string): Promise<Line> {
  if (questMode() === "mock") return { text: fallback, source: "system" };
  try {
    const { value, source } = await agentText({ system: QUEST_AGENT_SYSTEM, prompt });
    return { text: value, source };
  } catch (err) {
    console.warn(`[${label}]`, redact((err as Error).message).slice(0, 160));
    return { text: fallback, source: "system" };
  }
}

/** One spoken narrator line. Falls back to `fallback` if no model is available or it is slow. */
export function narrate(event: string, details: string, fallback: string): Promise<Line> {
  return speak("narrate", narrationPrompt(event, details), fallback);
}

export function hint(step: QuestStep, recent: StepObservation[]): Promise<Line> {
  const last = recent.at(-1);
  const fallback = last?.targetVisible
    ? `Take your time. ${last.instruction}`
    : `Take a slow breath and sweep the phone gently from left to right to find the ${step.destination && last?.holdingTarget ? step.destination : step.target}.`;
  return speak("hint", hintPrompt(step, recent), fallback);
}

export function describeScene(scene: Scene): Promise<Line> {
  const fallback = scene.objects.length
    ? `I sense ${scene.objects.slice(0, 4).map((o) => `a ${o.label}, ${o.note}`).join("; ")}.`
    : "I cannot make out much. Try sweeping the phone slowly.";
  return narrate("DESCRIBE", describePrompt(scene), fallback);
}

// ---------- Conversation turns ----------

export interface AgentTurn {
  reply: string;
  visionQuestion: string;
  completeCurrent: boolean;
  missionNote: string;
  playerNear: string;
  mapNotes: { label: string; note: string }[];
  source: LineSource;
}

interface RawTurn {
  reply: string;
  vision_question: string;
  complete_current_mission: boolean;
  mission_note: string;
  player_near: string;
  map_notes: { label: string; note: string }[];
}

async function turn(prompt: string, fallback: () => Omit<AgentTurn, "source">): Promise<AgentTurn> {
  if (questMode() === "mock") return { ...fallback(), source: "system" };
  try {
    const { value: raw, source } = await agentJson<RawTurn>({
      system: QUEST_AGENT_SYSTEM,
      prompt,
      schema: AGENT_TURN_SCHEMA,
      name: "agent_turn",
      timeoutMs: 12000,
    });
    return {
      reply: raw.reply?.trim() ?? "",
      visionQuestion: raw.vision_question?.trim() ?? "",
      completeCurrent: raw.complete_current_mission === true,
      missionNote: raw.mission_note?.trim() ?? "",
      playerNear: raw.player_near?.trim() ?? "",
      mapNotes: Array.isArray(raw.map_notes) ? raw.map_notes.slice(0, 4) : [],
      source,
    };
  } catch (err) {
    console.warn("[quest-agent]", redact((err as Error).message).slice(0, 160));
    return { ...fallback(), source: "system" };
  }
}

const noActions = { visionQuestion: "", completeCurrent: false, missionNote: "", playerNear: "", mapNotes: [] };
const DONE_PATTERN = /\b(done|finished|did it|check|verify)\b/i;

/** First pass over something the player said: answer directly, or name one question for the Vision Agent. */
export function askAgent(state: AgentState, utterance: string): Promise<AgentTurn> {
  const step = state.quest?.steps[state.stepIndex];
  return turn(agentAskPrompt(state, utterance), () => ({
    ...noActions,
    reply: "",
    visionQuestion: step && DONE_PATTERN.test(utterance) ? step.check : utterance,
  }));
}

/** Fallback verdict reaction when no model is reachable. */
function templateReaction(step: QuestStep | undefined, check: VisionCheck): Omit<AgentTurn, "source"> {
  const evidence = check.evidence[0] ? `${check.evidence[0]}. ` : "";
  if (check.verdict === "PASS") return { ...noActions, completeCurrent: step?.check === check.question, reply: check.summary || "Yes, it is done." };
  if (check.verdict === "FAIL") {
    return { ...noActions, missionNote: check.evidence[0] ?? "", reply: `Not quite. ${evidence}${step ? step.instruction : check.summary}` };
  }
  return { ...noActions, reply: `I cannot tell yet. ${evidence}Hold the phone steady at chest height and point it at the ${step?.destination || step?.target || "area"}.` };
}

/** React to a Vision Agent verdict with adapted guidance and status updates. */
export function reactToVerdict(state: AgentState, trigger: string, check: VisionCheck): Promise<AgentTurn> {
  return turn(agentVerdictPrompt(state, trigger, check), () => templateReaction(state.quest?.steps[state.stepIndex], check));
}

// ---------- Voice intents ----------

const COMMANDS: [RegExp, VoiceIntent][] = [
  [/\b(repeat|say (that|it) again|what (was|did you say))\b/i, { type: "repeat" }],
  [/\b(skip|next step)\b/i, { type: "skip" }],
  [/\b(pause|hold on|wait)\b/i, { type: "pause" }],
  [/\b(resume|continue|keep going|unpause)\b/i, { type: "resume" }],
  [/\b(stop|quit|cancel|end quest)\b/i, { type: "stop" }],
  [/\b(what('?s| is) (in front|around|here)|describe|where am i|look around)\b/i, { type: "describe" }],
];

const QUESTION = /^(is|are|am|was|were|do|does|did|can|could|should|have|has|where|what|which|how|why|who)\b|\?\s*$/i;
const CHECK_REQUEST = /\b(i'?m done|i am done|i'?m finished|i did it|did i do it|check (it|this|my work|now)|verify)\b/i;
const GOAL = /\b(help me|i want to|i need to|let'?s|new quest|give me a quest)\b/i;

/** Commands are matched locally for speed; questions go to the Quest Agent; anything else is a new quest goal. */
export function parseIntent(transcript: string): VoiceIntent {
  const text = transcript.trim();
  if (!text) return { type: "unknown" };
  for (const [pattern, intent] of COMMANDS) if (pattern.test(text)) return intent;
  if (CHECK_REQUEST.test(text) || (QUESTION.test(text) && !GOAL.test(text))) return { type: "ask", text };
  return { type: "start_quest", goal: text };
}
