//! CRM → 操作日志（P5-7，BLF-747）
//!
//! 对齐 web 端 `app/dashboard/crm/audit/page.tsx`（约 262 行）的**只读列表**：
//! 客户 / 线索 / 联系人 / 任务的全部操作留痕，对象 + 动作双筛选、30 行分页、
//! 时间 / 对象 / 操作 / 操作人 / 变更五列。数据源：
//! - `GET /api/v1/crm/audit-logs?entity_type=&action=&page=&page_size=`
//!   （gui-api-client::crm）
//!
//! 权限口径：后端 `require_admin` 兜底，sidebar 不做角色墙——非管理员会话
//! 请求返回 403，本页落 **Forbidden 态**优雅展示「无权限」而非报错（对齐 web
//! forbidden 兜底面板；GUI 按状态码精确区分 403 与其他错误，比 web 的
//! catch-all 更精确）。
//!
//! ## 与 web 端的取舍（issue 允许按 macOS 原生习惯精简并说明）
//!
//! - **保留**：双筛选（全部对象/客户/线索/联系人/任务 × 全部操作+10 动作，
//!   切换回第 1 页）、五列表格、操作徽标语义色（create/complete 绿系 /
//!   delete 红系 / update 蓝系 / 其余中性）、操作人为空展示「系统」、
//!   分页（30 行/页对齐 web `PAGE_SIZE`）、空态「暂无操作记录」；
//! - **精简**：时间列用本机时区 `YYYY-MM-DD HH:MM` 固定格式（web 用
//!   `toLocaleString('zh-CN')` 秒级全格式；GUI 收敛到分钟保证列宽稳定）；
//!   变更摘要单行截断（web line-clamp-2 两行截断；表格行高一致更利落）。

use gpui::prelude::*;
use gpui::{
    div, px, App, AsyncApp, Context, Entity, FontWeight, Hsla, IntoElement, Render, SharedString,
    Styled, WeakEntity, Window,
};
use gpui_component::button::Button;
use gpui_component::{h_flex, v_flex, Sizable};
use gui_api_client::error::ApiError;
use gui_api_client::Client;
use gui_domain::crm::{
    audit_action_label, audit_entity_label, format_audit_time, AuditLogItem, AuditLogPage,
    AUDIT_ACTIONS,
};

use crate::theme::AppTheme;
use crate::widgets::data_table::{ColumnDef, DataTable};
use crate::widgets::filter_bar::filter_select;
use crate::widgets::layout::content_guard;
use crate::widgets::page_header::PageHeader;
use crate::widgets::pagination::{self, PageState};
use crate::widgets::state_views::{self, SkeletonBlock};

/// sidebar「CRM 客户与合作伙伴 → 操作日志」URL（数据权威 gui-domain::sidebar）
pub const CRM_AUDIT_URL: &str = "/dashboard/crm/audit";

/// 每页行数（对齐 web `PAGE_SIZE = 30`）
const PAGE_SIZE: usize = 30;

// ---------------------------------------------------------------------------
// 筛选模型
// ---------------------------------------------------------------------------

/// 对象类型筛选（`All` = 全部对象）
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum EntityFilter {
    #[default]
    All,
    Customer,
    Lead,
    Contact,
    Task,
}

impl EntityFilter {
    /// query 参数值（`None` = 不带 entity_type）
    pub fn as_query(self) -> Option<&'static str> {
        match self {
            EntityFilter::All => None,
            EntityFilter::Customer => Some("customer"),
            EntityFilter::Lead => Some("lead"),
            EntityFilter::Contact => Some("contact"),
            EntityFilter::Task => Some("task"),
        }
    }

    /// 下拉按钮当前文案
    pub fn label(self) -> &'static str {
        match self {
            EntityFilter::All => "全部对象",
            EntityFilter::Customer => "客户",
            EntityFilter::Lead => "线索",
            EntityFilter::Contact => "联系人",
            EntityFilter::Task => "任务",
        }
    }

    /// 全部选项（菜单顺序：全部 → 客户 → 线索 → 联系人 → 任务，
    /// 与 gui_domain::AUDIT_ENTITY_TYPES 同序）
    pub const ALL: [EntityFilter; 5] = [
        EntityFilter::All,
        EntityFilter::Customer,
        EntityFilter::Lead,
        EntityFilter::Contact,
        EntityFilter::Task,
    ];
}

/// 动作筛选（`All` = 全部操作；`Known(key)` = 具体动作 key，如 `"create"`）
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum ActionFilter {
    #[default]
    All,
    Known(String),
}

impl ActionFilter {
    /// query 参数值（`None` = 不带 action）
    pub fn as_query(&self) -> Option<&str> {
        match self {
            ActionFilter::All => None,
            ActionFilter::Known(key) => Some(key.as_str()),
        }
    }

    /// 下拉按钮当前文案
    pub fn label(&self) -> String {
        match self {
            ActionFilter::All => "全部操作".to_string(),
            ActionFilter::Known(key) => audit_action_label(key),
        }
    }
}

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

/// 拉取失败信息（携带是否权限不足；403 单独落 Forbidden 态）
#[derive(Debug, Clone, PartialEq)]
pub struct FetchFailure {
    pub forbidden: bool,
    pub message: String,
}

impl From<ApiError> for FetchFailure {
    fn from(err: ApiError) -> Self {
        Self {
            forbidden: err.status() == Some(403),
            message: err.user_message(),
        }
    }
}

/// 视图状态机（对齐既有业务视图约定；Forbidden 为本页特有）
#[derive(Debug, Clone, PartialEq)]
pub enum CrmAuditState {
    /// 首屏 / 刷新中
    Loading,
    /// 数据就绪
    Loaded(Box<AuditLogPage>),
    /// 当前筛选 + 页下无记录
    Empty,
    /// 无权限（后端 require_admin 返回 403；仅管理员可见）
    Forbidden,
    /// 其他请求失败（携带用户可读消息）
    Error(String),
}

impl CrmAuditState {
    fn from_fetch_result(result: Result<AuditLogPage, FetchFailure>) -> Self {
        match result {
            Ok(page) if page.items.is_empty() => Self::Empty,
            Ok(page) => Self::Loaded(Box::new(page)),
            Err(failure) if failure.forbidden => Self::Forbidden,
            Err(failure) => Self::Error(failure.message),
        }
    }
}

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

/// CRM 操作日志视图（只读列表 + 双筛选 + 分页 + 竞态保护 + 403 兜底）
pub struct CrmAuditView {
    state: Entity<CrmAuditState>,
    /// 带会话的 API client
    client: Client,
    /// 对象筛选（全部对象默认）
    entity_filter: EntityFilter,
    /// 动作筛选（全部操作默认）
    action_filter: ActionFilter,
    /// 当前页（1 起）
    page: usize,
    /// 主请求竞态保护
    latest_request_id: u64,
    /// 日志表（Stage 0 DataTable，总存在）
    table: Entity<DataTable<AuditLogItem>>,
}

impl CrmAuditView {
    /// 新建视图：初始 `Loading`，由 root.rs 懒创建后触发 `reload()`
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| CrmAuditState::Loading);
        let table = cx.new(|_| DataTable::new("crm-audit-table", audit_columns()).striped(true));
        Self {
            state,
            client,
            entity_filter: EntityFilter::default(),
            action_filter: ActionFilter::default(),
            page: 1,
            latest_request_id: 0,
            table,
        }
    }

    /// 当前状态（只读，测试用）
    #[allow(dead_code)]
    pub fn current_state(&self, cx: &App) -> CrmAuditState {
        self.state.read(cx).clone()
    }

    /// 当前筛选与页码（只读，测试用）
    #[allow(dead_code)]
    pub fn current_filters(&self) -> (EntityFilter, ActionFilter, usize) {
        (self.entity_filter, self.action_filter.clone(), self.page)
    }

    /// 重新拉取：首屏 / 错误重试 / 空态刷新 / 筛选切换 / 翻页共用入口
    /// （竞态保护；每次调用递增 `latest_request_id` 并进入 Loading）
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;

        self.state.update(cx, |state, cx| {
            *state = CrmAuditState::Loading;
            cx.notify();
        });

        let client = self.client.clone();
        let entity_type = self.entity_filter.as_query().map(str::to_string);
        let action = self.action_filter.as_query().map(str::to_string);
        let page = self.page.max(1);
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    // reqwest 需要 tokio reactor：统一走应用级 runtime block_on
                    // （对齐 crm_follow_ups::reload 模式）
                    crate::runtime::runtime().block_on(async {
                        client
                            .crm_audit_logs(
                                entity_type.as_deref(),
                                action.as_deref(),
                                page,
                                PAGE_SIZE,
                            )
                            .await
                            .map_err(FetchFailure::from)
                    })
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.apply_result(request_id, result, cx);
            })
            .ok();
        })
        .detach();
    }

    /// 切换对象筛选并重新拉取（回第 1 页；同档不重复请求）
    pub fn set_entity_filter(&mut self, filter: EntityFilter, cx: &mut Context<Self>) {
        if self.entity_filter == filter {
            return;
        }
        self.entity_filter = filter;
        self.page = 1;
        self.reload(cx);
    }

    /// 切换动作筛选并重新拉取（回第 1 页；同档不重复请求）
    pub fn set_action_filter(&mut self, filter: ActionFilter, cx: &mut Context<Self>) {
        if self.action_filter == filter {
            return;
        }
        self.action_filter = filter;
        self.page = 1;
        self.reload(cx);
    }

    /// 翻页并重新拉取（同页不重复请求；非法页号忽略）
    pub fn go_to_page(&mut self, page: usize, cx: &mut Context<Self>) {
        if self.page == page || page < 1 {
            return;
        }
        self.page = page;
        self.reload(cx);
    }

    /// 应用拉取结果（竞态保护）：落状态机 + 注入表格行
    fn apply_result(
        &mut self,
        request_id: u64,
        result: Result<AuditLogPage, FetchFailure>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_request_id {
            return; // 过期响应，丢弃
        }
        let rows = result.as_ref().ok().map(|page| page.items.clone());
        let next = CrmAuditState::from_fetch_result(result);
        if let Some(rows) = rows {
            self.table.update(cx, |table, cx| table.set_rows(rows, cx));
        }
        self.state.update(cx, |state, cx| {
            *state = next;
            cx.notify();
        });
    }
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

impl Render for CrmAuditView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let app_theme = AppTheme::current(cx);
        let state = self.state.read(cx).clone();
        let view = cx.entity();
        // 分页信息：Loaded 用响应口径；其余态保持本地页号、总数 0（分页条仅在 Loaded 渲染）
        let (page, total) = match &state {
            CrmAuditState::Loaded(data) => (data.page.max(1) as usize, data.total.max(0) as usize),
            _ => (self.page, 0),
        };

        v_flex()
            .id("crm-audit")
            .size_full()
            .gap_4()
            .p_6()
            .overflow_y_scroll()
            .bg(app_theme.window_bg)
            .child(page_header(
                view.clone(),
                self.entity_filter,
                &self.action_filter,
                &app_theme,
            ))
            .child(match state {
                CrmAuditState::Loading => render_loading(&app_theme).into_any_element(),
                CrmAuditState::Error(msg) => state_views::error_state(
                    &view,
                    &app_theme,
                    "crm-audit-error",
                    "操作日志加载失败",
                    msg,
                    |this, cx| this.reload(cx),
                )
                .into_any_element(),
                CrmAuditState::Empty => state_views::empty_state_with_action(
                    &view,
                    &app_theme,
                    "crm-audit-empty",
                    "icons/history.svg",
                    "暂无操作记录",
                    "刷新",
                    |this, cx| this.reload(cx),
                )
                .into_any_element(),
                CrmAuditState::Forbidden => render_forbidden(&app_theme).into_any_element(),
                CrmAuditState::Loaded(_) => {
                    let reduce = crate::motion::reduce_motion(cx);
                    render_loaded(view, &app_theme, reduce, page, total, self.table.clone())
                        .into_any_element()
                }
            })
    }
}

/// 页面头部：标题 + 副标题 + 双筛选下拉 + 刷新按钮（对齐 web 标题行 +
/// 筛选行布局；GUI 收敛进 PageHeader 动作位）。筛选当前值在 render 期传入
/// 并被菜单构建闭包捕获（对齐 crm_follow_ups scope 菜单的值捕获模式）。
fn page_header(
    view: Entity<CrmAuditView>,
    entity_filter: EntityFilter,
    action_filter: &ActionFilter,
    theme: &AppTheme,
) -> impl IntoElement {
    let view_for_entity = view.clone();
    let view_for_action_menu = view.clone();
    let view_for_refresh = view.clone();
    let action_current = action_filter.label();
    let is_action_all = *action_filter == ActionFilter::All;
    let selected_action = action_filter.clone();

    PageHeader::new("操作日志")
        .subtitle("客户 / 线索 / 联系人的全部操作留痕（仅管理员可见）")
        .action(filter_select(
            theme,
            "对象",
            SharedString::from(entity_filter.label()),
            "crm-audit-entity-filter",
            move |menu, _w, _cx| {
                let mut menu = menu;
                for option in EntityFilter::ALL {
                    let view = view_for_entity.clone();
                    menu = menu.item(
                        gpui_component::menu::PopupMenuItem::new(option.label())
                            .checked(option == entity_filter)
                            .on_click(move |_ev, _w, cx| {
                                view.update(cx, |this, cx| this.set_entity_filter(option, cx));
                            }),
                    );
                }
                menu
            },
        ))
        .action(filter_select(
            theme,
            "操作",
            SharedString::from(action_current),
            "crm-audit-action-filter",
            move |menu, _w, _cx| {
                let mut menu = menu;
                menu = menu.item(
                    gpui_component::menu::PopupMenuItem::new("全部操作")
                        .checked(is_action_all)
                        .on_click({
                            let view = view_for_action_menu.clone();
                            move |_ev, _w, cx| {
                                view.update(cx, |this, cx| {
                                    this.set_action_filter(ActionFilter::All, cx)
                                });
                            }
                        }),
                );
                for (key, label) in AUDIT_ACTIONS {
                    let view = view_for_action_menu.clone();
                    let known = ActionFilter::Known(key.to_string());
                    let checked = known == selected_action;
                    menu = menu.item(
                        gpui_component::menu::PopupMenuItem::new(label)
                            .checked(checked)
                            .on_click(move |_ev, _w, cx| {
                                view.update(cx, |this, cx| {
                                    this.set_action_filter(known.clone(), cx)
                                });
                            }),
                    );
                }
                menu
            },
        ))
        .action(
            Button::new("crm-audit-refresh")
                .outline()
                .small()
                .label("刷新")
                .on_click(move |_ev, _w, cx| {
                    view_for_refresh.update(cx, |this, cx| this.reload(cx));
                }),
        )
}

/// Loading 骨架：表格块
fn render_loading(theme: &AppTheme) -> impl IntoElement {
    state_views::skeleton_loading(theme, &[SkeletonBlock::Table(240.0)])
}

/// Forbidden（403）：琥珀色兜底面板（对齐 web ShieldAlert + amber 面板语义；
/// 无重试按钮——权限问题重试无意义）
fn render_forbidden(theme: &AppTheme) -> impl IntoElement {
    let (fg, bg, border) = if theme.is_dark() {
        (
            theme.warning,
            theme.warning.opacity(0.10),
            theme.warning.opacity(0.30),
        )
    } else {
        (
            theme.warning,
            theme.warning.opacity(0.12),
            theme.warning.opacity(0.35),
        )
    };
    content_guard().child(
        v_flex()
            .id("crm-audit-forbidden")
            .items_center()
            .gap_3()
            .rounded(px(theme.radius_lg))
            .border_1()
            .border_color(border)
            .bg(bg)
            .px_6()
            .py_12()
            .child(
                gpui_component::Icon::new(gpui_component::Icon::empty())
                    .path("icons/shield.svg")
                    .with_size(px(28.0))
                    .text_color(fg),
            )
            .child(
                div()
                    .text_sm()
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(fg)
                    .child("无权限查看操作日志（仅管理员）"),
            ),
    )
}

/// Loaded：日志表卡片 + 分页条 + 行数脚注（对齐 web 表格 + 分页布局）
fn render_loaded(
    view: Entity<CrmAuditView>,
    theme: &AppTheme,
    reduce: bool,
    page: usize,
    total: usize,
    table: Entity<DataTable<AuditLogItem>>,
) -> gpui::AnyElement {
    let page_state = PageState::new(page, PAGE_SIZE.max(1), total);
    let view_for_pagination = view.clone();

    crate::motion::enter_fade_in(
        SharedString::from("crm-audit-loaded-fade"),
        v_flex().id("crm-audit-loaded").gap_3().child(
            content_guard().child(
                v_flex()
                    .id("crm-audit-list-card")
                    .w_full()
                    .rounded(px(theme.radius_lg))
                    .border_1()
                    .border_color(theme.separator.opacity(0.6))
                    .bg(theme.card_bg)
                    .shadow(vec![theme.card_shadow_box()])
                    .child(div().w_full().px_4().py_2().child(table))
                    .child(
                        div()
                            .w_full()
                            .px_4()
                            .py_2()
                            .child(pagination::pagination_bar(
                                &view_for_pagination,
                                theme,
                                "crm-audit-pagination",
                                &page_state,
                                &[PAGE_SIZE],
                                |this, page, cx| this.go_to_page(page, cx),
                                // 每页行数固定 30（对齐 web）；下拉仅一档，选中即同值 no-op
                                |this, size, cx| {
                                    if size == PAGE_SIZE {
                                        return;
                                    }
                                    let _ = (this, cx);
                                },
                            )),
                    )
                    .child(
                        div()
                            .px_4()
                            .pb_2()
                            .text_xs()
                            .text_color(theme.text_muted)
                            .child(SharedString::from(format!(
                                "共 {total} 条记录 · 每页 {PAGE_SIZE} 条"
                            ))),
                    ),
            ),
        ),
        reduce,
    )
    .into_any_element()
}

// ---------------------------------------------------------------------------
// 表格列定义
// ---------------------------------------------------------------------------

/// 操作徽标配色（对齐 web ACTION_BADGE 语义分组：create/complete 绿系 /
/// delete 红系 / update 蓝系 / transfer 紫系（chart_secondary）/
/// move_sea 琥珀系 / 其余中性）
fn action_pill_colors(action: &str, theme: &AppTheme) -> (Hsla, Hsla) {
    match action {
        "create" | "complete" => (theme.success_soft, theme.success),
        "delete" => (theme.danger_soft, theme.danger),
        "update" => (theme.chart_primary.opacity(0.12), theme.chart_primary),
        "transfer" => (theme.chart_secondary.opacity(0.12), theme.chart_secondary),
        "move_sea" => (theme.warning.opacity(0.12), theme.warning),
        _ => (theme.muted_fill, theme.text_secondary),
    }
}

/// 操作徽标单元格（软底 pill，对齐 crm_follow_ups::pill 观感）
fn action_pill(item: &AuditLogItem, theme: &AppTheme) -> gpui::AnyElement {
    let (bg, fg) = action_pill_colors(&item.action, theme);
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
                .child(audit_action_label(&item.action)),
        )
        .into_any_element()
}

/// 五列表格（时间 / 对象 / 操作 / 操作人 / 变更；列宽对齐 web TableHead w-*）
fn audit_columns() -> Vec<ColumnDef<AuditLogItem>> {
    vec![
        ColumnDef::text("time", "时间", |item: &AuditLogItem, _theme| {
            SharedString::from(format_audit_time(item.created_at))
        })
        .width(150.0),
        ColumnDef::text("entity", "对象", |item: &AuditLogItem, _theme| {
            SharedString::from(format!(
                "{} #{}",
                audit_entity_label(&item.entity_type),
                item.entity_id
            ))
        })
        .width(110.0),
        ColumnDef::text("action", "操作", |_, _| SharedString::from(""))
            .width(110.0)
            .with_render_element(|item: &AuditLogItem, theme| action_pill(item, theme)),
        ColumnDef::text("actor", "操作人", |item: &AuditLogItem, _theme| {
            // 操作人为空 → 「系统」（对齐 web `actorName ?? '系统'`）
            SharedString::from(
                item.actor_name
                    .clone()
                    .unwrap_or_else(|| "系统".to_string()),
            )
        })
        .width(110.0),
        ColumnDef::text("summary", "变更", |item: &AuditLogItem, _theme| {
            SharedString::from(item.summary.clone().unwrap_or_else(|| "-".to_string()))
        }),
    ]
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn dummy_client() -> Client {
        Client::new("http://127.0.0.1:1")
    }

    fn item(id: i64, entity_type: &str, action: &str) -> AuditLogItem {
        AuditLogItem {
            id,
            entity_type: entity_type.into(),
            entity_id: 3,
            action: action.into(),
            actor_id: Some("u-9".into()),
            actor_name: Some("张三".into()),
            summary: Some(format!("动作 {action}")),
            created_at: chrono::Local
                .with_ymd_and_hms(2026, 8, 21, 10, 30, 0)
                .unwrap()
                .with_timezone(&chrono::Utc),
        }
    }

    fn sample_page() -> AuditLogPage {
        AuditLogPage {
            items: vec![item(1, "customer", "create"), item(2, "lead", "move_sea")],
            total: 42,
            page: 1,
            page_size: PAGE_SIZE as i64,
        }
    }

    // ---------- 常量 / 筛选模型 ----------

    #[test]
    fn url_constant_matches_sidebar() {
        assert_eq!(CRM_AUDIT_URL, "/dashboard/crm/audit");
    }

    /// 对象筛选 ↔ query 参数 / 菜单文案（None = 不带参数，对齐 web「全部对象」）
    #[test]
    fn entity_filter_maps_query_and_label() {
        assert_eq!(EntityFilter::default(), EntityFilter::All, "默认全部对象");
        assert_eq!(EntityFilter::All.as_query(), None);
        assert_eq!(EntityFilter::All.label(), "全部对象");
        assert_eq!(EntityFilter::Customer.as_query(), Some("customer"));
        assert_eq!(EntityFilter::Customer.label(), "客户");
        assert_eq!(EntityFilter::Task.as_query(), Some("task"));
        // 菜单顺序：全部 → 客户 → 线索 → 联系人 → 任务（与 domain 表同序）
        assert_eq!(
            EntityFilter::ALL,
            [
                EntityFilter::All,
                EntityFilter::Customer,
                EntityFilter::Lead,
                EntityFilter::Contact,
                EntityFilter::Task,
            ]
        );
    }

    /// 动作筛选 ↔ query 参数 / 菜单文案；Known 未知 key 标签原样透传
    #[test]
    fn action_filter_maps_query_and_label() {
        assert_eq!(ActionFilter::default(), ActionFilter::All);
        assert_eq!(ActionFilter::All.as_query(), None);
        assert_eq!(ActionFilter::All.label(), "全部操作");

        let create = ActionFilter::Known("create".into());
        assert_eq!(create.as_query(), Some("create"));
        assert_eq!(create.label(), "新建");

        let weird = ActionFilter::Known("weird_action".into());
        assert_eq!(weird.as_query(), Some("weird_action"));
        assert_eq!(weird.label(), "weird_action");
    }

    // ---------- 状态机 ----------

    /// 拉取结果 → 落点状态：有数据 Loaded / 空列表 Empty / 403 Forbidden /
    /// 其他错误 Error
    #[test]
    fn state_from_fetch_result_transitions() {
        let data = sample_page();
        assert_eq!(
            CrmAuditState::from_fetch_result(Ok(data.clone())),
            CrmAuditState::Loaded(Box::new(data.clone()))
        );

        let mut empty = data.clone();
        empty.items.clear();
        assert_eq!(
            CrmAuditState::from_fetch_result(Ok(empty)),
            CrmAuditState::Empty
        );

        // total > 0 但当前页空（越界页）→ 页级 Empty（对齐 web items.length === 0）
        let mut beyond = data.clone();
        beyond.items.clear();
        beyond.total = 42;
        assert_eq!(
            CrmAuditState::from_fetch_result(Ok(beyond)),
            CrmAuditState::Empty
        );

        assert_eq!(
            CrmAuditState::from_fetch_result(Err(FetchFailure {
                forbidden: true,
                message: "仅管理员可访问".into(),
            })),
            CrmAuditState::Forbidden
        );
        assert_eq!(
            CrmAuditState::from_fetch_result(Err(FetchFailure {
                forbidden: false,
                message: "登录已过期".into(),
            })),
            CrmAuditState::Error("登录已过期".into())
        );
    }

    /// ApiError → FetchFailure：403 标记 forbidden；其余错误不标记
    #[test]
    fn fetch_failure_marks_403_only() {
        let forbidden: FetchFailure = ApiError::Http {
            status: 403,
            message: "仅管理员可访问".into(),
        }
        .into();
        assert!(forbidden.forbidden);
        assert_eq!(forbidden.message, "仅管理员可访问");

        let server_err: FetchFailure = ApiError::Http {
            status: 500,
            message: "boom".into(),
        }
        .into();
        assert!(!server_err.forbidden);

        let unauth: FetchFailure = ApiError::Unauthenticated(String::new()).into();
        assert!(!unauth.forbidden, "401 是会话失效不是权限不足");
        assert_eq!(unauth.message, "未登录");
    }

    // ---------- 视觉映射 ----------

    /// 操作徽标语义色分组（亮暗主题一致）：create/complete 绿系、delete 红、
    /// update 蓝、transfer 紫、move_sea 琥珀、其余中性
    #[test]
    fn action_pill_colors_follow_web_badge_semantics() {
        let light = AppTheme::light();
        let dark = AppTheme::dark();
        for theme in [&light, &dark] {
            let (bg, fg) = action_pill_colors("create", theme);
            assert_eq!(bg, theme.success_soft);
            assert_eq!(fg, theme.success);
            assert_eq!(action_pill_colors("complete", theme), (bg, fg));

            assert_eq!(
                action_pill_colors("delete", theme),
                (theme.danger_soft, theme.danger)
            );
            assert_eq!(
                action_pill_colors("update", theme),
                (theme.chart_primary.opacity(0.12), theme.chart_primary)
            );
            assert_eq!(
                action_pill_colors("transfer", theme),
                (theme.chart_secondary.opacity(0.12), theme.chart_secondary)
            );
            assert_eq!(
                action_pill_colors("move_sea", theme),
                (theme.warning.opacity(0.12), theme.warning)
            );
            assert_eq!(
                action_pill_colors("cancel", theme),
                (theme.muted_fill, theme.text_secondary),
                "未知/中性动作用 muted 底"
            );
            assert_eq!(
                action_pill_colors("nope", theme),
                (theme.muted_fill, theme.text_secondary)
            );
        }
    }

    /// 列定义契约：五列、列宽对齐 web TableHead、操作列走自定义渲染
    #[test]
    fn audit_columns_shape_matches_web_table_head() {
        let columns = audit_columns();
        assert_eq!(columns.len(), 5);
        let titles: Vec<&str> = columns.iter().map(|c| c.title.as_ref()).collect();
        assert_eq!(titles, ["时间", "对象", "操作", "操作人", "变更"]);
        assert_eq!(columns[0].width, Some(150.0));
        assert_eq!(columns[1].width, Some(110.0));
        assert_eq!(columns[2].width, Some(110.0));
        assert_eq!(columns[3].width, Some(110.0));
        assert!(columns[4].width.is_none(), "变更列弹性占满剩余空间");
        assert!(columns[2].render_element.is_some(), "操作列徽标自定义渲染");
    }

    // ---------- 渲染冒烟（亮 / 暗 × 全部状态 + 减弱动态） ----------

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
            let (_view, _cx) =
                cx.add_window_view(|_window, cx| CrmAuditView::new(cx, dummy_client()));
        }
    }

    #[gpui::test]
    async fn renders_loaded_in_light_mode(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Light, None, cx);
        });
        let (view, cx2) = cx.add_window_view(|_window, cx| CrmAuditView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            this.state.update(cx, |state, _| {
                *state = CrmAuditState::Loaded(Box::new(sample_page()));
            });
        });
        cx2.read(|app| assert!(!crate::theme::AppTheme::current(app).is_dark()));
    }

    #[gpui::test]
    async fn renders_loaded_in_dark_mode(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Dark, None, cx);
        });
        let (view, cx2) = cx.add_window_view(|_window, cx| CrmAuditView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            this.state.update(cx, |state, _| {
                *state = CrmAuditState::Loaded(Box::new(sample_page()));
            });
        });
        cx2.read(|app| assert!(crate::theme::AppTheme::current(app).is_dark()));
    }

    #[gpui::test]
    async fn renders_error_state(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| CrmAuditView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            this.state.update(cx, |state, _| {
                *state = CrmAuditState::Error("登录已过期".into());
            });
        });
    }

    #[gpui::test]
    async fn renders_empty_state(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| CrmAuditView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            this.state
                .update(cx, |state, _| *state = CrmAuditState::Empty);
        });
    }

    /// Forbidden 态渲染（琥珀兜底面板）
    #[gpui::test]
    async fn renders_forbidden_state(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| CrmAuditView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            this.state
                .update(cx, |state, _| *state = CrmAuditState::Forbidden);
        });
    }

    #[gpui::test]
    async fn renders_loaded_with_reduce_motion(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            cx.set_global(crate::motion::MotionPref(true));
        });
        let (view, cx2) = cx.add_window_view(|_window, cx| CrmAuditView::new(cx, dummy_client()));
        view.update(cx2, |this, cx| {
            this.state.update(cx, |state, _| {
                *state = CrmAuditState::Loaded(Box::new(sample_page()));
            });
        });
    }

    // ---------- 状态机动作 ----------

    /// reload 递增竞态 id 并进入 Loading；过期响应被丢弃（apply_result 竞态保护；
    /// 新鲜响应正常落地并注入表格行）
    #[gpui::test]
    async fn reload_bumps_request_id_and_drops_stale_results(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| CrmAuditView::new(cx, dummy_client()));

        view.update(cx2, |this, cx| {
            let before = this.latest_request_id;
            this.reload(cx);
            assert!(this.latest_request_id > before, "reload 应递增竞态 id");
            assert_eq!(this.current_state(cx), CrmAuditState::Loading);

            // 过期响应（request_id 落后于 latest）应被丢弃，不改变状态
            let stale_id = this.latest_request_id - 1;
            this.apply_result(
                stale_id,
                Err(FetchFailure {
                    forbidden: true,
                    message: "过期响应不应落地".into(),
                }),
                cx,
            );
            assert_eq!(this.current_state(cx), CrmAuditState::Loading);
        });

        // 新鲜响应正常落地
        view.update(cx2, |this, cx| {
            let fresh_id = this.latest_request_id;
            this.apply_result(fresh_id, Ok(sample_page()), cx);
            assert!(matches!(this.current_state(cx), CrmAuditState::Loaded(_)));
            let rows = this.table.read(cx).rows();
            assert_eq!(rows.len(), 2, "新鲜响应应注入表格行");
        });
    }

    /// 切换筛选：更新筛选值并触发 reload 且回第 1 页；同档不重复请求
    #[gpui::test]
    async fn set_filters_reset_page_and_reload(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| CrmAuditView::new(cx, dummy_client()));

        view.update(cx2, |this, cx| {
            // 先翻到第 3 页
            let before = this.latest_request_id;
            this.go_to_page(3, cx);
            assert!(this.latest_request_id > before, "翻页应触发重拉");
            assert_eq!(this.current_filters().2, 3);

            // 切对象筛选：回第 1 页 + 重拉
            let before = this.latest_request_id;
            this.set_entity_filter(EntityFilter::Customer, cx);
            let (entity, _, page) = this.current_filters();
            assert_eq!(entity, EntityFilter::Customer);
            assert_eq!(page, 1, "切筛选回第 1 页");
            assert!(this.latest_request_id > before);

            // 同档再切不重复请求
            let after = this.latest_request_id;
            this.set_entity_filter(EntityFilter::Customer, cx);
            assert_eq!(this.latest_request_id, after, "同档不应重复请求");
        });

        view.update(cx2, |this, cx| {
            // 动作筛选同样回第 1 页 + 重拉
            this.go_to_page(4, cx);
            let before = this.latest_request_id;
            this.set_action_filter(ActionFilter::Known("create".into()), cx);
            let (_, action, page) = this.current_filters();
            assert_eq!(action, ActionFilter::Known("create".into()));
            assert_eq!(page, 1);
            assert!(this.latest_request_id > before);

            let after = this.latest_request_id;
            this.set_action_filter(ActionFilter::Known("create".into()), cx);
            assert_eq!(this.latest_request_id, after, "同档不应重复请求");
        });
    }

    /// go_to_page：非法页号（0）忽略；同页不重复请求
    #[gpui::test]
    async fn go_to_page_guards_invalid_and_same_page(cx: &mut gpui::TestAppContext) {
        cx.update(gpui_component::init);
        let (view, cx2) = cx.add_window_view(|_window, cx| CrmAuditView::new(cx, dummy_client()));

        view.update(cx2, |this, cx| {
            let before = this.latest_request_id;
            this.go_to_page(0, cx);
            assert_eq!(this.latest_request_id, before, "非法页号忽略");
            assert_eq!(this.current_filters().2, 1);

            let after = this.latest_request_id;
            this.go_to_page(1, cx);
            assert_eq!(this.latest_request_id, after, "同页不重复请求");
        });
    }

    // ---------- 展示联动冒烟 ----------

    /// 行内文案联动冒烟：实体标签 + #id 拼接、操作人为空展示「系统」、
    /// 时间走本机时区（域函数口径已在 gui-domain 测过，这里锁视图调用链）
    #[test]
    fn row_display_helpers_via_view_path() {
        let mut log = item(11, "contact", "convert");
        // 行内展示拼 entity_id（非日志主键 id；helper 默认 entity_id=3）
        assert_eq!(
            format!(
                "{} #{}",
                audit_entity_label(&log.entity_type),
                log.entity_id
            ),
            "联系人 #3"
        );
        log.entity_id = 11;
        assert_eq!(
            format!(
                "{} #{}",
                audit_entity_label(&log.entity_type),
                log.entity_id
            ),
            "联系人 #11"
        );
        assert_eq!(audit_action_label(&log.action), "转化");

        log.actor_name = None;
        assert_eq!(
            log.actor_name.clone().unwrap_or_else(|| "系统".to_string()),
            "系统"
        );
    }
}
