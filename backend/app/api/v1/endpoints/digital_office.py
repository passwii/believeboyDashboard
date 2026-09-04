"""虚拟办公室 SSE 端点。

FIX-1 重写要点：
- 每 tick 创建独立短生命周期 DB session（不泄漏连接池）
- 同步 DB 操作跑在线程池（不阻塞 asyncio 事件循环）
- 每 tick 发 keep-alive 注释行（防代理超时断流）
- 单 tick 异常不断流（catch + 日志 + 继续）
- 客户端断连检测（request.is_disconnected）

P3-A: 每 tick 额外推送 chatter 事件（状态转换 → 拟人化动态）。
P2-Celery: 优先读 Redis 缓存（Celery beat 独立推进器写入），miss 时 fallback 直接计算。
"""

import asyncio
import json
import logging
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse

from app.api.deps import protected
from app.db.session import SessionLocal
from app.services.digital.office_service import build_wall_snapshot

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/digital-employees", tags=["digital-employees"])

TICK_SECONDS = 3.0

# Redis keys（与 office_tick.py 保持一致，前缀由 settings 统一）
_OFFICE_SNAPSHOT_SUFFIX = "office:wall_snapshot"
_OFFICE_CHATTER_SUFFIX = "office:chatter_events"


def _office_key(suffix: str) -> str:
    from app.core.config import get_settings

    return f"{get_settings().redis_key_prefix}:{suffix}"


def _get_sync_redis():
    """获取共享同步 Redis 客户端（infra 连接池单例）。"""
    from app.services.infra.redis import get_redis_client

    return get_redis_client()


def _build_tick_sync() -> tuple[str, list[str]]:
    """在线程池中执行：优先读 Redis 缓存，miss 时 fallback 直接计算。

    Returns:
        (snapshot_json, [chatter_json, ...])
    """
    # 尝试读 Redis 缓存（Celery beat 独立推进器写入）
    try:
        sr = _get_sync_redis()
        snapshot_key = _office_key(_OFFICE_SNAPSHOT_SUFFIX)
        chatter_key = _office_key(_OFFICE_CHATTER_SUFFIX)
        cached = sr.get(snapshot_key)
        if cached:
            snapshot_json = (
                cached.decode("utf-8") if isinstance(cached, bytes) else cached
            )
            # 读 chatter（最近的事件）
            chatter_raw = sr.lrange(chatter_key, 0, 9)
            chatter_jsons = [
                c.decode("utf-8") if isinstance(c, bytes) else c for c in chatter_raw
            ]
            return snapshot_json, chatter_jsons
    except Exception:
        # Redis 不可用（dev 模式无 Redis），fallback 直接计算
        pass

    # Fallback：直接计算（单客户端 dev 模式）
    db = SessionLocal()
    try:
        now = datetime.now(UTC)
        employees, chatter = build_wall_snapshot(db, now)
        snapshot_json = json.dumps(
            {"server_time": now.isoformat(), "employees": employees},
            ensure_ascii=False,
        )
        chatter_jsons = [json.dumps(evt, ensure_ascii=False) for evt in chatter]
        return snapshot_json, chatter_jsons
    finally:
        db.close()


async def _event_stream(request: Request):
    """SSE 生成器：每 tick 在线程池跑 DB/Redis，不阻塞事件循环。"""
    while True:
        # 客户端断连 → 退出
        if await request.is_disconnected():
            break
        try:
            snapshot_json, chatter_jsons = await asyncio.to_thread(_build_tick_sync)
            yield f"event: snapshot\ndata: {snapshot_json}\n\n"
            # P3-A: 推送 chatter 事件（每条独立 event）
            for cj in chatter_jsons:
                yield f"event: chatter\ndata: {cj}\n\n"
        except Exception:
            logger.exception("office stream tick failed")
            # 发注释行保持连接，不断流
            yield ": tick-error\n\n"
        # keep-alive 注释行（防代理 60s 超时）
        yield ": keep-alive\n\n"
        await asyncio.sleep(TICK_SECONDS)


@router.get("/office/stream")
async def office_stream(request: Request, _=Depends(protected)):
    return StreamingResponse(
        _event_stream(request),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
