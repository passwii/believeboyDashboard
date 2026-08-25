//! AI 智能 → AI洞察（BLF-803 Stage12 新建；Pattern B/C 混合形态）
//!
//! 对齐 web 端 `app/dashboard/ai/insights/page.tsx`（约 3260 行）的**查看主面**：
//! - 项目 / 站点筛选 + 生成入口（写操作引导走 web）；
//! - 洞察列表（状态徽标 + 类型 + 日期区间 + 创建人）；
//! - 点开查看历史洞察的 markdown 正文（`ai_insight_detail`）。
//!
//! 数据源：`GET /api/v1/ai-insights`（gui-api-client::ai，只读接入）。
//!
//! ## 与 web 端的取舍
//! - **保留**：项目 × 站点筛选、列表四态、状态语义色徽标、详情 markdown
//!   渲染、失败态错误信息展示；
//! - **精简**：洞察**生成全流程**（SSE 进度流 / 聚合明细预览 / 模型选择 /
//!   重试 / 编辑正文 / 导出 Word/PNG）与**定时计划**（schedules Tab 的
//!   CRUD）不接 GUI——均为写链路或长驻流式任务，对齐「写入走 web 端」
//!   取舍；GUI v1 提供历史洞察查看与筛选定位。

use gpui::prelude::*;
use gpui::{
    div, px, App, AsyncApp, Context, Entity, FontWeight, IntoElement, Render, SharedString,
    WeakEntity, Window,
};
use gpui_component::{button::Button, h_flex, menu::PopupMenuItem, v_flex, Sizable};
use gui_api_client::Client;
use gui_domain::ai::{AiInsightDetail, AiInsightItem};
use gui_domain::common::ManagedProject;

use crate::theme::{AppTheme, FONT_BASE};
use crate::widgets::data_grid::{pattern_a_shell, AggregateItem};
use crate::widgets::data_table::TabularNumsExt;
use crate::widgets::filter_bar;
use crate::widgets::page_header::PageHeader;
use crate::widgets::state_views::{self, SkeletonBlock};

/// sidebar「AI 智能 → AI洞察」URL（数据权威 gui-domain::sidebar）
pub const AI_INSIGHTS_URL: &str = "/dashboard/ai/insights";

#[derive(Debug, Clone, PartialEq)]
pub enum InsightsState {
    Loading,
    Loaded(Vec<AiInsightItem>, i64),
    Empty,
    Error(String),
}

#[derive(Debug, Clone, PartialEq)]
enum DetailState {
    Hidden,
    Loading(i64),
    Loaded(Box<AiInsightDetail>),
    Error(String),
}

/// AI洞察视图
pub struct AiInsightsView {
    client: Client,
    state: Entity<InsightsState>,
    /// 项目列表（reload 刷新；筛选菜单数据源）
    projects: Vec<ManagedProject>,
    selected_project_id: Option<i64>,
    country: &'static str,
    latest_request_id: u64,
    /// 详情面板（列表下方；点击行加载）
    detail: DetailState,
}

const COUNTRY_OPTIONS: [(&str, &str); 4] = [
    ("US", "美国站 (US)"),
    ("DE", "德国站 (DE)"),
    ("UK", "英国站 (UK)"),
    ("ALL", "全部站点"),
];

impl AiInsightsView {
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| InsightsState::Loading);
        Self {
            client,
            state,
            projects: Vec::new(),
            selected_project_id: None,
            country: "ALL",
            latest_request_id: 0,
            detail: DetailState::Hidden,
        }
    }

    /// 当前状态（测试用）
    #[allow(dead_code)]
    pub fn current_state(&self, cx: &App) -> InsightsState {
        self.state.read(cx).clone()
    }

    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;
        let project_id = self.selected_project_id;
        let country = if self.country == "ALL" {
            None
        } else {
            Some(self.country)
        };
        self.state.update(cx, |state, cx| {
            *state = InsightsState::Loading;
            cx.notify();
        });
        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime().block_on(async {
                        let projects = client
                            .list_managed_projects()
                            .await
                            .map_err(|e| e.user_message())?;
                        let list = client
                            .ai_insight_list(project_id, country, 50, 0)
                            .await
                            .map_err(|e| e.user_message())?;
                        Ok::<_, String>((projects, list))
                    })
                })
                .await;
            this.update(cx, |this, cx| {
                if this.latest_request_id != request_id {
                    return;
                }
                match result {
                    Ok((projects, list)) => {
                        this.projects = projects;
                        let next = if list.items.is_empty() {
                            InsightsState::Empty
                        } else {
                            InsightsState::Loaded(list.items, list.total)
                        };
                        this.state.update(cx, |state, cx| {
                            *state = next;
                            cx.notify();
                        });
                    }
                    Err(msg) => {
                        this.state.update(cx, |state, cx| {
                            *state = InsightsState::Error(msg);
                            cx.notify();
                        });
                    }
                }
            })
            .ok();
        })
        .detach();
    }

    pub fn select_project(&mut self, id: Option<i64>, cx: &mut Context<Self>) {
        if self.selected_project_id != id {
            self.selected_project_id = id;
            self.reload(cx);
        }
    }

    pub fn select_country(&mut self, country: &'static str, cx: &mut Context<Self>) {
        if self.country != country {
            self.country = country;
            self.reload(cx);
        }
    }

    fn open_detail(&mut self, insight_id: i64, cx: &mut Context<Self>) {
        self.detail = DetailState::Loading(insight_id);
        cx.notify();
        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime().block_on(client.ai_insight_detail(insight_id))
                })
                .await;
            this.update(cx, |this, cx| {
                match result {
                    Ok(detail) => {
                        this.detail = DetailState::Loaded(Box::new(detail));
                    }
                    Err(e) => {
                        this.detail = DetailState::Error(e.user_message());
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
}

impl Render for AiInsightsView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let app_theme = AppTheme::current(cx);
        let state = self.state.read(cx).clone();
        let view = cx.entity();

        // 详情 markdown 需要 window —— 在 render 期构造
        let detail_el = self.render_detail(window, &app_theme, cx);

        match state {
            InsightsState::Loading => pattern_a_shell(
                &app_theme,
                "ai-insights",
                PageHeader::new("AI洞察").subtitle("运营数据 AI 分析与洞察（历史查看）"),
                div(),
                state_views::skeleton_loading(
                    &app_theme,
                    &[SkeletonBlock::Filter(3), SkeletonBlock::Table(280.0)],
                ),
                aggregate_footer(&view, &app_theme, None),
            )
            .into_any_element(),
            InsightsState::Error(msg) => pattern_a_shell(
                &app_theme,
                "ai-insights",
                PageHeader::new("AI洞察").subtitle("运营数据 AI 分析与洞察（历史查看）"),
                div(),
                state_views::error_state(
                    &view,
                    &app_theme,
                    "ai-insights-error",
                    "AI洞察加载失败",
                    msg,
                    |this, cx| this.reload(cx),
                ),
                div(),
            )
            .into_any_element(),
            InsightsState::Empty => pattern_a_shell(
                &app_theme,
                "ai-insights",
                PageHeader::new("AI洞察").subtitle("运营数据 AI 分析与洞察（历史查看）"),
                render_toolbar(&view, &app_theme, self.selected_project_id, self.country),
                state_views::empty_state_with_action_desc(
                    &view,
                    &app_theme,
                    "ai-insights-empty",
                    "icons/sparkles.svg",
                    "暂无历史洞察",
                    Some("生成洞察请在 web 端「AI 智能 → AI洞察」页发起".to_string()),
                    "刷新",
                    |this, cx| this.reload(cx),
                ),
                div(),
            )
            .into_any_element(),
            InsightsState::Loaded(items, total) => {
                let header = PageHeader::new("AI洞察")
                    .subtitle(format!("共 {} 条历史洞察 · 生成请在 web 端操作", total));
                let body = v_flex()
                    .id("ai-insights-body")
                    .size_full()
                    .min_h_0()
                    .overflow_y_scroll()
                    .p_2()
                    .gap_2()
                    .children(
                        items
                            .iter()
                            .enumerate()
                            .map(|(ix, item)| insight_row(&view, ix, item, &app_theme)),
                    )
                    .child(div().id("ai-insights-detail").w_full().child(detail_el));
                pattern_a_shell(
                    &app_theme,
                    "ai-insights",
                    header,
                    render_toolbar(&view, &app_theme, self.selected_project_id, self.country),
                    body,
                    aggregate_footer(&view, &app_theme, Some(total)),
                )
                .into_any_element()
            }
        }
    }
}

impl AiInsightsView {
    fn render_detail(
        &mut self,
        window: &mut Window,
        theme: &AppTheme,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        match &self.detail {
            DetailState::Hidden => div().into_any_element(),
            DetailState::Loading(id) => div()
                .py_3()
                .text_sm()
                .text_color(theme.text_muted)
                .child(format!("加载洞察 #{id} …"))
                .into_any_element(),
            DetailState::Error(msg) => v_flex()
                .rounded_lg()
                .border_1()
                .border_color(theme.danger)
                .bg(theme.danger_soft)
                .p_3()
                .child(div().text_sm().text_color(theme.danger).child(msg.clone()))
                .into_any_element(),
            DetailState::Loaded(detail) => {
                let title = detail.item.title.clone();
                let content = detail.content.clone();
                v_flex()
                    .rounded_lg()
                    .border_1()
                    .border_color(theme.separator)
                    .bg(theme.card_bg)
                    .p_4()
                    .gap_2()
                    .max_w(px(880.))
                    .child(
                        div()
                            .text_base()
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.text_primary)
                            .child(title),
                    )
                    .child(markdown_body_for("ai-insight-doc", content, window, cx))
                    .into_any_element()
            }
        }
    }
}

/// 工具栏：项目 + 站点 + 刷新
fn render_toolbar(
    view: &Entity<AiInsightsView>,
    theme: &AppTheme,
    selected_project_id: Option<i64>,
    country: &'static str,
) -> impl IntoElement {
    let project_label: SharedString = match selected_project_id {
        Some(id) => format!("项目 #{id}").into(),
        None => SharedString::from("全部项目"),
    };
    let country_label_text: SharedString = SharedString::from(
        COUNTRY_OPTIONS
            .iter()
            .find(|(v, _)| *v == country)
            .map(|(_, l)| l.to_string())
            .unwrap_or_else(|| "全部站点".to_string()),
    );
    let view_for_project = view.clone();
    let view_for_country = view.clone();
    let view_for_refresh = view.clone();

    h_flex()
        .gap_2()
        .items_center()
        .child(filter_bar::filter_select(
            theme,
            "项目",
            project_label,
            "ai-insights-project-filter",
            move |menu, _window, _cx| {
                let mut menu = menu;
                let view_all = view_for_project.clone();
                let has_selection = selected_project_id.is_some();
                menu = menu.item(
                    PopupMenuItem::new("全部项目")
                        .checked(has_selection)
                        .on_click(move |_, _w, cx| {
                            view_all.update(cx, |this, cx| this.select_project(None, cx));
                        }),
                );
                menu
            },
        ))
        .child(filter_bar::filter_select(
            theme,
            "站点",
            country_label_text,
            "ai-insights-country-filter",
            move |menu, _window, _cx| {
                let mut menu = menu;
                for (value, label) in COUNTRY_OPTIONS {
                    let checked = country == value;
                    let view = view_for_country.clone();
                    let value: &'static str = value;
                    menu = menu.item(PopupMenuItem::new(label).checked(checked).on_click(
                        move |_, _w, cx| {
                            view.update(cx, |this, cx| this.select_country(value, cx));
                        },
                    ));
                }
                menu
            },
        ))
        .child(div().flex_1())
        .child(
            Button::new("ai-insights-refresh")
                .outline()
                .small()
                .label("刷新")
                .on_click(move |_, _w, cx| {
                    view_for_refresh.update(cx, |this, cx| this.reload(cx));
                }),
        )
}

/// 底部聚合条（总数 mono；None 时仅 chrome）
fn aggregate_footer(
    _view: &Entity<AiInsightsView>,
    theme: &AppTheme,
    total: Option<i64>,
) -> gpui::AnyElement {
    let items: Vec<AggregateItem> = match total {
        Some(t) => vec![AggregateItem::new("洞察条数", t.to_string())],
        None => Vec::new(),
    };
    if items.is_empty() {
        return div().into_any_element();
    }
    crate::widgets::data_grid::aggregate_strip(theme, "ai-insights", &items).into_any_element()
}

/// 单条洞察行（点击展开详情）
fn insight_row(
    view: &Entity<AiInsightsView>,
    ix: usize,
    item: &AiInsightItem,
    theme: &AppTheme,
) -> gpui::AnyElement {
    let (status_label, status_color) = status_meta(item.status_label(), item.is_terminal(), theme);
    let id = item.id;
    let view = view.clone();
    h_flex()
        .id(SharedString::from(format!("ai-insight-row-{ix}-{id}")))
        .w_full()
        .px_3()
        .py_1p5()
        .gap_3()
        .items_center()
        .rounded(px(theme.radius))
        .border_1()
        .border_color(theme.separator)
        .bg(theme.card_bg)
        .cursor(gpui::CursorStyle::PointingHand)
        .hover(|h| h.bg(theme.table_row_hover))
        .on_click(move |_, _, cx| {
            view.update(cx, |this, cx| this.open_detail(id, cx));
        })
        .child(
            status_label.child(
                div()
                    .text_xs()
                    .text_color(status_color)
                    .child(item.status_label()),
            ),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_size(px(FONT_BASE))
                .text_color(theme.text_primary)
                .child(item.title.clone()),
        )
        .child(
            div()
                .text_xs()
                .text_color(theme.text_muted)
                .child(format!("{} · {}", item.project_name, item.country)),
        )
        .child(
            div()
                .text_xs()
                .mono_tabular_nums()
                .text_color(theme.text_muted)
                .child(format!(
                    "{} ~ {}",
                    item.date_range_start, item.date_range_end
                )),
        )
        .into_any_element()
}

/// 状态徽标骨架与语义色（终态绿 / 失败红 / 进行中琥珀）
fn status_meta(
    label: &'static str,
    terminal: bool,
    theme: &AppTheme,
) -> (gpui::Stateful<gpui::Div>, gpui::Hsla) {
    let color = if label == "失败" {
        theme.danger
    } else if terminal {
        theme.success
    } else {
        theme.warning
    };
    (
        div()
            .id(SharedString::from(format!("status-{label}")))
            .px_1p5(),
        color,
    )
}

/// markdown 正文渲染（TextView 需要可变借用；独立小函数收敛调用点）
fn markdown_body_for(
    id: &'static str,
    content: String,
    window: &mut Window,
    cx: &mut App,
) -> gpui::AnyElement {
    gpui_component::text::TextView::markdown(id, content, window, cx)
        .selectable(true)
        .into_any_element()
}
