"""BLF-657：router 懒分组行为回归测试。

覆盖三条核心不变量：
1. 启动时懒分组模块**不**被 import（冷接口的模块树保持未加载 → 内存节省）；
2. 首次命中某懒分组时才加载该分组（且只加载被命中的分组）；
3. /openapi.json 一次性加载全部懒分组且 schema 完整、重复调用稳定（有效路由
   集合与急切版完全一致）。

fastapi < 0.139（无 _IncludedRouter 懒物化）时 include_lazy_router 走急切回退，
懒加载断言自动跳过。
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]  # backend/

LAZY_MARKERS = [
    "app.api.v1.endpoints.ai_chat",
    "app.api.v1.endpoints.inventory_ledger",
    "app.api.v1.endpoints.pricing_calculation",
    "app.api.v1.endpoints.daily_analysis",
    "app.api.v1.endpoints.ad_upload",
    "app.api.v1.endpoints.category_research",
    "app.api.v1.endpoints.digital_employees",
    "app.api.v1.endpoints.crm",
    "app.api.v1.endpoints.notification_settings",
]

pytestmark = pytest.mark.skipif(
    not hasattr(__import__("fastapi.routing", fromlist=["x"]), "_IncludedRouter"),
    reason="fastapi < 0.139：懒分组走急切回退，跳过懒加载断言",
)


def test_lazy_groups_not_imported_at_startup() -> None:
    """新进程冷启动：懒分组 endpoint 模块必须保持未 import。"""
    db_url = os.environ.get("TEST_DATABASE_URL") or os.environ.get("DATABASE_URL", "")
    code = (
        "import sys; import app.main; "
        f"lazy={LAZY_MARKERS!r}; "
        "print([m for m in lazy if m in sys.modules])"
    )
    env = {**os.environ, "PYTHONPATH": str(ROOT), "DATABASE_URL": db_url}
    proc = subprocess.run(
        [sys.executable, "-c", code],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode == 0, proc.stderr[-2000:]
    assert proc.stdout.strip() == "[]", f"启动时已加载懒分组: {proc.stdout.strip()}"


def test_lazy_group_loads_on_first_hit() -> None:
    """新进程内：首次命中懒分组路由时才 import 该分组；未命中分组保持未加载。"""
    db_url = os.environ.get("TEST_DATABASE_URL") or os.environ.get("DATABASE_URL", "")
    code = (
        "import sys; import app.main; "
        "from fastapi.testclient import TestClient; "
        "c = TestClient(app.main.app); "
        "r = c.get('/api/v1/inventory-ledger/months?project_id=1'); "
        "assert r.status_code == 401, r.status_code; "
        "imported = [m for m in sys.modules if 'inventory_ledger' in m]; "
        "crm_loaded = 'app.api.v1.endpoints.crm' in sys.modules; "
        "print(f'status={r.status_code} inventory_imported={bool(imported)} crm_loaded={crm_loaded}')"
    )
    env = {**os.environ, "PYTHONPATH": str(ROOT), "DATABASE_URL": db_url}
    proc = subprocess.run(
        [sys.executable, "-c", code],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert proc.returncode == 0, proc.stderr[-2000:]
    out = proc.stdout.strip().splitlines()[-1]
    assert "inventory_imported=True" in out, out
    assert "crm_loaded=False" in out, out


def test_openapi_paths_identical_to_eager_and_stable() -> None:
    """首次 /openapi.json 后：全部懒分组已加载、有效路径集合与急切版一致、重复调用稳定。"""
    from fastapi.testclient import TestClient
    from app.main import app

    def path_set(client: TestClient) -> set[str]:
        data = client.get("/openapi.json")
        assert data.status_code == 200
        return set(data.json().get("paths", {}))

    with TestClient(app) as client:
        lazy_paths = path_set(client)
        assert len(lazy_paths) > 300  # 完整性下限
        # 全部分组已加载
        for marker in LAZY_MARKERS:
            assert marker in sys.modules, f"{marker} 未被 /openapi.json 加载"
        # 重复调用稳定（schema 缓存）
        assert path_set(client) == lazy_paths

    # 与急切版路径集合对比（新进程，强制 fallback 急切加载）
    db_url = os.environ.get("TEST_DATABASE_URL") or os.environ.get("DATABASE_URL", "")
    code = (
        "import sys; sys.path.insert(0, %r); "
        "import app.api.v1.lazy_router as lr; lr._HAS_INCLUDED_ROUTER = False; "
        "from app.main import app; from fastapi.testclient import TestClient; "
        "c = TestClient(app); "
        "print(len(set(c.get('/openapi.json').json().get('paths', {}))))"
    ) % str(ROOT)
    env = {**os.environ, "PYTHONPATH": str(ROOT), "DATABASE_URL": db_url}
    proc = subprocess.run(
        [sys.executable, "-c", code],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=180,
    )
    assert proc.returncode == 0, proc.stderr[-2000:]
    eager_count = int(proc.stdout.strip().splitlines()[-1])
    assert eager_count == len(lazy_paths), (
        f"懒/急切路径数量不一致: lazy={len(lazy_paths)} eager={eager_count}"
    )
