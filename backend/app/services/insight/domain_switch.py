"""域切换开关（BLF-1016）：旧域写端 ↔ canonical Insight 的单一切换点。

`Settings.insight_canonical_domains` 是逗号分隔的域 role 白名单，任一时刻
只有一个写端：

- 空（默认，= 迁移前行为）：该域由**旧链路**承接——旧 ``AIInsight`` 写
  端点照常，canonical 域端点返回 409。线上功能与切换前完全一致，可直接
  回滚到该状态。
- 含某域 role：该域由**canonical** 承接——域端点可用，旧写端点冻结
  （HTTP 409 ``DOMAIN_SWITCH_NOT_READY``）且 Celery 不再自动建旧行。

冻结只针对**新建**旧行；已建行的在途生成不拦（否则切换瞬间的 pending
行会永久悬挂）。读路径、``AIInsight`` 历史表、SSE 流一律不动——观察期
结束前不移除旧读路径。

白名单只接受已知域 role，未知值忽略（配置笔误不会打开未实现的域）。"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException, status

#: 已迁移到 canonical Insight 的域 role（与 roles.py 注册表一致）。
CANONICAL_DOMAIN_ROLES: tuple[str, ...] = ("ad_analysis", "inventory_health")

#: 旧 ``InsightType`` → canonical role：只列已迁移的域，其余类型仍走旧链路。
#: 库存没有旧 ``InsightType`` 成员（无旧写端），故不在表内。
LEGACY_INSIGHT_TYPE_ROLES: dict[str, str] = {"ad_analysis": "ad_analysis"}


def canonical_domain_roles(settings: Any) -> frozenset[str]:
    """解析开关：返回已启用 canonical 的域 role 集合（未知项忽略）。"""
    raw = getattr(settings, "insight_canonical_domains", "") or ""
    requested = {part.strip() for part in str(raw).split(",") if part.strip()}
    return frozenset(requested.intersection(CANONICAL_DOMAIN_ROLES))


def is_domain_canonical(settings: Any, role_id: str) -> bool:
    """该域是否已由 canonical Insight 承接（决定旧写端是否冻结）。"""
    return role_id in canonical_domain_roles(settings)


def legacy_domain_role(insight_type: Any) -> str | None:
    """旧 ``InsightType``（值或枚举）→ canonical role id；未迁移域返回 None。"""
    if insight_type is None:
        return None
    return LEGACY_INSIGHT_TYPE_ROLES.get(str(getattr(insight_type, "value", insight_type)))


def domain_switch_error(role_id: str, *, enabled: bool) -> HTTPException:
    """域开关未开 / 未关时的 409：保证任一时刻只有一个写端（禁止双写）。

    定义在服务层而非端点层：``insight_schedule_service.run_schedule_now``
    也要在**建行前**用它冻结旧链路，服务层反向 import 端点模块会制造
    无谓的层级倒置（本仓服务层直接用 ``HTTPException`` 属既有惯例）。
    """
    if enabled:
        message = (
            f"{role_id} 已切换到 canonical Insight，旧生成入口已冻结；"
            "请改用 canonical run 入口"
        )
    else:
        message = (
            f"{role_id} 尚未切换到 canonical Insight（insight_canonical_domains "
            "未包含该域），canonical 入口暂不可用"
        )
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail={"code": "DOMAIN_SWITCH_NOT_READY", "message": message, "retryable": False},
    )


def legacy_write_frozen(settings: Any, insight_type: Any) -> str | None:
    """旧写路径是否已冻结；返回冻结它的 canonical role id，未冻结返回 None。

    冻结点：所有**新建**旧 ``AIInsight`` 行的入口（HTTP /generate、schedule
    run-now、Celery 自动建行）。已建行的在途生成不拦——否则切换瞬间的
    pending 行会永久悬挂。回滚 = 从 ``insight_canonical_domains`` 移除该域。
    """
    role_id = legacy_domain_role(insight_type)
    if role_id and is_domain_canonical(settings, role_id):
        return role_id
    return None


__all__ = [
    "CANONICAL_DOMAIN_ROLES",
    "LEGACY_INSIGHT_TYPE_ROLES",
    "canonical_domain_roles",
    "is_domain_canonical",
    "legacy_domain_role",
    "legacy_write_frozen",
]
