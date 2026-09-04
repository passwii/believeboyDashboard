"""RPA country-subfolder support (BLF-646): a file inside <project>/美国/ belongs
to the same project as one in <project>/ — both are the US site.

Covered:
- config.resolve_project_dir maps <project>/美国/x.csv -> <project>
- monitor._collect_files picks up files in the 美国 subfolder (not just project root)
- monitor.run_cycle resolves the project name through the 美国 subfolder
- processor._move_to_processed archives into <project>/processed (NOT inside 美国)
- recognition folder-name fallback matches through the 美国 subfolder
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from config import COUNTRY_SUBFOLDERS, resolve_project_dir
from monitor import _collect_files, run_cycle
from processor import _move_to_processed
from recognition import recognize_file

# ─── resolve_project_dir ──────────────────────────────────────────────────────


class TestResolveProjectDir:
    def test_root_file_returns_its_parent(self, tmp_path: Path):
        project_dir = tmp_path / "测试项目"
        project_dir.mkdir()
        file_path = project_dir / "Orders-2026-08-12.txt"
        assert resolve_project_dir(file_path) == project_dir

    def test_country_subfolder_file_returns_grandparent(self, tmp_path: Path):
        project_dir = tmp_path / "测试项目"
        country_dir = project_dir / "美国"
        country_dir.mkdir(parents=True)
        file_path = country_dir / "Orders-2026-08-12.txt"
        assert resolve_project_dir(file_path) == project_dir

    def test_country_subfolder_is_configured(self):
        assert "美国" in COUNTRY_SUBFOLDERS


# ─── monitor._collect_files ───────────────────────────────────────────────────


class TestCollectFilesWithCountrySubfolder:
    def _make_tree(self, tmp_path: Path) -> tuple[Path, dict[str, list[str]]]:
        """Create <project>/{file.txt, 美国/{file.txt, processed/old.txt}}."""
        project_dir = tmp_path / "测试项目"
        country_dir = project_dir / "美国"
        (country_dir / "processed").mkdir(parents=True)
        project_dir.joinpath("root-report.txt").write_text("root", encoding="utf-8")
        country_dir.joinpath("us-report.csv").write_text("us", encoding="utf-8")
        country_dir.joinpath("processed").joinpath("old.csv").write_text(
            "old", encoding="utf-8"
        )
        return project_dir, {
            "root": ["root-report.txt"],
            "us": ["us-report.csv"],
        }

    def test_collects_root_and_country_subfolder_files(self, tmp_path: Path):
        project_dir, expected = self._make_tree(tmp_path)
        files = _collect_files(project_dir)
        names = {f.name for f in files}
        assert names == set(expected["root"] + expected["us"])

    def test_skips_processed_inside_country_subfolder(self, tmp_path: Path):
        project_dir, _ = self._make_tree(tmp_path)
        files = _collect_files(project_dir)
        assert all(f.name != "old.csv" for f in files)

    def test_ignores_unsupported_extensions(self, tmp_path: Path):
        project_dir = tmp_path / "测试项目"
        country_dir = project_dir / "美国"
        country_dir.mkdir(parents=True)
        country_dir.joinpath("us-report.xlsx").write_text("x", encoding="utf-8")
        country_dir.joinpath("notes.md").write_text("md", encoding="utf-8")
        files = _collect_files(project_dir)
        assert [f.name for f in files] == ["us-report.xlsx"]


# ─── monitor.run_cycle project resolution ─────────────────────────────────────


class TestRunCycleCountrySubfolder:
    @patch("monitor.get_db_session_with_retry")
    @patch("monitor.process_file")
    def test_file_in_country_subfolder_uses_project_name(
        self, mock_process, mock_db, tmp_path: Path
    ):
        """run_cycle 把 美国 子文件夹里的文件以项目名为 project_name 处理。"""
        project_dir = tmp_path / "测试项目"
        country_dir = project_dir / "美国"
        country_dir.mkdir(parents=True)
        file_path = country_dir / "Orders-2026-08-12.txt"
        file_path.write_text("data", encoding="utf-8")

        mock_db.return_value = (MagicMock(), False)
        mock_process.return_value = MagicMock(
            skipped=False,
            success=True,
            report_type="sales_report",
            report_label="",
            error="",
            country="US",
            detected_start_date=None,
            detected_end_date=None,
            source_id=None,
            row_count=0,
            reason="",
        )

        # run_cycle only iterates PROJECTS — stub it to the single project
        with patch("monitor.PROJECTS", ["测试项目"]):
            with patch("monitor.WATCH_ROOT", tmp_path):
                stats = run_cycle(MagicMock(), dry_run=True)

        assert stats["files_seen"] == 1
        call = mock_process.call_args
        assert call.args[1] == "测试项目"
        assert call.args[0] == file_path


# ─── processor._move_to_processed ─────────────────────────────────────────────


class TestMoveToProcessedCountrySubfolder:
    def test_general_report_moves_to_project_processed(self, tmp_path: Path):
        project_dir = tmp_path / "测试项目"
        country_dir = project_dir / "美国"
        country_dir.mkdir(parents=True)
        file_path = country_dir / "Orders-2026-08-12.txt"
        file_path.write_text("data", encoding="utf-8")

        _move_to_processed(file_path, "sales_report")

        assert not file_path.exists()
        assert (project_dir / "processed" / "Orders-2026-08-12.txt").exists()
        assert not (country_dir / "processed").exists()

    def test_ad_report_moves_to_project_ad_processed(self, tmp_path: Path):
        project_dir = tmp_path / "测试项目"
        country_dir = project_dir / "美国"
        country_dir.mkdir(parents=True)
        file_path = country_dir / "广告-2026-08-12.csv"
        file_path.write_text("data", encoding="utf-8")

        _move_to_processed(file_path, "ad_placement_report")

        assert not file_path.exists()
        assert (project_dir / "广告Processed" / "广告-2026-08-12.csv").exists()
        assert not (country_dir / "广告Processed").exists()


# ─── recognition folder fallback ──────────────────────────────────────────────


class TestRecognitionFolderFallbackCountrySubfolder:
    def test_folder_match_resolves_through_country_subfolder(self, tmp_path: Path):
        """MSKU 内容匹配不到时，目录名 fallback 必须取项目名而非「美国」。"""
        project_dir = tmp_path / "测试项目"
        country_dir = project_dir / "美国"
        country_dir.mkdir(parents=True)
        path = country_dir / "库存 2026-08-12.txt"
        path.write_text(
            "snapshot-date\tsku\tasin\n2026-08-12\tSKU-001\tASIN-001\n",
            encoding="utf-8",
        )

        db = MagicMock()
        db.execute.return_value.scalars.return_value.all.return_value = []
        db.execute.return_value.scalars.return_value.first.return_value = MagicMock(
            project_name="测试项目"
        )

        result = recognize_file(db, path, country="US", original_filename=path.name)
        assert result is not None
        assert result.project_match is not None
        assert result.project_match["status"] == "matched"
        assert result.project_match["project_name"] == "测试项目"
