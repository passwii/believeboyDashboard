"""openapi 导出脚本回归（BLF-657 懒分组后的 schema 生成）。

背景：FastAPI 0.139 的 ``_IncludedRouter`` 懒物化机制下，若懒分组在
``app.openapi()`` 生成过程中才加载，``effective_candidates`` 缓存失效会重建
route 克隆 → ``field_mapping`` 里的旧 ModelField 与新克隆对不上，抛
``KeyError: (ModelField(... name='payload' ...), 'validation')``。
``backend/scripts/openapi_export.py`` 在 BLF-657 之后漏调
``preload_all_lazy_groups()``，导致 ``make openapi-export`` / ``openapi-check``
直接崩、契约无法再同步。
"""

from __future__ import annotations

import json
import os
import sys

BACKEND = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if BACKEND not in sys.path:
    sys.path.insert(0, BACKEND)

from scripts.openapi_export import build_app  # noqa: E402


def test_build_app_can_generate_openapi_schema():
    """build_app() 之后 app.openapi() 必须跑得通（懒分组已物化）。"""
    app = build_app()

    schema = app.openapi()

    assert "paths" in schema
    assert len(schema["paths"]) > 400


def test_openapi_generation_is_deterministic():
    """同一进程内两次生成必须逐字一致（导出可复现）。"""
    app = build_app()

    first = json.dumps(app.openapi(), ensure_ascii=False, indent=2, sort_keys=True)
    second = json.dumps(app.openapi(), ensure_ascii=False, indent=2, sort_keys=True)

    assert first == second
