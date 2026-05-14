"""Reporting, recommendations, and signal generation."""

from __future__ import annotations

from typing import Any


def risk_label(level: str) -> str:
    """Convert risk level to Chinese label."""
    if level == 'high':
        return '高'
    if level == 'medium':
        return '中'
    return '低'


def max_risk_level(levels: list[str | None]) -> str:
    """Get maximum risk level from list."""
    valid = [item for item in levels if item in {'high', 'medium', 'low'}]
    if 'high' in valid:
        return 'high'
    if 'medium' in valid:
        return 'medium'
    return 'low'


def build_dimension_blocks(advanced_metrics: dict[str, Any]) -> list[dict[str, Any]]:
    """Build three dimension blocks: structure, opportunity, execution."""
    brand = advanced_metrics['brand_monopoly']
    seller = advanced_metrics['seller_monopoly']
    product = advanced_metrics['product_monopoly']
    china = advanced_metrics['china_seller_competition']
    growth = advanced_metrics['market_growth']
    seasonality = advanced_metrics['seasonality']
    review = advanced_metrics['review_research']
    new_product = advanced_metrics['new_product_opportunity']
    quality = advanced_metrics['data_quality']

    structure_level = max_risk_level([
        brand.get('risk_level'),
        seller.get('risk_level'),
        product.get('risk_level'),
        china.get('risk_level'),
    ])

    opportunity_score = 0
    if growth.get('growth_level') == 'growing':
        opportunity_score += 1
    if seasonality.get('seasonality_level') in {'weak', 'moderate'}:
        opportunity_score += 1
    if new_product.get('new_product_sales_share', 0.0) >= 0.12:
        opportunity_score += 1
    if review.get('low_review_product_share', 0.0) >= 0.35:
        opportunity_score += 1

    if opportunity_score >= 3:
        opportunity_level = 'high'
    elif opportunity_score >= 2:
        opportunity_level = 'medium'
    else:
        opportunity_level = 'low'

    execution_level = 'high' if quality.get('score', 0.0) < 80 else 'medium' if quality.get('score', 0.0) < 92 else 'low'

    return [
        {
            'key': 'structure',
            'label': '竞争结构',
            'summary': f"品牌CR3 {brand.get('brand_cr3', 0.0):.2%}，卖家CR3 {seller.get('seller_cr3', 0.0):.2%}，结构风险{risk_label(structure_level)}。",
            'risk_level': structure_level,
            'metric_keys': ['brand_cr3', 'brand_hhi', 'seller_cr3', 'seller_hhi', 'asin_top1_share', 'china_seller_sales_share'],
        },
        {
            'key': 'opportunity',
            'label': '机会定位',
            'summary': f"增长 {growth.get('growth_level', 'stable')}，季节性 {seasonality.get('seasonality_level', 'weak')}，新品销量占比 {new_product.get('new_product_sales_share', 0.0):.2%}。",
            'risk_level': opportunity_level,
            'metric_keys': ['last12_vs_prev12_growth', 'cagr_like_growth', 'seasonality_level', 'review_p75', 'new_product_sales_share', 'supply_complexity_score'],
        },
        {
            'key': 'execution',
            'label': '执行落地',
            'summary': f"数据质量分 {quality.get('score', 0.0):.2f}，建议优先处理高影响验证项后推进候选池。",
            'risk_level': execution_level,
            'metric_keys': ['data_quality_score', 'missing_trend_for_asin_count', 'invalid_price_count', 'duplicate_asin_count'],
        },
    ]


def build_metric_definitions(advanced_metrics: dict[str, Any]) -> list[dict[str, Any]]:
    """Build metric definition cards."""
    brand = advanced_metrics['brand_monopoly']
    seller = advanced_metrics['seller_monopoly']
    product = advanced_metrics['product_monopoly']
    growth = advanced_metrics['market_growth']
    seasonality = advanced_metrics['seasonality']
    new_product = advanced_metrics['new_product_opportunity']
    supply = advanced_metrics['supply_complexity']
    quality = advanced_metrics['data_quality']
    china = advanced_metrics['china_seller_competition']

    return [
        {
            'key': 'brand_cr3',
            'name': '品牌CR3 (Concentration Ratio 3)',
            'formula_text': '前3品牌月销量之和 / 类目总月销量',
            'thresholds': ['低 < 45%', '中 45%-70%', '高 >= 70%'],
            'interpretation_template': f"当前值 {brand.get('brand_cr3', 0.0):.2%}，用于识别头部品牌垄断程度。",
            'pitfall': 'CR3高不等于不可进入，若利润带宽大且差异化明确仍可切入。',
            'action_hint': '若CR3高，优先寻找中尾部未被充分覆盖的价格带和功能点。',
        },
        {
            'key': 'brand_hhi',
            'name': '品牌HHI (Herfindahl-Hirschman Index)',
            'formula_text': 'Σ(品牌销量占比 × 100)^2',
            'thresholds': ['低 < 1500', '中 1500-2500', '高 >= 2500'],
            'interpretation_template': f"当前值 {brand.get('brand_hhi', 0.0):.0f}，用于综合衡量品牌集中度。",
            'pitfall': 'HHI对长尾品牌变化敏感，需和CR3联合判断。',
            'action_hint': 'HHI高时减少正面竞争，转向差异化卖点和细分场景。',
        },
        {
            'key': 'seller_cr3',
            'name': '卖家CR3 (Seller Concentration Ratio 3)',
            'formula_text': '前3卖家月销量之和 / 类目总月销量',
            'thresholds': ['低 < 45%', '中 45%-70%', '高 >= 70%'],
            'interpretation_template': f"当前值 {seller.get('seller_cr3', 0.0):.2%}，反映卖家侧渠道控制强度。",
            'pitfall': '卖家集中可能由季节活动驱动，需结合趋势判断持续性。',
            'action_hint': '卖家CR3高时，优先评估渠道壁垒和非价格竞争空间。',
        },
        {
            'key': 'seller_hhi',
            'name': '卖家HHI',
            'formula_text': 'Σ(卖家销量占比 × 100)^2',
            'thresholds': ['低 < 1500', '中 1500-2500', '高 >= 2500'],
            'interpretation_template': f"当前值 {seller.get('seller_hhi', 0.0):.0f}，用于识别渠道竞争集中度。",
            'pitfall': '卖家名称归一化不足会低估HHI，需要清洗同主体别名。',
            'action_hint': '卖家HHI高时，优先建立差异化供给与内容护城河。',
        },
        {
            'key': 'seller_monopoly_ratio',
            'name': '卖家垄断系数 (Seller Monopoly Coefficient)',
            'formula_text': '0.6 × Seller CR3 + 0.4 × min(Seller HHI / 2500, 1)',
            'thresholds': ['低 < 0.45', '中 0.45-0.70', '高 >= 0.70'],
            'interpretation_template': f"当前值 {(0.6 * seller.get('seller_cr3', 0.0) + 0.4 * min(seller.get('seller_hhi', 0.0) / 2500.0, 1.0)):.2f}，用于统一卖家垄断风险判断。",
            'pitfall': '该系数是策略指标，不替代原始CR3/HHI口径。',
            'action_hint': '系数偏高时，执行阶段应提高"暂缓进入"门槛。',
        },
        {
            'key': 'asin_top1_share',
            'name': '产品Top1份额',
            'formula_text': 'Top1 ASIN月销量 / 类目总月销量',
            'thresholds': ['低 < 20%', '中 20%-35%', '高 >= 35%'],
            'interpretation_template': f"当前值 {product.get('asin_top1_share', 0.0):.2%}，用于识别单品虹吸效应。",
            'pitfall': 'Top1高可能是短期爆款，需看动量和季节性。',
            'action_hint': 'Top1高时先验证同价带第二梯队产品是否具备承接能力。',
        },
        {
            'key': 'last12_vs_prev12_growth',
            'name': '市场增长层级',
            'formula_text': '最近12个月总销量 vs 之前12个月总销量',
            'thresholds': growth.get('tier_thresholds', []),
            'interpretation_template': (
                f"当前同比窗增长 {growth.get('last12_vs_prev12_growth', 0.0):.2%}，"
                f"CAGR-like {growth.get('cagr_like_growth', 0.0):.2%}，归类为 {growth.get('growth_tier', 'stable')}。"
            ),
            'pitfall': '短期爆发可能来自一次性事件，需排除大促、断货恢复和平台流量异常。',
            'action_hint': '增长层级越高，越适合优先验证差异化切入与补货能力。',
        },
        {
            'key': 'seasonality_level',
            'name': '季节性层级',
            'formula_text': 'Peak3 月销量占比 + 月销量变异系数(CV) 综合判断',
            'thresholds': seasonality.get('tier_thresholds', []),
            'interpretation_template': (
                f"当前 Peak3 占比 {seasonality.get('peak3_month_sales_share', 0.0):.2%}，"
                f"CV {seasonality.get('monthly_sales_cv', 0.0):.2f}，归类为 {seasonality.get('seasonality_tier', 'balanced')}。"
            ),
            'pitfall': '季节性强并不一定差，但会抬高入场时机和库存周转要求。',
            'action_hint': '强季节性类目需要把入场月份、首单节奏和补货周期前置验证。',
        },
        {
            'key': 'new_product_sales_share',
            'name': '新品机会层级',
            'formula_text': '新品数量占比 + 新品销量占比综合信号',
            'thresholds': new_product.get('level_thresholds', []),
            'interpretation_template': (
                f"当前新品数量占比 {new_product.get('new_product_share', 0.0):.2%}，"
                f"新品销量占比 {new_product.get('new_product_sales_share', 0.0):.2%}，"
                f"归类为 {new_product.get('opportunity_level', 'low')}。"
            ),
            'pitfall': '新品占比高也可能意味着市场动荡，需结合评论门槛和头部垄断判断。',
            'action_hint': '新品机会高时，优先验证新品是否能在主价格带快速承接销量。',
        },
        {
            'key': 'supply_complexity_score',
            'name': '供给复杂度',
            'formula_text': '0.4×履约混合度 + 0.4×FBA费用压力 + 0.2×价格离散度',
            'thresholds': supply.get('level_thresholds', []),
            'interpretation_template': f"当前分数 {supply.get('score', 0.0):.2f}，归类为 {supply.get('complexity_level', 'low')}。",
            'pitfall': '它是运营复杂度代理指标，不直接等于进入难度，需要结合品牌和卖家结构一起看。',
            'action_hint': '复杂度高时，优先确认物流、费用模型和可复制的履约策略。',
        },
        {
            'key': 'data_quality_score',
            'name': '数据质量',
            'formula_text': '0.3×完整性 + 0.3×有效性 + 0.2×一致性 + 0.2×覆盖度',
            'thresholds': ['优秀 >= 92', '良好 82-92', '一般 68-82', '较差 < 68'],
            'interpretation_template': (
                f"当前总分 {quality.get('score', 0.0):.2f}，完整性 {quality.get('completeness_score', 0.0):.2f}，"
                f"有效性 {quality.get('validity_score', 0.0):.2f}，一致性 {quality.get('consistency_score', 0.0):.2f}。"
            ),
            'pitfall': '高分不代表可直接决策，只代表当前样本内部更完整、更干净。',
            'action_hint': '若质量不达标，应先清洗缺失/异常字段再判断机会与风险。',
        },
        {
            'key': 'china_seller_sales_share',
            'name': '中国卖家竞争强度',
            'formula_text': '中国卖家月销量 / 全部月销量',
            'thresholds': ['低 < 50%', '中 50%-70%', '高 >= 70%'],
            'interpretation_template': f"当前值 {china.get('china_seller_sales_share', 0.0):.2%}，基于 seller_country_region 优先识别。",
            'pitfall': '如果卖家国家缺失较多，会低估国别竞争强度。',
            'action_hint': '中国卖家占比高时，优先评估供应链效率、价格战强度和差异化空间。',
        },
    ]


def build_action_recommendations(advanced_metrics: dict[str, Any]) -> list[dict[str, Any]]:
    """Build action recommendation cards."""
    brand = advanced_metrics['brand_monopoly']
    seller = advanced_metrics['seller_monopoly']
    product = advanced_metrics['product_monopoly']
    growth = advanced_metrics['market_growth']
    seasonality = advanced_metrics['seasonality']
    quality = advanced_metrics['data_quality']
    new_product = advanced_metrics['new_product_opportunity']

    actions: list[dict[str, Any]] = [
        {
            'priority': 'high' if brand.get('risk_level') == 'high' or seller.get('risk_level') == 'high' else 'medium',
            'action': '优先锁定中尾部价格带做差异化切入',
            'why': '头部品牌/卖家集中度偏高，直接同质竞争成本高。',
            'required_validation': ['目标价格带毛利率', '头部品牌评价壁垒', '广告竞价成本'],
            'linked_dimension': 'structure',
            'rule_basis': [
                f"品牌风险={brand.get('risk_level', 'low')}",
                f"卖家风险={seller.get('risk_level', 'low')}",
                f"品牌CR3={brand.get('brand_cr3', 0.0):.2%}",
                f"卖家CR3={seller.get('seller_cr3', 0.0):.2%}",
            ],
        },
        {
            'priority': 'high' if growth.get('growth_level') == 'growing' and seasonality.get('seasonality_level') != 'strong' else 'medium',
            'action': '按推荐入场月提前铺货并验证转化',
            'why': '增长和季节性窗口决定入场时点与库存节奏。',
            'required_validation': ['近12月增长持续性', '季节峰值月份稳定性', '补货周期可行性'],
            'linked_dimension': 'opportunity',
            'rule_basis': [
                f"增长层级={growth.get('growth_tier', growth.get('growth_level', 'stable'))}",
                f"季节性层级={seasonality.get('seasonality_tier', seasonality.get('seasonality_level', 'weak'))}",
                f"建议入场月={','.join(seasonality.get('recommended_entry_months', []) or '无')}",
            ],
        },
        {
            'priority': 'high' if quality.get('score', 0.0) < 90 else 'medium',
            'action': '先完成高影响数据校验再确定候选池',
            'why': '数据质量不足会直接放大错误决策风险。',
            'required_validation': ['缺失趋势ASIN补全', '异常价格/FBA清洗', '重复ASIN去重规则'],
            'linked_dimension': 'execution',
            'rule_basis': [
                f"数据质量={quality.get('score', 0.0):.1f}",
                f"完整性={quality.get('completeness_score', 0.0):.1f}",
                f"有效性={quality.get('validity_score', 0.0):.1f}",
                f"一致性={quality.get('consistency_score', 0.0):.1f}",
            ],
        },
    ]

    if product.get('risk_level') == 'high' and new_product.get('new_product_sales_share', 0.0) < 0.1:
        actions.append(
            {
                'priority': 'high',
                'action': '将该类目标记为暂缓进入，保留跟踪',
                'why': '单品垄断明显且新品承接不足，短期进入胜率低。',
                'required_validation': ['是否存在政策或平台扰动', '头部断货/侵权风险', '可替代细分场景'],
                'linked_dimension': 'execution',
                'rule_basis': [
                    f"单品风险={product.get('risk_level', 'low')}",
                    f"Top1份额={product.get('asin_top1_share', 0.0):.2%}",
                    f"新品销量占比={new_product.get('new_product_sales_share', 0.0):.2%}",
                ],
            }
        )

    return actions


def build_signals(advanced_metrics: dict[str, Any]) -> list[dict[str, Any]]:
    """Build signal cards for various metrics."""
    brand = advanced_metrics['brand_monopoly']
    seller = advanced_metrics['seller_monopoly']
    product = advanced_metrics['product_monopoly']
    china = advanced_metrics['china_seller_competition']
    growth = advanced_metrics['market_growth']
    seasonality = advanced_metrics['seasonality']
    quality = advanced_metrics['data_quality']

    growth_level = growth.get('growth_level', 'stable')
    growth_signal = 'positive' if growth_level == 'growing' else 'negative' if growth_level == 'shrinking' else 'neutral'
    seasonality_level = seasonality.get('seasonality_level', 'weak')
    seasonality_signal_level = 'high' if seasonality_level == 'strong' else 'medium' if seasonality_level == 'moderate' else 'low'
    quality_score = float(quality.get('score', 0.0))

    return [
        {'key': 'brand_monopoly', 'label': '品牌垄断风险', 'level': brand.get('risk_level', 'low'), 'direction': 'negative', 'linked_dimension': 'structure'},
        {'key': 'seller_monopoly', 'label': '卖家垄断风险', 'level': seller.get('risk_level', 'low'), 'direction': 'negative', 'linked_dimension': 'structure'},
        {'key': 'product_monopoly', 'label': '产品垄断风险', 'level': product.get('risk_level', 'low'), 'direction': 'negative', 'linked_dimension': 'structure'},
        {'key': 'china_seller_competition', 'label': '中国卖家拥挤', 'level': china.get('risk_level', 'low'), 'direction': 'negative', 'linked_dimension': 'structure'},
        {'key': 'market_growth', 'label': '市场增长信号', 'level': 'high' if growth_level == 'growing' else 'medium' if growth_level == 'stable' else 'high', 'direction': growth_signal, 'linked_dimension': 'opportunity'},
        {'key': 'seasonality', 'label': '季节性波动', 'level': seasonality_signal_level, 'direction': 'negative' if seasonality_level == 'strong' else 'neutral', 'linked_dimension': 'opportunity'},
        {'key': 'data_quality', 'label': '数据可信度', 'level': 'high' if quality_score < 80 else 'medium' if quality_score < 92 else 'low', 'direction': 'negative' if quality_score < 92 else 'positive', 'linked_dimension': 'execution'},
    ]