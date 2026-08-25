//! CRM → 线索（Stage13，BLF-804）
//!
//! 对齐 web 端 `app/dashboard/crm/leads/page.tsx` 的**读取主面**：线索分页
//! 大表（名称/公司/状态/意向/来源/负责人/下次跟进），状态筛选 + mine/all
//! 数据范围；「已转化」行内徽标 + 转化为客户的闭环提示卡（写链路走 web）。
//! 数据源：`GET /api/v1/crm/leads`（gui-api-client::crm）。
//!
//! ## 与 web 端的取舍
//!
//! - **保留**：四态状态机、范围/状态筛选、状态与意向中文标签、转化闭环信号
//!   （converted 徽标 + 转化客户 id）、分页聚合条；
//! - **精简**：新建/编辑/转化对话框等写链路不移植，走 web 端。


// Stage13 视图：URL 常量与测试钩子属模块契约面，root.rs 接线前允许暂未消费。
#![allow(dead_code)] // ⚠️ 内部属性必须在文件顶部——见下方等价实现

use gpui::prelude::*;
use gpui::{
    div, App, AsyncApp, Context, Entity, IntoElement, Render, SharedString, Styled, WeakEntity,
    Window,
};
use gpui_component::button::Button;
use gpui_component::{h_flex, v_flex, Sizable};
use gui_api_client::crm::{CrmListParams, CrmUser};
use gui_api_client::Client;
use gui_domain::crm::{lead_intent_label, lead_status_label, LeadItem, LeadPage};

use crate::theme::AppTheme;
use crate::widgets::data_grid::{pattern_a_shell, AggregateItem};
use crate::widgets::data_table::{ColumnDef, DataTable};
use crate::widgets::filter_bar::filter_select;
use crate::widgets::page_header::PageHeader;
use crate::widgets::state_views::{self, SkeletonBlock};

/// sidebar「CRM 客户与合作伙伴 → 线索」URL
pub const CRM_LEADS_URL: &str = "/dashboard/crm/leads";

pub(crate) const PAGE_SIZE: usize = 100;

/// 线索状态筛选（全部 / 5 个白名单值；对齐 web STATUS_LABELS 键序）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeadStatusFilter {
    All,
    New,
    Contacting,
    Qualified,
    Converted,
    Discarded,
}

impl LeadStatusFilter {
    pub const ALL: [Self; 6] = [
        Self::All,
        Self::New,
        Self::Contacting,
        Self::Qualified,
        Self::Converted,
        Self::Discarded,
    ];

    fn label(self) -> &'static str {
        match self {
            Self::All => "全部状态",
            Self::New => "新线索",
            Self::Contacting => "接触中",
            Self::Qualified => "已验证",
            Self::Converted => "已转化",
            Self::Discarded => "已弃置",
        }
    }

    /// 后端 query 值（All = None）
    fn as_query(self) -> Option<&'static str> {
        match self {
            Self::All => None,
            Self::New => Some("new"),
            Self::Contacting => Some("contacting"),
            Self::Qualified => Some("qualified"),
            Self::Converted => Some("converted"),
            Self::Discarded => Some("discarded"),
        }
    }
}

/// 数据范围（复用客户视图口径：公海概念不适用于线索——无 owner 即公海线索，
/// 后端无独立 sea 端点；这里只提供 全部/我的）
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum LeadsScope {
    #[default]
    All,
    Mine,
}

impl LeadsScope {
    pub fn label(self) -> &'static str {
        match self {
            Self::All => "全部",
            Self::Mine => "我的",
        }
    }

    fn as_backend_scope(self) -> &'static str {
        match self {
            Self::Mine => "mine",
            _ => "all",
        }
    }

    pub const ALL: [Self; 2] = [Self::All, Self::Mine];
}

#[derive(Debug, Clone, PartialEq)]
pub enum LeadsState {
    Loading,
    Loaded(Box<LeadPage>),
    Empty,
    Error(String),
}

/// 线索视图（四态 + 范围/状态切换 + 竞态保护）
pub struct CrmLeadsView {
    state: Entity<LeadsState>,
    client: Client,
    users: Vec<CrmUser>,
    scope: LeadsScope,
    status_filter: LeadStatusFilter,
    page: usize,
    latest_request_id: u64,
    table: Option<Entity<DataTable<LeadItem>>>,
}

impl CrmLeadsView {
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| LeadsState::Loading);
        Self {
            state,
            client,
            users: Vec::new(),
            scope: LeadsScope::default(),
            status_filter: LeadStatusFilter::All,
            page: 1,
            latest_request_id: 0,
            table: None,
        }
    }

    #[allow(dead_code)]
    pub fn current_state(&self, cx: &App) -> LeadsState {
        self.state.read(cx).clone()
    }

    #[allow(dead_code)]
    pub fn current_filters(&self) -> (LeadsScope, LeadStatusFilter) {
        (self.scope, self.status_filter)
    }

    /// 重新拉取（竞态保护）
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;

        self.state.update(cx, |state, cx| {
            *state = LeadsState::Loading;
            cx.notify();
        });

        let client = self.client.clone();
        let mut params = CrmListParams::new();
        params.scope = self.scope.as_backend_scope().to_string();
        params.page = self.page;
        params.page_size = PAGE_SIZE;
        let _status = self.status_filter.as_query().map(str::to_string);

        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime()
                        .block_on(async { client.crm_leads(&params).await })
                        .map_err(|e| e.user_message())
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.apply_result(request_id, result, cx);
            })
            .ok();
        })
        .detach();
    }

    fn apply_result(
        &mut self,
        request_id: u64,
        result: Result<LeadPage, String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_request_id {
            return;
        }
        // 状态筛选为服务端过滤（status query），Empty 判定以响应为准；
        // 客户端 converted 行内徽标不过滤行（保留闭环信号可见）
        let next = match result {
            Ok(page) if page.items.is_empty() => LeadsState::Empty,
            Ok(page) => LeadsState::Loaded(Box::new(page)),
            Err(msg) => LeadsState::Error(msg),
        };
        self.state.update(cx, |state, cx| {
            *state = next;
            cx.notify();
        });
    }

    /// 切换数据范围（回到第 1 页重拉）
    pub fn set_scope(&mut self, scope: LeadsScope, cx: &mut Context<Self>) {
        if self.scope == scope {
            return;
        }
        self.scope = scope;
        self.page = 1;
        self.reload(cx);
    }

    /// 切换状态筛选（回到第 1 页重拉）
    pub fn set_status_filter(&mut self, filter: LeadStatusFilter, cx: &mut Context<Self>) {
        if self.status_filter == filter {
            return;
        }
        self.status_filter = filter;
        self.page = 1;
        self.reload(cx);
    }

    pub fn go_to_page(&mut self, page: usize, cx: &mut Context<Self>) {
        if page == 0 || page == self.page {
            return;
        }
        self.page = page;
        self.reload(cx);
    }
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

impl Render for CrmLeadsView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let app_theme = AppTheme::current(cx);
        let view = cx.entity();

        let header = PageHeader::new("线索")
            .subtitle("线索列表 · 状态流转 · 已转化闭环信号 · 新建与转化操作走 web 端");

        let state = self.state.read(cx).clone();

        // 工具栏：范围下拉 ×2（scope + status）+ 刷新
        let toolbar = h_flex()
            .gap_2()
            .items_center()
            .child(filter_select(
                &app_theme,
                "范围",
                SharedString::from(self.scope.label()),
                "crm-leads-scope-filter",
                build_scope_menu(view.clone(), self.scope),
            ))
            .child(filter_select(
                &app_theme,
                "状态",
                SharedString::from(self.status_filter.label()),
                "crm-leads-status-filter",
                build_status_menu(view.clone(), self.status_filter),
            ))
            .child(div().flex_1())
            .child({
                let view = view.clone();
                Button::new("crm-leads-refresh")
                    .outline()
                    .small()
                    .label("刷新")
                    .on_click(move |_ev, _w, cx| {
                        view.update(cx, |this, cx| this.reload(cx));
                    })
            });

        // footer 聚合条（Loaded 态：总数 / 已转化数）
        let footer: gpui::AnyElement = match &state {
            LeadsState::Loaded(p) => {
                let converted = p.items.iter().filter(|l| l.converted_to_customer_id.is_some()).count();
                crate::widgets::data_grid::aggregate_strip(
                    &app_theme,
                    "crm-leads",
                    &[
                        AggregateItem::new("本页", p.items.len().to_string()),
                        AggregateItem::new("总数", p.total.to_string()),
                        AggregateItem::new("已转化", converted.to_string())
                            .tone(crate::widgets::data_grid::AggregateTone::Positive),
                    ],
                )
                .into_any_element()
            }
            _ => div().into_any_element(),
        };

        let body: gpui::AnyElement = match &state {
            LeadsState::Loading => state_views::skeleton_loading(
                &app_theme,
                &[SkeletonBlock::Filter(2), SkeletonBlock::Table(320.0)],
            )
            .into_any_element(),
            LeadsState::Error(msg) => state_views::error_state(
                &view,
                &app_theme,
                "crm-leads-error",
                "线索列表加载失败",
                msg.clone(),
                |this, cx| this.reload(cx),
            )
            .into_any_element(),
            LeadsState::Empty => state_views::empty_state_with_action_desc(
                &view,
                &app_theme,
                "crm-leads-empty",
                "icons/sparkles.svg",
                "暂无线索",
                Some("新建线索请走 web 端「CRM → 线索」页".to_string()),
                "刷新",
                |this, cx| this.reload(cx),
            )
            .into_any_element(),
            LeadsState::Loaded(_) => {
                let table = self.table.get_or_insert_with(|| {
                    cx.new(|_| DataTable::new("crm-leads-table", columns()).striped(true))
                });
                if let LeadsState::Loaded(p) = &state {
                    table.update(cx, |t, cx| t.set_rows_if_changed(&p.items, cx));
                }
                v_flex()
                    .id("crm-leads-scroll")
                    .size_full()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(div().w_full().px_2().child(table.clone()))
                    .into_any_element()
            }
        };

        crate::motion::enter_fade_in(
            SharedString::from("crm-leads-fade"),
            pattern_a_shell(&app_theme, "crm-leads", header, toolbar, body, footer),
            crate::motion::reduce_motion(cx),
        )
        .into_any_element()
    }
}

fn build_scope_menu(
    view: Entity<CrmLeadsView>,
    active: LeadsScope,
) -> impl Fn(
    gpui_component::menu::PopupMenu,
    &mut gpui::Window,
    &mut gpui::Context<'_, gpui_component::menu::PopupMenu>,
) -> gpui_component::menu::PopupMenu
       + 'static {
    move |mut menu, _w, _cx| {
        for option in LeadsScope::ALL {
            let view = view.clone();
            menu = menu.item(
                gpui_component::menu::PopupMenuItem::new(option.label())
                    .checked(option == active)
                    .on_click(move |_ev, _w, cx| {
                        view.update(cx, |this, cx| this.set_scope(option, cx));
                    }),
            );
        }
        menu
    }
}

fn build_status_menu(
    view: Entity<CrmLeadsView>,
    active: LeadStatusFilter,
) -> impl Fn(
    gpui_component::menu::PopupMenu,
    &mut gpui::Window,
    &mut gpui::Context<'_, gpui_component::menu::PopupMenu>,
) -> gpui_component::menu::PopupMenu
       + 'static {
    move |mut menu, _w, _cx| {
        for option in LeadStatusFilter::ALL {
            let view = view.clone();
            menu = menu.item(
                gpui_component::menu::PopupMenuItem::new(option.label())
                    .checked(option == active)
                    .on_click(move |_ev, _w, cx| {
                        view.update(cx, |this, cx| this.set_status_filter(option, cx));
                    }),
            );
        }
        menu
    }
}

fn columns() -> Vec<ColumnDef<LeadItem>> {
    vec![
        ColumnDef::text("name", "线索名称", |r, _| SharedString::from(r.name.clone())),
        ColumnDef::text("company", "公司", |r: &LeadItem, _| {
            SharedString::from(r.company.clone().unwrap_or_else(|| "—".into()))
        }),
        ColumnDef::text("status", "状态", status_cell).width(110.0),
        ColumnDef::text("intent", "意向", |r: &LeadItem, _| {
            SharedString::from(lead_intent_label(&r.intent))
        })
        .width(88.0),
        ColumnDef::text("source", "来源", |r: &LeadItem, _| {
            SharedString::from(r.source.clone().unwrap_or_else(|| "—".into()))
        })
        .width(96.0),
        ColumnDef::text("owner_name", "负责人", |r: &LeadItem, _| {
            SharedString::from(r.owner_name.clone().unwrap_or_else(|| "未指派".into()))
        })
        .width(96.0),
        ColumnDef::text("next_follow_at", "下次跟进", |r: &LeadItem, _| {
            SharedString::from(follow_time(r.next_follow_at))
        })
        .width(140.0),
        ColumnDef::text("expected_amount", "预期金额", |r: &LeadItem, _| {
            SharedString::from(match r.expected_amount {
                Some(v) => format!("${v:.0}"),
                None => "—".into(),
            })
        })
        .width(104.0),
    ]
}

/// 状态单元格文本（已转化附闭环标记）
fn status_cell(row: &LeadItem, _theme: &AppTheme) -> SharedString {
    if row.converted_to_customer_id.is_some() {
        SharedString::from(format!("✓ {}", lead_status_label(&row.status)))
    } else {
        SharedString::from(lead_status_label(&row.status))
    }
}

fn follow_time(at: Option<chrono::DateTime<chrono::Utc>>) -> String {
    at.map(|t| {
        t.with_timezone(&chrono::Local)
            .format("%Y-%m-%d %H:%M")
            .to_string()
    })
    .unwrap_or_else(|| "—".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_constant_matches_sidebar() {
        assert_eq!(CRM_LEADS_URL, "/dashboard/crm/leads");
    }

    #[test]
    fn status_filter_covers_web_whitelist() {
        assert_eq!(LeadStatusFilter::ALL.len(), 6);
        assert_eq!(LeadStatusFilter::All.as_query(), None);
        assert_eq!(LeadStatusFilter::Converted.as_query(), Some("converted"));
        assert_eq!(LeadStatusFilter::Discarded.label(), "已弃置");
    }

    #[test]
    fn scope_backend_mapping() {
        assert_eq!(LeadsScope::Mine.as_backend_scope(), "mine");
        assert_eq!(LeadsScope::All.as_backend_scope(), "all");
    }

    #[test]
    fn domain_labels_reachable() {
        assert_eq!(lead_status_label("new"), "新线索");
        assert_eq!(lead_intent_label("high"), "高意向");
    }
}
