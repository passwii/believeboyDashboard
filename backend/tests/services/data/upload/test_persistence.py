"""HTTP 入库持久化（commit_report_upload）——库存分类账独立类型显式路由 (Task 2).

覆盖控制器裁定：

* ``inventory_ledger_summary`` / ``inventory_ledger_detail`` 各自走专用
  ``ingest_ledger_csv(..., expected_kind=...)`` 分支，不再落入默认分支；
* 成功消息按视图命名（汇总视图 / 明细视图），旧 ``inventory_ledger`` 兼容分支保留；
* 声明类型与文件内容不一致 → 结构化 4xx（识别层 400 / 入库层 422），绝不裸 500；
* ``TYPE_ALLOWED_EXTENSIONS`` 显式收录两个新类型。

真实识别链路（recognize_saved_report_upload → 项目 SKU 匹配 → ingest）跑通
summary/detail 两个方向；入库层错配 422 通过 monkeypatch 识别响应定向触发。
"""

from __future__ import annotations

import io
import uuid

import pytest
from fastapi import HTTPException, UploadFile
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models import Project
from app.models.inventory_ledger import (
    InventoryLedgerDetail,
    InventoryLedgerIngestBatch,
    InventoryLedgerSummary,
)
from app.models.sku_info import SkuRecord
from app.schemas.upload import (
    ReportCommitRequest,
    ReportProjectMatchSummary,
    ReportRecognitionResponse,
)
from app.services import upload_service
from app.services.data.upload.persistence import commit_report_upload

SUMMARY_HEADERS = [
    "Date",
    "FNSKU",
    "ASIN",
    "MSKU",
    "Title",
    "Disposition",
    "Starting Warehouse Balance",
    "In Transit Between Warehouses",
    "Receipts",
    "Customer Shipments",
    "Customer Returns",
    "Vendor Returns",
    "Warehouse Transfer In/Out",
    "Found",
    "Lost",
    "Damaged",
    "Disposed",
    "Other Events",
    "Ending Warehouse Balance",
    "Unknown Events",
    "Location",
    "Store",
]

DETAIL_HEADERS = [
    "Date",
    "FNSKU",
    "ASIN",
    "MSKU",
    "Title",
    "Event Type",
    "Reference ID",
    "Quantity",
    "Fulfillment Center",
    "Disposition",
    "Reason",
    "Country",
    "Reconciled Quantity",
    "Unreconciled Quantity",
    "Date and Time",
    "Store",
]


def _summary_csv(msku: str) -> str:
    return (
        ",".join(SUMMARY_HEADERS)
        + "\n"
        + f"06/01/2026,X00ABC,B0001,{msku},Test Item,SELLABLE,100,0,0,5,0,0,0,0,0,0,0,0,95,0,LAX1,Bel-Bel\n"
    )


def _detail_csv(msku: str) -> str:
    return (
        ",".join(DETAIL_HEADERS)
        + "\n"
        + f"06/01/2026,X00ABC,B0001,{msku},Test Item,Shipments,, -1,LAX1,SELLABLE,,US,,,2026-06-01T00:00:00-0700,\n"
    )


@pytest.fixture
def upload_settings(tmp_path) -> Settings:
    """隔离的 upload_root：临时文件与最终入库文件都落在 tmp_path 下。"""
    return Settings(upload_root=tmp_path / "uploads")


@pytest.fixture
def project(db_session: Session):
    """可被识别链路匹配到的项目。

    SKU 每次测试唯一（防历史残留项目导致匹配冲突）；teardown 提交删除
    SkuRecord/Project，避免污染持久化的测试库。
    """
    p = Project(
        project_name=f"ledger-route-test-{uuid.uuid4().hex[:8]}",
        sort_order=999_999,
        is_active=True,
    )
    msku = f"MSKU-{uuid.uuid4().hex[:8].upper()}"
    db_session.add(p)
    db_session.flush()
    db_session.add(
        SkuRecord(
            project_id=p.id,
            project_name=p.project_name,
            sku=msku,
            asin="B0001",
            country="US",
        )
    )
    db_session.flush()
    p.msku = msku  # 测试用它构造 CSV，保证 SKU 匹配唯一
    yield p
    db_session.execute(
        text("DELETE FROM inventory_ledger_detail WHERE project_id = :pid"),
        {"pid": p.id},
    )
    db_session.execute(
        text("DELETE FROM inventory_ledger_summary WHERE project_id = :pid"),
        {"pid": p.id},
    )
    db_session.execute(
        text("DELETE FROM inventory_ledger_ingest_batch WHERE project_id = :pid"),
        {"pid": p.id},
    )
    db_session.execute(
        text("DELETE FROM product_costs WHERE project_id = :pid"),
        {"pid": p.id},
    )
    db_session.execute(text("DELETE FROM projects WHERE id = :pid"), {"pid": p.id})
    db_session.commit()


def _save_temp(settings: Settings, filename: str, content: str) -> str:
    saved = upload_service.save_report_upload_temp_file(
        UploadFile(filename=filename, file=io.BytesIO(content.encode("utf-8"))),
        settings,
    )
    return str(saved["temp_file_id"])


def _commit(
    db: Session,
    settings: Settings,
    *,
    report_type: str,
    temp_file_id: str,
    original_filename: str,
    project_name: str,
):
    return commit_report_upload(
        db,
        settings,
        payload=ReportCommitRequest(
            temp_file_id=temp_file_id,
            report_type=report_type,
            original_filename=original_filename,
            project_name=project_name,
            country="US",
        ),
        operator=f"test-operator-{uuid.uuid4().hex[:8]}",
        is_admin=True,
    )


def _summary_count(db: Session, project_id: int) -> int:
    return len(
        db.execute(
            select(InventoryLedgerSummary).where(
                InventoryLedgerSummary.project_id == project_id
            )
        ).all()
    )


def _detail_count(db: Session, project_id: int) -> int:
    return len(
        db.execute(
            select(InventoryLedgerDetail).where(
                InventoryLedgerDetail.project_id == project_id
            )
        ).all()
    )


class TestLedgerTypedRouting:
    """两类独立类型各自入库到对应业务表，消息按视图命名。"""

    def test_summary_commit_routes_to_summary_table_with_view_message(
        self, db_session: Session, upload_settings: Settings, project: Project
    ):
        temp_file_id = _save_temp(
            upload_settings,
            "库存分类账 2026-0601-0630.csv",
            _summary_csv(project.msku),
        )
        resp = _commit(
            db_session,
            upload_settings,
            report_type="inventory_ledger_summary",
            temp_file_id=temp_file_id,
            original_filename="库存分类账 2026-0601-0630.csv",
            project_name=project.project_name,
        )
        assert resp.status == "persisted"
        assert resp.message == "库存分类账汇总视图已入库（1 行）"
        db_session.commit()
        assert _summary_count(db_session, project.id) == 1
        assert _detail_count(db_session, project.id) == 0
        batch = (
            db_session.execute(
                select(InventoryLedgerIngestBatch).where(
                    InventoryLedgerIngestBatch.project_id == project.id
                )
            )
            .scalars()
            .one()
        )
        assert batch.file_kind == "summary"
        assert batch.status == "success"

    def test_detail_commit_routes_to_detail_table_with_view_message(
        self, db_session: Session, upload_settings: Settings, project: Project
    ):
        temp_file_id = _save_temp(
            upload_settings,
            "库存分类账-2026-06详细视图.csv",
            _detail_csv(project.msku),
        )
        resp = _commit(
            db_session,
            upload_settings,
            report_type="inventory_ledger_detail",
            temp_file_id=temp_file_id,
            original_filename="库存分类账-2026-06详细视图.csv",
            project_name=project.project_name,
        )
        assert resp.status == "persisted"
        assert resp.message == "库存分类账明细视图已入库（1 行）"
        db_session.commit()
        assert _summary_count(db_session, project.id) == 0
        assert _detail_count(db_session, project.id) == 1
        batch = (
            db_session.execute(
                select(InventoryLedgerIngestBatch).where(
                    InventoryLedgerIngestBatch.project_id == project.id
                )
            )
            .scalars()
            .one()
        )
        assert batch.file_kind == "detail"
        assert batch.status == "success"

    def test_legacy_inventory_ledger_commit_still_works(
        self, db_session: Session, upload_settings: Settings, project: Project
    ):
        """旧值兼容：声明 inventory_ledger 时识别层放行，入库层按表头自动路由。"""
        temp_file_id = _save_temp(
            upload_settings,
            "库存分类账 2026-0601-0630.csv",
            _summary_csv(project.msku),
        )
        resp = _commit(
            db_session,
            upload_settings,
            report_type="inventory_ledger",
            temp_file_id=temp_file_id,
            original_filename="库存分类账 2026-0601-0630.csv",
            project_name=project.project_name,
        )
        assert resp.status == "persisted"
        assert resp.message == "库存盘点数据已入库（1 行）"
        db_session.commit()
        assert _summary_count(db_session, project.id) == 1


class TestTypedMismatchIsStructured4xx:
    """声明类型与文件内容不一致：结构化 4xx，绝不裸 500。"""

    def test_declared_summary_with_detail_csv_rejected_by_recognition(
        self, db_session: Session, upload_settings: Settings, project: Project
    ):
        """真实识别链路：Detail 文件声明为 summary → 识别层 400。"""
        temp_file_id = _save_temp(
            upload_settings,
            "库存分类账-2026-06详细视图.csv",
            _detail_csv(project.msku),
        )
        with pytest.raises(HTTPException) as exc:
            _commit(
                db_session,
                upload_settings,
                report_type="inventory_ledger_summary",
                temp_file_id=temp_file_id,
                original_filename="库存分类账-2026-06详细视图.csv",
                project_name=project.project_name,
            )
        assert exc.value.status_code < 500
        db_session.rollback()
        assert _summary_count(db_session, project.id) == 0

    def test_typed_mismatch_at_ingest_becomes_422_not_500(
        self,
        db_session: Session,
        upload_settings: Settings,
        project: Project,
        monkeypatch,
    ):
        """识别层放行（声明类型被识别为 summary）但入库层检测到 Detail 表头
        → ingest_ledger_csv 抛 ValueError → 持久化层转 422，消息含中文说明。"""

        def _fake_recognize(db, settings, **kwargs) -> ReportRecognitionResponse:
            return ReportRecognitionResponse(
                temp_file_id=kwargs["temp_file_id"],
                original_filename=kwargs["original_filename"],
                extension=".csv",
                report_type="inventory_ledger_summary",
                matched_columns=["date", "msku"],
                reason="ok",
                status="recognized",
                country="US",
                date_input_mode="single_manual",
                project_match=ReportProjectMatchSummary(
                    status="matched",
                    project_name=project.project_name,
                    matched_by="sku",
                    message="已根据SKU自动匹配项目",
                ),
                warnings=[],
            )

        monkeypatch.setattr(
            "app.services.data.upload.persistence.recognize_saved_report_upload",
            _fake_recognize,
        )
        temp_file_id = _save_temp(
            upload_settings,
            "库存分类账-2026-06详细视图.csv",
            _detail_csv(project.msku),
        )
        with pytest.raises(HTTPException) as exc:
            _commit(
                db_session,
                upload_settings,
                report_type="inventory_ledger_summary",
                temp_file_id=temp_file_id,
                original_filename="库存分类账-2026-06详细视图.csv",
                project_name=project.project_name,
            )
        assert exc.value.status_code == 422
        assert "类型与文件内容不一致" in exc.value.detail
        db_session.rollback()
        assert _summary_count(db_session, project.id) == 0


class TestLedgerExtensionMap:
    def test_type_allowed_extensions_includes_new_ledger_types(self):
        assert upload_service.TYPE_ALLOWED_EXTENSIONS["inventory_ledger_summary"] == {
            ".csv"
        }
        assert upload_service.TYPE_ALLOWED_EXTENSIONS["inventory_ledger_detail"] == {
            ".csv"
        }
