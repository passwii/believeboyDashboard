//! CRM 客户与合作伙伴领域类型（P5-7，BLF-742）
//!
//! 字段对齐 backend `backend/app/schemas/crm.py` 的 `DashboardStats` /
//! `LifecycleBoard` 系列模型，与 web 端 `frontend/lib/crm/types/dashboard.ts`
//! 及 `frontend/lib/crm/api/dto-mappers.ts` 的 DTO 声明同口径。
//!
//! 口径说明：
//! - `lead_funnel` 后端为 `dict[str, int]`（键 = 线索状态
//!   new/contacting/qualified/converted/discarded），GUI 用 `BTreeMap`
//!   承载（键序稳定；取数按已知键，未知键忽略）；
//! - 生命周期天数分桶的 `min_days / max_days / pct` 后端为 float，GUI 用
//!   `f64` 承载；`max_days: None` = 无上限桶（30 天以上）；
//! - 漏斗派生口径对齐 web `frontend/lib/crm/method/lead-funnel.ts`：
//!   看板漏斗用 **raw 阶段口径**（BLF-516 决策 4：各阶段当前计数直接作层宽，
//!   一眼看出哪一级堆人、哪一级掉得快），弃置（discarded）不进主漏斗、单独展示。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// 数据看板统计（P3c，仅管理员）
// ---------------------------------------------------------------------------

/// 本月新增（Asia/Shanghai 口径）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct NewThisMonth {
    /// 本月新建客户数
    #[serde(default)]
    pub new_customers: i64,
    /// 本月新建线索数
    #[serde(default)]
    pub new_leads: i64,
    /// 本月转化数（converted_at 落本月）
    #[serde(default)]
    pub converted_count: i64,
}

/// 跟进活跃度（最近 7 天）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct FollowActivity {
    /// 最近 7 天跟进记录数
    #[serde(default)]
    pub follow_count_7d: i64,
}

/// 每销售业绩（按负责人分组）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct OwnerPerformance {
    pub owner_id: String,
    #[serde(default)]
    pub owner_name: Option<String>,
    /// 名下客户数（未删除）
    #[serde(default)]
    pub customer_count: i64,
    /// 名下本月转化线索数
    #[serde(default)]
    pub converted_this_month: i64,
}

/// CRM 数据看板聚合结果（对应 `GET /api/v1/crm/dashboard/stats`）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DashboardStats {
    /// 线索各状态计数（new/contacting/qualified/converted/discarded）
    #[serde(default)]
    pub lead_funnel: BTreeMap<String, i64>,
    #[serde(default)]
    pub new_this_month: NewThisMonth,
    #[serde(default)]
    pub follow_activity: FollowActivity,
    #[serde(default)]
    pub per_owner: Vec<OwnerPerformance>,
}

/// 线索状态 → 展示名（对齐 web `STAGE_LABELS` / `LEAD_STATUS_LABELS`，BLF-516 决策 1）
pub fn stage_label(stage: &str) -> &'static str {
    match stage {
        "new" => "新线索",
        "contacting" => "联系中",
        "qualified" => "已验证",
        "converted" => "已转化",
        "discarded" => "已弃置",
        _ => "未知",
    }
}

/// 漏斗一档（raw 阶段口径：value = 该阶段当前线索数）
#[derive(Debug, Clone, PartialEq)]
pub struct FunnelStageBar {
    /// 后端 stage key（new/contacting/qualified/converted）
    pub stage: &'static str,
    /// 展示名
    pub label: &'static str,
    pub value: i64,
}

/// 阶段漏斗四档（raw counts，不累计——BLF-516 决策 4 定稿口径）。
/// 即使输入为空也返回完整四档结构（值全 0），调用方用合计判断是否展示。
pub fn build_stage_funnel(counts: &BTreeMap<String, i64>) -> Vec<FunnelStageBar> {
    let get = |key: &str| counts.get(key).copied().unwrap_or(0);
    [
        ("new", "新线索"),
        ("contacting", "联系中"),
        ("qualified", "已验证"),
        ("converted", "已转化"),
    ]
    .into_iter()
    .map(|(stage, label)| FunnelStageBar {
        stage,
        label,
        value: get(stage),
    })
    .collect()
}

/// 整体转化率 = 转化 / (new+contacting+qualified+converted)；总量为 0 时返回
/// `None`（页面不展示徽标）。弃置不进分母（对齐 web `leadConversionRate`）。
pub fn lead_conversion_rate(counts: &BTreeMap<String, i64>) -> Option<f64> {
    let get = |key: &str| counts.get(key).copied().unwrap_or(0);
    let total = get("new") + get("contacting") + get("qualified") + get("converted");
    if total == 0 {
        return None;
    }
    Some(get("converted") as f64 / total as f64)
}

/// 相邻阶段的逐级转化率：第 i 项 = stages[i+1].value / stages[i].value。
/// 返回长度 = stages.len() - 1；前档值为 0 时该项为 `None`（展示为 "—"）。
/// 用于定位漏斗卡点（对齐 web `leadFunnelStepRates`）。
pub fn step_rates(stages: &[FunnelStageBar]) -> Vec<Option<f64>> {
    stages
        .windows(2)
        .map(|w| {
            let (from, to) = (w[0].value, w[1].value);
            if from > 0 {
                Some(to as f64 / from as f64)
            } else {
                None
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// 生命周期看板（P8，BLF-520，仅管理员）
// ---------------------------------------------------------------------------

/// 一个天数分桶（直方图柱）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct LifecycleBucket {
    /// 桶名（如 "1 天内" / "3-7 天" / "30 天以上"）
    pub label: String,
    #[serde(default)]
    pub min_days: f64,
    /// `None` = 无上限桶（30 天以上）
    #[serde(default)]
    pub max_days: Option<f64>,
    #[serde(default)]
    pub count: i64,
    /// 占 sample_count 比例（0-1）
    #[serde(default)]
    pub pct: f64,
    /// 累计占比（0-1，转化时间漏斗叠加用）
    #[serde(default)]
    pub cumulative_pct: f64,
}

/// 生命周期分布的摘要统计（天数）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct LifecycleSummary {
    /// 有该事件的数据数（分布主体）
    #[serde(default)]
    pub sample_count: i64,
    /// 口径总体（如全部未删除客户数）
    #[serde(default)]
    pub total_count: i64,
    #[serde(default)]
    pub avg_days: Option<f64>,
    /// P50
    #[serde(default)]
    pub median_days: Option<f64>,
    #[serde(default)]
    pub p90_days: Option<f64>,
    #[serde(default)]
    pub max_days: Option<f64>,
}

/// 一种「从创建到事件」的时间分布（BLF-520）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct LifecycleDistribution {
    /// first_follow / conversion / churn
    pub metric: String,
    /// 中文展示名（首次跟进 / 转化 / 流失）
    #[serde(default)]
    pub label: String,
    /// 口径说明
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub buckets: Vec<LifecycleBucket>,
    #[serde(default)]
    pub summary: LifecycleSummary,
}

/// 生命周期看板聚合结果（客户创建 → 首次跟进/转化/流失 的时间分布，
/// 对应 `GET /api/v1/crm/dashboard/lifecycle`）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct LifecycleBoard {
    #[serde(default)]
    pub first_follow: LifecycleDistribution,
    #[serde(default)]
    pub conversion: LifecycleDistribution,
    #[serde(default)]
    pub churn: LifecycleDistribution,
    /// 当前在公海的客户数（owner 为空）
    #[serde(default)]
    pub now_in_sea: i64,
}

/// 转化时间漏斗的一档（宽→窄排列；对齐 web `buildTimeFunnelStages`）
#[derive(Debug, Clone, PartialEq)]
pub struct TimeFunnelStage {
    pub label: String,
    pub value: i64,
}

/// 转化时间漏斗（BLF-520「漏斗叠加」）：从分布累计占比推出「N 天内转化」
/// 各档，宽→窄排列：已转化（全部样本）→ 30 天内 → … → 1 天内。
/// 档宽 = round(cumulative_pct × sample_count)，单调递减形成漏斗。
/// 无样本返回空数组（调用方不渲染叠加区）。
pub fn time_funnel_stages(dist: &LifecycleDistribution) -> Vec<TimeFunnelStage> {
    let sample = dist.summary.sample_count;
    if sample == 0 {
        return Vec::new();
    }
    let mut capped: Vec<&LifecycleBucket> = dist
        .buckets
        .iter()
        .filter(|b| b.max_days.is_some_and(|d| d > 0.0))
        .collect();
    capped.reverse();
    let mut stages = vec![TimeFunnelStage {
        label: "已转化".to_string(),
        value: sample,
    }];
    stages.extend(capped.into_iter().map(|b| TimeFunnelStage {
        label: format!("{} 天内", fmt_bucket_days(b.max_days.unwrap_or(0.0))),
        value: (b.cumulative_pct * sample as f64).round() as i64,
    }));
    stages
}

/// 分桶上限天数 → 整数文本（后端桶界为整天，f64 承载仅因 JSON 数值类型）
fn fmt_bucket_days(days: f64) -> String {
    if days.fract() == 0.0 {
        format!("{}", days as i64)
    } else {
        format!("{days}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn counts(pairs: &[(&str, i64)]) -> BTreeMap<String, i64> {
        pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    }

    #[test]
    fn stage_label_maps_known_keys() {
        assert_eq!(stage_label("new"), "新线索");
        assert_eq!(stage_label("contacting"), "联系中");
        assert_eq!(stage_label("qualified"), "已验证");
        assert_eq!(stage_label("converted"), "已转化");
        assert_eq!(stage_label("discarded"), "已弃置");
        assert_eq!(stage_label("nope"), "未知");
    }

    /// 阶段漏斗：raw 口径逐档取当前计数；缺键按 0；空输入仍返回完整四档
    #[test]
    fn build_stage_funnel_uses_raw_counts() {
        let funnel = build_stage_funnel(&counts(&[
            ("new", 10),
            ("contacting", 6),
            ("qualified", 3),
            ("converted", 2),
            ("discarded", 4),
        ]));
        assert_eq!(funnel.len(), 4);
        assert_eq!(funnel[0].stage, "new");
        assert_eq!(funnel[0].value, 10);
        assert_eq!(funnel[1].value, 6);
        assert_eq!(funnel[2].value, 3);
        assert_eq!(funnel[3].value, 2);
        // 弃置不进主漏斗
        assert!(funnel.iter().all(|s| s.stage != "discarded"));

        let empty = build_stage_funnel(&BTreeMap::new());
        assert_eq!(empty.len(), 4);
        assert!(empty.iter().all(|s| s.value == 0));
    }

    #[test]
    fn conversion_rate_excludes_discarded_and_handles_zero() {
        let c = counts(&[
            ("new", 10),
            ("contacting", 6),
            ("qualified", 3),
            ("converted", 2),
            ("discarded", 100),
        ]);
        let rate = lead_conversion_rate(&c).expect("总量非零应有转化率");
        assert!((rate - 2.0 / 21.0).abs() < 1e-9);
        assert!(lead_conversion_rate(&BTreeMap::new()).is_none());
    }

    /// 逐级转化率：相邻档相除；前档为 0 → None（展示 "—"）
    #[test]
    fn step_rates_divide_adjacent_stages() {
        let stages = build_stage_funnel(&counts(&[
            ("new", 10),
            ("contacting", 5),
            ("qualified", 0),
            ("converted", 2),
        ]));
        let rates = step_rates(&stages);
        assert_eq!(rates.len(), 3);
        assert!((rates[0].unwrap() - 0.5).abs() < 1e-9);
        assert!(rates[1].is_some_and(|r| r == 0.0), "后档为 0 是合法值 Some(0.0)");
        assert!(rates[2].is_none(), "前档 0 应为 None");
    }

    /// 反序列化：snake_case 直通 + 缺字段 serde default 兜底（后端 Pydantic
    /// 全字段有默认值，理论上恒携带；容错对齐 commission/vat_invoice 先例）
    #[test]
    fn dashboard_stats_deserializes_snake_case() {
        let stats: DashboardStats = serde_json::from_str(
            r#"{
                "lead_funnel": {"new": 10, "contacting": 6, "qualified": 3,
                                "converted": 2, "discarded": 4},
                "new_this_month": {"new_customers": 5, "new_leads": 10,
                                   "converted_count": 2},
                "follow_activity": {"follow_count_7d": 18},
                "per_owner": [
                    {"owner_id": "u-1", "owner_name": "张三",
                     "customer_count": 12, "converted_this_month": 2},
                    {"owner_id": "u-2", "owner_name": null,
                     "customer_count": 3, "converted_this_month": 0}
                ]
            }"#,
        )
        .expect("解析失败");
        assert_eq!(stats.new_this_month.new_customers, 5);
        assert_eq!(stats.follow_activity.follow_count_7d, 18);
        assert_eq!(stats.per_owner.len(), 2);
        assert_eq!(stats.per_owner[1].owner_name, None);
        assert_eq!(stats.lead_funnel.get("discarded"), Some(&4));
    }

    #[test]
    fn lifecycle_board_deserializes_snake_case() {
        let board: LifecycleBoard = serde_json::from_str(
            r#"{
                "first_follow": {
                    "metric": "first_follow", "label": "首次跟进",
                    "description": "客户创建到第一条跟进",
                    "buckets": [
                        {"label": "1 天内", "min_days": 0, "max_days": 1,
                         "count": 8, "pct": 0.4, "cumulative_pct": 0.4},
                        {"label": "30 天以上", "min_days": 30, "max_days": null,
                         "count": 2, "pct": 0.1, "cumulative_pct": 1.0}
                    ],
                    "summary": {"sample_count": 20, "total_count": 25,
                                "avg_days": 4.2, "median_days": 3.0,
                                "p90_days": 12.0, "max_days": 40.0}
                },
                "conversion": {
                    "metric": "conversion", "label": "转化",
                    "description": "", "buckets": [],
                    "summary": {"sample_count": 0, "total_count": 0}
                },
                "churn": {
                    "metric": "churn", "label": "流失",
                    "description": "", "buckets": [],
                    "summary": {"sample_count": 0, "total_count": 0}
                },
                "now_in_sea": 7
            }"#,
        )
        .expect("解析失败");
        assert_eq!(board.now_in_sea, 7);
        let ff = &board.first_follow;
        assert_eq!(ff.summary.sample_count, 20);
        assert_eq!(ff.buckets.len(), 2);
        assert_eq!(ff.buckets[1].max_days, None, "无上限桶 max_days 为 null");
    }

    /// 转化时间漏斗：已转化（全样本）→ 有上限桶倒序累计；无样本返回空
    #[test]
    fn time_funnel_stages_build_wide_to_narrow() {
        let dist = LifecycleDistribution {
            metric: "conversion".into(),
            label: "转化".into(),
            description: String::new(),
            buckets: vec![
                bucket("1 天内", Some(1.0), 0.2),
                bucket("3-7 天", Some(7.0), 0.6),
                bucket("30 天以上", None, 1.0),
            ],
            summary: LifecycleSummary {
                sample_count: 50,
                ..Default::default()
            },
        };
        let stages = time_funnel_stages(&dist);
        assert_eq!(stages.len(), 3, "首档 + 两个有上限桶（无上限桶剔除）");
        assert_eq!(stages[0].label, "已转化");
        assert_eq!(stages[0].value, 50);
        assert_eq!(stages[1].label, "7 天内");
        assert_eq!(stages[1].value, 30, "0.6 × 50");
        assert_eq!(stages[2].label, "1 天内");
        assert_eq!(stages[2].value, 10);

        let empty_dist = LifecycleDistribution::default();
        assert!(time_funnel_stages(&empty_dist).is_empty());
    }

    fn bucket(label: &str, max_days: Option<f64>, cumulative_pct: f64) -> LifecycleBucket {
        LifecycleBucket {
            label: label.to_string(),
            min_days: 0.0,
            max_days,
            count: 0,
            pct: 0.0,
            cumulative_pct,
        }
    }
}
