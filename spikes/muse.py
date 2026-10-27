"""Thin Muse Spark client for the spikes (Meta Model API, OpenAI-compatible endpoint)."""
import base64
import json
import os
import re
import sys
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI

load_dotenv(Path(__file__).resolve().parents[1] / ".env")

# Muse's audio input is speech-to-text only (idea.md §0.8 A), so music reaches it as text
# from ears.py. Contributor mode: ~12x cheaper, Meta may train on inputs (approved 2026-10-26).
MODEL = "muse-spark-1.3-contributor"
VOICE = "muse-spark-1.2-contributor"  # for spoken instructions; 1.3's audio input is documented as degraded
SPEND = {"input": 0, "output": 0}  # tokens this process; $0.10 / $0.20 per M in contributor mode

_client = None


def client():
    global _client
    if _client is None:
        key = os.environ.get("META_MODEL_API_KEY")
        if not key:
            raise SystemExit("META_MODEL_API_KEY missing: add it to lattice/.env")
        _client = OpenAI(base_url="https://api.meta.ai/v1", api_key=key)
    return _client


def audio_part(path):
    data = base64.b64encode(Path(path).read_bytes()).decode()
    return {"type": "input_audio", "input_audio": {"data": data, "format": "wav"}}


def ask(content, model=MODEL, system=None, max_tokens=16000, history=()):
    """content: list of text/audio parts for a new user turn; history: earlier
    {"role", "content"} messages. Reasoning shares max_tokens with the reply, so a
    small budget can come back empty (finish_reason "length"). Returns the reply text."""
    messages = [{"role": "system", "content": system}] if system else []
    messages += list(history)
    messages.append({"role": "user", "content": content})
    r = client().chat.completions.create(model=model, max_tokens=max_tokens, messages=messages)
    SPEND["input"] += r.usage.prompt_tokens
    SPEND["output"] += r.usage.completion_tokens
    text = r.choices[0].message.content or ""
    if not text:
        print(f"[muse] empty reply: finish_reason={r.choices[0].finish_reason}, usage={r.usage}", file=sys.stderr)
    return text


def spend_report():
    return f"{SPEND['input']} in / {SPEND['output']} out tokens, about ${(SPEND['input'] * 0.10 + SPEND['output'] * 0.20) / 1e6:.4f} (contributor rates)"


def parse_json(text):
    """Pull the last JSON object out of a reply (fenced or bare)."""
    fenced = re.findall(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    candidates = fenced or re.findall(r"(\{.*\})", text, re.S)
    for c in reversed(candidates):
        try:
            return json.loads(c)
        except json.JSONDecodeError:
            continue
    raise ValueError(f"no JSON object in reply: {text[:300]}")
