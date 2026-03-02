import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.db.session import Base
from app.models import Project
from app.services import project_service


def test_parse_projects_csv_success_with_skips():
    content = '项目名称\n宝勒1店\n   \n宝勒2店\n宝勒1店\n'.encode('utf-8')

    names, skipped, total = project_service.parse_projects_csv(content)

    assert names == ['宝勒1店', '宝勒2店']
    assert skipped == 2
    assert total == 4


def test_parse_projects_csv_missing_header():
    content = 'project_name\n宝勒1店\n'.encode('utf-8')

    with pytest.raises(Exception) as exc_info:
        project_service.parse_projects_csv(content)
    assert 'CSV 缺少字段: 项目名称' in str(exc_info.value)


def test_bulk_upsert_projects_keeps_existing_sort_order():
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as session:
        session.add(Project(project_name='宝勒1店', sort_order=5, source_file='old.csv'))
        session.commit()

        _, inserted, updated = project_service.bulk_upsert_projects(
            session, ['宝勒1店', '宝勒2店'], source_file='projects.csv'
        )
        session.commit()

        first = session.query(Project).filter(Project.project_name == '宝勒1店').one()
        second = session.query(Project).filter(Project.project_name == '宝勒2店').one()

        assert inserted == 1
        assert updated == 1
        assert first.sort_order == 5
        assert first.source_file == 'projects.csv'
        assert second.sort_order == 6


def test_normalize_commission_rate_accepts_points():
    normalized = project_service._normalize_commission_rate(5)
    assert normalized is not None
    assert float(normalized) == 0.05


def test_normalize_commission_rate_rejects_out_of_range():
    with pytest.raises(HTTPException) as exc_info:
        project_service._normalize_commission_rate(101)
    assert exc_info.value.status_code == 422
