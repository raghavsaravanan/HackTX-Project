"""Runtime configuration, read from environment variables (and an optional .env file)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parent.parent
load_dotenv(ROOT_DIR / ".env")


def _int(name: str, default: int) -> int:
    value = os.getenv(name, "").strip()
    return int(value) if value else default


def _float(name: str, default: float) -> float:
    value = os.getenv(name, "").strip()
    return float(value) if value else default


@dataclass(frozen=True)
class Settings:
    host: str = os.getenv("HOST", "0.0.0.0")
    port: int = _int("PORT", 8443)  # HTTPS, for the phone
    http_port: int = _int("HTTP_PORT", 8000)  # plain HTTP on 127.0.0.1, for the laptop viewer
    cert_dir: Path = ROOT_DIR / "certs"

    # Frame preparation
    frame_max_side: int = _int("FRAME_MAX_SIDE", 1120)
    frame_jpeg_quality: int = _int("FRAME_JPEG_QUALITY", 85)
    frame_buffer_size: int = _int("FRAME_BUFFER_SIZE", 30)
    save_frames_dir: str = os.getenv("SAVE_FRAMES_DIR", "").strip()

    # Llama vision backend (OpenAI-compatible chat completions API)
    llama_base_url: str = os.getenv("LLAMA_BASE_URL", "http://localhost:11434/v1").rstrip("/")
    llama_model: str = os.getenv("LLAMA_MODEL", "llama3.2-vision")
    llama_api_key: str = os.getenv("LLAMA_API_KEY", "ollama")
    llama_max_tokens: int = _int("LLAMA_MAX_TOKENS", 512)
    llama_timeout: float = _float("LLAMA_TIMEOUT", 120.0)

    # Sidequest game API (Node, loopback only). The phone page's voice and narration go through here.
    sidequest_api_url: str = os.getenv("SIDEQUEST_API_URL", f"http://127.0.0.1:{_int('API_PORT', 8787)}").rstrip("/")
    sidequest_session: str = os.getenv("SIDEQUEST_SESSION", "demo")

    @property
    def cert_file(self) -> Path:
        return self.cert_dir / "cert.pem"

    @property
    def key_file(self) -> Path:
        return self.cert_dir / "key.pem"


settings = Settings()
