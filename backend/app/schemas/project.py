from pydantic import BaseModel, Field, field_validator
from typing import Any


class ProjectOption(BaseModel):
    id: int | None = None
    name: str


class ProjectItem(BaseModel):
    id: int
    name: str
    brand_name: str | None = None
    store_address: str | None = None
    project_operator: str | None = None
    assistant_operator: str | None = None
    commission_basis: str | None = None
    commission_rate: float | None = None
    sort_order: int
    is_active: bool = True
    source_file: str | None = None
    has_context: bool = False

    @field_validator('is_active', mode='before')
    @classmethod
    def _coerce_is_active(cls, v):
        # Guard against NULL coming from legacy migration data
        return bool(v) if v is not None else True


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    brand_name: str | None = Field(default=None, max_length=255)
    store_address: str | None = Field(default=None, max_length=255)
    project_operator: str | None = Field(default=None, max_length=4000)
    assistant_operator: str | None = Field(default=None, max_length=4000)
    commission_basis: str | None = Field(default=None, max_length=32)
    commission_rate: float | None = Field(default=None, ge=0, le=100)


class ProjectUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    brand_name: str | None = Field(default=None, max_length=255)
    store_address: str | None = Field(default=None, max_length=255)
    project_operator: str | None = Field(default=None, max_length=4000)
    assistant_operator: str | None = Field(default=None, max_length=4000)
    commission_basis: str | None = Field(default=None, max_length=32)
    commission_rate: float | None = Field(default=None, ge=0, le=100)
    is_active: bool | None = Field(default=None)


class ProjectContextResponse(BaseModel):
    """API response for project context endpoints."""
    project_id: int
    project_name: str
    project_context: dict[str, Any] | None = None
    sku_context: dict[str, Any] | None = None


class ProjectContextUpdate(BaseModel):
    """API request for updating project context (JSON Merge Patch semantics)."""
    project_context: dict[str, Any] | None = None
    sku_context: dict[str, Any] | None = None
