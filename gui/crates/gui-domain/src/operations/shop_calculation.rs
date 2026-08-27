//! 报表中心 → 店铺测算领域类型（P5-4，BLF-729）
//!
//! 字段 1:1 对齐 backend：
//! - `backend/app/schemas/shop_calculation.py`（`ShopCalculationItem` /
//!   `ShopCalculationCreateRequest` / `ShopCalculationListResponse`；嵌套
//!   fees / profit 块含 EU 手动费用与 VAT 扩展字段）；
//! - `backend/app/schemas/sku_info.py`（`SkuRecordItem` / `SkuRecordsPage`
//!   —— SKU 档案分页；web 蓝本 `ProductCostItem` 同源）；
//! - `backend/app/schemas/pricing_calculation.py::PricingCalculationEURequest`
//!   （`POST /pricing-calculation/eu-quote` 请求体；响应复用新品核算域的
//!   [`PricingRunItem`]——backend eu-quote 与 quote 共用
//!   `PricingCalculationRunItem` 响应模型）。
//!
//! frontend 蓝本：`frontend/app/dashboard/reports/pricing-calculation/
//! shop-calculation/shop-calculation-client.tsx` +
//! `lib/pricing-calculation-types.ts`。
//!
//! 序列化约定：请求侧可选字段 `skip_serializing_if`（对齐 web 条件展开）；
//! 响应侧带默认值字段（EU 手动费用 / VAT / 平台佣金）`#[serde(default)]`
//! 容忍缺省。

use serde::{Deserialize, Serialize};

use super::new_product_calculation::{
    InboundPlacementMode, PricingDimensions, PricingRunItem, PricingWeights,
};

// ---------------------------------------------------------------------------
// SKU 档案（backend sku_info.py；web ProductCostItem 同源）
// ---------------------------------------------------------------------------

/// 单条 SKU 档案（backend `SkuRecordItem`；GUI 只取店铺测算消费的字段，
/// 其余 R2 图片 / 工厂信息等字段不接——对齐 web `ProductCostItem` 口径）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkuRecordItem {
    pub id: i64,
    pub project_name: String,
    pub sku: String,
    #[serde(default)]
    pub asin: String,
    #[serde(default)]
    pub fob_unit_cost: f64,
    #[serde(default)]
    pub first_leg_cost_rmb: f64,
    #[serde(default)]
    pub package_length_cm: f64,
    #[serde(default)]
    pub package_width_cm: f64,
    #[serde(default)]
    pub package_height_cm: f64,
    #[serde(default)]
    pub weight_kg: f64,
    #[serde(default)]
    pub currency: String,
    #[serde(default)]
    pub country: String,
    #[serde(default)]
    pub sort_order: i64,
    /// 每箱装量（backend `units_per_carton`；BLF-798 SKU 信息网格列）
    #[serde(default)]
    pub units_per_carton: i64,
    #[serde(default = "default_true")]
    pub is_active: bool,
}

fn default_true() -> bool {
    true
}

/// SKU 档案分页响应（backend `SkuRecordsPage` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkuRecordsPage {
    pub items: Vec<SkuRecordItem>,
    pub page: i64,
    pub page_size: i64,
    #[serde(default)]
    pub total: Option<i64>,
    #[serde(default)]
    pub has_next: bool,
}

// ---------------------------------------------------------------------------
// 店铺测算当前态（backend shop_calculation.py）
// ---------------------------------------------------------------------------

/// 费用明细（backend `ShopCalculationFees` 1:1；EU 手动费用 / 平台佣金
/// 带默认值，反序列化容忍缺省）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShopFees {
    pub referral_fee_usd: f64,
    pub advertising_fee_usd: f64,
    pub return_loss_usd: f64,
    pub fba_fulfillment_fee_usd: f64,
    pub inbound_config_fee_usd: f64,
    pub storage_fee_usd: f64,
    pub total_fee_usd: f64,
    /// EU 手动派送费
    #[serde(default)]
    pub delivery_fee_usd: f64,
    /// EU 手动配置费
    #[serde(default)]
    pub inbound_config_fee_manual_usd: f64,
    /// EU 手动仓储费
    #[serde(default)]
    pub storage_fee_manual_usd: f64,
    /// EU 平台佣金（售价 × 15%）
    #[serde(default)]
    pub platform_fee_usd: f64,
}

/// 利润结果（backend `ShopCalculationProfit` 1:1；VAT 扩展带默认）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShopProfit {
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
}

impl ShopProfit {
    /// 展示口径利润（对齐 web 盈利统计：EU 取扣税后利润，缺失回退税前）
    pub fn display_profit_usd(&self, country: &str) -> f64 {
        if country == "US" {
            self.profit_usd
        } else {
            self.profit_after_vat_usd.unwrap_or(self.profit_usd)
        }
    }
}

/// 单条店铺测算记录（backend `ShopCalculationItem` 1:1；
/// append-only 时间序列的「每 SKU 最新有效行」，BEL-378）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShopCalculationItem {
    pub id: i64,
    pub project_id: i64,
    pub project_name: String,
    pub sku: String,
    #[serde(default)]
    pub asin: Option<String>,
    #[serde(default = "default_country")]
    pub country: String,
    #[serde(default = "default_accounting_type")]
    pub accounting_type: String,

    // 尺寸信息
    pub package_length_cm: f64,
    pub package_width_cm: f64,
    pub package_height_cm: f64,
    pub weight_kg: f64,

    // 成本信息
    pub fob_product_cost_rmb: f64,
    pub first_leg_cost_rmb: f64,
    pub ddp_cost_rmb: f64,
    pub ddp_cost_usd: f64,

    // 销售参数
    pub sale_price_usd: f64,
    pub advertising_rate: f64,
    pub return_loss_rate: f64,
    pub storage_months: f64,
    pub inbound_placement_mode: InboundPlacementMode,

    // 汇率
    pub usd_to_rmb_rate: f64,
    pub usd_to_rmb_rate_source: String,

    // 尺寸等级和售价带
    pub size_tier: String,
    pub size_tier_label: String,
    pub price_band: String,
    pub price_band_label: String,

    // 费用规则标签
    pub fulfillment_fee_rule_label: String,
    pub inbound_config_fee_rule_label: String,
    pub storage_fee_rule_label: String,

    // 嵌套明细
    pub dimensions: PricingDimensions,
    pub weights: PricingWeights,
    pub fees: ShopFees,
    pub profit: ShopProfit,

    // 警告 / 备注 / 操作人
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub created_by: Option<String>,
    pub observed_at: String,
    #[serde(default = "default_source")]
    pub source: String,
    pub created_at: String,
    pub updated_at: String,
}

fn default_country() -> String {
    "US".to_string()
}

fn default_accounting_type() -> String {
    "profit_calc".to_string()
}

fn default_source() -> String {
    "manual".to_string()
}

/// 店铺测算列表响应（backend `ShopCalculationListResponse` 1:1）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShopCalculationListResponse {
    pub items: Vec<ShopCalculationItem>,
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
}

// ---------------------------------------------------------------------------
// 保存请求（backend `ShopCalculationCreateRequest` 1:1；web
// buildSnapshotPayload / EU requestSaveSnapshot 的逐字段落位）
// ---------------------------------------------------------------------------

/// 创建店铺测算记录请求（append-only；尺寸 / 重量详情由响应 run 展开，
/// EU 手动费用与 VAT 扩展按站点携带）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShopCalculationCreateRequest {
    pub project_id: i64,
    pub project_name: String,
    pub sku: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub country: Option<String>,
    pub accounting_type: String,

    // 尺寸信息
    pub package_length_cm: f64,
    pub package_width_cm: f64,
    pub package_height_cm: f64,
    pub weight_kg: f64,

    // 成本信息
    pub fob_product_cost_rmb: f64,
    pub first_leg_cost_rmb: f64,
    pub ddp_cost_rmb: f64,
    pub ddp_cost_usd: f64,

    // 销售参数
    pub sale_price_usd: f64,
    pub advertising_rate: f64,
    pub return_loss_rate: f64,
    pub storage_months: f64,
    pub inbound_placement_mode: InboundPlacementMode,

    // 汇率
    pub usd_to_rmb_rate: f64,
    pub usd_to_rmb_rate_source: String,

    // 尺寸等级和售价带
    pub size_tier: String,
    pub size_tier_label: String,
    pub price_band: String,
    pub price_band_label: String,

    // 费用规则标签
    pub fulfillment_fee_rule_label: String,
    pub inbound_config_fee_rule_label: String,
    pub storage_fee_rule_label: String,

    // 尺寸详情
    pub longest_side_in: f64,
    pub middle_side_in: f64,
    pub shortest_side_in: f64,
    pub length_plus_girth_in: f64,
    pub volume_cubic_in: f64,
    pub volume_cubic_ft: f64,

    // 重量详情
    pub product_weight_lb: f64,
    pub product_weight_oz: f64,
    pub dimensional_weight_lb: f64,
    pub chargeable_weight_lb: f64,
    pub chargeable_weight_oz: f64,
    pub chargeable_weight_rule: String,

    // 费用详情
    pub referral_fee_usd: f64,
    pub advertising_fee_usd: f64,
    pub return_loss_usd: f64,
    pub fba_fulfillment_fee_usd: f64,
    pub inbound_config_fee_usd: f64,
    pub storage_fee_usd: f64,
    pub total_fee_usd: f64,
    /// EU 手动费用（US 站传 0，对齐 web 默认值展开）
    #[serde(default)]
    pub delivery_fee_usd: f64,
    #[serde(default)]
    pub inbound_config_fee_manual_usd: f64,
    #[serde(default)]
    pub storage_fee_manual_usd: f64,
    #[serde(default)]
    pub platform_fee_usd: f64,

    // 利润详情
    pub payout_usd: f64,
    pub profit_usd: f64,
    pub profit_rate: f64,
    #[serde(default)]
    pub vat_usd: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profit_after_vat_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profit_after_vat_rate: Option<f64>,

    // 警告
    #[serde(default)]
    pub warnings: Vec<String>,
}

impl ShopCalculationCreateRequest {
    /// 从测算运行结果构建保存载荷（US `profit_calc` 分支，对齐 web
    /// `buildSnapshotPayload`；storage_months / 汇率来源取自请求上下文）。
    ///
    /// `delivery/inbound_manual/storage_manual` 为 EU 手动费用占位（US 全 0）；
    /// EU 分支见 [`Self::from_eu_run`]。
    #[allow(clippy::too_many_arguments)]
    pub fn from_us_run(
        run: &PricingRunItem,
        project_id: i64,
        project_name: &str,
        asin: Option<String>,
        country: &str,
        delivery_fee_usd: f64,
        inbound_config_fee_manual_usd: f64,
        storage_fee_manual_usd: f64,
    ) -> Self {
        Self {
            project_id,
            project_name: project_name.to_string(),
            sku: run.sku.clone().unwrap_or_default(),
            asin,
            country: Some(country.to_string()),
            accounting_type: "profit_calc".to_string(),
            package_length_cm: run.package_length_cm,
            package_width_cm: run.package_width_cm,
            package_height_cm: run.package_height_cm,
            weight_kg: run.weight_kg,
            fob_product_cost_rmb: run.fob_product_cost_rmb,
            first_leg_cost_rmb: run.first_leg_cost_rmb,
            ddp_cost_rmb: run.profit.ddp_cost_rmb,
            ddp_cost_usd: run.profit.ddp_cost_usd,
            sale_price_usd: run.sale_price_usd,
            advertising_rate: run.advertising_rate,
            return_loss_rate: run.return_loss_rate,
            storage_months: run.storage_months,
            inbound_placement_mode: run.inbound_placement_mode,
            usd_to_rmb_rate: run.usd_to_rmb_rate,
            usd_to_rmb_rate_source: run.usd_to_rmb_rate_source.clone(),
            size_tier: run.size_tier.clone(),
            size_tier_label: run.size_tier_label.clone(),
            price_band: run.price_band.clone(),
            price_band_label: run.price_band_label.clone(),
            longest_side_in: run.dimensions.longest_side_in,
            middle_side_in: run.dimensions.middle_side_in,
            shortest_side_in: run.dimensions.shortest_side_in,
            length_plus_girth_in: run.dimensions.length_plus_girth_in,
            volume_cubic_in: run.dimensions.volume_cubic_in,
            volume_cubic_ft: run.dimensions.volume_cubic_ft,
            product_weight_lb: run.weights.product_weight_lb,
            product_weight_oz: run.weights.product_weight_oz,
            dimensional_weight_lb: run.weights.dimensional_weight_lb,
            chargeable_weight_lb: run.weights.chargeable_weight_lb,
            chargeable_weight_oz: run.weights.chargeable_weight_oz,
            chargeable_weight_rule: run.weights.chargeable_weight_rule.clone(),
            fulfillment_fee_rule_label: run.fulfillment_fee_rule_label.clone(),
            inbound_config_fee_rule_label: run.inbound_config_fee_rule_label.clone(),
            storage_fee_rule_label: run.storage_fee_rule_label.clone(),
            referral_fee_usd: run.fees.referral_fee_usd,
            advertising_fee_usd: run.fees.advertising_fee_usd,
            return_loss_usd: run.fees.return_loss_usd,
            fba_fulfillment_fee_usd: run.fees.fba_fulfillment_fee_usd,
            inbound_config_fee_usd: run.fees.inbound_config_fee_usd,
            storage_fee_usd: run.fees.storage_fee_usd,
            total_fee_usd: run.fees.total_fee_usd,
            delivery_fee_usd,
            inbound_config_fee_manual_usd,
            storage_fee_manual_usd,
            platform_fee_usd: run.fees.platform_fee_usd,
            payout_usd: run.profit.payout_usd,
            profit_usd: run.profit.profit_usd,
            profit_rate: run.profit.profit_rate,
            vat_usd: run.profit.vat_usd,
            profit_after_vat_usd: run.profit.profit_after_vat_usd,
            profit_after_vat_rate: run.profit.profit_after_vat_rate,
            warnings: run.warnings.clone(),
        }
    }

    /// 从 EU 测算结果构建保存载荷（对齐 web EU `requestSaveSnapshot`：
    /// accounting_type = eu_accounting、仓储月数固定 1、入库单点、汇率来源空串）
    #[allow(clippy::too_many_arguments)]
    pub fn from_eu_run(
        run: &PricingRunItem,
        project_id: i64,
        project_name: &str,
        asin: Option<String>,
        country: &str,
        delivery_fee_usd: f64,
        inbound_config_fee_manual_usd: f64,
        storage_fee_manual_usd: f64,
    ) -> Self {
        let mut payload = Self::from_us_run(
            run,
            project_id,
            project_name,
            asin,
            country,
            delivery_fee_usd,
            inbound_config_fee_manual_usd,
            storage_fee_manual_usd,
        );
        payload.accounting_type = "eu_accounting".to_string();
        payload.storage_months = 1.0;
        payload.inbound_placement_mode = InboundPlacementMode::SingleDestination;
        payload.usd_to_rmb_rate_source = String::new();
        payload
    }
}

// ---------------------------------------------------------------------------
// EU 测算请求（backend `PricingCalculationEURequest` → POST eu-quote；
// 响应复用 PricingRunItem）
// ---------------------------------------------------------------------------

/// 欧洲（德国 / 英国）店铺 SKU 核算请求（backend
/// `PricingCalculationEURequest` 1:1；配送 / 配置 / 仓储三费手动填写）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PricingEuQuoteRequest {
    /// 仅 DE / UK（backend Literal 校验）
    pub country: String,
    pub product_name: String,
    pub package_length_cm: f64,
    pub package_width_cm: f64,
    pub package_height_cm: f64,
    pub weight_kg: f64,
    pub fob_product_cost_rmb: f64,
    pub first_leg_cost_rmb: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sku: Option<String>,
    pub sale_price_usd: f64,
    /// 手动派送费(USD)
    #[serde(default)]
    pub delivery_fee_usd: f64,
    /// 手动配置费(USD)
    #[serde(default)]
    pub inbound_config_fee_usd: f64,
    /// 手动仓储费(USD)
    #[serde(default)]
    pub storage_fee_usd: f64,
    #[serde(default = "default_commission_rate")]
    pub commission_rate: f64,
    #[serde(default = "default_advertising_rate")]
    pub advertising_rate: f64,
    #[serde(default = "default_return_loss_rate")]
    pub return_loss_rate: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usd_to_rmb_rate: Option<f64>,
}

fn default_commission_rate() -> f64 {
    0.15
}

fn default_advertising_rate() -> f64 {
    0.12
}

fn default_return_loss_rate() -> f64 {
    0.04
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 完整 ShopCalculationItem 解析（含四嵌套块 + EU VAT 扩展）
    #[test]
    fn shop_item_parses_full_payload() {
        let json = r#"{
            "id": 21,
            "project_id": 3,
            "project_name": "测试项目 A",
            "sku": "BB-US-001",
            "asin": "B0TEST01",
            "country": "DE",
            "accounting_type": "eu_accounting",
            "package_length_cm": 30.0,
            "package_width_cm": 20.0,
            "package_height_cm": 10.0,
            "weight_kg": 1.2,
            "fob_product_cost_rmb": 45.0,
            "first_leg_cost_rmb": 8.5,
            "ddp_cost_rmb": 106.3,
            "ddp_cost_usd": 14.87,
            "sale_price_usd": 29.99,
            "advertising_rate": 0.12,
            "return_loss_rate": 0.04,
            "storage_months": 1.0,
            "inbound_placement_mode": "single_destination",
            "usd_to_rmb_rate": 7.15,
            "usd_to_rmb_rate_source": "",
            "size_tier": "standard",
            "size_tier_label": "标准尺寸",
            "price_band": "20_50",
            "price_band_label": "$20-$50",
            "fulfillment_fee_rule_label": "EU 规则",
            "inbound_config_fee_rule_label": "入库配置",
            "storage_fee_rule_label": "仓储规则",
            "dimensions": {
                "longest_side_in": 11.81, "middle_side_in": 7.87,
                "shortest_side_in": 3.94, "length_plus_girth_in": 35.43,
                "volume_cubic_in": 366.14, "volume_cubic_ft": 0.21
            },
            "weights": {
                "product_weight_lb": 2.65, "product_weight_oz": 42.33,
                "dimensional_weight_lb": 1.27, "chargeable_weight_lb": 2.65,
                "chargeable_weight_oz": 42.33, "chargeable_weight_rule": "取大"
            },
            "fees": {
                "referral_fee_usd": 4.5, "advertising_fee_usd": 3.6,
                "return_loss_usd": 1.2, "fba_fulfillment_fee_usd": 3.2,
                "inbound_config_fee_usd": 0.3, "storage_fee_usd": 0.1,
                "total_fee_usd": 13.0,
                "delivery_fee_usd": 3.2, "inbound_config_fee_manual_usd": 0.3,
                "storage_fee_manual_usd": 0.1, "platform_fee_usd": 4.5
            },
            "profit": {
                "ddp_cost_rmb": 106.3, "ddp_cost_usd": 14.87,
                "payout_usd": 25.49, "profit_usd": 2.49, "profit_rate": 0.083,
                "vat_usd": 4.84, "profit_after_vat_usd": -2.35,
                "profit_after_vat_rate": -0.078
            },
            "warnings": ["利润为负"],
            "notes": null,
            "created_by": "测试",
            "observed_at": "2026-08-22T08:00:00Z",
            "source": "manual",
            "created_at": "2026-08-22T08:00:00Z",
            "updated_at": "2026-08-22T08:00:00Z"
        }"#;
        let item: ShopCalculationItem = serde_json::from_str(json).expect("解析失败");
        assert_eq!(item.id, 21);
        assert_eq!(item.accounting_type, "eu_accounting");
        assert_eq!(item.country, "DE");
        assert_eq!(
            item.inbound_placement_mode,
            InboundPlacementMode::SingleDestination
        );
        assert_eq!(item.fees.delivery_fee_usd, 3.2);
        assert_eq!(item.fees.platform_fee_usd, 4.5);
        assert_eq!(item.profit.vat_usd, 4.84);
        assert_eq!(item.profit.profit_after_vat_usd, Some(-2.35));
        assert_eq!(item.warnings, vec!["利润为负".to_string()]);
        // EU 展示口径取扣税后利润；US 回退税前
        assert_eq!(item.profit.display_profit_usd("DE"), -2.35);
        assert_eq!(item.profit.display_profit_usd("US"), 2.49);
    }

    /// 缺省容忍：EU 手动费用 / VAT 字段缺失时按 backend 默认值兜底
    #[test]
    fn shop_item_tolerates_missing_defaulted_fields() {
        let json = r#"{
            "id": 5,
            "project_id": 1,
            "project_name": "极简项目",
            "sku": "SKU-1",
            "package_length_cm": 10.0,
            "package_width_cm": 10.0,
            "package_height_cm": 10.0,
            "weight_kg": 1.0,
            "fob_product_cost_rmb": 20.0,
            "first_leg_cost_rmb": 5.0,
            "ddp_cost_rmb": 60.0,
            "ddp_cost_usd": 8.45,
            "sale_price_usd": 19.99,
            "advertising_rate": 0.12,
            "return_loss_rate": 0.04,
            "storage_months": 1.0,
            "inbound_placement_mode": "amazon_optimized_split",
            "usd_to_rmb_rate": 7.1,
            "usd_to_rmb_rate_source": "system",
            "size_tier": "standard",
            "size_tier_label": "标准尺寸",
            "price_band": "10_20",
            "price_band_label": "$10-$20",
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
            "observed_at": "2026-08-01T00:00:00Z",
            "created_at": "2026-08-01T00:00:00Z",
            "updated_at": "2026-08-01T00:00:00Z"
        }"#;
        let item: ShopCalculationItem = serde_json::from_str(json).expect("解析失败");
        assert_eq!(item.country, "US", "country 缺省回退 US");
        assert_eq!(item.accounting_type, "profit_calc");
        assert_eq!(item.source, "manual");
        assert_eq!(item.fees.delivery_fee_usd, 0.0);
        assert_eq!(item.fees.inbound_config_fee_manual_usd, 0.0);
        assert_eq!(item.fees.storage_fee_manual_usd, 0.0);
        assert_eq!(item.fees.platform_fee_usd, 0.0);
        assert_eq!(item.profit.vat_usd, 0.0);
        assert!(item.asin.is_none());
        assert!(item.warnings.is_empty());
    }

    /// SkuRecordsPage 解析（web ProductCostsResponse 同构）
    #[test]
    fn sku_page_parses_response() {
        let json = r#"{
            "items": [
                {
                    "id": 11,
                    "project_name": "测试项目 A",
                    "sku": "BB-US-001",
                    "asin": "B0TEST01",
                    "fob_unit_cost": 45.0,
                    "first_leg_cost_rmb": 8.5,
                    "package_length_cm": 30.0,
                    "package_width_cm": 20.0,
                    "package_height_cm": 10.0,
                    "weight_kg": 1.2,
                    "currency": "USD",
                    "country": "US",
                    "sort_order": 0,
                    "is_active": true
                }
            ],
            "page": 1,
            "page_size": 200,
            "total": 1,
            "has_next": false
        }"#;
        let page: SkuRecordsPage = serde_json::from_str(json).expect("解析失败");
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.total, Some(1));
        assert!(!page.has_next);
        assert_eq!(page.items[0].fob_unit_cost, 45.0);
    }

    /// US 保存载荷：从 run 构建 + 可选字段序列化行为（asin None 不出现）
    #[test]
    fn create_request_from_us_run_serializes() {
        let run = sample_run();
        let payload = ShopCalculationCreateRequest::from_us_run(
            &run,
            3,
            "测试项目 A",
            Some("B0TEST01".to_string()),
            "US",
            0.0,
            0.0,
            0.0,
        );
        assert_eq!(payload.sku, "BB-US-001");
        assert_eq!(payload.accounting_type, "profit_calc");
        assert_eq!(payload.project_id, 3);
        assert_eq!(payload.warnings.len(), 1);

        let value = serde_json::to_value(&payload).expect("序列化失败");
        assert_eq!(value["country"], "US");
        assert_eq!(value["accounting_type"], "profit_calc");
        assert_eq!(value["platform_fee_usd"], 0.0);
        assert!(
            value.get("profit_after_vat_usd").is_some() || value["profit_after_vat_usd"].is_null(),
            "Some(None) 序列化为 null 或缺省均可被 backend 接受"
        );
    }

    /// EU 保存载荷：accounting_type / 固定仓储月数 / 入库模式 / 汇率来源对齐 web
    #[test]
    fn create_request_from_eu_run_overrides() {
        let mut run = sample_run();
        run.profit.vat_usd = 4.84;
        run.profit.profit_after_vat_usd = Some(-2.35);
        run.profit.profit_after_vat_rate = Some(-0.078);
        let payload = ShopCalculationCreateRequest::from_eu_run(
            &run,
            3,
            "测试项目 A",
            None,
            "DE",
            3.2,
            0.3,
            0.1,
        );
        assert_eq!(payload.accounting_type, "eu_accounting");
        assert_eq!(payload.storage_months, 1.0);
        assert_eq!(
            payload.inbound_placement_mode,
            InboundPlacementMode::SingleDestination
        );
        assert_eq!(payload.usd_to_rmb_rate_source, "");
        assert_eq!(payload.delivery_fee_usd, 3.2);
        assert_eq!(payload.inbound_config_fee_manual_usd, 0.3);
        assert_eq!(payload.vat_usd, 4.84);
        assert_eq!(payload.profit_after_vat_usd, Some(-2.35));
    }

    /// EU quote 请求：可选字段 None 不序列化；默认费率对齐 backend
    #[test]
    fn eu_quote_request_skips_optional_fields() {
        let req = PricingEuQuoteRequest {
            country: "UK".into(),
            product_name: "测试项目 / SKU-1".into(),
            package_length_cm: 30.0,
            package_width_cm: 20.0,
            package_height_cm: 10.0,
            weight_kg: 1.2,
            fob_product_cost_rmb: 45.0,
            first_leg_cost_rmb: 8.5,
            project_id: None,
            sku: None,
            sale_price_usd: 29.99,
            delivery_fee_usd: 3.2,
            inbound_config_fee_usd: 0.3,
            storage_fee_usd: 0.1,
            commission_rate: 0.15,
            advertising_rate: 0.12,
            return_loss_rate: 0.04,
            usd_to_rmb_rate: None,
        };
        let value = serde_json::to_value(&req).expect("序列化失败");
        assert!(value.get("project_id").is_none());
        assert!(value.get("sku").is_none());
        assert!(value.get("usd_to_rmb_rate").is_none());
        assert_eq!(value["commission_rate"], 0.15);
        assert_eq!(value["delivery_fee_usd"], 3.2);
    }

    /// 测试样本 run（与 api-client 契约样本同口径的最小完整体）
    fn sample_run() -> PricingRunItem {
        serde_json::from_str(
            r#"{
                "id": 101,
                "country": "US",
                "product_name": "测试项目 A / BB-US-001",
                "calculation_type": "profit_calc",
                "project_id": 3,
                "sku": "BB-US-001",
                "package_length_cm": 30.0,
                "package_width_cm": 20.0,
                "package_height_cm": 10.0,
                "weight_kg": 1.2,
                "fob_product_cost_rmb": 45.0,
                "first_leg_cost_rmb": 8.5,
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
                    "longest_side_in": 11.81, "middle_side_in": 7.87,
                    "shortest_side_in": 3.94, "length_plus_girth_in": 35.43,
                    "volume_cubic_in": 366.14, "volume_cubic_ft": 0.21
                },
                "weights": {
                    "product_weight_lb": 2.65, "product_weight_oz": 42.33,
                    "dimensional_weight_lb": 1.27, "chargeable_weight_lb": 2.65,
                    "chargeable_weight_oz": 42.33, "chargeable_weight_rule": "取大"
                },
                "fees": {
                    "referral_fee_usd": 4.5, "advertising_fee_usd": 3.6,
                    "return_loss_usd": 1.2, "fba_fulfillment_fee_usd": 5.4,
                    "inbound_config_fee_usd": 0.3, "storage_fee_usd": 0.1,
                    "total_fee_usd": 15.1
                },
                "profit": {
                    "ddp_cost_rmb": 106.3, "ddp_cost_usd": 14.87,
                    "payout_usd": 25.49, "profit_usd": 10.62, "profit_rate": 0.354
                },
                "warnings": ["售价低于建议区间"],
                "created_at": "2026-08-18T10:00:00Z",
                "updated_at": "2026-08-18T10:00:00Z"
            }"#,
        )
        .expect("样本解析失败")
    }
}
