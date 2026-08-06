"""RPA processor: 库存分类账两种类型必须走类型化入库路径。

- ``inventory_ledger_summary`` → ``ingest_ledger_csv(expected_kind="summary")``
- ``inventory_ledger_detail``  → ``ingest_ledger_csv(expected_kind="detail")``

两个类型都不得落入 ``_persist_single_source``（A 表 analysis_source_files 路径）。
"""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from processor import (
    _find_sha256_duplicates,
    _persist_one_file,
    _write_dedup_upload_log,
    process_file,
)
from models import ReportUploadLog

from test_ledger_recognition import (
    INVENTORY_LEDGER_DETAIL_HEADERS,
    INVENTORY_LEDGER_SUMMARY_HEADERS,
    _INVENTORY_LEDGER_DETAIL_ROW,
    _INVENTORY_LEDGER_SUMMARY_ROW,
)


def _write_csv(tmp_path: Path, name: str, headers, row: str) -> Path:
    path = tmp_path / name
    path.write_text(",".join(headers) + "\n" + row + "\n", encoding="utf-8")
    return path


def _result(report_type: str) -> SimpleNamespace:
    return SimpleNamespace(
        report_type=report_type,
        country="US",
        detected_date=None,
        detected_start_date=None,
        detected_end_date=None,
    )


class TestLedgerPersistenceRouting:
    """两个独立类型各自路由到类型化 ingestion，绝不落入 _persist_single_source。"""

    @patch("processor._persist_single_source")
    @patch("app.services.inventory.ledger.ingest_ledger_csv", return_value=42)
    def test_summary_routes_to_typed_ledger_ingestion(self, mock_ingest, mock_single, tmp_path):
        path = _write_csv(
            tmp_path, "库存分类账 2026-03一览视图.csv",
            INVENTORY_LEDGER_SUMMARY_HEADERS, _INVENTORY_LEDGER_SUMMARY_ROW,
        )
        db = MagicMock()
        outcome = _persist_one_file(
            db, path, "测试项目", _result("inventory_ledger_summary")
        )
        mock_ingest.assert_called_once()
        call = mock_ingest.call_args
        assert call.kwargs["expected_kind"] == "summary"
        assert call.kwargs["filename"] == path.name
        assert call.kwargs["loaded_by"] == "autoReportUpload"
        assert isinstance(call.kwargs["csv_content"], bytes)
        assert call.kwargs["project_id"] is not None
        assert outcome["success"] is True
        assert outcome["row_count"] == 42
        assert outcome["report_kind"] == "summary"
        mock_single.assert_not_called()

    @patch("processor._persist_single_source")
    @patch("app.services.inventory.ledger.ingest_ledger_csv", return_value=17)
    def test_detail_routes_to_typed_ledger_ingestion(self, mock_ingest, mock_single, tmp_path):
        path = _write_csv(
            tmp_path, "库存分类账-2026-03详细视图.csv",
            INVENTORY_LEDGER_DETAIL_HEADERS, _INVENTORY_LEDGER_DETAIL_ROW,
        )
        db = MagicMock()
        outcome = _persist_one_file(
            db, path, "测试项目", _result("inventory_ledger_detail")
        )
        mock_ingest.assert_called_once()
        call = mock_ingest.call_args
        assert call.kwargs["expected_kind"] == "detail"
        assert isinstance(call.kwargs["csv_content"], bytes)
        assert outcome["success"] is True
        assert outcome["row_count"] == 17
        assert outcome["report_kind"] == "detail"
        mock_single.assert_not_called()

    @patch("processor._persist_single_source")
    @patch(
        "app.services.inventory.ledger.ingest_ledger_csv",
        side_effect=ValueError(
            "报表类型与文件内容不一致：声明为 summary，实际检测为 detail"
        ),
    )
    def test_ledger_mismatch_is_structured_failure(self, mock_ingest, mock_single, tmp_path):
        """声明类型与表头不一致 → 结构化失败结果，保留原始可操作错误信息。"""
        path = _write_csv(
            tmp_path, "库存分类账-2026-03详细视图.csv",
            INVENTORY_LEDGER_DETAIL_HEADERS, _INVENTORY_LEDGER_DETAIL_ROW,
        )
        db = MagicMock()
        outcome = _persist_one_file(
            db, path, "测试项目", _result("inventory_ledger_summary")
        )
        assert outcome["success"] is False
        assert "报表类型与文件内容不一致" in outcome["error"]
        mock_single.assert_not_called()


class TestLedgerSha256DuplicateDetection:
    """重复文件检测必须覆盖 inventory_ledger_ingest_batch（成功批次 = 重复）。"""

    def _stub_db_with_batch(self, fake_batch) -> MagicMock:
        db = MagicMock()
        a_scalars = MagicMock()
        a_scalars.all.return_value = []
        c_scalars = MagicMock()
        c_scalars.all.return_value = []
        l_scalars = MagicMock()
        l_scalars.all.return_value = [fake_batch]
        db.execute.side_effect = [
            MagicMock(scalars=lambda: a_scalars),
            MagicMock(scalars=lambda: c_scalars),
            MagicMock(scalars=lambda: l_scalars),
        ]
        return db

    def test_sha256_duplicates_includes_success_ledger_batch(self):
        fake_batch = MagicMock(
            project_id=7,
            source_filename="库存分类账-2026-03详细视图.csv",
            file_hash="abc123",
            file_kind="detail",
            status="success",
            rows_written_detail=99,
            rows_written_summary=0,
        )
        db = self._stub_db_with_batch(fake_batch)
        duplicates = _find_sha256_duplicates(db, "abc123")
        ledger_dups = [d for d in duplicates if d["table"] == "L"]
        assert len(ledger_dups) == 1
        assert ledger_dups[0]["report_type"] == "inventory_ledger_detail"
        assert ledger_dups[0]["row_count_total"] == 99


class TestDedupUploadLogSourceFileId:
    """重复日志的 source_file_id 只能写 A 表（analysis_source_files）主键。

    回归 I1：L 表（inventory_ledger_ingest_batch）与 C 表（ad_upload_files）
    的 source id 不是 analysis_source_files 的主键，写入
    report_upload_logs.source_file_id 会触发外键 IntegrityError
    （FK 指向 analysis_source_files.id，alembic 20260423_103）——
    跨天重复重传时 db.commit() 抛异常逃出 process_file，轮询模式下
    每轮中止该项目的其余文件。L/C 表重复必须写 None（无 FK 引用），
    A 表重复保留原值（有效 FK）。
    """

    def _stub_db(self, *, project_id: int = 7) -> MagicMock:
        db = MagicMock()
        project_query = MagicMock()
        project_query.scalars.return_value.first.return_value = MagicMock(id=project_id)
        log_query = MagicMock()
        log_query.scalars.return_value.first.return_value = None  # 今日尚无日志
        db.execute.side_effect = [project_query, log_query]
        return db

    def _dup(self, *, table: str, report_type: str, source_id: int, row_count_total: int) -> dict:
        return {
            "project_id": 7,
            "report_type": report_type,
            "country": "US",
            "source_id": source_id,
            "row_count_total": row_count_total,
            "table": table,
        }

    def test_ledger_batch_duplicate_writes_null_source_file_id(self):
        """L 表重复（source 是批次 id）→ 日志行 source_file_id=None，不违反 FK。"""
        db = self._stub_db()
        _write_dedup_upload_log(
            db, "库存分类账-2026-03详细视图.csv", "测试项目",
            "inventory_ledger_detail", "US",
            [self._dup(table="L", report_type="inventory_ledger_detail",
                       source_id=555, row_count_total=99)],
        )
        log = db.add.call_args[0][0]
        assert isinstance(log, ReportUploadLog)
        assert log.source_file_id is None
        assert log.row_count == 99
        assert log.has_real_data is True
        assert log.original_filename == "库存分类账-2026-03详细视图.csv"
        db.commit.assert_called_once()

    def test_ad_upload_duplicate_writes_null_source_file_id(self):
        """C 表重复（source 是 ad_upload_files id）→ source_file_id=None。"""
        db = self._stub_db()
        _write_dedup_upload_log(
            db, "广告-2026-03.csv", "测试项目",
            "ad_placement_report", "US",
            [self._dup(table="C", report_type="ad_placement_report",
                       source_id=777, row_count_total=0)],
        )
        log = db.add.call_args[0][0]
        assert isinstance(log, ReportUploadLog)
        assert log.source_file_id is None
        assert log.has_real_data is False

    def test_a_table_duplicate_keeps_source_file_id(self):
        """A 表重复（source 是 analysis_source_files id）→ 保留原值（有效 FK）。"""
        db = self._stub_db()
        _write_dedup_upload_log(
            db, "payment.csv", "测试项目",
            "payment_report", "US",
            [self._dup(table="A", report_type="payment_report",
                       source_id=42, row_count_total=50)],
        )
        log = db.add.call_args[0][0]
        assert isinstance(log, ReportUploadLog)
        assert log.source_file_id == 42


class TestLedgerRecognitionErrorHandling:
    """部分签名/冲突的库存分类账文件 → process_file 返回结构化失败，不抛异常。

    回归 I2：共享 recognizer 对部分签名文件抛 LedgerRecognitionError，
    process_file 必须将其转为 ProcessResult(success=False, reason=str(exc))，
    否则异常逃出 run_cycle 的项目级 try，轮询模式每轮中止该项目的其余
    文件且该文件永远重试。失败文件留在原地（与既有失败路径一致，不移动）。
    """

    def test_partial_signature_summary_returns_structured_failure(self, tmp_path):
        """Summary 强特征列齐全但缺必填列 → 结构化失败，不抛异常。"""
        headers = list(INVENTORY_LEDGER_SUMMARY_HEADERS)
        headers.remove("Date")  # 保留 starting/ending warehouse balance 强特征，缺必填列
        path = _write_csv(
            tmp_path, "库存分类账 2026-03一览视图.csv",
            headers, _INVENTORY_LEDGER_SUMMARY_ROW,
        )
        result = process_file(path, "测试项目", MagicMock(), dry_run=False)
        assert result.success is False
        assert result.skipped is False
        assert "Summary" in result.error
        assert "date" in result.error
        assert result.reason == result.error
        assert path.exists()  # 失败文件留在原地，等待人工处理（不移动、不删除）
