"""Minimal WebRTC signaling relay.

Each room holds at most one ``sender`` (the phone) and one ``viewer`` (the laptop
browser). The server never touches media: it only forwards SDP offers/answers and
ICE candidates between the two peers, which then connect directly over Wi-Fi.

Messages sent by the server:
    {"type": "welcome", "role": <your role>, "peers": [<roles already present>]}
    {"type": "peer-joined", "role": <role>}
    {"type": "peer-left", "role": <role>}
Everything else a client sends (offer / answer / candidate / ...) is relayed verbatim
to the other peer in the room.
"""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import WebSocket

log = logging.getLogger(__name__)

ROLES = ("sender", "viewer")


class SignalingHub:
    def __init__(self) -> None:
        self._rooms: dict[str, dict[str, WebSocket]] = {}
        self._lock = asyncio.Lock()

    @staticmethod
    def other(role: str) -> str:
        return "viewer" if role == "sender" else "sender"

    def peers(self, room: str) -> list[str]:
        return list(self._rooms.get(room, {}))

    async def join(self, room: str, role: str, ws: WebSocket) -> None:
        async with self._lock:
            members = self._rooms.setdefault(room, {})
            previous = members.get(role)
            members[role] = ws
        if previous is not None:
            # A newer tab took over this role (e.g. the phone page was reloaded).
            try:
                await previous.close(code=4000, reason="replaced by a newer connection")
            except Exception:
                pass
        await self._send(ws, {"type": "welcome", "role": role, "peers": [r for r in self.peers(room) if r != role]})
        await self.relay(room, role, {"type": "peer-joined", "role": role})
        log.info("room=%s %s joined (peers=%s)", room, role, self.peers(room))

    async def leave(self, room: str, role: str, ws: WebSocket) -> None:
        async with self._lock:
            members = self._rooms.get(room, {})
            if members.get(role) is not ws:
                return  # already replaced by a newer connection
            del members[role]
            if not members:
                self._rooms.pop(room, None)
        await self.relay(room, role, {"type": "peer-left", "role": role})
        log.info("room=%s %s left", room, role)

    async def relay(self, room: str, from_role: str, message: dict) -> None:
        target = self._rooms.get(room, {}).get(self.other(from_role))
        if target is not None:
            await self._send(target, message)

    @staticmethod
    async def _send(ws: WebSocket, message: dict) -> None:
        try:
            await ws.send_text(json.dumps(message))
        except Exception as exc:  # peer vanished mid-send
            log.debug("send failed: %s", exc)
