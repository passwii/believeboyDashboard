"""Durable Insight run record (BLF-1011).

Independent from the legacy ``ai_insights`` table: new Insight infrastructure
tracks each request as a durable run with idempotency key, attempt counter,
state timeline, resolved endpoint/model, usage, final Markdown outputs and
typed error. No per-token writes — the executor accumulates content in memory
and persists once at terminal state.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, Index, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.session import Base


class InsightRun(Base):
    """A single durable Insight execution attempt chain."""

    __tablename__ = "insight_runs"
    __table_args__ = (
        UniqueConstraint(
            "project_id",
            "country",
            "idempotency_key",
            name="uq_insight_runs_scope_idempotency",
        ),
        Index("ix_insight_runs_run_id", "run_id", unique=True),
        Index("ix_insight_runs_scope", "project_id", "country"),
        Index("ix_insight_runs_status", "status"),
    )

    # Repository migration convention: plain Integer primary key.
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)

    #: Stable public identifier (UUID4 hex string); Celery task argument.
    #: 唯一性由 ix_insight_runs_run_id（unique index）承担，与迁移 267 一致。
    run_id: Mapped[str] = mapped_column(String(36), nullable=False)
    #: Attempt counter; explicit retry bumps it, Celery redelivery does not.
    attempt: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default="1"
    )

    #: Unified AI capability name (always ``insight``); business extension point.
    capability: Mapped[str] = mapped_column(
        String(64), nullable=False, default="insight", server_default="insight"
    )
    #: Role canonical key, e.g. ``schedule_report_summary.v1``.
    use_case: Mapped[str] = mapped_column(String(128), nullable=False)

    #: Request scope: project/country validated by the scope authorizer.
    project_id: Mapped[int] = mapped_column(Integer, nullable=False)
    country: Mapped[str] = mapped_column(String(2), nullable=False)

    role_id: Mapped[str] = mapped_column(String(128), nullable=False)
    role_version: Mapped[int] = mapped_column(Integer, nullable=False)
    endpoint_id: Mapped[str] = mapped_column(String(64), nullable=False)
    model_id: Mapped[str] = mapped_column(String(128), nullable=False)

    #: InsightStatus value; transitions enforced by lifecycle.require_transition.
    status: Mapped[str] = mapped_column(
        String(32), nullable=False, default="queued", server_default="queued"
    )
    #: InsightStage value; terminal runs keep their last active stage.
    stage: Mapped[str] = mapped_column(
        String(32), nullable=False, default="queued", server_default="queued"
    )
    progress_percent: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )

    idempotency_key: Mapped[str] = mapped_column(String(64), nullable=False)
    #: SHA-256 over the canonical request (see validator.fingerprint_of).
    request_fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)

    #: Canonical JSON of the validated slots (retry reuses it, no LLM recall).
    slots_json: Mapped[str] = mapped_column(
        Text, nullable=False, default="{}", server_default="{}"
    )
    #: JSON list of ``{status, attempt, at}`` entries, append-only.
    status_timeline_json: Mapped[str] = mapped_column(
        Text, nullable=False, default="[]", server_default="[]"
    )

    #: JSON InsightUsage; written once at terminal state.
    usage_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: JSON ``{slot: {format, content, content_sha256}}``; terminal only.
    outputs_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: Final Markdown of the default output slot; terminal only.
    content_markdown: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: JSON typed InsightError; terminal failed/cancelled only.
    error_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )
