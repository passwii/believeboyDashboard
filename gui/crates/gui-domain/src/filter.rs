//! 通用筛选值（P5-0 公共基建，BLF-759）
//!
//! 对齐 web 端 `useUrlParam` 筛选模式：一个结构化对象承载「项目 / 国家 / 日期区间」
//! 三类最常用筛选，供 FilterBar 组件（gui-app/widgets/filter_bar.rs）渲染与
//! api-client 模板方法（gui-api-client/query.rs）消费——两端共享同一类型，
//! 保证「筛选 UI 输出」与「HTTP query 参数」一一对应。
//!
//! 约定：
//! - `country` 用 ISO 3166-1 大写码（"US"/"DE"…），与后端 / 广告模块一致；
//! - 日期为闭区间 `[date_from, date_to]`（与后端 `start_date/end_date`、
//!   `date_from/date_to` 契约一致），两值同时存在才构成有效区间；
//! - 空筛选（`is_empty()`）表示「全部」，模板方法不携带任何 query 参数。

use chrono::NaiveDate;

/// 通用筛选值（默认空 = 全部）
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TableFilter {
    /// 项目 ID（`project_id` query 参数；None = 全部项目）
    pub project_id: Option<i64>,
    /// 国家 / 站点码（`country` query 参数；None = 全部站点）
    pub country: Option<String>,
    /// 区间起始（含；`date_from` / `start_date`；None = 不限）
    pub date_from: Option<NaiveDate>,
    /// 区间结束（含；`date_to` / `end_date`；None = 不限）
    pub date_to: Option<NaiveDate>,
}

impl TableFilter {
    /// 是否为空筛选（没有任何过滤条件 = 全部）
    pub fn is_empty(&self) -> bool {
        self.project_id.is_none()
            && self.country.is_none()
            && self.date_from.is_none()
            && self.date_to.is_none()
    }

    /// 是否已构成完整日期区间（起止都存在且起始 ≤ 结束）
    pub fn has_valid_range(&self) -> bool {
        match (self.date_from, self.date_to) {
            (Some(from), Some(to)) => from <= to,
            _ => false,
        }
    }

    /// 转成后端 query 参数（空条件不携带；键与现有模块 / 后端契约一致：
    /// `project_id` / `country` / `date_from` / `date_to`，见 ad_analysis_overview）
    pub fn to_query_params(&self) -> Vec<(&'static str, String)> {
        let mut params = Vec::with_capacity(4);
        if let Some(id) = self.project_id {
            params.push(("project_id", id.to_string()));
        }
        if let Some(country) = &self.country {
            if !country.is_empty() {
                params.push(("country", country.clone()));
            }
        }
        if let Some(from) = self.date_from {
            params.push(("date_from", from.to_string()));
        }
        if let Some(to) = self.date_to {
            params.push(("date_to", to.to_string()));
        }
        params
    }

    /// 构建器：设置项目（None 清除）
    pub fn with_project(mut self, project_id: Option<i64>) -> Self {
        self.project_id = project_id;
        self
    }

    /// 构建器：设置国家（空串按 None 处理）
    pub fn with_country(mut self, country: impl Into<String>) -> Self {
        let country = country.into();
        self.country = (!country.is_empty()).then_some(country);
        self
    }

    /// 构建器：设置日期区间（起止必须同时给，否则视为不限）
    pub fn with_range(mut self, from: Option<NaiveDate>, to: Option<NaiveDate>) -> Self {
        self.date_from = from;
        self.date_to = to;
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    #[test]
    fn default_filter_is_empty() {
        let filter = TableFilter::default();
        assert!(filter.is_empty());
        assert!(filter.to_query_params().is_empty());
        assert!(!filter.has_valid_range());
    }

    #[test]
    fn to_query_params_carries_only_set_fields() {
        let filter = TableFilter::default()
            .with_project(Some(7))
            .with_country("US")
            .with_range(Some(d(2026, 8, 1)), Some(d(2026, 8, 13)));
        let params = filter.to_query_params();
        assert_eq!(
            params,
            vec![
                ("project_id", "7".to_string()),
                ("country", "US".to_string()),
                ("date_from", "2026-08-01".to_string()),
                ("date_to", "2026-08-13".to_string()),
            ]
        );
    }

    #[test]
    fn empty_country_treated_as_none() {
        let filter = TableFilter::default().with_country("");
        assert_eq!(filter.country, None);
        assert!(filter.is_empty());
    }

    #[test]
    fn with_project_none_clears() {
        let filter = TableFilter::default()
            .with_project(Some(3))
            .with_project(None);
        assert_eq!(filter.project_id, None);
    }

    #[test]
    fn range_validity_checks_order() {
        let ok = TableFilter::default().with_range(Some(d(2026, 8, 1)), Some(d(2026, 8, 13)));
        assert!(ok.has_valid_range());
        // 起始 > 结束 → 无效区间
        let reversed = TableFilter::default().with_range(Some(d(2026, 8, 13)), Some(d(2026, 8, 1)));
        assert!(!reversed.has_valid_range());
        // 只给一端 → 不算完整区间
        let half = TableFilter::default().with_range(Some(d(2026, 8, 1)), None);
        assert!(!half.has_valid_range());
    }

    #[test]
    fn partial_date_params_still_serialized() {
        // 只有 date_to（如「截止今天」）也要能携带——to_query_params 只跟随字段有无
        let filter = TableFilter::default().with_range(None, Some(d(2026, 8, 13)));
        let params = filter.to_query_params();
        assert_eq!(params, vec![("date_to", "2026-08-13".to_string())]);
        assert!(!filter.is_empty());
    }
}
