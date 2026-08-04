"""Agent 命名空间存活探针（spec 用例 E2）。"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Request

from app.api.agent.response import agent_ok

router = APIRouter()


@router.get("/health")
def agent_health(request: Request) -> dict:
    return agent_ok(
        {
            "agent_id": getattr(request.state, "agent_id", None),
            "server_time": datetime.now(timezone.utc).isoformat(),
        }
    )
