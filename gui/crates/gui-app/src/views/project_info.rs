//! 系统管理 → 项目信息（Stage13，BLF-804）
//!
//! 对齐 web 端 `app/dashboard/system/project-info/page.tsx` 的**只读主面**：
//! 项目档案大表（名称 / 品牌 / 店铺地址 / 运营 / 助理运营 / 佣金口径 /
//! 费率 / 层级 / 启用状态），数据源 `GET /api/v1/projects/manage`
//! （gui-api-client::dashboard `list_managed_projects`，与控制条项目选择器
//! 同源；按 X-Operator 过滤可见项目）。
//!
//! ## 与 web 端的取舍（issue 允许按 macOS 原生习惯精简并说明）
//!
//! - **保留**：四态状态机、关键词行内过滤、启用/停用徽标、佣金口径中文、
//!   排序号；
//! - **精简**：新建 / 编辑 / 项目上下文（ProjectContextDrawer）等写链路与
//!   配置抽屉不移植——GUI 无表单弹层先例，维护走 web 端。


// Stage13 视图：URL 常量与测试钩子属模块契约面，root.rs 接线前允许暂未消费。
#![allow(dead_code)] // ⚠️ 内部属性必须在文件顶部——见下方等价实现

use gpui::prelude::*;
use gpui::{
    div, App, AsyncApp, Context, Entity, IntoElement, Render, SharedString, WeakEntity, Window,
};
use gpui_component::button::Button;
use gpui_component::{h_flex, v_flex, Sizable};
use gui_api_client::Client;
use gui_domain::common::ManagedProject;

use crate::theme::AppTheme;
use crate::widgets::data_grid::{pattern_a_shell, AggregateItem};
use crate::widgets::data_table::{ColumnDef, DataTable};
use crate::widgets::page_header::PageHeader;
use crate::widgets::state_views::{self, SkeletonBlock};

/// sidebar「系统管理 → 项目信息」URL（数据权威 gui-domain::sidebar）
pub const PROJECT_INFO_URL: &str = "/dashboard/system/project-info";

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum ProjectsState {
    Loading,
    Loaded(Vec<ManagedProject>),
    Empty,
    Error(String),
}

/// 项目信息视图（四态 + 关键词过滤 + 竞态保护）
pub struct ProjectInfoView {
    state: Entity<ProjectsState>,
    client: Client,
    /// 关键词（名称 / 品牌 / 地址行内过滤）
    keyword: String,
    latest_request_id: u64,
    table: Option<Entity<DataTable<ManagedProject>>>,
}

impl ProjectInfoView {
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| ProjectsState::Loading);
        Self {
            state,
            client,
            keyword: String::new(),
            latest_request_id: 0,
            table: None,
        }
    }

    #[allow(dead_code)]
    pub(crate) fn current_state(&self, cx: &App) -> ProjectsState {
        self.state.read(cx).clone()
    }

    /// 当前关键词（测试用）
    #[allow(dead_code)]
    pub fn current_keyword(&self) -> &str {
        &self.keyword
    }

    /// 首屏拉取
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;

        self.state.update(cx, |state, cx| {
            *state = ProjectsState::Loading;
            cx.notify();
        });

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime()
                        .block_on(async { client.list_managed_projects().await })
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
        result: Result<Vec<ManagedProject>, String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_request_id {
            return;
        }
        let next = match result {
            Ok(items) if items.is_empty() => ProjectsState::Empty,
            Ok(items) => ProjectsState::Loaded(items),
            Err(msg) => ProjectsState::Error(msg),
        };
        self.state.update(cx, |state, cx| {
            *state = next;
            cx.notify();
        });
    }

    /// 设置行内过滤关键词（实时过滤，不发请求）
    pub fn set_keyword(&mut self, keyword: String, cx: &mut Context<Self>) {
        if self.keyword == keyword {
            return;
        }
        self.keyword = keyword;
        cx.notify();
    }

    /// 过滤后行集（名称 / 品牌 / 地址包含关键词，大小写不敏感）
    fn visible_rows(&self, cx: &App) -> Vec<ManagedProject> {
        let ProjectsState::Loaded(items) = self.state.read(cx) else {
            return Vec::new();
        };
        if self.keyword.is_empty() {
            return items.clone();
        }
        let kw = self.keyword.to_lowercase();
        items
            .iter()
            .filter(|p| {
                p.name.to_lowercase().contains(&kw)
                    || p.brand_name
                        .as_deref()
                        .is_some_and(|b| b.to_lowercase().contains(&kw))
                    || p.store_address
                        .as_deref()
                        .is_some_and(|s| s.to_lowercase().contains(&kw))
            })
            .cloned()
            .collect()
    }
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

impl Render for ProjectInfoView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let app_theme = AppTheme::current(cx);
        let view = cx.entity();
        let state = self.state.read(cx).clone();

        let header = PageHeader::new("项目信息")
            .subtitle("项目档案 · 编辑与上下文配置走 web 端")
            .action({
                let view = view.clone();
                Button::new("project-info-refresh")
                    .outline()
                    .small()
                    .label("刷新")
                    .on_click(move |_ev, _w, cx| {
                        view.update(cx, |this, cx| this.reload(cx));
                    })
            });

        // 工具栏：关键词提示（GUI 无检索输入框先例，行内过滤由后续统一补）
        let toolbar = h_flex().gap_2().items_center().child(
            div()
                .text_xs()
                .text_color(app_theme.text_muted)
                .child(if self.keyword.is_empty() {
                    "全部项目".to_string()
                } else {
                    format!("过滤：{}", self.keyword)
                }),
        );

        let rows = self.visible_rows(cx);

        // footer 聚合：总数 / 启用 / 停用
        let footer: gpui::AnyElement = match &state {
            ProjectsState::Loaded(_) => {
                let active = rows.iter().filter(|p| p.is_active).count();
                crate::widgets::data_grid::aggregate_strip(
                    &app_theme,
                    "project-info",
                    &[
                        AggregateItem::new("项目数", rows.len().to_string()),
                        AggregateItem::new("启用", active.to_string())
                            .tone(crate::widgets::data_grid::AggregateTone::Positive),
                        AggregateItem::new("停用", (rows.len() - active).to_string()),
                    ],
                )
                .into_any_element()
            }
            _ => div().into_any_element(),
        };

        let body: gpui::AnyElement = match &state {
            ProjectsState::Loading => state_views::skeleton_loading(
                &app_theme,
                &[SkeletonBlock::Filter(2), SkeletonBlock::Table(320.0)],
            )
            .into_any_element(),
            ProjectsState::Error(msg) => state_views::error_state(
                &view,
                &app_theme,
                "project-info-error",
                "项目列表加载失败",
                msg.clone(),
                |this, cx| this.reload(cx),
            )
            .into_any_element(),
            ProjectsState::Empty => state_views::empty_state_with_action_desc(
                &view,
                &app_theme,
                "project-info-empty",
                "icons/store.svg",
                "暂无可见项目",
                Some("当前账号无可见项目，或项目尚未创建".to_string()),
                "刷新",
                |this, cx| this.reload(cx),
            )
            .into_any_element(),
            ProjectsState::Loaded(_) => {
                let table = self.table.get_or_insert_with(|| {
                    cx.new(|_| DataTable::new("project-info-table", columns()).striped(true))
                });
                table.update(cx, |t, cx| t.set_rows_if_changed(&rows, cx));

                v_flex()
                    .id("project-info-scroll")
                    .size_full()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(div().w_full().px_2().child(table.clone()))
                    .into_any_element()
            }
        };

        crate::motion::enter_fade_in(
            SharedString::from("project-info-fade"),
            pattern_a_shell(&app_theme, "project-info", header, toolbar, body, footer),
            crate::motion::reduce_motion(cx),
        )
        .into_any_element()
    }
}

// ---------------------------------------------------------------------------
// 列定义
// ---------------------------------------------------------------------------

fn columns() -> Vec<ColumnDef<ManagedProject>> {
    vec![
        ColumnDef::text("name", "项目名称", |r: &ManagedProject, _| {
            SharedString::from(r.name.clone())
        }),
        ColumnDef::text("brand_name", "品牌", |r: &ManagedProject, _| {
            SharedString::from(r.brand_name.clone().unwrap_or_else(|| "—".into()))
        })
        .width(120.0),
        ColumnDef::text("store_address", "店铺地址", |r: &ManagedProject, _| {
            SharedString::from(r.store_address.clone().unwrap_or_else(|| "—".into()))
        })
        .width(160.0),
        ColumnDef::text("operator", "运营", |r: &ManagedProject, _| {
            SharedString::from(r.project_operator.clone().unwrap_or_else(|| "—".into()))
        })
        .width(96.0),
        ColumnDef::text("assistant", "助理运营", |r: &ManagedProject, _| {
            SharedString::from(r.assistant_operator.clone().unwrap_or_else(|| "—".into()))
        })
        .width(96.0),
        ColumnDef::text("commission", "佣金口径", |r: &ManagedProject, theme| {
            let _ = theme;
            SharedString::from(commission_label(r))
        })
        .width(140.0),
        ColumnDef::text("tier", "层级", |r: &ManagedProject, _| {
            SharedString::from(r.project_tier.clone().unwrap_or_else(|| "—".into()))
        })
        .width(64.0),
        ColumnDef::text("sort_order", "排序", |r: &ManagedProject, _| {
            SharedString::from(r.sort_order.to_string())
        })
        .width(64.0)
        .numeric(true),
        ColumnDef::text("status", "状态", |r: &ManagedProject, _| {
            if r.is_active {
                "启用"
            } else {
                "停用"
            }
            .into()
        })
        .width(64.0),
    ]
}

/// 佣金口径摘要（口径中文名 + 费率；对齐 web COMMISSION_BASIS_LABEL）
fn commission_label(project: &ManagedProject) -> String {
    let basis = match project.commission_basis.as_deref() {
        Some("sales_amount") => "销售额",
        Some("cash_received") => "平台回款",
        Some("profit_margin") => "利润率",
        Some(other) => other,
        None => return "—".to_string(),
    };
    match project.commission_rate {
        Some(rate) => format!("{basis} · {:.1}%", rate * 100.0),
        None => basis.to_string(),
    }
}
