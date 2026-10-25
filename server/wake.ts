import { config } from "./config.ts";

const GREETING = "(?:hi|hey|hello|hiya|okay|ok)";
/** Spellings speech-to-text produces for the default name. */
const SOUND_ALIKES: Record<string, string[]> = { echo: ["eko", "ekko", "ecco", "eco"] };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function wakePattern(): RegExp {
  const name = config.agent.name.toLowerCase();
  const names = `(?:${[name, "agent", ...(SOUND_ALIKES[name] ?? [])].map(escape).join("|")})`;
  return new RegExp(`(?:\\b${GREETING}[\\s,.!]+${names}\\b|^\\s*${names}\\b)[\\s,.!?]*`, "i");
}

export const wakePhrase = () => `Hi ${config.agent.name}`;

/** Finds "hi Echo" anywhere (or "Echo," at the start) and returns what was said after it. */
export function matchWake(transcript: string): { woke: boolean; rest: string } {
  const m = wakePattern().exec(transcript);
  if (!m) return { woke: false, rest: transcript.trim() };
  return { woke: true, rest: transcript.slice(m.index + m[0].length).trim() };
}

/** Words for the transcriber to listen for so the wake phrase survives noisy rooms. */
export const wakeKeywords = () => [config.agent.name, "hi", "hey"];
