import base64
import io

from fastapi.testclient import TestClient
from PIL import Image

from app.frames import FrameBuffer, prepare_image
from app.llama import build_messages
from app.main import app


def _jpeg(w: int, h: int) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (200, 30, 30)).save(buf, format="JPEG")
    return buf.getvalue()


def test_prepare_image_downscales_to_max_side():
    jpeg, size, source = prepare_image(_jpeg(1920, 1080), max_side=1120)
    assert source == (1920, 1080)
    assert max(size) == 1120
    assert Image.open(io.BytesIO(jpeg)).format == "JPEG"


def test_prepare_image_keeps_small_frames():
    _, size, _ = prepare_image(_jpeg(640, 480), max_side=1120)
    assert size == (640, 480)


def test_frame_buffer_ring_and_messages():
    buf = FrameBuffer(maxlen=3)
    for _ in range(5):
        buf.add(_jpeg(100, 100))
    assert len(buf) == 3
    assert [f.frame_id for f in buf.latest(2)] == [4, 5]

    msgs = build_messages("hi", buf.latest(1))
    image_part = msgs[-1]["content"][1]
    assert image_part["type"] == "image_url"
    assert image_part["image_url"]["url"].startswith("data:image/jpeg;base64,")


def test_signaling_relay_between_sender_and_viewer():
    client = TestClient(app)
    with client.websocket_connect("/ws/signal/t1?role=viewer") as viewer:
        assert viewer.receive_json() == {"type": "welcome", "role": "viewer", "peers": []}
        with client.websocket_connect("/ws/signal/t1?role=sender") as sender:
            assert sender.receive_json()["peers"] == ["viewer"]
            assert viewer.receive_json() == {"type": "peer-joined", "role": "sender"}
            sender.send_json({"type": "offer", "sdp": {"type": "offer", "sdp": "x"}})
            assert viewer.receive_json()["type"] == "offer"
            viewer.send_json({"type": "answer", "sdp": {"type": "answer", "sdp": "y"}})
            assert sender.receive_json()["type"] == "answer"
        assert viewer.receive_json() == {"type": "peer-left", "role": "sender"}


def test_signaling_replaces_viewer_mdns_hosts_with_lan_ip(monkeypatch):
    monkeypatch.setattr("app.signaling.lan_ip", lambda: "192.168.1.50")
    mdns = "a5bf9572-65ea-48dd-b40d-04b37e040ba7.local"
    client = TestClient(app)
    with client.websocket_connect("/ws/signal/t2?role=viewer") as viewer:
        viewer.receive_json()
        with client.websocket_connect("/ws/signal/t2?role=sender") as sender:
            sender.receive_json()
            viewer.receive_json()
            viewer.send_json({"type": "candidate", "candidate": {
                "candidate": f"candidate:1 1 udp 2113937151 {mdns} 58552 typ host", "sdpMid": "0"}})
            got = sender.receive_json()["candidate"]
            assert got == {"candidate": "candidate:1 1 udp 2113937151 192.168.1.50 58552 typ host", "sdpMid": "0"}

            viewer.send_json({"type": "answer", "sdp": {"type": "answer", "sdp": f"a=candidate:1 1 udp 1 {mdns} 9 typ host"}})
            assert "192.168.1.50 9 typ host" in sender.receive_json()["sdp"]["sdp"]


def test_relay_forwards_phone_frames_to_viewer():
    client = TestClient(app)
    frame = _jpeg(64, 48)
    with client.websocket_connect("/ws/relay/r1?role=viewer") as viewer:
        with client.websocket_connect("/ws/relay/r1?role=sender") as phone:
            phone.send_bytes(frame)
            assert viewer.receive_bytes() == frame


def test_frame_ingest_and_latest_endpoint():
    client = TestClient(app)
    with client.websocket_connect("/ws/frames") as ws:
        ws.send_bytes(_jpeg(1280, 720))
        ack = ws.receive_json()
    assert ack["type"] == "frame" and ack["width"] == 1120
    body = client.get("/api/frames/latest").json()
    assert body["frame_id"] == ack["frame_id"]
    assert base64.b64decode(body["base64"])[:2] == b"\xff\xd8"
    assert client.get("/api/frames/latest.jpg").headers["content-type"] == "image/jpeg"


def test_analyze_sends_openai_style_request(monkeypatch):
    import json

    import httpx

    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"choices": [{"message": {"content": "a red square"}}]})

    real_client = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw))

    client = TestClient(app)
    with client.websocket_connect("/ws/frames") as ws:
        ws.send_bytes(_jpeg(320, 240))
        ws.receive_json()
    resp = client.post("/api/analyze", json={"prompt": "What is it?"})
    assert resp.status_code == 200 and resp.json()["answer"] == "a red square"
    assert seen["url"].endswith("/chat/completions")
    user = seen["body"]["messages"][-1]["content"]
    assert user[0] == {"type": "text", "text": "What is it?"}
    assert user[1]["image_url"]["url"].startswith("data:image/jpeg;base64,")
