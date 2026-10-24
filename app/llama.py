"""Client for a vision-capable Llama model behind an OpenAI-compatible API.

Works with any server exposing ``POST {base_url}/chat/completions`` and accepting
image content parts, e.g.:

* Ollama          LLAMA_BASE_URL=http://localhost:11434/v1   LLAMA_MODEL=llama3.2-vision
* vLLM            LLAMA_BASE_URL=http://localhost:8000/v1    LLAMA_MODEL=meta-llama/Llama-3.2-11B-Vision-Instruct
* llama.cpp       LLAMA_BASE_URL=http://localhost:8080/v1
* Groq / Together / other hosted providers serving Llama vision weights

No Meta AI product or API is used.
"""

from __future__ import annotations

from collections.abc import Sequence

import httpx

from .config import Settings
from .frames import PreparedFrame

DEFAULT_SYSTEM_PROMPT = (
    "You are a vision assistant looking at live frames from a phone camera. "
    "Describe only what is visible and be concise."
)


class LlamaError(RuntimeError):
    pass


def build_messages(prompt: str, frames: Sequence[PreparedFrame], system_prompt: str = DEFAULT_SYSTEM_PROMPT) -> list[dict]:
    """Build an OpenAI-style message list: system text + user text with the frames attached."""
    content: list[dict] = [{"type": "text", "text": prompt}]
    content += [{"type": "image_url", "image_url": {"url": f.data_url}} for f in frames]
    messages = [{"role": "system", "content": system_prompt}] if system_prompt else []
    messages.append({"role": "user", "content": content})
    return messages


class LlamaVisionClient:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    async def analyze(self, prompt: str, frames: Sequence[PreparedFrame], system_prompt: str = DEFAULT_SYSTEM_PROMPT) -> str:
        if not frames:
            raise LlamaError("No frames available yet - start streaming frames from the viewer first.")
        payload = {
            "model": self.settings.llama_model,
            "messages": build_messages(prompt, frames, system_prompt),
            "max_tokens": self.settings.llama_max_tokens,
            "temperature": 0.2,
        }
        headers = {"Authorization": f"Bearer {self.settings.llama_api_key}"}
        url = f"{self.settings.llama_base_url}/chat/completions"
        try:
            async with httpx.AsyncClient(timeout=self.settings.llama_timeout) as client:
                resp = await client.post(url, json=payload, headers=headers)
        except httpx.HTTPError as exc:
            raise LlamaError(f"Could not reach Llama backend at {url}: {exc}") from exc
        if resp.status_code >= 400:
            raise LlamaError(f"Llama backend returned {resp.status_code}: {resp.text[:500]}")
        try:
            return resp.json()["choices"][0]["message"]["content"]
        except (KeyError, IndexError, ValueError) as exc:
            raise LlamaError(f"Unexpected response from Llama backend: {resp.text[:500]}") from exc
