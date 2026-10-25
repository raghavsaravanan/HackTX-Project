# Sidequest — HackTX 2026

Everyday tasks become voice-guided quests for blind players. Muse hears, Gemini sees and guides, you conquer.

The repo holds two apps that share one `.env`:

| App | Language | What it does | Ports |
| --- | --- | --- | --- |
| **Sidequest game** (`server/`, `web/`, `shared/`) | Node / TypeScript | Quest planning, per-frame guidance, XP, narration, the laptop hub | API `8787`, hub `5173` (laptop only) |
| **Phone camera link** (`app/`, `static/`) | Python / FastAPI | Streams the phone camera to the laptop over WebRTC and buffers frames for a vision model | phone `8443` (HTTPS), viewer `8000` |

```bash
cp .env.example .env   # one file configures both apps; blank keys fall back to mock mode
```

---

## Sidequest game (Node)

```bash
npm install
npm run dev            # game API on :8787, laptop hub on http://localhost:5173
.venv/bin/python run.py   # phone camera server (setup below)
```

**One laptop link: `http://localhost:5173`.** It has four tabs:

| Tab | What it shows |
| --- | --- |
| Connect phone | The QR code that opens the phone controller, plus a pairing checklist |
| Quest | The projector view: what the AI sees, the quest, the quest map, Vision Agent verdicts, XP, subtitles |
| Live camera | The full-rate WebRTC video from the phone (the camera server's viewer, proxied) |
| APIs | Which service does which job, and the model each one is using right now |

The hub proxies the camera server (`/viewer`, `/ws/*`, `/api/qr.svg`, `/api/info`, `/api/frames*`) and the game API (`/api/*`), so nothing else needs opening. Without any keys, everything runs on scripted mock vision so you can rehearse the demo.

### The journey

The phone is the controller, and it is hands-free. The agent is called **Echo** (`AGENT_NAME`).

1. Start both apps and open `http://localhost:5173` on the laptop.
2. Scan the QR code on the Connect phone tab. Accept the certificate warning once.
3. Tap **Start** on the phone, the only tap needed. It turns on the camera and the microphone and keeps the screen awake. The hub switches to the Quest tab when frames arrive.
4. Say **“Hi Echo, help me tidy my desk.”** The Vision Agent surveys the room, and the Quest Agent builds a quest from what it sees and speaks the first step. “Hi Echo” on its own gets a chime and a “Yes?”.
5. Follow the voice. Beeps speed up and pan toward the target. Say “I'm done” after a step, or ask “is the room clean?” or “where are my headphones?”.
6. For 20 seconds after the wake phrase or a reply (`AWAKE_MS`), follow-ups need no wake phrase. Starting a new quest always needs it, so nearby chatter can't replace the quest.

How listening works: the phone runs a small voice detector, so only speech is sent, one utterance at a time, while the phone's own voice is muted from the mic. Each utterance goes to Muse Voice Transcribe with the agent's name and the quest's objects as keywords. The server checks for the wake phrase and drops everything else. There is a type box for loud rooms; typed text needs no wake phrase. The scripted presets (`POST /api/quest/start` with a `presetId`) remain a demo safety net.

### Agents and models

| Job | Model | Where |
| --- | --- | --- |
| Speech to text | Muse Voice Transcribe (`/v1/asr/transcribe`, 16 kHz WAV), with the agent's name and the quest's objects as keywords | `server/providers/muse.ts`, `server/index.ts` |
| Wake phrase (“Hi Echo”) and the awake window | No model; a pattern match on each transcript | `server/wake.ts`, `hearUtterance` in `server/session.ts` |
| **Quest Agent**: plans quests (each mission gets a vision `check`), narrates step by step, gives hints, answers questions, asks the Vision Agent to look, updates mission statuses and the quest map | Gemini (`GEMINI_QUEST_MODEL`, else `GEMINI_MODEL`) | `server/questAgent.ts`, `server/llm.ts`, `server/prompts.ts` |
| **Vision Agent**: per-frame step observations, scene scans, and yes/no checks answered `PASS` / `FAIL` / `UNCERTAIN` with evidence | Gemini (`GEMINI_VISION_MODEL`, else `GEMINI_MODEL`) | `server/vision.ts` |
| Fallback brain and eyes | Muse Spark (`muse-spark-1.3`), used automatically when Gemini is missing or fails (quota, overload, timeout) | `server/llm.ts`, `server/vision.ts` |
| Narrator voice and directional beeps | The phone's `speechSynthesis` and Web Audio | `static/js/voice.js` |

How the agents work together:

- **Verified progress.** When the frame loop thinks a step is done, the mission turns `verifying` and the Vision Agent answers that mission's `check`. `PASS` awards XP and advances. `FAIL` or `UNCERTAIN` sends the verdict and evidence back to the Quest Agent, which marks the mission `retry` and speaks a correction. A PASS/FAIL below 0.55 confidence counts as UNCERTAIN. Set `VERIFY_STEPS=0` to trust the frame loop alone.
- **Questions.** "Is the room clean?", "Where is the trash can?", or "I'm done" become an `ask` intent. The Quest Agent either answers from quest state or names one yes/no question for the Vision Agent, then reacts to the verdict. Only a Vision Agent `PASS` can complete a mission.
- **Recognized surroundings, not presets.** Every few seconds (`SURVEY_INTERVAL_MS`) the Vision Agent surveys the live camera frame: a one-sentence description of the place plus every object it can actually see. These become the map's landmarks and the Quest Agent's picture of the room. Planned quests may only use objects the camera saw (or ones the player names). The scripted presets remain as a demo safety net, but their map is also filled from what the camera sees.
- **Quest map.** The stage shows recognized objects as landmarks, missions as numbered nodes on a route, and where the player is. Nodes update as the camera spots objects and as the Quest Agent pins notes. Tap a mission to re-verify it, or a landmark to ask where it is. After victory the Vision Agent runs the quest's `goalCheck` once and pins the verdict on the map.
- **One vision call at a time.** Frames are analyzed about once a second, and a surroundings survey runs every 15 seconds. A Gemini quota error (429) pauses Gemini for 30 seconds and Muse Spark takes over, so vision traffic can't crowd out transcription.

**API keys stay on the server.** They are read from `.env` (gitignored) by the Node API only, sent in headers (never URLs), and scrubbed from logs and error responses. Vite exposes nothing to the browser. In dev the API binds to `127.0.0.1` behind the Vite proxy, so other devices on the network can't spend your quota.

### Which API is used where

The phone only talks to the camera server (port 8443). That server holds no keys; it forwards game traffic to the Node API on `127.0.0.1:8787`, which is the only process that calls out. Keys are read from `.env`, sent in headers, and scrubbed from logs and error responses.

| What happens | External API | Called from |
| --- | --- | --- |
| Speech → text | Meta **Muse Voice Transcribe** `POST /v1/asr/transcribe` | `server/providers/muse.ts` |
| Planning, narration, hints, answers | Google **Gemini** (`GEMINI_QUEST_API_KEY`, `GEMINI_QUEST_MODEL`) | `server/questAgent.ts` via `server/llm.ts` |
| Seeing frames, surveying the room, PASS/FAIL/UNCERTAIN checks | Google **Gemini** (`GEMINI_VISION_API_KEY`, `GEMINI_VISION_MODEL`) | `server/vision.ts` |
| Either agent, when its Gemini key is missing, over quota, or unreachable | Meta **Muse Spark** `POST /v1/chat/completions` (`MODEL_API_KEY`) | `server/llm.ts`, `server/vision.ts` |
| Optional “ask the model” box on the laptop viewer | Local **Llama** (Ollama) | `app/llama.py` |

The phone's own calls, all on the camera server:

| Phone does | Camera server | Node API behind it |
| --- | --- | --- |
| Each spoken utterance (16 kHz mono WAV) | `POST /api/game/voice` | `POST /api/voice/listen` → transcribe, then act only after the wake phrase |
| Type instead | `POST /api/game/text` | `POST /api/say` → act on the text, no wake phrase |
| Listen for narration, verdicts, the quest | `GET /api/game/events` | `GET /api/session/:id/events?role=phone` |
| One JPEG a second | `WS /ws/frames` | polled from `GET /api/frames/latest` on the camera server |

`POST /api/frame` still accepts frames pushed directly at the Node API, and `POST /api/vision/check` plus `POST /api/mission/verify` ask the Vision Agent on demand. The hub's Quest tab uses the event stream with `?role=stage`.

The server owns quest progress, step completion, XP, combos, levels, hints, and narration, so the phone and stage always agree.

### Demo checklist

- Stage the desk with the preset objects: water bottle, trash can, book, backpack.
- Use the `desk` preset as the safety net if live planning misbehaves.
- Run the demo on a phone hotspot, not venue Wi-Fi.
- Click "Enable stage sound" on the Quest tab so the audience hears rewards.

---

## Phone camera link (Python, WebRTC)

Stream your phone's camera to your MacBook's browser over your local Wi-Fi using
WebRTC, then feed the frames to a vision-capable Llama model (Llama 3.2 Vision
via Ollama, vLLM, llama.cpp, or any OpenAI-compatible host).

```
 ┌──────────── Phone browser ─────────────┐                 ┌──────────── MacBook ────────────────────────────────┐
 │ getUserMedia() ─► RTCPeerConnection ───┼── WebRTC (LAN) ─┼─► RTCPeerConnection ─► <video>  (viewer page)       │
 │                         ▲              │   video, P2P    │        ▲                   │ canvas snapshot (JPEG)  │
 └─────────────────────────┼──────────────┘                 │        │                   ▼                         │
                           │  offer/answer/ICE (wss)        │  FastAPI ◄── /ws/frames ── frames                    │
                           └────────────────────────────────┼─► /ws/signal   FrameBuffer: RGB, ≤1120px, JPEG, b64  │
                                                            │                   │                                  │
                                                            │                   ▼  /api/analyze                    │
                                                            │       Llama vision model (OpenAI-compatible API)     │
                                                            └──────────────────────────────────────────────────────┘
```

* **Media path:** phone → laptop browser, direct peer-to-peer on the LAN (no STUN/TURN,
  nothing leaves your network). FastAPI only relays the signaling messages.
* **Frame path:** the viewer page samples the live `<video>` at a configurable rate
  (0.5–10 fps), sends JPEG snapshots over a WebSocket, and the server normalises them
  for Llama: EXIF-rotated, RGB, longest side ≤ 1120 px (Llama 3.2 Vision's 2×2 grid of
  560 px tiles), re-encoded as JPEG and base64 `data:` URLs ready for an `image_url`
  content part.

### Requirements

* macOS with Python 3.10+ (tested with 3.14)
* Phone and MacBook on **the same Wi-Fi network** (guest networks with "client
  isolation" block device-to-device traffic, so avoid those). A phone hotspot works.
* Phone browser: iOS Safari 14.3+ or Android Chrome
* Optional, for the model: [Ollama](https://ollama.com) (`brew install ollama`)

### Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python run.py
```

`run.py` starts two listeners on the same app:

```
  Laptop viewer : http://localhost:8000/viewer     (open on this Mac)
  Phone camera  : https://192.168.1.23:8443/phone  (accept the certificate warning on the phone)
```

* The **viewer** uses plain `http://localhost` — browsers treat localhost as a secure origin,
  so there's no certificate and no *"might be impersonating localhost"* warning. It only
  listens on `127.0.0.1`, so nothing else on the network can reach it.
* The **phone** needs `https://` (phones only allow camera access on secure pages), so
  `run.py` creates a self-signed certificate in `certs/` on first start. The cert is
  machine-specific and is not committed.

1. **On the MacBook**, open `http://localhost:8000/viewer`.
2. **On the phone**, scan the QR code shown on the viewer page (or in the terminal). On the
   *"Your connection is not private"* page tap **Show Details → visit this website** (Safari) or
   **Advanced → Proceed** (Chrome). Then tap **Start camera** and allow camera access.
3. The video appears on the laptop within a second or two. Use **Flip camera** to switch
   between rear and front cameras, and the resolution menu for 480p/720p/1080p.

If macOS asks whether Python may accept incoming network connections, click **Allow**.

Use `?room=<name>` on both URLs to run several phone/laptop pairs on one server.

### Using the frames with Llama

#### 1. Run a Llama vision model locally (Ollama)

```bash
ollama pull llama3.2-vision     # 11B, ~8 GB; fine on Apple Silicon with 16 GB+ RAM
ollama serve                    # if the Ollama app isn't already running
```

The defaults in `.env.example` already point at Ollama's OpenAI-compatible endpoint
(`http://localhost:11434/v1`, model `llama3.2-vision`). For another backend, change
`LLAMA_BASE_URL`, `LLAMA_MODEL` and `LLAMA_API_KEY` — e.g. vLLM serving
`meta-llama/Llama-3.2-11B-Vision-Instruct`, a llama.cpp server, LM Studio, or a hosted
provider such as Groq or Together that serves Llama vision weights.

#### 2. Stream frames and ask questions

On the viewer page tick **Send frames to server**, pick a rate, then type a prompt under
**Ask the vision model**. Ollama's `llama3.2-vision` accepts one image per request, so keep
*Frames* at 1 unless your backend supports multiple images.

#### 3. Use the frames from your own code

| Endpoint | What you get |
|---|---|
| `GET /api/frames/latest` | Newest prepared frame: `frame_id`, `timestamp`, size, `base64`, `data_url` |
| `GET /api/frames/latest.jpg` | Newest prepared frame as a JPEG |
| `GET /api/frames?limit=10` | Metadata for the buffered frames |
| `GET /api/frames/{id}.jpg` | A specific buffered frame |
| `POST /api/analyze` | `{"prompt": "...", "num_frames": 1}` → `{"answer": "..."}` from the Llama model |
| `WS /ws/frames` | Push your own JPEG/PNG bytes in; get frame metadata back |

Interactive docs are at `http://localhost:8000/docs`.

```bash
curl http://localhost:8000/api/frames/latest.jpg -o frame.jpg
curl -X POST http://localhost:8000/api/analyze \
     -H 'Content-Type: application/json' \
     -d '{"prompt": "What objects are on the table?"}'
```

`scripts/llama_watch.py` is a ready-made loop that asks the model about the newest frame
every few seconds:

```bash
python scripts/llama_watch.py --prompt "Is anyone in the frame?" --every 5
```

In Python, `app.frames.PreparedFrame` gives you `.jpeg`, `.base64`, `.data_url` and
`.to_pil()`, and `app.llama.build_messages(prompt, frames)` builds the OpenAI-style message
list. Set `SAVE_FRAMES_DIR=captures` in `.env` to also write every frame to disk (for
datasets or offline batch inference).

### Project layout

```
app/
  main.py        FastAPI routes: pages, signaling + frame WebSockets, frame/analyze API
  signaling.py   Room-based offer/answer/ICE relay (one phone + one viewer per room)
  relay.py       Fallback video: phone JPEG frames forwarded to viewers over WebSocket
  frames.py      Frame ring buffer and Llama-oriented preprocessing
  llama.py       OpenAI-compatible client for a Llama vision model
  network.py     LAN IP detection and self-signed certificate generation
  config.py      Settings from environment / .env
static/
  phone.html, js/phone.js      getUserMedia + WebRTC sender
  viewer.html, js/viewer.js    WebRTC receiver, frame sampler, "ask the model" panel
  js/common.js, css/style.css
scripts/
  gen_cert.py    Regenerate the HTTPS cert (run after your LAN IP changes)
  llama_watch.py Periodic frame → Llama example
tests/           pytest suite (signaling relay, frame ingest, preprocessing)
run.py           Starts uvicorn with HTTPS and prints the URLs + QR code
```

### Troubleshooting

* **"Camera API unavailable" on the phone** – the page isn't on a secure origin. Use the
  `https://` URL and accept the certificate warning.
* **"This website might be impersonating localhost"** – you opened `https://localhost:8443`.
  Use `http://localhost:8000/viewer` on the Mac instead (or click *Advanced → Proceed*).
* **Certificate errors after switching networks** – your LAN IP changed; run
  `python scripts/gen_cert.py` and restart. (Or install [mkcert](https://github.com/FiloSottile/mkcert),
  generate `certs/cert.pem`/`certs/key.pem` with it, and trust its root CA on the phone to
  get rid of the warning.)
* **Stuck on "WebRTC: connecting" / "failed"** – both devices must be on the same Wi-Fi
  without client isolation, and VPNs on either device should be off. While the direct link
  is down, the phone falls back to sending ~8 fps JPEG frames through the server
  (`/ws/relay/{room}`), and the status shows "via server relay". Open the phone page with
  `?mode=relay` to skip WebRTC entirely on networks that block device-to-device traffic.
* **Black video on iPhone after locking the screen** – iOS pauses the camera in background
  tabs; unlock and tap *Restart camera*.
* **`/api/analyze` returns 502** – the Llama backend isn't reachable; check `ollama serve` is
  running and `ollama list` shows `llama3.2-vision`.

### Tests

```bash
pip install -r requirements-dev.txt
pytest
```
