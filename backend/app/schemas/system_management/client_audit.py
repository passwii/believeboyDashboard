"""
客户端审计 Schema。
"""
from pydantic import BaseModel, Field


class OperationAuditClientActionRequest(BaseModel):
    action: str = Field(min_length=1, max_length=128)
    target_type: str = Field(min_length=1, max_length=64)
    target_id: str | None = Field(default=None, max_length=128)
    result: str = Field(default="success", pattern="^(success|failure)$")
    after: dict | list | None = None
    error_message: str | None = Field(default=None, max_length=4000)