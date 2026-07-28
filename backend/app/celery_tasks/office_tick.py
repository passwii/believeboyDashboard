"""虚拟办公室独立推进器（Celery beat）。

每 3s 推进所有员工的虚拟播放状态，将整墙快照 + chatter 事件
序列化后存入 Redis（TTL 5s）。SSE 端点直接读缓存，不再各自
advance，解决多客户端竞态。

队列：default（短任务，3s 一次，<100ms 执行）
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime

from celery import shared_task

logger = logging.getLogger(__name__)

# Redis key 和 TTL（前缀由 settings.redis_key_prefix 统一）
OFFICE_SNAPSHOT_KEY_SUFFIX = "office:wall_snapshot"
OFFICE_CHATTER_KEY_SUFFIX = "office:chatter_events"
SNAPSHOT_TTL_S = 5


def _office_key(suffix: str) -> str:
    from app.core.config import get_settings

    return f"{get_settings().redis_key_prefix}:{suffix}"


@shared_task(name="office_tick", acks_late=False)
def office_tick() -> str:
    """推进所有员工并缓存快照到 Redis。

    acks_late=False：这是幂等的周期任务，丢了重跑即可，不需要 redelivery。
    使用 infra 共享连接池（get_redis_client），不再每次新建连接。
    """
    from app.db.session import SessionLocal
    from app.services.digital.office_service import build_wall_snapshot
    from app.services.infra.redis import get_redis_client

    db = SessionLocal()
    try:
        now = datetime.now(UTC)
        employees, chatter = build_wall_snapshot(db, now)

        snapshot_payload = json.dumps(
            {"server_time": now.isoformat(), "employees": employees},
            ensure_ascii=False,
        )

        sr = get_redis_client()
        snapshot_key = _office_key(OFFICE_SNAPSHOT_KEY_SUFFIX)
        chatter_key = _office_key(OFFICE_CHATTER_KEY_SUFFIX)
        sr.set(snapshot_key, snapshot_payload, ex=SNAPSHOT_TTL_S)

        # chatter 事件：追加到 list，保留最近 50 条
        if chatter:
            chatter_payloads = [json.dumps(evt, ensure_ascii=False) for evt in chatter]
            pipe = sr.pipeline()
            for cp in chatter_payloads:
                pipe.lpush(chatter_key, cp)
            pipe.ltrim(chatter_key, 0, 49)
            pipe.expire(chatter_key, 60)
            pipe.execute()

        return f"ok: {len(employees)} employees, {len(chatter)} chatter"
    except Exception:
        logger.exception("office_tick failed")
        return "error"
    finally:
        db.close()
