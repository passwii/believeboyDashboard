"""虚拟办公室 SSE 端点。

FIX-1 重写要点：
- 每 tick 创建独立短生命周期 DB session（不泄漏连接池）
- 同步 DB 操作跑在线程池（不阻塞 asyncio 事件循环）
- 每 tick 发 keep-alive 注释行（防代理超时断流）
- 单 tick 异常不断流（catch + 日志 + 继续）
- 客户端断连检测（request.is_disconnected）

P3-A: 每 tick 额外推送 chatter 事件（状态转换 → 拟人化动态）。
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


def _build_tick_sync() -> tuple[str, list[str]]:
    """在线程池中执行：短生命周期 session，构建快照 + chatter 后立即归还连接。

    Returns:
        (snapshot_json, [chatter_json, ...])
    """
    db = SessionLocal()
    try:
        now = datetime.now(UTC)
        employees, chatter = build_wall_snapshot(db, now)
        snapshot_json = json.dumps(
            {"server_time": now.isoformat(), "employees": employees},
            ensure_ascii=False,
        )
        chatter_jsons = [
            json.dumps(evt, ensure_ascii=False) for evt in chatter
        ]
        return snapshot_json, chatter_jsons
    finally:
        db.close()


async def _event_stream(request: Request):
    """SSE 生成器：每 tick 在线程池跑 DB，不阻塞事件循环。"""
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
