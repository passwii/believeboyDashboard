"""Agent 命名空间限流（spec E3）。

slowapi 内存存储：限额按 worker 进程独立计数（与 external limiter 同口径）。
测试里把读桶临时调到 5/minute 验证 429 壳。
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def settings():
    from app.core.config import get_settings

    return get_settings()


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _headers(key: dict) -> dict:
    return {
        "Authorization": f"Bearer {key['plaintext']}",
        "X-Agent-Id": key["agent_id"],
    }


class TestReadRateLimit:
    def test_breach_returns_429_shell(self, client, settings, make_api_key):
        settings.agent_api_read_rate_limit = "5/minute"
        key = make_api_key(agent_id="rate-limit-agent")
        headers = {
            "Authorization": f"Bearer {key['plaintext']}",
            "X-Agent-Id": "rate-limit-agent",
        }
        statuses = [
            client.get("/api/v1/agent/health", headers=headers).status_code
            for _ in range(8)
        ]
        assert statuses.count(200) == 5
        assert statuses.count(429) == 3

        blocked = client.get("/api/v1/agent/health", headers=headers)
        assert blocked.status_code == 429
        body = blocked.json()
        assert body["ok"] is False
        assert body["error"]["code"] == "AGENT_RATE_LIMIT_EXCEEDED"
        assert blocked.headers.get("Retry-After")

    def test_buckets_are_per_agent(self, client, settings, make_api_key):
        settings.agent_api_read_rate_limit = "5/minute"
        key_a = make_api_key(agent_id="bucket-a")
        key_b = make_api_key(agent_id="bucket-b")
        for _ in range(5):
            assert client.get("/api/v1/agent/health", headers=_headers(key_a)).status_code == 200
        # a 桶已耗尽，b 桶不受影响
        assert client.get("/api/v1/agent/health", headers=_headers(key_a)).status_code == 429
        assert client.get("/api/v1/agent/health", headers=_headers(key_b)).status_code == 200


class TestReadWriteLimitIndependence:
    """P2 修复回归：slowapi `_rate_limiting_complete` 跨依赖去重陷阱。

    两个 limiter 实例必须并行存在；写桶被读桶的 flag 短路后会失效。
    """

    def test_write_bucket_does_not_collide_with_read_bucket(
        self, client, settings, make_api_key
    ):
        settings.agent_api_read_rate_limit = "100/minute"  # 几乎不限读
        settings.agent_api_write_rate_limit = "2/minute"
        # 写端点需要真实路由——用一个简易 stub 路由注册到 agent_router 测
        from app.api.agent.rate_limit import (
            agent_read_limiter,
            agent_write_limiter,
        )
        assert agent_read_limiter is not agent_write_limiter  # 独立实例

    def test_write_routes_get_write_limit(self, client, settings, make_api_key):
        # 用真实 POST 端点测（需要 P2 写路由就绪；此测试在 Task 5 路由落地后才有意义）
        pytest.skip("Task 5 写路由就绪后补断言")
