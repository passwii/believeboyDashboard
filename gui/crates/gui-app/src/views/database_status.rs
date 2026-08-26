//! 系统管理 → 数据库状态（Stage13，BLF-804）
//!
//! 对齐 web 端 `app/dashboard/system/data-management/page.tsx` 的**只读主面**：
//! 数据库连通性卡（engine / source / 健康状态 / 检查时刻）+ 表健康矩阵
//! （表名 / 中文名 / 行数 / 最近更新 / 状态徽标）+ 数据汇总（总表数 /
//! 总行数 / 过期表）。
//!
//! 数据源（gui-api-client::system_management，BLF-797 Footer 同源扩展）：
//! - `GET /api/v1/system-management/data-management/status` → 连通性卡
//!   （`data_management_status`）
//! - `GET /api/v1/system-management/data-management/overview` → 全景
//!   （`data_management_overview`）
//!
//! ## 与 web 端的取舍
//!
//! - **保留**：连通性卡、表健康表（状态语义色）、汇总三格；
//! - **精简**：「清空缓存」写操作不移植——破坏性动作走 web 端二次确认。


// Stage13 视图：URL 常量与测试钩子属模块契约面，root.rs 接线前允许暂未消费。
#![allow(dead_code)] // ⚠️ 内部属性必须在文件顶部——见下方等价实现

use gpui::prelude::*;
use gpui::{
    div, px, App, AsyncApp, Context, Entity, FontWeight, IntoElement, Render, SharedString,
    WeakEntity, Window,
};
use gpui_component::button::Button;
use gpui_component::{h_flex, v_flex, Sizable};
use gui_api_client::Client;
use gui_domain::system_management::{
    DataManagementOverview, DataManagementStatus,
};

use crate::theme::{AppTheme, FONT_BASE, FONT_MONO_FAMILY, FONT_TITLE_LG};
use crate::widgets::data_table::{ColumnDef, DataTable};
use crate::widgets::layout::content_guard;
use crate::widgets::page_header::PageHeader;
use crate::widgets::state_views::{self, SkeletonBlock};

/// sidebar「系统管理 → 数据库状态」URL（数据权威 gui-domain::sidebar）
pub const DATABASE_STATUS_URL: &str = "/dashboard/system/data-management";

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum DbStatusState {
    Loading,
    Loaded(Box<DbData>),
    Empty,
    Error(String),
}

/// Loaded 数据（status + overview；overview 失败仅丢表矩阵段）
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct DbData {
    status: Option<DataManagementStatus>,
    overview: Option<DataManagementOverview>,
}

/// 数据库状态视图（四态 + 双端点合并 + 竞态保护）
pub struct DatabaseStatusView {
    state: Entity<DbStatusState>,
    client: Client,
    latest_request_id: u64,
    table: Option<Entity<DataTable<gui_domain::system_management::TableStatusItem>>>,
}

impl DatabaseStatusView {
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| DbStatusState::Loading);
        Self {
            state,
            client,
            latest_request_id: 0,
            table: None,
        }
    }

    #[allow(dead_code)]
    pub(crate) fn current_state(&self, cx: &App) -> DbStatusState {
        self.state.read(cx).clone()
    }

    /// 首屏 / 刷新共用入口
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;

        self.state.update(cx, |state, cx| {
            *state = DbStatusState::Loading;
            cx.notify();
        });

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime().block_on(async {
                        let status = client.data_management_status().await;
                        let overview = client.data_management_overview().await;
                        (status, overview)
                    })
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.apply_result(request_id, result.0, result.1, cx);
            })
            .ok();
        })
        .detach();
    }

    /// 应用结果：status 失败 → Error（页面主信号不可得）；overview 失败仅丢表格
    fn apply_result(
        &mut self,
        request_id: u64,
        status: Result<DataManagementStatus, gui_api_client::error::ApiError>,
        overview: Result<DataManagementOverview, gui_api_client::error::ApiError>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_request_id {
            return;
        }
        let next = match status {
            Ok(status) => DbStatusState::Loaded(Box::new(DbData {
                status: Some(status),
                overview: overview.ok(),
            })),
            Err(e) => DbStatusState::Error(e.user_message()),
        };
        self.state.update(cx, |state, cx| {
            *state = next;
            cx.notify();
        });
    }
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

impl Render for DatabaseStatusView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let app_theme = AppTheme::current(cx);
        let view = cx.entity();
        let state = self.state.read(cx).clone();

        let header = PageHeader::new("数据库状态")
            .subtitle("主库连通性 · 表健康全景 · 缓存清理走 web 端")
            .action({
                let view = view.clone();
                Button::new("db-status-refresh")
                    .outline()
                    .small()
                    .label("刷新")
                    .on_click(move |_ev, _w, cx| {
                        view.update(cx, |this, cx| this.reload(cx));
                    })
            });

        let body: gpui::AnyElement = match &state {
            DbStatusState::Loading => state_views::skeleton_loading(
                &app_theme,
                &[SkeletonBlock::Kpi(3), SkeletonBlock::Table(280.0)],
            )
            .into_any_element(),
            DbStatusState::Error(msg) => state_views::error_state(
                &view,
                &app_theme,
                "db-status-error",
                "数据库状态加载失败",
                msg.clone(),
                |this, cx| this.reload(cx),
            )
            .into_any_element(),
            DbStatusState::Empty => state_views::empty_state_with_action_desc(
                &view,
                &app_theme,
                "db-status-empty",
                "icons/database.svg",
                "暂无状态数据",
                None::<SharedString>,
                "刷新",
                |this, cx| this.reload(cx),
            )
            .into_any_element(),
            DbStatusState::Loaded(data) => {
                render_loaded(data.as_ref(), &view, self, &app_theme, cx).into_any_element()
            }
        };

        v_flex()
            .id("database-status")
            .size_full()
            .gap_4()
            .p_6()
            .overflow_y_scroll()
            .bg(app_theme.window_bg)
            .child(header)
            .child(content_guard().child(body))
    }
}

/// Loaded：连通性卡 + 汇总三格 + 表健康矩阵
fn render_loaded(
    data: &DbData,
    _view: &Entity<DatabaseStatusView>,
    this: &mut DatabaseStatusView,
    theme: &AppTheme,
    cx: &mut Context<DatabaseStatusView>,
) -> gpui::AnyElement {
    let mut col = v_flex().id("db-status-loaded").w_full().gap_4();

    // 连通性卡
    if let Some(status) = &data.status {
        col = col.child(render_conn_card(&status.database, theme));
    }

    // 汇总三格 + 表矩阵
    if let Some(overview) = &data.overview {
        col = col.child(render_summary_cards(&overview.summary, theme));
        if !overview.tables.is_empty() {
            let table = this.table.get_or_insert_with(|| {
                cx.new(|_| DataTable::new("db-status-table", table_columns()).striped(true))
            });
            table.update(cx, |t, cx| t.set_rows_if_changed(&overview.tables, cx));
            col = col.child(
                div()
                    .w_full()
                    .px_0p5()
                    .min_h_0()
                    .child(table.clone()),
            );
        } else {
            col = col.child(
                div()
                    .id("db-status-tables-empty")
                    .text_xs()
                    .text_color(theme.text_muted)
                    .child("暂无表健康数据"),
            );
        }
    }

    col.into_any_element()
}

/// 主库连通性卡：引擎 / 来源 / 健康徽标 / 检查时刻
fn render_conn_card(db: &gui_domain::system_management::DatabaseStatus, theme: &AppTheme) -> gpui::AnyElement {
    let (health_label, health_color) = if db.healthy {
        ("健康", theme.success)
    } else {
        ("异常", theme.danger)
    };
    h_flex()
        .id("db-status-conn-card")
        .w_full()
        .items_center()
        .gap_6()
        .rounded(px(theme.radius_lg))
        .border_1()
        .border_color(theme.separator)
        .bg(theme.card_bg)
        .px_4()
        .py_3()
        .child(
            v_flex()
                .gap_1()
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.text_muted)
                        .child("主库"),
                )
                .child(
                    h_flex()
                        .items_center()
                        .gap_2()
                        .child(
                            div().text_size(px(crate::theme::fs(FONT_TITLE_LG)))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(health_color)
                                .child(health_label),
                        )
                        .child(
                            div().text_size(px(crate::theme::fs(FONT_BASE)))
                                .mono_text()
                                .text_color(theme.text_secondary)
                                .child(db.engine.clone()),
                        ),
                ),
        )
        .when_some(db.source.clone(), |card, source| {
            card.child(
                v_flex()
                    .gap_1()
                    .child(div().text_xs().text_color(theme.text_muted).child("来源"))
                    .child(
                        div().text_size(px(crate::theme::fs(FONT_BASE)))
                            .mono_text()
                            .text_color(theme.text_primary)
                            .child(source),
                    ),
            )
        })
        .child(
            v_flex()
                .gap_1()
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.text_muted)
                        .child("检查时刻"),
                )
                .child(
                    div().text_size(px(crate::theme::fs(FONT_BASE)))
                        .mono_text()
                        .text_color(theme.text_secondary)
                        .child(gui_domain::system_management::format_log_time(
                            &db.checked_at,
                        )),
                ),
        )
        .into_any_element()
}

/// 汇总三格：总表 / 总行 / 过期表
fn render_summary_cards(
    summary: &gui_domain::system_management::DataSummary,
    theme: &AppTheme,
) -> gpui::AnyElement {
    let cards = [
        ("总表数", summary.total_tables.to_string(), theme.text_primary),
        ("总行数", format_rows(summary.total_rows), theme.text_primary),
        (
            "过期表",
            summary.stale_tables.to_string(),
            if summary.stale_tables > 0 {
                theme.warning
            } else {
                theme.success
            },
        ),
    ];
    h_flex()
        .id("db-status-summary")
        .w_full()
        .gap_2()
        .children(cards.map(|(label, value, color)| {
            v_flex()
                .flex_1()
                .gap_1()
                .px_3()
                .py_2()
                .rounded(px(theme.radius))
                .border_1()
                .border_color(theme.separator)
                .bg(theme.card_bg)
                .child(
                    div().text_size(px(crate::theme::fs(FONT_TITLE_LG)))
                        .font_weight(FontWeight::SEMIBOLD)
                        .mono_tabular_nums_local()
                        .text_color(color)
                        .child(value),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(theme.text_muted)
                        .child(label),
                )
        }))
        .into_any_element()
}

/// 行数千分位（本地辅助）
fn format_rows(rows: i64) -> String {
    let s = rows.abs().to_string();
    let mut out = String::new();
    for (i, ch) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    if rows < 0 {
        format!("-{out}")
    } else {
        out
    }
}

// 局部 mono 辅助（等宽 + tabular-nums；复用 data_table 的 TabularNumsExt）
use crate::widgets::data_table::TabularNumsExt;

trait MonoTextExt: gpui::Styled + Sized {
    fn mono_text(self) -> Self {
        self.font_family(SharedString::from(FONT_MONO_FAMILY))
    }

    fn mono_tabular_nums_local(self) -> Self {
        self.mono_tabular_nums()
    }
}
impl<E: gpui::Styled + Sized> MonoTextExt for E {}

/// 表健康列定义
fn table_columns() -> Vec<ColumnDef<gui_domain::system_management::TableStatusItem>> {
    vec![
        ColumnDef::text("table_name", "表名", |r, _| {
            SharedString::from(r.table_name.clone())
        }),
        ColumnDef::text("table_name_cn", "说明", |r: &gui_domain::system_management::TableStatusItem, _| {
            SharedString::from(r.table_name_cn.clone().unwrap_or_else(|| "—".into()))
        }),
        ColumnDef::number("row_count", "行数", |r: &gui_domain::system_management::TableStatusItem| r.row_count.unwrap_or(0) as f64, |r, _| {
            SharedString::from(r.row_count.map(|n| n.to_string()).unwrap_or_else(|| "—".into()))
        })
        .width(110.0),
        ColumnDef::text("last_updated_at", "最近更新", |r: &gui_domain::system_management::TableStatusItem, _| {
            SharedString::from(r.last_updated_at.as_deref().map(gui_domain::system_management::format_time_ago).unwrap_or_else(|| "—".into()))
        })
        .width(120.0),
        ColumnDef::text("status", "状态", |r: &gui_domain::system_management::TableStatusItem, _| {
            SharedString::from(r.status.label())
        })
        .width(72.0),
    ]
}
