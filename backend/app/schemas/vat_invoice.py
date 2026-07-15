from __future__ import annotations
from typing import Any
from pydantic import BaseModel, ConfigDict, Field


# ---- VAT entity ----

class VatEntityBase(BaseModel):
    country: str = Field(min_length=2, max_length=2)
    company_name: str = Field(min_length=1, max_length=255)
    vat_id: str = Field(default='', max_length=64)
    address_line: str = Field(default='', max_length=512)
    postal_code: str = Field(default='', max_length=32)
    city: str = Field(default='', max_length=128)
    email: str = Field(default='', max_length=255)
    is_default: bool = False


class VatEntityCreate(VatEntityBase):
    project_id: int = Field(gt=0)


class VatEntityUpdate(BaseModel):
    company_name: str | None = Field(default=None, min_length=1, max_length=255)
    vat_id: str | None = Field(default=None, max_length=64)
    address_line: str | None = Field(default=None, max_length=512)
    postal_code: str | None = Field(default=None, max_length=32)
    city: str | None = Field(default=None, max_length=128)
    email: str | None = Field(default=None, max_length=255)
    is_default: bool | None = None


class VatEntityResponse(VatEntityBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    project_id: int
    created_at: Any
    updated_at: Any
