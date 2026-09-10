"""Insight Stage 1 canonical 序列化：稳定字节表示。

同一模型同一输入连续序列化结果字节级一致，供 fixture 比较、
幂等 fingerprint 与 exporter 使用。
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from pydantic import BaseModel


def to_canonical_json(value: BaseModel | dict[str, Any] | list[Any]) -> str:
    """转 canonical JSON 字符串：key 排序、固定 separators、非 ASCII 直写。"""
    if isinstance(value, BaseModel):
        data = value.model_dump(mode="json", exclude_none=True)
    else:
        data = value
    return json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def serialize_contract(value: BaseModel | dict[str, Any] | list[Any]) -> bytes:
    """稳定序列化：canonical JSON 的 UTF-8 字节。"""
    return to_canonical_json(value).encode("utf-8")


def sha256_hex(payload: bytes) -> str:
    """小写 SHA-256 hex digest（输出 slot content 摘要用）。"""
    return hashlib.sha256(payload).hexdigest()
