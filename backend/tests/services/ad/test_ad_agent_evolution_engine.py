"""Tests for evolution engine DB persistence."""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from app.services.ad_agent.evolution_engine import (
    AnalysisRunMetadata,
    record_run_to_db,
)


def test_record_run_to_db_uses_savepoint():
    """If commit fails, savepoint rollback should be called to avoid session pollution."""
    db = MagicMock()
    nested_tx = MagicMock()
    db.begin_nested.return_value = nested_tx

    metadata = AnalysisRunMetadata(
        run_id="test_001",
        project_id=1,
        project_name="Test",
        country="US",
        dimensions_analyzed=[{"dimension_id": "d1", "name": "D1", "level": 1, "signal_strength": "strong"}],
    )

    record_run_to_db(db, metadata)

    db.begin_nested.assert_called_once()
    db.commit.assert_called_once()
    nested_tx.rollback.assert_not_called()


def test_record_run_to_db_rollback_on_failure():
    """Rollback savepoint when commit fails."""
    db = MagicMock()
    nested_tx = MagicMock()
    db.begin_nested.return_value = nested_tx
    db.commit.side_effect = RuntimeError("DB locked")

    metadata = AnalysisRunMetadata(
        run_id="test_002",
        project_id=1,
        project_name="Test",
        country="US",
        dimensions_analyzed=[{"dimension_id": "d1", "name": "D1", "level": 1, "signal_strength": "strong"}],
    )

    with pytest.raises(RuntimeError, match="DB locked"):
        record_run_to_db(db, metadata)

    nested_tx.rollback.assert_called_once()
