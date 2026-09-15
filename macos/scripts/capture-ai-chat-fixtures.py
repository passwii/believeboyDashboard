#!/usr/bin/env python3
# pyright: reportMissingImports=false
#
# ↑ `app.*` 只在**运行时**可导入：脚本把 `backend/` 插进 `sys.path` 后才 import（见
# `main()`）。静态分析器按仓库根解析不到 `backend/app` 这个包名，这不是缺陷 —— 故在这里
# 关掉这一条，而不是把 import 改成难以阅读的 `importlib.import_module` 字符串。
"""抓取「AI 会话片」的真实响应快照（BLF-1065，macOS Stage 5.4）。

用途：把「与 Web 同源同结构」变成可执行断言 —— `AIChatDecodingTests` / `AIChatClientTests`
拿这里落盘的响应去断言「解码器认得的键名就是后端吐出来的键名」。字段改名 / 类型漂移会在
测试里报红，不必等到人工对比 Web。

## 为什么要跨两个库（这是本脚本最需要解释的一点）

四条读端点的响应要**成对**才有意义：会话列表与消息历史必须来自**同一个账号**（否则「这条
消息属于哪个会话」就无从断言）。而快照库 `BLF` 的现状是：

* 归属 `user_id` 的会话（11~15）**一个消息都没有**；
* 有消息的会话（1/3/8/9）`user_id IS NULL` —— 后端对这类历史脏数据**对任何人都是 404**
  （`services/ai/chat.py:65`）。

所以「同一账号 + 有消息」在 `BLF` 上不存在。做法是：**从 `BLF` 只读地复制一个含搜索来源的
真实会话**（连它的消息）到可写的隔离库 `BLF_test`，挂在 `--user-id`（默认 99001065，刻意避开
pytest 用的 42）名下，然后**经真实 HTTP 路由**（FastAPI `TestClient`）读出来。

* `BLF`：只 `SELECT`，绝不写（`AGENTS.md`：`BLF` 供手动读写，但本脚本不需要写它）。
* `BLF_test`：可写的一次性库；脚本每次先删掉上次插入的那条（按标题标记），再插，**幂等**。

## SSE 事件序列为什么不实跑

`id:` 游标 / `data:` 键名 / 事件类型顺序才是要钉的东西，它们正是**编码器的输出**：
`app.services.ai.protocol.encoder.encode_sse` + `ai_chat_v2._encode_done_sse`。本机
`ai_chat_provider_*` 未配置（`provider_configured = false`），实跑起不来；而且 LLM 正文
**不确定**，把一次实跑的文本固化成快照等于给一份马上腐烂的文本背书，也与本批口径 8
「AI 文本不逐字断言」冲突。`done` 载荷里的两条消息来自真实 `ai_messages` 行。
`id:` 游标取本地 Redis 真实 `XADD` 产生的 `<ms>-<seq>`（临时 key，抓完即删）。

用法：

    python3 macos/scripts/capture-ai-chat-fixtures.py                     # 写入默认目录
    python3 macos/scripts/capture-ai-chat-fixtures.py --out <dir>         # 写别处（复核漂移）
    python3 macos/scripts/capture-ai-chat-fixtures.py --user-id 99001065  # 换夹具账号
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = REPO_ROOT / "backend"
DEFAULT_OUT = REPO_ROOT / "macos" / "Tests" / "BelieveBoyTests" / "Fixtures" / "AIChat"

# 夹具账号：刻意避开 pytest 用的 42，免得污染/被污染。
DEFAULT_USER_ID = 99001065
USAGE_RANGE = "30d"
# 插入目标的会话标题前缀（既做「这是夹具数据」的标记，也是幂等删除的锚点）。
FIXTURE_TITLE_PREFIX = "[BLF-1065 夹具] "

CONVERSATION_COLUMNS = [
    "title",
    "created_at",
    "updated_at",
    "total_prompt_tokens",
    "total_completion_tokens",
    "total_tokens",
]
MESSAGE_COLUMNS = [
    "role",
    "content",
    "created_at",
    "search_sources",
    "is_complete",
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "duration_ms",
    "search_time_range",
    "model",
]


def pretty(payload: object) -> bytes:
    """落盘形态：2 空格缩进 + 键排序 —— 夹具要能被人工 `diff` / `jq` 复查。"""
    text = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True)
    return (text + "\n").encode("utf-8")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def database_url_from_env_file() -> str:
    """从 `backend/.env` 读 `DATABASE_URL`（脚本特意不依赖 Settings，见下）。"""
    env_path = BACKEND_DIR / ".env"
    if not env_path.exists():
        raise SystemExit(
            f"缺少 {env_path}（含 DATABASE_URL）。本脚本不依赖 app 的 Settings 读它，"
            "因为要在 import app **之前**把 DATABASE_URL 指向隔离库。"
        )
    for line in env_path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped.startswith("DATABASE_URL="):
            return stripped.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit(f"{env_path} 里没有 DATABASE_URL")


def redacted(url: object) -> str:
    """只留 host/db（报告与 manifest 里不落密码）。"""
    return f"{url.host}:{url.port}/{url.database}"  # type: ignore[attr-defined]


def seed_target_conversation(source_engine, target_engine, user_id: int) -> tuple[int, str]:
    """把源库里一个「带搜索来源的真实会话」复制进隔离库，返回 (会话 id, 标题)。

    标识符全部来自**反射出的 Table**（不是拼字符串），值全部走绑定参数 —— 动态 SQL 的
    两个风险面（标识符与值）都不存在，顺带让列名多一个来源：列不存在会在反射期就报错。
    """
    from sqlalchemy import (  # noqa: PLC0415
        MetaData,
        Table,
        delete,
        func,
        insert,
        select,
    )

    source_metadata = MetaData()
    source_conversations = Table("ai_conversations", source_metadata, autoload_with=source_engine)
    source_messages = Table("ai_messages", source_metadata, autoload_with=source_engine)

    with source_engine.connect() as connection:
        # 挑 search_sources 最多的那条消息所属的会话 —— 来源卡片覆盖面最大。
        source_conversation_id: int = connection.execute(
            select(source_messages.c.conversation_id)
            .where(source_messages.c.search_sources.is_not(None))
            .group_by(source_messages.c.conversation_id)
            .order_by(func.count().desc(), source_messages.c.conversation_id)
            .limit(1)
        ).scalar_one()
        conversation: dict = connection.execute(
            select(source_conversations).where(source_conversations.c.id == source_conversation_id)
        ).mappings().one()
        messages: list[dict] = connection.execute(
            select(source_messages)
            .where(source_messages.c.conversation_id == source_conversation_id)
            .order_by(source_messages.c.created_at, source_messages.c.id)
        ).mappings().all()

    title = FIXTURE_TITLE_PREFIX + conversation["title"]
    target_metadata = MetaData()
    target_conversations = Table("ai_conversations", target_metadata, autoload_with=target_engine)
    target_messages = Table("ai_messages", target_metadata, autoload_with=target_engine)

    with target_engine.begin() as connection:
        # 幂等：清掉上一次插入的那条（消息随 FK 级联）。
        connection.execute(
            delete(target_conversations).where(
                target_conversations.c.user_id == user_id,
                target_conversations.c.title.like(FIXTURE_TITLE_PREFIX + "%"),
            )
        )
        payload = {name: conversation[name] for name in CONVERSATION_COLUMNS}
        payload["title"] = title
        payload["user_id"] = user_id
        new_id: int = connection.execute(
            insert(target_conversations)
            .values(**payload)
            .returning(target_conversations.c.id)
        ).scalar_one()

        for message in messages:
            values = {name: message[name] for name in MESSAGE_COLUMNS}
            values["conversation_id"] = new_id
            connection.execute(insert(target_messages).values(**values))
    return new_id, title


def real_cursor_ids(count: int) -> tuple[list[str], str]:
    """取 `count` 个**真实** Redis Stream entry id（`<ms>-<seq>`）。

    本地 Redis 可用时 `XADD` 到临时 key 再删；不可用就按同一格式合成，并把来源写进 manifest
    （夹具里不谎称是哪一种）。
    """
    try:
        import redis  # noqa: PLC0415

        client = redis.Redis(host="127.0.0.1", port=6379, decode_responses=True)
        client.ping()
        key = "blf1065:fixture:cursor"
        client.delete(key)
        ids: list[str] = [str(client.xadd(key, {"n": str(i)})) for i in range(count)]
        client.delete(key)
        return ids, "本地 Redis XADD（临时 key，抓完即删）"
    except Exception as error:  # noqa: BLE001 —— 抓取脚本：Redis 不可用不该让整次抓取失败
        print(f"  ⚠ Redis 不可用（{error}）→ 游标按同一格式合成")
        base = 1_770_000_000_000
        return [f"{base + i * 37}-0" for i in range(count)], "合成（本地 Redis 不可用；格式为 `<ms>-<seq>`）"


def build_stream_fixtures(conversation: dict, messages: list[dict]):
    """用后端自己的编码器产出三份 SSE 文本。"""
    from app.api.v1.endpoints.ai_chat_v2 import _encode_done_sse
    from app.services.ai.protocol.encoder import encode_sse
    from app.services.ai.protocol.errors import ErrorCode, ProtocolError
    from app.services.ai.protocol.events import (
        ContentBlockDelta,
        ContentBlockStart,
        ContentBlockStop,
        ErrorEvent,
        MessageDelta,
        MessageStart,
        MessageStop,
        Ping,
        TextBlock,
        TextDelta,
        Usage,
    )

    assistant = next(
        (m for m in messages if m["role"] == "assistant" and m.get("search_sources")), None
    )
    if assistant is None:
        assistant = next((m for m in messages if m["role"] == "assistant" and m["content"]), None)
    user = next((m for m in messages if m["role"] == "user"), None)
    if assistant is None or user is None:
        raise SystemExit("该会话缺少 user/assistant 消息 —— 换一个会话源")

    # 正文分片由我们给（LLM 真实分片不可复现），但**帧是编码器吐的**，
    # 拼起来等于原始正文 —— 用例会断言这一点。
    content = assistant["content"]
    chunk_size = max(1, len(content) // 6)
    chunks = [content[i : i + chunk_size] for i in range(0, len(content), chunk_size)]

    ids, cursor_source = real_cursor_ids(len(chunks) + 3)
    frames: list[bytes] = [
        encode_sse(
            MessageStart(message_id=f"msg_{conversation['id']}", model="capture", created_at=0),
            entry_id=ids[0],
        ),
        encode_sse(ContentBlockStart(index=0, content_block=TextBlock()), entry_id=ids[1]),
    ]
    for offset, chunk in enumerate(chunks):
        frames.append(
            encode_sse(ContentBlockDelta(index=0, delta=TextDelta(text=chunk)), entry_id=ids[offset + 2])
        )
    stop_id = ids[len(chunks) + 2]
    frames.append(encode_sse(ContentBlockStop(index=0), entry_id=stop_id))
    frames.append(
        encode_sse(
            MessageDelta(
                usage=Usage(
                    input_tokens=assistant["prompt_tokens"],
                    output_tokens=assistant["completion_tokens"],
                    total_tokens=assistant["total_tokens"],
                ),
                stop_reason="end_turn",
            ),
            entry_id=stop_id,
        )
    )
    frames.append(encode_sse(MessageStop(), entry_id=stop_id))
    # 心跳（后端在等工具结果时会发）
    frames.append(encode_sse(Ping(), entry_id=stop_id))

    done_payload = {
        "type": "done",
        "user_message": user,
        "assistant_message": assistant,
        "conversation_title": conversation["title"],
        "token_usage": {
            "prompt_tokens": assistant["prompt_tokens"],
            "completion_tokens": assistant["completion_tokens"],
            "total_tokens": assistant["total_tokens"],
        },
        "conversation_token_usage": {
            "prompt_tokens": conversation["total_prompt_tokens"],
            "completion_tokens": conversation["total_completion_tokens"],
            "total_tokens": conversation["total_tokens"],
        },
        "duration_ms": assistant["duration_ms"] or 1234,
        "title_regenerated": False,
    }
    frames.append(_encode_done_sse(done_payload))
    turn = b"".join(frames)

    # 续传：从最后一个游标之后继续。`_resume_stream` 只转发 Redis 里的原始帧、
    # **不合成 done** —— 这正是「message_stop 无 done」这条合法收尾的来源。
    resume = b"".join(
        [
            encode_sse(
                ContentBlockDelta(index=0, delta=TextDelta(text="（续传补上的尾段）")),
                entry_id=stop_id,
            ),
            encode_sse(MessageStop(), entry_id=stop_id),
        ]
    )
    error = encode_sse(
        ErrorEvent(error=ProtocolError(code=ErrorCode.RATE_LIMIT, message="请求过于频繁，请稍后再试"))
    )
    return turn, resume, error, cursor_source, len(chunks)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="输出目录")
    parser.add_argument("--user-id", type=int, default=DEFAULT_USER_ID, help="夹具账号（X-User-Id）")
    parser.add_argument(
        "--source-db-url",
        default=None,
        help="只读源库（默认 backend/.env 的 DATABASE_URL）",
    )
    parser.add_argument(
        "--target-db-url",
        default=None,
        help="可写目标库（默认把源库名换成 BLF_test）",
    )
    args = parser.parse_args()

    # 必须在 import app **之前**改 DATABASE_URL：Settings 与 SQLAlchemy engine 都是 import 期
    # /首次依赖注入期就定型的东西。
    source_url = args.source_db_url or database_url_from_env_file()
    from sqlalchemy.engine import make_url  # noqa: PLC0415

    source = make_url(source_url)
    target = make_url(args.target_db_url) if args.target_db_url else source.set(database="BLF_test")
    if target.database == source.database:
        raise SystemExit("目标库与源库同名 —— 本脚本只写隔离库，拒绝就地覆盖快照库")
    os.environ["DATABASE_URL"] = target.render_as_string(hide_password=False)
    os.environ["DATABASE_READ_URL"] = ""
    os.environ["TEST_DATABASE_URL"] = ""

    sys.path.insert(0, str(BACKEND_DIR))
    from app.core.config import get_settings  # noqa: E402
    from app.main import app  # noqa: E402
    from fastapi.testclient import TestClient  # noqa: E402  （必须在 sys.path 之后）
    from sqlalchemy import create_engine  # noqa: E402

    settings = get_settings()
    headers = {
        "X-API-Key": settings.api_key,
        "X-Is-Admin": "true",
        "X-Operator": "admin",
        "X-User-Id": str(args.user_id),
    }

    conversation_id, fixture_title = seed_target_conversation(
        create_engine(source_url), create_engine(target.render_as_string(hide_password=False)), args.user_id
    )
    print(f"夹具会话：{fixture_title}（id={conversation_id}, user_id={args.user_id}）")

    client = TestClient(app)
    args.out.mkdir(parents=True, exist_ok=True)

    files: list[dict[str, object]] = []

    def write(name: str, body: bytes, note: str, endpoint: str) -> None:
        (args.out / name).write_bytes(body)
        files.append(
            {"file": name, "endpoint": endpoint, "note": note, "bytes": len(body), "sha256": sha256(body)}
        )
        print(f"{name:36s} {len(body):8d} B  {endpoint}")

    # 1) 配置
    response = client.get("/api/v1/ai/config", headers=headers)
    response.raise_for_status()
    config = response.json()
    write("ai-config.json", pretty(config), "模型 / 场景配置", "GET /api/v1/ai/config")

    # 2) 会话列表（按 X-User-Id 过滤）
    response = client.get("/api/v1/ai/conversations", headers=headers)
    response.raise_for_status()
    conversations = response.json()
    write(
        "ai-conversations.json",
        pretty(conversations),
        f"账号 {args.user_id} 的会话列表（{len(conversations)} 条）",
        "GET /api/v1/ai/conversations",
    )
    if not conversations:
        raise SystemExit("该账号没有会话 —— 换 --user-id")

    # 3) 消息历史
    response = client.get(f"/api/v1/ai/conversations/{conversation_id}/messages", headers=headers)
    response.raise_for_status()
    messages = response.json()
    write(
        "ai-conversation-messages.json",
        pretty(messages),
        f"会话 {conversation_id} 的消息历史（{len(messages)} 条，含 search_sources）",
        f"GET /api/v1/ai/conversations/{conversation_id}/messages",
    )
    if not messages:
        raise SystemExit("该会话没有消息 —— 换一个会话源")

    # 4) token 用量
    response = client.get("/api/v1/ai/usage/stats", params={"range": USAGE_RANGE}, headers=headers)
    response.raise_for_status()
    usage = response.json()
    write(
        "ai-usage-stats-30d.json",
        pretty(usage),
        f"token 用量（range={USAGE_RANGE}；物化表 {len(usage['daily'])} 天，含补 0 行）",
        "GET /api/v1/ai/usage/stats",
    )

    # 5) SSE 事件序列（后端编码器，见模块 docstring）
    conversation_summary = next(c for c in conversations if c["id"] == conversation_id)
    turn, resume, error, cursor_source, chunk_count = build_stream_fixtures(conversation_summary, messages)
    write(
        "ai-chat-stream-turn.txt",
        turn,
        f"一次完整生成的事件序列（{chunk_count} 个 text_delta + ping + done）",
        "POST /api/v1/ai/conversations/{id}/messages/stream（SSE）",
    )
    write(
        "ai-chat-stream-resume.txt",
        resume,
        "续传帧：从 Last-Event-ID 之后继续，**没有 done**（_resume_stream 不合成）",
        "同上 + Last-Event-ID",
    )
    write(
        "ai-chat-stream-error.txt",
        error,
        "error 事件（rate_limit）",
        "同上（error 分支）",
    )

    manifest = {
        "captured_at": datetime.now().astimezone().strftime("%Y-%m-%dT%H:%M:%S%z"),
        "captured_by": "BLF-1065（macOS Stage 5.4 AI 会话片）",
        "backend": (
            "本地后端经 FastAPI TestClient 走真实 HTTP 路由；响应读自隔离库 BLF_test，"
            "其中的会话与消息是从只读快照库 BLF 复制的真实数据"
        ),
        "databases": {
            "source_read_only": redacted(source),
            "target_read_write": redacted(target),
        },
        "auth": "X-API-Key（主 key）+ X-Is-Admin: true + X-User-Id: <user-id>",
        "capture_script": "macos/scripts/capture-ai-chat-fixtures.py（BLF 只读；SSE 由后端编码器生成）",
        "params": {
            "user_id": args.user_id,
            "usage_range": USAGE_RANGE,
            "conversation_id": conversation_id,
            "conversation_title": fixture_title,
            "seed_note": (
                "快照库里「归属账号」与「有消息」互不相容（有消息的会话 user_id IS NULL，"
                "后端对任何调用方都 404），故脚本把真实会话连同消息复制进 BLF_test 的夹具账号下，"
                "再经真实路由读出来 —— 内容来自生产快照，读写都不落 BLF。"
            ),
            "cursor_source": cursor_source,
            "note": (
                "SSE 三份由 `encode_sse` + `_encode_done_sse` 输出（事件实例是真实 ProtocolEvent，"
                "done 载荷的两条消息来自真实 ai_messages 行）；钉的是**线格式**"
                "（id 游标 / data 键名 / 事件顺序），不钉 AI 文本（口径 8）"
            ),
        },
        "provider_configured": config["provider_configured"],
        "usage_snapshot_rows": len(usage["daily"]),
        "files": files,
    }
    (args.out / "manifest.json").write_bytes(pretty(manifest))
    print(f"manifest → {args.out / 'manifest.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
