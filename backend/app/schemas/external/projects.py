"""Project response schemas for the shared agent project query."""
from __future__ import annotations

from pydantic import BaseModel, Field


class SellerIdentity(BaseModel):
    """Seller Central 页面身份对照（BLF-1022）。

    ``expected_alias`` 必须是页面账户切换器可见的店铺 alias；
    ``required=true`` 时缺少 ``expected_alias`` 不允许 Agent 将该店铺作为可写店铺。
    """

    expected_alias: str | None = None
    aliases: list[str] = Field(default_factory=list)
    source: str | None = None
    required: bool = True


class AgentShopItem(BaseModel):
    shop_id: str
    shop_name: str | None = None
    country: str
    site: str
    seller_identity: SellerIdentity = Field(default_factory=SellerIdentity)


class ProjectItem(BaseModel):
    """Minimal project descriptor returned by the agent projects list."""

    project_id: int
    project_name: str
    country: str = "US"
    country_name: str | None = None
    is_active: bool = True
    shops: list[AgentShopItem] = Field(default_factory=list)
