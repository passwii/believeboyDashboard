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


# ---- VAT invoice ----

from datetime import date  # noqa: E402
from decimal import Decimal  # noqa: E402


class VatInvoiceLineIn(BaseModel):
    description: str = Field(min_length=1, max_length=512)
    asin: str = Field(default='', max_length=32)
    qty: int = Field(gt=0, default=1)
    unit_price_incl_vat: Decimal = Field(ge=0)
    vat_rate: Decimal = Field(ge=0, le=100)


class VatInvoiceLineResponse(VatInvoiceLineIn):
    model_config = ConfigDict(from_attributes=True)
    id: int
    line_no: int
    line_excl: Decimal
    line_vat: Decimal
    line_incl: Decimal


class VatBuyerIn(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    address_line: str = Field(default='', max_length=512)
    postal_code: str = Field(default='', max_length=32)
    city: str = Field(default='', max_length=128)
    country: str = Field(default='', max_length=2)


class VatInvoiceCreate(BaseModel):
    project_id: int = Field(gt=0)
    seller_entity_id: int | None = None
    currency: str = Field(min_length=3, max_length=3)
    order_id: str = Field(default='', max_length=64)
    invoice_date: date
    buyer: VatBuyerIn
    shipping_incl_vat: Decimal = Field(default=Decimal(0), ge=0)
    lines: list[VatInvoiceLineIn] = Field(min_length=1)
    status: str = Field(default='draft')


class VatInvoiceListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    invoice_no: str
    project_id: int
    project_name: str = ''
    currency: str
    order_id: str
    buyer_name: str
    invoice_date: date
    subtotal_excl: Decimal
    total_vat: Decimal
    total_incl: Decimal
    status: str
    has_pdf: bool
    created_at: Any
    updated_at: Any


class VatInvoiceResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    invoice_no: str
    project_id: int
    seller_entity_id: int | None
    seller_snapshot: dict[str, Any]
    buyer: dict[str, Any]
    currency: str
    order_id: str
    invoice_date: date
    shipping_incl_vat: Decimal
    subtotal_excl: Decimal
    total_vat: Decimal
    total_incl: Decimal
    summary_by_rate: list[Any]
    r2_key: str | None
    r2_url: str | None
    status: str
    void_reason: str | None
    created_by: str | None
    created_at: Any
    updated_at: Any
    lines: list[VatInvoiceLineResponse]


class VatInvoicePdfUploadRequest(BaseModel):
    pdf_base64: str = Field(min_length=1)
    filename: str = Field(min_length=1, max_length=128)


class VatInvoicePdfUploadResponse(BaseModel):
    id: int
    invoice_no: str
    r2_key: str
    r2_url: str
    status: str


class VatInvoiceVoidRequest(BaseModel):
    reason: str = Field(default='', max_length=512)
