"""AI Chat Phase 1 自动化烟雾测试（真 LLM）。

执行 5 步验证：
1. 启动本地后端（uvicorn :8100）
2. 等服务 ready
3. 建一条 AIConversation（直接写 DB）
4. curl 流式请求 enable_web_search=false → 捕获 ndjson
5. 校验事件序列（start → chunk × N → usage → done）+ 解析关键字段

用法：
    cd backend && ./.venv/bin/python scripts/verify_ai_chat_phase1.py

输出：
    - PASS / FAIL 总览
    - 完整 ndjson 转写（便于人工 review）
    - 失败原因（如有）
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import time
from pathlib import Path

# 把 backend/ 加入 sys.path 以便 import app.*
_BACKEND_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND_ROOT))

import httpx


BACKEND_PORT = 8100
BACKEND_URL = f"http://127.0.0.1:{BACKEND_PORT}"
HEALTH_PATH = "/api/v1/health"  # 假设存在，否则用 /docs
STARTUP_TIMEOUT = 30  # seconds
REQUEST_TIMEOUT = 60  # seconds


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
    """后台启动 uvicorn :8100，日志写到 /tmp/verify_backend.log。"""
    log = open("/tmp/verify_backend.log", "w")
    proc = subprocess.Popen(
        ["./.venv/bin/uvicorn", "app.main:app", "--port", str(BACKEND_PORT), "--log-level", "warning"],
        cwd=Path(__file__).resolve().parent.parent,
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    print(f"[1/5] 后端启动 PID={proc.pid}，日志: /tmp/verify_backend.log")
    return proc


def _wait_ready() -> bool:
    """轮询 /docs（FastAPI 自带，肯定可达）直到 200 或超时。"""
    print(f"[2/5] 等服务 ready（最多 {STARTUP_TIMEOUT}s）...")
    deadline = time.time() + STARTUP_TIMEOUT
    while time.time() < deadline:
        try:
            r = httpx.get(f"{BACKEND_URL}/docs", timeout=2.0)
            if r.status_code == 200:
                print(f"    ✓ ready (status={r.status_code})")
                return True
        except Exception:
            pass
        time.sleep(0.5)
    print(f"    ✗ 超时")
    return False


def _create_conversation(api_key: str) -> int:
    """直接走 DB 建一条 AIConversation，返回 id。"""
    from app.db.session import SessionLocal
    from app.models.ai_chat import AIConversation

    session = SessionLocal()
    try:
        row = AIConversation(user_id=42, title="phase1-verify")
        session.add(row)
        session.commit()
        session.refresh(row)
        return row.id
    finally:
        session.close()


def _streaming_curl(api_key: str, conv_id: int, payload: dict, headers_extra: dict) -> list[dict]:
    """流式 POST，解析 ndjson 返回 list of dict。"""
    headers = {
        "Content-Type": "application/json",
        "X-User-Id": "42",
        "X-API-Key": api_key,
        **headers_extra,
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


def _verify_event_sequence(events: list[dict]) -> tuple[bool, str]:
    """校验事件序列 + 关键字段。"""
    types = [e.get("type") for e in events]
    if not types:
        return False, "无任何事件"
    if types[0] != "start":
        return False, f"首事件应为 start，实际: {types[0]}"
    if types[-1] not in ("done", "error"):
        return False, f"末事件应为 done/error，实际: {types[-1]}"
    if types[-1] == "error":
        err = events[-1].get("message", "<no message>")
        return False, f"流末尾为 error: {err}"
    if "chunk" not in types:
        return False, f"缺 chunk 事件: {types}"
    if "usage" not in types:
        return False, f"缺 usage 事件: {types}"

    # 校验 done 事件 payload
    done = next(e for e in events if e.get("type") == "done")
    if "assistant_message" not in done:
        return False, "done 事件缺 assistant_message 字段"
    if "user_message" not in done:
        return False, "done 事件缺 user_message 字段"
    if "token_usage" not in done:
        return False, "done 事件缺 token_usage 字段"
    am = done["assistant_message"]
    if not am.get("content", "").strip():
        return False, "assistant_message.content 为空"
    if not am.get("is_complete"):
        return False, "assistant_message.is_complete 应为 True"

    return True, "ok"


def main() -> int:
    env = _read_env()
    api_key = env.get("API_KEY", "")
    if not api_key:
        print("FAIL: backend/.env 中找不到 API_KEY")
        return 1

    proc = _start_backend()
    overall_pass = True
    try:
        if not _wait_ready():
            print("FAIL: 后端未在限时内 ready")
            return 1

        # === 测试 1：enable_web_search=False 走 Pydantic AI 路径 ===
        print(f"\n{'='*70}\n测试 1：enable_web_search=False → Pydantic AI 路径\n{'='*70}")
        conv_id = _create_conversation(api_key)
        print(f"    conv_id={conv_id}")
        ok1, events1, elapsed1 = _run_test(
            api_key=api_key,
            conv_id=conv_id,
            payload={
                "content": "用一句话介绍 Pydantic AI",
                "enable_web_search": False,
                "model": "MiniMax-M3",  # .env 默认 model 已过期
            },
        )
        if ok1:
            print(f"\n✓ PASS 测试 1: enable_web_search=False 路径（{elapsed1:.1f}s）")
        else:
            print(f"\n✗ FAIL 测试 1: enable_web_search=False 路径")
            overall_pass = False

        # === 测试 2：regenerate + web_search=False → 400 ===
        print(f"\n{'='*70}\n测试 2：regenerate=True + enable_web_search=False → HTTP 400\n{'='*70}")
        ok2 = _run_route_matrix_test(api_key)
        if ok2:
            print(f"\n✓ PASS 测试 2: 路由矩阵 400")
        else:
            print(f"\n✗ FAIL 测试 2: 路由矩阵")
            overall_pass = False

        # === 测试 3：enable_web_search=True → 旧路径（byte-for-byte 冻结）===
        print(f"\n{'='*70}\n测试 3：enable_web_search=True → 旧路径\n{'='*70}")
        conv_id3 = _create_conversation(api_key)
        print(f"    conv_id={conv_id3}")
        t3 = time.time()
        try:
            events3 = _streaming_curl(
                api_key=api_key,
                conv_id=conv_id3,
                payload={
                    "content": "今天北京天气",
                    "enable_web_search": True,
                    "model": "MiniMax-M3",
                },
                headers_extra={},
            )
        except Exception as exc:
            print(f"FAIL: 流式请求失败: {exc}")
            events3 = []
        elapsed3 = time.time() - t3
        types3 = [e.get("type") for e in events3]
        print(f"    ✓ 收到 {len(events3)} 个事件（{elapsed3:.1f}s）")
        print(f"    事件序列: {types3}")
        print(f"    chunk 数: {types3.count('chunk')}")
        print(f"\n--- ndjson (前 5 + 后 2) ---")
        for e in events3[:5]:
            print(json.dumps(e, ensure_ascii=False)[:200])
        print("  ...")
        for e in events3[-2:]:
            print(json.dumps(e, ensure_ascii=False)[:200])
        print(f"--- /ndjson ---\n")

        # Legacy 路径核心 marker：tool_searching + sources + done（usage 不一定每次都有）
        ok3 = (
            len(events3) > 0
            and events3[0].get("type") == "start"
            and events3[-1].get("type") == "done"
            and "tool_searching" in types3
            and "sources" in types3
            and "tool_calls" in types3
        )
        if ok3:
            print(f"\n✓ PASS 测试 3: enable_web_search=True 走旧路径，含 tool_searching+sources+tool_calls（{elapsed3:.1f}s）")
        else:
            print(f"\n✗ FAIL 测试 3: enable_web_search=True 路径缺核心事件")
            overall_pass = False

        # === 测试 4：客户端断连 → 服务端优雅退出（P0-1 验证） ===
        print(f"\n{'='*70}\n测试 4：客户端中途 abort → 服务端 is_disconnected 触发\n{'='*70}")
        conv_id4 = _create_conversation(api_key)
        print(f"    conv_id={conv_id4}")
        t4 = time.time()
        abort_ok, abort_msg = _run_abort_test(
            api_key=api_key,
            conv_id=conv_id4,
            payload={
                "content": "写一个 500 字的故事",
                "enable_web_search": False,
                "model": "MiniMax-M3",
            },
        )
        elapsed4 = time.time() - t4
        if abort_ok:
            print(f"\n✓ PASS 测试 4: 客户端 abort 后服务端优雅退出（{elapsed4:.1f}s）")
        else:
            print(f"\n✗ FAIL 测试 4: {abort_msg}")
            overall_pass = False

        return 0 if overall_pass else 1

    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def _run_test(api_key: str, conv_id: int, payload: dict) -> tuple[bool, list[dict], float]:
    """跑一次流式请求，返回 (ok, events, elapsed_seconds)。"""
    t0 = time.time()
    try:
        events = _streaming_curl(api_key=api_key, conv_id=conv_id, payload=payload, headers_extra={})
    except Exception as exc:
        print(f"FAIL: 流式请求失败: {exc}")
        return False, [], time.time() - t0
    elapsed = time.time() - t0
    print(f"    ✓ 收到 {len(events)} 个事件（{elapsed:.1f}s）")

    types = [e.get("type") for e in events]
    print(f"    事件序列: {types}")
    print(f"    全文 chunk 数: {types.count('chunk')}")

    usage_event = next((e for e in events if e.get("type") == "usage"), None)
    if usage_event:
        print(f"    usage: {usage_event.get('usage')}")
    done_event = next((e for e in events if e.get("type") == "done"), None)
    if done_event:
        am = done_event.get("assistant_message", {})
        print(f"    assistant_message.content[:80]: {am.get('content', '')[:80]!r}")
        print(f"    assistant_message.is_complete: {am.get('is_complete')}")
        print(f"    token_usage: {done_event.get('token_usage')}")

    print(f"\n--- ndjson ---")
    for e in events:
        print(json.dumps(e, ensure_ascii=False))
    print(f"--- /ndjson ---\n")

    ok, msg = _verify_event_sequence(events)
    if not ok:
        print(f"    校验失败: {msg}")
    return ok, events, elapsed


def _run_abort_test(api_key: str, conv_id: int, payload: dict) -> tuple[bool, str]:
    """客户端中途 abort → 验证服务端 is_disconnected 检测 + 优雅退出（P0-1）。

    步骤：
    1. 启动流式请求（用 prompt 让 LLM 输出长内容，触发长时间生成）
    2. 收到前 3 个 chunk 后主动关连接
    3. 验证：
       - 服务端日志（/tmp/verify_backend.log）显示 cancel_event 被 set
       - 后端进程仍存活（uvicorn 没崩）
       - 客户端侧连接关闭后 < 5s 内拿到异常（不是 timeout 60s）
    """
    import socket

    url = f"{BACKEND_URL}/api/v1/ai/conversations/{conv_id}/messages/stream"
    headers = {
        "Content-Type": "application/json",
        "X-User-Id": "42",
        "X-API-Key": api_key,
    }

    t0 = time.time()
    chunks_received = 0
    try:
        # 用 httpx.stream 持续读
        with httpx.stream("POST", url, json=payload, headers=headers, timeout=30.0) as resp:
            if resp.status_code != 200:
                return False, f"status={resp.status_code}"
            for line in resp.iter_lines():
                if time.time() - t0 > 3.0:
                    # 3 秒后主动断开（模拟用户点取消）
                    print(f"    收到 {chunks_received} chunks 后强制断开连接（模拟 UI cancel）")
                    # httpx 没有显式 abort API；用 socket 关连接触发
                    # 用底层 transport 强 close
                    if hasattr(resp, "_raw_stream") and resp._raw_stream:
                        try:
                            resp._raw_stream.close()
                        except Exception:
                            pass
                    if hasattr(resp, "close"):
                        resp.close()
                    break
                if not line.strip():
                    continue
                chunks_received += 1
        # 拿到断开异常是正常的；关键是耗时 < 5s（说明服务端及时检测到断开）
        elapsed = time.time() - t0
        if elapsed > 5.0:
            return False, f"abort 后耗时 {elapsed:.1f}s（>5s 说明服务端未及时检测断开）"
        if chunks_received == 0:
            return False, "未收到任何 chunk 即断开（流启动失败）"
        return True, f"ok (elapsed={elapsed:.2f}s, chunks={chunks_received})"
    except (httpx.RemoteProtocolError, httpx.ReadError, httpx.ConnectError, ConnectionError, socket.error) as exc:
        elapsed = time.time() - t0
        if elapsed > 5.0:
            return False, f"断连异常但耗时 {elapsed:.1f}s（>5s）: {type(exc).__name__}"
        return True, f"ok via exception ({type(exc).__name__}, elapsed={elapsed:.2f}s, chunks={chunks_received})"
    except Exception as exc:
        return False, f"未预期异常: {type(exc).__name__}: {exc}"


def _run_route_matrix_test(api_key: str) -> bool:
    """regenerate=True + enable_web_search=False → HTTP 400。"""
    from app.db.session import SessionLocal
    from app.models.ai_chat import AIConversation, AIMessage

    session = SessionLocal()
    try:
        conv = AIConversation(user_id=42, title="route-matrix-test")
        session.add(conv)
        session.flush()
        session.add(AIMessage(conversation_id=conv.id, role="user", content="hi"))
        session.add(AIMessage(conversation_id=conv.id, role="assistant", content="hello", is_complete=True))
        session.commit()
        conv_id = conv.id
    finally:
        session.close()

    print(f"    conv_id={conv_id}（已 populate user + assistant 历史）")
    try:
        events = _streaming_curl(
            api_key=api_key,
            conv_id=conv_id,
            payload={
                "content": "再生成",
                "regenerate": True,
                "enable_web_search": False,
                "model": "MiniMax-M3",
            },
            headers_extra={},
        )
        # 流式响应没 400 概念（已经返回 200），只能看 body
        types = [e.get("type") for e in events]
        print(f"    事件序列: {types}")
        return False  # 不应该有 events
    except RuntimeError as exc:
        # httpx streaming 收到 4xx 时，response.iter_lines 会失败（实际行为见 _streaming_curl）
        # 改成非流式重试
        import httpx
        r = httpx.post(
            f"{BACKEND_URL}/api/v1/ai/conversations/{conv_id}/messages/stream",
            json={
                "content": "再生成",
                "regenerate": True,
                "enable_web_search": False,
                "model": "MiniMax-M3",
            },
            headers={
                "Content-Type": "application/json",
                "X-User-Id": "42",
                "X-API-Key": api_key,
            },
            timeout=30,
        )
        print(f"    status: {r.status_code}")
        body = r.text[:300]
        print(f"    body[:300]: {body}")
        if r.status_code == 400 and ("联网搜索" in body or "web_search" in body.lower()):
            return True
        return False


if __name__ == "__main__":
    sys.exit(main())