from __future__ import annotations

from calendar import monthrange
from datetime import UTC, date, datetime
from decimal import Decimal, ROUND_HALF_UP
from zoneinfo import ZoneInfo

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import AnalysisSalesOrderRow, AnalysisSourceFile, Project, ProjectGoal
from app.schemas.project_goal import (
    AnnualProgressItem,
    MonthlyProgressItem,
    ProjectGoalCreate,
    ProjectGoalItem,
    ProjectGoalProgressResponse,
    ProjectGoalUpdate,
)
from app.utils.country import normalize_country

ALLOWED_METRIC_TYPES = {'sales_amount'}
COUNTRY_TO_CURRENCY = {'US': 'USD', 'DE': 'EUR', 'UK': 'GBP'}
COUNTRY_TO_TIMEZONE = {
    'US': ZoneInfo('America/Los_Angeles'),
    'DE': ZoneInfo('Europe/Berlin'),
    'UK': ZoneInfo('Europe/London'),
}
MONTHLY = 'monthly'
ANNUAL = 'annual'


def _is_unique_period_conflict(exc: IntegrityError) -> bool:
    message = str(getattr(exc, 'orig', exc))
    return (
        'project_goals_unique_period' in message
        or 'UNIQUE constraint failed: project_goals.' in message
    )


def _is_missing_id_default_failure(exc: IntegrityError) -> bool:
    message = str(getattr(exc, 'orig', exc))
    return 'null value in column "id"' in message and 'project_goals' in message


def _get_currency(country: str) -> str:
    return COUNTRY_TO_CURRENCY.get(country, 'USD')


def _get_today_in_country_timezone(country: str) -> date:
    timezone = COUNTRY_TO_TIMEZONE.get(country, ZoneInfo('UTC'))
    return datetime.now(UTC).astimezone(timezone).date()


def _serialize_goal(row: ProjectGoal) -> ProjectGoalItem:
    return ProjectGoalItem(
        id=row.id,
        project_id=row.project_id,
        country=row.country,
        goal_type=row.goal_type,
        metric_type=row.metric_type,
        period_year=row.period_year,
        period_month=row.period_month,
        target_amount=float(row.target_amount),
        currency=_get_currency(row.country),
        created_at=row.created_at.isoformat() if row.created_at else '',
        updated_at=row.updated_at.isoformat() if row.updated_at else '',
    )


def _get_project_or_404(db: Session, project_id: int) -> Project:
    row = db.get(Project, project_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail='项目不存在')
    return row


def _get_goal_or_404(db: Session, goal_id: int) -> ProjectGoal:
    row = db.get(ProjectGoal, goal_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail='目标不存在')
    return row


def _query_monthly_sales(
    db: Session,
    project_id: int,
    country: str,
    year: int,
    month: int,
) -> Decimal:
    """查询指定项目/国家/月份的销售额"""
    start_date = date(year, month, 1)
    _, last_day = monthrange(year, month)
    end_date = date(year, month, last_day)

    stmt = (
        select(AnalysisSalesOrderRow.item_price)
        .join(
            AnalysisSourceFile,
            AnalysisSourceFile.id == AnalysisSalesOrderRow.source_file_id,
        )
        .where(
            AnalysisSourceFile.project_id == project_id,
            AnalysisSourceFile.report_type == 'sales_report',
            AnalysisSourceFile.country == country,
            AnalysisSourceFile.is_current.is_(True),
            AnalysisSourceFile.report_date >= start_date,
            AnalysisSourceFile.report_date <= end_date,
            AnalysisSalesOrderRow.is_counted_sales.is_(True),
        )
    )
    rows = db.execute(stmt).scalars().all()
    total = Decimal('0')
    for price in rows:
        total += Decimal(str(price or 0))
    return total


def _query_annual_sales(
    db: Session,
    project_id: int,
    country: str,
    year: int,
) -> Decimal:
    """查询指定项目/国家/年度的销售额"""
    start_date = date(year, 1, 1)
    end_date = date(year, 12, 31)

    stmt = (
        select(AnalysisSalesOrderRow.item_price)
        .join(
            AnalysisSourceFile,
            AnalysisSourceFile.id == AnalysisSalesOrderRow.source_file_id,
        )
        .where(
            AnalysisSourceFile.project_id == project_id,
            AnalysisSourceFile.report_type == 'sales_report',
            AnalysisSourceFile.country == country,
            AnalysisSourceFile.is_current.is_(True),
            AnalysisSourceFile.report_date >= start_date,
            AnalysisSourceFile.report_date <= end_date,
            AnalysisSalesOrderRow.is_counted_sales.is_(True),
        )
    )
    rows = db.execute(stmt).scalars().all()
    total = Decimal('0')
    for price in rows:
        total += Decimal(str(price or 0))
    return total


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def list_goals(
    db: Session,
    project_id: int,
    country: str,
    year: int,
    goal_type: str | None = None,
    metric_type: str | None = None,
) -> list[ProjectGoalItem]:
    """列出指定项目/国家/年份的目标"""
    stmt = (
        select(ProjectGoal)
        .where(
            ProjectGoal.project_id == project_id,
            ProjectGoal.country == country,
            ProjectGoal.period_year == year,
        )
        .order_by(ProjectGoal.goal_type, ProjectGoal.period_month)
    )
    if goal_type:
        stmt = stmt.where(ProjectGoal.goal_type == goal_type)
    if metric_type:
        stmt = stmt.where(ProjectGoal.metric_type == metric_type)
    rows = db.execute(stmt).scalars().all()
    return [_serialize_goal(r) for r in rows]


def get_goal(db: Session, goal_id: int) -> ProjectGoalItem:
    """获取单条目标"""
    row = _get_goal_or_404(db, goal_id)
    return _serialize_goal(row)


def create_goal(db: Session, data: ProjectGoalCreate) -> ProjectGoalItem:
    """创建目标"""
    normalized_country = normalize_country(data.country)

    if data.goal_type == MONTHLY and data.period_month is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail='月度目标必须指定 period_month',
        )
    if data.goal_type == ANNUAL and data.period_month is not None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail='年度目标不能指定 period_month',
        )
    if data.goal_type not in (MONTHLY, ANNUAL):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail='goal_type must be monthly or annual',
        )
    if data.metric_type not in ALLOWED_METRIC_TYPES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f'metric_type must be one of: {", ".join(sorted(ALLOWED_METRIC_TYPES))}',
        )

    goal = ProjectGoal(
        project_id=data.project_id,
        country=normalized_country,
        goal_type=data.goal_type,
        metric_type=data.metric_type,
        period_year=data.period_year,
        period_month=data.period_month,
        target_amount=Decimal(str(data.target_amount)),
    )
    try:
        db.add(goal)
        db.commit()
        db.refresh(goal)
    except IntegrityError as exc:
        db.rollback()
        if _is_unique_period_conflict(exc):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail='该目标已存在（同一项目/国家/类型/指标/年份/月份组合）',
            ) from exc
        if _is_missing_id_default_failure(exc):
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail='project_goals 表主键自增配置异常，请执行最新数据库迁移',
            ) from exc
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail='创建目标失败，数据库约束异常',
        ) from exc
    return _serialize_goal(goal)


def update_goal(db: Session, goal_id: int, data: ProjectGoalUpdate) -> ProjectGoalItem:
    """更新目标"""
    goal = _get_goal_or_404(db, goal_id)
    goal.target_amount = Decimal(str(data.target_amount))
    db.add(goal)
    db.commit()
    db.refresh(goal)
    return _serialize_goal(goal)


def delete_goal(db: Session, goal_id: int) -> None:
    """删除目标"""
    goal = _get_goal_or_404(db, goal_id)
    db.delete(goal)
    db.commit()


def get_progress(
    db: Session,
    project_id: int,
    country: str,
    year: int,
    metric_type: str = 'sales_amount',
) -> ProjectGoalProgressResponse:
    """计算目标完成进度"""
    normalized_country = normalize_country(country)
    currency = _get_currency(normalized_country)
    _get_project_or_404(db, project_id)

    today = _get_today_in_country_timezone(normalized_country)
    goals = list_goals(
        db, project_id, normalized_country, year,
        metric_type=metric_type,
    )

    # 构建月度目标字典 {(month): target_amount}
    monthly_goal_map: dict[int, Decimal] = {}
    annual_goal: Decimal | None = None
    for g in goals:
        if g.goal_type == MONTHLY and g.period_month is not None:
            monthly_goal_map[g.period_month] = Decimal(str(g.target_amount))
        elif g.goal_type == ANNUAL:
            annual_goal = Decimal(str(g.target_amount))

    # 构建月度完成进度
    monthly_progress: list[MonthlyProgressItem] = []
    for month in range(1, 13):
        target = monthly_goal_map.get(month)
        achieved = _query_monthly_sales(db, project_id, normalized_country, year, month)
        _, days_in_month = monthrange(year, month)
        today_day = (
            today.day if today.year == year and today.month == month
            else 0  # past months: no daily pace metric
        )

        daily_target = float(target / days_in_month) if target and days_in_month else 0.0
        cumulative_daily_target = daily_target * today_day
        achieved_f = float(achieved)

        if target and target > 0:
            completion_vs_monthly = achieved_f / float(target)
        else:
            completion_vs_monthly = 0.0

        if cumulative_daily_target > 0:
            completion_vs_daily = achieved_f / cumulative_daily_target
        else:
            completion_vs_daily = 0.0

        month_label = f'{year}年{month}月'

        monthly_progress.append(MonthlyProgressItem(
            year=year,
            month=month,
            month_label=month_label,
            target_amount=float(target) if target else 0.0,
            achieved_amount=achieved_f,
            completion_rate=completion_vs_monthly,
            days_in_month=days_in_month,
            today_day=today_day,
            daily_target=daily_target,
            cumulative_daily_target=cumulative_daily_target,
            completion_vs_daily=completion_vs_daily,
            completion_vs_monthly=completion_vs_monthly,
            currency=currency,
        ))

    # 年度进度
    annual_progress: AnnualProgressItem | None = None
    if annual_goal is not None:
        annual_achieved = _query_annual_sales(db, project_id, normalized_country, year)
        annual_progress = AnnualProgressItem(
            year=year,
            target_amount=float(annual_goal),
            achieved_amount=float(annual_achieved),
            completion_rate=float(annual_achieved) / float(annual_goal) if annual_goal > 0 else 0.0,
            currency=currency,
        )

    return ProjectGoalProgressResponse(
        project_id=project_id,
        country=normalized_country,
        currency=currency,
        year=year,
        monthly_progress=monthly_progress,
        annual_progress=annual_progress,
    )
