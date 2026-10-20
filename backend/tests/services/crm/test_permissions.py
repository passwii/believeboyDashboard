"""权限 helper 单测 —— 方案域全员可见 vs CRM 全域私海保护（BLF-1403 / BLF-1410）。

这两个口径**必须分开**：
- ``resolve_scope``：CRM 全域（客户 / 线索 / 任务 / 跟进 / 漏斗…）的「私海保护」——
  非 admin 的 ``all`` 降级为 ``mine``（用户 2026-07-23 拍板）。
- ``resolve_proposal_scope``：**仅**客户方案域——``all`` 不降级（客户方案全员可见）。

若有人为了「方案全员可见」去改 ``resolve_scope``，本文件会直接失败——
这正是它存在的目的：把「方案域例外」钉死在方案域，不外溢到其它 CRM 列表。
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.services.crm.permissions import (
    PROPOSAL_SCOPES,
    require_owner_or_admin,
    require_proposal_readable,
    resolve_proposal_scope,
    resolve_scope,
)


# ── CRM 全域口径（回归护栏）：行为不得因方案域改动而变化 ────────────────────
@pytest.mark.parametrize(
    ("scope", "is_admin", "expected"),
    [
        ("all", False, "mine"),
        ("all", True, "all"),
        ("mine", False, "mine"),
        ("mine", True, "mine"),
        ("sea", False, "sea"),
        ("sea", True, "sea"),
    ],
)
def test_resolve_scope_keeps_private_sea_protection(scope, is_admin, expected):
    """全域 resolve_scope：非 admin 的 all → mine（私海保护）。"""
    assert resolve_scope(scope, is_admin) == expected


# ── 方案域口径：all 不降级 ──────────────────────────────────────────────────
@pytest.mark.parametrize(
    ("scope", "is_admin", "expected"),
    [
        ("all", False, "all"),
        ("all", True, "all"),
        ("mine", False, "mine"),
        ("mine", True, "mine"),
    ],
)
def test_resolve_proposal_scope_does_not_downgrade(scope, is_admin, expected):
    """方案域 resolve_proposal_scope：all 原样透传（客户方案全员可见）。"""
    assert resolve_proposal_scope(scope, is_admin) == expected


@pytest.mark.parametrize("scope", ["sea", "x", "All", "ALL", "", "mine ", "public"])
def test_resolve_proposal_scope_rejects_unknown_values(scope):
    """方案域 scope **值域收口**：白名单外一律 400。

    为什么必须收口：服务层 ``list_proposals`` 只判 ``if scope == "mine"``——
    **任何**其它字符串都等于「不加 owner 过滤 = 看全部」。而 scope 在端点层是
    无校验的自由字符串 → 收口前非 admin 传 ``scope=sea`` 就能看到全部方案
    （``resolve_scope`` 对方案域只挡字面量 ``"all"``）。

    「全员可见」只应从**明确的** ``scope=all`` 进入，而不是「默认值恰好是 mine」
    的巧合。
    """
    with pytest.raises(HTTPException) as exc:
        resolve_proposal_scope(scope, False)
    assert exc.value.status_code == 400
    assert "不支持的 scope" in exc.value.detail


def test_proposal_scopes_whitelist_is_exactly_mine_and_all():
    """白名单本身就是契约：只有 mine / all 两个语义。"""
    assert set(PROPOSAL_SCOPES) == {"mine", "all"}


def test_resolve_proposal_scope_differs_from_global_scope():
    """方案域与全域口径必须不同——否则方案域的「全员可见」就废了。"""
    assert resolve_proposal_scope("all", False) == "all"
    assert resolve_scope("all", False) == "mine"


# ── 方案域只读：全员可读（含跨私海 / 无主） ────────────────────────────────
def test_require_proposal_readable_allows_anyone():
    """只读门禁：非 owner、非 admin、跨私海 → 放行（不抛 403）。"""
    assert require_proposal_readable("owner-uuid", "other-uuid", False) is None
    assert require_proposal_readable("owner-uuid", "other-uuid", True) is None
    # 无主方案（公海/未指派）同样可读
    assert require_proposal_readable(None, "some-uuid", False) is None
    # 自己的方案当然可读
    assert require_proposal_readable("me", "me", False) is None


# ── 写门禁回归护栏：非 owner 仍 403 ─────────────────────────────────────────
def test_require_owner_or_admin_still_blocks_non_owner():
    """写操作门禁不受方案域「全员可读」影响：非 owner → 403。"""
    with pytest.raises(HTTPException) as exc:
        require_owner_or_admin("owner-uuid", "other-uuid", False)
    assert exc.value.status_code == 403


def test_require_owner_or_admin_allows_owner_and_admin():
    assert require_owner_or_admin("me", "me", False) is None
    assert require_owner_or_admin("owner-uuid", "other-uuid", True) is None
