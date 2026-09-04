"""Tests for SHA-256 duplicate detection."""
import pytest
from datetime import date
from unittest.mock import MagicMock

from app.services.data.upload.dedup import find_sha256_duplicates, DuplicateInfo
from app.utils.models import AnalysisSourceFile


@pytest.mark.upload
class TestFindSha256Duplicates:
    """Verify SHA-256 duplicate detection returns correct info."""

    def test_returns_empty_list_when_no_duplicate(self):
        db = MagicMock()
        db.execute.return_value.scalars.return_value.all.return_value = []

        result = find_sha256_duplicates(db, "abc123")

        assert result == []

    def test_returns_duplicate_info_when_found(self):
        db = MagicMock()
        mock_row = MagicMock(spec=AnalysisSourceFile)
        mock_row.id = 1
        mock_row.project_id = 10
        mock_row.report_type = "payment_report"
        mock_row.country = "US"
        mock_row.period_start_date = date(2024, 1, 1)
        mock_row.period_end_date = date(2024, 1, 31)
        mock_row.original_filename = "payment.csv"
        mock_row.created_at.isoformat.return_value = "2024-02-01T10:00:00"
        db.execute.return_value.scalars.return_value.all.return_value = [mock_row]

        result = find_sha256_duplicates(db, "abc123")

        assert len(result) == 1
        info = result[0]
        assert isinstance(info, DuplicateInfo)
        assert info.source_id == 1
        assert info.project_id == 10
        assert info.report_type == "payment_report"
        assert info.country == "US"
        assert info.period_start_date == "2024-01-01"
        assert info.period_end_date == "2024-01-31"
        assert info.original_filename == "payment.csv"

    def test_returns_multiple_duplicates(self):
        """Same file uploaded to multiple projects should return all."""
        db = MagicMock()
        row1 = MagicMock(spec=AnalysisSourceFile)
        row1.id = 1
        row1.project_id = 10
        row1.report_type = "payment_report"
        row1.country = "US"
        row1.period_start_date = None
        row1.period_end_date = None
        row1.original_filename = "file.csv"
        row1.created_at = None

        row2 = MagicMock(spec=AnalysisSourceFile)
        row2.id = 2
        row2.project_id = 20
        row2.report_type = "payment_report"
        row2.country = "DE"
        row2.period_start_date = date(2024, 3, 1)
        row2.period_end_date = date(2024, 3, 31)
        row2.original_filename = "file.csv"
        row2.created_at.isoformat.return_value = "2024-04-01"

        db.execute.return_value.scalars.return_value.all.return_value = [row1, row2]

        result = find_sha256_duplicates(db, "same_hash")

        assert len(result) == 2
        assert result[0].project_id == 10
        assert result[1].project_id == 20
