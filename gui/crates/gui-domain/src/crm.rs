//! CRM 客户与合作伙伴领域类型（P5-7，BLF-742 / BLF-743）
//!
//! 字段对齐 backend `backend/app/schemas/crm.py` 的 `DashboardStats` /
//! `LifecycleBoard` / `FollowUpItem` / `FollowUpGroups` 系列模型，与 web 端
//! `frontend/lib/crm/types/dashboard.ts`、`frontend/lib/crm/types/follow-up.ts`
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

use chrono::{DateTime, Datelike, Local, Utc};
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
mod follow_up_tests {
    use super::*;

    /// 反序列化：snake_case 直通 + 缺字段 serde default 兜底（对齐后端 Pydantic 全默认值）
    #[test]
    fn follow_up_groups_deserializes_snake_case() {
        let groups: FollowUpGroups = serde_json::from_str(
            r#"{
                "overdue": [
                    {"entity_type": "customer", "entity_id": 3, "name": "客户甲",
                     "subtitle": "制造业", "owner_id": "u-1", "owner_name": "张三",
                     "next_follow_at": "2026-08-10T09:30:00+08:00",
                     "last_follow_content": "电话沟通报价",
                     "last_follow_at": "2026-08-01T14:00:00+08:00",
                     "rating": "A", "status": "active", "intent": null}
                ],
                "today": [],
                "this_week": [
                    {"entity_type": "lead", "entity_id": 7, "name": "线索乙",
                     "next_follow_at": "2026-08-22T15:00:00+08:00"}
                ],
                "overdue_count": 1,
                "total_count": 2
            }"#,
        )
        .expect("反序列化失败");
        assert_eq!(groups.overdue.len(), 1);
        assert_eq!(groups.today.len(), 0);
        assert_eq!(groups.this_week.len(), 1);
        assert_eq!(groups.overdue_count, 1);
        assert_eq!(groups.total_count, 2);

        let c = &groups.overdue[0];
        assert!(c.is_customer());
        assert_eq!(c.entity_label(), "客户");
        assert_eq!(c.rating.as_deref(), Some("A"));
        assert_eq!(c.last_follow_content.as_deref(), Some("电话沟通报价"));
        // timezone-aware ISO 带偏移量 → UTC 承载
        assert_eq!(
            c.next_follow_at,
            DateTime::parse_from_rfc3339("2026-08-10T09:30:00+08:00")
                .unwrap()
                .with_timezone(&Utc)
        );

        let lead = &groups.this_week[0];
        assert!(!lead.is_customer());
        assert_eq!(lead.entity_label(), "线索");
        assert!(lead.subtitle.is_none());
    }

    /// 空对象全 default 兜底（后端空分组返回 `{}` 形状也安全）
    #[test]
    fn follow_up_groups_defaults_on_missing_fields() {
        let groups: FollowUpGroups = serde_json::from_str("{}").expect("空对象应可解析");
        assert!(groups.overdue.is_empty());
        assert_eq!(groups.total_count, 0);
    }

    /// 等级徽标短文案（对齐 web CUSTOMER_RATING_LABELS 的列表行口径）
    #[test]
    fn rating_label_maps_known_grades() {
        assert_eq!(rating_label("A"), "A 级");
        assert_eq!(rating_label("D"), "D 级");
        assert_eq!(rating_label("unknown"), "unknown");
    }

    /// 展示文案：逾期 N 天 / 今天 HH:mm / 周X HH:mm（本机时区；注入固定 now）
    #[test]
    fn format_next_follow_matches_web_copy() {
        use chrono::TimeZone;

        // 固定「现在」：2026-08-21（周五）15:00 本机时区
        let now = Local.with_ymd_and_hms(2026, 8, 21, 15, 0, 0).unwrap();

        // 逾期：三天前 09:30 → 「逾期 3 天」
        let overdue_at = Local
            .with_ymd_and_hms(2026, 8, 18, 9, 30, 0)
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            format_next_follow(overdue_at, FollowUpGroup::Overdue, now),
            "逾期 3 天"
        );

        // 今日：今天 09:05 → 「今天 09:05」
        let today_at = Local
            .with_ymd_and_hms(2026, 8, 21, 9, 5, 0)
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            format_next_follow(today_at, FollowUpGroup::Today, now),
            "今天 09:05"
        );

        // 本周：周六 15:30 → 「周六 15:30」（2026-08-22 是周六）
        let week_at = Local
            .with_ymd_and_hms(2026, 8, 22, 15, 30, 0)
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            format_next_follow(week_at, FollowUpGroup::ThisWeek, now),
            "周六 15:30"
        );

        // 当天内逾期（零点差 0 天）→ 「逾期」不带天数（对齐 web days > 0 判断）
        let earlier_today = Local
            .with_ymd_and_hms(2026, 8, 21, 0, 30, 0)
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            format_next_follow(earlier_today, FollowUpGroup::Overdue, now),
            "逾期"
        );
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
        assert!(
            rates[1].is_some_and(|r| r == 0.0),
            "后档为 0 是合法值 Some(0.0)"
        );
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

// ---------------------------------------------------------------------------
// 待跟进视图（P2b，P5-7 GUI 接入）
// ---------------------------------------------------------------------------

/// 待跟进记录归属分组（后端按 Asia/Shanghai 时区把 `next_follow_at` 归桶）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FollowUpGroup {
    /// 逾期未跟进（next_follow_at 早于今天 0 点）
    Overdue,
    /// 今日待跟进（落在今天内）
    Today,
    /// 本周待跟进（明天 → 本周日 23:59:59）
    ThisWeek,
}

/// 一条待跟进记录（客户或线索），字段对齐 backend
/// `backend/app/schemas/crm.py` 的 `FollowUpItem`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FollowUpItem {
    /// `"customer"` | `"lead"`
    pub entity_type: String,
    pub entity_id: i64,
    pub name: String,
    /// 线索 = 公司名；客户 = 行业
    #[serde(default)]
    pub subtitle: Option<String>,
    #[serde(default)]
    pub owner_id: Option<String>,
    #[serde(default)]
    pub owner_name: Option<String>,
    /// 下次跟进时间（后端 timezone-aware ISO 8601，反序列化为 UTC）
    pub next_follow_at: DateTime<Utc>,
    #[serde(default)]
    pub last_follow_content: Option<String>,
    #[serde(default)]
    pub last_follow_at: Option<DateTime<Utc>>,
    /// 客户等级（A/B/C/D；线索为 None）
    #[serde(default)]
    pub rating: Option<String>,
    /// 客户状态 / 线索状态
    #[serde(default)]
    pub status: Option<String>,
    /// 线索意向
    #[serde(default)]
    pub intent: Option<String>,
}

impl FollowUpItem {
    /// 实体类型徽标文本（对齐 web FollowUpRow：客户 / 线索）
    pub fn entity_label(&self) -> &'static str {
        if self.entity_type == "customer" {
            "客户"
        } else {
            "线索"
        }
    }

    /// 是否客户实体
    pub fn is_customer(&self) -> bool {
        self.entity_type == "customer"
    }
}

/// 待跟进分组结果，对齐 backend `FollowUpGroups`（`this_week` 蛇形键由
/// serde 默认命名承载——字段名即 JSON 键）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct FollowUpGroups {
    #[serde(default)]
    pub overdue: Vec<FollowUpItem>,
    #[serde(default)]
    pub today: Vec<FollowUpItem>,
    #[serde(default)]
    pub this_week: Vec<FollowUpItem>,
    #[serde(default)]
    pub overdue_count: i64,
    #[serde(default)]
    pub total_count: i64,
}

/// 客户等级徽标文本（对齐 web `CUSTOMER_RATING_LABELS`，列表行取短文案）
pub fn rating_label(rating: &str) -> String {
    match rating {
        "A" => "A 级".to_string(),
        "B" => "B 级".to_string(),
        "C" => "C 级".to_string(),
        "D" => "D 级".to_string(),
        other => other.to_string(),
    }
}

/// 下次跟进时间的展示文案（对齐 web `formatNextFollow`：逾期 N 天 /
/// 今天 HH:mm / 周X HH:mm）。分桶由后端完成（Asia/Shanghai），展示时刻用
/// **本机时区**换算——与 web 用浏览器本地时间同口径。
///
/// `now_local` 由调用方传入（测试可注入固定时刻）。
pub fn format_next_follow(
    next_follow_at: DateTime<Utc>,
    group: FollowUpGroup,
    now_local: DateTime<Local>,
) -> String {
    let local = next_follow_at.with_timezone(&Local);
    let hm = local.format("%H:%M").to_string();
    match group {
        FollowUpGroup::Overdue => {
            // 对齐 web：本地零点差取整日数；当天内逾期显示「逾期」
            let today_start = now_local.date_naive();
            let due_date = local.date_naive();
            let days = (today_start - due_date).num_days();
            if days > 0 {
                format!("逾期 {days} 天")
            } else {
                "逾期".to_string()
            }
        }
        FollowUpGroup::Today => format!("今天 {hm}"),
        FollowUpGroup::ThisWeek => {
            const WEEKDAYS: [&str; 7] = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
            format!(
                "{} {hm}",
                WEEKDAYS[local.weekday().num_days_from_sunday() as usize]
            )
        }
    }
}

// ---------------------------------------------------------------------------
// 操作审计日志（P4，P5-7 GUI 接入 BLF-747）
// ---------------------------------------------------------------------------

/// 一条 CRM 操作审计日志，字段对齐 backend `backend/app/schemas/crm.py` 的
/// `AuditLogItem`（snake_case 直通；与 web 端 `frontend/lib/crm/types/audit.ts`
/// 的 `AuditLog` 同口径）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AuditLogItem {
    pub id: i64,
    /// `"customer"` | `"lead"` | `"contact"` | `"task"`
    pub entity_type: String,
    pub entity_id: i64,
    /// 动作 key（create/update/delete/transfer/move_sea/claim/convert/
    /// complete/cancel/status；未知值原样透传展示）
    pub action: String,
    #[serde(default)]
    pub actor_id: Option<String>,
    #[serde(default)]
    pub actor_name: Option<String>,
    /// 变更摘要（后端 audit_service.summarize 生成；可为空）
    #[serde(default)]
    pub summary: Option<String>,
    /// 操作时间（后端 timezone-aware ISO 8601，反序列化为 UTC）
    pub created_at: DateTime<Utc>,
}

/// 审计日志分页结果，字段对齐 backend `AuditLogListResponse`
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AuditLogPage {
    #[serde(default)]
    pub items: Vec<AuditLogItem>,
    #[serde(default)]
    pub total: i64,
    #[serde(default)]
    pub page: i64,
    #[serde(default)]
    pub page_size: i64,
}

/// 实体类型筛选选项（key + 中文标签；对齐 web `ENTITY_LABELS`，
/// 菜单顺序即数组顺序）
pub const AUDIT_ENTITY_TYPES: [(&str, &str); 4] = [
    ("customer", "客户"),
    ("lead", "线索"),
    ("contact", "联系人"),
    ("task", "任务"),
];

/// 审计动作选项（key + 中文标签；对齐 web `AUDIT_ACTION_LABELS` 键序）
pub const AUDIT_ACTIONS: [(&str, &str); 10] = [
    ("create", "新建"),
    ("update", "编辑"),
    ("delete", "删除"),
    ("transfer", "指派负责人"),
    ("move_sea", "释放公海"),
    ("claim", "领取"),
    ("convert", "转化"),
    ("complete", "完成"),
    ("cancel", "取消"),
    ("status", "状态变更"),
];

/// 实体类型 → 中文标签（行内展示用；已知类型查表，未知原样返回）
pub fn audit_entity_label(entity_type: &str) -> String {
    AUDIT_ENTITY_TYPES
        .iter()
        .find(|(key, _)| *key == entity_type)
        .map(|(_, label)| label.to_string())
        .unwrap_or_else(|| entity_type.to_string())
}

/// 动作 → 中文标签（行内展示用；已知动作查表，未知原样返回——对齐 web
/// `AUDIT_ACTION_LABELS[action] ?? action` 兜底口径）
pub fn audit_action_label(action: &str) -> String {
    AUDIT_ACTIONS
        .iter()
        .find(|(key, _)| *key == action)
        .map(|(_, label)| label.to_string())
        .unwrap_or_else(|| action.to_string())
}

/// 操作时间展示文案：UTC → 本机时区 `YYYY-MM-DD HH:MM`（对齐 web
/// `toLocaleString('zh-CN')` 的浏览器本地时区口径；GUI 取固定格式保证列宽稳定）
pub fn format_audit_time(created_at: DateTime<Utc>) -> String {
    created_at
        .with_timezone(&Local)
        .format("%Y-%m-%d %H:%M")
        .to_string()
}

#[cfg(test)]
mod audit_tests {
    use super::*;
    use chrono::TimeZone;

    /// 反序列化：snake_case 直通 + 可空字段 default 兜底
    #[test]
    fn audit_page_deserializes_snake_case() {
        let page: AuditLogPage = serde_json::from_str(
            r#"{
                "items": [
                    {"id": 1, "entity_type": "customer", "entity_id": 3,
                     "action": "create", "actor_id": "u-1", "actor_name": "张三",
                     "summary": "创建客户「客户甲」",
                     "created_at": "2026-08-21T10:30:00+08:00"},
                    {"id": 2, "entity_type": "lead", "entity_id": 7,
                     "action": "move_sea", "actor_id": null, "actor_name": null,
                     "summary": null, "created_at": "2026-08-20T09:00:00Z"}
                ],
                "total": 42, "page": 2, "page_size": 30
            }"#,
        )
        .expect("反序列化失败");
        assert_eq!(page.items.len(), 2);
        assert_eq!(page.total, 42);
        assert_eq!(page.page, 2);
        assert_eq!(page.page_size, 30);

        let first = &page.items[0];
        assert_eq!(first.entity_type, "customer");
        assert_eq!(first.actor_name.as_deref(), Some("张三"));
        assert_eq!(first.summary.as_deref(), Some("创建客户「客户甲」"));
        assert_eq!(
            first.created_at,
            DateTime::parse_from_rfc3339("2026-08-21T10:30:00+08:00")
                .unwrap()
                .with_timezone(&Utc)
        );
        assert!(page.items[1].actor_name.is_none());
    }

    /// 空对象全 default 兜底（后端空列表返回 `{}` 形状也安全）
    #[test]
    fn audit_page_defaults_on_missing_fields() {
        let page: AuditLogPage = serde_json::from_str("{}").expect("空对象应可解析");
        assert!(page.items.is_empty());
        assert_eq!(page.total, 0);
    }

    /// 实体类型 / 动作标签：已知查表、未知原样透传
    #[test]
    fn audit_labels_map_known_and_pass_through_unknown() {
        assert_eq!(audit_entity_label("customer"), "客户");
        assert_eq!(audit_entity_label("lead"), "线索");
        assert_eq!(audit_entity_label("contact"), "联系人");
        assert_eq!(audit_entity_label("task"), "任务");
        assert_eq!(audit_entity_label("unknown_kind"), "unknown_kind");

        assert_eq!(audit_action_label("create"), "新建");
        assert_eq!(audit_action_label("move_sea"), "释放公海");
        assert_eq!(audit_action_label("status"), "状态变更");
        assert_eq!(audit_action_label("weird_action"), "weird_action");
    }

    /// 筛选选项表完整性：动作 10 项、实体 4 项（对齐 web 常量表键序）
    #[test]
    fn audit_filter_option_tables_are_complete() {
        assert_eq!(AUDIT_ENTITY_TYPES.len(), 4);
        assert_eq!(AUDIT_ACTIONS.len(), 10);
        assert_eq!(AUDIT_ACTIONS[0], ("create", "新建"));
        assert_eq!(AUDIT_ACTIONS[9], ("status", "状态变更"));
    }

    /// 时间文案：UTC → 本机时区 `YYYY-MM-DD HH:MM`
    #[test]
    fn format_audit_time_uses_local_timezone() {
        // 本机时区 2026-08-21 15:30 → UTC 随偏移换算，格式化后回到同一本地时刻
        let local = Local.with_ymd_and_hms(2026, 8, 21, 15, 30, 0).unwrap();
        assert_eq!(format_audit_time(local.with_timezone(&Utc)), "2026-08-21 15:30");

        // 固定 UTC 时刻换算本机时区后仅锁格式形状（日期可能随偏移跨日界，不锁值）
        let utc = Utc.with_ymd_and_hms(2026, 8, 21, 15, 30, 0).unwrap();
        let formatted = format_audit_time(utc);
        assert_eq!(formatted.len(), 16, "格式固定 YYYY-MM-DD HH:MM：{formatted}");
        assert_eq!(formatted.as_bytes()[4], b'-');
        assert_eq!(formatted.as_bytes()[10], b' ');
    }
}
// ---------------------------------------------------------------------------
// 客户 / 线索 / 任务列表（Stage13，BLF-804）
// ---------------------------------------------------------------------------

/// 一条客户记录，字段对齐 backend `backend/app/schemas/crm.py` 的
/// `CustomerItem`（GUI 只读主面消费子集 + 联系人 join 字段）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CustomerItem {
    pub id: i64,
    pub name: String,
    #[serde(default)]
    pub short_name: Option<String>,
    #[serde(default)]
    pub industry: Option<String>,
    /// 对象类型：工厂/贸易商/同行/其他
    #[serde(default)]
    pub customer_type: Option<String>,
    /// 意向服务：代运营/AI运营/运营服务/其他
    #[serde(default)]
    pub interested_service: Option<String>,
    /// 客户等级（A/B/C/D，4 维价值评分汇总）
    pub rating: String,
    /// 客户状态（active/churned/…；后端自由字符串）
    pub status: String,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub owner_id: Option<String>,
    #[serde(default)]
    pub owner_name: Option<String>,
    // primary contact join 字段
    #[serde(default)]
    pub contact_name: Option<String>,
    #[serde(default)]
    pub contact_phone: Option<String>,
    #[serde(default)]
    pub contact_email: Option<String>,
    #[serde(default)]
    pub contact_wechat: Option<String>,
    #[serde(default)]
    pub address: Option<String>,
    #[serde(default)]
    pub website: Option<String>,
    #[serde(default)]
    pub remark: Option<String>,
    #[serde(default)]
    pub last_follow_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub next_follow_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl CustomerItem {
    /// 是否公海客户（owner 为空）
    pub fn is_sea(&self) -> bool {
        self.owner_id.is_none()
    }
}

/// 客户分页结果，字段对齐 backend `CustomerListResponse`
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CustomerPage {
    #[serde(default)]
    pub items: Vec<CustomerItem>,
    #[serde(default)]
    pub total: i64,
    #[serde(default)]
    pub page: i64,
    #[serde(default)]
    pub page_size: i64,
}

/// 一条线索记录，字段对齐 backend `LeadItem`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LeadItem {
    pub id: i64,
    pub name: String,
    #[serde(default)]
    pub company: Option<String>,
    #[serde(default)]
    pub phone: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub wechat: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    /// 线索状态（new/contacting/qualified/converted/discarded）
    pub status: String,
    /// 意向（high/medium/low）
    #[serde(default = "default_lead_intent")]
    pub intent: String,
    #[serde(default)]
    pub customer_type: Option<String>,
    #[serde(default)]
    pub interested_service: Option<String>,
    #[serde(default)]
    pub owner_id: Option<String>,
    #[serde(default)]
    pub owner_name: Option<String>,
    #[serde(default)]
    pub expected_amount: Option<f64>,
    #[serde(default)]
    pub expected_close_date: Option<String>,
    #[serde(default)]
    pub remark: Option<String>,
    #[serde(default)]
    pub next_follow_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub converted_to_customer_id: Option<i64>,
    #[serde(default)]
    pub converted_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

fn default_lead_intent() -> String {
    "medium".to_string()
}

/// 线索状态 → 中文标签（对齐 web lead.enum STATUS_LABELS；未知原样返回）
pub fn lead_status_label(status: &str) -> String {
    match status {
        "new" => "新线索",
        "contacting" => "接触中",
        "qualified" => "已验证",
        "converted" => "已转化",
        "discarded" => "已弃置",
        _ => return status.to_string(),
    }
    .to_string()
}

/// 意向等级 → 中文标签（对齐 web INTENT_LABELS）
pub fn lead_intent_label(intent: &str) -> String {
    match intent {
        "high" => "高意向",
        "medium" => "中意向",
        "low" => "低意向",
        _ => return intent.to_string(),
    }
    .to_string()
}

/// 线索分页结果，字段对齐 backend `LeadListResponse`
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct LeadPage {
    #[serde(default)]
    pub items: Vec<LeadItem>,
    #[serde(default)]
    pub total: i64,
    #[serde(default)]
    pub page: i64,
    #[serde(default)]
    pub page_size: i64,
}

/// 一条 CRM 任务，字段对齐 backend `TaskItem`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskItem {
    pub id: i64,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub due_date: Option<DateTime<Utc>>,
    /// 优先级（high/medium/low）
    pub priority: String,
    /// 状态（pending/in_progress/done/cancelled）
    pub status: String,
    /// 类型（follow_up/call/visit/custom）
    #[serde(default = "default_task_type")]
    pub r#type: String,
    #[serde(default)]
    pub owner_id: Option<String>,
    #[serde(default)]
    pub owner_name: Option<String>,
    #[serde(default)]
    pub customer_id: Option<i64>,
    #[serde(default)]
    pub customer_name: Option<String>,
    #[serde(default)]
    pub lead_id: Option<i64>,
    #[serde(default)]
    pub lead_name: Option<String>,
    #[serde(default)]
    pub completed_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

fn default_task_type() -> String {
    "custom".to_string()
}

impl TaskItem {
    /// 是否在看板三列之一（cancelled 不入看板，对齐 web isBoardStatus）
    pub fn on_board(&self) -> bool {
        matches!(self.status.as_str(), "pending" | "in_progress" | "done")
    }
}

/// 任务分页结果，字段对齐 backend `TaskListResponse`
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TaskPage {
    #[serde(default)]
    pub items: Vec<TaskItem>,
    #[serde(default)]
    pub total: i64,
    #[serde(default)]
    pub page: i64,
    #[serde(default)]
    pub page_size: i64,
}

/// CRM 协作用户（负责人下拉数据源），字段对齐 backend `CrmUserItem`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CrmUser {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub role_type: Option<String>,
    #[serde(default = "default_true_crm")]
    pub is_active: bool,
}

fn default_true_crm() -> bool {
    true
}

// ---------------------------------------------------------------------------
// P9 规则引擎 / 工作流设置（Stage13，BLF-804；对齐 backend
// `RuleItem` / `WorkflowSettings` 与 frontend `lib/crm/types/rule.ts`）
// ---------------------------------------------------------------------------

/// 规则条件行（AND 语义；MVP 白名单字段见 `rule_condition_field_label`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CrmRuleCondition {
    pub id: i64,
    /// 白名单字段：days_since_created / days_since_last_follow /
    /// last_follow_at / status / rating
    pub field: String,
    pub operator: String,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub sort_order: i64,
}

/// 规则动作行（MVP 仅 notify_owner）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CrmRuleAction {
    pub id: i64,
    pub action_type: String,
    #[serde(default)]
    pub params: Option<serde_json::Value>,
    #[serde(default)]
    pub sort_order: i64,
}

/// 一条规则（对齐 backend `RuleItem`，snake_case 原样）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CrmRuleItem {
    pub id: i64,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub entity_type: String,
    pub event_type: String,
    pub enabled: bool,
    #[serde(default)]
    pub priority: i64,
    #[serde(default)]
    pub conditions: Vec<CrmRuleCondition>,
    #[serde(default)]
    pub actions: Vec<CrmRuleAction>,
}

impl CrmRuleItem {
    /// 触发条件中文描述（对齐 web `describeRule` 口径：当… → 提醒负责人）
    pub fn trigger_kind_label(&self) -> String {
        let entity = rule_entity_label(&self.entity_type);
        let mut parts: Vec<String> = Vec::new();
        for cond in &self.conditions {
            match (cond.field.as_str(), cond.operator.as_str()) {
                ("days_since_created", "gte") => {
                    if let Some(v) = &cond.value {
                        parts.push(format!("{}创建超过 {} 天", entity, v));
                    }
                }
                ("days_since_last_follow", "gte") => {
                    if let Some(v) = &cond.value {
                        parts.push(format!("{}超过 {} 天未跟进", entity, v));
                    }
                }
                ("last_follow_at", "is_null") => parts.push("从未跟进".to_string()),
                _ => {}
            }
        }
        if parts.is_empty() {
            format!("{}符合条件", entity)
        } else {
            parts.join(" 且 ")
        }
    }

    /// 执行动作中文摘要（MVP 仅提醒负责人）
    pub fn action_summary(&self) -> String {
        if self
            .actions
            .iter()
            .any(|a| a.action_type == "notify_owner")
        {
            "提醒负责人".to_string()
        } else {
            "自定义动作".to_string()
        }
    }
}

/// 规则作用实体中文标签（未知原样返回）
fn rule_entity_label(entity_type: &str) -> String {
    match entity_type {
        "customer" => "客户".to_string(),
        "lead" => "线索".to_string(),
        other => other.to_string(),
    }
}

/// P9 工作流自动化设置（7 天无跟进提醒邮件；对齐 backend `WorkflowSettings`）
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CrmWorkflowSettings {
    /// 无跟进提醒阈值（天，1~365）
    pub stale_days: i64,
    /// 提醒邮件开关
    pub stale_email_enabled: bool,
}

/// 任务优先级 → 中文标签（对齐 web PRIORITY_LABELS）
pub fn task_priority_label(priority: &str) -> String {
    match priority {
        "high" => "高",
        "medium" => "中",
        "low" => "低",
        _ => return priority.to_string(),
    }
    .to_string()
}

/// 任务类型 key → 中文标签（对齐 web TASK_TYPE_LABELS）
pub fn task_type_label(task_type: &str) -> String {
    match task_type {
        "follow_up" => "跟进",
        "call" => "电话",
        "visit" => "拜访",
        "custom" => "自定义",
        _ => return task_type.to_string(),
    }
    .to_string()
}

/// 任务状态 → 中文标签（对齐 web TASK_STATUS_LABELS）
pub fn task_status_label(status: &str) -> String {
    match status {
        "pending" => "待处理",
        "in_progress" => "进行中",
        "done" => "已完成",
        "cancelled" => "已取消",
        _ => return status.to_string(),
    }
    .to_string()
}

#[cfg(test)]
mod crm_list_tests {    use super::*;

    /// 客户列表 snake_case 解析：可空字段缺省 + 联系人 join 字段
    #[test]
    fn customer_page_parses_snake_case() {
        let payload = r#"{
            "items": [{
                "id": 1,
                "name": "测试客户",
                "rating": "A",
                "status": "active",
                "owner_id": "u-1",
                "owner_name": "张三",
                "contact_name": "李四",
                "created_at": "2026-08-01T10:00:00+08:00",
                "updated_at": "2026-08-20T10:00:00+08:00"
            }],
            "total": 1, "page": 1, "page_size": 20
        }"#;
        let page: CustomerPage = serde_json::from_str(payload).expect("解析失败");
        assert_eq!(page.total, 1);
        let c = &page.items[0];
        assert_eq!(c.rating, "A");
        assert!(!c.is_sea());
        assert_eq!(c.contact_name.as_deref(), Some("李四"));
        assert_eq!(c.industry, None);
    }

    /// 公海判定：owner_id 为 None 即公海
    #[test]
    fn customer_sea_detection() {
        let payload = r#"{
            "items": [{
                "id": 2, "name": "公海客户", "rating": "B", "status": "active",
                "owner_id": null,
                "created_at": "2026-08-01T10:00:00+08:00",
                "updated_at": "2026-08-20T10:00:00+08:00"
            }],
            "total": 1, "page": 1, "page_size": 20
        }"#;
        let page: CustomerPage = serde_json::from_str(payload).unwrap();
        assert!(page.items[0].is_sea());
    }

    /// 线索解析 + 状态/意向标签映射
    #[test]
    fn lead_page_parses_and_labels() {
        let payload = r#"{
            "items": [{
                "id": 5, "name": "线索甲", "company": "甲公司", "status": "new",
                "intent": "high",
                "created_at": "2026-08-01T10:00:00+08:00",
                "updated_at": "2026-08-20T10:00:00+08:00"
            }],
            "total": 1, "page": 1, "page_size": 20
        }"#;
        let page: LeadPage = serde_json::from_str(payload).unwrap();
        assert_eq!(page.items[0].intent, "high");
        assert_eq!(lead_status_label("contacting"), "接触中");
        assert_eq!(lead_status_label("weird"), "weird");
        assert_eq!(lead_intent_label("low"), "低意向");
    }

    /// 任务解析：type 键为 Rust 关键字（r#type）+ 看板归属
    #[test]
    fn task_page_parses_and_board_membership() {
        let payload = r#"{
            "items": [
                {"id": 7, "title": "跟进任务", "priority": "high", "status": "pending",
                 "type": "follow_up",
                 "created_at": "2026-08-01T10:00:00+08:00",
                 "updated_at": "2026-08-20T10:00:00+08:00"},
                {"id": 8, "title": "已取消", "priority": "low", "status": "cancelled",
                 "created_at": "2026-08-01T10:00:00+08:00",
                 "updated_at": "2026-08-20T10:00:00+08:00"}
            ],
            "total": 2, "page": 1, "page_size": 100
        }"#;
        let page: TaskPage = serde_json::from_str(payload).unwrap();
        assert_eq!(page.items[0].r#type, "follow_up");
        assert!(page.items[0].on_board());
        assert!(!page.items[1].on_board(), "cancelled 不入看板");
        assert_eq!(task_status_label("in_progress"), "进行中");
        assert_eq!(task_priority_label("high"), "高");
        assert_eq!(task_type_label("visit"), "拜访");
    }
}
