import type { Quest, QuestStep, Scene, StepObservation, VoiceIntent } from "../shared/types.ts";
import { hasMuse } from "./config.ts";
import { PRESETS } from "./presets.ts";
import { NARRATOR, QUEST_SCHEMA, describePrompt, hintPrompt, narrationPrompt, planPrompt } from "./prompts.ts";
import { museChat, museJson } from "./providers/muse.ts";
import { uid } from "./util.ts";

const persona = { role: "developer" as const, content: NARRATOR.persona };

type PlannedQuest = Omit<Quest, "id" | "steps"> & { steps: Omit<QuestStep, "id">[] };

export async function planQuest(goal: string, scene: Scene): Promise<Quest> {
  if (!hasMuse()) return { id: uid("q"), ...PRESETS.desk };
  const planned = await museJson<PlannedQuest>({
    messages: [persona, { role: "user", content: planPrompt(goal, scene) }],
    schema: { name: "quest", schema: QUEST_SCHEMA },
    timeoutMs: 25000,
  });
  return {
    id: uid("q"),
    ...planned,
    steps: planned.steps.map((s, i) => ({ ...s, id: `s${i + 1}` })),
  };
}

/** One spoken narrator line. Falls back to `fallback` if Muse is unavailable or slow. */
export async function narrate(event: string, details: string, fallback: string): Promise<{ text: string; source: "muse" | "system" }> {
  if (!hasMuse()) return { text: fallback, source: "system" };
  try {
    const text = await museChat({
      messages: [persona, { role: "user", content: narrationPrompt(event, details) }],
      maxCompletionTokens: 2000,
      timeoutMs: 8000,
    });
    return { text, source: "muse" };
  } catch (err) {
    console.warn("[narrate]", (err as Error).message);
    return { text: fallback, source: "system" };
  }
}

export async function hint(step: QuestStep, recent: StepObservation[]): Promise<{ text: string; source: "muse" | "system" }> {
  const last = recent.at(-1);
  const fallback = last?.targetVisible
    ? `Steady, hero. ${last.instruction}`
    : `Take a slow breath and sweep the phone gently from left to right to find the ${step.destination && last?.holdingTarget ? step.destination : step.target}.`;
  if (!hasMuse()) return { text: fallback, source: "system" };
  try {
    const text = await museChat({
      messages: [persona, { role: "user", content: hintPrompt(step, recent) }],
      maxCompletionTokens: 2000,
      timeoutMs: 8000,
    });
    return { text, source: "muse" };
  } catch (err) {
    console.warn("[hint]", (err as Error).message);
    return { text: fallback, source: "system" };
  }
}

export async function describeScene(scene: Scene): Promise<{ text: string; source: "muse" | "system" }> {
  const fallback = scene.objects.length
    ? `I sense ${scene.objects.slice(0, 4).map((o) => `a ${o.label}, ${o.note}`).join("; ")}.`
    : "I cannot make out much. Try sweeping the phone slowly.";
  return narrate("DESCRIBE", describePrompt(scene), fallback);
}

const COMMANDS: [RegExp, VoiceIntent][] = [
  [/\b(repeat|say (that|it) again|what (was|did you say))\b/i, { type: "repeat" }],
  [/\b(skip|next step)\b/i, { type: "skip" }],
  [/\b(pause|hold on|wait)\b/i, { type: "pause" }],
  [/\b(resume|continue|keep going|unpause)\b/i, { type: "resume" }],
  [/\b(stop|quit|cancel|end quest)\b/i, { type: "stop" }],
  [/\b(what('?s| is) (in front|around|here)|describe|where am i|look around)\b/i, { type: "describe" }],
];

/** Commands are matched locally for speed; anything else is treated as a quest goal for Muse Spark to plan. */
export function parseIntent(transcript: string): VoiceIntent {
  const text = transcript.trim();
  if (!text) return { type: "unknown" };
  for (const [pattern, intent] of COMMANDS) if (pattern.test(text)) return intent;
  return { type: "start_quest", goal: text };
}
