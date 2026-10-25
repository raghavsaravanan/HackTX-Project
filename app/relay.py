"""Fallback video path: JPEG frames from the phone, forwarded to the room's viewers.

WebRTC needs a direct phone-to-laptop route, which many venue and campus networks block
even when the phone can load pages from the laptop. This rides the same HTTPS/WSS
connection the phone page already uses, so it works anywhere that page loads.

Each viewer gets only the newest frame: if a send is still in flight when another frame
arrives, the older pending frame is dropped instead of queued.
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import WebSocket

log = logging.getLogger(__name__)


class FrameRelay:
    def __init__(self) -> None:
        self._viewers: dict[str, set[WebSocket]] = {}
        self._pending: dict[WebSocket, bytes] = {}
        self._sending: set[asyncio.Task] = set()
        self._busy: set[WebSocket] = set()

    def add_viewer(self, room: str, ws: WebSocket) -> None:
        self._viewers.setdefault(room, set()).add(ws)

    def remove_viewer(self, room: str, ws: WebSocket) -> None:
        viewers = self._viewers.get(room)
        if viewers is not None:
            viewers.discard(ws)
            if not viewers:
                del self._viewers[room]
        self._pending.pop(ws, None)

    def publish(self, room: str, frame: bytes) -> None:
        for ws in self._viewers.get(room, ()):
            self._pending[ws] = frame
            if ws not in self._busy:
                self._busy.add(ws)
                task = asyncio.create_task(self._drain(ws))
                self._sending.add(task)
                task.add_done_callback(self._sending.discard)

    async def _drain(self, ws: WebSocket) -> None:
        try:
            while (frame := self._pending.pop(ws, None)) is not None:
                await ws.send_bytes(frame)
        except Exception as exc:  # viewer went away mid-send
            log.debug("relay send failed: %s", exc)
        finally:
            self._busy.discard(ws)
