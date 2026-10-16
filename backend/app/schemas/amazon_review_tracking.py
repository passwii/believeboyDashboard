from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

SUPPORTED_MARKETPLACES = frozenset({"US", "CA", "UK", "DE", "FR", "IT", "ES", "JP", "AU", "MX", "BR", "NL", "SE", "PL", "BE", "IN", "SG", "AE", "SA", "TR", "EG"})


def validate_marketplace(value: str) -> str:
    normalized = value.strip().upper()
    if normalized not in SUPPORTED_MARKETPLACES:
        raise ValueError("unsupported Marketplace")
    return normalized


class ReviewGroupCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    project_id: int = Field(gt=0)
    marketplace: str = Field(min_length=2, max_length=20)
    name: str = Field(min_length=1, max_length=255)
    description: str | None = None
    member_ids: list[int] = Field(min_length=1)
    representative_id: int = Field(gt=0)

    @field_validator("marketplace")
    @classmethod
    def marketplace_valid(cls, value: str) -> str:
        return validate_marketplace(value)

    @field_validator("name")
    @classmethod
    def name_trimmed(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("name must not be blank")
        return value

    @model_validator(mode="after")
    def members_unique_and_representative_valid(self):
        if len(set(self.member_ids)) != len(self.member_ids):
            raise ValueError("duplicate member IDs")
        if self.representative_id not in self.member_ids:
            raise ValueError("representative must be a member")
        return self


class ReviewGroupMemberReplace(BaseModel):
    model_config = ConfigDict(extra="forbid")
    member_ids: list[int] = Field(min_length=1)

    @field_validator("member_ids")
    @classmethod
    def unique_positive_members(cls, values: list[int]) -> list[int]:
        if any(value <= 0 for value in values):
            raise ValueError("member IDs must be positive")
        if len(set(values)) != len(values):
            raise ValueError("duplicate member IDs")
        return values


class ReviewGroupRepresentativeUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sku_record_id: int = Field(gt=0)


class TargetItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    kind: str
    group_id: int | None
    project_id: int | None
    marketplace: str
    asin: str | None
    display_name: str | None
    is_active: bool


class RatingSnapshotItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    capture_date: date
    captured_at: datetime
    average_rating: float | None
    rating_count: int | None
    review_count: int | None
    star_1_percentage: float | None
    star_2_percentage: float | None
    star_3_percentage: float | None
    star_4_percentage: float | None
    star_5_percentage: float | None
    star_1_count: int | None
    star_2_count: int | None
    star_3_count: int | None
    star_4_count: int | None
    star_5_count: int | None
    star_count_quality: str
    capture_status: str


class ReviewItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    review_key: str
    id_confidence: str
    reviewer_id: str | None
    reviewer_name: str | None
    rating: int | None
    title: str | None
    body: str | None
    review_date: date | None
    verified_purchase: bool | None
    helpful_count: int | None
    first_seen_at: datetime
    last_seen_at: datetime
    visibility_status: str


class CrawlRunItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    started_at: datetime
    finished_at: datetime | None
    status: str
    is_complete_list: bool
    reviews_seen: int | None
    ratings_captured: bool
    asin_scraped: str | None
    error_message: str | None


class ExternalLinkItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    target_id: int
    shop_id: int
    is_active: bool


class ExternalTargetItem(TargetItem):
    links: list[ExternalLinkItem]


class ExternalTargetCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    marketplace: str = Field(min_length=2, max_length=20)
    asin: str = Field(min_length=1, max_length=20)
    shop_id: int | None = Field(default=None, gt=0)
    display_name: str | None = Field(default=None, max_length=255)

    @field_validator("marketplace")
    @classmethod
    def marketplace_valid(cls, value: str) -> str:
        return validate_marketplace(value)

    @field_validator("asin")
    @classmethod
    def asin_normalized(cls, value: str) -> str:
        value = value.strip().upper()
        if not value:
            raise ValueError("asin must not be blank")
        return value


class ExternalLinkCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    shop_id: int = Field(gt=0)
