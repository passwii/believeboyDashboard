"""周巡检表单模板常量（BLF-944 提取共享）。

单一事实源 = 周巡检表单字段（迁移自 ``app/api/v1/endpoints/inspections.py``）。
内部端点 ``GET /inspections/template`` 与 agent 端点
``GET /agent/platform-inspection/template``（R0）同源引用，杜绝两处漂移
（BEL-93：内部端点改 import、行为不变，regression 锁）。
"""

from __future__ import annotations

from app.schemas.inspection import InspectionTemplateField

HEALTH_FIELDS = [
    InspectionTemplateField(
        key="account_health_rating", label="账户健康评级", label_en="Account Health Rating",
        type="select", options=["Healthy", "Good", "At Risk", "Critical"],
    ),
]

SERVICE_PERFORMANCE_FIELDS = [
    InspectionTemplateField(
        key="negative_feedback", label="负面反馈", label_en="Negative Feedback",
        type="number", threshold_warning=1, threshold_critical=3, threshold_direction="above",
    ),
    InspectionTemplateField(
        key="a2z_claims", label="亚马逊 A-to-Z", label_en="A-to-Z Claims",
        type="number", threshold_warning=1, threshold_critical=3, threshold_direction="above",
    ),
    InspectionTemplateField(
        key="chargeback_claims", label="信用卡拒付", label_en="Chargeback Claims",
        type="number", threshold_warning=1, threshold_critical=3, threshold_direction="above",
    ),
]

SHIPPING_PERFORMANCE_FIELDS = [
    InspectionTemplateField(
        key="late_shipment_rate", label="迟发率", label_en="Late Shipment Rate",
        type="number", unit="%", threshold_warning=2.0, threshold_critical=4.0, threshold_direction="above",
    ),
    InspectionTemplateField(
        key="pre_fulfillment_cancel_rate", label="配送前取消率", label_en="Pre-fulfillment Cancel Rate",
        type="number", unit="%",
    ),
    InspectionTemplateField(
        key="valid_tracking_rate", label="有效追踪率", label_en="Valid Tracking Rate",
        type="number", unit="%", threshold_warning=97.0, threshold_critical=95.0, threshold_direction="below",
    ),
    InspectionTemplateField(
        key="on_time_delivery_rate", label="准时交付率", label_en="On-time Delivery Rate",
        type="number", unit="%", threshold_warning=97.0, threshold_critical=95.0, threshold_direction="below",
    ),
]

COMPLIANCE_FIELDS = [
    InspectionTemplateField(
        key="ip_infringement", label="涉嫌侵犯知识产权", label_en="Suspected IP Infringement",
        type="number", threshold_warning=1, threshold_critical=3, threshold_direction="above",
    ),
    InspectionTemplateField(
        key="ip_complaints", label="知识产权投诉", label_en="IP Complaints",
        type="number", threshold_warning=1, threshold_critical=3, threshold_direction="above",
    ),
    InspectionTemplateField(
        key="product_authenticity_complaints", label="商品真实性买家投诉", label_en="Product Authenticity Complaints",
        type="number", threshold_warning=1, threshold_critical=3, threshold_direction="above",
    ),
    InspectionTemplateField(
        key="product_condition_complaints", label="商品状况买家投诉", label_en="Product Condition Complaints",
        type="number", threshold_warning=1, threshold_critical=3, threshold_direction="above",
    ),
    InspectionTemplateField(
        key="food_product_safety", label="食品和商品安全问题", label_en="Food & Product Safety",
        type="number", threshold_warning=1, threshold_critical=3, threshold_direction="above",
    ),
    InspectionTemplateField(
        key="listing_policy_violations", label="上架政策违规", label_en="Listing Policy Violations",
        type="number", threshold_warning=1, threshold_critical=3, threshold_direction="above",
    ),
    InspectionTemplateField(
        key="restricted_product_violations", label="违反受限商品政策", label_en="Restricted Product Violations",
        type="number", threshold_warning=1, threshold_critical=3, threshold_direction="above",
    ),
    InspectionTemplateField(
        key="review_policy_violations", label="违反买家商品评论政策", label_en="Review Policy Violations",
        type="number", threshold_warning=1, threshold_critical=3, threshold_direction="above",
    ),
    InspectionTemplateField(
        key="other_policy_violations", label="其他违反政策", label_en="Other Policy Violations",
        type="number", threshold_warning=1, threshold_critical=3, threshold_direction="above",
    ),
    InspectionTemplateField(
        key="regulatory_compliance", label="监管合规性", label_en="Regulatory Compliance",
        type="number", threshold_warning=1, threshold_critical=3, threshold_direction="above",
    ),
]