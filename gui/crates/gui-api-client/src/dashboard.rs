//! Dashboard 相关 API
//!
//! Dashboard 相关 API
//!
//! 端点对齐 frontend `app/dashboard/page.tsx`：
//! - `useManagedProjects`           →  `GET /api/v1/projects/manage`
//! - daily-analysis (聚合)          →  `GET /api/v1/daily-analysis/all`
//! - daily-analysis (按国家)        →  `GET /api/v1/daily-analysis/all-countries`

use chrono::NaiveDate;
use gui_domain::{
    common::ManagedProject,
    dashboard::{DailyAnalysisAllCountriesResponse, DailyAnalysisResponse},
};

use crate::client::Client;
use crate::error::ApiError;

/// `/api/v1/projects/manage`（backend `app/api/v1/endpoints/projects.py` 的路由；
/// 注意是 **manage** 不是 managed——GUI-5 之前的笔误已在此修正）
pub(crate) const MANAGED_PROJECTS_PATH: &str = "/api/v1/projects/manage";

impl Client {
    /// 当前用户可管理的项目列表
    ///
    /// 返回 `ProjectItem` 强类型字段（见 `gui_domain::common::ManagedProject`）。
    pub async fn list_managed_projects(&self) -> Result<Vec<ManagedProject>, ApiError> {
        self.get_json(MANAGED_PROJECTS_PATH, &[]).await
    }

    /// 销售数据聚合（按天 + 项目分解）
    pub async fn daily_analysis_all(
        &self,
        project_ids: &str,         // 逗号分隔，如 "1,2,3"，或 "all"
        country: &str,
        start_date: NaiveDate,
        end_date: NaiveDate,
    ) -> Result<DailyAnalysisResponse, ApiError> {
        let query = [
            ("project_ids", project_ids.to_string()),
            ("country", country.to_string()),
            ("start_date", start_date.to_string()),
            ("end_date", end_date.to_string()),
        ];
        self.get_json("/api/v1/daily-analysis/all", &query).await
    }

    /// 销售数据按国家分布（仅支持单 project_id）
    pub async fn daily_analysis_all_countries(
        &self,
        project_id: i64,
        start_date: NaiveDate,
        end_date: NaiveDate,
    ) -> Result<DailyAnalysisAllCountriesResponse, ApiError> {
        let query = [
            ("project_id", project_id.to_string()),
            ("start_date", start_date.to_string()),
            ("end_date", end_date.to_string()),
        ];
        self.get_json("/api/v1/daily-analysis/all-countries", &query)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 契约测试：项目列表端点路径必须与 backend 实际路由一致
    /// （backend `app/api/v1/endpoints/projects.py`：`/projects/manage`，
    /// frontend `lib/project-client-cache.ts` 也走 `/projects/manage`）。
    /// 曾经误写为 `/projects/managed`（不存在，返回 404），此处锁定防回归。
    #[test]
    fn managed_projects_path_matches_backend_route() {
        assert_eq!(MANAGED_PROJECTS_PATH, "/api/v1/projects/manage");
    }
}
