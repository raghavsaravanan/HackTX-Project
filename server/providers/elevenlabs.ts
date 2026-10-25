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

/** ElevenLabs Scribe, single-shot upload. `keyterms` biases recognition toward the wake phrase and quest objects. */
export async function elevenLabsTranscribe(wav: Buffer, keyterms: string[] = []): Promise<string> {
  const form = new FormData();
  form.append("model_id", config.elevenlabs.sttModel);
  form.append("language_code", "en");
  form.append("tag_audio_events", "false");
  for (const term of keyterms) form.append("keyterms", term);
  form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "speech.wav");
  const res = await withTimeout(
    fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": config.elevenlabs.apiKey, Accept: "application/json" },
      body: form,
    }),
    8000,
    "ElevenLabs Scribe",
  );
  if (!res.ok) throw new Error(`ElevenLabs Scribe ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { text?: string };
  return (json.text ?? "").trim();
}
