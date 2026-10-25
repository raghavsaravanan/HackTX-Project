import { config } from "../config.ts";
import { withTimeout } from "../util.ts";

/** Stream MP3 from ElevenLabs. Returns raw bytes. */
export async function elevenLabsSpeak(text: string): Promise<Buffer> {
  const voice = config.elevenlabs.voiceId;
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/stream?output_format=mp3_44100_64`;
  const res = await withTimeout(
    fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": config.elevenlabs.apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: config.elevenlabs.model,
        voice_settings: { stability: 0.55, similarity_boost: 0.75, style: 0.15, use_speaker_boost: true, speed: 0.95 },
      }),
    }),
    15000,
    "ElevenLabs",
  );
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}
