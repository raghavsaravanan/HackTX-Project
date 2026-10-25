import base64
import io

from fastapi.testclient import TestClient
from PIL import Image

from app.frames import FrameBuffer, prepare_image
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


def test_frame_buffer_keeps_newest_frames():
    buf = FrameBuffer(maxlen=3)
    for _ in range(5):
        buf.add(_jpeg(100, 100))
    assert len(buf) == 3
    assert [f.frame_id for f in buf.latest(2)] == [4, 5]


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


def test_root_redirects_to_phone_and_viewer_is_gone():
    client = TestClient(app)
    assert client.get("/", follow_redirects=False).headers["location"] == "/phone"
    assert client.get("/viewer").status_code == 404


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

    small = client.get("/api/frames/latest", params={"max_side": 640}).json()
    assert small["frame_id"] == ack["frame_id"] and (small["width"], small["height"]) == (640, 360)
    assert Image.open(io.BytesIO(base64.b64decode(small["base64"]))).size == (640, 360)


def _mock_game_api(monkeypatch, handler):
    import httpx

    real_client = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw))


def test_game_voice_forwards_wav_to_sidequest(monkeypatch):
    import httpx

    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["body"] = request.content
        seen["type"] = request.headers["content-type"]
        return httpx.Response(200, json={"transcript": "is the room clean", "intent": {"type": "ask", "text": "is the room clean"}})

    _mock_game_api(monkeypatch, handler)
    res = TestClient(app).post("/api/game/voice?session=demo", content=b"RIFFfakewav", headers={"Content-Type": "audio/wav"})
    assert res.status_code == 200 and res.json()["intent"]["type"] == "ask"
    assert seen["url"].endswith("/api/voice/listen?sessionId=demo")
    assert seen["body"] == b"RIFFfakewav" and seen["type"] == "audio/wav"


def test_game_text_forwards_to_sidequest(monkeypatch):
    import httpx

    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["body"] = request.content.decode()
        return httpx.Response(200, json={"transcript": "tidy my desk", "intent": {"type": "start_quest", "goal": "tidy my desk"}})

    _mock_game_api(monkeypatch, handler)
    res = TestClient(app).post("/api/game/text?session=demo", json={"text": "tidy my desk"})
    assert res.status_code == 200 and res.json()["intent"]["type"] == "start_quest"
    assert seen["url"].endswith("/api/say") and "tidy my desk" in seen["body"]


def test_game_voice_rejects_bad_session_and_empty_audio():
    client = TestClient(app)
    assert client.post("/api/game/voice?session=../etc", content=b"x").status_code == 400
    assert client.post("/api/game/voice").status_code == 400


def test_game_tts_streams_from_sidequest(monkeypatch):
    import httpx

    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        return httpx.Response(200, content=b"\xff\xfbMP3", headers={"Content-Type": "audio/mpeg"})

    _mock_game_api(monkeypatch, handler)
    res = TestClient(app).get("/api/game/tts/ln_abc1234")
    assert res.status_code == 200 and res.content == b"\xff\xfbMP3"
    assert res.headers["content-type"].startswith("audio/mpeg")
    assert seen["url"].endswith("/api/tts/ln_abc1234")


def test_game_tts_rejects_bad_line_id():
    assert TestClient(app).get("/api/game/tts/not-valid").status_code == 400


def test_game_voice_maps_upstream_timeout_to_504(monkeypatch):
    import httpx

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.TimeoutException("slow")

    _mock_game_api(monkeypatch, handler)
    res = TestClient(app).post("/api/game/voice?session=demo", content=b"RIFFfakewav", headers={"Content-Type": "audio/wav"})
    assert res.status_code == 504
    assert "timed out" in res.json()["detail"].lower()


def test_game_events_relays_server_sent_events(monkeypatch):
    import httpx

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/session/demo/events" and request.url.params["role"] == "phone"
        return httpx.Response(200, content=b'data: {"type":"say","text":"Onward"}\n\n', headers={"Content-Type": "text/event-stream"})

    _mock_game_api(monkeypatch, handler)
    res = TestClient(app).get("/api/game/events")
    assert res.headers["content-type"].startswith("text/event-stream")
    assert '"text":"Onward"' in res.text
