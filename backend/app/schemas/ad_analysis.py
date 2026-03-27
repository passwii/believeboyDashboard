from pydantic import BaseModel, Field


class AdAnalysisMetricCard(BaseModel):
    label: str
    value: float
    display_value: str
    helper: str | None = None


class AdAnalysisIssueCard(BaseModel):
    title: str
    level: str
    summary: str
    drill_to: str | None = None
    next_step: str | None = None


class AdAnalysisNarrativeSection(BaseModel):
    title: str
    summary: str
    evidence: list[str] = Field(default_factory=list)
    action: str | None = None
    drill_to: str | None = None


class AdAnalysisPeriodComparison(BaseModel):
    current_start: str | None = None
    current_end: str | None = None
    previous_start: str | None = None
    previous_end: str | None = None
    spend_change_ratio: float | None = None
    clicks_change_ratio: float | None = None
    sales_change_ratio: float | None = None
    orders_change_ratio: float | None = None
    cpc_change_ratio: float | None = None
    acos_change_ratio: float | None = None
    summary: str | None = None


class AdAnalysisOverviewResponse(BaseModel):
    project_id: int
    country: str
    metrics: list[AdAnalysisMetricCard]
    issue_cards: list[AdAnalysisIssueCard] = Field(default_factory=list)
    narrative_sections: list[AdAnalysisNarrativeSection] = Field(default_factory=list)
    comparison: AdAnalysisPeriodComparison | None = None
    top_campaigns: list[dict[str, object]] = Field(default_factory=list)
    top_products: list[dict[str, object]] = Field(default_factory=list)
    top_waste_terms: list[dict[str, object]] = Field(default_factory=list)
    trend_summary: list[dict[str, object]] = Field(default_factory=list)
    top_cross_sell_products: list[dict[str, object]] = Field(default_factory=list)


class AdAnalysisCampaignsResponse(BaseModel):
    project_id: int
    country: str
    summary_cards: list[dict[str, object]] = Field(default_factory=list)
    narrative_sections: list[AdAnalysisNarrativeSection] = Field(default_factory=list)
    items: list[dict[str, object]] = Field(default_factory=list)


class AdAnalysisProductsResponse(BaseModel):
    project_id: int
    country: str
    summary_cards: list[dict[str, object]] = Field(default_factory=list)
    items: list[dict[str, object]] = Field(default_factory=list)


class AdAnalysisBudgetResponse(BaseModel):
    project_id: int
    country: str
    summary_cards: list[dict[str, object]] = Field(default_factory=list)
    narrative_sections: list[AdAnalysisNarrativeSection] = Field(default_factory=list)
    items: list[dict[str, object]] = Field(default_factory=list)


class AdAnalysisPlacementsResponse(BaseModel):
    project_id: int
    country: str
    summary_cards: list[dict[str, object]] = Field(default_factory=list)
    narrative_sections: list[AdAnalysisNarrativeSection] = Field(default_factory=list)
    items: list[dict[str, object]] = Field(default_factory=list)


class AdAnalysisTrafficQualityResponse(BaseModel):
    project_id: int
    country: str
    summary_cards: list[dict[str, object]] = Field(default_factory=list)
    narrative_sections: list[AdAnalysisNarrativeSection] = Field(default_factory=list)
    items: list[dict[str, object]] = Field(default_factory=list)


class AdAnalysisSearchTermsResponse(BaseModel):
    project_id: int
    country: str
    summary_cards: list[dict[str, object]] = Field(default_factory=list)
    narrative_sections: list[AdAnalysisNarrativeSection] = Field(default_factory=list)
    items: list[dict[str, object]] = Field(default_factory=list)


class AdAnalysisTargetsResponse(BaseModel):
    project_id: int
    country: str
    summary_cards: list[dict[str, object]] = Field(default_factory=list)
    items: list[dict[str, object]] = Field(default_factory=list)


class AdAnalysisTimeTrendResponse(BaseModel):
    project_id: int
    country: str
    summary: list[dict[str, object]] = Field(default_factory=list)
    comparison: AdAnalysisPeriodComparison | None = None


class AdAnalysisPurchasedProductsResponse(BaseModel):
    project_id: int
    country: str
    items: list[dict[str, object]] = Field(default_factory=list)
