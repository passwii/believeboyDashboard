"""
项目角色分配服务。
"""
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.project_role_assignment import ProjectRoleAssignment


def upsert_project_role_assignments(
    db: Session,
    items: list[dict],
) -> list[ProjectRoleAssignment]:
    """Upsert 项目角色分配。"""
    for item in items:
        row = None
        if item.id is not None:
            row = db.execute(
                select(ProjectRoleAssignment).where(ProjectRoleAssignment.id == item.id)
            ).scalars().first()
        if row is None:
            row = ProjectRoleAssignment(
                project_id=item.project_id,
                role_type=item.role_type.strip(),
                person_name=item.person_name.strip(),
                effective_from_month=item.effective_from_month,
                effective_to_month=item.effective_to_month,
            )
            db.add(row)
        else:
            row.project_id = item.project_id
            row.role_type = item.role_type.strip()
            row.person_name = item.person_name.strip()
            row.effective_from_month = item.effective_from_month
            row.effective_to_month = item.effective_to_month

    db.commit()

    return db.execute(
        select(ProjectRoleAssignment).order_by(
            ProjectRoleAssignment.project_id.asc(),
            ProjectRoleAssignment.role_type.asc(),
            ProjectRoleAssignment.effective_from_month.asc(),
            ProjectRoleAssignment.person_name.asc(),
        )
    ).scalars().all()