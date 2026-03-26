from pydantic import BaseModel, Field


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
    source_file: str | None = None


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
