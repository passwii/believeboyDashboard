from __future__ import annotations

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
    marketplace: str = Field(min_length=2, max_length=2)
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
