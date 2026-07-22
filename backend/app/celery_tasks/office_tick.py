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

# Redis key 和 TTL
OFFICE_SNAPSHOT_KEY = "office:wall_snapshot"
OFFICE_CHATTER_KEY = "office:chatter_events"
SNAPSHOT_TTL_S = 5


@shared_task(name="office_tick", acks_late=False)
def office_tick() -> str:
    """推进所有员工并缓存快照到 Redis。

    acks_late=False：这是幂等的周期任务，丢了重跑即可，不需要 redelivery。
    """
    from app.db.redis import create_redis_client
    from app.db.session import SessionLocal
    from app.core.config import get_settings
    from app.services.digital.office_service import build_wall_snapshot

    settings = get_settings()
    db = SessionLocal()
    try:
        now = datetime.now(UTC)
        employees, chatter = build_wall_snapshot(db, now)

        snapshot_payload = json.dumps(
            {"server_time": now.isoformat(), "employees": employees},
            ensure_ascii=False,
        )

        # 存快照
        r = create_redis_client(
            host=settings.redis_host,
            port=settings.redis_port,
            password=settings.redis_password,
            db=settings.redis_db,
        )
        # 同步调用（Celery worker 是同步上下文）
        import redis as sync_redis
        sr = sync_redis.Redis(
            host=settings.redis_host,
            port=settings.redis_port,
            password=settings.redis_password or None,
            db=settings.redis_db,
        )
        sr.set(OFFICE_SNAPSHOT_KEY, snapshot_payload, ex=SNAPSHOT_TTL_S)

        # chatter 事件：追加到 list，保留最近 50 条
        if chatter:
            chatter_payloads = [json.dumps(evt, ensure_ascii=False) for evt in chatter]
            pipe = sr.pipeline()
            for cp in chatter_payloads:
                pipe.lpush(OFFICE_CHATTER_KEY, cp)
            pipe.ltrim(OFFICE_CHATTER_KEY, 0, 49)
            pipe.expire(OFFICE_CHATTER_KEY, 60)
            pipe.execute()

        sr.close()
        return f"ok: {len(employees)} employees, {len(chatter)} chatter"
    except Exception:
        logger.exception("office_tick failed")
        return "error"
    finally:
        db.close()
