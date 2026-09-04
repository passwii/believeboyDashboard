//! 系统管理 → 日志查看（P5-8，BLF-757）
//!
//! 对齐 web 端 `app/dashboard/system/logs/page.tsx`（约 1184 行）+
//! `components/system/agent-access-logs-panel.tsx` 的三页签只读日志中心：
//! - **操作审计**：`GET /api/v1/system-management/audit-logs`（+ `/summary`），
//!   分类 × 结果双筛选、统计概览、七列表格、分页、详情弹层；
//! - **登录日志**：同端点固定 `action=auth.` 前缀，设备 / IP 列 + 详情弹层；
//! - **Agent 访问**：`GET /api/v1/system-management/agent-access-logs`
//!   （+ `/summary`），方法 × 结果筛选、状态码语义色、耗时数字列。
//!
//! 数据源在 gui-api-client::system_management；域类型与展示辅助
//! （分类归属 / 动作中文标签 / UA 解析 / 相对时间）在 gui_domain::system_management。
//!
//! ## 与 web 端的取舍（issue 允许按 macOS 原生习惯精简并说明）
//!
//! - **保留**：三页签结构、审计分类（全部分类 + 10 分类 + 其他）× 结果双筛选、
//!   统计概览四卡、分类徽标语义色（映射 web badge 色系）、结果成功绿 / 失败红、
//!   Agent 状态码 2xx 绿 / 4xx 琥珀 / 5xx 红分档、20/20/50 分页口径、审计与
//!   登录详情弹层（变更前后 JSON pretty + 失败原因）、加载 / 错误 / 空三态 +
//!   亮暗主题 token + 减弱动态尊重；
//! - **精简**：关键词 / 操作人 / project_id 自由文本检索未迁移（GUI 尚无单行
//!   检索框先例，避免引入 focus / IME 边界；下拉分类 × 方法 × 结果覆盖主要巡检
//!   诉求，后续需要时单独补）；「其他」分类沿用 web 口径在当前页客户端过滤；
//!   Agent 访问行不设详情弹层（关键信息已全部列内呈现）；UA 解析保留 OS /
//!   浏览器二元组，emoji 图标不迁移。

use gpui::prelude::*;
use gpui::{
    div, px, App, Context, Entity, FontWeight, Hsla, IntoElement, ParentElement, Render,
    SharedString, Styled, Window,
};
use gpui_component::button::{Button, ButtonVariants};
use gpui_component::{h_flex, v_flex, Sizable, StyledExt};
use gui_api_client::error::ApiError;
use gui_api_client::Client;
use gui_domain::system_management::{
    format_action_label, format_log_time, format_time_ago, is_other_category,
    operation_category_label, parse_user_agent, target_type_label, AgentAccessLogItem,
    AgentAccessLogsResponse, AgentAccessLogsSummaryResponse, OperationAuditLogItem,
    OperationAuditLogsResponse, OperationAuditLogsSummaryResponse, LOG_CATEGORIES,
};

use crate::theme::AppTheme;
use crate::widgets::data_table::{ColumnDef, DataTable};
use crate::widgets::filter_bar::{filter_bar_layout, filter_select};
use crate::widgets::layout::content_guard;
use crate::widgets::page_header::PageHeader;
use crate::widgets::pagination::{self, PageState};
use crate::widgets::state_views::{self, SkeletonBlock};

/// sidebar「系统管理 → 日志查看」URL（数据权威 gui-domain::sidebar）
pub const SYSTEM_LOGS_URL: &str = "/dashboard/system/logs";

/// 每页行数（对齐 web：审计 / 登录 20 条；Agent 访问面板 50 条）
const AUDIT_PAGE_SIZE: usize = 20;
const AGENT_PAGE_SIZE: usize = 50;

// ---------------------------------------------------------------------------
// 页签 / 筛选模型
// ---------------------------------------------------------------------------

/// 日志页签（对齐 web Tabs：audit / login / agent）
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum LogTab {
    #[default]
    Audit,
    Login,
    Agent,
}

impl LogTab {
    /// 全部页签（顺序对齐 web TabsList）
    pub const ALL: [LogTab; 3] = [LogTab::Audit, LogTab::Login, LogTab::Agent];

    pub fn label(self) -> &'static str {
        match self {
            LogTab::Audit => "操作审计日志",
            LogTab::Login => "登录日志",
            LogTab::Agent => "Agent 访问日志",
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            LogTab::Audit => "audit",
            LogTab::Login => "login",
            LogTab::Agent => "agent",
        }
    }

    /// 空态图标 / 文案（每页签独立）
    fn empty_copy(self) -> (&'static str, &'static str) {
        match self {
            LogTab::Audit => ("icons/history.svg", "暂无日志"),
            LogTab::Login => ("icons/users.svg", "暂无登录记录"),
            LogTab::Agent => ("icons/zap.svg", "暂无访问记录"),
        }
    }
}

/// 审计分类筛选（`All` = 全部分类；`Known(key)` = LOG_CATEGORIES 内 key；
/// `Other` = 其他——后端无反向前缀参数，当前页客户端过滤，对齐 web）
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum CategoryFilter {
    #[default]
    All,
    Known(&'static str),
    Other,
}

impl CategoryFilter {
    /// query 参数值（`None` = 不带 action；Other 无对应参数）
    pub fn as_query(self) -> Option<&'static str> {
        match self {
            CategoryFilter::All | CategoryFilter::Other => None,
            CategoryFilter::Known(key) => gui_domain::system_management::category_action_query(key),
        }
    }

    /// 下拉按钮当前文案
    pub fn label(self) -> &'static str {
        match self {
            CategoryFilter::All => "全部分类",
            CategoryFilter::Other => "其他",
            CategoryFilter::Known(key) => category_label_by_key(key),
        }
    }

    /// 行动作是否落在该档（Other 档走「无前缀命中」判定）
    #[allow(dead_code)]
    pub fn matches_row(self, action: &str) -> bool {
        match self {
            CategoryFilter::All => true,
            CategoryFilter::Other => is_other_category(action),
            CategoryFilter::Known(key) => {
                operation_category_label(action) == category_label_by_key(key)
            }
        }
    }
}

/// key → 分类中文标签（LOG_CATEGORIES 查表；未知 key 兜底「其他」）
fn category_label_by_key(key: &str) -> &'static str {
    LOG_CATEGORIES
        .iter()
        .find(|(k, _, _)| *k == key)
        .map(|(_, l, _)| *l)
        .unwrap_or("其他")
}

/// 审计结果筛选（backend `result` 参数精确匹配 success / failure）
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum AuditResultFilter {
    #[default]
    All,
    Success,
    Failure,
}

impl AuditResultFilter {
    pub const ALL: [AuditResultFilter; 3] = [
        AuditResultFilter::All,
        AuditResultFilter::Success,
        AuditResultFilter::Failure,
    ];

    pub fn as_query(self) -> Option<&'static str> {
        match self {
            AuditResultFilter::All => None,
            AuditResultFilter::Success => Some("success"),
            AuditResultFilter::Failure => Some("failure"),
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            AuditResultFilter::All => "全部结果",
            AuditResultFilter::Success => "仅成功",
            AuditResultFilter::Failure => "仅失败",
        }
    }
}

/// Agent 访问结果筛选（web 面板口径：success = 2xx，error = ≥400）
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum AgentResultFilter {
    #[default]
    All,
    Success,
    Error,
}

impl AgentResultFilter {
    pub const ALL: [AgentResultFilter; 3] = [
        AgentResultFilter::All,
        AgentResultFilter::Success,
        AgentResultFilter::Error,
    ];

    pub fn as_query(self) -> Option<&'static str> {
        match self {
            AgentResultFilter::All => None,
            AgentResultFilter::Success => Some("success"),
            AgentResultFilter::Error => Some("error"),
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            AgentResultFilter::All => "全部结果",
            AgentResultFilter::Success => "仅成功",
            AgentResultFilter::Error => "仅错误",
        }
    }
}

/// HTTP 方法筛选（Agent 访问面板）
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum MethodFilter {
    #[default]
    All,
    Get,
    Post,
    Put,
    Patch,
    Delete,
}

impl MethodFilter {
    pub const ALL: [MethodFilter; 6] = [
        MethodFilter::All,
        MethodFilter::Get,
        MethodFilter::Post,
        MethodFilter::Put,
        MethodFilter::Patch,
        MethodFilter::Delete,
    ];

    pub fn as_query(self) -> Option<&'static str> {
        match self {
            MethodFilter::All => None,
            MethodFilter::Get => Some("GET"),
            MethodFilter::Post => Some("POST"),
            MethodFilter::Put => Some("PUT"),
            MethodFilter::Patch => Some("PATCH"),
            MethodFilter::Delete => Some("DELETE"),
        }
    }

    pub fn label(self) -> String {
        match self {
            MethodFilter::All => "全部方法".to_string(),
            other => other.as_query().unwrap_or_default().to_string(),
        }
    }
}

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

/// 单页签拉取阶段（对齐既有业务视图约定）
#[derive(Debug, Clone, PartialEq)]
pub enum FetchPhase {
    /// 首屏 / 刷新中
    Loading,
    /// 数据就绪
    Loaded,
    /// 当前筛选 + 页下无记录
    Empty,
    /// 请求失败（携带用户可读消息）
    Error(String),
}

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

/// 日志查看视图（三页签 + 双筛选 + 统计卡 + 表格 + 分页 + 详情弹层；
/// 各页签独立请求竞态保护，切页签即重拉对齐 web useEffect 行为）
pub struct SystemLogsView {
    client: Client,
    tab: LogTab,

    // ---- 操作审计 ----
    audit_phase: FetchPhase,
    audit_summary: Option<OperationAuditLogsSummaryResponse>,
    audit_total: usize,
    audit_page: usize,
    audit_category: CategoryFilter,
    audit_result: AuditResultFilter,
    audit_request_id: u64,
    audit_table: Entity<DataTable<OperationAuditLogItem>>,
    /// 详情弹层（审计行）
    audit_detail: Option<OperationAuditLogItem>,

    // ---- 登录日志 ----
    login_phase: FetchPhase,
    login_summary: Option<OperationAuditLogsSummaryResponse>,
    login_total: usize,
    login_page: usize,
    login_request_id: u64,
    login_table: Entity<DataTable<OperationAuditLogItem>>,
    /// 详情弹层（登录行）
    login_detail: Option<OperationAuditLogItem>,

    // ---- Agent 访问 ----
    agent_phase: FetchPhase,
    agent_summary: Option<AgentAccessLogsSummaryResponse>,
    agent_total: usize,
    agent_page: usize,
    agent_result: AgentResultFilter,
    agent_method: MethodFilter,
    agent_request_id: u64,
    agent_table: Entity<DataTable<AgentAccessLogItem>>,
}

impl SystemLogsView {
    /// 新建视图：初始 Loading，由 root.rs 懒创建后触发 `reload()`
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        // 详情按钮单元格需要回写视图实体：cx.entity() 在构造期即可取
        let view = cx.entity();
        let audit_table = cx.new(|_| {
            DataTable::new("system-logs-audit-table", audit_columns(view.clone()))
                .striped(true)
                .empty_text("暂无日志")
        });
        let login_table = cx.new(|_| {
            DataTable::new("system-logs-login-table", login_columns(view.clone()))
                .striped(true)
                .empty_text("暂无登录记录")
        });
        let agent_table = cx.new(|_| {
            DataTable::new("system-logs-agent-table", agent_columns())
                .striped(true)
                .empty_text("暂无访问记录")
        });
        Self {
            client,
            tab: LogTab::Audit,
            audit_phase: FetchPhase::Loading,
            audit_summary: None,
            audit_total: 0,
            audit_page: 1,
            audit_category: CategoryFilter::All,
            audit_result: AuditResultFilter::All,
            audit_request_id: 0,
            audit_table,
            audit_detail: None,
            login_phase: FetchPhase::Loading,
            login_summary: None,
            login_total: 0,
            login_page: 1,
            login_request_id: 0,
            login_table,
            login_detail: None,
            agent_phase: FetchPhase::Loading,
            agent_summary: None,
            agent_total: 0,
            agent_page: 1,
            agent_result: AgentResultFilter::All,
            agent_method: MethodFilter::All,
            agent_request_id: 0,
            agent_table,
        }
    }

    /// 当前页签拉取阶段（只读，测试用）
    #[allow(dead_code)]
    pub fn phase(&self, tab: LogTab) -> &FetchPhase {
        match tab {
            LogTab::Audit => &self.audit_phase,
            LogTab::Login => &self.login_phase,
            LogTab::Agent => &self.agent_phase,
        }
    }

    /// 当前页签与审计筛选快照（只读，测试用）
    #[allow(dead_code)]
    pub fn current_filters(&self) -> (LogTab, CategoryFilter, AuditResultFilter, usize) {
        (
            self.tab,
            self.audit_category,
            self.audit_result,
            self.audit_page,
        )
    }

    /// 当前页签行数快照（只读，测试用）
    #[allow(dead_code)]
    pub fn table_len(&self, cx: &App, tab: LogTab) -> usize {
        match tab {
            LogTab::Audit => self.audit_table.read(cx).rows().len(),
            LogTab::Login => self.login_table.read(cx).rows().len(),
            LogTab::Agent => self.agent_table.read(cx).rows().len(),
        }
    }

    /// 重新拉取当前页签（首屏 / 错误重试 / 空态刷新共用；竞态保护：
    /// 递增对应页签 request_id 并进入 Loading）
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        match self.tab {
            LogTab::Audit => self.reload_audit(cx),
            LogTab::Login => self.reload_login(cx),
            LogTab::Agent => self.reload_agent(cx),
        }
    }

    /// 切换页签并重拉该页签数据（同页签 no-op；关闭遗留详情弹层）
    pub fn set_tab(&mut self, tab: LogTab, cx: &mut Context<Self>) {
        if self.tab == tab {
            return;
        }
        self.tab = tab;
        self.audit_detail = None;
        self.login_detail = None;
        self.reload(cx);
    }

    /// 切换审计分类（回第 1 页重拉；同档 no-op）
    pub fn set_audit_category(&mut self, filter: CategoryFilter, cx: &mut Context<Self>) {
        if self.audit_category == filter {
            return;
        }
        self.audit_category = filter;
        self.audit_page = 1;
        self.reload_audit(cx);
    }

    /// 切换审计结果筛选（回第 1 页重拉；同档 no-op）
    pub fn set_audit_result(&mut self, filter: AuditResultFilter, cx: &mut Context<Self>) {
        if self.audit_result == filter {
            return;
        }
        self.audit_result = filter;
        self.audit_page = 1;
        self.reload_audit(cx);
    }

    /// 重置审计筛选（对齐 web resetFilters：全部分类 + 全部结果 + 回第 1 页）
    pub fn reset_audit_filters(&mut self, cx: &mut Context<Self>) {
        if self.audit_category == CategoryFilter::All
            && self.audit_result == AuditResultFilter::All
            && self.audit_page == 1
        {
            return;
        }
        self.audit_category = CategoryFilter::All;
        self.audit_result = AuditResultFilter::All;
        self.audit_page = 1;
        self.reload_audit(cx);
    }

    /// 审计页翻页（非法页号 / 同页 no-op）
    pub fn go_to_audit_page(&mut self, page: usize, cx: &mut Context<Self>) {
        if self.audit_page == page || page < 1 {
            return;
        }
        self.audit_page = page;
        self.reload_audit(cx);
    }

    /// 登录页翻页（非法页号 / 同页 no-op）
    pub fn go_to_login_page(&mut self, page: usize, cx: &mut Context<Self>) {
        if self.login_page == page || page < 1 {
            return;
        }
        self.login_page = page;
        self.reload_login(cx);
    }

    /// 切换 Agent 结果筛选（回第 1 页重拉；同档 no-op）
    pub fn set_agent_result(&mut self, filter: AgentResultFilter, cx: &mut Context<Self>) {
        if self.agent_result == filter {
            return;
        }
        self.agent_result = filter;
        self.agent_page = 1;
        self.reload_agent(cx);
    }

    /// 切换 Agent 方法筛选（回第 1 页重拉；同档 no-op）
    pub fn set_agent_method(&mut self, filter: MethodFilter, cx: &mut Context<Self>) {
        if self.agent_method == filter {
            return;
        }
        self.agent_method = filter;
        self.agent_page = 1;
        self.reload_agent(cx);
    }

    /// Agent 页翻页（非法页号 / 同页 no-op）
    pub fn go_to_agent_page(&mut self, page: usize, cx: &mut Context<Self>) {
        if self.agent_page == page || page < 1 {
            return;
        }
        self.agent_page = page;
        self.reload_agent(cx);
    }

    /// 打开审计详情弹层
    pub fn open_audit_detail(&mut self, row: OperationAuditLogItem, cx: &mut Context<Self>) {
        self.login_detail = None;
        self.audit_detail = Some(row);
        cx.notify();
    }

    /// 打开登录详情弹层
    pub fn open_login_detail(&mut self, row: OperationAuditLogItem, cx: &mut Context<Self>) {
        self.audit_detail = None;
        self.login_detail = Some(row);
        cx.notify();
    }

    /// 关闭全部详情弹层（无弹层时 no-op）
    pub fn close_details(&mut self, cx: &mut Context<Self>) {
        if self.audit_detail.is_some() || self.login_detail.is_some() {
            self.audit_detail = None;
            self.login_detail = None;
            cx.notify();
        }
    }

    // ---- 拉取管线（竞态保护 + reqwest 走应用级 runtime block_on）----

    fn reload_audit(&mut self, cx: &mut Context<Self>) {
        self.audit_request_id = self.audit_request_id.wrapping_add(1);
        let request_id = self.audit_request_id;
        self.audit_phase = FetchPhase::Loading;

        let client = self.client.clone();
        let action = self.audit_category.as_query().map(str::to_string);
        let result = self.audit_result.as_query().map(str::to_string);
        let page = self.audit_page.max(1);
        let bg = cx.background_executor().clone();
        cx.spawn(
            async move |this: gpui::WeakEntity<Self>, cx: &mut gpui::AsyncApp| {
                let fetched = bg
                    .spawn(async move {
                        crate::runtime::runtime().block_on(async {
                            let logs = client
                                .system_audit_logs(
                                    None,
                                    action.as_deref(),
                                    None,
                                    page,
                                    AUDIT_PAGE_SIZE,
                                )
                                .await?;
                            let summary = client
                                .system_audit_logs_summary(
                                    None,
                                    action.as_deref(),
                                    result.as_deref(),
                                )
                                .await?;
                            Ok((logs, summary))
                        })
                    })
                    .await;
                this.update(&mut *cx, |this, cx| {
                    this.apply_audit_result(request_id, fetched, cx);
                })
                .ok();
            },
        )
        .detach();
        cx.notify();
    }

    /// 应用审计拉取结果（竞态保护）：落阶段 + 注入表格行 + 更新汇总
    fn apply_audit_result(
        &mut self,
        request_id: u64,
        result: Result<
            (
                OperationAuditLogsResponse,
                OperationAuditLogsSummaryResponse,
            ),
            ApiError,
        >,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.audit_request_id {
            return; // 过期响应，丢弃
        }
        match result {
            Ok((page, summary)) => {
                let mut rows = page.items;
                // 「其他」分类无后端反向前缀参数：当前页客户端过滤（对齐 web）
                if self.audit_category == CategoryFilter::Other {
                    rows.retain(|row| is_other_category(&row.action));
                }
                let has_rows = !rows.is_empty();
                self.audit_phase = match has_rows {
                    true => FetchPhase::Loaded,
                    false => FetchPhase::Empty,
                };
                self.audit_total = page.total.max(0) as usize;
                self.audit_summary = Some(summary);
                self.audit_table
                    .update(cx, |table, cx| table.set_rows(rows, cx));
            }
            Err(err) => {
                self.audit_phase = FetchPhase::Error(err.user_message());
            }
        }
        cx.notify();
    }

    fn reload_login(&mut self, cx: &mut Context<Self>) {
        self.login_request_id = self.login_request_id.wrapping_add(1);
        let request_id = self.login_request_id;
        self.login_phase = FetchPhase::Loading;

        let client = self.client.clone();
        let page = self.login_page.max(1);
        let bg = cx.background_executor().clone();
        cx.spawn(
            async move |this: gpui::WeakEntity<Self>, cx: &mut gpui::AsyncApp| {
                let fetched = bg
                    .spawn(async move {
                        crate::runtime::runtime().block_on(async {
                            let logs = client
                                .system_audit_logs(None, Some("auth."), None, page, AUDIT_PAGE_SIZE)
                                .await?;
                            let summary = client
                                .system_audit_logs_summary(None, Some("auth."), None)
                                .await?;
                            Ok((logs, summary))
                        })
                    })
                    .await;
                this.update(&mut *cx, |this, cx| {
                    this.apply_login_result(request_id, fetched, cx);
                })
                .ok();
            },
        )
        .detach();
        cx.notify();
    }

    fn apply_login_result(
        &mut self,
        request_id: u64,
        result: Result<
            (
                OperationAuditLogsResponse,
                OperationAuditLogsSummaryResponse,
            ),
            ApiError,
        >,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.login_request_id {
            return;
        }
        match result {
            Ok((page, summary)) => {
                let has_rows = !page.items.is_empty();
                self.login_phase = match has_rows {
                    true => FetchPhase::Loaded,
                    false => FetchPhase::Empty,
                };
                self.login_total = page.total.max(0) as usize;
                self.login_summary = Some(summary);
                self.login_table
                    .update(cx, |table, cx| table.set_rows(page.items, cx));
            }
            Err(err) => {
                self.login_phase = FetchPhase::Error(err.user_message());
            }
        }
        cx.notify();
    }

    fn reload_agent(&mut self, cx: &mut Context<Self>) {
        self.agent_request_id = self.agent_request_id.wrapping_add(1);
        let request_id = self.agent_request_id;
        self.agent_phase = FetchPhase::Loading;

        let client = self.client.clone();
        let method = self.agent_method.as_query().map(str::to_string);
        let result = self.agent_result.as_query().map(str::to_string);
        let page = self.agent_page.max(1);
        let bg = cx.background_executor().clone();
        cx.spawn(
            async move |this: gpui::WeakEntity<Self>, cx: &mut gpui::AsyncApp| {
                let fetched = bg
                    .spawn(async move {
                        crate::runtime::runtime().block_on(async {
                            let logs = client
                                .agent_access_logs(
                                    None,
                                    method.as_deref(),
                                    result.as_deref(),
                                    page,
                                    AGENT_PAGE_SIZE,
                                )
                                .await?;
                            let summary = client
                                .agent_access_logs_summary(
                                    None,
                                    method.as_deref(),
                                    result.as_deref(),
                                )
                                .await?;
                            Ok((logs, summary))
                        })
                    })
                    .await;
                this.update(&mut *cx, |this, cx| {
                    this.apply_agent_result(request_id, fetched, cx);
                })
                .ok();
            },
        )
        .detach();
        cx.notify();
    }

    fn apply_agent_result(
        &mut self,
        request_id: u64,
        result: Result<(AgentAccessLogsResponse, AgentAccessLogsSummaryResponse), ApiError>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.agent_request_id {
            return;
        }
        match result {
            Ok((page, summary)) => {
                let has_rows = !page.items.is_empty();
                self.agent_phase = match has_rows {
                    true => FetchPhase::Loaded,
                    false => FetchPhase::Empty,
                };
                self.agent_total = page.total.max(0) as usize;
                self.agent_summary = Some(summary);
                self.agent_table
                    .update(cx, |table, cx| table.set_rows(page.items, cx));
            }
            Err(err) => {
                self.agent_phase = FetchPhase::Error(err.user_message());
            }
        }
        cx.notify();
    }
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

impl Render for SystemLogsView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let app_theme = AppTheme::current(cx);
        let view = cx.entity();
        let view_for_modal = view.clone();
        let reduce = crate::motion::reduce_motion(cx);

        v_flex()
            .id("system-logs")
            .size_full()
            .gap_4()
            .p_6()
            .overflow_y_scroll()
            .bg(app_theme.window_bg)
            .child(
                PageHeader::new("日志查看").subtitle("操作审计 / 登录 / Agent 访问的全量留痕检索"),
            )
            .child(tab_bar(view.clone(), self.tab))
            .child(match self.tab {
                LogTab::Audit => render_tab_body(
                    &view,
                    &app_theme,
                    reduce,
                    LogTab::Audit,
                    &self.audit_phase,
                    self.audit_table.clone(),
                    audit_filter_bar(
                        view.clone(),
                        self.audit_category,
                        self.audit_result,
                        &app_theme,
                    ),
                    self.audit_page,
                    AUDIT_PAGE_SIZE,
                    self.audit_total,
                    summary_cards_audit(&self.audit_summary, &app_theme),
                    |this, page, cx| this.go_to_audit_page(page, cx),
                ),
                LogTab::Login => render_tab_body(
                    &view,
                    &app_theme,
                    reduce,
                    LogTab::Login,
                    &self.login_phase,
                    self.login_table.clone(),
                    filter_bar_layout(&app_theme).into_any_element(),
                    self.login_page,
                    AUDIT_PAGE_SIZE,
                    self.login_total,
                    summary_cards_login(&self.login_summary, &app_theme),
                    |this, page, cx| this.go_to_login_page(page, cx),
                ),
                LogTab::Agent => render_tab_body(
                    &view,
                    &app_theme,
                    reduce,
                    LogTab::Agent,
                    &self.agent_phase,
                    self.agent_table.clone(),
                    agent_filter_bar(
                        view.clone(),
                        self.agent_method,
                        self.agent_result,
                        &app_theme,
                    ),
                    self.agent_page,
                    AGENT_PAGE_SIZE,
                    self.agent_total,
                    summary_cards_agent(&self.agent_summary, &app_theme),
                    |this, page, cx| this.go_to_agent_page(page, cx),
                ),
            })
            // 详情弹层（绝对覆盖层，最上层；对齐 project_goals 模态范式）
            .when(
                self.audit_detail.is_some() || self.login_detail.is_some(),
                |this| {
                    this.child(render_modal_overlay(
                        view_for_modal,
                        self.audit_detail.clone(),
                        self.login_detail.clone(),
                        &app_theme,
                    ))
                },
            )
    }
}

/// 三页签切换条（激活 primary / 其余 outline；切页签即重拉对齐 web）
fn tab_bar(view: Entity<SystemLogsView>, active: LogTab) -> gpui::AnyElement {
    h_flex()
        .id("system-logs-tabs")
        .gap_2()
        .children(LogTab::ALL.map(move |tab| {
            let view = view.clone();
            Button::new(SharedString::from(format!("system-logs-tab-{}", tab.id())))
                .when(tab == active, |b| b.primary())
                .when(tab != active, |b| b.outline())
                .small()
                .label(tab.label())
                .on_click(move |_, _, cx| {
                    view.update(cx, |this, cx| this.set_tab(tab, cx));
                })
        }))
        .into_any_element()
}

/// 审计筛选栏：分类下拉 × 结果下拉 × 重置按钮（置于统计卡与表格之间）
fn audit_filter_bar(
    view: Entity<SystemLogsView>,
    category: CategoryFilter,
    result: AuditResultFilter,
    theme: &AppTheme,
) -> gpui::AnyElement {
    let view_for_category = view.clone();
    let view_for_result = view.clone();
    let view_for_reset = view.clone();
    let mut bar = filter_bar_layout(theme);
    bar = bar.child(filter_select(
        theme,
        "分类",
        SharedString::from(category.label()),
        "system-logs-category-filter",
        move |menu, _w, _cx| build_category_menu(menu, view_for_category.clone(), category),
    ));
    bar = bar.child(filter_select(
        theme,
        "结果",
        SharedString::from(result.label()),
        "system-logs-result-filter",
        move |menu, _w, _cx| {
            let mut menu = menu;
            for option in AuditResultFilter::ALL {
                let v = view_for_result.clone();
                menu = menu.item(
                    gpui_component::menu::PopupMenuItem::new(option.label())
                        .checked(option == result)
                        .on_click(move |_ev, _w, cx| {
                            v.update(cx, |this, cx| this.set_audit_result(option, cx));
                        }),
                );
            }
            menu
        },
    ));
    bar.child(
        Button::new("system-logs-filter-reset")
            .outline()
            .small()
            .label("重置")
            .on_click(move |_ev, _w, cx| {
                view_for_reset.update(cx, |this, cx| this.reset_audit_filters(cx));
            }),
    )
    .into_any_element()
}

/// 分类菜单构建：全部分类 → 10 个已知分类 → 其他
fn build_category_menu(
    menu: gpui_component::menu::PopupMenu,
    view: Entity<SystemLogsView>,
    current: CategoryFilter,
) -> gpui_component::menu::PopupMenu {
    let mut menu = menu;
    menu = menu.item(
        gpui_component::menu::PopupMenuItem::new(CategoryFilter::All.label())
            .checked(current == CategoryFilter::All)
            .on_click({
                let view = view.clone();
                move |_ev, _w, cx| {
                    view.update(cx, |this, cx| {
                        this.set_audit_category(CategoryFilter::All, cx)
                    });
                }
            }),
    );
    for (key, label, _) in LOG_CATEGORIES {
        let option = CategoryFilter::Known(key);
        let checked = current == option;
        let view = view.clone();
        menu = menu.item(
            gpui_component::menu::PopupMenuItem::new(*label)
                .checked(checked)
                .on_click(move |_ev, _w, cx| {
                    view.update(cx, |this, cx| this.set_audit_category(option, cx));
                }),
        );
    }
    menu.item(
        gpui_component::menu::PopupMenuItem::new(CategoryFilter::Other.label())
            .checked(current == CategoryFilter::Other)
            .on_click(move |_ev, _w, cx| {
                view.update(cx, |this, cx| {
                    this.set_audit_category(CategoryFilter::Other, cx)
                });
            }),
    )
}

/// Agent 筛选栏：结果下拉 × 方法下拉
fn agent_filter_bar(
    view: Entity<SystemLogsView>,
    method: MethodFilter,
    result: AgentResultFilter,
    theme: &AppTheme,
) -> gpui::AnyElement {
    let view_for_result = view.clone();
    let view_for_method = view.clone();
    let mut bar = filter_bar_layout(theme);
    bar = bar.child(filter_select(
        theme,
        "结果",
        SharedString::from(result.label()),
        "system-logs-agent-result-filter",
        move |menu, _w, _cx| {
            let mut menu = menu;
            for option in AgentResultFilter::ALL {
                let v = view_for_result.clone();
                menu = menu.item(
                    gpui_component::menu::PopupMenuItem::new(option.label())
                        .checked(option == result)
                        .on_click(move |_ev, _w, cx| {
                            v.update(cx, |this, cx| this.set_agent_result(option, cx));
                        }),
                );
            }
            menu
        },
    ));
    bar.child(filter_select(
        theme,
        "方法",
        SharedString::from(method.label()),
        "system-logs-agent-method-filter",
        move |menu, _w, _cx| {
            let mut menu = menu;
            for option in MethodFilter::ALL {
                let v = view_for_method.clone();
                menu = menu.item(
                    gpui_component::menu::PopupMenuItem::new(option.label())
                        .checked(option == method)
                        .on_click(move |_ev, _w, cx| {
                            v.update(cx, |this, cx| this.set_agent_method(option, cx));
                        }),
                );
            }
            menu
        },
    ))
    .into_any_element()
}

/// 单页签主体：按拉取阶段分发加载 / 错误 / 空 / 就绪；就绪态 = 统计卡 +
/// 表格卡 + 分页条 + 行数脚注（enter_fade_in，减弱动态瞬时）
#[allow(clippy::too_many_arguments)]
fn render_tab_body<T: Clone + PartialEq + 'static>(
    view: &Entity<SystemLogsView>,
    theme: &AppTheme,
    reduce: bool,
    tab: LogTab,
    phase: &FetchPhase,
    table: Entity<DataTable<T>>,
    filter_bar: gpui::AnyElement,
    page: usize,
    page_size: usize,
    total: usize,
    cards: gpui::AnyElement,
    on_page: fn(&mut SystemLogsView, usize, &mut Context<SystemLogsView>),
) -> gpui::AnyElement {
    let tab_id = tab.id();
    // 每页签固定 element id（error_state / empty_state / pagination 要求
    // &'static str；三页签枚举有限，直接查表避免渲染期分配）
    let (error_id, empty_id, pagination_id) = match tab {
        LogTab::Audit => (
            "system-logs-audit-error",
            "system-logs-audit-empty",
            "system-logs-audit-pagination",
        ),
        LogTab::Login => (
            "system-logs-login-error",
            "system-logs-login-empty",
            "system-logs-login-pagination",
        ),
        LogTab::Agent => (
            "system-logs-agent-error",
            "system-logs-agent-empty",
            "system-logs-agent-pagination",
        ),
    };
    let _ = tab_id;
    match phase {
        FetchPhase::Loading => {
            state_views::skeleton_loading(theme, &[SkeletonBlock::Table(240.0)]).into_any_element()
        }
        FetchPhase::Error(message) => state_views::error_state(
            view,
            theme,
            error_id,
            format!("{}加载失败", tab.label()),
            message.clone(),
            |this, cx| this.reload(cx),
        )
        .into_any_element(),
        FetchPhase::Empty => {
            let (icon, text) = tab.empty_copy();
            state_views::empty_state_with_action(
                view,
                theme,
                empty_id,
                icon,
                text,
                "刷新",
                |this, cx| this.reload(cx),
            )
            .into_any_element()
        }
        FetchPhase::Loaded => {
            let page_state = PageState::new(page, page_size.max(1), total);
            let view_for_pagination = view.clone();
            crate::motion::enter_fade_in(
                SharedString::from(format!("system-logs-{tab_id}-loaded-fade")),
                content_guard().child(
                    v_flex()
                        .id(SharedString::from(format!(
                            "system-logs-{tab_id}-loaded"
                        )))
                        .gap_3()
                        .child(cards)
                        .child(content_guard().child(filter_bar))
                        .child(content_guard().child(
                            v_flex()
                                .w_full()
                                .rounded(px(theme.radius_lg))
                                .border_1()
                                .border_color(theme.separator.opacity(0.6))
                                .bg(theme.card_bg)
                                .shadow(vec![theme.card_shadow_box()])
                                .child(div().w_full().px_4().py_2().child(table))
                                .child(div().w_full().px_4().py_2().child(
                                    pagination::pagination_bar(
                                        &view_for_pagination,
                                        theme,
                                        pagination_id,
                                        &page_state,
                                        &[page_size],
                                        on_page,
                                        |_: &mut SystemLogsView,
                                         _: usize,
                                         _: &mut Context<SystemLogsView>| {},
                                    ),
                                ))
                                .child(
                                    div()
                                        .px_4()
                                        .pb_2()
                                        .text_xs()
                                        .text_color(theme.text_muted)
                                        .child(SharedString::from(format!(
                                            "共 {total} 条记录 · 每页 {page_size} 条"
                                        ))),
                                ),
                        )),
                ),
                reduce,
            )
            .into_any_element()
        }
    }
}

// ---------------------------------------------------------------------------
// 统计概览卡
// ---------------------------------------------------------------------------

/// 统计数字带（label + value 卡片；对齐 commission::stat_cards 观感）
fn stat_cards(
    prefix: &'static str,
    cards: Vec<(&'static str, String, Option<Hsla>)>,
    theme: &AppTheme,
) -> gpui::AnyElement {
    h_flex()
        .id(SharedString::from(format!("system-logs-{prefix}-stats")))
        .gap_3()
        .flex_wrap()
        .children(cards.into_iter().map(|(label, value, color)| {
            v_flex()
                .id(SharedString::from(format!(
                    "system-logs-{prefix}-stat-{label}"
                )))
                .flex_1()
                .min_w_40()
                .gap_1p5()
                .p_3()
                .rounded(px(theme.radius_lg))
                .bg(theme.card_bg)
                .shadow(vec![theme.card_shadow_box()])
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.text_muted)
                        .child(label.to_string()),
                )
                .child(
                    div()
                        .text_lg()
                        .font_semibold()
                        .text_color(color.unwrap_or(theme.text_primary))
                        .truncate()
                        .child(value),
                )
        }))
        .into_any_element()
}

/// 审计统计卡（总量 / 成功 / 失败 / 活跃操作人；对齐 web DataTableCardStatBar）
fn summary_cards_audit(
    summary: &Option<OperationAuditLogsSummaryResponse>,
    theme: &AppTheme,
) -> gpui::AnyElement {
    let (total, success, failure, operators) = summary.as_ref().map_or((0, 0, 0, 0), |s| {
        (
            s.total,
            s.success_count,
            s.failure_count,
            s.unique_operator_count,
        )
    });
    stat_cards(
        "audit",
        vec![
            ("日志总量", total.to_string(), None),
            ("成功反馈", success.to_string(), Some(theme.success)),
            ("失败反馈", failure.to_string(), Some(theme.danger)),
            ("活跃操作人", operators.to_string(), Some(theme.accent)),
        ],
        theme,
    )
}

/// 登录统计卡（总次数 / 成功 / 失败 / 活跃用户）
fn summary_cards_login(
    summary: &Option<OperationAuditLogsSummaryResponse>,
    theme: &AppTheme,
) -> gpui::AnyElement {
    let (total, success, failure, users) = summary.as_ref().map_or((0, 0, 0, 0), |s| {
        (
            s.total,
            s.success_count,
            s.failure_count,
            s.unique_operator_count,
        )
    });
    stat_cards(
        "login",
        vec![
            ("登录总次数", total.to_string(), None),
            ("登录成功", success.to_string(), Some(theme.success)),
            ("登录失败", failure.to_string(), Some(theme.danger)),
            ("活跃用户", users.to_string(), Some(theme.accent)),
        ],
        theme,
    )
}

/// Agent 访问统计卡（总量 / 成功 / 错误 / 活跃 Agent）
fn summary_cards_agent(
    summary: &Option<AgentAccessLogsSummaryResponse>,
    theme: &AppTheme,
) -> gpui::AnyElement {
    let (total, success, errors, agents) = summary.as_ref().map_or((0, 0, 0, 0), |s| {
        (
            s.total,
            s.success_count,
            s.error_count,
            s.unique_agent_count,
        )
    });
    stat_cards(
        "agent",
        vec![
            ("访问总量", total.to_string(), None),
            ("成功请求", success.to_string(), Some(theme.success)),
            ("错误请求", errors.to_string(), Some(theme.danger)),
            ("活跃 Agent", agents.to_string(), Some(theme.accent)),
        ],
        theme,
    )
}

// ---------------------------------------------------------------------------
// 徽标 / 单元格渲染
// ---------------------------------------------------------------------------

/// 软底 pill（对齐 crm_audit::action_pill 观感）
fn pill(text: String, bg: Hsla, fg: Hsla) -> gpui::AnyElement {
    h_flex()
        .items_center()
        .rounded_full()
        .px_2()
        .py_0p5()
        .bg(bg)
        .child(
            div()
                .text_xs()
                .font_weight(FontWeight::MEDIUM)
                .text_color(fg)
                .truncate()
                .child(text),
        )
        .into_any_element()
}

/// 分类徽标配色（映射 web CATEGORY_OPTIONS badge 色系到主题语义色；
/// GUI 调色板有限，report 与 shipment 共用琥珀、system/other 共用中性灰）
fn category_pill_colors(label: &str, theme: &AppTheme) -> (Hsla, Hsla) {
    let accent = match label {
        "提成与绩效" => theme.chart_primary,
        "发货管理" | "报表中心" => theme.warning,
        "SKU资料" => theme.chart_secondary,
        "项目资料" => theme.success,
        "账号权限" => theme.danger,
        "用户登录" => theme.accent,
        "库存补货" => theme.chart_tertiary,
        _ => theme.text_secondary,
    };
    (accent.opacity(0.12), accent)
}

/// 审计结果徽标（success 绿 / 其余红——后端仅 success/failure 两值，
/// 对齐 web getResultMeta 兜底口径）
fn result_pill_colors(result: &str, theme: &AppTheme) -> (Hsla, Hsla) {
    if result == "failure" {
        (theme.danger_soft, theme.danger)
    } else {
        (theme.success_soft, theme.success)
    }
}

/// 结果徽标文案（success/failure 二值兜底「成功」）
fn result_label(result: &str) -> &'static str {
    if result == "failure" {
        "失败"
    } else {
        "成功"
    }
}

/// Agent 状态码分档（web statusMeta：≥5xx 红 / ≥4xx 琥珀 / ≥3xx 蓝 / 2xx 绿）
fn status_pill_colors(code: i64, theme: &AppTheme) -> (Hsla, Hsla) {
    if code >= 500 {
        (theme.danger.opacity(0.12), theme.danger)
    } else if code >= 400 {
        (theme.warning.opacity(0.12), theme.warning)
    } else if code >= 300 {
        (theme.accent.opacity(0.12), theme.accent)
    } else {
        (theme.success_soft, theme.success)
    }
}

/// 审计「分类 / 动作」单元格：分类 pill + 动作中文标签 + 原始动作小字
fn action_cell(item: &OperationAuditLogItem, theme: &AppTheme) -> gpui::AnyElement {
    let category = operation_category_label(&item.action);
    let (bg, fg) = category_pill_colors(category, theme);
    v_flex()
        .gap_0p5()
        .child(
            h_flex()
                .gap_1p5()
                .items_center()
                .child(pill(category.to_string(), bg, fg))
                .child(
                    div()
                        .text_sm()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.text_primary)
                        .truncate()
                        .child(format_action_label(&item.action)),
                ),
        )
        .child(
            div()
                .text_xs()
                .text_color(theme.text_muted)
                .truncate()
                .child(item.action.clone()),
        )
        .into_any_element()
}

/// 登录设备单元格（OS / 浏览器二元组，web parseUserAgent 口径）
fn device_cell(item: &OperationAuditLogItem, theme: &AppTheme) -> gpui::AnyElement {
    let (os, browser) = parse_user_agent(item.user_agent.as_deref());
    h_flex()
        .items_center()
        .gap_1()
        .child(div().text_sm().text_color(theme.text_primary).child(os))
        .child(div().text_xs().text_color(theme.text_muted).child("/"))
        .child(
            div()
                .text_sm()
                .text_color(theme.text_primary)
                .child(browser),
        )
        .into_any_element()
}

/// 行内「查看」按钮（捕获行数据回写视图打开详情弹层；BLF-692
/// 「Button on_click 捕获实体」范式在表格单元格内的应用）
fn detail_button(
    id_prefix: &'static str,
    row_id: i64,
    view: Entity<SystemLogsView>,
    open: fn(&mut SystemLogsView, OperationAuditLogItem, &mut Context<SystemLogsView>),
    row: OperationAuditLogItem,
) -> gpui::AnyElement {
    Button::new(SharedString::from(format!("{id_prefix}-{row_id}")))
        .ghost()
        .small()
        .label("查看")
        .on_click(move |_, _, cx| {
            let row = row.clone();
            view.update(cx, |this, cx| open(this, row, cx));
        })
        .into_any_element()
}

// ---------------------------------------------------------------------------
// 表格列定义
// ---------------------------------------------------------------------------

/// 审计七列表（时间 / 操作人 / 分类·动作 / 资源类型 / 资源 ID / 结果 / 详情；
/// 列宽对齐 web TableHead w-*）
fn audit_columns(view: Entity<SystemLogsView>) -> Vec<ColumnDef<OperationAuditLogItem>> {
    vec![
        ColumnDef::text("time", "时间", |item: &OperationAuditLogItem, _theme| {
            SharedString::from(format_log_time(&item.created_at))
        })
        .width(150.0),
        ColumnDef::text(
            "operator",
            "操作人",
            |item: &OperationAuditLogItem, _theme| {
                SharedString::from(item.operator.clone().unwrap_or_else(|| "-".to_string()))
            },
        )
        .width(100.0),
        ColumnDef::text("action", "分类 / 动作", |_, _| SharedString::from(""))
            .with_render_element(|item: &OperationAuditLogItem, theme| action_cell(item, theme)),
        ColumnDef::text(
            "target_type",
            "资源类型",
            |item: &OperationAuditLogItem, _theme| {
                SharedString::from(target_type_label(&item.target_type).to_string())
            },
        )
        .width(110.0),
        ColumnDef::text(
            "target_id",
            "资源 ID",
            |item: &OperationAuditLogItem, _theme| {
                SharedString::from(item.target_id.clone().unwrap_or_else(|| "-".to_string()))
            },
        )
        .numeric(true)
        .width(110.0),
        ColumnDef::text("result", "结果", |_, _| SharedString::from(""))
            .width(80.0)
            .with_render_element(|item: &OperationAuditLogItem, theme| {
                let (bg, fg) = result_pill_colors(&item.result, theme);
                pill(result_label(&item.result).to_string(), bg, fg)
            }),
        ColumnDef::text("detail", "详情", |_, _| SharedString::from(""))
            .width(70.0)
            .with_render_element(move |item: &OperationAuditLogItem, _theme| {
                detail_button(
                    "system-logs-audit-detail",
                    item.id,
                    view.clone(),
                    SystemLogsView::open_audit_detail,
                    item.clone(),
                )
            }),
    ]
}

/// 登录七列表（登录时间 / 距现在 / 操作人 / 结果 / 设备·浏览器 / IP 地址 / 详情）
fn login_columns(view: Entity<SystemLogsView>) -> Vec<ColumnDef<OperationAuditLogItem>> {
    vec![
        ColumnDef::text(
            "time",
            "登录时间",
            |item: &OperationAuditLogItem, _theme| {
                SharedString::from(format_log_time(&item.created_at))
            },
        )
        .width(140.0),
        ColumnDef::text(
            "ago",
            "距现在",
            |item: &OperationAuditLogItem, _theme| {
                SharedString::from(format_time_ago(&item.created_at))
            },
        )
        .width(90.0),
        ColumnDef::text(
            "operator",
            "操作人",
            |item: &OperationAuditLogItem, _theme| {
                SharedString::from(item.operator.clone().unwrap_or_else(|| "-".to_string()))
            },
        )
        .width(120.0),
        ColumnDef::text("result", "结果", |_, _| SharedString::from(""))
            .width(80.0)
            .with_render_element(|item: &OperationAuditLogItem, theme| {
                let (bg, fg) = result_pill_colors(&item.result, theme);
                pill(result_label(&item.result).to_string(), bg, fg)
            }),
        ColumnDef::text("device", "设备 · 浏览器", |_, _| {
            SharedString::from("")
        })
        .width(160.0)
        .with_render_element(|item: &OperationAuditLogItem, theme| device_cell(item, theme)),
        ColumnDef::text("ip", "IP 地址", |item: &OperationAuditLogItem, _theme| {
            SharedString::from(item.ip_address.clone().unwrap_or_else(|| "-".to_string()))
        })
        .numeric(true)
        .width(130.0),
        ColumnDef::text("detail", "详情", |_, _| SharedString::from(""))
            .width(70.0)
            .with_render_element(move |item: &OperationAuditLogItem, _theme| {
                detail_button(
                    "system-logs-login-detail",
                    item.id,
                    view.clone(),
                    SystemLogsView::open_login_detail,
                    item.clone(),
                )
            }),
    ]
}

/// Agent 访问八列（时间 / 方法 / 路径 / Agent / 项目 / 状态码 / 耗时 / IP；
/// 未绑定 key 展示「未绑定」，对齐 backend LEFT JOIN 兜底）
fn agent_columns() -> Vec<ColumnDef<AgentAccessLogItem>> {
    vec![
        ColumnDef::text("time", "时间", |item: &AgentAccessLogItem, _theme| {
            SharedString::from(format_log_time(&item.created_at))
        })
        .width(140.0),
        ColumnDef::text("method", "方法", |item: &AgentAccessLogItem, _theme| {
            SharedString::from(item.method.clone())
        })
        .numeric(true)
        .width(70.0),
        ColumnDef::text("path", "路径", |item: &AgentAccessLogItem, _theme| {
            SharedString::from(item.path.clone())
        }),
        ColumnDef::text("agent", "Agent", |item: &AgentAccessLogItem, _theme| {
            SharedString::from(
                item.key_label
                    .clone()
                    .or_else(|| item.agent_id.clone())
                    .unwrap_or_else(|| "未绑定".to_string()),
            )
        })
        .width(150.0),
        ColumnDef::text("project", "项目", |item: &AgentAccessLogItem, _theme| {
            SharedString::from(item.project_name.clone().unwrap_or_else(|| "-".to_string()))
        })
        .width(120.0),
        ColumnDef::text("status", "状态码", |_, _| SharedString::from(""))
            .width(90.0)
            .with_render_element(|item: &AgentAccessLogItem, theme| {
                let (bg, fg) = status_pill_colors(item.status_code, theme);
                pill(item.status_code.to_string(), bg, fg)
            }),
        ColumnDef::number(
            "latency",
            "耗时(ms)",
            |item: &AgentAccessLogItem| item.latency_ms as f64,
            |item: &AgentAccessLogItem, _theme| {
                SharedString::from(format!("{} ms", item.latency_ms))
            },
        )
        .width(90.0),
        ColumnDef::text("ip", "IP 地址", |item: &AgentAccessLogItem, _theme| {
            SharedString::from(item.ip_address.clone().unwrap_or_else(|| "-".to_string()))
        })
        .numeric(true)
        .width(130.0),
    ]
}

// ---------------------------------------------------------------------------
// 详情弹层
// ---------------------------------------------------------------------------

/// JSON pretty（null / 缺省展示「-」）
fn pretty_json(value: Option<&serde_json::Value>) -> String {
    match value {
        None | Some(serde_json::Value::Null) => "-".to_string(),
        Some(v) => serde_json::to_string_pretty(v).unwrap_or_else(|_| v.to_string()),
    }
}

/// 详情字段行（label 弱化 + 值截断）
fn detail_field(label_text: &str, value: String, theme: &AppTheme) -> gpui::AnyElement {
    h_flex()
        .min_w_0()
        .gap_2()
        .child(
            div()
                .flex_shrink()
                .text_sm()
                .text_color(theme.text_muted)
                .child(format!("{label_text}:")),
        )
        .child(
            div()
                .min_w_0()
                .text_sm()
                .text_color(theme.text_primary)
                .truncate()
                .child(value),
        )
        .into_any_element()
}

/// 详情小节标题
fn detail_section_title(text: &str, danger: bool, theme: &AppTheme) -> gpui::AnyElement {
    div()
        .text_sm()
        .font_weight(FontWeight::MEDIUM)
        .text_color(if danger {
            theme.danger
        } else {
            theme.text_primary
        })
        .child(text.to_string())
        .into_any_element()
}

/// 详情代码块（JSON / UA / 错误原因等宽小字块）
fn detail_code_block(text: String, theme: &AppTheme, danger: bool) -> gpui::AnyElement {
    let border = if danger {
        theme.danger.opacity(0.35)
    } else {
        theme.separator.opacity(0.7)
    };
    let fg = if danger {
        theme.danger
    } else {
        theme.text_secondary
    };
    div()
        .id("system-logs-detail-code")
        .w_full()
        .rounded(px(6.0))
        .border_1()
        .border_color(border)
        .bg(theme.muted_fill.opacity(0.4))
        .px_3()
        .py_2()
        .max_h(px(160.0))
        .overflow_y_scroll()
        .child(div().text_xs().text_color(fg).child(text))
        .into_any_element()
}

/// 弹层卡片骨架：标题 + 关闭按钮 + 字段区 + 代码块区（最大高滚动）
fn detail_card_shell(
    view: Entity<SystemLogsView>,
    title: &'static str,
    fields: Vec<gpui::AnyElement>,
    sections: Vec<gpui::AnyElement>,
    theme: &AppTheme,
) -> gpui::AnyElement {
    let view_for_close = view.clone();
    v_flex()
        .id("system-logs-detail-card")
        .w(px(680.0))
        .gap_3()
        .p_5()
        .rounded(px(theme.radius_lg))
        .border_1()
        .border_color(theme.separator.opacity(0.6))
        .bg(theme.card_bg)
        .shadow(vec![theme.card_shadow_box()])
        .max_h(px(600.0))
        .overflow_y_scroll()
        .child(
            h_flex()
                .justify_between()
                .items_center()
                .child(
                    div()
                        .text_base()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme.text_primary)
                        .child(title.to_string()),
                )
                .child(
                    Button::new("system-logs-detail-close")
                        .ghost()
                        .small()
                        .label("关闭")
                        .on_click(move |_, _, cx| {
                            view_for_close.update(cx, |this, cx| this.close_details(cx));
                        }),
                ),
        )
        .child(div().grid().grid_cols(2).gap_2().children(fields))
        .children(sections)
        .into_any_element()
}

/// 审计详情卡（对齐 web 日志详情 Dialog：基础字段 + 变更前后 JSON +
/// 失败原因）
fn audit_detail_card(
    view: Entity<SystemLogsView>,
    row: OperationAuditLogItem,
    theme: &AppTheme,
) -> gpui::AnyElement {
    let mut fields = vec![
        detail_field("时间", format_log_time(&row.created_at), theme),
        detail_field(
            "操作人",
            row.operator.clone().unwrap_or_else(|| "-".to_string()),
            theme,
        ),
        detail_field(
            "分类",
            operation_category_label(&row.action).to_string(),
            theme,
        ),
        detail_field("动作", format_action_label(&row.action), theme),
        detail_field("原始动作标识", row.action.clone(), theme),
        detail_field("结果", result_label(&row.result).to_string(), theme),
        detail_field(
            "资源类型",
            target_type_label(&row.target_type).to_string(),
            theme,
        ),
        detail_field(
            "资源 ID",
            row.target_id.clone().unwrap_or_else(|| "-".to_string()),
            theme,
        ),
        detail_field(
            "请求",
            format!(
                "{} {}",
                row.request_method.as_deref().unwrap_or("-"),
                row.request_path.as_deref().unwrap_or("")
            )
            .trim()
            .to_string(),
            theme,
        ),
        detail_field(
            "Trace ID",
            row.trace_id.clone().unwrap_or_else(|| "-".to_string()),
            theme,
        ),
    ];
    // 失败时结果字段标红提示（对齐 web destructive 文案位）
    if row.result == "failure" {
        fields[5] = detail_field("结果", "失败".to_string(), theme);
    }

    let mut sections = vec![
        detail_section_title("变更前", false, theme),
        detail_code_block(pretty_json(row.before_json.as_ref()), theme, false),
        detail_section_title("变更后 / 返回结果", false, theme),
        detail_code_block(pretty_json(row.after_json.as_ref()), theme, false),
    ];
    if let Some(error_message) = &row.error_message {
        sections.push(detail_section_title("失败原因", true, theme));
        sections.push(detail_code_block(error_message.clone(), theme, true));
    }

    detail_card_shell(view, "日志详情", fields, sections, theme)
}

/// 登录详情卡（对齐 web 登录详情 Dialog：登录字段 + 设备信息 + 其他信息 +
/// 失败原因）
fn login_detail_card(
    view: Entity<SystemLogsView>,
    row: OperationAuditLogItem,
    theme: &AppTheme,
) -> gpui::AnyElement {
    let (os, browser) = parse_user_agent(row.user_agent.as_deref());
    let fields = vec![
        detail_field("登录时间", format_log_time(&row.created_at), theme),
        detail_field("距现在", format_time_ago(&row.created_at), theme),
        detail_field(
            "操作人",
            row.operator.clone().unwrap_or_else(|| "-".to_string()),
            theme,
        ),
        detail_field("登录结果", result_label(&row.result).to_string(), theme),
        detail_field(
            "IP 地址",
            row.ip_address.clone().unwrap_or_else(|| "-".to_string()),
            theme,
        ),
        detail_field(
            "请求路径",
            format!(
                "{} {}",
                row.request_method.as_deref().unwrap_or("-"),
                row.request_path.as_deref().unwrap_or("")
            )
            .trim()
            .to_string(),
            theme,
        ),
    ];

    let mut sections = vec![
        detail_section_title("设备信息", false, theme),
        detail_field("操作系统", os, theme),
        detail_field("浏览器", browser, theme),
        detail_code_block(
            row.user_agent.clone().unwrap_or_else(|| "未知".to_string()),
            theme,
            false,
        ),
        detail_section_title("其他信息", false, theme),
        detail_field(
            "Trace ID",
            row.trace_id.clone().unwrap_or_else(|| "-".to_string()),
            theme,
        ),
        detail_field(
            "资源类型",
            target_type_label(&row.target_type).to_string(),
            theme,
        ),
        detail_field(
            "资源 ID",
            row.target_id.clone().unwrap_or_else(|| "-".to_string()),
            theme,
        ),
    ];
    if let Some(error_message) = &row.error_message {
        sections.push(detail_section_title("失败原因", true, theme));
        sections.push(detail_code_block(error_message.clone(), theme, true));
    }

    detail_card_shell(view, "登录详情", fields, sections, theme)
}

/// 详情弹层（绝对覆盖层 + 居中卡片；审计与登录详情互斥不会并存）
fn render_modal_overlay(
    view: Entity<SystemLogsView>,
    audit_detail: Option<OperationAuditLogItem>,
    login_detail: Option<OperationAuditLogItem>,
    theme: &AppTheme,
) -> gpui::AnyElement {
    let overlay = div()
        .id("system-logs-modal-overlay")
        .absolute()
        .inset_0()
        .flex()
        .items_center()
        .justify_center()
        .bg(gpui::hsla(0., 0., 0., 0.35));

    if let Some(row) = login_detail {
        return overlay
            .child(login_detail_card(view, row, theme))
            .into_any_element();
    }
    if let Some(row) = audit_detail {
        return overlay
            .child(audit_detail_card(view, row, theme))
            .into_any_element();
    }
    overlay.into_any_element()
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_client() -> Client {
        Client::new("http://127.0.0.1:1")
    }

    fn audit_row(id: i64, action: &str, result: &str) -> OperationAuditLogItem {
        OperationAuditLogItem {
            id,
            created_at: "2026-08-21T10:30:00+08:00".into(),
            operator: Some("张三".into()),
            action: action.into(),
            target_type: "shipment_schedule".into(),
            target_id: Some("42".into()),
            result: result.into(),
            trace_id: Some("trace-1".into()),
            request_method: Some("POST".into()),
            request_path: Some("/api/v1/shipment-schedules".into()),
            ip_address: Some("10.0.0.1".into()),
            user_agent: Some(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/126.0.0.0".into(),
            ),
            before_json: None,
            after_json: Some(serde_json::json!({"id": 42})),
            error_message: None,
        }
    }

    fn agent_row(id: i64, status: i64) -> AgentAccessLogItem {
        AgentAccessLogItem {
            id,
            created_at: "2026-08-21T10:31:00+08:00".into(),
            method: "GET".into(),
            path: "/api/v1/agent/inventory/snapshot".into(),
            status_code: status,
            latency_ms: 88,
            ip_address: Some("10.0.0.9".into()),
            api_key_id: Some(3),
            agent_id: Some("simon-inventory".into()),
            key_label: Some("库存运营 Simon".into()),
            project_id: Some(5),
            project_name: Some("测试项目".into()),
            operation_type: Some("read".into()),
        }
    }

    // ---------- 常量 / 筛选模型 ----------

    #[test]
    fn url_constant_matches_sidebar() {
        assert_eq!(SYSTEM_LOGS_URL, "/dashboard/system/logs");
    }

    /// 页签枚举：顺序 / 文案 / 空态文案
    #[test]
    fn log_tab_metadata() {
        assert_eq!(
            LogTab::ALL,
            [LogTab::Audit, LogTab::Login, LogTab::Agent],
            "页签顺序对齐 web TabsList"
        );
        assert_eq!(LogTab::default(), LogTab::Audit);
        assert_eq!(LogTab::Audit.label(), "操作审计日志");
        assert_eq!(LogTab::Login.label(), "登录日志");
        assert_eq!(LogTab::Agent.label(), "Agent 访问日志");
        for tab in LogTab::ALL {
            let (icon, text) = tab.empty_copy();
            assert!(icon.starts_with("icons/"));
            assert!(text.starts_with("暂无"));
        }
    }

    /// 分类筛选 ↔ query 参数 / 文案 / 行匹配（Known 查前缀表，Other 客户端判定）
    #[test]
    fn category_filter_maps_query_label_and_rows() {
        assert_eq!(CategoryFilter::default(), CategoryFilter::All);
        assert_eq!(CategoryFilter::All.as_query(), None);
        assert_eq!(CategoryFilter::All.label(), "全部分类");
        assert_eq!(CategoryFilter::Other.as_query(), None);
        assert_eq!(CategoryFilter::Other.label(), "其他");

        let report = CategoryFilter::Known("report");
        assert_eq!(report.as_query(), Some("report"));
        assert_eq!(report.label(), "报表中心");
        assert!(report.matches_row("monthly_reports.export"));
        assert!(!report.matches_row("auth.login.success"));
        assert!(CategoryFilter::Other.matches_row("weird.unknown"));
        assert!(!CategoryFilter::Other.matches_row("auth.login.success"));
        assert!(CategoryFilter::All.matches_row("anything.at.all"));

        let inventory = CategoryFilter::Known("inventory");
        assert_eq!(inventory.as_query(), Some("inventory_"));
        assert!(inventory.matches_row("inventory_replenishment.list"));
    }

    /// 审计 / Agent 结果筛选 ↔ query 参数 / 文案
    #[test]
    fn result_filters_map_query_and_labels() {
        assert_eq!(AuditResultFilter::All.as_query(), None);
        assert_eq!(AuditResultFilter::Success.as_query(), Some("success"));
        assert_eq!(AuditResultFilter::Failure.as_query(), Some("failure"));
        assert_eq!(AuditResultFilter::Failure.label(), "仅失败");

        assert_eq!(AgentResultFilter::All.as_query(), None);
        assert_eq!(AgentResultFilter::Success.as_query(), Some("success"));
        assert_eq!(AgentResultFilter::Error.as_query(), Some("error"));
        assert_eq!(AgentResultFilter::Error.label(), "仅错误");
    }

    /// 方法筛选 ↔ query 参数 / 文案
    #[test]
    fn method_filter_maps_query_and_labels() {
        assert_eq!(MethodFilter::default(), MethodFilter::All);
        assert_eq!(MethodFilter::All.as_query(), None);
        assert_eq!(MethodFilter::All.label(), "全部方法");
        assert_eq!(MethodFilter::Get.as_query(), Some("GET"));
        assert_eq!(MethodFilter::Get.label(), "GET");
        assert_eq!(MethodFilter::Patch.as_query(), Some("PATCH"));
        assert_eq!(MethodFilter::ALL.len(), 6);
    }

    // ---------- 徽标语义色 ----------

    /// 结果徽标：failure 红、success 绿；未知值兜底绿（亮暗一致）
    #[test]
    fn result_pill_colors_follow_web_semantics() {
        let light = AppTheme::light();
        let dark = AppTheme::dark();
        for theme in [&light, &dark] {
            assert_eq!(
                result_pill_colors("failure", theme),
                (theme.danger_soft, theme.danger)
            );
            assert_eq!(
                result_pill_colors("success", theme),
                (theme.success_soft, theme.success)
            );
            assert_eq!(
                result_pill_colors("weird", theme),
                (theme.success_soft, theme.success),
                "未知结果按成功展示（对齐 web getResultMeta）"
            );
            assert_eq!(result_label("failure"), "失败");
            assert_eq!(result_label("success"), "成功");
            assert_eq!(result_label("weird"), "成功");
        }
    }

    /// 状态码分档：≥500 红 / ≥400 琥珀 / ≥300 蓝 / 其余绿（亮暗一致）
    #[test]
    fn status_pill_colors_follow_web_status_meta() {
        let light = AppTheme::light();
        let dark = AppTheme::dark();
        for theme in [&light, &dark] {
            assert_eq!(
                status_pill_colors(502, theme),
                (theme.danger.opacity(0.12), theme.danger)
            );
            assert_eq!(
                status_pill_colors(404, theme),
                (theme.warning.opacity(0.12), theme.warning)
            );
            assert_eq!(
                status_pill_colors(304, theme),
                (theme.accent.opacity(0.12), theme.accent)
            );
            assert_eq!(
                status_pill_colors(200, theme),
                (theme.success_soft, theme.success)
            );
        }
    }

    /// 分类徽标映射稳定且非零（每分类有底色与前景色）
    #[test]
    fn category_pill_colors_cover_all_categories() {
        let light = AppTheme::light();
        let dark = AppTheme::dark();
        let labels = [
            "提成与绩效",
            "发货管理",
            "SKU资料",
            "项目资料",
            "账号权限",
            "用户登录",
            "库存补货",
            "系统运维",
            "报表中心",
            "其他",
        ];
        for theme in [&light, &dark] {
            for label in labels {
                let (bg, fg) = category_pill_colors(label, theme);
                assert_ne!(bg, gpui::hsla(0., 0., 0., 0.), "{label} 应有底色");
                assert_ne!(bg, fg, "{label} 底色前景色应区分");
            }
            assert_eq!(
                category_pill_colors("未知分类", theme),
                (theme.text_secondary.opacity(0.12), theme.text_secondary),
            );
        }
    }

    // ---------- 列定义契约 ----------

    /// 审计列：七列、列宽对齐 web TableHead、动作 / 结果 / 详情走自定义渲染
    #[gpui::test]
    async fn audit_columns_shape_matches_web_table_head(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, _cx2) =
            cx.add_window_view(|_window, cx| SystemLogsView::new(cx, dummy_client()));
        let columns = audit_columns(view);
        assert_eq!(columns.len(), 7);
        let titles: Vec<&str> = columns.iter().map(|c| c.title.as_ref()).collect();
        assert_eq!(
            titles,
            [
                "时间",
                "操作人",
                "分类 / 动作",
                "资源类型",
                "资源 ID",
                "结果",
                "详情"
            ]
        );
        assert_eq!(columns[0].width, Some(150.0));
        assert!(columns[2].render_element.is_some(), "分类·动作为自定义渲染");
        assert!(columns[5].render_element.is_some(), "结果徽标自定义渲染");
        assert!(columns[6].render_element.is_some(), "详情按钮自定义渲染");
    }

    /// 登录列：七列 + IP 走等宽列
    #[gpui::test]
    async fn login_columns_shape_matches_web_table_head(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, _cx2) =
            cx.add_window_view(|_window, cx| SystemLogsView::new(cx, dummy_client()));
        let columns = login_columns(view);
        assert_eq!(columns.len(), 7);
        let titles: Vec<&str> = columns.iter().map(|c| c.title.as_ref()).collect();
        assert_eq!(
            titles,
            [
                "登录时间",
                "距现在",
                "操作人",
                "结果",
                "设备 · 浏览器",
                "IP 地址",
                "详情"
            ]
        );
        assert!(columns[4].render_element.is_some(), "设备列为自定义渲染");
        assert!(columns[5].numeric, "IP 地址走等宽字体列");
    }

    /// Agent 列：八列 + 状态码徽标 / 耗时数字列
    #[test]
    fn agent_columns_shape_matches_web_table_head() {
        let columns = agent_columns();
        assert_eq!(columns.len(), 8);
        let titles: Vec<&str> = columns.iter().map(|c| c.title.as_ref()).collect();
        assert_eq!(
            titles,
            [
                "时间",
                "方法",
                "路径",
                "Agent",
                "项目",
                "状态码",
                "耗时(ms)",
                "IP 地址"
            ]
        );
        assert!(columns[5].render_element.is_some(), "状态码徽标自定义渲染");
        assert!(columns[6].numeric, "耗时为数字列");
        assert!(columns[2].width.is_none(), "路径列弹性占满剩余空间");
    }

    // ---------- 展示辅助联动 ----------

    /// 详情 JSON pretty 与缺省「-」；未绑定 agent 兜底
    #[test]
    fn detail_helpers_fallbacks() {
        assert_eq!(pretty_json(None), "-");
        assert_eq!(pretty_json(Some(&serde_json::Value::Null)), "-");
        assert_eq!(
            pretty_json(Some(&serde_json::json!({"a": 1}))),
            "{\n  \"a\": 1\n}"
        );
        let mut row = agent_row(9, 200);
        row.key_label = None;
        row.agent_id = None;
        let label = row
            .key_label
            .clone()
            .or_else(|| row.agent_id.clone())
            .unwrap_or_else(|| "未绑定".to_string());
        assert_eq!(label, "未绑定");
    }

    // ---------- 渲染冒烟（亮 / 暗 × 全部状态 + 三页签 + 弹层 + 减弱动态）----------

    fn set_theme(dark: bool, cx: &mut gpui::App) {
        crate::theme::set_theme_pref(
            if dark {
                crate::theme::ThemePreference::Dark
            } else {
                crate::theme::ThemePreference::Light
            },
            None,
            cx,
        );
    }

    #[gpui::test]
    async fn renders_loading_in_light_and_dark(cx: &mut gpui::TestAppContext) {
        for dark in [false, true] {
            cx.update(|cx| {
                gpui_component::init(cx);
                set_theme(dark, cx);
            });
            let (view, _cx) =
                cx.add_window_view(|_window, cx| SystemLogsView::new(cx, dummy_client()));
            cx.read(|app| {
                assert_eq!(*view.read(app).phase(LogTab::Audit), FetchPhase::Loading);
                assert_eq!(crate::theme::AppTheme::current(app).is_dark(), dark);
            });
        }
    }

    #[gpui::test]
    async fn renders_loaded_empty_error_states(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            set_theme(false, cx);
        });
        let (view, cx2) = cx.add_window_view(|_window, cx| SystemLogsView::new(cx, dummy_client()));

        // Loaded：注入审计行 + 汇总
        view.update(cx2, |this, cx| {
            let summary: OperationAuditLogsSummaryResponse = serde_json::from_str(
                r#"{"total":30,"success_count":28,"failure_count":2,"unique_operator_count":4}"#,
            )
            .unwrap();
            this.apply_audit_result(
                this.audit_request_id,
                Ok((
                    OperationAuditLogsResponse {
                        items: vec![audit_row(1, "shipment_schedules.create", "success")],
                        total: 30,
                        page: 1,
                        page_size: AUDIT_PAGE_SIZE as i64,
                        has_next: true,
                    },
                    summary,
                )),
                cx,
            );
            assert_eq!(*this.phase(LogTab::Audit), FetchPhase::Loaded);
            assert_eq!(this.table_len(cx, LogTab::Audit), 1);
            assert_eq!(this.audit_total, 30);
        });

        // Empty
        view.update(cx2, |this, cx| {
            this.apply_audit_result(
                this.audit_request_id,
                Ok((
                    OperationAuditLogsResponse {
                        items: vec![],
                        total: 0,
                        page: 1,
                        page_size: AUDIT_PAGE_SIZE as i64,
                        has_next: false,
                    },
                    serde_json::from_str(
                        r#"{"total":0,"success_count":0,"failure_count":0,"unique_operator_count":0}"#,
                    )
                    .unwrap(),
                )),
                cx,
            );
            assert_eq!(*this.phase(LogTab::Audit), FetchPhase::Empty);
        });

        // Error
        view.update(cx2, |this, cx| {
            this.apply_audit_result(
                this.audit_request_id,
                Err(ApiError::Http {
                    status: 500,
                    message: "boom".into(),
                }),
                cx,
            );
            assert!(matches!(this.phase(LogTab::Audit), FetchPhase::Error(_)));
        });
    }

    /// 「其他」分类客户端过滤：命中保留、已知前缀剔除（对齐 web 口径）
    #[gpui::test]
    async fn other_category_filters_rows_client_side(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| SystemLogsView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            this.set_audit_category(CategoryFilter::Other, cx);
            this.apply_audit_result(
                this.audit_request_id,
                Ok((
                    OperationAuditLogsResponse {
                        items: vec![
                            audit_row(1, "weird.unknown.action", "success"),
                            audit_row(2, "auth.login.success", "success"),
                            audit_row(3, "totally-unknown", "success"),
                        ],
                        total: 3,
                        page: 1,
                        page_size: AUDIT_PAGE_SIZE as i64,
                        has_next: false,
                    },
                    serde_json::from_str(
                        r#"{"total":3,"success_count":3,"failure_count":0,"unique_operator_count":1}"#,
                    )
                    .unwrap(),
                )),
                cx,
            );
            assert_eq!(
                this.table_len(cx, LogTab::Audit),
                2,
                "其他档应仅留无前缀命中的行"
            );
        });
    }

    /// 过期响应丢弃（竞态保护）：request_id 落后不落地
    #[gpui::test]
    async fn stale_results_are_dropped(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| SystemLogsView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            this.reload_audit(cx);
            let fresh = this.audit_request_id;
            this.apply_audit_result(
                fresh - 1,
                Err(ApiError::Http {
                    status: 500,
                    message: "过期响应不应落地".into(),
                }),
                cx,
            );
            assert_eq!(*this.phase(LogTab::Audit), FetchPhase::Loading);

            this.apply_audit_result(
                fresh,
                Ok((
                    OperationAuditLogsResponse {
                        items: vec![audit_row(1, "projects.create", "success")],
                        total: 1,
                        page: 1,
                        page_size: AUDIT_PAGE_SIZE as i64,
                        has_next: false,
                    },
                    serde_json::from_str(
                        r#"{"total":1,"success_count":1,"failure_count":0,"unique_operator_count":1}"#,
                    )
                    .unwrap(),
                )),
                cx,
            );
            assert_eq!(*this.phase(LogTab::Audit), FetchPhase::Loaded);
            assert_eq!(this.table_len(cx, LogTab::Audit), 1);
        });
    }

    /// 页签切换 / 筛选切换回第 1 页重拉；同档 no-op；翻页守卫
    #[gpui::test]
    async fn filters_and_pagination_guards(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| SystemLogsView::new(cx, dummy_client()));

        view.update(cx2, |this, cx| {
            // 翻到第 3 页
            this.go_to_audit_page(3, cx);
            assert_eq!(this.current_filters().3, 3);
            let after = this.audit_request_id;
            this.go_to_audit_page(3, cx);
            assert_eq!(this.audit_request_id, after, "同页不重复请求");
            this.go_to_audit_page(0, cx);
            assert_eq!(this.audit_request_id, after, "非法页号忽略");

            // 切筛选回第 1 页 + 重拉
            this.set_audit_category(CategoryFilter::Known("report"), cx);
            let (tab, category, _, page) = this.current_filters();
            assert_eq!(category, CategoryFilter::Known("report"));
            assert_eq!(page, 1, "切筛选回第 1 页");
            assert_eq!(tab, LogTab::Audit);
            let after = this.audit_request_id;
            this.set_audit_category(CategoryFilter::Known("report"), cx);
            assert_eq!(this.audit_request_id, after, "同档不重复请求");

            // 结果筛选同口径
            this.go_to_audit_page(2, cx);
            this.set_audit_result(AuditResultFilter::Failure, cx);
            assert_eq!(this.current_filters().2, AuditResultFilter::Failure);
            assert_eq!(this.current_filters().3, 1);
            let after = this.audit_request_id;
            this.set_audit_result(AuditResultFilter::Failure, cx);
            assert_eq!(this.audit_request_id, after);

            // 重置：全部分类 + 全部结果 + 第 1 页
            this.reset_audit_filters(cx);
            let (_, category, result, page) = this.current_filters();
            assert_eq!(category, CategoryFilter::All);
            assert_eq!(result, AuditResultFilter::All);
            assert_eq!(page, 1);
        });

        // 页签切换：切 Login 后 reload 走登录管线（action=auth.），切同页签 no-op
        view.update(cx2, |this, cx| {
            this.set_tab(LogTab::Login, cx);
            assert_eq!(this.current_filters().0, LogTab::Login);
            let after = this.login_request_id;
            this.set_tab(LogTab::Login, cx);
            assert_eq!(this.login_request_id, after, "同页签切换 no-op");

            // Agent 翻页 / 筛选
            this.set_tab(LogTab::Agent, cx);
            this.go_to_agent_page(2, cx);
            assert_eq!(this.agent_page, 2);
            this.set_agent_method(MethodFilter::Post, cx);
            assert_eq!(this.agent_method, MethodFilter::Post);
            assert_eq!(this.agent_page, 1, "切方法筛选回第 1 页");
            let after = this.agent_request_id;
            this.set_agent_result(AgentResultFilter::Error, cx);
            assert!(this.agent_request_id > after);
        });
    }

    /// 详情弹层开合互斥：打开审计详情关登录详情，close 双清
    #[gpui::test]
    async fn detail_modal_open_close_and_mutex(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| SystemLogsView::new(cx, dummy_client()));

        view.update(cx2, |this, cx| {
            this.open_login_detail(audit_row(7, "auth.login.failed", "failure"), cx);
            assert!(this.login_detail.is_some());
            this.open_audit_detail(audit_row(8, "users.create", "success"), cx);
            assert!(this.audit_detail.is_some(), "打开审计详情应顶掉登录详情");
            assert!(this.login_detail.is_none());
            this.close_details(cx);
            assert!(this.audit_detail.is_none());
        });

        // 无弹层时 close no-op 不触发 notify 断言（幂等）
        view.update(cx2, |this, cx| {
            this.close_details(cx);
            assert!(this.audit_detail.is_none() && this.login_detail.is_none());
            let _ = cx;
        });
    }

    /// 登录页签拉取落地（apply_login_result 注入表格 + 汇总）
    #[gpui::test]
    async fn login_tab_apply_result_lands(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| SystemLogsView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            this.reload_login(cx);
            this.apply_login_result(
                this.login_request_id,
                Ok((
                    OperationAuditLogsResponse {
                        items: vec![
                            audit_row(1, "auth.login.success", "success"),
                            audit_row(2, "auth.login.failed", "failure"),
                        ],
                        total: 2,
                        page: 1,
                        page_size: AUDIT_PAGE_SIZE as i64,
                        has_next: false,
                    },
                    serde_json::from_str(
                        r#"{"total":2,"success_count":1,"failure_count":1,"unique_operator_count":2}"#,
                    )
                    .unwrap(),
                )),
                cx,
            );
            assert_eq!(*this.phase(LogTab::Login), FetchPhase::Loaded);
            assert_eq!(this.table_len(cx, LogTab::Login), 2);
            assert_eq!(this.login_total, 2);
            assert!(this.login_summary.is_some());
        });
    }

    /// Agent 页签拉取落地
    #[gpui::test]
    async fn agent_tab_apply_result_lands(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| SystemLogsView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            this.reload_agent(cx);
            this.apply_agent_result(
                this.agent_request_id,
                Ok((
                    AgentAccessLogsResponse {
                        items: vec![agent_row(9, 200), agent_row(10, 502)],
                        total: 120,
                        page: 1,
                        page_size: AGENT_PAGE_SIZE as i64,
                        has_next: true,
                    },
                    serde_json::from_str(
                        r#"{"total":120,"success_count":110,"error_count":10,"unique_agent_count":3}"#,
                    )
                    .unwrap(),
                )),
                cx,
            );
            assert_eq!(*this.phase(LogTab::Agent), FetchPhase::Loaded);
            assert_eq!(this.table_len(cx, LogTab::Agent), 2);
            assert_eq!(this.agent_total, 120);
        });
    }

    /// 弹层渲染冒烟（审计详情 + 登录详情 + 减弱动态）
    #[gpui::test]
    async fn renders_detail_modal_overlay(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            set_theme(true, cx);
        });
        let (view, cx2) = cx.add_window_view(|_window, cx| SystemLogsView::new(cx, dummy_client()));

        view.update(cx2, |this, cx| {
            let mut failed = audit_row(11, "commission.bonus.recompute", "failure");
            failed.error_message = Some("数据库连接超时".into());
            failed.before_json = Some(serde_json::json!({"ratio": 0.1}));
            failed.after_json = Some(serde_json::json!({"ratio": 0.15}));
            this.open_audit_detail(failed, cx);
        });
        cx2.read(|app| {
            assert!(view.read(app).audit_detail.is_some());
        });

        view.update(cx2, |this, cx| {
            let mut login_failed = audit_row(12, "auth.login.account_disabled", "failure");
            login_failed.user_agent =
                Some("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/127.0".into());
            login_failed.error_message = Some("账号已禁用".into());
            this.open_login_detail(login_failed, cx);
        });
        cx2.read(|app| {
            assert!(view.read(app).login_detail.is_some());
        });
    }

    /// reduce motion 下 Loaded 渲染瞬时（无动画重放）
    #[gpui::test]
    async fn renders_loaded_with_reduce_motion(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            cx.set_global(crate::motion::MotionPref(true));
        });
        let (view, cx2) = cx.add_window_view(|_window, cx| SystemLogsView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            this.apply_audit_result(
                this.audit_request_id,
                Ok((
                    OperationAuditLogsResponse {
                        items: vec![audit_row(1, "sku_info.export", "success")],
                        total: 1,
                        page: 1,
                        page_size: AUDIT_PAGE_SIZE as i64,
                        has_next: false,
                    },
                    serde_json::from_str(
                        r#"{"total":1,"success_count":1,"failure_count":0,"unique_operator_count":1}"#,
                    )
                    .unwrap(),
                )),
                cx,
            );
            assert_eq!(*this.phase(LogTab::Audit), FetchPhase::Loaded);
        });
    }
}
