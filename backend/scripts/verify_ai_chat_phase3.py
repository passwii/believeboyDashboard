"""AI Chat Phase 3 自动化烟雾测试（真 LLM）：自动生成会话标题。

验证（对应 plan 任务 4 验收）：
1. 新会话（默认标题）首条消息 → done.title_regenerated=True 且标题非默认、DB 落库
2. 用户自定义标题会话 → done.title_regenerated=False 且标题不变
3. 第二条消息（标题已非默认）→ 不再重算（title_regenerated=False）

用法：
    cd backend && ./.venv/bin/python scripts/verify_ai_chat_phase3.py

说明：
- 会真实启动 uvicorn :8100 并调用 LLM（依赖 backend/.env 的 provider 配置），
  且会向当前 DATABASE_URL 写入 user_id=42 的会话（与 phase1/2 烟雾脚本一致）。
- 仅作人工验收用；CI / 单测请用 backend/tests/api/test_ai_chat_autotitle.py。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

# 把 backend/ 加入 sys.path 以便 import app.*
_BACKEND_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND_ROOT))

import httpx

# 把 backend/.env 和 .env.test 注入 os.environ（用 setdefault，不覆盖已有环境变量）；
# .env 提供 AI provider / API_KEY 等，.env.test 提供 TEST_DATABASE_URL / TEST_*_PASSWORD。
# get_settings() 发现 TEST_DATABASE_URL 时路由到独立测试库（隔离 dev DB）；
# subprocess.Popen(uvicorn) 子进程继承这些环境变量。
for _env_file in (_BACKEND_ROOT / ".env", _BACKEND_ROOT / ".env.test"):
    if not _env_file.exists():
        continue
    for _line in _env_file.read_text(encoding="utf-8").splitlines():
        _line = _line.strip()
        if not _line or _line.startswith("#") or "=" not in _line:
            continue
        _k, _, _v = _line.partition("=")
        os.environ.setdefault(_k.strip(), _v.strip().strip('"').strip("'"))

from app.services.ai.chat import DEFAULT_CONVERSATION_TITLE  # noqa: E402

BACKEND_PORT = 8100
BACKEND_URL = f"http://127.0.0.1:{BACKEND_PORT}"
STARTUP_TIMEOUT = 30
REQUEST_TIMEOUT = 120


def _read_env() -> dict[str, str]:
    """从 backend/.env 读 API_KEY / DB URL 等必要字段。"""
    env_path = Path(__file__).resolve().parent.parent / ".env"
    env: dict[str, str] = {}
    if not env_path.exists():
        return env
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def _start_backend() -> subprocess.Popen:
    """后台启动 uvicorn :8100，日志写到 /tmp/verify_phase3_backend.log。"""
    log = open("/tmp/verify_phase3_backend.log", "w")
    proc = subprocess.Popen(
        ["./.venv/bin/uvicorn", "app.main:app", "--port", str(BACKEND_PORT), "--log-level", "warning"],
        cwd=Path(__file__).resolve().parent.parent,
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    print(f"[启动] 后端 PID={proc.pid}，日志: /tmp/verify_phase3_backend.log")
    return proc


def _wait_ready() -> bool:
    """轮询 /docs（FastAPI 自带，肯定可达）直到 200 或超时。"""
    print(f"[等待] 等服务 ready（最多 {STARTUP_TIMEOUT}s）...")
    deadline = time.time() + STARTUP_TIMEOUT
    while time.time() < deadline:
        try:
            r = httpx.get(f"{BACKEND_URL}/docs", timeout=2.0)
            if r.status_code == 200:
                print("    ✓ ready")
                return True
        except Exception:
            pass
        time.sleep(0.5)
    print("    ✗ 超时")
    return False


def _create_conversation(api_key: str, *, title) -> int:
    """直接走 DB 建一条 AIConversation，返回 id。"""
    from app.db.session import SessionLocal
    from app.models.ai_chat import AIConversation

    session = SessionLocal()
    try:
        row = AIConversation(user_id=42, title=title)
        session.add(row)
        session.commit()
        session.refresh(row)
        return row.id
    finally:
        session.close()


def _db_title(conv_id: int) -> str:
    from app.db.session import SessionLocal
    from app.models.ai_chat import AIConversation

    session = SessionLocal()
    try:
        return session.get(AIConversation, conv_id).title
    finally:
        session.close()


def _streaming_curl(api_key: str, conv_id: int, payload: dict) -> list[dict]:
    """流式 POST，解析 ndjson 返回 list of dict。"""
    headers = {
        "Content-Type": "application/json",
        "X-User-Id": "42",
        "X-API-Key": api_key,
    }
    url = f"{BACKEND_URL}/api/v1/ai/conversations/{conv_id}/messages/stream"
    events: list[dict] = []
    with httpx.stream("POST", url, json=payload, headers=headers, timeout=REQUEST_TIMEOUT) as resp:
        if resp.status_code != 200:
            body = resp.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"status={resp.status_code} body={body[:500]}")
        for line in resp.iter_lines():
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                print(f"    [warn] 非 ndjson 行: {line[:100]}")
    return events


def _done_of(events: list[dict]) -> dict | None:
    return next((e for e in events if e.get("type") == "done"), None)


def _test_autotitle_first_turn(api_key: str) -> tuple[bool, str]:
    conv_id = _create_conversation(api_key, title=DEFAULT_CONVERSATION_TITLE)
    events = _streaming_curl(
        api_key, conv_id, {"content": "帮我分析一下上个月的销售趋势", "enable_web_search": False, "model": "Believeboy-Nano"}
    )
    done = _done_of(events)
    if done is None:
        return False, "无 done 事件"
    if not done.get("title_regenerated"):
        return False, f"title_regenerated=False（预期 True）；conversation_title={done.get('conversation_title')}"
    ct = done.get("conversation_title") or ""
    if ct == DEFAULT_CONVERSATION_TITLE:
        return False, "标题仍是默认，未生成"
    db_title = _db_title(conv_id)
    if db_title != ct:
        return False, f"DB 标题({db_title!r}) 与 done 标题({ct!r}) 不一致"
    return True, f"ok（标题={ct!r}，DB 已落库）"


def _test_custom_title_skipped(api_key: str) -> tuple[bool, str]:
    conv_id = _create_conversation(api_key, title="我的自定义标题")
    events = _streaming_curl(
        api_key, conv_id, {"content": "帮我分析一下库存", "enable_web_search": False, "model": "Believeboy-Nano"}
    )
    done = _done_of(events)
    if done is None:
        return False, "无 done 事件"
    if done.get("title_regenerated"):
        return False, "自定义标题会话不应触发 title_regenerated"
    if (done.get("conversation_title") or "") != "我的自定义标题":
        return False, f"标题被覆盖为 {done.get('conversation_title')!r}"
    return True, "ok（自定义标题保留，title_regenerated=False）"


def _test_second_turn_no_regen(api_key: str) -> tuple[bool, str]:
    conv_id = _create_conversation(api_key, title=DEFAULT_CONVERSATION_TITLE)
    e1 = _streaming_curl(api_key, conv_id, {"content": "第一问", "enable_web_search": False, "model": "Believeboy-Nano"})
    d1 = _done_of(e1)
    if not d1 or not d1.get("title_regenerated"):
        return False, "首轮未触发自动标题"
    first_title = d1.get("conversation_title")
    e2 = _streaming_curl(api_key, conv_id, {"content": "第二问", "enable_web_search": False, "model": "Believeboy-Nano"})
    d2 = _done_of(e2)
    if not d2:
        return False, "第二轮无 done"
    if d2.get("title_regenerated"):
        return False, "第二轮不应再重算标题"
    if (d2.get("conversation_title") or "") != first_title:
        return False, "第二轮标题发生变化"
    return True, f"ok（仅首轮生成，第二轮保持 {first_title!r}）"


def main() -> int:
    env = _read_env()
    api_key = env.get("API_KEY") or ""
    if not api_key:
        print("✗ 未读到 API_KEY（backend/.env）")
        return 1
    proc = _start_backend()
    try:
        if not _wait_ready():
            print("✗ 后端未 ready")
            return 1
        results = [
            ("首轮默认标题自动生成", *_test_autotitle_first_turn(api_key)),
            ("自定义标题不覆盖", *_test_custom_title_skipped(api_key)),
            ("仅首轮生成（第二轮不重算）", *_test_second_turn_no_regen(api_key)),
        ]
        print("\n=== Phase 3 烟雾测试总览 ===")
        ok = True
        for name, passed, msg in results:
            mark = "✓ PASS" if passed else "✗ FAIL"
            print(f"  {mark} {name} — {msg}")
            ok = ok and passed
        print("=== " + ("ALL PASS" if ok else "SOME FAIL") + " ===")
        return 0 if ok else 1
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
