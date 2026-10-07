"""Agent 月报临时件生命周期测试（BLF-1250 阶段一，janitor）。

覆盖「24 小时到期清理、运行中任务不被清理、超过硬超时恢复为 failed 再清理、
正式目录永不被触碰、孤儿目录兜底」。
"""

from __future__ import annotations

import os
import uuid
from datetime import timedelta

import pytest

from app.core.config import get_settings
from app.db.session import SessionLocal
from app.models import Project
from app.models.agent_monthly_report import (
    AgentMonthlyReportBuild,
    AgentMonthlyReportBuildStatus,
    AgentMonthlyReportUpload,
    AgentMonthlyReportUploadStatus,
)
from app.services.agent_monthly_report_common import (
    build_dir,
    prepare_private_dir,
    upload_dir,
    utc_now,
)
from app.services.agent_monthly_report_janitor import sweep


@pytest.fixture
def janitor_env(tmp_path, monkeypatch):
    settings = get_settings()
    root = tmp_path / "agent_monthly_reports"
    monkeypatch.setattr(settings, "agent_monthly_report_root", root)
    monkeypatch.setattr(settings, "agent_monthly_report_build_timeout_minutes", 25)
    monkeypatch.setattr(settings, "agent_monthly_report_ttl_hours", 24)
    formal_root = tmp_path / "uploads"
    monkeypatch.setattr(settings, "upload_root", formal_root)
    formal_root.mkdir(parents=True, exist_ok=True)

    db = SessionLocal()
    try:
        project = Project(
            project_name=f"janitor-{uuid.uuid4().hex[:8]}",
            project_operator="pytest",
            assistant_operator=None,
            sort_order=0,
            is_active=True,
        )
        db.add(project)
        db.commit()
        db.refresh(project)
        project_id = project.id
        project_name = project.project_name
    finally:
        db.close()

    yield {
        "project_id": project_id,
        "project_name": project_name,
        "settings": settings,
        "root": root,
        "formal_root": formal_root,
    }

    db = SessionLocal()
    try:
        db.query(AgentMonthlyReportUpload).filter(
            AgentMonthlyReportUpload.project_id == project_id
        ).delete()
        obj = db.get(Project, project_id)
        if obj is not None:
            db.delete(obj)
        db.commit()
    finally:
        db.close()


def _make_upload(env, *, expires_in_minutes: int, status: str) -> AgentMonthlyReportUpload:
    db = SessionLocal()
    try:
        upload = AgentMonthlyReportUpload(
            agent_api_key_id=1,
            agent_id="janitor-agent",
            project_id=env["project_id"],
            project_name=env["project_name"],
            country="US",
            report_month="2026-10",
            status=status,
            expires_at=utc_now() + timedelta(minutes=expires_in_minutes),
        )
        db.add(upload)
        db.commit()
        db.refresh(upload)
        prepare_private_dir(upload_dir(env["settings"], upload.id))
        (upload_dir(env["settings"], upload.id) / "transactions.csv").write_bytes(b"a,b\n")
        return upload.id
    finally:
        db.close()


def _make_build(
    env,
    upload_id: int,
    *,
    status: str,
    started_minutes_ago: int | None = None,
    expires_in_minutes: int = -60,
) -> int:
    db = SessionLocal()
    try:
        build = AgentMonthlyReportBuild(
            upload_id=upload_id,
            agent_api_key_id=1,
            agent_id="janitor-agent",
            status=status,
            input_sha256="0" * 64,
            expires_at=utc_now() + timedelta(minutes=expires_in_minutes),
            started_at=(
                utc_now() - timedelta(minutes=started_minutes_ago)
                if started_minutes_ago is not None
                else None
            ),
        )
        db.add(build)
        db.commit()
        db.refresh(build)
        directory = build_dir(env["settings"], build.id)
        prepare_private_dir(directory)
        (directory / "preview.json").write_text("{}")
        return build.id
    finally:
        db.close()


def _run_sweep(env) -> dict:
    db = SessionLocal()
    try:
        return sweep(db, env["settings"])
    finally:
        db.close()


def _build_row(build_id: int) -> AgentMonthlyReportBuild:
    db = SessionLocal()
    try:
        return db.get(AgentMonthlyReportBuild, build_id)
    finally:
        db.close()


def _upload_row(upload_id: int) -> AgentMonthlyReportUpload:
    db = SessionLocal()
    try:
        return db.get(AgentMonthlyReportUpload, upload_id)
    finally:
        db.close()


class TestJanitor:
    def test_running_build_within_timeout_is_not_cleaned(self, janitor_env):
        upload_id = _make_upload(
            janitor_env, expires_in_minutes=-60, status=AgentMonthlyReportUploadStatus.building.value
        )
        build_id = _make_build(
            janitor_env,
            upload_id,
            status=AgentMonthlyReportBuildStatus.running.value,
            started_minutes_ago=1,
        )

        counts = _run_sweep(janitor_env)
        assert counts["timeout_recovered"] == 0
        assert counts["builds_cleaned"] == 0
        assert counts["uploads_cleaned"] == 0
        # 运行中的任务目录保留（worker 仍在使用）。
        assert build_dir(janitor_env["settings"], build_id).is_dir()
        assert upload_dir(janitor_env["settings"], upload_id).is_dir()
        assert _build_row(build_id).status == AgentMonthlyReportBuildStatus.running.value

    def test_stale_running_build_is_recovered_then_cleaned(self, janitor_env):
        upload_id = _make_upload(
            janitor_env, expires_in_minutes=-60, status=AgentMonthlyReportUploadStatus.building.value
        )
        build_id = _make_build(
            janitor_env,
            upload_id,
            status=AgentMonthlyReportBuildStatus.running.value,
            started_minutes_ago=26,
        )

        counts = _run_sweep(janitor_env)
        assert counts["timeout_recovered"] == 1
        row = _build_row(build_id)
        assert row.status == AgentMonthlyReportBuildStatus.failed.value
        assert row.error_message == "build_timeout_recovered"
        # 恢复为 failed 后，同一次扫描即清理目录。
        assert not build_dir(janitor_env["settings"], build_id).exists()
        assert counts["builds_cleaned"] >= 1

    def test_expired_success_build_is_marked_expired_and_cleaned(self, janitor_env):
        upload_id = _make_upload(
            janitor_env, expires_in_minutes=-60, status=AgentMonthlyReportUploadStatus.built.value
        )
        build_id = _make_build(
            janitor_env,
            upload_id,
            status=AgentMonthlyReportBuildStatus.success.value,
        )

        counts = _run_sweep(janitor_env)
        assert counts["builds_expired"] == 1
        assert _build_row(build_id).status == AgentMonthlyReportBuildStatus.expired.value
        assert not build_dir(janitor_env["settings"], build_id).exists()

    def test_expired_upload_without_active_build_is_cleaned(self, janitor_env):
        upload_id = _make_upload(
            janitor_env, expires_in_minutes=-60, status=AgentMonthlyReportUploadStatus.built.value
        )
        _make_build(
            janitor_env,
            upload_id,
            status=AgentMonthlyReportBuildStatus.success.value,
        )

        counts = _run_sweep(janitor_env)
        assert counts["uploads_expired"] == 1
        assert counts["uploads_cleaned"] == 1
        assert (
            _upload_row(upload_id).status == AgentMonthlyReportUploadStatus.expired.value
        )
        assert not upload_dir(janitor_env["settings"], upload_id).exists()

    def test_expired_upload_with_active_build_keeps_input_dir(self, janitor_env):
        upload_id = _make_upload(
            janitor_env, expires_in_minutes=-60, status=AgentMonthlyReportUploadStatus.building.value
        )
        _make_build(
            janitor_env,
            upload_id,
            status=AgentMonthlyReportBuildStatus.running.value,
            started_minutes_ago=1,
        )

        counts = _run_sweep(janitor_env)
        assert counts["uploads_expired"] == 1
        assert counts["uploads_cleaned"] == 0
        assert upload_dir(janitor_env["settings"], upload_id).is_dir()

    def test_orphan_build_dir_is_cleaned(self, janitor_env):
        orphan = janitor_env["root"] / "builds" / "999999"
        prepare_private_dir(orphan)
        (orphan / "preview.json").write_text("{}")
        old = (utc_now() - timedelta(hours=3)).timestamp()
        os.utime(orphan, (old, old))

        counts = _run_sweep(janitor_env)
        assert counts["orphans_cleaned"] >= 1
        assert not orphan.exists()

    def test_formal_files_are_never_touched(self, janitor_env):
        formal = janitor_env["formal_root"] / "project" / "payment-report" / "formal.csv"
        formal.parent.mkdir(parents=True, exist_ok=True)
        formal.write_bytes(b"formal")

        _run_sweep(janitor_env)
        assert formal.is_file()
