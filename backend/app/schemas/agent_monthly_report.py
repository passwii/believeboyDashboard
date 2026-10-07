"""Agent 月报写入域请求模型（BLF-1250 阶段一）。

响应体保持 ``dict``（沿用 agent 命名空间 ``agent_ok`` 壳惯例），这里只声明
入口请求体，避免未声明字段被静默接受。
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class MonthlyReportUploadCreateRequest(BaseModel):
    """建临时上传会话：项目名从服务端项目记录解析，客户端只给 id。"""

    project_id: int = Field(gt=0)
    country: str = Field(default="US", max_length=8)
    report_month: str = Field(min_length=7, max_length=7, description="YYYY-MM")


class MonthlyReportBuildCreateRequest(BaseModel):
    """发起仅计算草稿：引用会话内已上传的不透明 file_id。"""

    upload_id: int = Field(gt=0)
    transaction_file_id: str = Field(min_length=1, max_length=64)
    summary_pdf_file_id: str | None = Field(default=None, max_length=64)


__all__ = ["MonthlyReportBuildCreateRequest", "MonthlyReportUploadCreateRequest"]
