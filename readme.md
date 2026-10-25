# Sidequest — HackTX 2026

Everyday tasks become voice-guided quests for blind players. The phone is a hands-free controller: point its camera at the room and say “Hi Echo, help me tidy my desk.” Muse hears, Gemini sees and guides, you conquer.

## Quick start

```bash
cp .env.example .env            # one file configures both apps; blank keys fall back to mock mode
npm install
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

npm run dev                     # game API on 127.0.0.1:8787 + laptop hub on http://localhost:5173
.venv/bin/python run.py         # camera server: phone on https://<lan-ip>:8443, laptop side on 127.0.0.1:8000
```

Open **`http://localhost:5173`** on the laptop, which is the only laptop link. Scan the QR code on its Connect phone tab with the phone, on the same Wi-Fi, and accept the certificate warning once. Without any API keys, everything runs on scripted mock vision so you can rehearse the demo.

## The journey

The agent is called **Echo** (`AGENT_NAME`).

1. Start both apps and open the hub on the laptop.
2. Scan the QR code on the Connect phone tab.
3. Tap **Start** on the phone. This is the only tap: it turns on the camera and microphone and keeps the screen awake. The hub switches to the Quest tab when frames arrive.
4. Say **“Hi Echo, help me tidy my desk.”** The Vision Agent surveys the room, and the Quest Agent builds a quest from what it actually sees and speaks the first step. “Hi Echo” on its own gets a chime and a “Yes?”.
5. Follow the voice. Beeps speed up and pan toward the target. Say “I'm done” after a step, or ask “is the room clean?” or “where are my headphones?”.
6. For 20 seconds after the wake phrase or a reply (`AWAKE_MS`), follow-ups need no wake phrase. Starting a new quest always needs it, so nearby chatter can't replace the quest.

The phone also has a type box for loud rooms; typed text needs no wake phrase.

## The laptop hub

| Tab | What it shows |
| --- | --- |
| Connect phone | The QR code that opens the phone controller, plus a pairing checklist |
| Quest | The projector view: what the AI sees (with boxes), the quest, the quest map, Vision Agent verdicts, XP, subtitles |
| Live camera | The full-rate WebRTC video from the phone |
| APIs | Which service does which job, and the model each one is using right now |

Vite serves the hub and proxies both backends, so nothing else needs opening: the camera server for `/viewer`, `/ws/*`, `/api/qr.svg`, `/api/info`, and `/api/frames*`, and the game API for every other `/api/*` route.

## How it fits together

```
 Phone (https://<lan-ip>:8443/phone)          Camera server (Python, app/)            Game API (Node, server/)
 ─────────────────────────────────           ─────────────────────────────           ────────────────────────
 camera ── WebRTC video (LAN, P2P) ─────────────────────────────────────────────►  hub Live camera tab
 camera ── 1 JPEG/s ── WS /ws/frames ──────► frame buffer ◄── polled ─────────────── Vision Agent (Gemini)
 mic ── voice detector ── WAV ── POST /api/game/voice ──► proxy ──► POST /api/voice/listen ── Muse transcribe
 type box ────────────── POST /api/game/text ──► proxy ──► POST /api/say                        │
 speaker ◄── narration, beeps ◄── GET /api/game/events ◄── proxy ◄── session events ◄── Quest Agent (Gemini)
```

The phone only talks to the camera server. That server holds no keys; it forwards game traffic to the game API on `127.0.0.1:8787`, which is the only process that calls external APIs. The game server owns quest progress, step completion, XP, combos, levels, hints, and narration, so the phone and the hub always agree.

### Which API is used where

| Job | Service | Code |
| --- | --- | --- |
| Speech to text | Meta **Muse Voice Transcribe** `POST /v1/asr/transcribe` (16 kHz mono WAV, with the agent's name and the quest's objects as keywords) | `server/providers/muse.ts`, `server/index.ts` |
| Wake phrase and awake window | No API; a pattern match on each transcript | `server/wake.ts`, `hearUtterance` in `server/session.ts` |
| **Quest Agent**: plans quests, narrates step by step, gives hints, answers questions, asks the Vision Agent to look, updates mission statuses and the map | Google **Gemini** (`GEMINI_QUEST_API_KEY`, `GEMINI_QUEST_MODEL`) | `server/questAgent.ts`, `server/llm.ts`, `server/prompts.ts` |
| **Vision Agent**: per-frame step observations, room surveys, yes/no checks answered `PASS` / `FAIL` / `UNCERTAIN` with evidence | Google **Gemini** (`GEMINI_VISION_API_KEY`, `GEMINI_VISION_MODEL`) | `server/vision.ts` |
| Fallback for either agent when Gemini is missing, over quota, or unreachable | Meta **Muse Spark** `POST /v1/chat/completions` (`MODEL_API_KEY`) | `server/llm.ts`, `server/vision.ts` |
| Narrator voice | **ElevenLabs** TTS (`ELEVENLABS_API_KEY`) via `GET /api/tts/:id` (cached); browser speech on the phone and hub if no key | `server/providers/elevenlabs.ts`, `server/tts.ts`, `static/js/voice.js`, `web/src/lib/speech.ts` |
| Directional beeps, voice activity detection | Web Audio on the phone (no API) | `static/js/voice.js` |
| Live video | WebRTC with a server relay fallback (no API) | `app/signaling.py`, `app/relay.py`, `static/js/phone.js`, `static/js/viewer.js` |

### How the agents work together

- **Verified progress.** When the frame loop thinks a step is done, the mission turns `verifying` and the Vision Agent answers that mission's `check`. `PASS` awards XP and advances. `FAIL` or `UNCERTAIN` goes back to the Quest Agent, which marks the mission `retry` and speaks a correction. A PASS/FAIL below 0.55 confidence counts as UNCERTAIN. Set `VERIFY_STEPS=0` to trust the frame loop alone.
- **Questions.** “Is the room clean?”, “Where is the trash can?”, or “I'm done” become an `ask` intent. The Quest Agent answers from quest state or names one yes/no question for the Vision Agent, then reacts to the verdict. Only a Vision Agent `PASS` can complete a mission.
- **Recognized surroundings, not presets.** Every `SURVEY_INTERVAL_MS` (15 s) the Vision Agent surveys the newest frame: one sentence describing the place plus every object it can see. These become the map's landmarks. Planned quests may only use objects the camera saw or the player named.
- **Quest map.** Recognized objects are landmarks, missions are numbered nodes on a route, and the player's position is marked. Tap a mission to re-verify it, or a landmark to ask where it is. After victory the Vision Agent runs the quest's `goalCheck` once.
- **Efficiency.** Frames arrive about once a second. Vision uses two lanes: player-driven scans (`inspect`, planning, describe) jump ahead of background frame work, and background observations are dropped when the player is waiting. A Gemini quota error (429) can pause Gemini for five minutes while Muse Spark takes over. The phone only sends audio when its voice detector hears speech, and mutes the mic while Echo is talking.

**API keys stay on the laptop.** They are read from `.env` (gitignored) by the game API only, sent in headers (never URLs), and scrubbed from logs and error responses. The game API and the camera server's laptop side bind to `127.0.0.1`, so other devices on the network can't spend your quota.

## Configuration

Everything lives in `.env`; `.env.example` documents each variable. The ones you are most likely to change:

| Variable | Default | Effect |
| --- | --- | --- |
| `MODEL_API_KEY` | | Meta Muse key (transcription and fallback brain) |
| `GEMINI_QUEST_API_KEY`, `GEMINI_VISION_API_KEY` | `GEMINI_API_KEY` | Per-agent Gemini keys (separate quotas) |
| `GEMINI_QUEST_MODEL`, `GEMINI_VISION_MODEL` | `GEMINI_MODEL` | Per-agent Gemini models |
| `AGENT_NAME` | `Echo` | Wake phrase is “Hi <name>”; narration persona uses this name |
| `ELEVENLABS_API_KEY` | | Cloud narrator voice; blank uses on-device speech |
| `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL` | premade + `eleven_flash_v2_5` | ElevenLabs voice and low-latency model |
| `AWAKE_MS` | `20000` | How long follow-ups need no wake phrase |
| `VERIFY_STEPS` | `1` | `0` skips Vision Agent confirmation of each step |
| `SURVEY_INTERVAL_MS` | `15000` | How often the room is re-surveyed for the map |
| `SIDEQUEST_SESSION` | `demo` | Game session the phone joins (or `?session=` on the phone URL) |

## Project layout

```
server/                 Game API (Node / TypeScript)
  index.ts              HTTP routes, camera-link polling, survey timer
  session.ts            Session state: quests, missions, frame loop, wake-phrase listening, events
  questAgent.ts         Quest Agent: plan, narrate, hint, answer, react to verdicts, intent parsing
  vision.ts             Vision Agent: step observations, room scans, PASS/FAIL/UNCERTAIN checks
  llm.ts                Quest Agent model calls (Gemini, Muse Spark fallback)
  prompts.ts            All system prompts and JSON schemas
  providers/            gemini.ts, muse.ts (chat + Voice Transcribe)
  wake.ts               Wake phrase matching
  map.ts                Quest map: landmarks, routes, player position
  guidance.ts           Pan / proximity / phase for directional cues
  game.ts               XP, combos, levels
  cameraLink.ts         Reads the newest phone frame from the camera server
  presets.ts, mock.ts   Scripted demo quests and mock vision (no keys)
  config.ts, util.ts
shared/types.ts         Types shared by the game API and the hub
web/                    Laptop hub (React, Vite)
  src/hub/Hub.tsx       Tabs: Connect phone, Quest, Live camera, APIs
  src/stage/            Quest tab (Stage.tsx) and the quest map (QuestMap.tsx)
  src/lib/              API client, event subscription, stage speech and sound effects
app/                    Camera server (Python / FastAPI)
  main.py               Pages, signaling + relay + frame WebSockets, frame API, game proxies
  signaling.py          Room-based offer/answer/ICE relay (one phone + one viewer per room)
  relay.py              Fallback video: phone JPEG frames forwarded to the viewer
  frames.py             Frame ring buffer and preprocessing
  network.py            LAN IP detection and self-signed certificate
  config.py             Settings from .env
static/                 Pages served by the camera server
  phone.html, js/phone.js, js/voice.js   Phone controller: camera, WebRTC, listening, narration
  viewer.html, js/viewer.js              Live video (shown in the hub's Live camera tab)
  js/common.js, css/style.css
scripts/gen_cert.py     Regenerate the HTTPS certificate (after your LAN IP changes)
tests/test_app.py       Camera server tests (signaling, relay, frames, game proxies)
run.py                  Starts the camera server's HTTPS and HTTP listeners
```

## Development

```bash
npm run typecheck                      # TypeScript
npm run build                          # check the hub builds (output in dist/, unused at runtime)
.venv/bin/pip install -r requirements-dev.txt && .venv/bin/python -m pytest
```

The camera server's interactive API docs are at `http://localhost:8000/docs`.

## Demo checklist

- Run the demo on a phone hotspot, not venue Wi-Fi.
- Stage the desk with a few clear objects (water bottle, trash can, book, backpack).
- If live planning misbehaves, start a scripted quest: `curl -X POST localhost:8787/api/quest/start -H 'Content-Type: application/json' -d '{"sessionId":"demo","presetId":"desk"}'` (`GET /api/presets` lists them).
- Click “Enable stage sound” on the Quest tab so the audience hears rewards.

## Troubleshooting

* **“Camera API unavailable” on the phone.** The page isn't on a secure origin. Use the `https://` URL and accept the certificate warning.
* **Certificate errors after switching networks.** Your LAN IP changed; run `.venv/bin/python scripts/gen_cert.py` and restart. (Or generate `certs/cert.pem` and `certs/key.pem` with [mkcert](https://github.com/FiloSottile/mkcert) and trust its root CA on the phone.)
* **Stuck on “WebRTC: connecting” or “failed”.** Both devices must be on the same Wi-Fi without client isolation, with VPNs off. While the direct link is down, the phone sends ~8 fps JPEG frames through the server and the status shows “via server relay”. Add `?mode=relay` to the phone URL to skip WebRTC entirely.
* **Echo doesn't react.** The phone's status line shows what it heard. Start with “Hi Echo”, and check that “Listen for the wake phrase” is on under Settings. A “Voice failed” message means the game API (`npm run dev`) isn't running or Muse is unreachable.
* **Black video on iPhone after locking the screen.** iOS pauses the camera in background tabs; unlock and tap Restart camera.
* **macOS asks whether Python may accept incoming connections.** Click Allow.
