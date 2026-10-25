import { config } from "./config.ts";

const GREETING = "(?:hi|hey|hello|hiya|okay|ok|high|hecho)";
/** Spellings speech-to-text produces for agent names. */
const SOUND_ALIKES: Record<string, string[]> = {
  echo: ["eko", "ekko", "ecco", "eco", "hecho"],
  lumi: ["enemy", "lumie", "lumy", "lumee", "loomi", "loomie", "loomy", "lummy", "lumia", "lu me", "lou me", "loo me", "lew me"],
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function wakePattern(): RegExp {
  const name = config.agent.name.toLowerCase();
  const names = `(?:${[name, "agent", ...(SOUND_ALIKES[name] ?? [])].map(escape).join("|")})`;
  return new RegExp(`(?:\\b${GREETING}[\\s,.!]+${names}\\b|^\\s*${names}\\b)[\\s,.!?]*`, "i");
}

export const wakePhrase = () => `Hi ${config.agent.name}`;

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const next = Math.min(row[j] + 1, prev + 1, row[j - 1] + cost);
      row[j - 1] = prev;
      prev = next;
    }
    row[b.length] = prev;
  }
  return row[b.length];
}

function matchesAgentName(word: string): boolean {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return false;
  const name = config.agent.name.toLowerCase();
  if (w === name || w === "agent") return true;
  if ((SOUND_ALIKES[name] ?? []).includes(w)) return true;
  if (w.length >= 3 && editDistance(w, name) <= 1) return true;
  return false;
}

function matchesGreeting(word: string): boolean {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  return /^(hi|hey|hello|hiya|ok|okay|high|hecho|hiya)$/.test(w);
}

/** Fuzzy fallback when the strict regex misses a noisy transcript ("high echo", "hi eco"). */
function fuzzyWake(transcript: string): { woke: boolean; rest: string } | null {
  const words = transcript.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  if (words.length === 1 && matchesAgentName(words[0])) return { woke: true, rest: "" };
  // Greeting and name run together ("Hilumi", "Heylumi").
  const fused = /^(hi|hey)(.{3,})$/i.exec(words[0].replace(/[^a-z]/gi, ""));
  if (fused && matchesAgentName(fused[2])) return { woke: true, rest: words.slice(1).join(" ").trim() };
  if (words.length >= 2 && matchesGreeting(words[0]) && matchesAgentName(words[1])) {
    return { woke: true, rest: words.slice(2).join(" ").trim() };
  }
  return null;
}

/** Finds "hi Lumi" anywhere (or "Lumi," at the start) and returns what was said after it. */
export function matchWake(transcript: string): { woke: boolean; rest: string } {
  const m = wakePattern().exec(transcript);
  if (m) return { woke: true, rest: transcript.slice(m.index + m[0].length).trim() };
  const fuzzy = fuzzyWake(transcript);
  if (fuzzy) return fuzzy;
  return { woke: false, rest: transcript.trim() };
}

/** Words for the transcriber to listen for so the wake phrase survives noisy rooms. */
export const wakeKeywords = () => [config.agent.name, "hi", "hey", "agent"];
