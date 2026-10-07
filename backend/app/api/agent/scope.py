"""Agent 命名空间 project_scope 项目范围准入依赖（BLF-441，spec §6）。

L2 硬前置：店铺测算域（以及后续所有 agent 域写路由）合入前必须先落地。
语义（§6.2 #1）：

* ``project_scope == "*"`` → 放行（存量 key 兼容，行为不变）；
* 否则按 ``,`` 分隔的 project_id 白名单校验，不在 → **403
  ``AGENT_PROJECT_OUT_OF_SCOPE``**（``errors.py`` 已有 code + 映射，无新码）；
* 查不到 key 行（auth 之后被并发吊销/删除）→ 401 fail closed，
  语义与 ``require_agent_credential`` 的 ``token_invalid`` 一致。

必须在 ``require_agent_credential`` 之后运行（它注入
``request.state.agent_api_key_id``）；路由级挂载时由依赖顺序天然保证。
"""

from __future__ import annotations

import logging

from fastapi import Request

from app.api.agent.errors import AgentApiError, ErrorCode
from app.db.session import SessionLocal
from app.models.agent_api_key import AgentApiKey

logger = logging.getLogger(__name__)

# 全量放行哨兵值（与 DB server_default 对齐）。
SCOPE_ALL = "*"

#: 这些业务域不允许被 ``'*'`` 通配隐含授予（最小权限 + 管理 Key 单例红线）。
#: 目前仅 ``agent_provisioning``——签发能力绝不经由通配 key 隐含取得
#: （BLF-847：Yawei 拍板 ``'*'`` 不再隐含签发能力）。其余域保持存量兼容。
_WILDCARD_DENIED_DOMAINS = frozenset({"agent_provisioning"})

#: 中央业务域注册表（BLF-885 P0）：路由接线 ``require_business_scope(...)``
#: 与签发校验共用同一份事实源；未知域 code 在预览阶段即拒绝。
#: 12 域（issue 原文）+ ``inventory_ledger``（BLF-582 后新增活域），与
#: ``frontend/lib/agent-domains.ts`` 的 live 列表对齐。
KNOWN_BUSINESS_DOMAINS: frozenset[str] = frozenset(
    {
        "sku_info",
        "inventory",
        "sales",
        "shipments",
        "shop_calculations",
        "new_product_calculations",
        "return_analysis",
        "replenishment_analysis",
        "report_upload_status",
        "report_upload",
        "account_health",
        "ad_analysis",
        "agent_provisioning",
        "inventory_ledger",
        # 平台巡检写侧域（BLF-944）：R0+W1–W4，写巡检报告/截图。
        "platform_inspection",
        # 客诉中心写侧域（BLF-981）：W1 批量 upsert + R1 列表读取，写每日巡检客诉数据。
        "complaint_center",
        # 月报写入域（BLF-1250 阶段一）：临时上传 + 仅计算草稿 + 确认入库。
        # 写侧域——只有显式持有该域的凭据能写入正式财务月报。
        "monthly_reports",
    }
)


def _parse_scope(scope: str) -> set[int]:
    """把 ``"12, 34"`` 解析成 project_id 集合；非法片段跳过并告警。"""
    ids: set[int] = set()
    for part in scope.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            ids.add(int(part))
        except ValueError:
            logger.warning("invalid project id in project_scope: %r", part)
    return ids


def require_project_scope(project_id: int, request: Request) -> None:
    """项目范围准入依赖。

    ``project_id`` 来自路径参数（店铺域路由统一 ``/projects/{project_id}/...``）。
    通过则静默放行；未通过抛 ``AgentApiError``，由 agent 错误处理器序列化。
    """
    key_id = getattr(request.state, "agent_api_key_id", None)
    if key_id is None:
        # 依赖顺序错误（auth 未先跑）或 state 未注入 → fail closed。
        raise AgentApiError(ErrorCode.AGENT_AUTH_FAILED, reason="token_invalid")

    db = SessionLocal()
    try:
        key = db.get(AgentApiKey, key_id)
        if key is None:
            # auth 之后 key 被删/并发吊销：与 auth 语义一致 401。
            raise AgentApiError(ErrorCode.AGENT_AUTH_FAILED, reason="token_invalid")
        scope = key.project_scope or SCOPE_ALL
        if scope == SCOPE_ALL:
            return
        if project_id not in _parse_scope(scope):
            raise AgentApiError(
                ErrorCode.AGENT_PROJECT_OUT_OF_SCOPE,
                reason="project_not_in_scope",
            )
    finally:
        db.close()


def _parse_business_scope(scope: str) -> set[str]:
    """把 ``"shipments, shop_calculations"`` 解析成域 code 集合；空片段跳过。"""
    codes: set[str] = set()
    for part in scope.split(","):
        part = part.strip()
        if part:
            codes.add(part)
    return codes


def require_business_scope(domain: str):
    """业务域范围准入依赖工厂（BLF-448）。

    ``domain`` 为域 code（如 ``shipments`` / ``shop_calculations``），在路由
    接线时闭包注入，同一路由下所有端点共享。语义与 project_scope 对齐：

    * ``business_scope == "*"`` → 放行（存量 key 兼容，行为不变）；
    * 否则按 ``,`` 分隔的域 code 白名单校验，不在 → **403
      ``AGENT_BUSINESS_OUT_OF_SCOPE``**；
    * 查不到 key 行（auth 之后被并发吊销/删除）→ 401 fail closed。

    必须在 ``require_agent_credential`` 之后运行（它注入
    ``request.state.agent_api_key_id``）。
    """

    def _require(request: Request) -> None:
        key_id = getattr(request.state, "agent_api_key_id", None)
        if key_id is None:
            # 依赖顺序错误（auth 未先跑）或 state 未注入 → fail closed。
            raise AgentApiError(ErrorCode.AGENT_AUTH_FAILED, reason="token_invalid")

        db = SessionLocal()
        try:
            key = db.get(AgentApiKey, key_id)
            if key is None:
                # auth 之后 key 被删/并发吊销：与 auth 语义一致 401。
                raise AgentApiError(ErrorCode.AGENT_AUTH_FAILED, reason="token_invalid")
            scope = key.business_scope or SCOPE_ALL
            if scope == SCOPE_ALL:
                # 通配放行，但红线域显式拒绝：'*' 不再隐含签发能力
                # （BLF-847）。即一张全域 '*' key 不能凭通配拿到签发域——
                # 必须持有显式列出 agent_provisioning 的凭据。
                if domain in _WILDCARD_DENIED_DOMAINS:
                    raise AgentApiError(
                        ErrorCode.AGENT_BUSINESS_OUT_OF_SCOPE,
                        reason="business_not_in_scope",
                        human_message=(
                            f"通配 '*' 业务域不隐含 {domain} 授权；"
                            "请使用显式授予该域的凭据"
                        ),
                    )
                return
            if domain not in _parse_business_scope(scope):
                raise AgentApiError(
                    ErrorCode.AGENT_BUSINESS_OUT_OF_SCOPE,
                    reason="business_not_in_scope",
                )
        finally:
            db.close()

    return _require
