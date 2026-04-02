from fastapi import HTTPException
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.db.session import Base
from app.models import OperationTask, Project
from app.schemas.collaboration import (
    OperationCollaborationPageUpdateRequest,
    OperationTaskSubtaskInput,
    OperationTaskUpsertRequest,
)
from app.services import collaboration_service, project_service


@pytest.fixture(autouse=True)
def disable_project_cache(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(project_service, 'cache_get', lambda key: None)
    monkeypatch.setattr(project_service, 'cache_set', lambda key, value: None)
    monkeypatch.setattr(project_service, 'cache_delete_pattern', lambda pattern: 0)


def build_session() -> Session:
    engine = create_engine('sqlite:///:memory:', future=True)
    Base.metadata.create_all(bind=engine)
    return Session(engine)


def test_list_tasks_respects_accessible_projects():
    with build_session() as session:
        session.add_all(
            [
                Project(id=1, project_name='项目A', project_operator='小王', sort_order=0),
                Project(id=2, project_name='项目B', project_operator='小李', sort_order=1),
                OperationTask(
                    title='任务A',
                    status='todo',
                    priority='medium',
                    owner_operator_name='小王',
                    collaborator_operator_names=[],
                    project_id=1,
                    project_name_snapshot='项目A',
                    tags=[],
                    created_by='小王',
                    updated_by='小王',
                ),
                OperationTask(
                    title='任务B',
                    status='todo',
                    priority='medium',
                    owner_operator_name='小李',
                    collaborator_operator_names=[],
                    project_id=2,
                    project_name_snapshot='项目B',
                    tags=[],
                    created_by='小李',
                    updated_by='小李',
                ),
            ]
        )
        session.commit()

        rows = collaboration_service.list_tasks(session, operator='小王', is_admin=False)

        assert [row.title for row in rows] == ['任务A']


def test_update_task_requires_creator_or_owner():
    with build_session() as session:
        session.add(Project(id=1, project_name='项目A', project_operator='小王、小李', sort_order=0))
        session.add(
            OperationTask(
                title='任务A',
                status='todo',
                priority='medium',
                owner_operator_name='小王',
                collaborator_operator_names=['小李'],
                project_id=1,
                project_name_snapshot='项目A',
                tags=[],
                created_by='小王',
                updated_by='小王',
            )
        )
        session.commit()

        task_id = session.query(OperationTask.id).first()[0]
        payload = OperationTaskUpsertRequest(
            title='任务A-更新',
            description='说明',
            status='in_progress',
            priority='high',
            owner_operator_name='小王',
            collaborator_operator_names=['小李'],
            project_id=1,
            tags=['复盘'],
            objective_cycle='2026-Q2',
            objective_key='提高效率',
            subtasks=[OperationTaskSubtaskInput(title='核对数据', is_completed=False, sort_order=0)],
        )

        with pytest.raises(HTTPException) as exc_info:
            collaboration_service.update_task(
                session,
                task_id,
                payload=payload,
                operator='小李',
                is_admin=False,
            )

        assert exc_info.value.status_code == 403


def test_upsert_page_returns_saved_content_and_project_tasks():
    with build_session() as session:
        session.add(Project(id=1, project_name='项目A', project_operator='小王', sort_order=0))
        session.add(
            OperationTask(
                title='任务A',
                status='todo',
                priority='medium',
                owner_operator_name='小王',
                collaborator_operator_names=[],
                project_id=1,
                project_name_snapshot='项目A',
                tags=[],
                created_by='小王',
                updated_by='小王',
            )
        )
        session.commit()

        payload = OperationCollaborationPageUpdateRequest(
            title='项目A 协作页',
            content_json=[{'id': 'a', 'type': 'paragraph', 'content': '第一周推进记录'}],
            objective_cycle='2026-Q2',
            objective_key='提高广告投放效率',
        )
        collaboration_service.upsert_page(session, 1, payload=payload, operator='小王', is_admin=False)
        session.commit()

        project, page, tasks = collaboration_service.get_page(session, 1, operator='小王', is_admin=False)

        assert project.project_name == '项目A'
        assert page is not None
        assert page.title == '项目A 协作页'
        assert page.objective_cycle == '2026-Q2'
        assert len(tasks) == 1
