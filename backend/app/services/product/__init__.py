"""Product analysis service - split from product_analysis_source_service.py.

模块结构:
    _internal.py   - 内部共享工具
    persistence.py - 源文件入库 (SourcePersistOutcome, ensure_tables, persist_*)
    sources.py     - 源文件查询与序列化 (list_sources, get_source_rows, get_current_inventory_snapshot)
    analysis.py    - 核心分析计算 (recompute, check_availability, run_calculation)
    business.py    - 商业数据 DataFrame 构建
    ad.py          - 广告数据 DataFrame 构建
    sales.py       - 销售报告按日持久化

注意: payment 相关功能已移至 services.payment 模块
"""
from app.services.product._internal import (
    _is_full_iso_week as _is_full_iso_week,
    _is_single_full_week as _is_single_full_week,
)
from app.services.product.analysis import (
    check_product_calculation_data_availability,
    list_weekly_product_analysis_from_details,
    recompute_pt1_for_period,
    recompute_weekly_product_analysis_from_history,
    run_product_calculation_from_history,
)
from app.services.product.persistence import (
    SourcePersistOutcome,
    ensure_tables,
    persist_product_analysis_pt1_calculation,
    persist_product_analysis_sources,
    persist_single_analysis_source,
    persist_single_date_report_sources,
)
from app.services.product.sales import (
    persist_sales_report_by_purchase_date,
)
from app.services.product.sources import (
    get_current_inventory_snapshot,
    get_source_or_none,
    get_source_rows,
    list_sources,
)