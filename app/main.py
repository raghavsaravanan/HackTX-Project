"""FastAPI app: serves the phone/viewer pages, relays WebRTC signaling, and
collects video frames for a vision-capable Llama model."""

from __future__ import annotations

import base64
import io
import json
import logging
import re

import httpx
import qrcode
import qrcode.image.svg
from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .config import ROOT_DIR, settings
from .frames import FrameBuffer, prepare_image
from .llama import DEFAULT_SYSTEM_PROMPT, LlamaError, LlamaVisionClient
from .network import lan_ip
from .relay import FrameRelay
from .signaling import ROLES, SignalingHub

log = logging.getLogger("phonecam")
STATIC_DIR = ROOT_DIR / "static"

app = FastAPI(title="Phone Camera -> MacBook (WebRTC)")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

hub = SignalingHub()
relay_hub = FrameRelay()
frames = FrameBuffer(
    maxlen=settings.frame_buffer_size,
    max_side=settings.frame_max_side,
    jpeg_quality=settings.frame_jpeg_quality,
    save_dir=settings.save_frames_dir,
)
llama = LlamaVisionClient(settings)


def phone_url(room: str = "default") -> str:
    suffix = "" if room == "default" else f"?room={room}"
    return f"https://{lan_ip()}:{settings.port}/phone{suffix}"


# --------------------------------------------------------------------- pages
@app.get("/", include_in_schema=False)
async def index() -> RedirectResponse:
    return RedirectResponse("/viewer")


@app.get("/phone", include_in_schema=False)
async def phone_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "phone.html")


@app.get("/viewer", include_in_schema=False)
async def viewer_page() -> FileResponse:
    return FileResponse(STATIC_DIR / "viewer.html")


# ----------------------------------------------------------------------- api
@app.get("/api/info")
async def info(room: str = "default") -> dict:
    return {
        "phone_url": phone_url(room),
        "room": room,
        "peers": hub.peers(room),
        "frames_buffered": len(frames),
        "llama": {"base_url": settings.llama_base_url, "model": settings.llama_model},
    }


@app.get("/api/qr.svg", include_in_schema=False)
async def qr_svg(room: str = "default") -> Response:
    img = qrcode.make(phone_url(room), image_factory=qrcode.image.svg.SvgPathImage, box_size=12, border=2)
    buf = io.BytesIO()
    img.save(buf)
    return Response(buf.getvalue(), media_type="image/svg+xml")


@app.get("/api/frames")
async def list_frames(limit: int = Query(10, ge=1, le=500)) -> list[dict]:
    return [f.metadata() for f in frames.latest(limit)]


@app.get("/api/frames/latest")
async def latest_frame(include_image: bool = True, max_side: int | None = Query(None, ge=64, le=4096)) -> dict:
    """Newest frame, already prepared for Llama (base64 JPEG + data URL).

    ``max_side`` returns a smaller copy, e.g. for low-latency vision calls."""
    latest = frames.latest(1)
    if not latest:
        raise HTTPException(404, "No frames received yet")
    frame = latest[0]
    body = frame.metadata()
    if not include_image:
        return body
    jpeg = frame.jpeg
    if max_side and max(frame.width, frame.height) > max_side:
        jpeg, (w, h), _ = await run_in_threadpool(prepare_image, jpeg, max_side, frames.jpeg_quality)
        body |= {"width": w, "height": h}
    b64 = base64.b64encode(jpeg).decode("ascii")
    return body | {"mime_type": "image/jpeg", "base64": b64, "data_url": f"data:image/jpeg;base64,{b64}"}


@app.get("/api/frames/latest.jpg")
async def latest_frame_jpeg() -> Response:
    latest = frames.latest(1)
    if not latest:
        raise HTTPException(404, "No frames received yet")
    return Response(latest[0].jpeg, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@app.get("/api/frames/{frame_id}.jpg")
async def frame_jpeg(frame_id: int) -> Response:
    frame = frames.get(frame_id)
    if frame is None:
        raise HTTPException(404, "Frame not in buffer")
    return Response(frame.jpeg, media_type="image/jpeg")


class AnalyzeRequest(BaseModel):
    prompt: str = Field("What do you see?", min_length=1, max_length=4000)
    num_frames: int = Field(1, ge=1, le=8, description="Newest N frames to attach (Ollama's llama3.2-vision accepts 1)")
    system_prompt: str = DEFAULT_SYSTEM_PROMPT


@app.post("/api/analyze")
async def analyze(req: AnalyzeRequest) -> dict:
    selected = frames.latest(req.num_frames)
    try:
        answer = await llama.analyze(req.prompt, selected, req.system_prompt)
    except LlamaError as exc:
        raise HTTPException(502, str(exc)) from exc
    return {"answer": answer, "model": settings.llama_model, "frame_ids": [f.frame_id for f in selected]}


# ------------------------------------------------- sidequest game (voice in, narration out)
# The game API binds to loopback so only this machine can spend its API quota. The phone
# can only reach this server, so its microphone audio and narration stream pass through.
_SESSION_RE = re.compile(r"^[\w-]{1,64}$")
_MAX_VOICE_BYTES = 10 * 1024 * 1024


def _game_session(session: str | None) -> str:
    name = session or settings.sidequest_session
    if not _SESSION_RE.match(name):
        raise HTTPException(400, "Invalid session name")
    return name


@app.post("/api/game/voice")
async def game_voice(request: Request, session: str | None = None) -> Response:
    """Hands-free listening: one utterance as 16 kHz mono WAV. Muse transcribes it and the game
    acts on it only after the wake phrase ("hi Echo")."""
    audio = await request.body()
    if not audio or len(audio) > _MAX_VOICE_BYTES:
        raise HTTPException(413 if audio else 400, "Send 1 byte to 10 MB of WAV audio")
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            upstream = await client.post(
                f"{settings.sidequest_api_url}/api/voice/listen",
                params={"sessionId": _game_session(session)},
                content=audio,
                headers={"Content-Type": "audio/wav"},
            )
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"Sidequest game API unreachable at {settings.sidequest_api_url}") from exc
    return Response(upstream.content, status_code=upstream.status_code, media_type="application/json")


class GameText(BaseModel):
    text: str = Field(min_length=1, max_length=500)


@app.post("/api/game/text")
async def game_text(body: GameText, session: str | None = None) -> Response:
    """Typed fallback for speech: the game parses the text and acts on it, no wake phrase needed."""
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            upstream = await client.post(
                f"{settings.sidequest_api_url}/api/say",
                json={"sessionId": _game_session(session), "text": body.text},
            )
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"Sidequest game API unreachable at {settings.sidequest_api_url}") from exc
    return Response(upstream.content, status_code=upstream.status_code, media_type="application/json")


@app.get("/api/game/events")
async def game_events(session: str | None = None) -> StreamingResponse:
    """The game's server-sent events (narration, rewards, verdicts) for the phone to speak aloud."""
    url = f"{settings.sidequest_api_url}/api/session/{_game_session(session)}/events"
    client = httpx.AsyncClient(timeout=httpx.Timeout(10, read=None))
    try:
        upstream = await client.send(client.build_request("GET", url, params={"role": "phone"}), stream=True)
    except httpx.HTTPError as exc:
        await client.aclose()
        raise HTTPException(502, f"Sidequest game API unreachable at {settings.sidequest_api_url}") from exc

    async def relay():
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        except httpx.HTTPError:
            pass
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(relay(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---------------------------------------------------------------- websockets
@app.websocket("/ws/signal/{room}")
async def signal(ws: WebSocket, room: str, role: str = Query(...)) -> None:
    if role not in ROLES:
        await ws.close(code=4001, reason=f"role must be one of {ROLES}")
        return
    await ws.accept()
    await hub.join(room, role, ws)
    try:
        while True:
            message = json.loads(await ws.receive_text())
            await hub.relay(room, role, message)
    except (WebSocketDisconnect, json.JSONDecodeError):
        pass
    finally:
        await hub.leave(room, role, ws)


@app.websocket("/ws/relay/{room}")
async def relay(ws: WebSocket, room: str, role: str = Query(...)) -> None:
    """Fallback video: the phone (sender) pushes JPEG frames, viewers receive them."""
    if role not in ROLES:
        await ws.close(code=4001, reason=f"role must be one of {ROLES}")
        return
    if role == "viewer":
        # Register before accepting so a frame published right after the handshake isn't missed.
        relay_hub.add_viewer(room, ws)
        try:
            await ws.accept()
            while True:
                await ws.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            relay_hub.remove_viewer(room, ws)
        return
    await ws.accept()
    try:
        while True:
            relay_hub.publish(room, await ws.receive_bytes())
    except WebSocketDisconnect:
        pass


@app.websocket("/ws/frames")
async def frame_ingest(ws: WebSocket) -> None:
    """Viewer pushes encoded JPEG snapshots (binary messages); we ack with metadata."""
    await ws.accept()
    try:
        while True:
            raw = await ws.receive_bytes()
            try:
                frame = await run_in_threadpool(frames.add, raw)
            except Exception as exc:  # corrupt / non-image payload
                await ws.send_json({"type": "error", "detail": str(exc)})
                continue
            await ws.send_json({"type": "frame", **frame.metadata()})
    except WebSocketDisconnect:
        pass
