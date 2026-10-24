# Sidequest — HackTX 2026

Everyday tasks become voice-guided quests for blind players. Gemini sees, Muse thinks, you conquer.

## Run it

```bash
npm install
cp .env.example .env   # add MODEL_API_KEY (Meta) and GEMINI_API_KEY; blank keys fall back to mock mode
npm run dev            # API on :8787, web on https://localhost:5173
```

- **Stage (projector):** `https://localhost:5173/stage?session=demo`
- **Console (phone / test harness):** `https://<laptop-LAN-IP>:5173/console?session=demo`. Accept the self-signed cert on the phone; HTTPS is required for camera and mic.
- Laptop-only (no phone): `HTTP=1 npm run dev` serves plain HTTP.
- Without any keys, everything runs on scripted mock vision so you can rehearse the full demo.

## Models

| Job | Model | Where |
| --- | --- | --- |
| Voice commands | Muse Voice Transcribe (`/v1/asr/transcribe`, 16 kHz WAV) | `server/providers/muse.ts` |
| Quest planning, narration, hints | Muse Spark (`muse-spark-1.3`, JSON-schema output) | `server/brain.ts`, `server/prompts.ts` |
| Per-frame vision + scene scan | Gemini (`GEMINI_MODEL`, default `gemini-4-argon`) | `server/vision.ts`, `server/providers/gemini.ts` |
| Vision fallback | Muse Spark with images, used automatically if Gemini fails | `server/vision.ts` |
| Narrator voice | Browser `speechSynthesis` | `web/src/lib/speech.ts` |

## Contract for the phone app

All types live in `shared/types.ts`. The loop:

1. `POST /api/quest/start` with `{ sessionId, presetId }` or `{ sessionId, goal, image }`.
2. Every ~600 ms, `POST /api/frame` with `{ sessionId, seq, image }` (512px JPEG data URL). Up to 2 requests in flight; ignore responses older than the newest one. `FrameLoop` in `web/src/lib/camera.ts` does this.
3. Drive audio from `response.guidance`: `phase` (scan / aim / approach / reach / verify), `pan` (-1..1), `proximity` (0..1), `say` (throttle it). `GuidanceCues` in `web/src/lib/cues.ts` is a working reference.
4. Subscribe to `GET /api/session/:id/events?role=phone` (server-sent events). Speak every `say` event and play `sfx` on `reward` events.
5. Voice: record push-to-talk with `WavRecorder`, `POST /api/voice?sessionId=` (raw WAV body), then dispatch the returned `intent` (`start_quest` → step 1; anything else → `POST /api/command`).

The server owns quest progress, step completion, XP, combos, levels, hints, and narration, so the phone and stage always agree.

## Demo checklist

- Stage the desk with the preset objects: water bottle, trash can, book, backpack.
- Use the `desk` preset as the safety net if live planning misbehaves.
- Run the demo on a phone hotspot, not venue Wi-Fi.
- Click "Enable stage sound" on the projector so the audience hears rewards.
