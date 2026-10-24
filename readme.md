# Phone Camera → MacBook over WebRTC (local Wi-Fi) + Llama Vision

*Built for HackTX 2026.*

Stream your phone's camera to your MacBook's browser over your local Wi-Fi using
WebRTC, then feed the frames to a **vision-capable Llama model** (Llama 3.2 Vision
via Ollama, vLLM, llama.cpp, or any OpenAI-compatible host — no Meta AI).

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

## Requirements

* macOS with Python 3.10+ (tested with 3.14)
* Phone and MacBook on **the same Wi-Fi network** (guest networks with "client
  isolation" block device-to-device traffic, so avoid those)
* Phone browser: iOS Safari 14.3+ or Android Chrome
* Optional, for the model: [Ollama](https://ollama.com) (`brew install ollama`)

## Setup

```bash
git clone https://github.com/reventhTheCoder333/HackTX.git
cd HackTX
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env      # optional: tweak frame size / model settings
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
  `run.py` creates a self-signed certificate in `certs/` on first start.

1. **On the MacBook**, open `http://localhost:8000/viewer`.
2. **On the phone**, scan the QR code shown on the viewer page (or in the terminal). On the
   *"Your connection is not private"* page tap **Show Details → visit this website** (Safari) or
   **Advanced → Proceed** (Chrome). Then tap **Start camera** and allow camera access.
3. The video appears on the laptop within a second or two. Use **Flip camera** to switch
   between rear and front cameras, and the resolution menu for 480p/720p/1080p.

If macOS asks whether Python may accept incoming network connections, click **Allow**.

Use `?room=<name>` on both URLs to run several phone/laptop pairs on one server.

## Using the frames with Llama

### 1. Run a Llama vision model locally (Ollama)

```bash
ollama pull llama3.2-vision     # 11B, ~8 GB; fine on Apple Silicon with 16 GB+ RAM
ollama serve                    # if the Ollama app isn't already running
```

The defaults in `.env.example` already point at Ollama's OpenAI-compatible endpoint
(`http://localhost:11434/v1`, model `llama3.2-vision`). For another backend, change
`LLAMA_BASE_URL`, `LLAMA_MODEL` and `LLAMA_API_KEY` — e.g. vLLM serving
`meta-llama/Llama-3.2-11B-Vision-Instruct`, a llama.cpp server, LM Studio, or a hosted
provider such as Groq or Together that serves Llama vision weights.

### 2. Stream frames and ask questions

On the viewer page tick **Send frames to server**, pick a rate, then type a prompt under
**Ask the vision model**. Ollama's `llama3.2-vision` accepts one image per request, so keep
*Frames* at 1 unless your backend supports multiple images.

### 3. Use the frames from your own code

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

## Project layout

```
app/
  main.py        FastAPI routes: pages, signaling + frame WebSockets, frame/analyze API
  signaling.py   Room-based offer/answer/ICE relay (one phone + one viewer per room)
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

## Troubleshooting

* **"Camera API unavailable" on the phone** – the page isn't on a secure origin. Use the
  `https://` URL and accept the certificate warning.
* **"This website might be impersonating localhost"** – you opened `https://localhost:8443`.
  Use `http://localhost:8000/viewer` on the Mac instead (or click *Advanced → Proceed*).
* **Certificate errors after switching networks** – your LAN IP changed; run
  `python scripts/gen_cert.py` and restart. (Or install [mkcert](https://github.com/FiloSottile/mkcert),
  generate `certs/cert.pem`/`certs/key.pem` with it, and trust its root CA on the phone to
  get rid of the warning.)
* **Stuck on "WebRTC: connecting" / "failed"** – both devices must be on the same Wi-Fi
  without client isolation, and VPNs on either device should be off.
* **Black video on iPhone after locking the screen** – iOS pauses the camera in background
  tabs; unlock and tap *Restart camera*.
* **`/api/analyze` returns 502** – the Llama backend isn't reachable; check `ollama serve` is
  running and `ollama list` shows `llama3.2-vision`.

## Tests

```bash
pip install -r requirements-dev.txt
pytest
```
