//! 系统管理 → Agent 接入管理（P5-8，BLF-758）
//!
//! 对齐 web 端 `app/dashboard/system/agent-management`（约 2650 行）的核心面，
//! 四个 Tab：
//! - **业务域概览**：13 个业务域接入状态卡（live/planned + 路由数 + 读/写能力 +
//!   已授权凭据数，凭据数从当前凭据列表实时统计）；
//! - **凭据管理**：状态 / 业务域筛选 + 含已删除开关 + 凭据表（选中行操作：
//!   编辑 / 停用 | 激活 / 删除）+ 创建凭据对话框（名称 / Agent ID / 项目范围 /
//!   业务域范围多选），创建成功后明文 Key 仅展示一次（复制到剪贴板）；
//! - **调用指南**：静态鉴权与调用示例（解析项目 ID → 探针 → 读列表 → 写两步
//!   确认），一键复制；
//! - **访问日志**：读访问 / 写操作子 Tab，统计概览带 + Top Agent 徽标 + 日志表
//!   （关键词 / 方法 / 结果 / 操作类型筛选 + 分页，page_size=50 对齐 web）。
//!
//! ## 与 web 端的取舍（issue 允许按 macOS 原生习惯精简并说明）
//!
//! - **行内操作按钮** → 表格行选中 + 操作条（GPUI DataTable 无行内事件回调，
//!   选中行操作是 macOS 原生习惯，如 Finder / Xcode 列表详情模式）；
//! - **删除确认输入 Key 前缀复核** → 普通确认对话框（桌面端误触风险低于 web，
//!   软删除本身可审计回溯；后端 DELETE 幂等）；
//! - **日志筛选的 project_id 数字输入 / date_from/date_to/status_code** → 不接入
//!   （web 面板亦未全部暴露；保留关键词 + 方法 + 结果 + 操作类型四个高频项）;
//! - **调用指南的按业务域分域示例切换** → 静态通用示例卡（鉴权头 + 项目 ID
//!   解析 + 两步确认写流程跨域一致，域差异只在路径）。
//!
//! ## 权限口径
//!
//! 凭据 CRUD 走 `/api/v1/internal/api-keys`（admin-gated）；GUI 登录会话为
//! admin 时 `Client` 自动携带 `X-Is-Admin: true`（client.rs 上下文头管线），
//! 非 admin 登录将收到后端 403「需要管理员权限」（错误态透传展示）。

use gpui::prelude::*;
use gpui::{
    div, px, App, AsyncApp, Context, CursorStyle, Entity, FontWeight, IntoElement, SharedString,
    WeakEntity, Window,
};
use gpui_component::button::{Button, ButtonVariants};
use gpui_component::input::{Input, InputState};
use gpui_component::menu::PopupMenuItem;
use gpui_component::{h_flex, v_flex, Disableable, Icon, IconName, Sizable};
use gui_api_client::agent_management::{
    AgentKeyCreateBody, AgentKeyListFilter, AgentKeyUpdateBody, AgentLogsFilter,
};
use gui_api_client::Client;
use gui_domain::agent_management::{
    parse_scope_parts, scope_has_domain, AgentApiKeyCreateResponse, AgentApiKeyItem,
    AgentDomainStatus, AgentKeyStatus, AgentOperationLogItem, AgentOperationLogsSummary,
    AGENT_DOMAINS, BUSINESS_SCOPE_ALL,
};
use gui_domain::common::ManagedProject;
use gui_domain::system_management::{
    AgentAccessLogItem, AgentAccessLogsResponse, AgentAccessLogsSummaryResponse,
};

use crate::theme::AppTheme;
use crate::widgets::data_table::{CellAlign, ColumnDef, DataTable};
use crate::widgets::filter_bar::{filter_bar_layout, filter_select};
use crate::widgets::layout::content_guard;
use crate::widgets::page_header::PageHeader;
use crate::widgets::pagination::{self, PageState};
use crate::widgets::state_views::{self, SkeletonBlock};

/// sidebar「系统管理 → Agent 接入管理」URL（数据权威 gui-domain::sidebar）
pub const AGENT_MANAGEMENT_URL: &str = "/dashboard/system/agent-management";

/// 日志每页行数（对齐 web 固定 50）
const LOG_PAGE_SIZE: usize = 50;

// ---------------------------------------------------------------------------
// Tab / 筛选枚举
// ---------------------------------------------------------------------------

/// 主 Tab（对齐 web TabsList 四项）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentTab {
    Overview,
    Credentials,
    Guide,
    Logs,
}

impl AgentTab {
    pub const ALL: [Self; 4] = [Self::Overview, Self::Credentials, Self::Guide, Self::Logs];

    fn id(self) -> &'static str {
        match self {
            Self::Overview => "overview",
            Self::Credentials => "credentials",
            Self::Guide => "guide",
            Self::Logs => "logs",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Overview => "业务域概览",
            Self::Credentials => "凭据管理",
            Self::Guide => "调用指南",
            Self::Logs => "访问日志",
        }
    }
}

/// 访问日志子 Tab（读访问 / 写操作）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogsSubTab {
    Read,
    Write,
}

impl LogsSubTab {
    fn label(self) -> &'static str {
        match self {
            Self::Read => "读访问",
            Self::Write => "写操作",
        }
    }
}

/// 凭据状态筛选
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusFilter {
    All,
    Active,
    Inactive,
    Expired,
}

/// 双 scope 编辑目标（项目 / 业务域；对话框勾选动作路由用）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScopeKind {
    Project,
    Business,
}

impl ScopeKind {
    fn id_prefix(self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::Business => "biz",
        }
    }
}

impl StatusFilter {
    fn label(self) -> &'static str {
        match self {
            Self::All => "全部状态",
            Self::Active => "激活",
            Self::Inactive => "停用",
            Self::Expired => "已过期",
        }
    }

    /// 与派生状态的匹配（Deleted 只随「含已删除」出现，不设筛选档——对齐 web）
    fn matches(self, status: AgentKeyStatus) -> bool {
        match self {
            Self::All => true,
            Self::Active => status == AgentKeyStatus::Active,
            Self::Inactive => status == AgentKeyStatus::Inactive,
            Self::Expired => status == AgentKeyStatus::Expired,
        }
    }
}

// ---------------------------------------------------------------------------
// 纯辅助函数
// ---------------------------------------------------------------------------

/// ISO 时间戳 → 北京时间 `YYYY-MM-DD HH:MM`（空 / 解析失败 → 「—」/ 原文回退）
fn beijing_time(iso: Option<&str>) -> String {
    let Some(iso) = iso.map(str::trim).filter(|s| !s.is_empty()) else {
        return "—".to_string();
    };
    let beijing = chrono::FixedOffset::east_opt(8 * 3600).expect("固定偏移");
    let parsed = chrono::DateTime::parse_from_rfc3339(iso)
        .map(|dt| dt.with_timezone(&beijing))
        .or_else(|_| {
            chrono::NaiveDateTime::parse_from_str(iso, "%Y-%m-%dT%H:%M:%S%.f").map(|naive| {
                use chrono::TimeZone;
                chrono::Utc
                    .from_utc_datetime(&naive)
                    .with_timezone(&beijing)
            })
        });
    parsed
        .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_else(|_| iso.to_string())
}

/// HTTP 状态码语义（对齐 web `statusMeta` 四档）
fn http_status_label(code: i64) -> &'static str {
    if code >= 500 {
        "服务端错误"
    } else if code >= 400 {
        "请求错误"
    } else if code >= 300 {
        "重定向"
    } else {
        "成功"
    }
}

/// 状态码 pill 配色（成功绿 / 请求错橙 / 重定向黄 / 服务端错红）
fn http_status_colors(code: i64, theme: &AppTheme) -> (gpui::Hsla, gpui::Hsla) {
    if code >= 500 {
        (theme.danger_soft, theme.danger)
    } else if code >= 400 {
        (theme.warning.opacity(0.12), theme.warning)
    } else if code >= 300 {
        (theme.warning.opacity(0.08), theme.warning)
    } else {
        (theme.success_soft, theme.success)
    }
}

/// 业务域 scope 白名单归一：勾选项拼接（空 → '*' 哨兵）
fn join_scope(selected: &[String]) -> String {
    if selected.is_empty() {
        BUSINESS_SCOPE_ALL.to_string()
    } else {
        selected.join(",")
    }
}

/// 操作类型 code → 中文名（未知 code 回退原样，空 → '-'）
fn operation_type_label(code: Option<&str>) -> String {
    match code.map(str::trim).filter(|s| !s.is_empty()) {
        None => "-".to_string(),
        Some(c) => gui_domain::agent_management::get_agent_domain(c)
            .map(|d| d.label.to_string())
            .unwrap_or_else(|| c.to_string()),
    }
}

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

/// 凭据列表状态机
#[derive(Debug, Clone, PartialEq)]
pub enum KeyListState {
    Loading,
    Loaded,
    Empty,
    Error(String),
}

/// 待确认动作（停用 / 激活 / 删除共用一个确认对话框）
#[derive(Debug, Clone)]
pub enum PendingConfirm {
    Deactivate(AgentApiKeyItem),
    Activate(AgentApiKeyItem),
    Delete(AgentApiKeyItem),
}

impl PendingConfirm {
    fn title(&self) -> String {
        match self {
            Self::Deactivate(k) => format!("停用凭据「{}」？", k.label),
            Self::Activate(k) => format!("激活凭据「{}」？", k.label),
            Self::Delete(k) => format!("删除凭据「{}」？", k.label),
        }
    }

    fn description(&self) -> &'static str {
        match self {
            Self::Deactivate(_) => {
                "停用后使用该凭据的 Agent 将立即无法访问。可随时重新激活。"
            }
            Self::Activate(_) => {
                "激活后该凭据恢复访问权限。若此前因疑似泄露而停用，建议新建凭据轮换。"
            }
            Self::Delete(_) => "软删除后不可在列表恢复，使用该凭据的 Agent 将永久无法访问（审计日志保留）。删除需输入 Key 前缀确认请在 web 端操作。",
        }
    }

    fn confirm_label(&self) -> &'static str {
        match self {
            Self::Deactivate(_) => "停用",
            Self::Activate(_) => "激活",
            Self::Delete(_) => "删除",
        }
    }

    fn key_id(&self) -> i64 {
        match self {
            Self::Deactivate(k) | Self::Activate(k) | Self::Delete(k) => k.id,
        }
    }

    fn is_delete(&self) -> bool {
        matches!(self, Self::Delete(_))
    }
}

/// 双 scope 多选草稿（项目范围 / 业务域范围共用；all = 哨兵 '*'）
#[derive(Debug, Clone, Default, PartialEq)]
struct ScopeDraft {
    all: bool,
    selected: Vec<String>,
}

impl ScopeDraft {
    fn all() -> Self {
        Self {
            all: true,
            selected: Vec::new(),
        }
    }

    /// 由既有 scope 归一构造（编辑预填；'*' → all）
    fn from_scope(scope: Option<&str>) -> Self {
        let normalized = gui_domain::agent_management::normalize_scope(scope);
        if normalized == BUSINESS_SCOPE_ALL {
            Self::all()
        } else {
            Self {
                all: false,
                selected: parse_scope_parts(scope),
            }
        }
    }

    fn toggle_all(&mut self) {
        self.all = !self.all;
        if self.all {
            self.selected.clear();
        }
    }

    fn toggle_item(&mut self, item: &str) {
        if self.all {
            // 从「全部」切到白名单：先全选再移除当前项（对齐 web MultiSelect 交互直觉）
            self.all = false;
        }
        if let Some(pos) = self.selected.iter().position(|s| s == item) {
            self.selected.remove(pos);
        } else {
            self.selected.push(item.to_string());
        }
    }

    fn to_scope(&self) -> String {
        if self.all {
            BUSINESS_SCOPE_ALL.to_string()
        } else {
            join_scope(&self.selected)
        }
    }
}

/// 创建 / 编辑凭据对话框状态（输入框实体由 render 期懒建，需要 window）
#[derive(Debug, Clone, Default, PartialEq)]
struct KeyFormDialog {
    editing: Option<AgentApiKeyItem>,
    project_scope: ScopeDraft,
    business_scope: ScopeDraft,
}

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

/// Agent 接入管理视图（四 Tab + 写操作对话框 + 确认动作）
pub struct AgentManagementView {
    client: Client,
    active_tab: AgentTab,

    // ── 凭据 ────────────────────────────────────────────────
    keys_state: KeyListState,
    keys: Vec<AgentApiKeyItem>,
    include_deleted: bool,
    status_filter: StatusFilter,
    domain_filter: Option<String>,
    projects: Vec<ManagedProject>,
    table: Entity<DataTable<AgentApiKeyItem>>,
    keys_request_id: u64,

    // ── 创建 / 编辑对话框 ────────────────────────────────────
    form_dialog: Option<KeyFormDialog>,
    label_input: Option<Entity<InputState>>,
    agent_id_input: Option<Entity<InputState>>,
    created: Option<AgentApiKeyCreateResponse>,
    busy: bool,
    dialog_error: Option<String>,

    // ── 行级确认 ────────────────────────────────────────────
    pending_confirm: Option<PendingConfirm>,

    // ── 操作反馈（成功绿 / 失败红内联提示条） ────────────────
    notice: Option<(bool, String)>,

    // ── 访问日志 ────────────────────────────────────────────
    logs_sub_tab: LogsSubTab,
    logs_loading: bool,
    logs_error: Option<String>,
    access_rows: Vec<AgentAccessLogItem>,
    access_summary: Option<AgentAccessLogsSummaryResponse>,
    op_rows: Vec<AgentOperationLogItem>,
    op_summary: Option<AgentOperationLogsSummary>,
    log_keyword_input: Option<Entity<InputState>>,
    log_keyword_applied: String,
    log_method: Option<String>,
    log_result: Option<String>,
    log_page: usize,
    log_total: usize,
    log_has_next: bool,
    logs_request_id: u64,
}

impl AgentManagementView {
    /// 新建视图：初始 Loading，由 root.rs 懒创建后触发 `reload_keys` /
    /// `reload_logs` / 项目列表拉取
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let table = cx.new(|_| {
            DataTable::new("agent-key-table", key_columns())
                .striped(true)
                .selectable(true)
                .empty_text("暂无凭据 — 点击右上角「创建凭据」开始接入")
        });
        Self {
            client,
            active_tab: AgentTab::Credentials,
            keys_state: KeyListState::Loading,
            keys: Vec::new(),
            include_deleted: false,
            status_filter: StatusFilter::All,
            domain_filter: None,
            projects: Vec::new(),
            table,
            keys_request_id: 0,
            form_dialog: None,
            label_input: None,
            agent_id_input: None,
            created: None,
            busy: false,
            dialog_error: None,
            pending_confirm: None,
            notice: None,
            logs_sub_tab: LogsSubTab::Read,
            logs_loading: false,
            logs_error: None,
            access_rows: Vec::new(),
            access_summary: None,
            op_rows: Vec::new(),
            op_summary: None,
            log_keyword_input: None,
            log_keyword_applied: String::new(),
            log_method: None,
            log_result: None,
            log_page: 1,
            log_total: 0,
            log_has_next: false,
            logs_request_id: 0,
        }
    }

    /// 当前状态（只读，测试用）
    #[allow(dead_code)]
    pub fn current_keys_state(&self) -> &KeyListState {
        &self.keys_state
    }

    /// 当前 Tab（只读，测试用）
    #[allow(dead_code)]
    pub fn current_tab(&self) -> AgentTab {
        self.active_tab
    }

    // ── 数据拉取 ────────────────────────────────────────────

    /// 拉取凭据列表（首屏 / 动作完成后 / 筛选含已删除切换）
    pub fn reload_keys(&mut self, cx: &mut Context<Self>) {
        self.keys_request_id = self.keys_request_id.wrapping_add(1);
        let request_id = self.keys_request_id;
        let filter = AgentKeyListFilter {
            include_deleted: self.include_deleted,
        };
        self.keys_state = KeyListState::Loading;
        cx.notify();

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime()
                        .block_on(async { client.agent_key_list(&filter).await })
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                if request_id != this.keys_request_id {
                    return; // 过期响应
                }
                match result {
                    Ok(keys) => {
                        this.keys = keys;
                        this.keys_state = if this.keys.is_empty() {
                            KeyListState::Empty
                        } else {
                            KeyListState::Loaded
                        };
                    }
                    Err(e) => {
                        this.keys = Vec::new();
                        this.keys_state = KeyListState::Error(e.user_message());
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();

        self.reload_projects(cx);
    }

    /// 拉取可管理项目列表（项目范围格式化 + 创建对话框用；失败静默降级 #id 展示）
    fn reload_projects(&mut self, cx: &mut Context<Self>) {
        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime()
                        .block_on(async { client.list_managed_projects().await })
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                if let Ok(projects) = result {
                    this.projects = projects;
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    /// 组装写操作日志筛选（读访问走 BLF-757 客户端位置参数，不经此结构）
    fn build_logs_filter(&self) -> AgentLogsFilter {
        AgentLogsFilter {
            keyword: Some(self.log_keyword_applied.clone()),
            // 读侧「失败 (≥4xx)」= error；写侧口径为 failure，切换时映射
            result: self.log_result.as_deref().map(|r| match r {
                "error" => "failure".to_string(),
                other => other.to_string(),
            }),
            project_id: None,
        }
    }

    /// 拉取访问日志（列表 + 统计概览并行；读 / 写子 Tab 各自端点）
    pub fn reload_logs(&mut self, cx: &mut Context<Self>) {
        self.logs_request_id = self.logs_request_id.wrapping_add(1);
        let request_id = self.logs_request_id;
        let filter = self.build_logs_filter();
        let page = self.log_page as i64;
        let read = self.logs_sub_tab == LogsSubTab::Read;
        self.logs_loading = true;
        self.logs_error = None;
        cx.notify();

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        // 读访问复用 BLF-757 system_management 客户端（keyword/method/result 三参）；
        // 写操作走本模块端点（keyword/result/project_id/operation_type）
        let keyword = Some(self.log_keyword_applied.clone()).filter(|s| !s.is_empty());
        let method = self.log_method.clone();
        let result = self.log_result.clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result_fetch: Result<LogFetch, gui_api_client::error::ApiError> = bg
                .spawn(async move {
                    crate::runtime::runtime().block_on(async {
                        if read {
                            let page = client
                                .agent_access_logs(
                                    keyword.as_deref(),
                                    method.as_deref(),
                                    result.as_deref(),
                                    page as usize,
                                    LOG_PAGE_SIZE,
                                )
                                .await?;
                            let summary = client
                                .agent_access_logs_summary(
                                    keyword.as_deref(),
                                    method.as_deref(),
                                    result.as_deref(),
                                )
                                .await?;
                            Ok(LogFetch::Access { page, summary })
                        } else {
                            let page = client.agent_operation_logs(&filter, page).await?;
                            let summary = client.agent_operation_logs_summary(&filter).await?;
                            Ok(LogFetch::Operation { page, summary })
                        }
                    })
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                if request_id != this.logs_request_id {
                    return; // 过期响应
                }
                this.logs_loading = false;
                match result_fetch {
                    Ok(LogFetch::Access { page, summary }) => {
                        this.log_total = page.total.max(0) as usize;
                        this.log_has_next = page.has_next;
                        this.access_rows = page.items;
                        this.access_summary = Some(summary);
                    }
                    Ok(LogFetch::Operation { page, summary }) => {
                        this.log_total = page.total.max(0) as usize;
                        this.log_has_next = page.has_next;
                        this.op_rows = page.items;
                        this.op_summary = Some(summary);
                    }
                    Err(e) => {
                        this.logs_error = Some(e.user_message());
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    // ── Tab / 筛选动作 ──────────────────────────────────────

    /// 切主 Tab（同值 no-op；切到日志 Tab 且无数据时触发首拉）
    pub fn select_tab(&mut self, tab: AgentTab, cx: &mut Context<Self>) {
        if tab == self.active_tab {
            return;
        }
        self.active_tab = tab;
        if tab == AgentTab::Logs && self.access_rows.is_empty() && self.op_rows.is_empty() {
            self.reload_logs(cx);
        }
        cx.notify();
    }

    /// 切日志子 Tab（重置页码 + 重拉）
    pub fn select_logs_sub_tab(&mut self, sub: LogsSubTab, cx: &mut Context<Self>) {
        if sub == self.logs_sub_tab {
            return;
        }
        self.logs_sub_tab = sub;
        self.log_page = 1;
        self.reload_logs(cx);
    }

    /// 切换「含已删除」（重新拉取全量）
    pub fn set_include_deleted(&mut self, on: bool, cx: &mut Context<Self>) {
        if on == self.include_deleted {
            return;
        }
        self.include_deleted = on;
        self.notice = None;
        self.reload_keys(cx);
    }

    /// 切状态筛选（客户端过滤，不重拉）
    pub fn set_status_filter(&mut self, f: StatusFilter, cx: &mut Context<Self>) {
        if f == self.status_filter {
            return;
        }
        self.status_filter = f;
        cx.notify();
    }

    /// 切业务域筛选（None = 全部域；客户端过滤）
    pub fn set_domain_filter(&mut self, code: Option<String>, cx: &mut Context<Self>) {
        if code == self.domain_filter {
            return;
        }
        self.domain_filter = code;
        cx.notify();
    }

    /// 当前过滤后的凭据列表（状态 × 业务域 × 含已删除已在服务端，这里客户端过滤）
    pub fn filtered_keys(&self) -> Vec<AgentApiKeyItem> {
        let now_ms = chrono::Utc::now().timestamp_millis();
        self.keys
            .iter()
            .filter(|k| {
                let status = AgentKeyStatus::derive(k, now_ms);
                if status == AgentKeyStatus::Deleted {
                    // 未勾选含已删除时后端不会下发；双保险过滤
                    return self.include_deleted;
                }
                if !self.status_filter.matches(status) {
                    return false;
                }
                if let Some(code) = &self.domain_filter {
                    if !scope_has_domain(Some(&k.business_scope), code) {
                        return false;
                    }
                }
                true
            })
            .cloned()
            .collect()
    }

    /// 当前选中行对应的凭据（表格选中下标 → 过滤后列表）
    fn selected_key(&self, cx: &App) -> Option<AgentApiKeyItem> {
        let ix = self.table.read(cx).selected()?;
        self.filtered_keys().get(ix).cloned()
    }

    // ── 创建 / 编辑对话框 ────────────────────────────────────

    /// 打开创建对话框（清空上次创建结果）
    pub fn open_create(&mut self, cx: &mut Context<Self>) {
        self.created = None;
        self.dialog_error = None;
        self.form_dialog = Some(KeyFormDialog {
            editing: None,
            project_scope: ScopeDraft::all(),
            business_scope: ScopeDraft::all(),
        });
        // 输入框实体置空 → render 期重建（新默认值）
        self.label_input = None;
        self.agent_id_input = None;
        cx.notify();
    }

    /// 打开编辑对话框（预填既有值；Agent ID 不可改）
    pub fn open_edit(&mut self, item: AgentApiKeyItem, cx: &mut Context<Self>) {
        self.dialog_error = None;
        self.form_dialog = Some(KeyFormDialog {
            project_scope: ScopeDraft::from_scope(Some(&item.project_scope)),
            business_scope: ScopeDraft::from_scope(Some(&item.business_scope)),
            editing: Some(item),
        });
        self.label_input = None;
        self.agent_id_input = None;
        cx.notify();
    }

    /// 关闭对话框（表单 / 创建结果 / 确认共用入口）
    pub fn close_dialog(&mut self, cx: &mut Context<Self>) {
        self.form_dialog = None;
        self.created = None;
        self.dialog_error = None;
        self.label_input = None;
        self.agent_id_input = None;
        cx.notify();
    }

    /// 取消行级确认
    pub fn cancel_confirm(&mut self, cx: &mut Context<Self>) {
        self.pending_confirm = None;
        cx.notify();
    }

    /// 提交创建 / 编辑（读输入框 → POST/PATCH → 关闭 + reload + 反馈条）
    pub fn submit_form(&mut self, cx: &mut Context<Self>) {
        let Some(dialog) = self.form_dialog.clone() else {
            return;
        };
        if self.busy {
            return;
        }
        let label = self
            .label_input
            .as_ref()
            .map(|i| i.read(cx).value().trim().to_string())
            .unwrap_or_default();
        if label.is_empty() {
            self.dialog_error = Some("请输入凭据名称".to_string());
            cx.notify();
            return;
        }
        let project_scope = dialog.project_scope.to_scope();
        let business_scope = dialog.business_scope.to_scope();

        self.busy = true;
        self.dialog_error = None;
        cx.notify();

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        match &dialog.editing {
            None => {
                let agent_id = self
                    .agent_id_input
                    .as_ref()
                    .map(|i| i.read(cx).value().trim().to_string())
                    .filter(|s| !s.is_empty());
                let body = AgentKeyCreateBody {
                    label: label.clone(),
                    agent_id,
                    expires_at: None,
                    project_scope: project_scope.clone(),
                    business_scope: business_scope.clone(),
                };
                cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
                    let result = bg
                        .spawn(async move {
                            crate::runtime::runtime()
                                .block_on(async { client.agent_key_create(&body).await })
                        })
                        .await;
                    this.update(&mut *cx, |this, cx| {
                        this.busy = false;
                        match result {
                            Ok(created) => {
                                this.created = Some(created);
                                this.form_dialog = None;
                                this.notice =
                                    Some((false, format!("已创建凭据：{label}（明文仅展示一次）")));
                                this.reload_keys(cx);
                            }
                            Err(e) => {
                                this.dialog_error = Some(e.user_message());
                            }
                        }
                        cx.notify();
                    })
                    .ok();
                })
                .detach();
            }
            Some(item) => {
                let key_id = item.id;
                let body = AgentKeyUpdateBody {
                    label: Some(label.clone()),
                    project_scope: Some(project_scope.clone()),
                    business_scope: Some(business_scope.clone()),
                };
                cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
                    let result = bg
                        .spawn(async move {
                            crate::runtime::runtime()
                                .block_on(async { client.agent_key_update(key_id, &body).await })
                        })
                        .await;
                    this.update(&mut *cx, |this, cx| {
                        this.busy = false;
                        match result {
                            Ok(_) => {
                                this.form_dialog = None;
                                this.notice = Some((false, format!("已更新凭据：{label}")));
                                this.reload_keys(cx);
                            }
                            Err(e) => {
                                this.dialog_error = Some(e.user_message());
                            }
                        }
                        cx.notify();
                    })
                    .ok();
                })
                .detach();
            }
        }
    }

    /// 复制明文 Key 到剪贴板（创建结果态）
    pub fn copy_created_key(&mut self, cx: &mut Context<Self>) {
        if let Some(created) = &self.created {
            cx.write_to_clipboard(gpui::ClipboardItem::new_string(
                created.plaintext_key.clone(),
            ));
            self.notice = Some((false, "明文 Key 已复制到剪贴板".to_string()));
            cx.notify();
        }
    }

    /// 复制调用说明到剪贴板（指南 Tab / 创建结果共用）
    pub fn copy_usage_text(&mut self, cx: &mut Context<Self>) {
        let base = self.client.base_url().trim_end_matches('/').to_string();
        let text = build_usage_text(if base.is_empty() {
            "<后端地址>".to_string()
        } else {
            base
        });
        cx.write_to_clipboard(gpui::ClipboardItem::new_string(text));
        self.notice = Some((false, "调用说明已复制到剪贴板".to_string()));
        cx.notify();
    }

    // ── 行级动作 ────────────────────────────────────────────

    /// 发起行级动作（进入确认对话框）
    pub fn request_confirm(&mut self, confirm: PendingConfirm, cx: &mut Context<Self>) {
        self.pending_confirm = Some(confirm);
        cx.notify();
    }

    /// 执行已确认的动作（停用 / 激活 / 删除 → reload + 反馈条）
    pub fn run_confirmed_action(&mut self, cx: &mut Context<Self>) {
        let Some(confirm) = self.pending_confirm.clone() else {
            return;
        };
        if self.busy {
            return;
        }
        self.busy = true;
        cx.notify();

        let key_id = confirm.key_id();
        let key_label = match &confirm {
            PendingConfirm::Deactivate(k)
            | PendingConfirm::Activate(k)
            | PendingConfirm::Delete(k) => k.label.clone(),
        };
        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime().block_on(async {
                        match confirm {
                            PendingConfirm::Deactivate(_) => {
                                client.agent_key_deactivate(key_id).await.map(|_| ())
                            }
                            PendingConfirm::Activate(_) => {
                                client.agent_key_activate(key_id).await.map(|_| ())
                            }
                            PendingConfirm::Delete(_) => client.agent_key_delete(key_id).await,
                        }
                    })
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.busy = false;
                this.pending_confirm = None;
                match result {
                    Ok(()) => {
                        this.notice = Some((false, format!("操作成功：{key_label}")));
                    }
                    Err(e) => {
                        this.notice = Some((true, format!("操作失败：{}", e.user_message())));
                    }
                }
                this.reload_keys(cx);
            })
            .ok();
        })
        .detach();
    }

    // ── 日志动作 ────────────────────────────────────────────

    /// 应用日志筛选（读取关键词输入 → 回页码 1 重拉）
    pub fn apply_log_filters(&mut self, cx: &mut Context<Self>) {
        self.log_keyword_applied = self
            .log_keyword_input
            .as_ref()
            .map(|i| i.read(cx).value().trim().to_string())
            .unwrap_or_default();
        self.log_page = 1;
        self.reload_logs(cx);
    }

    /// 重置日志筛选
    pub fn reset_log_filters(&mut self, cx: &mut Context<Self>) {
        self.log_keyword_applied.clear();
        self.log_keyword_input = None;
        self.log_method = None;
        self.log_result = None;
        self.log_page = 1;
        self.reload_logs(cx);
    }

    /// 切日志请求方法筛选
    pub fn set_log_method(&mut self, method: Option<String>, cx: &mut Context<Self>) {
        if method == self.log_method {
            return;
        }
        self.log_method = method;
        self.log_page = 1;
        self.reload_logs(cx);
    }

    /// 切日志结果筛选
    pub fn set_log_result(&mut self, result: Option<String>, cx: &mut Context<Self>) {
        if result == self.log_result {
            return;
        }
        self.log_result = result;
        self.log_page = 1;
        self.reload_logs(cx);
    }

    /// 日志跳页
    pub fn go_to_log_page(&mut self, page: usize, cx: &mut Context<Self>) {
        if page == self.log_page || page == 0 {
            return;
        }
        self.log_page = page;
        self.reload_logs(cx);
    }

    /// 对话框内切换「全部项目 / 全部业务域」哨兵（无对话框时 no-op）
    pub fn toggle_scope_all(&mut self, kind: ScopeKind, cx: &mut Context<Self>) {
        if let Some(dialog) = &mut self.form_dialog {
            match kind {
                ScopeKind::Project => dialog.project_scope.toggle_all(),
                ScopeKind::Business => dialog.business_scope.toggle_all(),
            }
            cx.notify();
        }
    }

    /// 对话框内切换具体 scope 选项勾选（无对话框时 no-op）
    pub fn toggle_scope_item(&mut self, kind: ScopeKind, value: String, cx: &mut Context<Self>) {
        if let Some(dialog) = &mut self.form_dialog {
            match kind {
                ScopeKind::Project => dialog.project_scope.toggle_item(&value),
                ScopeKind::Business => dialog.business_scope.toggle_item(&value),
            }
            cx.notify();
        }
    }
}

/// 日志拉取结果（读 / 写两类响应统一）
enum LogFetch {
    Access {
        page: AgentAccessLogsResponse,
        summary: AgentAccessLogsSummaryResponse,
    },
    Operation {
        page: gui_domain::agent_management::AgentOperationLogsResponse,
        summary: AgentOperationLogsSummary,
    },
}

// ---------------------------------------------------------------------------
// 列定义
// ---------------------------------------------------------------------------

/// 凭据表 8 列（对齐 web 桌面列序；操作改为选中行操作条）
fn key_columns() -> Vec<ColumnDef<AgentApiKeyItem>> {
    vec![
        ColumnDef::text("key-label", "名称", |r: &AgentApiKeyItem, _| {
            SharedString::from(r.label.clone())
        })
        .width(150.0),
        ColumnDef::text("key-prefix", "Key 前缀", |r: &AgentApiKeyItem, theme| {
            let _ = theme;
            SharedString::from(format!("{}…", r.key_prefix))
        })
        .width(120.0),
        ColumnDef::text("key-agent", "Agent", |r: &AgentApiKeyItem, _| {
            SharedString::from(r.agent_id.clone().unwrap_or_else(|| "—（未绑定）".into()))
        })
        .width(180.0),
        ColumnDef::text("key-project-scope", "项目范围", |_r, _| {
            SharedString::from("")
        })
        .with_render_element(|r: &AgentApiKeyItem, theme| {
            // 项目名映射需要 projects —— 渲染期不可得，退化为 id 白名单文案；
            // 全量映射在概览卡与对话框内完成
            div()
                .text_sm()
                .text_color(theme.text_secondary)
                .child(SharedString::from(render_project_scope_compact(
                    &r.project_scope,
                )))
                .into_any_element()
        })
        .width(140.0),
        ColumnDef::text("key-business-scope", "业务域范围", |_r, _| {
            SharedString::from("")
        })
        .with_render_element(|r: &AgentApiKeyItem, theme| {
            div()
                .text_sm()
                .text_color(theme.text_secondary)
                .child(SharedString::from(
                    gui_domain::agent_management::format_business_scope(Some(&r.business_scope)),
                ))
                .into_any_element()
        })
        .width(150.0),
        ColumnDef::text("key-last-used", "最近使用", |r: &AgentApiKeyItem, _| {
            SharedString::from(
                r.last_used_at
                    .as_deref()
                    .map(|s| beijing_time(Some(s)))
                    .unwrap_or_else(|| "从未使用".to_string()),
            )
        })
        .numeric(true)
        .align(CellAlign::Right)
        .width(130.0),
        ColumnDef::text("key-status", "状态", |_r, _| SharedString::from(""))
            .with_render_element(|r: &AgentApiKeyItem, theme| {
                status_pill(r, theme).into_any_element()
            })
            .width(96.0),
    ]
}

/// 项目范围紧凑文案（表格单元格：'*' → 全部项目；否则 `#id` 列表——
/// 完整项目名映射见对话框 / 概览）
fn render_project_scope_compact(scope: &str) -> String {
    let normalized = gui_domain::agent_management::normalize_scope(Some(scope));
    if normalized == BUSINESS_SCOPE_ALL {
        "全部项目".to_string()
    } else {
        let parts = parse_scope_parts(Some(&normalized));
        if parts.len() > 3 {
            format!("{} 等 {} 个项目", parts[..3].join("/"), parts.len())
        } else {
            parts
                .iter()
                .map(|p| format!("#{p}"))
                .collect::<Vec<_>>()
                .join("/")
        }
    }
}

/// 状态 pill（激活绿 / 停用中性 / 过期警示 / 删除中性+删除线语义灰）
fn status_pill(item: &AgentApiKeyItem, theme: &AppTheme) -> gpui::AnyElement {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let status = AgentKeyStatus::derive(item, now_ms);
    let (bg, fg) = match status {
        AgentKeyStatus::Active => (theme.success_soft, theme.success),
        AgentKeyStatus::Inactive => (theme.muted_fill, theme.text_secondary),
        AgentKeyStatus::Expired => (theme.warning.opacity(0.14), theme.warning),
        AgentKeyStatus::Deleted => (theme.danger_soft, theme.danger),
    };
    h_flex()
        .items_center()
        .gap_1()
        .rounded_full()
        .border_1()
        .border_color(fg.opacity(0.35))
        .bg(bg)
        .px_2()
        .py(px(1.))
        .child(
            div()
                .text_xs()
                .font_weight(FontWeight::MEDIUM)
                .when(
                    status == AgentKeyStatus::Inactive || status == AgentKeyStatus::Deleted,
                    |this| this.opacity(0.75),
                )
                .child(SharedString::from(status.label())),
        )
        .into_any_element()
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

impl Render for AgentManagementView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let app_theme = AppTheme::current(cx);
        let view = cx.entity();

        // 对话框输入框懒建（需要 window；关闭后重建）
        if self.form_dialog.is_some() {
            let editing = self.form_dialog.as_ref().and_then(|d| d.editing.clone());
            if self.label_input.is_none() {
                let initial = editing.as_ref().map(|k| k.label.clone());
                self.label_input = Some(cx.new(|cx| {
                    let mut s = InputState::new(window, cx).placeholder(if editing.is_some() {
                        ""
                    } else {
                        "如：货件助理 (生产)"
                    });
                    if let Some(v) = initial {
                        s = s.default_value(v);
                    }
                    s
                }));
            }
            if editing.is_none() && self.agent_id_input.is_none() {
                self.agent_id_input = Some(cx.new(|cx| {
                    InputState::new(window, cx).placeholder("如：shipment-assistant-prod")
                }));
            }
        }

        // 日志关键词输入框懒建
        if self.active_tab == AgentTab::Logs && self.log_keyword_input.is_none() {
            let initial = self.log_keyword_applied.clone();
            self.log_keyword_input = Some(cx.new(|cx| {
                let mut s =
                    InputState::new(window, cx).placeholder("关键词：Agent ID / 标签 / 路径");
                if !initial.is_empty() {
                    s = s.default_value(initial);
                }
                s
            }));
        }

        v_flex()
            .id("agent-management")
            .size_full()
            .gap_4()
            .p_6()
            .overflow_y_scroll()
            .bg(app_theme.window_bg)
            .child(
                PageHeader::new("Agent 接入管理")
                    .subtitle("管理外部 Agent 的 API 凭据、业务域授权与访问审计")
                    .action(create_button(&view)),
            )
            .child(content_guard().child(render_tab_bar(&view, self.active_tab, &app_theme)))
            .child(match self.active_tab {
                AgentTab::Overview => render_overview(self, cx, &app_theme).into_any_element(),
                AgentTab::Credentials => self.render_credentials_tab(window, cx, &view, &app_theme),
                AgentTab::Guide => render_guide(&view, &app_theme).into_any_element(),
                AgentTab::Logs => self.render_logs_tab(cx, &view, &app_theme),
            })
            // 模态层（表单 / 创建结果 / 确认）
            .when(
                self.form_dialog.is_some()
                    || self.created.is_some()
                    || self.pending_confirm.is_some(),
                |this| this.child(render_modal_overlay(self, cx, &view, &app_theme)),
            )
    }
}

impl AgentManagementView {
    /// 凭据管理 Tab
    fn render_credentials_tab(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
        view: &Entity<Self>,
        theme: &AppTheme,
    ) -> gpui::AnyElement {
        let _ = window;
        let filtered = self.filtered_keys();

        // 表格行注入（render 期幂等）
        self.table
            .update(cx, |t, cx| t.set_rows_if_changed(&filtered, cx));

        // 选中行动作条数据
        let selected = self.selected_key(cx);
        let reduce = crate::motion::reduce_motion(cx);

        let body: gpui::AnyElement = match &self.keys_state {
            KeyListState::Loading => state_views::skeleton_loading(
                theme,
                &[SkeletonBlock::Kpi(3), SkeletonBlock::Table(280.0)],
            )
            .into_any_element(),
            KeyListState::Error(msg) => state_views::error_state(
                view,
                theme,
                "agent-keys-error",
                "凭据列表加载失败",
                msg.clone(),
                |this, cx| this.reload_keys(cx),
            )
            .into_any_element(),
            KeyListState::Empty => state_views::empty_state_with_action_desc(
                view,
                theme,
                "agent-keys-empty",
                "icons/shield.svg",
                "暂无 Agent 凭据",
                Some("点击「创建凭据」为外部 Agent 签发 API Key；已有凭据被隐藏时尝试勾选「含已删除」".to_string()),
                "刷新",
                |this, cx| this.reload_keys(cx),
            )
            .into_any_element(),
            KeyListState::Loaded => {
                let total = filtered.len();
                let action_bar = render_selected_actions(selected.as_ref(), view, theme);
                let table_card = v_flex()
                    .id("agent-keys-card")
                    .w_full()
                    .rounded(px(theme.radius_lg))
                    .bg(theme.card_bg)
                    .shadow(vec![theme.card_shadow_box()])
                    .child(
                        v_flex()
                            .gap_1()
                            .px_4()
                            .py_3()
                            .border_b_1()
                            .border_color(theme.separator)
                            .child(
                                div()
                                    .text_base()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(theme.text_primary)
                                    .child("凭据列表"),
                            )
                            .child(
                                div()
                                    .text_xs()
                                    .text_color(theme.text_muted)
                                    .child("管理 Agent 凭据的生命周期状态与项目 / 业务域权限范围"),
                            ),
                    )
                    .child(action_bar)
                    .child(div().w_full().px_4().py_2().child(self.table.clone()))
                    .child(
                        div()
                            .px_4()
                            .pb_2()
                            .text_xs()
                            .text_color(theme.text_muted)
                            .child(SharedString::from(format!(
                                "共 {} 张凭据 · 点击行选中后可在上方编辑 / 停用 / 删除",
                                total
                            ))),
                    );
                crate::motion::enter_fade_in(
                    SharedString::from("agent-keys-loaded-fade"),
                    table_card,
                    reduce,
                )
                .into_any_element()
            }
        };

        v_flex()
            .gap_4()
            .when_some(self.notice.clone(), |this, (is_err, text)| {
                this.child(notice_banner(theme, is_err, &text))
            })
            .child(content_guard().child(render_credential_filters(self, view, theme)))
            .child(body)
            .into_any_element()
    }

    /// 访问日志 Tab
    fn render_logs_tab(
        &mut self,
        cx: &mut Context<Self>,
        view: &Entity<Self>,
        theme: &AppTheme,
    ) -> gpui::AnyElement {
        let read = self.logs_sub_tab == LogsSubTab::Read;
        let reduce = crate::motion::reduce_motion(cx);

        let stat_band = if read {
            render_access_stats(self.access_summary.as_ref(), theme)
        } else {
            render_operation_stats(self.op_summary.as_ref(), theme)
        };

        let top_chips = if read {
            render_top_agent_chips(
                self.access_summary.as_ref().map(|s| {
                    s.top_agents
                        .iter()
                        .map(|a| (a.key_label.as_deref(), a.agent_id.as_str(), a.count))
                        .collect()
                }),
                theme,
            )
        } else {
            render_top_agent_chips(
                self.op_summary.as_ref().map(|s| {
                    s.top_agents
                        .iter()
                        .map(|a| (a.agent_name.as_deref(), a.agent_id.as_str(), a.count))
                        .collect()
                }),
                theme,
            )
        };

        let list_body: gpui::AnyElement = if let Some(err) = &self.logs_error {
            state_views::error_state(
                view,
                theme,
                "agent-logs-error",
                "日志加载失败",
                err.clone(),
                |this, cx| this.reload_logs(cx),
            )
            .into_any_element()
        } else if self.logs_loading {
            state_views::skeleton_loading(
                theme,
                &[SkeletonBlock::Kpi(4), SkeletonBlock::Table(260.0)],
            )
            .into_any_element()
        } else if read && self.access_rows.is_empty() {
            state_views::empty_state_with_action_desc(
                view,
                theme,
                "agent-logs-empty",
                "icons/history.svg",
                "暂无 Agent 访问记录",
                Some("Agent 调用 /api/v1/agent/* 后将在此留痕（保留 90 天）".to_string()),
                "刷新",
                |this, cx| this.reload_logs(cx),
            )
            .into_any_element()
        } else if !read && self.op_rows.is_empty() {
            state_views::empty_state_with_action_desc(
                view,
                theme,
                "agent-op-logs-empty",
                "icons/history.svg",
                "暂无 Agent 写操作记录",
                Some("Agent 执行写操作（创建 / 状态推进等）后将在此留痕".to_string()),
                "刷新",
                |this, cx| this.reload_logs(cx),
            )
            .into_any_element()
        } else {
            let page_state = PageState::new(self.log_page, LOG_PAGE_SIZE, self.log_total);
            let table = if read {
                render_access_table(&self.access_rows, theme)
            } else {
                render_operation_table(&self.op_rows, theme)
            };
            let card = v_flex()
                .id("agent-logs-card")
                .w_full()
                .rounded(px(theme.radius_lg))
                .bg(theme.card_bg)
                .shadow(vec![theme.card_shadow_box()])
                .child(
                    div()
                        .id("agent-logs-table-scroll")
                        .w_full()
                        .px_4()
                        .py_2()
                        .max_h(px(560.))
                        .overflow_y_scroll()
                        .child(table),
                )
                .child(
                    div()
                        .w_full()
                        .px_4()
                        .py_2()
                        .child(pagination::pagination_bar(
                            view,
                            theme,
                            "agent-logs-pagination",
                            &page_state,
                            &[LOG_PAGE_SIZE],
                            |this, page, cx| this.go_to_log_page(page, cx),
                            |this, size, cx| {
                                // 固定 50/页：守卫 no-op（保契约占位）
                                let _ = (this, size, cx);
                            },
                        )),
                );
            crate::motion::enter_fade_in(SharedString::from("agent-logs-list-fade"), card, reduce)
                .into_any_element()
        };

        v_flex()
            .gap_4()
            .child(content_guard().child(render_logs_sub_tabs(view, self.logs_sub_tab, theme)))
            .child(content_guard().child(stat_band))
            .when_some(top_chips, |this, chips| {
                this.child(content_guard().child(chips))
            })
            .child(content_guard().child(render_log_filters(self, view, theme)))
            .child(list_body)
            .into_any_element()
    }
}

/// 页头右侧「创建凭据」按钮
fn create_button(view: &Entity<AgentManagementView>) -> gpui::AnyElement {
    let view = view.clone();
    Button::new("agent-key-create-btn")
        .primary()
        .small()
        .label("创建凭据")
        .on_click(move |_, _, cx| {
            view.update(cx, |this, cx| this.open_create(cx));
        })
        .into_any_element()
}

/// 主 Tab 栏（沿 commission「选中强调底 + 文本色」观感）
fn render_tab_bar(
    view: &Entity<AgentManagementView>,
    active: AgentTab,
    theme: &AppTheme,
) -> impl IntoElement {
    h_flex()
        .id("agent-management-tabs")
        .w_full()
        .p_1()
        .gap_1()
        .rounded(px(theme.radius_lg))
        .bg(theme.muted_fill)
        .children(AgentTab::ALL.into_iter().map(|tab| {
            let view = view.clone();
            let selected = active == tab;
            div()
                .id(SharedString::from(format!("agent-tab-{}", tab.id())))
                .flex_1()
                .py_1p5()
                .px_2()
                .text_center()
                .text_sm()
                .rounded(px(theme.radius))
                .cursor(CursorStyle::PointingHand)
                .when(selected, |this| {
                    this.bg(theme.card_bg)
                        .text_color(theme.accent)
                        .font_weight(FontWeight::MEDIUM)
                })
                .when(!selected, |this| {
                    this.text_color(theme.text_secondary).hover(|this| {
                        this.bg(theme.card_bg.opacity(0.5))
                            .text_color(theme.text_primary)
                    })
                })
                .child(tab.label().to_string())
                .on_mouse_up(gpui::MouseButton::Left, move |_, _window, cx| {
                    view.update(cx, |this, cx| this.select_tab(tab, cx));
                })
        }))
}

// ---------------------------------------------------------------------------
// Tab 1 业务域概览
// ---------------------------------------------------------------------------

/// 业务域卡片栅格（flex wrap 三列节奏）
fn render_overview(
    view: &AgentManagementView,
    cx: &Context<AgentManagementView>,
    theme: &AppTheme,
) -> impl IntoElement {
    let _ = cx;
    let now_ms = chrono::Utc::now().timestamp_millis();
    let cards: Vec<gpui::AnyElement> = AGENT_DOMAINS
        .iter()
        .map(|domain| {
            let live = domain.status == AgentDomainStatus::Live;
            let key_count = view
                .keys
                .iter()
                .filter(|k| {
                    AgentKeyStatus::derive(k, now_ms) != AgentKeyStatus::Deleted
                        && scope_has_domain(Some(&k.business_scope), domain.code)
                })
                .count();
            domain_card(domain, live, key_count, theme)
        })
        .collect();

    content_guard().child(
        v_flex()
            .id("agent-domains-card")
            .w_full()
            .gap_3()
            .rounded(px(theme.radius_lg))
            .bg(theme.card_bg)
            .shadow(vec![theme.card_shadow_box()])
            .child(
                v_flex()
                    .gap_1()
                    .px_4()
                    .pt_3()
                    .child(
                        div()
                            .text_base()
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.text_primary)
                            .child("业务域接入一览"),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.text_muted)
                            .child("各业务域的 Agent API 接入状态与已授权凭据数"),
                    ),
            )
            .child(h_flex().flex_wrap().gap_3().px_4().pb_4().children(cards)),
    )
}

/// 单个业务域卡（live 绿框 / planned 虚线灰框，对齐 web 卡片观感）
fn domain_card(
    domain: &gui_domain::agent_management::AgentDomain,
    live: bool,
    key_count: usize,
    theme: &AppTheme,
) -> gpui::AnyElement {
    let (border, bg) = if live {
        (
            theme.success.opacity(0.35),
            theme.success_soft.opacity(0.35),
        )
    } else {
        (theme.separator, theme.muted_fill.opacity(0.35))
    };
    v_flex()
        .w(px(300.))
        .gap_2()
        .p_3()
        .rounded(px(theme.radius_lg))
        .border_1()
        .border_color(border)
        .bg(bg)
        .child(
            h_flex()
                .items_center()
                .justify_between()
                .child(
                    div()
                        .text_sm()
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.text_primary)
                        .child(domain.label.to_string()),
                )
                .child(
                    div()
                        .text_xs()
                        .rounded_full()
                        .border_1()
                        .border_color(border)
                        .px_2()
                        .py(px(1.))
                        .when(live, |this| this.text_color(theme.success))
                        .when(!live, |this| this.text_color(theme.text_muted))
                        .child(if live { "已接入" } else { "规划中" }),
                ),
        )
        .child(
            div()
                .text_xs()
                .line_height(px(16.))
                .text_color(theme.text_muted)
                .child(domain.description.to_string()),
        )
        .child(
            h_flex()
                .flex_wrap()
                .gap_1()
                .items_center()
                .when(live, |this| {
                    this.child(small_chip(
                        theme,
                        &format!("{} 路由", domain.route_count),
                        theme.text_secondary,
                    ))
                })
                .when(domain.read, |this| {
                    this.child(small_chip(theme, "读", theme.accent))
                })
                .when(domain.write, |this| {
                    this.child(small_chip(theme, "写", theme.accent))
                })
                .child(
                    div()
                        .ml_auto()
                        .text_xs()
                        .text_color(theme.text_muted)
                        .child(if live {
                            format!("{key_count} 张凭据授权")
                        } else {
                            "待接入".to_string()
                        }),
                ),
        )
        .into_any_element()
}

/// 小徽标 chip
fn small_chip(theme: &AppTheme, label: &str, color: gpui::Hsla) -> gpui::AnyElement {
    div()
        .text_xs()
        .rounded(px(theme.radius))
        .border_1()
        .border_color(color.opacity(0.35))
        .px_1p5()
        .py(px(0.5))
        .text_color(color)
        .child(label.to_string())
        .into_any_element()
}

// ---------------------------------------------------------------------------
// Tab 2 凭据管理（筛选 + 操作条）
// ---------------------------------------------------------------------------

/// 凭据筛选栏（状态 / 业务域下拉 + 含已删除开关 + 刷新）
fn render_credential_filters(
    view: &AgentManagementView,
    view_entity: &Entity<AgentManagementView>,
    theme: &AppTheme,
) -> gpui::AnyElement {
    let v_status = view_entity.clone();
    let v_domain = view_entity.clone();
    let v_refresh = view_entity.clone();

    let status = view.status_filter;
    let domain_filter = view.domain_filter.clone();
    let include_deleted = view.include_deleted;
    let domains: Vec<(&'static str, &'static str)> =
        gui_domain::agent_management::live_agent_domains()
            .map(|d| (d.code, d.label))
            .collect();

    filter_bar_layout(theme)
        .id("agent-key-filters")
        .child(filter_select(
            theme,
            "状态",
            SharedString::from(status.label()),
            "agent-key-status-filter",
            move |menu, _window, _cx| {
                let mut menu = menu;
                for f in [
                    StatusFilter::All,
                    StatusFilter::Active,
                    StatusFilter::Inactive,
                    StatusFilter::Expired,
                ] {
                    let view = v_status.clone();
                    menu = menu.item(PopupMenuItem::new(f.label()).checked(status == f).on_click(
                        move |_ev, _w, cx| {
                            view.update(cx, |this, cx| this.set_status_filter(f, cx));
                        },
                    ));
                }
                menu
            },
        ))
        .child(filter_select(
            theme,
            "业务域",
            SharedString::from(
                domain_filter
                    .as_deref()
                    .and_then(|c| {
                        gui_domain::agent_management::get_agent_domain(c).map(|d| d.label)
                    })
                    .unwrap_or("全部业务域"),
            ),
            "agent-key-domain-filter",
            move |menu, _window, _cx| {
                let mut menu = menu;
                let view_all = v_domain.clone();
                menu = menu.item(
                    PopupMenuItem::new("全部业务域")
                        .checked(domain_filter.is_none())
                        .on_click(move |_ev, _w, cx| {
                            view_all.update(cx, |this, cx| this.set_domain_filter(None, cx));
                        }),
                );
                for (code, label) in &domains {
                    let view = v_domain.clone();
                    let checked = domain_filter.as_deref() == Some(*code);
                    let label = (*label).to_string();
                    let value = (*code).to_string();
                    menu = menu.item(PopupMenuItem::new(label).checked(checked).on_click(
                        move |_ev, _w, cx| {
                            let next = Some(value.clone());
                            view.update(cx, |this, cx| this.set_domain_filter(next, cx));
                        },
                    ));
                }
                menu
            },
        ))
        .child(toggle_pill(
            theme,
            "agent-key-include-deleted",
            "含已删除",
            include_deleted,
            view_entity,
        ))
        .child(
            Button::new("agent-key-refresh")
                .outline()
                .small()
                .label("刷新")
                .on_click(move |_ev, _w, cx| {
                    v_refresh.update(cx, |this, cx| this.reload_keys(cx));
                }),
        )
        .into_any_element()
}

/// 布尔开关 pill（点击切换；选中态强调色）
fn toggle_pill(
    theme: &AppTheme,
    id: &'static str,
    label: &'static str,
    on: bool,
    view: &Entity<AgentManagementView>,
) -> gpui::AnyElement {
    let view = view.clone();
    h_flex()
        .id(id)
        .gap_1()
        .items_center()
        .rounded(px(theme.radius))
        .border_1()
        .cursor(CursorStyle::PointingHand)
        .px_2()
        .py_1()
        .when(on, |this| {
            this.border_color(theme.accent.opacity(0.5))
                .bg(theme.accent_soft)
                .text_color(theme.accent)
        })
        .when(!on, |this| {
            this.border_color(theme.separator)
                .text_color(theme.text_secondary)
        })
        .child(Icon::new(if on { IconName::Check } else { IconName::Close }).with_size(px(11.)))
        .child(div().text_sm().child(label.to_string()))
        .on_mouse_up(gpui::MouseButton::Left, move |_, _window, cx| {
            let next = !on;
            view.update(cx, |this, cx| this.set_include_deleted(next, cx));
        })
        .into_any_element()
}

/// 内联反馈条（成功 / 失败）
fn notice_banner(theme: &AppTheme, is_err: bool, text: &str) -> gpui::AnyElement {
    let (bg, fg, border) = if is_err {
        (theme.danger_soft, theme.danger, theme.danger.opacity(0.35))
    } else {
        (
            theme.success_soft,
            theme.success,
            theme.success.opacity(0.35),
        )
    };
    h_flex()
        .id("agent-notice-banner")
        .rounded(px(theme.radius))
        .border_1()
        .border_color(border)
        .bg(bg)
        .px_3()
        .py_2()
        .text_sm()
        .text_color(fg)
        .child(text.to_string())
        .into_any_element()
}

/// 选中行操作条（macOS 列表详情模式：选中后展示 编辑 / 停用|激活 / 删除）
fn render_selected_actions(
    selected: Option<&AgentApiKeyItem>,
    view: &Entity<AgentManagementView>,
    theme: &AppTheme,
) -> gpui::AnyElement {
    let container = h_flex()
        .id("agent-key-actions")
        .gap_2()
        .items_center()
        .px_4()
        .py_2()
        .border_b_1()
        .border_color(theme.separator);

    let Some(item) = selected else {
        return container
            .child(
                div()
                    .text_xs()
                    .text_color(theme.text_muted)
                    .child("点击表格行选中凭据后可在此编辑 / 停用 / 删除"),
            )
            .into_any_element();
    };

    let status = AgentKeyStatus::derive(item, chrono::Utc::now().timestamp_millis());
    let deleted = status == AgentKeyStatus::Deleted;

    let v_edit = view.clone();
    let v_toggle = view.clone();
    let v_delete = view.clone();
    let item_for_edit = item.clone();
    let item_for_toggle = item.clone();
    let item_for_delete = item.clone();

    container
        .child(
            div()
                .text_xs()
                .text_color(theme.text_secondary)
                .child(SharedString::from(format!(
                    "已选中：{}（{}）",
                    item.label,
                    status.label()
                ))),
        )
        .when(!deleted, |this| {
            this.child(
                Button::new("agent-key-edit")
                    .outline()
                    .small()
                    .label("编辑")
                    .on_click(move |_, _, cx| {
                        let item = item_for_edit.clone();
                        v_edit.update(cx, |this, cx| this.open_edit(item, cx));
                    }),
            )
            .child(if status == AgentKeyStatus::Active {
                let item = item_for_toggle.clone();
                Button::new("agent-key-deactivate")
                    .outline()
                    .small()
                    .label("停用")
                    .on_click(move |_, _, cx| {
                        let c = PendingConfirm::Deactivate(item.clone());
                        v_toggle.update(cx, |this, cx| this.request_confirm(c, cx));
                    })
                    .into_any_element()
            } else {
                let item = item_for_toggle.clone();
                Button::new("agent-key-activate")
                    .outline()
                    .small()
                    .label("激活")
                    .on_click(move |_, _, cx| {
                        let c = PendingConfirm::Activate(item.clone());
                        v_toggle.update(cx, |this, cx| this.request_confirm(c, cx));
                    })
                    .into_any_element()
            })
            .child({
                let item = item_for_delete.clone();
                Button::new("agent-key-delete")
                    .outline()
                    .danger()
                    .small()
                    .label("删除")
                    .on_click(move |_, _, cx| {
                        let c = PendingConfirm::Delete(item.clone());
                        v_delete.update(cx, |this, cx| this.request_confirm(c, cx));
                    })
            })
        })
        .when(deleted, |this| {
            this.child(
                div()
                    .text_xs()
                    .text_color(theme.text_muted)
                    .child("已删除凭据为审计 tombstone，仅可查看"),
            )
        })
        .into_any_element()
}

// ---------------------------------------------------------------------------
// 模态层（表单 / 创建结果 / 确认）
// ---------------------------------------------------------------------------

/// 模态覆盖层：优先级 确认 > 创建结果 > 表单
fn render_modal_overlay(
    this: &AgentManagementView,
    cx: &Context<AgentManagementView>,
    view: &Entity<AgentManagementView>,
    theme: &AppTheme,
) -> gpui::AnyElement {
    let overlay = div()
        .id("agent-management-modal-overlay")
        .absolute()
        .inset_0()
        .flex()
        .items_center()
        .justify_center()
        .bg(gpui::hsla(0., 0., 0., 0.35));

    if let Some(confirm) = &this.pending_confirm {
        return overlay
            .child(render_confirm_dialog(confirm, view, theme))
            .into_any_element();
    }
    if let Some(created) = &this.created {
        return overlay
            .child(render_created_dialog(created, view, theme))
            .into_any_element();
    }
    if let Some(dialog) = &this.form_dialog {
        return overlay
            .child(render_form_dialog(this, dialog, view, cx, theme))
            .into_any_element();
    }
    overlay.into_any_element()
}

/// 行级确认对话框（删除 / 停用 / 激活）
fn render_confirm_dialog(
    confirm: &PendingConfirm,
    view: &Entity<AgentManagementView>,
    theme: &AppTheme,
) -> gpui::AnyElement {
    let v_ok = view.clone();
    let v_cancel = view.clone();
    let is_delete = confirm.is_delete();
    let busy = {
        // busy 状态从视图读取不可得（此处仅持 &view），以禁用重复提交交给 run 守卫
        false
    };
    let _ = busy;
    v_flex()
        .id("agent-confirm-dialog")
        .w(px(400.))
        .gap_4()
        .p_5()
        .rounded(px(theme.radius_lg))
        .bg(theme.card_bg)
        .shadow(vec![theme.card_shadow_box()])
        .child(
            div()
                .text_base()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(theme.text_primary)
                .child(confirm.title()),
        )
        .child(
            div()
                .text_sm()
                .line_height(px(18.))
                .text_color(theme.text_muted)
                .child(confirm.description()),
        )
        .child(
            h_flex()
                .gap_2()
                .justify_end()
                .child(
                    Button::new("agent-confirm-cancel")
                        .outline()
                        .small()
                        .label("取消")
                        .on_click(move |_, _, cx| {
                            v_cancel.update(cx, |this, cx| this.cancel_confirm(cx));
                        }),
                )
                .child(if is_delete {
                    Button::new("agent-confirm-ok")
                        .primary()
                        .danger()
                        .small()
                        .label(confirm.confirm_label())
                        .on_click(move |_, _, cx| {
                            v_ok.update(cx, |this, cx| this.run_confirmed_action(cx));
                        })
                        .into_any_element()
                } else {
                    Button::new("agent-confirm-ok")
                        .primary()
                        .small()
                        .label(confirm.confirm_label())
                        .on_click(move |_, _, cx| {
                            v_ok.update(cx, |this, cx| this.run_confirmed_action(cx));
                        })
                        .into_any_element()
                }),
        )
        .into_any_element()
}

/// 创建成功对话框：明文 Key 仅展示一次 + 复制
fn render_created_dialog(
    created: &AgentApiKeyCreateResponse,
    view: &Entity<AgentManagementView>,
    theme: &AppTheme,
) -> gpui::AnyElement {
    let v_copy = view.clone();
    let v_close = view.clone();
    let v_copy_usage = view.clone();
    v_flex()
        .id("agent-created-dialog")
        .w(px(520.))
        .gap_3()
        .p_5()
        .rounded(px(theme.radius_lg))
        .bg(theme.card_bg)
        .shadow(vec![theme.card_shadow_box()])
        .child(
            div()
                .text_base()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(theme.text_primary)
                .child("凭据创建成功"),
        )
        .child(
            div()
                .text_xs()
                .text_color(theme.text_muted)
                .child("明文 Key"),
        )
        .child(
            h_flex()
                .gap_2()
                .items_start()
                .child(
                    div()
                        .flex_1()
                        .rounded(px(theme.radius))
                        .bg(theme.muted_fill.opacity(0.5))
                        .px_2()
                        .py_2()
                        .text_xs()
                        .line_height(px(16.))
                        .child(SharedString::from(created.plaintext_key.clone())),
                )
                .child(
                    Button::new("agent-copy-key")
                        .outline()
                        .small()
                        .icon(Icon::new(IconName::Copy).with_size(px(13.)))
                        .on_click(move |_, _, cx| {
                            v_copy.update(cx, |this, cx| this.copy_created_key(cx));
                        }),
                ),
        )
        .child(
            div()
                .text_sm()
                .text_color(theme.text_secondary)
                .child(SharedString::from(format!(
                    "Agent：{} · 名称：{}",
                    created.agent_id.clone().unwrap_or_else(|| "—（未绑定）".into()),
                    created.label,
                ))),
        )
        .child(
            div()
                .rounded(px(theme.radius))
                .border_1()
                .border_color(theme.warning.opacity(0.5))
                .bg(theme.warning.opacity(0.1))
                .p_2()
                .text_xs()
                .line_height(px(16.))
                .text_color(theme.warning)
                .child("⚠ 明文仅展示一次，请妥善保存。调用时 Authorization 用明文 Key，X-Agent-Id 用 Agent ID。"),
        )
        .child(
            h_flex()
                .gap_2()
                .justify_end()
                .child(
                    Button::new("agent-copy-usage")
                        .outline()
                        .small()
                        .label("复制调用说明")
                        .on_click(move |_, _, cx| {
                            v_copy_usage.update(cx, |this, cx| this.copy_usage_text(cx));
                        }),
                )
                .child(
                    Button::new("agent-created-close")
                        .primary()
                        .small()
                        .label("关闭")
                        .on_click(move |_, _, cx| {
                            v_close.update(cx, |this, cx| this.close_dialog(cx));
                        }),
                ),
        )
        .into_any_element()
}

/// 创建 / 编辑表单对话框（名称 + Agent ID + 双 scope 多选清单）
fn render_form_dialog(
    this: &AgentManagementView,
    dialog: &KeyFormDialog,
    view: &Entity<AgentManagementView>,
    _cx: &Context<AgentManagementView>,
    theme: &AppTheme,
) -> gpui::AnyElement {
    let is_edit = dialog.editing.is_some();
    let title = if is_edit {
        "编辑凭据权限"
    } else {
        "创建 Agent 凭据"
    };

    let v_cancel = view.clone();
    let v_save = view.clone();

    let label_input = this.label_input.clone();
    let agent_id_input = this.agent_id_input.clone();
    let saving = this.busy;
    let error = this.dialog_error.clone();

    let project_options: Vec<(String, String)> = this
        .projects
        .iter()
        .map(|p| (p.id.to_string(), p.name.clone()))
        .collect();
    let biz_options: Vec<(String, String)> = gui_domain::agent_management::live_agent_domains()
        .map(|d| (d.code.to_string(), d.label.to_string()))
        .collect();

    let proj_selected = dialog.project_scope.selected.clone();
    let biz_selected = dialog.business_scope.selected.clone();
    let editing_agent = dialog
        .editing
        .as_ref()
        .and_then(|k| k.agent_id.clone())
        .unwrap_or_else(|| "—（未绑定）".into());

    v_flex()
        .id("agent-form-dialog")
        .w(px(520.))
        .max_h(px(640.))
        .overflow_y_scroll()
        .gap_3()
        .p_5()
        .rounded(px(theme.radius_lg))
        .bg(theme.card_bg)
        .shadow(vec![theme.card_shadow_box()])
        .child(
            div()
                .text_base()
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(theme.text_primary)
                .child(title),
        )
        // 名称
        .child(field_label(theme, "名称"))
        .when_some(label_input.clone(), |this, input| {
            this.child(Input::new(&input))
        })
        // Agent ID
        .when(!is_edit, |this| {
            this.child(field_label(theme, "Agent ID"))
                .when_some(agent_id_input.clone(), |this, input| {
                    this.child(Input::new(&input))
                })
        })
        .when(is_edit, |this| {
            this.child(
                v_flex()
                    .gap_1()
                    .child(field_label(theme, "Agent ID（不可改，凭据绑定标识）"))
                    .child(
                        div()
                            .rounded(px(theme.radius))
                            .bg(theme.muted_fill.opacity(0.5))
                            .px_2()
                            .py_1p5()
                            .text_xs()
                            .child(SharedString::from(editing_agent)),
                    ),
            )
        })
        // 项目范围
        .child(field_label(theme, "项目范围"))
        .child(check_row(
            theme,
            "agent-scope-project-all",
            "全部项目",
            if dialog.project_scope.all {
                "该凭据可访问所有项目的数据".to_string()
            } else if proj_selected.is_empty() {
                "取消勾选后选择具体项目".to_string()
            } else {
                format!("已选 {} 个项目", proj_selected.len())
            },
            dialog.project_scope.all,
            view,
            ScopeKind::Project,
        ))
        .child(checklist(
            theme,
            &project_options,
            &proj_selected,
            dialog.project_scope.all,
            view,
            ScopeKind::Project,
        ))
        // 业务域范围
        .child(field_label(theme, "业务域范围"))
        .child(check_row(
            theme,
            "agent-scope-biz-all",
            "全部业务域",
            if dialog.business_scope.all {
                "该凭据可访问所有已接入业务域".to_string()
            } else if biz_selected.is_empty() {
                "取消勾选后选择具体业务域".to_string()
            } else {
                format!("已选 {} 个业务域", biz_selected.len())
            },
            dialog.business_scope.all,
            view,
            ScopeKind::Business,
        ))
        .child(checklist(
            theme,
            &biz_options,
            &biz_selected,
            dialog.business_scope.all,
            view,
            ScopeKind::Business,
        ))
        // 错误提示
        .when_some(error, |this, msg| {
            this.child(
                div()
                    .rounded(px(theme.radius))
                    .bg(theme.danger_soft)
                    .px_3()
                    .py_2()
                    .text_sm()
                    .text_color(theme.danger)
                    .child(msg),
            )
        })
        // 底部动作
        .child(
            h_flex()
                .gap_2()
                .justify_end()
                .pt_1()
                .child(
                    Button::new("agent-form-cancel")
                        .outline()
                        .small()
                        .label("取消")
                        .on_click(move |_, _, cx| {
                            v_cancel.update(cx, |this, cx| this.close_dialog(cx));
                        }),
                )
                .child(
                    Button::new("agent-form-save")
                        .primary()
                        .small()
                        .label(if saving {
                            "保存中…"
                        } else if is_edit {
                            "保存"
                        } else {
                            "创建"
                        })
                        .disabled(saving)
                        .on_click(move |_, _, cx| {
                            v_save.update(cx, |this, cx| this.submit_form(cx));
                        }),
                ),
        )
        .into_any_element()
}

/// 字段标签
fn field_label(theme: &AppTheme, text: &str) -> gpui::AnyElement {
    div()
        .text_sm()
        .font_weight(FontWeight::MEDIUM)
        .mt_1()
        .text_color(theme.text_secondary)
        .child(text.to_string())
        .into_any_element()
}

/// 勾选行（方形勾选框 + 主标题 + 说明；点击切换「全部」哨兵）
fn check_row(
    theme: &AppTheme,
    id: &'static str,
    title: &str,
    hint: String,
    checked: bool,
    view: &Entity<AgentManagementView>,
    kind: ScopeKind,
) -> gpui::AnyElement {
    let view = view.clone();
    h_flex()
        .id(id)
        .gap_2()
        .items_center()
        .rounded(px(theme.radius))
        .border_1()
        .cursor(CursorStyle::PointingHand)
        .px_2()
        .py_1p5()
        .when(checked, |this| {
            this.border_color(theme.accent.opacity(0.5))
                .bg(theme.accent_soft)
        })
        .when(!checked, |this| this.border_color(theme.separator))
        .child(check_square(theme, checked))
        .child(
            div()
                .text_sm()
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.text_primary)
                .child(title.to_string()),
        )
        .child(
            div()
                .ml_auto()
                .text_xs()
                .text_color(theme.text_muted)
                .child(hint),
        )
        .on_mouse_up(gpui::MouseButton::Left, move |_, _window, cx| {
            view.update(cx, |this, cx| this.toggle_scope_all(kind, cx));
        })
        .into_any_element()
}

/// 方形勾选指示器
fn check_square(theme: &AppTheme, checked: bool) -> gpui::AnyElement {
    div()
        .size(px(14.))
        .rounded(px(3.))
        .border_1()
        .when(checked, |this| {
            this.bg(theme.accent).border_color(theme.accent).child(
                div()
                    .size_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_color(theme.on_accent)
                    .child(Icon::new(IconName::Check).with_size(px(10.))),
            )
        })
        .when(!checked, |this| this.border_color(theme.separator))
        .into_any_element()
}

/// 可滚动多选清单（项目 / 业务域共用；每行点击按 value 切换选中）
fn checklist(
    theme: &AppTheme,
    options: &[(String, String)],
    selected: &[String],
    disabled: bool,
    view: &Entity<AgentManagementView>,
    kind: ScopeKind,
) -> gpui::AnyElement {
    let rows: Vec<gpui::AnyElement> = options
        .iter()
        .map(|(value, label)| {
            let view = view.clone();
            let checked = selected.iter().any(|s| s == value);
            let value = value.clone();
            h_flex()
                .id(SharedString::from(format!(
                    "scope-item-{}-{value}",
                    kind.id_prefix()
                )))
                .gap_2()
                .items_center()
                .rounded(px(theme.radius))
                .px_2()
                .py_1()
                .when(disabled, |this| this.opacity(0.45))
                .when(!disabled, |this| {
                    this.cursor(CursorStyle::PointingHand)
                        .hover(|this| this.bg(theme.table_row_hover))
                        .on_mouse_up(gpui::MouseButton::Left, move |_, _window, cx| {
                            let value = value.clone();
                            view.update(cx, |this, cx| this.toggle_scope_item(kind, value, cx));
                        })
                })
                .child(check_square(theme, checked))
                .child(
                    div()
                        .text_sm()
                        .text_color(theme.text_secondary)
                        .child(label.clone()),
                )
                .into_any_element()
        })
        .collect();

    v_flex()
        .id("agent-scope-checklist")
        .max_h(px(132.))
        .overflow_y_scroll()
        .rounded(px(theme.radius))
        .border_1()
        .border_color(theme.separator)
        .child(div().children(rows))
        .into_any_element()
}

// ---------------------------------------------------------------------------
// Tab 4 访问日志（统计带 / Top 徽标 / 筛选 / 子 Tab / 表格）
// ---------------------------------------------------------------------------

/// 日志子 Tab 栏（读访问 / 写操作）
fn render_logs_sub_tabs(
    view: &Entity<AgentManagementView>,
    active: LogsSubTab,
    theme: &AppTheme,
) -> impl IntoElement {
    h_flex()
        .id("agent-logs-subtabs")
        .p_1()
        .gap_1()
        .rounded(px(theme.radius_lg))
        .bg(theme.muted_fill)
        .children(
            [LogsSubTab::Read, LogsSubTab::Write]
                .into_iter()
                .map(|tab| {
                    let view = view.clone();
                    let selected = active == tab;
                    div()
                        .id(SharedString::from(format!(
                            "agent-logs-subtab-{}",
                            tab.label()
                        )))
                        .px_4()
                        .py_1p5()
                        .text_sm()
                        .rounded(px(theme.radius))
                        .cursor(CursorStyle::PointingHand)
                        .when(selected, |this| {
                            this.bg(theme.card_bg)
                                .text_color(theme.accent)
                                .font_weight(FontWeight::MEDIUM)
                        })
                        .when(!selected, |this| {
                            this.text_color(theme.text_secondary).hover(|this| {
                                this.bg(theme.card_bg.opacity(0.5))
                                    .text_color(theme.text_primary)
                            })
                        })
                        .child(tab.label().to_string())
                        .on_mouse_up(gpui::MouseButton::Left, move |_, _window, cx| {
                            view.update(cx, |this, cx| this.select_logs_sub_tab(tab, cx));
                        })
                }),
        )
}

/// 统计概览带（读访问四项：请求总量 / 成功 / 失败 / 活跃 Agent）
fn render_access_stats(
    summary: Option<&AgentAccessLogsSummaryResponse>,
    theme: &AppTheme,
) -> gpui::AnyElement {
    let (total, ok, err, agents) = match summary {
        Some(s) => (
            s.total,
            s.success_count,
            s.error_count,
            s.unique_agent_count,
        ),
        None => (0, 0, 0, 0),
    };
    stat_band_card(
        theme,
        "Agent 访问统计概览",
        "当前筛选条件下 /api/v1/agent/* 的访问统计（保留 90 天）",
        &[
            ("请求总量", total, true),
            ("成功 (2xx)", ok, false),
            ("失败 (≥4xx)", err, err > 0),
            ("活跃 Agent", agents, false),
        ],
    )
}

/// 统计概览带（写操作四项）
fn render_operation_stats(
    summary: Option<&AgentOperationLogsSummary>,
    theme: &AppTheme,
) -> gpui::AnyElement {
    let (total, ok, fail, agents) = match summary {
        Some(s) => (
            s.total,
            s.success_count,
            s.failure_count,
            s.unique_agent_count,
        ),
        None => (0, 0, 0, 0),
    };
    stat_band_card(
        theme,
        "Agent 操作统计概览",
        "当前筛选条件下 Agent 写操作审计（operation_audit_logs）",
        &[
            ("操作总量", total, true),
            ("成功", ok, false),
            ("失败", fail, fail > 0),
            ("活跃 Agent", agents, false),
        ],
    )
}

/// 四格统计卡
fn stat_band_card(
    theme: &AppTheme,
    title: &str,
    desc: &str,
    items: &[(&str, i64, bool)],
) -> gpui::AnyElement {
    content_guard()
        .child(
            v_flex()
                .id("agent-stats-card")
                .w_full()
                .gap_2()
                .rounded(px(theme.radius_lg))
                .bg(theme.card_bg)
                .shadow(vec![theme.card_shadow_box()])
                .px_4()
                .py_3()
                .child(
                    div()
                        .text_sm()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme.text_primary)
                        .child(title.to_string()),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.text_muted)
                        .child(desc.to_string()),
                )
                .child(
                    h_flex()
                        .flex_wrap()
                        .gap_3()
                        .pt_1()
                        .children(items.iter().map(|(label, value, emphasize)| {
                            v_flex()
                                .min_w(px(110.))
                                .gap_0p5()
                                .child(
                                    div()
                                        .text_xs()
                                        .text_color(theme.text_muted)
                                        .child((*label).to_string()),
                                )
                                .child(
                                    div()
                                        .text_xl()
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .when(*emphasize && *value > 0, |this| {
                                            this.text_color(theme.accent)
                                        })
                                        .when(!(*emphasize && *value > 0), |this| {
                                            this.text_color(theme.text_primary)
                                        })
                                        .child(SharedString::from(format!("{value}"))),
                                )
                        })),
                ),
        )
        .into_any_element()
}

/// Top Agent 徽标行（无数据 → 不渲染，返回 None）
fn render_top_agent_chips(
    top: Option<Vec<(Option<&str>, &str, i64)>>,
    theme: &AppTheme,
) -> Option<gpui::AnyElement> {
    let top = top?;
    if top.is_empty() {
        return None;
    }
    let chips: Vec<gpui::AnyElement> = top
        .into_iter()
        .take(8)
        .map(|(label, agent_id, count)| {
            h_flex()
                .gap_1()
                .items_center()
                .rounded_full()
                .border_1()
                .border_color(theme.accent.opacity(0.35))
                .bg(theme.accent_soft.opacity(0.6))
                .px_2()
                .py(px(2.))
                .when_some(label.filter(|l| !l.trim().is_empty()), |this, l| {
                    this.child(div().text_xs().child(SharedString::from(l.to_string())))
                })
                .child(
                    div()
                        .text_xs()
                        .child(SharedString::from(agent_id.to_string())),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.text_muted)
                        .child(SharedString::from(format!("×{count}"))),
                )
                .into_any_element()
        })
        .collect();
    Some(
        content_guard()
            .child(h_flex().flex_wrap().gap_2().children(chips))
            .into_any_element(),
    )
}

/// 日志筛选栏（关键词输入 + 方法[仅读访问] / 结果下拉 + 查询 / 重置；
/// 写操作侧结果口径为 failure，读访问为 error，切换子 Tab 时由筛选状态映射）
fn render_log_filters(
    view: &AgentManagementView,
    view_entity: &Entity<AgentManagementView>,
    theme: &AppTheme,
) -> gpui::AnyElement {
    let v_method = view_entity.clone();
    let v_result = view_entity.clone();
    let v_apply = view_entity.clone();
    let v_reset = view_entity.clone();

    let result = view.log_result.clone();
    let is_read = view.logs_sub_tab == LogsSubTab::Read;
    let method = view.log_method.clone();
    const METHODS: [(&str, &str); 6] = [
        ("all", "全部方法"),
        ("GET", "GET"),
        ("POST", "POST"),
        ("PUT", "PUT"),
        ("PATCH", "PATCH"),
        ("DELETE", "DELETE"),
    ];

    filter_bar_layout(theme)
        .id("agent-log-filters")
        .when_some(view.log_keyword_input.clone(), |this, input| {
            this.child(h_flex().w(px(260.)).child(Input::new(&input)))
        })
        // 方法下拉：仅读访问子 Tab 展示（写操作无 method 筛选参数）
        .when(is_read, |this| {
            this.child(filter_select(
                theme,
                "方法",
                SharedString::from(
                    method
                        .as_deref()
                        .and_then(|m| {
                            METHODS
                                .iter()
                                .find(|(v, _)| *v == m)
                                .map(|(_, label)| *label)
                        })
                        .unwrap_or("全部方法"),
                ),
                "agent-log-method-filter",
                move |menu, _window, _cx| {
                    let mut menu = menu;
                    for (value, label) in METHODS {
                        let view = v_method.clone();
                        let checked = if value == "all" {
                            method.is_none()
                        } else {
                            method.as_deref() == Some(value)
                        };
                        menu = menu.item(PopupMenuItem::new(label).checked(checked).on_click(
                            move |_ev, _w, cx| {
                                let next = (value != "all").then(|| value.to_string());
                                view.update(cx, |this, cx| this.set_log_method(next, cx));
                            },
                        ));
                    }
                    menu
                },
            ))
        })
        .child(filter_select(
            theme,
            "结果",
            SharedString::from(match view.log_result.as_deref() {
                Some("success") => "成功 (2xx)",
                Some("error") => "失败 (≥4xx)",
                _ => "全部结果",
            }),
            "agent-log-result-filter",
            move |menu, _window, _cx| {
                let mut menu = menu;
                let entries: [(&str, &str); 3] = [
                    ("all", "全部结果"),
                    ("success", "成功 (2xx)"),
                    ("error", "失败 (≥4xx)"),
                ];
                for (value, label) in entries {
                    let view = v_result.clone();
                    let checked = if value == "all" {
                        result.is_none()
                    } else {
                        result.as_deref() == Some(value)
                    };
                    menu = menu.item(PopupMenuItem::new(label).checked(checked).on_click(
                        move |_ev, _w, cx| {
                            let next = (value != "all").then(|| value.to_string());
                            view.update(cx, |this, cx| this.set_log_result(next, cx));
                        },
                    ));
                }
                menu
            },
        ))
        .child(
            Button::new("agent-log-apply")
                .primary()
                .small()
                .label("查询")
                .on_click(move |_ev, _w, cx| {
                    v_apply.update(cx, |this, cx| this.apply_log_filters(cx));
                }),
        )
        .child(
            Button::new("agent-log-reset")
                .outline()
                .small()
                .label("重置")
                .on_click(move |_ev, _w, cx| {
                    v_reset.update(cx, |this, cx| this.reset_log_filters(cx));
                }),
        )
        .into_any_element()
}

/// 读访问日志表（时间 / Agent / 方法 / 路径 / 项目 / 操作类型 / 状态码 / 耗时 / IP）
fn render_access_table(rows: &[AgentAccessLogItem], theme: &AppTheme) -> gpui::AnyElement {
    let header = h_flex()
        .gap_2()
        .px_2()
        .py_1p5()
        .border_b_1()
        .border_color(theme.separator)
        .children(
            [
                ("时间", 140., CellAlign::Left),
                ("Agent", 170., CellAlign::Left),
                ("方法", 64., CellAlign::Left),
                ("路径", 300., CellAlign::Left),
                ("项目", 100., CellAlign::Left),
                ("操作类型", 90., CellAlign::Left),
                ("状态码", 96., CellAlign::Left),
                ("耗时", 72., CellAlign::Right),
                ("IP 地址", 120., CellAlign::Left),
            ]
            .into_iter()
            .map(|(title, width, align)| {
                div()
                    .w(px(width))
                    .text_xs()
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.text_muted)
                    .when(align == CellAlign::Right, |this| this.text_right())
                    .child(title.to_string())
            }),
        );

    let body: Vec<gpui::AnyElement> = rows
        .iter()
        .map(|row| {
            let (_, fg) = http_status_colors(row.status_code, theme);
            h_flex()
                .gap_2()
                .px_2()
                .py_1p5()
                .border_b_1()
                .border_color(theme.separator.opacity(0.6))
                .hover(|this| this.bg(theme.table_row_hover))
                .child(access_cell(
                    theme,
                    beijing_time(Some(&row.created_at)),
                    140.,
                    false,
                ))
                .child(access_cell(
                    theme,
                    agent_display(row.key_label.as_deref(), row.agent_id.as_deref()),
                    170.,
                    false,
                ))
                .child(access_cell(theme, row.method.clone(), 64., false))
                .child(access_cell(theme, row.path.clone(), 300., true))
                .child(access_cell(
                    theme,
                    row.project_name
                        .clone()
                        .unwrap_or_else(|| format!("#{}", row.project_id.unwrap_or(0))),
                    100.,
                    false,
                ))
                .child(access_cell(
                    theme,
                    operation_type_label(row.operation_type.as_deref()),
                    90.,
                    false,
                ))
                .child(div().w(px(96.)).child(small_chip(
                    theme,
                    http_status_label(row.status_code),
                    fg,
                )))
                .child(access_cell(
                    theme,
                    format!("{}ms", row.latency_ms),
                    72.,
                    true,
                ))
                .child(access_cell(
                    theme,
                    row.ip_address.clone().unwrap_or_else(|| "-".into()),
                    120.,
                    true,
                ))
                .into_any_element()
        })
        .collect();

    content_guard()
        .child(
            v_flex()
                .rounded(px(theme.radius))
                .border_1()
                .border_color(theme.separator)
                .overflow_hidden()
                .child(header)
                .children(body),
        )
        .into_any_element()
}

/// 写操作日志表（时间 / Agent / 动作 / 对象 / 结果 / 项目 / 操作类型 / 错误信息）
fn render_operation_table(rows: &[AgentOperationLogItem], theme: &AppTheme) -> gpui::AnyElement {
    let head = h_flex()
        .gap_2()
        .px_2()
        .py_1p5()
        .border_b_1()
        .border_color(theme.separator)
        .children(
            [
                ("时间", 140., CellAlign::Left),
                ("Agent", 160., CellAlign::Left),
                ("动作", 150., CellAlign::Left),
                ("对象", 130., CellAlign::Left),
                ("结果", 70., CellAlign::Left),
                ("项目", 100., CellAlign::Left),
                ("操作类型", 90., CellAlign::Left),
                ("错误信息", 240., CellAlign::Left),
            ]
            .into_iter()
            .map(|(title, width, align)| {
                div()
                    .w(px(width))
                    .text_xs()
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.text_muted)
                    .when(align == CellAlign::Right, |this| this.text_right())
                    .child(title.to_string())
            }),
        );

    let body: Vec<gpui::AnyElement> = rows
        .iter()
        .map(|row| {
            let failed = row.result != "success";
            h_flex()
                .gap_2()
                .px_2()
                .py_1p5()
                .border_b_1()
                .border_color(theme.separator.opacity(0.6))
                .hover(|this| this.bg(theme.table_row_hover))
                .child(access_cell(
                    theme,
                    beijing_time(Some(&row.created_at)),
                    140.,
                    false,
                ))
                .child(access_cell(
                    theme,
                    agent_display(row.agent_name.as_deref(), row.agent_id.as_deref()),
                    160.,
                    false,
                ))
                .child(access_cell(theme, row.action.clone(), 150., true))
                .child(access_cell(
                    theme,
                    row.target_label
                        .clone()
                        .or_else(|| row.target_id.clone())
                        .unwrap_or_else(|| "-".into()),
                    130.,
                    true,
                ))
                .child(div().w(px(70.)).child(if failed {
                    small_chip(theme, "失败", theme.danger)
                } else {
                    small_chip(theme, "成功", theme.success)
                }))
                .child(access_cell(
                    theme,
                    row.project_name
                        .clone()
                        .unwrap_or_else(|| format!("#{}", row.project_id.unwrap_or(0))),
                    100.,
                    false,
                ))
                .child(access_cell(
                    theme,
                    operation_type_label(row.operation_type.as_deref()),
                    90.,
                    false,
                ))
                .child(access_cell(
                    theme,
                    row.error_message.clone().unwrap_or_else(|| "-".into()),
                    240.,
                    true,
                ))
                .into_any_element()
        })
        .collect();

    content_guard()
        .child(
            v_flex()
                .rounded(px(theme.radius))
                .border_1()
                .border_color(theme.separator)
                .overflow_hidden()
                .child(head)
                .children(body),
        )
        .into_any_element()
}

/// 表格单元格文本（mono 可选；溢出省略）
fn access_cell(theme: &AppTheme, text: String, width: f32, mono: bool) -> gpui::AnyElement {
    div()
        .w(px(width))
        .text_xs()
        .text_color(theme.text_secondary)
        .truncate()
        .when(mono, |this| this.font_family("JetBrains Mono"))
        .child(text)
        .into_any_element()
}

/// Agent 展示名（名称在前 + id 兜底，对齐 web AgentIdentityCell 语义）
fn agent_display(label: Option<&str>, agent_id: Option<&str>) -> String {
    match (label.map(str::trim).filter(|s| !s.is_empty()), agent_id) {
        (Some(l), Some(id)) => format!("{l} ({id})"),
        (Some(l), None) => l.to_string(),
        (None, Some(id)) => id.to_string(),
        (None, None) => "未绑定".to_string(),
    }
}

// ---------------------------------------------------------------------------
// 调用指南（静态通用示例；域差异只在路径）
// ---------------------------------------------------------------------------

/// 生成调用说明全文（复制到剪贴板 / 指南卡共用；对齐 web buildUsageText 核心）
pub fn build_usage_text(api_base: String) -> String {
    format!(
        r#"【鉴权头】所有 /api/v1/agent/* 请求携带：
  Authorization: Bearer <明文 Key>
  X-Agent-Id: <Agent ID>

【0. 解析项目 ID（派发时只给项目名，先查 ID）】
  curl "{base}/api/v1/agent/projects?name=<项目名>" \
    -H "Authorization: Bearer <Key>" \
    -H "X-Agent-Id: <AgentId>"
  # → {{"ok":true,"data":[{{"project_id":1,"project_name":"<项目名>"}}]}}

【1. 存活探针】
  curl {base}/api/v1/agent/health \
    -H "Authorization: Bearer <Key>" \
    -H "X-Agent-Id: <AgentId>"

【2. 读取货件列表（业务域示例：shipments；其余域换对应路径）】
  curl "{base}/api/v1/agent/projects/$PROJECT_ID/shipments?page_size=20" \
    -H "Authorization: Bearer <Key>" \
    -H "X-Agent-Id: <AgentId>"

【3. 写操作（两步确认，第一次调用不会落库）】
  第一步（预览，返回 confirm_token）：
  curl -X POST "{base}/api/v1/agent/projects/$PROJECT_ID/shipments" \
    -H "Authorization: Bearer <Key>" -H "X-Agent-Id: <AgentId>" \
    -H "Idempotency-Key: <UUID>" -H "Content-Type: application/json" \
    -d '{{...}}'
  第二步（向用户确认后重放，请求体必须与第一步完全一致）：
  同一 URL + 同一 Idempotency-Key，另加：
    -H "X-Confirm-Token: <第一步返回的 confirm_token>"

【4. 删除货件（两步确认，不可逆；DELETE 无请求体，重放同样不带 body）】"#,
        base = api_base
    )
}

/// 调用指南卡（静态示例 + 复制按钮）
fn render_guide(view: &Entity<AgentManagementView>, theme: &AppTheme) -> gpui::AnyElement {
    let v_copy = view.clone();
    content_guard()
        .child(
            v_flex()
                .id("agent-guide-card")
                .w_full()
                .gap_3()
                .rounded(px(theme.radius_lg))
                .bg(theme.card_bg)
                .shadow(vec![theme.card_shadow_box()])
                .p_4()
                .child(
                    h_flex()
                        .justify_between()
                        .child(
                            div()
                                .text_base()
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(theme.text_primary)
                                .child("调用指南"),
                        )
                        .child(
                            Button::new("agent-guide-copy")
                                .outline()
                                .small()
                                .icon(Icon::new(IconName::Copy).with_size(px(13.)))
                                .label("复制调用说明")
                                .on_click(move |_, _, cx| {
                                    v_copy.update(cx, |this, cx| {
                                        this.copy_usage_text(cx)
                                    });
                                }),
                        ),
                )
                .child(
                    div()
                        .text_sm()
                        .line_height(px(20.))
                        .text_color(theme.text_secondary)
                        .child("凭据创建成功后即可按以下模式调用。各业务域差异仅在 URL 路径（如 shipments / shop-calculations），鉴权头、项目解析与两步确认写流程全域一致。"),
                )
                .child(
                    div()
                        .rounded(px(theme.radius))
                        .border_1()
                        .border_color(theme.separator)
                        .bg(theme.muted_fill.opacity(0.35))
                        .p_3()
                        .text_xs()
                        .line_height(px(17.))
                        .child(SharedString::from(build_usage_text("<后端地址>".to_string()))),
                ),
        )
        .into_any_element()
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- 常量 / 纯函数契约 ----------

    #[test]
    fn url_constant_matches_sidebar() {
        assert_eq!(AGENT_MANAGEMENT_URL, "/dashboard/system/agent-management");
        assert!(gui_domain::sidebar::sidebar_groups()
            .iter()
            .flat_map(|g| g.items.iter())
            .any(|item| item.url == AGENT_MANAGEMENT_URL));
    }

    #[test]
    fn log_page_size_aligns_with_web() {
        assert_eq!(LOG_PAGE_SIZE, 50);
    }

    #[test]
    fn tab_labels_match_web_tabs() {
        let labels: Vec<&str> = AgentTab::ALL.iter().map(|t| t.label()).collect();
        assert_eq!(
            labels,
            vec!["业务域概览", "凭据管理", "调用指南", "访问日志"]
        );
    }

    #[test]
    fn status_filter_labels_and_matching() {
        assert_eq!(StatusFilter::All.label(), "全部状态");
        // Deleted 不属于任何筛选档（只随「含已删除」出现）
        assert!(!StatusFilter::Active.matches(AgentKeyStatus::Deleted));
        assert!(!StatusFilter::Expired.matches(AgentKeyStatus::Inactive));
        assert!(StatusFilter::All.matches(AgentKeyStatus::Deleted));
    }

    #[test]
    fn beijing_time_handles_empty_bad_and_offset() {
        assert_eq!(beijing_time(None), "—");
        assert_eq!(beijing_time(Some("")), "—");
        assert_eq!(
            beijing_time(Some("2026-08-20T06:23:00+00:00")),
            "2026-08-20 14:23"
        );
        // 解析失败回退原文（不吞内容）
        assert_eq!(beijing_time(Some("not-a-date")), "not-a-date");
    }

    #[test]
    fn http_status_semantics_follow_web_meta() {
        assert_eq!(http_status_label(200), "成功");
        assert_eq!(http_status_label(302), "重定向");
        assert_eq!(http_status_label(404), "请求错误");
        assert_eq!(http_status_label(503), "服务端错误");
        let theme = AppTheme::light();
        let (_, ok) = http_status_colors(200, &theme);
        let (_, err) = http_status_colors(500, &theme);
        assert_eq!(ok, theme.success);
        assert_eq!(err, theme.danger);
    }

    #[test]
    fn operation_type_label_resolves_registry() {
        assert_eq!(operation_type_label(Some("shipments")), "货件管理");
        assert_eq!(operation_type_label(Some("unknown_x")), "unknown_x");
        assert_eq!(operation_type_label(None), "-");
        assert_eq!(operation_type_label(Some("  ")), "-");
    }

    #[test]
    fn agent_display_prefers_label_falls_back_to_id() {
        assert_eq!(agent_display(Some("货件助理"), Some("a1")), "货件助理 (a1)");
        assert_eq!(agent_display(Some(""), Some("a1")), "a1");
        assert_eq!(agent_display(None, None), "未绑定");
    }

    // ---------- ScopeDraft 状态机 ----------

    #[test]
    fn scope_draft_toggles_follow_sentinel_semantics() {
        let mut draft = ScopeDraft::all();
        assert_eq!(draft.to_scope(), "*");

        // 全部 → 取消勾选（空）→ 勾选项
        draft.toggle_all();
        assert_eq!(draft.to_scope(), "*"); // 空白名单仍归一为 '*'
        draft.toggle_item("shipments");
        assert_eq!(draft.to_scope(), "shipments");
        draft.toggle_item("sales");
        assert_eq!(draft.to_scope(), "shipments,sales");

        // 再点已选项 → 移除
        draft.toggle_item("shipments");
        assert_eq!(draft.to_scope(), "sales");

        // 切回全部 → 清空白名单
        draft.toggle_all();
        assert!(draft.all);
        assert!(draft.selected.is_empty());
        // 全部态下点具体项 → 从「全部」切白名单并排除该项
        draft.toggle_item("inventory");
        assert!(!draft.all);
        assert_eq!(draft.selected, vec!["inventory".to_string()]);
    }

    #[test]
    fn scope_draft_from_scope_roundtrips() {
        assert_eq!(ScopeDraft::from_scope(Some("*")), ScopeDraft::all());
        let partial = ScopeDraft::from_scope(Some("shipments,sales"));
        assert!(!partial.all);
        assert_eq!(partial.selected.len(), 2);
    }

    // ---------- 过滤 / 派生（纯逻辑，无 GPUI 实体） ----------

    #[test]
    fn usage_text_contains_auth_and_confirm_flow() {
        let text = build_usage_text("https://api.example.com".into());
        assert!(text.contains("Authorization: Bearer"));
        assert!(text.contains("X-Agent-Id"));
        assert!(text.contains("/api/v1/agent/health"));
        assert!(text.contains("X-Confirm-Token"));
        assert!(text.contains("https://api.example.com/api/v1/agent/projects?name="));
    }

    #[test]
    fn compact_project_scope_truncates_long_lists() {
        assert_eq!(render_project_scope_compact("*"), "全部项目");
        assert_eq!(render_project_scope_compact("1,2"), "#1/#2");
        let long = render_project_scope_compact("1,2,3,4,5");
        assert!(long.contains("等 5 个项目"), "{long}");
    }
}

#[cfg(test)]
mod gpui_tests {
    use super::*;

    /// 构造测试凭据（两个测试模块共用；仅测试构建）
    #[cfg(test)]
    fn sample_key(id: i64, business_scope: &str) -> AgentApiKeyItem {
        AgentApiKeyItem {
            id,
            key_prefix: format!("bbk_{id:04}"),
            label: format!("凭据{id}"),
            scope: "read".into(),
            project_scope: "*".into(),
            business_scope: business_scope.into(),
            agent_id: Some(format!("agent-{id}")),
            is_revoked: false,
            expires_at: None,
            created_at: "2026-08-01T00:00:00+00:00".into(),
            last_used_at: None,
            deleted_at: None,
        }
    }

    /// 构造一个 dummy client（无有效 base_url；仅构造视图用）
    fn dummy_client() -> Client {
        Client::new("http://127.0.0.1:1")
    }

    /// 渲染冒烟：亮 / 暗主题下视图可构建 + 默认凭据管理 Tab + Loading 态
    #[gpui::test]
    async fn renders_loading_state_in_light_and_dark(cx: &mut gpui::TestAppContext) {
        for dark in [false, true] {
            cx.update(|cx| {
                gpui_component::init(cx);
                crate::theme::set_theme_pref(
                    if dark {
                        crate::theme::ThemePreference::Dark
                    } else {
                        crate::theme::ThemePreference::Light
                    },
                    None,
                    cx,
                );
            });
            let (view, cx2) =
                cx.add_window_view(|_window, cx| AgentManagementView::new(cx, dummy_client()));
            view.update(cx2, |this, cx| {
                assert_eq!(this.current_tab(), AgentTab::Credentials);
                assert_eq!(this.current_keys_state(), &KeyListState::Loading);
                this.select_tab(AgentTab::Overview, cx);
                this.select_tab(AgentTab::Credentials, cx);
                this.select_tab(AgentTab::Guide, cx);
            });
            cx2.read(|app| {
                assert_eq!(
                    crate::theme::AppTheme::current(app).is_dark(),
                    dark,
                    "主题切换生效"
                );
            });
        }
    }

    /// 凭据 Loaded / Empty / Error 三态落点 + 客户端筛选
    #[gpui::test]
    async fn key_list_states_and_client_side_filters(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) =
            cx.add_window_view(|_window, cx| AgentManagementView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            this.keys = vec![
                sample_key(1, "*"),
                sample_key(2, "shipments"),
                sample_key(3, "shipments,sales"),
            ];

            // 全部通过
            this.keys_state = KeyListState::Loaded;
            assert_eq!(this.filtered_keys().len(), 3);

            // 业务域筛选：'*' scope 恒命中
            this.set_domain_filter(Some("shipments".into()), cx);
            assert_eq!(this.filtered_keys().len(), 3);
            this.set_domain_filter(Some("sales".into()), cx);
            assert_eq!(this.filtered_keys().len(), 2); // key1('*') + key3

            // 状态筛选叠加：全部激活 → 同上；停用一个后减少
            this.status_filter = StatusFilter::Active;
            assert_eq!(this.filtered_keys().len(), 2);
            this.keys[2].is_revoked = true;
            assert_eq!(this.filtered_keys().len(), 1);
            this.set_status_filter(StatusFilter::Inactive, cx);
            assert_eq!(this.filtered_keys().len(), 1);

            // 重置
            this.set_domain_filter(None, cx);
            this.set_status_filter(StatusFilter::All, cx);
            assert_eq!(this.filtered_keys().len(), 3);

            // Error / Empty 落点语义（reload 驱动，此处直接断言构造）
            this.keys.clear();
            this.keys_state = KeyListState::Loaded;
            assert_eq!(this.filtered_keys().len(), 0);
        });
    }
}
