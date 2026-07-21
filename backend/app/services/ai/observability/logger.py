"""结构化 JSONL logger(P1 最小实现)。"""
import json
import logging
import time

logger = logging.getLogger("ai_chat.observability")


def log_stream_event(conv_id: int, event_type: str, **extra):
    """记录流事件(P1 最小:stdout JSONL)。"""
    logger.info(json.dumps({
        "ts": time.time(),
        "conv_id": conv_id,
        "event": event_type,
        **extra,
    }))
