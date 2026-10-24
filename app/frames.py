"""Frame buffer + preprocessing that turns raw video snapshots into Llama-ready images.

The laptop viewer grabs JPEG snapshots from the live WebRTC <video> element and
pushes them over a WebSocket. Each snapshot is normalised here so it can be handed
straight to a vision-capable Llama model:

* decoded and converted to RGB (drops alpha / odd color modes, applies EXIF rotation)
* downscaled so the longest side is <= ``max_side`` (default 1120 = 2x2 tiles of
  560px, the largest canvas Llama 3.2 Vision uses without further downsampling)
* re-encoded as baseline JPEG and base64'd, ready for an OpenAI-style
  ``image_url`` content part (``data:image/jpeg;base64,...``)
"""

from __future__ import annotations

import base64
import io
import itertools
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image, ImageOps


@dataclass(frozen=True)
class PreparedFrame:
    frame_id: int
    timestamp: float  # unix seconds when the server received the frame
    width: int
    height: int
    source_width: int
    source_height: int
    jpeg: bytes = field(repr=False)

    @property
    def base64(self) -> str:
        return base64.b64encode(self.jpeg).decode("ascii")

    @property
    def data_url(self) -> str:
        return f"data:image/jpeg;base64,{self.base64}"

    def to_pil(self) -> Image.Image:
        return Image.open(io.BytesIO(self.jpeg)).convert("RGB")

    def metadata(self) -> dict:
        return {
            "frame_id": self.frame_id,
            "timestamp": self.timestamp,
            "width": self.width,
            "height": self.height,
            "source_width": self.source_width,
            "source_height": self.source_height,
            "bytes": len(self.jpeg),
        }


def prepare_image(raw: bytes, max_side: int = 1120, jpeg_quality: int = 85) -> tuple[bytes, tuple[int, int], tuple[int, int]]:
    """Decode an encoded image and return (jpeg_bytes, (w, h), (source_w, source_h))."""
    with Image.open(io.BytesIO(raw)) as img:
        img = ImageOps.exif_transpose(img)
        source_size = img.size
        img = img.convert("RGB")
        if max(img.size) > max_side:
            img.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
        out = io.BytesIO()
        img.save(out, format="JPEG", quality=jpeg_quality, optimize=True)
        return out.getvalue(), img.size, source_size


class FrameBuffer:
    """Ring buffer holding the most recent prepared frames."""

    def __init__(self, maxlen: int = 30, max_side: int = 1120, jpeg_quality: int = 85, save_dir: str = "") -> None:
        self._frames: deque[PreparedFrame] = deque(maxlen=maxlen)
        self._ids = itertools.count(1)
        self.max_side = max_side
        self.jpeg_quality = jpeg_quality
        self.save_dir = Path(save_dir) if save_dir else None
        if self.save_dir:
            self.save_dir.mkdir(parents=True, exist_ok=True)

    def add(self, raw: bytes) -> PreparedFrame:
        jpeg, (w, h), (sw, sh) = prepare_image(raw, self.max_side, self.jpeg_quality)
        frame = PreparedFrame(next(self._ids), time.time(), w, h, sw, sh, jpeg)
        self._frames.append(frame)
        if self.save_dir:
            (self.save_dir / f"frame_{frame.frame_id:07d}.jpg").write_bytes(jpeg)
        return frame

    def latest(self, n: int = 1) -> list[PreparedFrame]:
        """Return the newest ``n`` frames, oldest first."""
        if n <= 0:
            return []
        return list(self._frames)[-n:]

    def get(self, frame_id: int) -> PreparedFrame | None:
        return next((f for f in self._frames if f.frame_id == frame_id), None)

    def __len__(self) -> int:
        return len(self._frames)
