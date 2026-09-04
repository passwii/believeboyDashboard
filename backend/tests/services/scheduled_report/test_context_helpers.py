"""Tests for app.services.scheduled_report.context_helpers.fetch_multi_project_context.

Covers:
- Multi-project ``project_ids=[...]`` returns ``project_context`` keyed by
  ``project_name`` in ``Project.id`` ascending order (H2 fix).
- Two projects sharing the same ``sku_key`` in ``sku_context`` get
  consistently prefixed by project name (no bare key leaks through) (H3 fix).
- Empty list and None still short-circuit cleanly.
"""
from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.db.session import Base
from app.models.project import Project
from app.services.scheduled_report.context_helpers import (
    fetch_multi_project_context,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _session():
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autoflush=False)
    return Session()


def _seed_projects():
    """Seed two projects in REVERSE id order to prove order_by(Project.id) ASC.

    插入顺序是 id=2 先、id=1 后；如果查询不加 order_by，SQLite 可能按物理
    顺序返回 id=2 在前（破坏期望）。所以两个项目的 project_context 必须
    按 id ASC 出现在返回 dict 里。
    """
    db = _session()
    # Insert with id=2 first
    p2 = Project(
        id=2,
        project_name="店铺B",
        sort_order=0,
        project_context={"factory": "B-factory", "notes": "B notes"},
        sku_context={"sku-shared": {"B-specific": True}, "sku-B-only": {"v": 1}},
    )
    db.add(p2)
    db.commit()
    # Then id=1
    p1 = Project(
        id=1,
        project_name="店铺A",
        sort_order=0,
        project_context={"factory": "A-factory", "notes": "A notes"},
        sku_context={"sku-shared": {"A-specific": True}, "sku-A-only": {"v": 2}},
    )
    db.add(p1)
    db.commit()
    return db, [p1, p2]


# ---------------------------------------------------------------------------
# H2 — order_by(Project.id) ASC in explicit multi-project branch
# ---------------------------------------------------------------------------


def test_multi_project_orders_by_id_ascending():
    db, _ = _seed_projects()
    pc, _ = fetch_multi_project_context(db, [2, 1])  # 输入乱序
    assert pc is not None
    # 不管输入顺序如何，返回的 dict 必须按 Project.id ASC 排列
    assert list(pc.keys()) == ["店铺A", "店铺B"]


def test_multi_project_passes_input_order():
    """即使按输入顺序 [1, 2] 也应得到相同 id-ASC 顺序（确定性输出）。"""
    db, _ = _seed_projects()
    pc, _ = fetch_multi_project_context(db, [1, 2])
    assert pc is not None
    assert list(pc.keys()) == ["店铺A", "店铺B"]


# ---------------------------------------------------------------------------
# H3 — sku_context always prefixed by project name
# ---------------------------------------------------------------------------


def test_multi_project_sku_context_all_keys_prefixed():
    db, _ = _seed_projects()
    _, sc = fetch_multi_project_context(db, [1, 2])
    assert sc is not None
    # 同一个 sku-shared 在两个项目都出现，必须各自带前缀，不能出现裸 key
    assert "sku-shared" not in sc
    assert "店铺A/sku-shared" in sc
    assert "店铺B/sku-shared" in sc
    # 各自独有的 sku 也带前缀（保持 key 形状一致）
    assert "店铺A/sku-A-only" in sc
    assert "店铺B/sku-B-only" in sc


def test_multi_project_sku_context_values_preserved():
    db, _ = _seed_projects()
    _, sc = fetch_multi_project_context(db, [1, 2])
    assert sc is not None
    assert sc["店铺A/sku-shared"] == {"A-specific": True}
    assert sc["店铺B/sku-shared"] == {"B-specific": True}


# ---------------------------------------------------------------------------
# Edge cases — None / empty list / single project (no regression)
# ---------------------------------------------------------------------------


def test_none_returns_top_active_projects():
    db, _ = _seed_projects()
    pc, sc = fetch_multi_project_context(db, None)
    assert pc is not None
    # 至少包含我们 seed 的两个项目（top 10 active）
    assert "店铺A" in pc
    assert "店铺B" in pc


def test_empty_list_returns_none_none():
    db, _ = _seed_projects()
    pc, sc = fetch_multi_project_context(db, [])
    assert pc is None
    assert sc is None


def test_single_project_returns_raw_dicts():
    db, _ = _seed_projects()
    pc, sc = fetch_multi_project_context(db, [1])
    # 单项目走兼容分支，直接返回原始 dict（不被包成 {project_name: ...}）
    assert pc == {"factory": "A-factory", "notes": "A notes"}
    assert sc == {
        "sku-shared": {"A-specific": True},
        "sku-A-only": {"v": 2},
    }