"""Example integration: every N seconds, pull the newest prepared frame from the
server and ask a vision Llama model about it.

    python scripts/llama_watch.py --prompt "Is anyone in the frame?" --every 5

Uses the same LLAMA_* settings as the server (see .env.example).
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import settings  # noqa: E402
from app.frames import PreparedFrame  # noqa: E402
from app.llama import LlamaError, LlamaVisionClient  # noqa: E402


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", default=f"http://localhost:{settings.http_port}")
    parser.add_argument("--prompt", default="Describe what the camera sees.")
    parser.add_argument("--every", type=float, default=5.0, help="seconds between requests")
    args = parser.parse_args()

    client = LlamaVisionClient(settings)
    last_id = None
    # verify=False in case --server points at the self-signed HTTPS listener.
    async with httpx.AsyncClient(base_url=args.server, verify=False) as http:
        while True:
            resp = await http.get("/api/frames/latest")
            if resp.status_code == 200:
                data = resp.json()
                if data["frame_id"] != last_id:
                    last_id = data["frame_id"]
                    frame = PreparedFrame(
                        data["frame_id"], data["timestamp"], data["width"], data["height"],
                        data["source_width"], data["source_height"], base64.b64decode(data["base64"]),
                    )
                    try:
                        answer = await client.analyze(args.prompt, [frame])
                        print(f"[{time.strftime('%H:%M:%S')}] frame {frame.frame_id}: {answer}\n", flush=True)
                    except LlamaError as exc:
                        print(f"Llama error: {exc}", file=sys.stderr)
            else:
                print("Waiting for frames...", file=sys.stderr)
            await asyncio.sleep(args.every)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
