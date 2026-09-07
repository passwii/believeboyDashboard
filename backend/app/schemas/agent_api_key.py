"""Schemas for Agent API key admin endpoints（BEL-377，改名见设计稿 §11）。"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class ApiKeyCreateRequest(BaseModel):
    label: str = Field(min_length=1, max_length=128, description="人类可读标识")
    scope: str = Field(default="read", max_length=64)
    project_scope: str = Field(
        default="*",
        max_length=255,
        description="项目范围：'*' 全部，或 ',' 分隔的 project_id 白名单（空串按 '*' 处理）",
    )
    business_scope: str = Field(
        default="*",
        max_length=255,
        description="业务域范围：'*' 全部，或 ',' 分隔的域 code 白名单（空串按 '*' 处理）",
    )
    expires_at: datetime | None = Field(
        default=None, description="ISO 过期时间；null = 永不过期"
    )
    agent_id: str | None = Field(
        default=None,
        max_length=128,
        description="绑定的 Agent 稳定标识；Agent 凭据必填，存量 external key 留空",
    )
    item_key: str | None = Field(
        default=None,
        max_length=128,
        description="外部 agent 平台身份引用（BLF-843，如 multica://<workspace>/agent/<id>）；仅标注不参与鉴权",
    )


class ApiKeyUpdateRequest(BaseModel):
    """编辑请求（BLF-480）：PATCH 语义，仅更新显式传入的字段。

    ``label`` / ``project_scope`` / ``business_scope`` 均可缺省（None = 不改）；
    空串归一为 ``*`` 在 service 层与 create 对齐。
    """

    label: str | None = Field(
        default=None, min_length=1, max_length=128, description="人类可读标识"
    )
    project_scope: str | None = Field(
        default=None,
        max_length=255,
        description="项目范围：'*' 全部，或 ',' 分隔的 project_id 白名单（空串按 '*' 处理）",
    )
    business_scope: str | None = Field(
        default=None,
        max_length=255,
        description="业务域范围：'*' 全部，或 ',' 分隔的域 code 白名单（空串按 '*' 处理）",
    )
    item_key: str | None = Field(
        default=None,
        max_length=128,
        description="外部 agent 平台身份引用（空串清除标注）",
    )


class ApiKeyCreateResponse(BaseModel):
    id: int
    key_prefix: str
    label: str
    scope: str
    project_scope: str
    business_scope: str
    agent_id: str | None
    item_key: str | None = None
    expires_at: datetime | None
    created_at: datetime
    # Shown exactly once — the stored row only holds the SHA-256 hash.
    plaintext_key: str


class ApiKeyItem(BaseModel):
    id: int
    key_prefix: str
    label: str
    scope: str
    project_scope: str
    business_scope: str
    agent_id: str | None
    item_key: str | None = None
    is_revoked: bool
    expires_at: datetime | None
    created_at: datetime
    last_used_at: datetime | None
    # 软删除 tombstone（BLF-468）；默认列表隐藏，``?include_deleted=true`` 全量
    deleted_at: datetime | None = None

    model_config = {"from_attributes": True}


class ApiKeyRevokeResponse(BaseModel):
    id: int
    is_revoked: bool


class ApiKeyDeactivateResponse(BaseModel):
    """``POST .../{id}/deactivate`` 响应（BLF-468，``/revoke`` 兼容别名）。"""

    id: int
    is_revoked: bool


class ApiKeyActivateResponse(BaseModel):
    """``POST .../{id}/activate`` 响应（BLF-468）。"""

    id: int
    is_revoked: bool


class AgentProvisionKeyEditRequest(BaseModel):
    """Agent 编辑现有凭据请求（BLF-987，``PATCH /api/v1/agent/provisioning/keys/{key_id}``）。

    与 ``ApiKeyUpdateRequest`` 差异：
    - 所有字段可选（PATCH 语义）
    - project_scope / business_scope 必须显式白名单（禁 "*"）
    - 编辑后即刻生效（鉴权路径每请求实时读列）
    """

    model_config = {"extra": "forbid"}

    label: str | None = Field(
        default=None, min_length=1, max_length=128, description="目标 Agent 中文名"
    )
    project_scope: str | None = Field(
        default=None,
        max_length=255,
        description=",分隔的 project_id 白名单；禁止 '*'",
    )
    business_scope: str | None = Field(
        default=None,
        max_length=255,
        description=",分隔的域 code 白名单；禁止 '*'",
    )
    item_key: str | None = Field(
        default=None,
        max_length=128,
        description="外部 agent 平台身份引用（空串清除标注）",
    )


class AgentProvisionKeyRequest(BaseModel):
    """Agent 自助签发请求（BLF-843，``/api/v1/agent/provisioning/keys``）。

    与 ``ApiKeyCreateRequest`` 的差异：

    * ``agent_id`` **必填**——签发的就是 Agent 凭据；
    * ``project_scope`` / ``business_scope`` **必填显式白名单**（禁 "*"，
      服务端 ``_validate`` 再拦一道）；
    * 不暴露 ``scope`` 列（服务端固定 "read"）。
    """

    model_config = {"extra": "forbid"}

    label: str = Field(min_length=1, max_length=128, description="目标 Agent 中文名")
    agent_id: str = Field(
        min_length=3,
        max_length=128,
        description="目标 Agent 稳定标识（如 inventory-simon-v1）",
    )
    project_scope: str = Field(
        min_length=1,
        max_length=255,
        description=",分隔的 project_id 白名单；禁止 '*'",
    )
    business_scope: str = Field(
        min_length=1,
        max_length=255,
        description=",分隔的域 code 白名单；禁止 '*'",
    )
    item_key: str | None = Field(
        default=None,
        max_length=128,
        description="外部 agent 平台身份引用（可空）",
    )
    expires_at: datetime | None = Field(
        default=None,
        description="ISO 过期时间；null = 永不过期（用户拍板默认永久）",
    )
