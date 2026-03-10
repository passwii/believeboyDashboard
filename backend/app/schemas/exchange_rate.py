from pydantic import BaseModel, Field


class ExchangeRateNoteImage(BaseModel):
    id: str = Field(min_length=1)
    url: str = Field(min_length=1)
    thumbnail_url: str | None = None
    filename: str = Field(min_length=1)
    content_type: str = Field(min_length=1)
    size: int = Field(ge=0)
    uploaded_at: str = Field(min_length=1)


class ExchangeRateItem(BaseModel):
    id: int
    currency: str
    currency_name: str | None = None
    year_month: str
    rate: float
    description: str | None = None
    note_images: list[ExchangeRateNoteImage] = Field(default_factory=list)
    created_at: str
    updated_at: str


class ExchangeRateListResponse(BaseModel):
    items: list[ExchangeRateItem]
    total: int
    page: int
    page_size: int


class ExchangeRateCreate(BaseModel):
    currency: str = Field(min_length=1, max_length=32)
    currency_name: str | None = Field(default=None, max_length=128)
    year_month: str | None = None
    year: int | None = Field(default=None, ge=1900, le=9999)
    month: int | None = Field(default=None, ge=1, le=12)
    rate: float = Field(gt=0)
    description: str | None = None
    note_images: list[ExchangeRateNoteImage] = Field(default_factory=list)


class ExchangeRateUpdate(BaseModel):
    currency: str | None = Field(default=None, min_length=1, max_length=32)
    currency_name: str | None = Field(default=None, max_length=128)
    year_month: str | None = None
    year: int | None = Field(default=None, ge=1900, le=9999)
    month: int | None = Field(default=None, ge=1, le=12)
    rate: float | None = Field(default=None, gt=0)
    description: str | None = None
    note_images: list[ExchangeRateNoteImage] | None = None


class ExchangeRateOption(BaseModel):
    value: str | int
    label: str


class ExchangeRateOptionsResponse(BaseModel):
    currencies: list[ExchangeRateOption]
    years: list[ExchangeRateOption]
    months: list[ExchangeRateOption]


class ExchangeRateUploadResponse(BaseModel):
    id: str
    url: str
    thumbnail_url: str | None = None
    filename: str
    content_type: str
    size: int
    uploaded_at: str
