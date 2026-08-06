"""RPA processor: 库存分类账两种类型必须走类型化入库路径。

- ``inventory_ledger_summary`` → ``ingest_ledger_csv(expected_kind="summary")``
- ``inventory_ledger_detail``  → ``ingest_ledger_csv(expected_kind="detail")``

两个类型都不得落入 ``_persist_single_source``（A 表 analysis_source_files 路径）。
"""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from processor import _persist_one_file, _find_sha256_duplicates

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
