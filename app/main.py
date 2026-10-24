"""FastAPI app: serves the phone/viewer pages, relays WebRTC signaling, and
collects video frames for a vision-capable Llama model."""

from __future__ import annotations

import io
import json
import logging

import qrcode
import qrcode.image.svg
from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .config import ROOT_DIR, settings
from .frames import FrameBuffer
from .llama import DEFAULT_SYSTEM_PROMPT, LlamaError, LlamaVisionClient
from .network import lan_ip
from .signaling import ROLES, SignalingHub

log = logging.getLogger("phonecam")
STATIC_DIR = ROOT_DIR / "static"

app = FastAPI(title="Phone Camera -> MacBook (WebRTC)")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

hub = SignalingHub()
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
async def latest_frame(include_image: bool = True) -> dict:
    """Newest frame, already prepared for Llama (base64 JPEG + data URL)."""
    latest = frames.latest(1)
    if not latest:
        raise HTTPException(404, "No frames received yet")
    frame = latest[0]
    body = frame.metadata()
    if include_image:
        body |= {"mime_type": "image/jpeg", "base64": frame.base64, "data_url": frame.data_url}
    return body


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
