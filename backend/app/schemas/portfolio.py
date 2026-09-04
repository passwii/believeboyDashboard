from pydantic import BaseModel

from .daily_analysis import DailyAnalysisSummaryRow


class ProjectPortfolioKPI(BaseModel):
    """Portfolio-level KPI for a single project."""
    project_id: int
    project_name: str
    sales_amount: float = 0.0
    order_qty: int = 0
    ad_spend: float = 0.0
    conversion_rate: float = 0.0
    impressions: int = 0
    clicks: int = 0
    cpc: float = 0.0
    ad_orders: int = 0
    page_views: int = 0
    sessions: int = 0
    available_qty: int = 0
    daily_trend: list[DailyAnalysisSummaryRow] = []
    # Contribution (percentage, 0-100)
    sales_contribution: float = 0.0
    order_contribution: float = 0.0
    ad_spend_contribution: float = 0.0


class PortfolioSummary(BaseModel):
    """Response shape consumed by the portfolio overview frontend page.

    Built from the existing /daily-analysis/all endpoint's project_breakdown field.
    """
    projects: list[ProjectPortfolioKPI]
    total_sales_amount: float = 0.0
    total_order_qty: int = 0
    total_ad_spend: float = 0.0
    avg_conversion_rate: float = 0.0
    total_impressions: int = 0
    total_clicks: int = 0
    total_sessions: int = 0