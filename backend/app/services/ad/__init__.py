"""Ad analysis service package.

Extracted from ad_analysis_service.py (stage 3 of backend refactor plan).
All public functions remain importable from the legacy module for backward compatibility.
"""
from .loaders import *
from .metrics import (
    build_issue_card,
    build_narrative_section,
    classify_budget_action,
    classify_budget_next_step,
)
from .analysis import *
from .budget import *
from .campaign import *
from .build_products import build_products
from .build_placements import build_placements
from .build_traffic_quality import build_traffic_quality
from .build_search_terms import build_search_terms
from .build_targets import build_targets
from .build_time_trend import build_time_trend
from .build_purchased_products import build_purchased_products