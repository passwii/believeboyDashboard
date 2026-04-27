"""
数字员工 HTTP API Client。
供本地 Agent（Claude Code）调用，向远程后端上报心跳、任务进度和日志。
"""

from __future__ import annotations

import json
import logging
import os
import urllib.request
import urllib.error
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)


class DigitalEmployeeAPIError(Exception):
    """API 调用失败（已知的 4xx/5xx）"""
    def __init__(self, status_code: int, message: str):
        self.status_code = status_code
        super().__init__(message)


class DigitalEmployeeClient:
    """
    通过 HTTP API 与远程数字员工后端交互。

    使用方式（本地 Agent）：
        client = DigitalEmployeeClient.from_env()
        task_id = client.start_task("代码审查", "CODE_REVIEW")
        client.update_progress(task_id, "RUNNING", 50, "审查第 3/6 个文件")
        client.log(task_id, "WARN", "发现潜在的空指针引用")
        client.complete(task_id, metadata={"issues_found": 3, "risk": "medium"})
    """

    def __init__(
        self,
        base_url: str,
        employee_id: int,
        api_secret: str,
    ):
        self.base_url = base_url.rstrip("/")
        self.employee_id = employee_id
        self.api_secret = api_secret
        self._task_id: str | None = None

    @classmethod
    def from_env(cls) -> "DigitalEmployeeClient":
        """从环境变量读取配置"""
        base_url = os.environ.get("DIGITAL_EMPLOYEE_API_BASE_URL")
        employee_id = os.environ.get("DIGITAL_EMPLOYEE_ID")
        api_secret = os.environ.get("DIGITAL_EMPLOYEE_API_SECRET")

        missing = [k for k, v in [
            ("DIGITAL_EMPLOYEE_API_BASE_URL", base_url),
            ("DIGITAL_EMPLOYEE_ID", employee_id),
            ("DIGITAL_EMPLOYEE_API_SECRET", api_secret),
        ] if not v]

        if missing:
            raise EnvironmentError(
                f"Missing required environment variables: {', '.join(missing)}. "
                "Run `python scripts/seed_digital_employees.py` first to register."
            )

        return cls(base_url=base_url, employee_id=int(employee_id), api_secret=api_secret)

    # ── Low-level HTTP ─────────────────────────────────────────────────────────

    def _request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        timeout: int = 10,
    ) -> dict[str, Any] | None:
        """发送 HTTP 请求，失败时静默降级（返回 None）"""
        url = f"{self.base_url}{path}"
        headers = {
            "Content-Type": "application/json",
            "X-API-Secret": self.api_secret,
        }
        data = json.dumps(body).encode("utf-8") if body is not None else None

        try:
            req = urllib.request.Request(url, data=data, headers=headers, method=method)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                if resp.status == 204:
                    return None
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            try:
                body_text = exc.read().decode("utf-8")
                payload = json.loads(body_text)
                detail = payload.get("detail", str(exc))
            except Exception:
                detail = str(exc)
            logger.warning("[DigitalEmployeeClient] HTTP %d %s: %s", exc.code, url, detail)
            return None
        except urllib.error.URLError as exc:
            logger.warning("[DigitalEmployeeClient] Network error %s: %s", url, exc.reason)
            return None
        except Exception as exc:
            logger.warning("[DigitalEmployeeClient] Unexpected error %s: %s", url, exc)
            return None

    # ── Task lifecycle ─────────────────────────────────────────────────────────

    def start_task(self, task_name: str, task_type: str = "code_review") -> str:
        """
        注册一个新任务，返回 task_id。
        内部会创建一个 UUID 格式的 task_id。
        """
        import uuid
        task_id = f"code-review-{uuid.uuid4().hex[:12]}"

        payload = {
            "task_id": task_id,
            "task_name": task_name,
            "task_type": task_type,
            "status": "RUNNING",
            "progress_percent": 0,
            "current_step": "初始化",
        }

        result = self._request(
            "POST",
            f"/api/v1/digital-employees/{self.employee_id}/heartbeat",
            body=payload,
        )

        if result is None:
            logger.warning("[DigitalEmployeeClient] start_task: API unreachable, continuing locally")
        else:
            self._task_id = task_id
        return task_id

    def update_progress(
        self,
        task_id: str,
        status: str = "RUNNING",
        progress: int = 0,
        step: str = "",
        message: str | None = None,
    ) -> None:
        """
        上报任务进度。

        status: PENDING | RUNNING | SUCCEEDED | FAILED | CANCELLED
        progress: 0-100
        step: 当前步骤描述（会显示在 Dashboard 上）
        """
        payload = {
            "task_id": task_id,
            "status": status.upper(),
            "progress_percent": max(0, min(100, progress)),
            "current_step": step,
        }
        if message:
            payload["message"] = message
        self._request(
            "POST",
            f"/api/v1/digital-employees/{self.employee_id}/heartbeat",
            body=payload,
        )

    def log(
        self,
        task_id: str,
        level: str = "INFO",
        message: str = "",
    ) -> None:
        """
        写入一条日志（会出现在 ActivityFeed 中）。
        level: DEBUG | INFO | WARN | ERROR
        """
        self._request(
            "POST",
            f"/api/v1/digital-employees/{self.employee_id}/tasks/{task_id}/logs",
            body={"level": level.upper(), "message": message},
        )

    def complete(
        self,
        task_id: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """
        标记任务完成，并写入汇总元数据。
        metadata 会以 JSON 字符串存储在 task.metadata_json 中。
        """
        self.update_progress(task_id, "SUCCEEDED", 100, "完成")
        if metadata:
            # metadata 通过 heartbeat message 传递，不影响 API 契约
            self._request(
                "POST",
                f"/api/v1/digital-employees/{self.employee_id}/heartbeat",
                body={
                    "task_id": task_id,
                    "status": "SUCCEEDED",
                    "progress_percent": 100,
                    "current_step": "完成",
                    "message": f"完成，摘要: {json.dumps(metadata, ensure_ascii=False)}",
                },
            )
        self._task_id = None

    def fail(self, task_id: str, error: str) -> None:
        """标记任务失败"""
        self.update_progress(task_id, "FAILED", 0, "失败")
        self.log(task_id, "ERROR", f"任务失败: {error}")
        self._task_id = None

    # ── Convenience ────────────────────────────────────────────────────────────

    def report_start(self, task_name: str) -> str:
        """便捷别名：开始一个任务"""
        return self.start_task(task_name)

    def report_done(
        self,
        files_reviewed: int = 0,
        issues_found: int = 0,
        risk: str = "low",
        summary: str = "",
    ) -> None:
        """便捷别名：完成并写入汇总"""
        if self._task_id:
            self.complete(
                self._task_id,
                metadata={
                    "files_reviewed": files_reviewed,
                    "issues_found": issues_found,
                    "risk": risk,
                    "summary": summary,
                },
            )
