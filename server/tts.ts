import { config } from "./config.ts";
import { elevenLabsSpeak } from "./providers/elevenlabs.ts";
import { uid } from "./util.ts";

const lines = new Map<string, string>();
const audioCache = new Map<string, Buffer>();

const MAX_LINES = 100;
const MAX_CACHE = 50;

/** Register spoken text so only server-issued line ids can be synthesized. */
export function registerSpeakLine(text: string): string {
  const id = uid("ln");
  lines.set(id, text);
  while (lines.size > MAX_LINES) {
    const oldest = lines.keys().next().value;
    if (oldest) lines.delete(oldest);
    else break;
  }
  return id;
}

export function speakLineText(id: string): string | undefined {
  return lines.get(id);
}

export async function speakLineAudio(id: string): Promise<Buffer | null> {
  const cached = audioCache.get(id);
  if (cached) return cached;
  const text = lines.get(id);
  if (!text || !config.elevenlabs.apiKey) return null;
  const audio = await elevenLabsSpeak(text);
  audioCache.set(id, audio);
  while (audioCache.size > MAX_CACHE) {
    const oldest = audioCache.keys().next().value;
    if (oldest) audioCache.delete(oldest);
    else break;
  }
  return audio;
}

export const cloudVoiceEnabled = () => config.elevenlabs.apiKey.length > 0;
