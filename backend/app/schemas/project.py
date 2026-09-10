from pydantic import BaseModel, Field, field_validator
from typing import Any

from app.utils.country import normalize_country


def _validate_country(value: str | None) -> str | None:
    """Validate + normalize a country code against SUPPORTED_COUNTRIES.

    ``None`` is passed through untouched (used by update semantics where
    ``None`` means "keep current value"). Any unrecognised value raises
    ``ValueError`` → HTTP 422 via FastAPI.
    """
    if value is None:
        return None
    # normalize_country raises ValueError in strict mode for unknown codes,
    # and maps aliases (USA/美国/德国站/GB …) to US/DE/UK canonical codes.
    return normalize_country(value)


class ProjectOption(BaseModel):
    id: int | None = None
    name: str
    country: str = "US"
    country_name: str | None = None


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
    project_tier: str | None = None
    country: str = "US"
    country_name: str | None = None
    vat_enabled: bool = False

    @field_validator("is_active", mode="before")
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
    project_tier: str | None = Field(default=None, max_length=8)
    country: str = "US"
    vat_enabled: bool = False

    @field_validator("country", mode="before")
    @classmethod
    def _normalize_country(cls, v):
        normalized = _validate_country(v)
        return "US" if normalized is None else normalized


class ProjectUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    brand_name: str | None = Field(default=None, max_length=255)
    store_address: str | None = Field(default=None, max_length=255)
    project_operator: str | None = Field(default=None, max_length=4000)
    assistant_operator: str | None = Field(default=None, max_length=4000)
    commission_basis: str | None = Field(default=None, max_length=32)
    commission_rate: float | None = Field(default=None, ge=0, le=100)
    is_active: bool | None = Field(default=None)
    project_tier: str | None = Field(default=None, max_length=8)
    country: str | None = None
    vat_enabled: bool | None = Field(default=None)

    @field_validator("country", mode="before")
    @classmethod
    def _normalize_country(cls, v):
        return _validate_country(v)


class ProjectShopItem(BaseModel):
    id: int
    country: str
    shop_id: str
    shop_name: str | None = None
    seller_identity_expected_alias: str | None = None
    seller_identity_aliases: list[str] = Field(default_factory=list)
    seller_identity_source: str | None = None
    seller_identity_required: bool = True


class ProjectShopUpsert(BaseModel):
    shop_id: str = Field(min_length=1, max_length=64)
    shop_name: str | None = Field(default=None, max_length=128)
    seller_identity_expected_alias: str | None = Field(default=None, max_length=128)
    seller_identity_aliases: list[str] = Field(default_factory=list)
    seller_identity_source: str | None = Field(default=None, max_length=128)
    seller_identity_required: bool = True

    @field_validator("shop_id")
    @classmethod
    def _validate_shop_id(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("shop_id must not be blank")
        return normalized

    @field_validator("shop_name", "seller_identity_expected_alias", mode="before")
    @classmethod
    def _strip_optional(cls, value):
        if value is None:
            return None
        stripped = str(value).strip()
        return stripped or None


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


class ParseContextRequest(BaseModel):
    """API request for parsing project context with AI."""

    description: str = Field(min_length=1, description="自然语言项目背景描述")


class ParseContextResponse(BaseModel):
    """API response for parsed project context."""

    result: dict[str, Any] = Field(
        default_factory=dict, description="解析后的上下文配置"
    )
