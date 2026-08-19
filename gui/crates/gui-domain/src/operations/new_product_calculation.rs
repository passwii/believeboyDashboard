//! 报表中心 → 新品核算领域类型（P5-4，BLF-728）
//!
//! 字段 1:1 对齐 backend `backend/app/schemas/pricing_calculation.py`：
//! - 4 种测算请求模型（`PricingCalculationCreateRequest` /
//!   `PricingCalculationReverseRequest` / `PricingCalculationCostReverseRequest` /
//!   `PricingCalculationFbmRequest`；`EURequest` 为店铺测算专用，GUI 新品核算
//!   不接——对齐 frontend `new-product-client.tsx` 只调 quote / reverse-quote /
//!   reverse-cost / fbm-quote 四端点的口径）；
//! - 统一响应模型 `PricingCalculationRunItem`（含 dimensions / weights / fees /
//!   profit 四个嵌套块 + warnings）与分页包装 `PricingCalculationRunListResponse`。
//!
//! frontend 蓝本：`frontend/app/dashboard/reports/pricing-calculation/new-product/
//! new-product-client.tsx` 的 `PricingCalculationRunItem` / `ListResponse` /
//! `requestPricingCalculation` 请求体。
//!
//! 序列化约定：
//! - 可选字段 `skip_serializing_if = Option::is_none`（对齐 web 端条件扩展语法
//!   `...(payload.x ? { x } : {})` 的按需携带）；
//! - backend 响应侧带默认值的字段（`platform_fee_usd` / `vat_usd` /
//!   `delivery_fee_usd` / `full_container_*`）反序列化同样容忍缺省
//!   （`#[serde(default)]`），防存量记录缺字段时解析失败。

use serde::{Deserialize, Serialize};

/// 核算类型（backend `CalculationType`：5 种；`EuAccounting` 为欧洲店铺核算，
/// 新品核算视图不会产生，但响应解析必须容忍——历史 runs 可能含该类型；
/// `Default = ProfitCalc` 对齐 backend schema 的字段默认值，`#[serde(default)]`
/// 解析缺省用）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CalculationType {
    /// 利润核算（输入售价 → 算利润）
    #[default]
    ProfitCalc,
    /// 利润倒算（输入目标利润率 → 倒算建议售价）
    ProfitReverse,
    /// 成本倒推（输入售价 + 目标利润率 → 倒推最高可承受成本）
    CostReverse,
    /// FBM 测算（整柜头程 + 配送费口径）
    FbmCalc,
    /// 欧洲店铺核算（店铺测算域；新品视图仅解析展示，不发起）
    EuAccounting,
}

impl CalculationType {
    /// 中文标签（对齐 web `getCalculationTypeMeta` 的 label 列）
    pub fn label(&self) -> &'static str {
        match self {
            Self::ProfitCalc => "利润核算",
            Self::ProfitReverse => "利润倒算",
            Self::CostReverse => "成本倒推",
            Self::FbmCalc => "FBM测算",
            Self::EuAccounting => "欧洲核算",
        }
    }
}

/// 入库配置模式（backend `InboundPlacementMode`）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum InboundPlacementMode {
    /// 单点入仓（默认；对齐 web `INITIAL_FORM.inbound_placement_mode`）
    #[default]
    SingleDestination,
    /// 亚马逊优化分仓
    AmazonOptimizedSplit,
}

impl InboundPlacementMode {
    /// 中文标签（GUI 表单选择器用；web 端该字段不暴露 UI，GUI 显式化）
    pub fn label(&self) -> &'static str {
        match self {
            Self::SingleDestination => "单点入仓",
            Self::AmazonOptimizedSplit => "亚马逊优化分仓",
        }
    }
}

/// 包装尺寸派生量（backend `PricingCalculationDimensions` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PricingDimensions {
    pub longest_side_in: f64,
    pub middle_side_in: f64,
    pub shortest_side_in: f64,
    pub length_plus_girth_in: f64,
    pub volume_cubic_in: f64,
    pub volume_cubic_ft: f64,
}

/// 重量派生量（backend `PricingCalculationWeight` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PricingWeights {
    pub product_weight_lb: f64,
    pub product_weight_oz: f64,
    pub dimensional_weight_lb: f64,
    pub chargeable_weight_lb: f64,
    pub chargeable_weight_oz: f64,
    pub chargeable_weight_rule: String,
}

/// 费用明细（backend `PricingCalculationFees` 1:1；`platform_fee_usd` 后端
/// 默认 0，反序列化容忍缺省）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PricingFees {
    pub referral_fee_usd: f64,
    pub advertising_fee_usd: f64,
    pub return_loss_usd: f64,
    pub fba_fulfillment_fee_usd: f64,
    pub inbound_config_fee_usd: f64,
    pub storage_fee_usd: f64,
    pub total_fee_usd: f64,
    #[serde(default)]
    pub platform_fee_usd: f64,
}

/// 利润结果（backend `PricingCalculationProfit` 1:1；VAT / FBM 扩展字段带默认）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PricingProfit {
    pub ddp_cost_rmb: f64,
    pub ddp_cost_usd: f64,
    pub payout_usd: f64,
    pub profit_usd: f64,
    pub profit_rate: f64,
    #[serde(default)]
    pub vat_usd: f64,
    #[serde(default)]
    pub profit_after_vat_usd: Option<f64>,
    #[serde(default)]
    pub profit_after_vat_rate: Option<f64>,
    #[serde(default)]
    pub delivery_fee_usd: f64,
    #[serde(default)]
    pub full_container_quantity: f64,
    #[serde(default)]
    pub full_container_price_rmb: f64,
}

/// 单次测算运行记录（backend `PricingCalculationRunItem` 1:1；
/// quote / reverse-quote / reverse-cost / fbm-quote 四端点的统一响应，
/// 也是 `GET /pricing-calculation/runs` 的列表项）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PricingRunItem {
    pub id: i64,
    #[serde(default = "default_country")]
    pub country: String,
    pub product_name: String,
    #[serde(default)]
    pub calculation_type: CalculationType,
    #[serde(default)]
    pub project_id: Option<i64>,
    #[serde(default)]
    pub sku: Option<String>,
    pub package_length_cm: f64,
    pub package_width_cm: f64,
    pub package_height_cm: f64,
    pub weight_kg: f64,
    pub fob_product_cost_rmb: f64,
    pub first_leg_cost_rmb: f64,
    #[serde(default)]
    pub first_leg_unit_price_rmb_per_kg: Option<f64>,
    pub sale_price_usd: f64,
    pub commission_rate: f64,
    pub advertising_rate: f64,
    pub return_loss_rate: f64,
    pub storage_months: f64,
    pub inbound_placement_mode: InboundPlacementMode,
    pub size_tier: String,
    pub size_tier_label: String,
    pub price_band: String,
    pub price_band_label: String,
    pub usd_to_rmb_rate: f64,
    pub usd_to_rmb_rate_source: String,
    pub fulfillment_fee_rule_label: String,
    pub inbound_config_fee_rule_label: String,
    pub storage_fee_rule_label: String,
    pub dimensions: PricingDimensions,
    pub weights: PricingWeights,
    pub fees: PricingFees,
    pub profit: PricingProfit,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default)]
    pub created_by: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub delivery_fee_usd: f64,
    #[serde(default)]
    pub full_container_quantity: f64,
    #[serde(default)]
    pub full_container_price_rmb: f64,
    #[serde(default)]
    pub competitor_url: Option<String>,
}

fn default_country() -> String {
    "US".to_string()
}

/// runs 分页响应（backend `PricingCalculationRunListResponse` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PricingRunListResponse {
    pub items: Vec<PricingRunItem>,
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
}

// ---------------------------------------------------------------------------
// 4 种测算请求（对齐 backend 4 个 Request 模型；web `requestPricingCalculation`
// 按模式拼装的请求体逐字段落位）
// ---------------------------------------------------------------------------

/// 利润核算请求（backend `PricingCalculationCreateRequest` →
/// `POST /pricing-calculation/quote`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PricingQuoteRequest {
    pub country: String,
    pub product_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub competitor_url: Option<String>,
    pub package_length_cm: f64,
    pub package_width_cm: f64,
    pub package_height_cm: f64,
    pub weight_kg: f64,
    pub fob_product_cost_rmb: f64,
    pub first_leg_cost_rmb: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_leg_unit_price_rmb: Option<f64>,
    pub sale_price_usd: f64,
    pub commission_rate: f64,
    pub advertising_rate: f64,
    pub return_loss_rate: f64,
    pub storage_months: f64,
    pub inbound_placement_mode: InboundPlacementMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usd_to_rmb_rate: Option<f64>,
}

/// 利润倒算请求（backend `PricingCalculationReverseRequest` →
/// `POST /pricing-calculation/reverse-quote`；无售价，带目标利润率）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PricingReverseQuoteRequest {
    pub country: String,
    pub product_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub competitor_url: Option<String>,
    pub package_length_cm: f64,
    pub package_width_cm: f64,
    pub package_height_cm: f64,
    pub weight_kg: f64,
    pub fob_product_cost_rmb: f64,
    pub first_leg_cost_rmb: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_leg_unit_price_rmb: Option<f64>,
    pub target_profit_rate: f64,
    pub commission_rate: f64,
    pub advertising_rate: f64,
    pub return_loss_rate: f64,
    pub storage_months: f64,
    pub inbound_placement_mode: InboundPlacementMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usd_to_rmb_rate: Option<f64>,
}

/// 成本倒推请求（backend `PricingCalculationCostReverseRequest` →
/// `POST /pricing-calculation/reverse-cost`；**无 FOB 成本字段**——成本为
/// 倒推目标，售价 + 目标利润率必填）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PricingCostReverseRequest {
    pub country: String,
    pub product_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub competitor_url: Option<String>,
    pub package_length_cm: f64,
    pub package_width_cm: f64,
    pub package_height_cm: f64,
    pub weight_kg: f64,
    pub first_leg_cost_rmb: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_leg_unit_price_rmb: Option<f64>,
    pub sale_price_usd: f64,
    pub target_profit_rate: f64,
    pub commission_rate: f64,
    pub advertising_rate: f64,
    pub return_loss_rate: f64,
    pub storage_months: f64,
    pub inbound_placement_mode: InboundPlacementMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usd_to_rmb_rate: Option<f64>,
}

/// FBM 测算请求（backend `PricingCalculationFbmRequest` →
/// `POST /pricing-calculation/fbm-quote`；头程 = 整柜价格 ÷ 整柜数量，
/// 由前端算好传入，后端不二次计算——对齐 backend schema 注释与 web
/// `handleSubmit` 的 `fbmFirstLegCost` 口径）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PricingFbmQuoteRequest {
    pub country: String,
    pub product_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub competitor_url: Option<String>,
    pub package_length_cm: f64,
    pub package_width_cm: f64,
    pub package_height_cm: f64,
    pub weight_kg: f64,
    pub fob_product_cost_rmb: f64,
    pub first_leg_cost_rmb: f64,
    pub full_container_quantity: f64,
    pub full_container_price_rmb: f64,
    pub delivery_fee_usd: f64,
    pub sale_price_usd: f64,
    pub commission_rate: f64,
    pub advertising_rate: f64,
    pub return_loss_rate: f64,
    pub storage_months: f64,
    pub inbound_placement_mode: InboundPlacementMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usd_to_rmb_rate: Option<f64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 响应解析：完整 run 记录（含四嵌套块 + warnings + FBM 扩展字段）
    #[test]
    fn run_item_parses_full_payload() {
        let json = r#"{
            "id": 12,
            "country": "US",
            "product_name": "桌面置物架",
            "calculation_type": "fbm_calc",
            "project_id": null,
            "sku": null,
            "package_length_cm": 30.0,
            "package_width_cm": 20.0,
            "package_height_cm": 10.0,
            "weight_kg": 1.2,
            "fob_product_cost_rmb": 45.0,
            "first_leg_cost_rmb": 8.5,
            "first_leg_unit_price_rmb_per_kg": null,
            "sale_price_usd": 29.99,
            "commission_rate": 0.15,
            "advertising_rate": 0.12,
            "return_loss_rate": 0.04,
            "storage_months": 1.0,
            "inbound_placement_mode": "single_destination",
            "size_tier": "standard",
            "size_tier_label": "标准尺寸",
            "price_band": "20_50",
            "price_band_label": "$20-$50",
            "usd_to_rmb_rate": 7.15,
            "usd_to_rmb_rate_source": "system",
            "fulfillment_fee_rule_label": "FBA 标准",
            "inbound_config_fee_rule_label": "入库配置",
            "storage_fee_rule_label": "仓储规则",
            "dimensions": {
                "longest_side_in": 11.81,
                "middle_side_in": 7.87,
                "shortest_side_in": 3.94,
                "length_plus_girth_in": 35.43,
                "volume_cubic_in": 366.14,
                "volume_cubic_ft": 0.21
            },
            "weights": {
                "product_weight_lb": 2.65,
                "product_weight_oz": 42.33,
                "dimensional_weight_lb": 1.27,
                "chargeable_weight_lb": 2.65,
                "chargeable_weight_oz": 42.33,
                "chargeable_weight_rule": "取大"
            },
            "fees": {
                "referral_fee_usd": 4.5,
                "advertising_fee_usd": 3.6,
                "return_loss_usd": 1.2,
                "fba_fulfillment_fee_usd": 5.4,
                "inbound_config_fee_usd": 0.3,
                "storage_fee_usd": 0.1,
                "total_fee_usd": 15.1,
                "platform_fee_usd": 0.0
            },
            "profit": {
                "ddp_cost_rmb": 106.3,
                "ddp_cost_usd": 14.87,
                "payout_usd": 25.49,
                "profit_usd": 10.62,
                "profit_rate": 0.354,
                "delivery_fee_usd": 3.2,
                "full_container_quantity": 1000.0,
                "full_container_price_rmb": 8500.0
            },
            "warnings": ["售价低于建议区间"],
            "created_by": "测试",
            "created_at": "2026-08-18T10:00:00Z",
            "updated_at": "2026-08-18T10:00:00Z",
            "delivery_fee_usd": 3.2,
            "full_container_quantity": 1000.0,
            "full_container_price_rmb": 8500.0,
            "competitor_url": "https://www.amazon.com/dp/B0TEST"
        }"#;
        let item: PricingRunItem = serde_json::from_str(json).expect("解析失败");
        assert_eq!(item.id, 12);
        assert_eq!(item.calculation_type, CalculationType::FbmCalc);
        assert_eq!(item.calculation_type.label(), "FBM测算");
        assert_eq!(item.inbound_placement_mode, InboundPlacementMode::SingleDestination);
        assert_eq!(item.fees.total_fee_usd, 15.1);
        assert_eq!(item.profit.profit_usd, 10.62);
        assert_eq!(item.dimensions.volume_cubic_ft, 0.21);
        assert_eq!(item.weights.chargeable_weight_rule, "取大");
        assert_eq!(item.warnings, vec!["售价低于建议区间".to_string()]);
        assert_eq!(item.competitor_url.as_deref(), Some("https://www.amazon.com/dp/B0TEST"));
    }

    /// 响应解析容忍缺省：`platform_fee_usd` / `vat_usd` / FBM 扩展字段缺失的
    /// 存量记录（backend 有默认值，GUI 反序列化同口径）
    #[test]
    fn run_item_tolerates_missing_defaulted_fields() {
        let json = r#"{
            "id": 1,
            "product_name": "老记录",
            "package_length_cm": 10.0,
            "package_width_cm": 10.0,
            "package_height_cm": 10.0,
            "weight_kg": 1.0,
            "fob_product_cost_rmb": 20.0,
            "first_leg_cost_rmb": 5.0,
            "sale_price_usd": 19.99,
            "commission_rate": 0.15,
            "advertising_rate": 0.12,
            "return_loss_rate": 0.04,
            "storage_months": 1.0,
            "inbound_placement_mode": "amazon_optimized_split",
            "size_tier": "standard",
            "size_tier_label": "标准尺寸",
            "price_band": "10_20",
            "price_band_label": "$10-$20",
            "usd_to_rmb_rate": 7.1,
            "usd_to_rmb_rate_source": "system",
            "fulfillment_fee_rule_label": "r1",
            "inbound_config_fee_rule_label": "r2",
            "storage_fee_rule_label": "r3",
            "dimensions": {
                "longest_side_in": 3.94, "middle_side_in": 3.94,
                "shortest_side_in": 3.94, "length_plus_girth_in": 19.7,
                "volume_cubic_in": 61.0, "volume_cubic_ft": 0.04
            },
            "weights": {
                "product_weight_lb": 2.2, "product_weight_oz": 35.2,
                "dimensional_weight_lb": 0.2, "chargeable_weight_lb": 2.2,
                "chargeable_weight_oz": 35.2, "chargeable_weight_rule": "取大"
            },
            "fees": {
                "referral_fee_usd": 3.0, "advertising_fee_usd": 2.4,
                "return_loss_usd": 0.8, "fba_fulfillment_fee_usd": 4.0,
                "inbound_config_fee_usd": 0.2, "storage_fee_usd": 0.1,
                "total_fee_usd": 10.5
            },
            "profit": {
                "ddp_cost_rmb": 60.0, "ddp_cost_usd": 8.45,
                "payout_usd": 16.99, "profit_usd": 8.54, "profit_rate": 0.427
            },
            "created_at": "2026-08-01T00:00:00Z",
            "updated_at": "2026-08-01T00:00:00Z"
        }"#;
        let item: PricingRunItem = serde_json::from_str(json).expect("解析失败");
        assert_eq!(item.country, "US", "country 缺省回退 US");
        assert_eq!(item.calculation_type, CalculationType::ProfitCalc);
        assert_eq!(item.inbound_placement_mode, InboundPlacementMode::AmazonOptimizedSplit);
        assert_eq!(item.fees.platform_fee_usd, 0.0);
        assert_eq!(item.profit.vat_usd, 0.0);
        assert!(item.warnings.is_empty());
        assert!(item.created_by.is_none());
        assert_eq!(item.delivery_fee_usd, 0.0);
    }

    /// 序列化：可选字段 None 时不出现在请求体（对齐 web 条件扩展口径）
    #[test]
    fn quote_request_skips_none_fields() {
        let req = PricingQuoteRequest {
            country: "US".into(),
            product_name: "桌面置物架".into(),
            competitor_url: None,
            package_length_cm: 30.0,
            package_width_cm: 20.0,
            package_height_cm: 10.0,
            weight_kg: 1.2,
            fob_product_cost_rmb: 45.0,
            first_leg_cost_rmb: 8.5,
            first_leg_unit_price_rmb: Some(5.0),
            sale_price_usd: 29.99,
            commission_rate: 0.15,
            advertising_rate: 0.12,
            return_loss_rate: 0.04,
            storage_months: 1.0,
            inbound_placement_mode: InboundPlacementMode::SingleDestination,
            usd_to_rmb_rate: None,
        };
        let value = serde_json::to_value(&req).expect("序列化失败");
        assert!(value.get("competitor_url").is_none());
        assert!(value.get("usd_to_rmb_rate").is_none());
        assert_eq!(value["first_leg_unit_price_rmb"], 5.0);
        assert_eq!(value["inbound_placement_mode"], "single_destination");
    }

    /// 成本倒推请求不含 FOB 字段（成本为倒推目标；backend
    /// `PricingCalculationCostReverseRequest` 无该字段）
    #[test]
    fn cost_reverse_request_has_no_fob_field() {
        let req = PricingCostReverseRequest {
            country: "US".into(),
            product_name: "测试".into(),
            competitor_url: None,
            package_length_cm: 10.0,
            package_width_cm: 10.0,
            package_height_cm: 10.0,
            weight_kg: 1.0,
            first_leg_cost_rmb: 5.0,
            first_leg_unit_price_rmb: None,
            sale_price_usd: 19.99,
            target_profit_rate: 0.25,
            commission_rate: 0.15,
            advertising_rate: 0.12,
            return_loss_rate: 0.04,
            storage_months: 1.0,
            inbound_placement_mode: InboundPlacementMode::default(),
            usd_to_rmb_rate: None,
        };
        let value = serde_json::to_value(&req).expect("序列化失败");
        assert!(value.get("fob_product_cost_rmb").is_none());
        assert_eq!(value["target_profit_rate"], 0.25);
        assert_eq!(value["sale_price_usd"], 19.99);
    }

    /// CalculationType 全变体标签 + serde 往返
    #[test]
    fn calculation_type_labels_and_serde_roundtrip() {
        for (ty, slug, label) in [
            (CalculationType::ProfitCalc, "profit_calc", "利润核算"),
            (CalculationType::ProfitReverse, "profit_reverse", "利润倒算"),
            (CalculationType::CostReverse, "cost_reverse", "成本倒推"),
            (CalculationType::FbmCalc, "fbm_calc", "FBM测算"),
            (CalculationType::EuAccounting, "eu_accounting", "欧洲核算"),
        ] {
            assert_eq!(ty.label(), label);
            let json = serde_json::to_string(&ty).expect("序列化失败");
            assert_eq!(json, format!("\"{slug}\""));
            let back: CalculationType = serde_json::from_str(&json).expect("反序列化失败");
            assert_eq!(back, ty);
        }
    }
}
