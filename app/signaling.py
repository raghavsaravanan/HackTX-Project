"""Minimal WebRTC signaling relay.

Each room holds at most one ``sender`` (the phone) and one ``viewer`` (the laptop
browser). The server never touches media: it only forwards SDP offers/answers and
ICE candidates between the two peers, which then connect directly over Wi-Fi.

Messages sent by the server:
    {"type": "welcome", "role": <your role>, "peers": [<roles already present>]}
    {"type": "peer-joined", "role": <role>}
    {"type": "peer-left", "role": <role>}
Everything else a client sends (offer / answer / candidate / ...) is relayed to the
other peer in the room, verbatim except for mDNS host names (see ``_unmask_mdns``).
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import re

from fastapi import WebSocket

from .network import lan_ip

log = logging.getLogger(__name__)

ROLES = ("sender", "viewer")

# Browsers hide a page's local IP behind a random "<uuid>.local" mDNS name unless the
# page has camera/mic permission. The laptop viewer never has it, and phones often
# can't resolve the name (an iPhone can't over its own hotspot), so ICE finds no path.
_MDNS_HOST = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.local", re.IGNORECASE)


class SignalingHub:
    def __init__(self) -> None:
        self._rooms: dict[str, dict[str, WebSocket]] = {}
        self._hosts: dict[tuple[str, str], str] = {}
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
            self._hosts[(room, role)] = ws.client.host if ws.client else ""
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
            self._hosts.pop((room, role), None)
            if not members:
                self._rooms.pop(room, None)
        await self.relay(room, role, {"type": "peer-left", "role": role})
        log.info("room=%s %s left", room, role)

    async def relay(self, room: str, from_role: str, message: dict) -> None:
        message = self._unmask_mdns(room, from_role, message)
        if message.get("type") == "candidate":
            log.info("room=%s %s candidate: %s", room, from_role, (message.get("candidate") or {}).get("candidate"))
        target = self._rooms.get(room, {}).get(self.other(from_role))
        if target is not None:
            await self._send(target, message)

    def _reachable_ip(self, room: str, role: str) -> str | None:
        """The peer's address as seen on the LAN. The viewer runs on this machine, so it
        connects over loopback and its LAN address is ours."""
        for host in (self._hosts.get((room, role)), lan_ip()):
            try:
                addr = ipaddress.ip_address(host or "")
            except ValueError:
                continue
            if not addr.is_loopback:
                return str(addr)
        return None

    def _unmask_mdns(self, room: str, role: str, message: dict) -> dict:
        """Swap "<uuid>.local" host names in candidates and SDP for the sender's real IP."""
        kind = message.get("type")
        field = "candidate" if kind == "candidate" else "sdp" if kind in ("offer", "answer") else None
        holder = message.get(field) if field else None
        text = holder.get(field) if isinstance(holder, dict) else None
        if not isinstance(text, str) or not _MDNS_HOST.search(text):
            return message
        ip = self._reachable_ip(room, role)
        if ip is None:
            return message
        return {**message, field: {**holder, field: _MDNS_HOST.sub(ip, text)}}

    @staticmethod
    async def _send(ws: WebSocket, message: dict) -> None:
        try:
            await ws.send_text(json.dumps(message))
        except Exception as exc:  # peer vanished mid-send
            log.debug("send failed: %s", exc)
