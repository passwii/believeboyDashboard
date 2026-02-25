from pydantic import BaseModel, Field


class ProjectOption(BaseModel):
    name: str


class ProjectItem(BaseModel):
    id: int
    name: str
    brand_name: str | None = None
    store_address: str | None = None
    sort_order: int
    source_file: str | None = None


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    brand_name: str | None = Field(default=None, max_length=255)
    store_address: str | None = Field(default=None, max_length=255)


class ProjectUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    brand_name: str | None = Field(default=None, max_length=255)
    store_address: str | None = Field(default=None, max_length=255)
