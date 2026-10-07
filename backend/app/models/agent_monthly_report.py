"""Agent 月报写入流程的临时状态（BLF-1250 阶段一）。

三张表只承载「临时上传 → 仅计算草稿 → 确认入库」的状态：

* ``AgentMonthlyReportUpload``：一次写入会话（绑定 agent key/项目/国家/月份/期限）；
* ``AgentMonthlyReportFile``：会话内的原始二进制输入（CSV 必选、PDF 可选）；
* ``AgentMonthlyReportBuild``：一次仅计算草稿（结果摘要 + 状态 + 确认后的 report_id）；
* ``AgentMonthlyReportIdempotency``：写请求幂等记录（build 发起 / confirm 入库）。

这些行本身**不是正式财务入库**：``confirmed_at``/``report_id`` 落库前不得写入
``MonthlyReport`` / 交易 / PT3 / PT4 正式表（契约见
``docs/superpowers/plans/2026-10-06-monthly-report-agent-api/2026-10-06-stage-one-contract.md``）。

状态列用 ``String`` 而非 DB enum：阶段一还要在 janitor/超时恢复里新增状态
（``expired`` / ``cancelled``），避免 Postgres 枚举类型在迁移里反复 ALTER。
"""

from __future__ import annotations

import enum
from datetime import datetime

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.session import Base


class AgentMonthlyReportUploadStatus(str, enum.Enum):
    """会话状态（与契约里的 build 状态分开，便于「同会话多 build」）。"""

    open = "open"
    building = "building"
    built = "built"
    confirmed = "confirmed"
    failed = "failed"
    expired = "expired"


class AgentMonthlyReportBuildStatus(str, enum.Enum):
    queued = "queued"
    running = "running"
    success = "success"
    failed = "failed"
    expired = "expired"
    cancelled = "cancelled"


class AgentMonthlyReportFileKind(str, enum.Enum):
    transaction_csv = "transaction_csv"
    summary_pdf = "summary_pdf"


class AgentMonthlyReportUpload(Base):
    __tablename__ = "agent_monthly_report_uploads"
    __table_args__ = (
        Index("idx_amr_uploads_key", "agent_api_key_id"),
        Index("idx_amr_uploads_target", "project_id", "country", "report_month"),
        Index("idx_amr_uploads_status", "status"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # 归属：不设 FK——凭据删除后审计/归属仍需可读（与 agent_api_audit_log 同口径）。
    agent_api_key_id: Mapped[int] = mapped_column(Integer, nullable=False)
    agent_id: Mapped[str] = mapped_column(String(64), nullable=False)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    project_name: Mapped[str] = mapped_column(String(255), nullable=False)
    country: Mapped[str] = mapped_column(String(2), nullable=False)
    report_month: Mapped[str] = mapped_column(String(7), nullable=False)
    status: Mapped[str] = mapped_column(
        String(16),
        nullable=False,
        server_default=AgentMonthlyReportUploadStatus.open.value,
    )
    # 期限在建会话时一次性写定，重试/重放都不延长（契约要求）。
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    files: Mapped[list["AgentMonthlyReportFile"]] = relationship(
        back_populates="upload", cascade="all, delete-orphan"
    )
    builds: Mapped[list["AgentMonthlyReportBuild"]] = relationship(
        back_populates="upload", cascade="all, delete-orphan"
    )


class AgentMonthlyReportFile(Base):
    __tablename__ = "agent_monthly_report_files"
    __table_args__ = (
        UniqueConstraint("upload_id", "kind", name="uq_amr_files_upload_kind"),
        UniqueConstraint("file_id", name="uq_amr_files_file_id"),
        Index("idx_amr_files_upload", "upload_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    upload_id: Mapped[int] = mapped_column(
        ForeignKey("agent_monthly_report_uploads.id", ondelete="CASCADE"),
        nullable=False,
    )
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    # 对 Agent 暴露的不透明 id（UUID hex）；服务端路径永不回传。
    file_id: Mapped[str] = mapped_column(String(64), nullable=False)
    original_filename: Mapped[str] = mapped_column(String(255), nullable=False)
    stored_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    content_type: Mapped[str | None] = mapped_column(String(128), nullable=True)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    upload: Mapped[AgentMonthlyReportUpload] = relationship(back_populates="files")


class AgentMonthlyReportBuild(Base):
    __tablename__ = "agent_monthly_report_builds"
    __table_args__ = (
        Index("idx_amr_builds_upload", "upload_id"),
        Index("idx_amr_builds_key", "agent_api_key_id"),
        Index("idx_amr_builds_status", "status"),
        Index("idx_amr_builds_expires", "expires_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    upload_id: Mapped[int] = mapped_column(
        ForeignKey("agent_monthly_report_uploads.id", ondelete="CASCADE"),
        nullable=False,
    )
    agent_api_key_id: Mapped[int] = mapped_column(Integer, nullable=False)
    agent_id: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(
        String(16),
        nullable=False,
        server_default=AgentMonthlyReportBuildStatus.queued.value,
    )
    celery_task_id: Mapped[str | None] = mapped_column(String(64), nullable=True)

    # 输入摘要：确认时不重算，靠这两个 hash + 期限判定「输入未变」。
    input_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    summary_pdf_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)

    # 仅计算草稿产物（A 单元产出；服务端可信元数据）。
    result_dir: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    payload_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    payload_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    workbook_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    workbook_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    calculation_version: Mapped[int | None] = mapped_column(Integer, nullable=True)

    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    # 建 build 请求的幂等键（与 AgentMonthlyReportIdempotency 双写：本列便于
    # 直接按 build 查重，幂等表负责「同 key 异体 → 409」）。
    idempotency_key: Mapped[str | None] = mapped_column(String(64), nullable=True)

    # 确认入库结果：report_id 落库 + confirmed_at 才代表正式写入。
    confirmed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    report_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    confirm_idempotency_key: Mapped[str | None] = mapped_column(String(64), nullable=True)

    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    finished_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    upload: Mapped[AgentMonthlyReportUpload] = relationship(back_populates="builds")


class AgentMonthlyReportIdempotency(Base):
    """写请求幂等台账（build 发起 / confirm 入库）。

    契约要求「同幂等键 + 同请求体 → 返回原结果，不新增版本；同幂等键 + 异体 →
    409」。confirm 的响应丢失重试因此不能只依赖 Redis 单次 token：token 已被
    原子 pop，重放必须命中本表。唯一键 ``(agent_api_key_id, action, key)``
    是并发去重的数据库事实源。
    """

    __tablename__ = "agent_monthly_report_idempotency"
    __table_args__ = (
        UniqueConstraint(
            "agent_api_key_id",
            "action",
            "idempotency_key",
            name="uq_amr_idempotency_key_action",
        ),
        Index("idx_amr_idempotency_build", "build_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    agent_api_key_id: Mapped[int] = mapped_column(Integer, nullable=False)
    action: Mapped[str] = mapped_column(String(32), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(64), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    build_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    report_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


__all__ = [
    "AgentMonthlyReportBuild",
    "AgentMonthlyReportBuildStatus",
    "AgentMonthlyReportFile",
    "AgentMonthlyReportFileKind",
    "AgentMonthlyReportIdempotency",
    "AgentMonthlyReportUpload",
    "AgentMonthlyReportUploadStatus",
]
