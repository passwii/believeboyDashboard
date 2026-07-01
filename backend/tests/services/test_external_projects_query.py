"""Smoke tests for ``app.services.external.projects_query``."""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from app.services.external import projects_query


@pytest.fixture
def db_session() -> MagicMock:
    return MagicMock()


class TestListProjects:
    def test_unknown_status_raises(self, db_session):
        with pytest.raises(ValueError, match="status must be"):
            projects_query.list_projects(db_session, status='bogus')

    @pytest.mark.parametrize("status", ['active', 'archived', 'all'])
    def test_valid_status_does_not_raise(self, db_session, status):
        # Set up mock to return empty list
        db_session.execute.return_value.scalars.return_value.all.return_value = []
        result = projects_query.list_projects(db_session, status=status)
        assert result == []


class TestProjectExists:
    def test_existing_project(self, db_session):
        db_session.get.return_value = MagicMock()
        assert projects_query.project_exists(db_session, 1) is True

    def test_missing_project(self, db_session):
        db_session.get.return_value = None
        assert projects_query.project_exists(db_session, 999) is False