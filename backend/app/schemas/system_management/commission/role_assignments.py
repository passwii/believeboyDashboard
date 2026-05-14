"""
项目角色分配 Schema。
"""
from pydantic import BaseModel, Field


class ProjectRoleAssignmentItem(BaseModel):
    id: int
    project_id: int
    role_type: str
    person_name: str
    effective_from_month: str
    effective_to_month: str | None = None
    updated_at: str


class UpsertProjectRoleAssignmentItem(BaseModel):
    id: int | None = None
    project_id: int = Field(gt=0)
    role_type: str = Field(min_length=1, max_length=32)
    person_name: str = Field(min_length=1, max_length=255)
    effective_from_month: str = Field(min_length=7, max_length=7)
    effective_to_month: str | None = Field(default=None, min_length=7, max_length=7)


class UpsertProjectRoleAssignmentsRequest(BaseModel):
    items: list[UpsertProjectRoleAssignmentItem] = Field(default_factory=list)


class ProjectRoleAssignmentsResponse(BaseModel):
    items: list[ProjectRoleAssignmentItem] = Field(default_factory=list)