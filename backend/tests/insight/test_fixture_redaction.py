"""I-7：fixture / contract 脱敏回归。

fixture 与 contract 中不得出现 API key、authorization、provider URL、
绝对 endpoint、system prompt / secret；只允许相对本产品 URL 与受控标识。
"""

from __future__ import annotations

import json
from pathlib import Path

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "insight"

BANNED = (
    "api_key",
    "apikey",
    "authorization",
    "base_url",
    "provider_url",
    "system_prompt",
    "system secret",
    "sk-",
    "Bearer ",
    "http://",
    "https://",
)


def _scan(value, path: str = "$") -> list[str]:
    hits: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            lowered = key.lower()
            if any(token in lowered for token in ("api_key", "base_url", "provider_url", "system_prompt", "authorization")):
                hits.append(f"{path}.{key}")
            hits.extend(_scan(child, f"{path}.{key}"))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            hits.extend(_scan(child, f"{path}[{index}]"))
    elif isinstance(value, str):
        lowered = value.lower()
        if any(token in lowered for token in BANNED):
            hits.append(f"{path}={value[:60]}")
    return hits


def test_fixtures_contain_no_secrets_or_absolute_urls():
    for name in ("normal-run", "failed-run", "cancelled-run", "retry-attempt", "resume-gap"):
        doc = json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))
        assert _scan(doc) == [], name


def test_error_payload_shape_has_no_leak_fields():
    doc = json.loads((FIXTURES / "failed-run.json").read_text(encoding="utf-8"))
    error = doc["events"][-1]["error"]
    assert set(error) <= {"code", "message", "retryable", "retry_after_seconds", "partial_available", "field", "slot", "details"}
