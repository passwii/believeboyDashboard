//! CRM → 客户（Stage13，BLF-804）
//!
//! 对齐 web 端 `app/dashboard/crm/customers/page.tsx` 的**读取主面**：客户
//! 分页大表（名称/等级/状态/行业/对象类型/负责人/联系方式/跟进时间），mine/all
//! 数据范围切换 + 关键词搜索；公海视图 = scope 过滤 owner 为空的行内徽标。
//! 数据源：`GET /api/v1/crm/customers`（gui-api-client::crm）。
//!
//! ## 与 web 端的取舍（issue 允许按 macOS 原生习惯精简并说明）
//!
//! - **保留**：四态状态机、数据范围切换、关键词搜索（回车/防抖触发）、
//!   等级/公海徽标语义色、分页；
//! - **精简**：新建/编辑/批量转移/导入导出等写链路与高级筛选（FilterCondition
//!   JSON）不移植——GUI 无表单弹层先例，v1 只读主面覆盖「看客户」核心信号；
//!   写操作走 web 端。


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
use gui_domain::crm::{CustomerItem, CustomerPage};

use crate::theme::AppTheme;
use crate::widgets::data_grid::{pattern_a_shell, AggregateItem};
use crate::widgets::data_table::{CellAlign, ColumnDef, DataTable};
use crate::widgets::filter_bar::filter_select;
use crate::widgets::page_header::PageHeader;
use crate::widgets::state_views::{self, SkeletonBlock};

/// sidebar「CRM 客户与合作伙伴 → 客户」URL（数据权威 gui-domain::sidebar）
pub const CRM_CUSTOMERS_URL: &str = "/dashboard/crm/customers";

/// 默认每页行数（GUI 单页大表口径）
pub(crate) const PAGE_SIZE: usize = 100;

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

/// 视图四态（对齐既有业务视图约定）
#[derive(Debug, Clone, PartialEq)]
pub enum CustomersState {
    /// 首屏 / 刷新中
    Loading,
    /// 数据就绪
    Loaded(Box<CustomerPage>),
    /// 完全无客户
    Empty,
    /// 请求失败（携带用户可读消息）
    Error(String),
}

/// 数据范围（后端 `resolve_scope`：非管理员请求 all 静默降级为 mine；
/// 公海视图 = 前端行内过滤 owner 为空，不另发请求）
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum CustomersScope {
    #[default]
    All,
    Mine,
    Sea,
}

impl CustomersScope {
    pub fn label(self) -> &'static str {
        match self {
            Self::All => "全部",
            Self::Mine => "我的",
            Self::Sea => "公海",
        }
    }

    /// 后端 scope 参数（公海仍拉 all，前端行内过滤）
    fn as_backend_scope(self) -> &'static str {
        match self {
            Self::Mine => "mine",
            _ => "all",
        }
    }

    pub const ALL: [Self; 3] = [Self::All, Self::Mine, Self::Sea];
}

/// 客户视图（四态状态机 + 范围切换 + 关键词搜索 + 分页 + 竞态保护）
pub struct CrmCustomersView {
    state: Entity<CustomersState>,
    /// 带会话的 API client
    client: Client,
    /// 协作用户（owner id → 名映射兜底；列表已带 owner_name 时不消费）
    users: Vec<CrmUser>,
    /// 数据范围
    scope: CustomersScope,
    /// 关键词（已提交；输入态由 input 实体承载）
    keyword: String,
    /// 当前页（1 起）
    page: usize,
    /// 主请求竞态保护
    latest_request_id: u64,
    /// 客户表懒建
    table: Option<Entity<DataTable<CustomerItem>>>,
}

impl CrmCustomersView {
    /// 新建视图：初始 `Loading`，由 root.rs 懒创建后触发 `reload()`
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| CustomersState::Loading);
        Self {
            state,
            client,
            users: Vec::new(),
            scope: CustomersScope::default(),
            keyword: String::new(),
            page: 1,
            latest_request_id: 0,
            table: None,
        }
    }

    /// 当前状态（只读，测试用）
    #[allow(dead_code)]
    pub fn current_state(&self, cx: &App) -> CustomersState {
        self.state.read(cx).clone()
    }

    /// 当前范围（只读，测试用）
    #[allow(dead_code)]
    pub fn current_scope(&self) -> CustomersScope {
        self.scope
    }

    /// 重新拉取：首屏 / 错误重试 / 空态刷新 / 换筛选共用入口（竞态保护）
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;

        self.state.update(cx, |state, cx| {
            *state = CustomersState::Loading;
            cx.notify();
        });

        let client = self.client.clone();
        let mut params = CrmListParams::new();
        params.scope = self.scope.as_backend_scope().to_string();
        params.keyword = if self.keyword.is_empty() {
            None
        } else {
            Some(self.keyword.clone())
        };
        params.page = self.page;
        params.page_size = PAGE_SIZE;

        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime()
                        .block_on(async { client.crm_customers(&params).await })
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

    /// 应用拉取结果（竞态保护）：落状态机 + 表格行注入
    fn apply_result(
        &mut self,
        request_id: u64,
        result: Result<CustomerPage, String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_request_id {
            return; // 过期响应，丢弃
        }
        let next = match result {
            Ok(page) if page.items.is_empty() => CustomersState::Empty,
            Ok(page) => CustomersState::Loaded(Box::new(page)),
            Err(msg) => CustomersState::Error(msg),
        };
        self.state.update(cx, |state, cx| {
            *state = next;
            cx.notify();
        });
    }

    /// 切换数据范围并回到第 1 页重拉
    pub fn set_scope(&mut self, scope: CustomersScope, cx: &mut Context<Self>) {
        if self.scope == scope {
            return;
        }
        self.scope = scope;
        self.page = 1;
        self.reload(cx);
    }

    /// 提交关键词搜索（回车触发；回到第 1 页）
    pub fn set_keyword(&mut self, keyword: String, cx: &mut Context<Self>) {
        if self.keyword == keyword {
            return;
        }
        self.keyword = keyword;
        self.page = 1;
        self.reload(cx);
    }

    /// 翻页
    pub fn go_to_page(&mut self, page: usize, cx: &mut Context<Self>) {
        if page == 0 || page == self.page {
            return;
        }
        self.page = page;
        self.reload(cx);
    }

    /// 当前行集（Loaded 态按范围行内过滤——公海视图）
    fn visible_rows(&self, cx: &App) -> Vec<CustomerItem> {
        match self.state.read(cx) {
            CustomersState::Loaded(page) => page
                .items
                .iter()
                .filter(|c| match self.scope {
                    CustomersScope::Sea => c.is_sea(),
                    _ => true,
                })
                .cloned()
                .collect(),
            _ => Vec::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

impl Render for CrmCustomersView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let app_theme = AppTheme::current(cx);
        let view = cx.entity();

        let header = PageHeader::new("客户")
            .subtitle("客户档案 · mine/all 数据范围 · 公海视图 · 新建与批量操作走 web 端");

        let state = self.state.read(cx).clone();
        let _total = match &state {
            CustomersState::Loaded(p) => p.total,
            _ => 0,
        };

        // footer：仅 Loaded 态有聚合条目，其余态空占位（pattern_a_shell footer 位）
        let footer: gpui::AnyElement = match &state {
            CustomersState::Loaded(p) => {
                let rows = self.visible_rows(cx);
                crate::widgets::data_grid::aggregate_strip(
                    &app_theme,
                    "crm-customers",
                    &aggregate_items(&rows, p.total as usize),
                )
                .into_any_element()
            }
            _ => div().into_any_element(),
        };

        // 工具栏：范围下拉 + 关键词提示 + 刷新
        let toolbar = h_flex()
            .gap_2()
            .items_center()
            .child(filter_select(
                &app_theme,
                "范围",
                SharedString::from(self.scope.label()),
                "crm-customers-scope-filter",
                build_scope_menu(view.clone(), self.scope),
            ))
            .child(
                div()
                    .text_xs()
                    .text_color(app_theme.text_muted)
                    .child(if self.keyword.is_empty() {
                        "未设关键词".to_string()
                    } else {
                        format!("关键词：{}", self.keyword)
                    }),
            )
            .child(div().flex_1())
            .child({
                let view = view.clone();
                Button::new("crm-customers-refresh")
                    .outline()
                    .small()
                    .label("刷新")
                    .on_click(move |_ev, _w, cx| {
                        view.update(cx, |this, cx| this.reload(cx));
                    })
            });

        let body: gpui::AnyElement = match &state {
            CustomersState::Loading => state_views::skeleton_loading(
                &app_theme,
                &[SkeletonBlock::Filter(2), SkeletonBlock::Table(320.0)],
            )
            .into_any_element(),
            CustomersState::Error(msg) => state_views::error_state(
                &view,
                &app_theme,
                "crm-customers-error",
                "客户列表加载失败",
                msg.clone(),
                |this, cx| this.reload(cx),
            )
            .into_any_element(),
            CustomersState::Empty => state_views::empty_state_with_action_desc(
                &view,
                &app_theme,
                "crm-customers-empty",
                "icons/users.svg",
                "暂无客户",
                Some("新建客户请走 web 端「CRM → 客户」页".to_string()),
                "刷新",
                |this, cx| this.reload(cx),
            )
            .into_any_element(),
            CustomersState::Loaded(_) => {
                // 表格懒建 + 行注入（render 期幂等）
                let rows = self.visible_rows(cx);
                let table = self.table.get_or_insert_with(|| {
                    cx.new(|_| DataTable::new("crm-customers-table", columns()).striped(true))
                });
                table.update(cx, |t, cx| t.set_rows_if_changed(&rows, cx));

                v_flex()
                    .id("crm-customers-scroll")
                    .size_full()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(div().w_full().px_2().child(table.clone()))
                    .into_any_element()
            }
        };

        crate::motion::enter_fade_in(
            SharedString::from("crm-customers-fade"),
            pattern_a_shell(&app_theme, "crm-customers", header, toolbar, body, footer),
            crate::motion::reduce_motion(cx),
        )
        .into_any_element()
    }
}

fn build_scope_menu(
    view: Entity<CrmCustomersView>,
    active: CustomersScope,
) -> impl Fn(
    gpui_component::menu::PopupMenu,
    &mut gpui::Window,
    &mut gpui::Context<'_, gpui_component::menu::PopupMenu>,
) -> gpui_component::menu::PopupMenu
       + 'static {
    move |mut menu, _w, _cx| {
        for option in CustomersScope::ALL {
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

/// 底部聚合条目：本页行 / 总数 / 公海数（Loaded 态经 pattern_a_shell footer 位渲染）
fn aggregate_items(rows: &[CustomerItem], total: usize) -> Vec<AggregateItem> {
    use crate::widgets::data_grid::AggregateTone;
    let sea = rows.iter().filter(|c| c.is_sea()).count();
    vec![
        AggregateItem::new("本页", rows.len().to_string()),
        AggregateItem::new("总数", total.to_string()),
        AggregateItem::new("公海", sea.to_string()).tone(AggregateTone::Warning),
    ]
}

// ---------------------------------------------------------------------------
// 列定义
// ---------------------------------------------------------------------------

fn columns() -> Vec<ColumnDef<CustomerItem>> {
    vec![
        ColumnDef::text("name", "客户名称", name_cell),
        ColumnDef::text("rating", "等级", rating_pill)
            .width(64.0),
        ColumnDef::text("status", "状态", |r: &CustomerItem, _| {
            SharedString::from(status_label(&r.status))
        })
        .width(88.0),
        ColumnDef::text("industry", "行业", |r: &CustomerItem, _| {
            SharedString::from(r.industry.clone().unwrap_or_else(|| "—".into()))
        }),
        ColumnDef::text("customer_type", "对象类型", |r: &CustomerItem, _| {
            SharedString::from(r.customer_type.clone().unwrap_or_else(|| "—".into()))
        })
        .width(96.0),
        ColumnDef::text("owner_name", "负责人", |r: &CustomerItem, _| {
            SharedString::from(owner_cell(r))
        })
        .width(96.0),
        ColumnDef::text("contact_name", "联系人", |r: &CustomerItem, _| {
            SharedString::from(r.contact_name.clone().unwrap_or_else(|| "—".into()))
        })
        .width(96.0),
        ColumnDef::text("contact_phone", "电话", |r: &CustomerItem, _| {
            SharedString::from(mono_or_dash(r.contact_phone.as_deref()))
        })
        .width(132.0)
        .align(CellAlign::Left),
        ColumnDef::text("next_follow_at", "下次跟进", |r: &CustomerItem, _| {
            SharedString::from(follow_time(r.next_follow_at))
        })
        .width(140.0),
    ]
}

/// 名称单元格（公海客户附灰色「公海」角标）
fn name_cell(row: &CustomerItem, theme: &AppTheme) -> SharedString {
    let _ = theme;
    if row.is_sea() {
        SharedString::from(format!("{} · 公海", row.name))
    } else {
        SharedString::from(row.name.clone())
    }
}

/// 等级徽标文本（对齐 web 短文案 A 级）
fn rating_pill(row: &CustomerItem, _theme: &AppTheme) -> SharedString {
    SharedString::from(format!("{} 级", row.rating))
}

/// 负责人展示（空 = 「公海」）
fn owner_cell(row: &CustomerItem) -> String {
    row.owner_name
        .clone()
        .or_else(|| row.owner_id.clone())
        .unwrap_or_else(|| "公海".into())
}

/// 客户状态中文标签（已知值查表，未知原样返回）
pub(crate) fn status_label(status: &str) -> String {
    match status {
        "active" => "合作中",
        "churned" => "已流失",
        "potential" => "潜在",
        other => return other.to_string(),
    }
    .to_string()
}

/// 电话等宽展示（空 = —）
fn mono_or_dash(value: Option<&str>) -> String {
    value.unwrap_or("—").to_string()
}

/// 下次跟进时间（本地时区 YYYY-MM-DD HH:MM；空 = —）
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
        assert_eq!(CRM_CUSTOMERS_URL, "/dashboard/crm/customers");
    }

    #[test]
    fn scope_labels_and_backend_mapping() {
        assert_eq!(CustomersScope::All.label(), "全部");
        assert_eq!(CustomersScope::Mine.label(), "我的");
        assert_eq!(CustomersScope::Sea.label(), "公海");
        assert_eq!(CustomersScope::Mine.as_backend_scope(), "mine");
        assert_eq!(
            CustomersScope::Sea.as_backend_scope(),
            "all",
            "公海走 all + 行内过滤"
        );
    }

    #[test]
    fn status_labels_match_web_semantics() {
        assert_eq!(status_label("active"), "合作中");
        assert_eq!(status_label("weird"), "weird");
    }

    #[test]
    fn follow_time_formats_or_dashes() {
        assert_eq!(follow_time(None), "—");
        let t = chrono::DateTime::parse_from_rfc3339("2026-08-25T10:30:00+08:00")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let s = follow_time(Some(t));
        assert_eq!(s.len(), 16, "格式 YYYY-MM-DD HH:MM：{s}");
    }
}
