from __future__ import annotations

import datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Header, Query
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator, protected
from app.schemas.project_goal import (
    ProjectGoalCreate,
    ProjectGoalItem,
    ProjectGoalListResponse,
    ProjectGoalProgressResponse,
    ProjectGoalUpdate,
)
from app.services import project_goal_service, project_service

router = APIRouter(dependencies=[Depends(protected)])

ALLOWED_METRIC_TYPES = {'sales_amount'}


@router.get('/project-goals', response_model=ProjectGoalListResponse)
def list_project_goals(
    project_id: int,
    country: str = 'US',
    year: int = Query(default=None, ge=2020, le=2100),
    goal_type: Optional[str] = None,
    metric_type: Optional[str] = Query(default='sales_amount'),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
):
    """列出项目目标"""
    project_service.ensure_project_access(
        db, project_id, operator=operator, is_admin=bool(is_admin),
    )
    if year is None:
        year = datetime.date.today().year
    if metric_type and metric_type not in ALLOWED_METRIC_TYPES:
        metric_type = 'sales_amount'
    goals = project_goal_service.list_goals(
        db, project_id=project_id, country=country, year=year,
        goal_type=goal_type, metric_type=metric_type,
    )
    return ProjectGoalListResponse(goals=goals, total=len(goals))


@router.get('/project-goals/progress', response_model=ProjectGoalProgressResponse)
def get_project_goal_progress(
    project_id: int,
    country: str = 'US',
    year: int = Query(default=None, ge=2020, le=2100),
    metric_type: str = Query(default='sales_amount'),
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
):
    """获取目标完成进度"""
    project_service.ensure_project_access(
        db, project_id, operator=operator, is_admin=bool(is_admin),
    )
    if year is None:
        year = datetime.date.today().year
    if metric_type not in ALLOWED_METRIC_TYPES:
        metric_type = 'sales_amount'
    return project_goal_service.get_progress(
        db, project_id=project_id, country=country, year=year,
        metric_type=metric_type,
    )


@router.get('/project-goals/{goal_id}', response_model=ProjectGoalItem)
def get_project_goal(
    goal_id: int,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
):
    """获取单条目标"""
    goal = project_goal_service.get_goal(db, goal_id=goal_id)
    project_service.ensure_project_access(
        db, goal.project_id, operator=operator, is_admin=bool(is_admin),
    )
    return goal


@router.post('/project-goals', response_model=ProjectGoalItem, status_code=201)
def create_project_goal(
    data: ProjectGoalCreate,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
):
    """创建项目目标"""
    project_service.ensure_project_access(
        db, data.project_id, operator=operator, is_admin=bool(is_admin),
    )
    return project_goal_service.create_goal(db, data=data)


@router.put('/project-goals/{goal_id}', response_model=ProjectGoalItem)
def update_project_goal(
    goal_id: int,
    data: ProjectGoalUpdate,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
):
    """更新项目目标"""
    goal = project_goal_service.get_goal(db, goal_id=goal_id)
    project_service.ensure_project_access(
        db, goal.project_id, operator=operator, is_admin=bool(is_admin),
    )
    return project_goal_service.update_goal(db, goal_id=goal_id, data=data)


@router.delete('/project-goals/{goal_id}', status_code=204)
def delete_project_goal(
    goal_id: int,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
    is_admin: bool = Header(default=False, alias='X-Is-Admin'),
):
    """删除项目目标"""
    goal = project_goal_service.get_goal(db, goal_id=goal_id)
    project_service.ensure_project_access(
        db, goal.project_id, operator=operator, is_admin=bool(is_admin),
    )
    project_goal_service.delete_goal(db, goal_id=goal_id)
