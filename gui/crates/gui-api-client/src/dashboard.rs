//! Dashboard 相关 API
//!
//! 端点对齐 frontend `app/dashboard/page.tsx`：
//! - `useManagedProjects`           →  `GET /api/v1/projects/managed`
//! - daily-analysis (聚合)          →  `GET /api/v1/daily-analysis/all`
//! - daily-analysis (按国家)        →  `GET /api/v1/daily-analysis/all-countries`

use chrono::NaiveDate;
use gui_domain::{
    common::ManagedProject,
    dashboard::{DailyAnalysisAllCountriesResponse, DailyAnalysisResponse},
};

use crate::client::Client;
use crate::error::ApiError;

impl Client {
    /// 当前用户可管理的项目列表
    pub async fn list_managed_projects(&self) -> Result<Vec<ManagedProject>, ApiError> {
        self.get_json("/api/v1/projects/managed", &[]).await
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
