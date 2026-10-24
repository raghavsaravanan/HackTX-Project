// Shared helpers for the phone (sender) and laptop (viewer) pages.

// Same Wi-Fi network: host ICE candidates are enough, so no STUN/TURN servers
// are configured and no traffic leaves the LAN.
export const RTC_CONFIG = { iceServers: [] };

export function roomFromUrl() {
  return new URLSearchParams(location.search).get("room") || "default";
}

export function wsUrl(path) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${path}`;
}

export function setStatus(el, text, state = "idle") {
  el.textContent = text;
  el.dataset.state = state;
}

/**
 * Auto-reconnecting signaling socket.
 * onMessage(msg) is called for every JSON message from the server.
 */
export class Signaling {
  constructor(room, role, onMessage, onStateChange = () => {}) {
    this.url = wsUrl(`/ws/signal/${encodeURIComponent(room)}?role=${role}`);
    this.onMessage = onMessage;
    this.onStateChange = onStateChange;
    this.closed = false;
    this.connect();
  }

  connect() {
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => this.onStateChange("open");
    this.ws.onmessage = (e) => this.onMessage(JSON.parse(e.data));
    this.ws.onclose = (e) => {
      this.onStateChange("closed");
      // 4000 = replaced by a newer tab with the same role; don't fight it.
      if (!this.closed && e.code !== 4000) setTimeout(() => this.connect(), 1500);
    };
  }

  send(msg) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}
