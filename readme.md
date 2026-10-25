# Sidequest — HackTX 2026

Everyday tasks become voice-guided quests for blind players. The phone is a hands-free controller: point its camera at the room and say “Hi Echo, help me tidy my desk.” Muse Spark hears, sees, and guides.

## Quick start

```bash
cp .env.example .env            # one file configures both apps; blank keys fall back to mock mode
npm install
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

npm run dev                     # game API on 127.0.0.1:8787 + laptop hub on http://localhost:5173
.venv/bin/python run.py         # camera server: phone on https://<lan-ip>:8443, laptop side on 127.0.0.1:8000
```

Open **`http://localhost:5173`** on the laptop, which is the only laptop link. Click **Begin a session** and scan the QR code with the phone, on the same Wi-Fi, and accept the certificate warning once. Without any API keys, everything runs on scripted mock vision so you can rehearse the demo.

## The journey

The agent is called **Echo** (`AGENT_NAME`).

1. Start both apps and open the hub on the laptop.
2. Click **Begin a session** and scan the QR code.
3. Tap **Start** on the phone. This is the only tap: it turns on the camera and microphone and keeps the screen awake. Starting a task (by voice, or typed on the Begin page) moves the hub on to Perceive.
4. Say **“Hi Echo, help me tidy my desk.”** The Vision Agent surveys the room, and the Quest Agent builds a quest from what it actually sees and speaks the first step. “Hi Echo” on its own gets a chime and a “Yes?”.
5. Follow the voice. Beeps speed up and pan toward the target. Say “I'm done” after a step, or ask “is the room clean?” or “where are my headphones?”.
6. For 20 seconds after the wake phrase or a reply (`AWAKE_MS`), follow-ups need no wake phrase. Starting a new quest always needs it, so nearby chatter can't replace the quest.

The phone also has a type box for loud rooms; typed text needs no wake phrase.

## The laptop hub

The hub has three screens: **Overview** (what Lumi is), **Connect** (pair the phone, or type a task), and **Live**, one dashboard for the demo. The phone is where the experience happens; Live shows the technology behind it.

| Live panel | What it shows |
| --- | --- |
| What Lumi sees | The latest analyzed frame with target, destination, and hand boxes, direction and distance meters, and the cue sent to the phone. Switch to the **3D map** (an approximate model from one viewpoint, rotate/zoom/select) or **Text** (the same spatial information as a table, with read-aloud) |
| Task | The current touch-based instruction, every step's status, and quick actions (repeat, check, pause, skip) |
| What Lumi understands | The scene, hazards, where the current target is with its confidence, and the latest Vision Agent verdict |

A bar along the bottom shows what Lumi is saying, has a box to type to Lumi, and can play Lumi's voice on the laptop.

Vite serves the hub and proxies both backends, so nothing else needs opening: the camera server for `/ws/*`, `/api/qr.svg`, `/api/info`, and `/api/frames*`, and the game API for every other `/api/*` route.

## How it fits together

```
 Phone (https://<lan-ip>:8443/phone)          Camera server (Python, app/)            Game API (Node, server/)
 ─────────────────────────────────           ─────────────────────────────           ────────────────────────
 camera ── 1 JPEG/s ── WS /ws/frames ──────► frame buffer ◄── polled ─────────────── Vision Agent (Muse)
 mic ── voice detector ── WAV ── POST /api/game/voice ──► proxy ──► POST /api/voice/listen ── Muse transcribe
 type box ────────────── POST /api/game/text ──► proxy ──► POST /api/say                        │
 speaker ◄── narration, beeps ◄── GET /api/game/events ◄── proxy ◄── session events ◄── Quest Agent (Muse)
```

The phone only talks to the camera server. That server holds no keys; it forwards game traffic to the game API on `127.0.0.1:8787`, which is the only process that calls external APIs. The game server owns quest progress, step completion, hints, and narration, so the phone and the hub always agree.

### Which API is used where

| Job | Service | Code |
| --- | --- | --- |
| Speech to text | Meta **Muse Voice Transcribe** `POST /v1/asr/transcribe` (16 kHz mono WAV, with the agent's name and the quest's objects as keywords) | `server/providers/muse.ts`, `server/index.ts` |
| Wake phrase and awake window | No API; a pattern match on each transcript | `server/wake.ts`, `hearUtterance` in `server/session.ts` |
| **Quest Agent**: plans quests, narrates step by step, gives hints, answers questions, asks the Vision Agent to look, updates mission statuses and the map | Meta **Muse Spark** (`MODEL_API_KEY`, `MUSE_MODEL`) | `server/questAgent.ts`, `server/llm.ts`, `server/prompts.ts` |
| **Vision Agent**: per-frame step observations, room surveys, yes/no checks answered `PASS` / `FAIL` / `UNCERTAIN` with evidence | Meta **Muse Spark** vision (`MODEL_API_KEY`) | `server/vision.ts` |
| Optional alternative providers (`QUEST_AGENT_PROVIDER` / `VISION_PROVIDER` = `gemini` or `openai`); Muse Spark stays the fallback | Google Gemini or OpenAI | `server/llm.ts`, `server/vision.ts` |
| Narrator voice | **ElevenLabs** TTS (`ELEVENLABS_API_KEY`) via `GET /api/tts/:id` (cached); browser speech on the phone and hub if no key | `server/providers/elevenlabs.ts`, `server/tts.ts`, `static/js/voice.js`, `web/src/lib/speech.ts` |
| Directional beeps, voice activity detection | Web Audio on the phone (no API) | `static/js/voice.js` |
| Phone presence (the hub's "Phone open" status) | A signaling WebSocket the phone page joins (no API) | `app/signaling.py`, `static/js/phone.js` |

### How the agents work together

- **Verified progress.** When the frame loop thinks a step is done, the mission turns `verifying` and the Vision Agent answers that mission's `check`. `PASS` confirms the step (with a chime on the hub) and advances. `FAIL` or `UNCERTAIN` goes back to the Quest Agent, which marks the mission `retry` and speaks a correction. A PASS/FAIL below 0.55 confidence counts as UNCERTAIN. Set `VERIFY_STEPS=0` to trust the frame loop alone.
- **Questions.** “Is the room clean?”, “Where is the trash can?”, or “I'm done” become an `ask` intent. The Quest Agent answers from quest state or names one yes/no question for the Vision Agent, then reacts to the verdict. Only a Vision Agent `PASS` can complete a mission.
- **Recognized surroundings, not presets.** Every `SURVEY_INTERVAL_MS` (15 s) the Vision Agent surveys the newest frame: one sentence describing the place plus every object it can see. These become the map's landmarks. Planned quests may only use objects the camera saw or the player named.
- **Quest map.** Recognized objects are landmarks and missions are tied to them. After the last step the Vision Agent runs the quest's `goalCheck` once.
- **3D Quest Map, honestly approximate.** There is one phone camera, no depth sensor, no pose, so the hub (`web/src/lib/reconstruct.ts`) builds an approximate model from one viewpoint. Directions come from where things appeared in the frame; distances are ranges, either from the Vision Agent's distance class (the current target) or from how low a thing sits in the frame, assuming it rests between the floor and table height. Each object is marked observed now (live frame), estimated (latest room survey), or earlier view; things the task expects but the camera hasn't seen are listed, never drawn, and everything outside the camera's ~65° view is shown as unobserved. The real camera frame is placed inside the camera's field of view, so markers sit on the rays through where they appeared.
- **Execution telemetry.** Every outbound model or speech call (Gemini, OpenAI, Muse, ElevenLabs) goes through `server/telemetry.ts`, which reports provider, model, operation, status, latency, a short result summary, fallbacks, and retries to the hub, with no prompts, images, audio, or keys. Together with the stage start/end events this is available for diagnostics; it carries no prompts or keys.
- **Efficiency.** The phone sends a frame a second; during a task the game API analyzes the newest one every 2.5 s (`CAMERA_LINK_INTERVAL_MS`). Vision uses two lanes: player-driven scans (`inspect`, planning, describe) jump ahead of background frame work, and background observations are dropped when the player is waiting. The phone only sends audio when its voice detector hears speech, and mutes the mic while Echo is talking.

**API keys stay on the laptop.** They are read from `.env` (gitignored) by the game API only, sent in headers (never URLs), and scrubbed from logs and error responses. The game API and the camera server's laptop side bind to `127.0.0.1`, so other devices on the network can't spend your quota.

## Configuration

Everything lives in `.env`; `.env.example` documents each variable. The ones you are most likely to change:

| Variable | Default | Effect |
| --- | --- | --- |
| `MODEL_API_KEY` | | Meta Muse key (transcription and fallback brain) |
| `QUEST_AGENT_PROVIDER`, `VISION_PROVIDER` | `muse` | `muse`, or optionally `gemini` / `openai` (with their keys) |
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
  llm.ts                Quest Agent model calls (Muse Spark by default; Gemini or OpenAI optional)
  prompts.ts            All system prompts and JSON schemas
  providers/            gemini.ts, muse.ts (chat + Voice Transcribe)
  wake.ts               Wake phrase matching
  map.ts                Quest map: landmarks, routes, player position
  guidance.ts           Pan / proximity / phase for directional cues
  telemetry.ts          Per-call API telemetry for the hub's workflow view
  cameraLink.ts         Reads the newest phone frame from the camera server
  presets.ts, mock.ts   Scripted demo quests and mock vision (no keys)
  config.ts, util.ts
shared/types.ts         Types shared by the game API and the hub
web/                    Laptop hub (React, Vite)
  src/App.tsx           Shell: Overview / Connect / Live tabs, step and task-complete announcements
  src/pages/            Overview (Discover.tsx) and Connect (Begin.tsx: pairing, starting a task)
  src/session/          Live dashboard (Live.tsx), pipeline and technical details (Pipeline.tsx),
                        3D map and text view (Spatial.tsx, Spatial3D.tsx with three.js, lazy-loaded)
  src/ui/               Brand, icons, verdict chips, the camera view with Vision Agent boxes
  src/lib/              Shared session state (lumi.tsx), journey routing, spatial readouts, 3D reconstruction (reconstruct.ts),
                        workflow model (workflow.ts), API client, speech, sounds
app/                    Camera server (Python / FastAPI)
  main.py               Phone page, signaling + frame WebSockets, frame API, game proxies
  signaling.py          Which phone is connected to each room
  frames.py             Frame ring buffer and preprocessing
  network.py            LAN IP detection and self-signed certificate
  config.py             Settings from .env
static/                 Pages served by the camera server
  phone.html, js/phone.js, js/voice.js   Phone controller: camera, frames for the agents, listening, narration
  js/common.js, css/style.css
scripts/gen_cert.py     Regenerate the HTTPS certificate (after your LAN IP changes)
tests/test_app.py       Camera server tests (signaling, frames, game proxies)
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
- If live planning misbehaves, start a scripted demo task from the Begin page (or `curl -X POST localhost:8787/api/quest/start -H 'Content-Type: application/json' -d '{"sessionId":"demo","presetId":"desk"}'`; `GET /api/presets` lists them).
- Click **Turn on sound** in the live bar so the audience hears the narrator and the step chimes.

## Troubleshooting

* **“Camera API unavailable” on the phone.** The page isn't on a secure origin. Use the `https://` URL and accept the certificate warning.
* **Certificate errors after switching networks.** Your LAN IP changed; run `.venv/bin/python scripts/gen_cert.py` and restart. (Or generate `certs/cert.pem` and `certs/key.pem` with [mkcert](https://github.com/FiloSottile/mkcert) and trust its root CA on the phone.)
* **The hub says “No phone yet” with the phone page open.** Both devices must be on the same Wi-Fi without client isolation, with VPNs off.
* **Echo doesn't react.** The phone's status line shows what it heard. Start with “Hi Echo”, and check that “Listen for the wake phrase” is on under Settings. A “Voice failed” message means the game API (`npm run dev`) isn't running or Muse is unreachable.
* **Black video on iPhone after locking the screen.** iOS pauses the camera in background tabs; unlock and tap Restart camera.
* **macOS asks whether Python may accept incoming connections.** Click Allow.
