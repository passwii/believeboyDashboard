//! 广告 → 广告数据视图（P3-3，BLF-703）
//!
//! frontend `app/dashboard/advertising/ad-data/page.tsx`（`AdDataExplorer`）的
//! GPUI 等价：按报表类型查看广告原始行，支持 搜索 / 列排序 / 分页。
//!
//! 数据管线（对齐 frontend `ad-client-cache.ts` + `lib/ad-data.ts`）：
//! - `ad_upload_files` → 当前项目/站点下「哪些报表类型有成功入库数据」；
//! - `ad_data_raw`（`period=custom&limit=10000&start_date=2000-01-01&end_date=2100-12-31`）
//!   → 选中类型的原始行（服务端按 `report_end_date` 降序）；
//! - 列配置 / 格式化（`ad_report_types` / `format_ad_value`）在 gui-domain，
//!   与 frontend `AD_DATA_REPORT_TYPES` 1:1。
//!
//! 交互（对齐 frontend）：
//! - 搜索：按任意展示列内容过滤（客户端，不改服务端 query）；
//! - 排序：点击表头切换升/降序（数值列按数值、文本列按字符串）；
//! - 分页：每页 50/100/200/500（默认 100），客户端分页。
//!
//! 已知差异（有意保留）：
//! - 前端「聚合视图 / 原始明细展开 / CSV 导出 / 日期范围」未接入（P3-3 范围：原始表
//!   浏览），留后续增强；
//! - 报表类型下拉只列出「有成功入库数据」的类型（前端对无数据类型置灰显示）。

use gpui::{
    div, prelude::*, px, App, AsyncApp, Context, CursorStyle, Entity, Render, SharedString,
    WeakEntity, Window,
};
use gpui_component::{
    button::Button,
    h_flex,
    input::{Input, InputEvent, InputState},
    menu::PopupMenuItem,
    table::{Column, ColumnSort, Table, TableDelegate, TableState},
    v_flex, Icon, IconName, Sizable,
};
use gui_api_client::Client;
use gui_domain::advertising::{
    ad_report_type, format_ad_value, is_numeric_format, AdFormat, AdPeriodInfo, AdReportType,
};
use gui_domain::common::ManagedProject;

use crate::theme::AppTheme;
use crate::views::ad_analysis::ad_country_label;
use crate::widgets::layout::content_guard;
use crate::widgets::page_header::PageHeader;
use crate::widgets::{filter_bar, pagination, state_views};

/// 本页在侧栏中的 URL（root.rs 据此路由；与 gui-domain::sidebar 的广告数据条目一致）
pub const AD_DATA_URL: &str = "/dashboard/advertising/ad-data";

/// 站点选项（对齐 frontend ad-data：US/DE/UK）
const COUNTRY_OPTIONS: [(&str, &str); 3] = [
    ("US", "美国站 (US)"),
    ("DE", "德国站 (DE)"),
    ("UK", "英国站 (UK)"),
];

/// 默认站点（对齐 frontend `useUrlParam('country', 'US')`）
const DEFAULT_COUNTRY: &str = "US";

/// 每页行数选项（对齐 frontend `PAGE_SIZE_OPTIONS`）
const PAGE_SIZE_OPTIONS: [usize; 4] = [50, 100, 200, 500];

/// 默认每页行数（对齐 frontend `useState(100)`）
const DEFAULT_PAGE_SIZE: i64 = 100;

/// 拉取全部原始行的宽窗口（对齐 frontend `start_date: '2000-01-01'` /
/// `end_date: '2100-12-31'`，客户端自行筛选/分页）
const WIDE_START: &str = "2000-01-01";
const WIDE_END: &str = "2100-12-31";

/// 广告数据载荷（Loaded 持有）
#[derive(Debug, Clone, PartialEq)]
pub struct AdDataPayload {
    pub projects: Vec<ManagedProject>,
    /// 有成功入库数据的报表类型（report_type，升序去重）
    pub available_types: Vec<String>,
    /// 当前选中的报表类型（`None` = 尚未选中/无可用数据）
    pub selected_type: Option<String>,
    /// 原始行（服务端返回的全部行，客户端搜索/排序/分页）
    pub rows: Vec<serde_json::Value>,
    /// 服务端总行数（`summary.total_rows`）
    pub total_rows: i64,
    /// 周期信息（raw 响应附带；展示用）
    pub period: Option<AdPeriodInfo>,
}

impl AdDataPayload {
    /// 空态判定：没有任何原始行 → Empty（对齐 frontend `rows.length === 0`）
    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }
}

/// 广告数据状态机（四态；对齐 dashboard.rs / daily_analysis.rs）
#[derive(Debug, Clone, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum AdDataState {
    Loading,
    Loaded(AdDataPayload),
    Empty,
    Error(String),
}

impl AdDataState {
    /// 拉取结果 → 落点状态（唯一合法的「拉取完成」转移）
    pub fn from_fetch_result(result: Result<AdDataPayload, String>) -> Self {
        match result {
            Ok(data) if data.is_empty() => Self::Empty,
            Ok(data) => Self::Loaded(data),
            Err(msg) => Self::Error(msg),
        }
    }
}

/// 广告数据视图（状态机 + 项目/站点/报表类型筛选 + 搜索/排序/分页）
pub struct AdDataView {
    state: Entity<AdDataState>,
    /// 带会话的 API client
    client: Client,
    /// 项目列表（reload 刷新；筛选菜单数据源）
    projects: Vec<ManagedProject>,
    /// 有成功入库数据的报表类型
    available_types: Vec<String>,
    /// 当前选中项目；`None` = 未选择（ad-data 端点要求必选项目）
    selected_project_id: Option<i64>,
    /// 当前站点（"US" / "DE" / "UK"）
    country: &'static str,
    /// 当前选中的报表类型
    selected_report_type: Option<String>,
    /// 请求竞态保护：只有等于最新值的响应才被应用
    latest_request_id: u64,
    /// 原始表 Widget（懒建 TableState；搜索/排序/分页状态留在内部）
    table: Entity<AdRawTable>,
    /// 搜索输入框（懒建 InputState，render 首帧创建）
    search_input: Option<Entity<InputState>>,
    search_sub: Option<gpui::Subscription>,
}

impl AdDataView {
    /// 新建视图：初始 `Loading`，由 root.rs 懒创建后触发 `reload()`
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| AdDataState::Loading);
        let table = cx.new(|_| AdRawTable::new());
        Self {
            state,
            client,
            projects: Vec::new(),
            available_types: Vec::new(),
            selected_project_id: None,
            country: DEFAULT_COUNTRY,
            selected_report_type: None,
            latest_request_id: 0,
            table,
            search_input: None,
            search_sub: None,
        }
    }

    /// 当前状态（只读，测试用）
    #[allow(dead_code)]
    pub fn current_state(&self, cx: &App) -> AdDataState {
        self.state.read(cx).clone()
    }

    /// 重新拉取数据：项目/站点/报表类型切换、错误重试、空态刷新共用入口。
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;
        let selected = self.selected_project_id;
        let country = self.country;
        let selected_type = self.selected_report_type.clone();

        self.state.update(cx, |state, cx| {
            *state = AdDataState::Loading;
            cx.notify();
        });

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime()
                        .block_on(load_ad_data(&client, selected, country, selected_type))
                })
                .await;
            this.update(&mut *cx, |this, cx| {
                this.apply_result(request_id, result, cx);
            })
            .ok();
        })
        .detach();
    }

    /// 切换选中项目 → reload（同一项目为 no-op）
    pub fn select_project(&mut self, project_id: Option<i64>, cx: &mut Context<Self>) {
        if project_id == self.selected_project_id {
            return;
        }
        self.selected_project_id = project_id;
        // 项目/站点切换后，原报表类型可能无数据 → 交给 load 重新推导
        self.selected_report_type = None;
        self.reload(cx);
    }

    /// 切换站点 → reload（同一站点为 no-op）
    pub fn select_country(&mut self, country: &'static str, cx: &mut Context<Self>) {
        if country == self.country {
            return;
        }
        self.country = country;
        self.selected_report_type = None;
        self.reload(cx);
    }

    /// 切换报表类型 → reload（同一类型为 no-op）
    pub fn select_report_type(&mut self, report_type: Option<String>, cx: &mut Context<Self>) {
        if report_type == self.selected_report_type {
            return;
        }
        self.selected_report_type = report_type;
        self.reload(cx);
    }

    /// 搜索框内容变化（InputEvent::Change）→ 客户端过滤，不重新拉取
    fn on_search_change(&mut self, cx: &mut Context<Self>) {
        let text = self
            .search_input
            .as_ref()
            .map(|input| input.read(cx).value().to_string())
            .unwrap_or_default();
        self.table.update(cx, |widget, cx| widget.set_search(text, cx));
    }

    /// 应用拉取结果：竞态保护（过期响应丢弃）+ Loaded 落点前喂表格 + 记录筛选状态。
    fn apply_result(
        &mut self,
        request_id: u64,
        result: Result<AdDataPayload, String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_request_id {
            return; // 过期响应，丢弃
        }
        if let Ok(data) = &result {
            self.projects = data.projects.clone();
            self.available_types = data.available_types.clone();
            self.selected_report_type = data.selected_type.clone();
            if !data.is_empty() {
                if let Some(st) = &data.selected_type {
                    if let Some(config) = ad_report_type(st) {
                        let rows = data.rows.clone();
                        self.table.update(cx, |widget, cx| {
                            widget.set_data(&config, rows, cx)
                        });
                    }
                }
            }
        }
        self.state.update(cx, |state, cx| {
            *state = AdDataState::from_fetch_result(result);
            cx.notify();
        });
    }
}

/// 拉取广告数据（项目列表 + 上传文件 + 选中类型原始行），与视图解耦便于测试。
///
/// 对齐 frontend AdDataExplorer：未选项目 → 空载荷（前端同样提示先选项目）；
/// 默认选中「第一个有成功入库数据」的报表类型（保留用户当前选择若仍可用）。
async fn load_ad_data(
    client: &Client,
    selected_project_id: Option<i64>,
    country: &str,
    selected_type: Option<String>,
) -> Result<AdDataPayload, String> {
    let projects = client
        .list_managed_projects()
        .await
        .map_err(|e| e.user_message())?;
    let Some(project_id) = selected_project_id else {
        return Ok(AdDataPayload {
            projects,
            available_types: Vec::new(),
            selected_type: None,
            rows: Vec::new(),
            total_rows: 0,
            period: None,
        });
    };

    let files = client
        .ad_upload_files(project_id, country)
        .await
        .map_err(|e| e.user_message())?;
    let mut available: Vec<String> = files
        .iter()
        .filter(|f| f.ingestion_status == "success")
        .map(|f| f.report_type.clone())
        .collect();
    available.sort();
    available.dedup();

    // 保留用户选择（若仍可用），否则默认第一个有数据的类型
    let selected = selected_type
        .filter(|t| available.contains(t))
        .or_else(|| available.first().cloned());
    let Some(st) = selected else {
        return Ok(AdDataPayload {
            projects,
            available_types: available,
            selected_type: None,
            rows: Vec::new(),
            total_rows: 0,
            period: None,
        });
    };
    let Some(config) = ad_report_type(&st) else {
        return Err(format!("未知报表类型：{st}"));
    };

    let start = chrono::NaiveDate::parse_from_str(WIDE_START, "%Y-%m-%d")
        .expect("WIDE_START 必须是合法日期");
    let end = chrono::NaiveDate::parse_from_str(WIDE_END, "%Y-%m-%d").expect("WIDE_END 必须是合法日期");
    let raw = client
        .ad_data_raw(project_id, config.endpoint, country, start, end)
        .await
        .map_err(|e| e.user_message())?;
    Ok(AdDataPayload {
        projects,
        available_types: available,
        selected_type: Some(st),
        rows: raw.data,
        total_rows: raw.summary.total_rows,
        period: Some(raw.period),
    })
}

impl Render for AdDataView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = AppTheme::current(cx);
        let state = self.state.read(cx).clone();
        let view = cx.entity();
        let table = self.table.clone();

        // 搜索输入框懒建（首帧；InputState::new 需要 window）
        if self.search_input.is_none() {
            let input = cx.new(|cx| {
                InputState::new(window, cx).placeholder("按任意列内容过滤…")
            });
            self.search_sub = Some(cx.subscribe(&input, |this, _e, event: &InputEvent, cx| {
                if let InputEvent::Change = event {
                    this.on_search_change(cx);
                }
            }));
            self.search_input = Some(input);
        }

        let project_name = self
            .selected_project_id
            .and_then(|id| self.projects.iter().find(|p| p.id == id).map(|p| p.name.clone()))
            .unwrap_or_else(|| "广告数据".to_string());

        v_flex()
            .id("ad-data")
            .size_full()
            .gap_4()
            .p_6()
            .overflow_y_scroll()
            .bg(theme.window_bg)
            // 页面头部（P4-5：共享 PageHeader）
            .child(PageHeader::new("广告数据").subtitle(match &state {
                AdDataState::Loaded(data) => format!(
                    "{} · {} · {}",
                    project_name,
                    ad_country_label(self.country),
                    data.selected_type
                        .as_ref()
                        .and_then(|t| ad_report_type(t))
                        .map_or_else(|| "—".to_string(), |c| c.label.to_string())
                ),
                _ => "按报表类型查看广告原始数据（搜索 / 排序 / 分页）".to_string(),
            }))
            // 筛选栏：项目 + 站点 + 报表类型 + 搜索 + 刷新（宽窗受内容上限约束）
            .child(content_guard().child(render_filter_bar(
                &view,
                &theme,
                &self.projects,
                self.selected_project_id,
                self.country,
                &self.available_types,
                self.selected_report_type.as_deref(),
                self.search_input.clone(),
            )))
            // 状态区（加载/错误/空态受上限约束；原始数据表格保留全宽）
            .child(match state {
                AdDataState::Loading => content_guard()
                    .child(
                        v_flex()
                            .id("ad-data-loading")
                            .gap_4()
                            .child(state_views::loading_state(&theme, "加载中…"))
                            .child(
                                div()
                                    .w_full()
                                    .h_80()
                                    .child(gpui_component::skeleton::Skeleton::new()),
                            ),
                    )
                    .into_any_element(),
                AdDataState::Error(msg) => state_views::error_state(
                    &view,
                    &theme,
                    "ad-data-error",
                    "广告数据加载失败",
                    msg,
                    |this, cx| this.reload(cx),
                )
                .into_any_element(),
                AdDataState::Empty => {
                    let message = if self.selected_project_id.is_none() {
                        "请先选择项目以加载广告数据"
                    } else if self.available_types.is_empty() {
                        "当前项目/国家下暂无成功入库的广告报表数据"
                    } else {
                        "当前筛选条件下没有广告原始数据"
                    };
                    state_views::empty_state_with_action(
                        &view,
                        &theme,
                        "ad-data-empty",
                        "icons/package.svg",
                        message,
                        "刷新",
                        |this, cx| this.reload(cx),
                    )
                    .into_any_element()
                }
                AdDataState::Loaded(data) => {
                    let subtitle = format!(
                        "报表：{}",
                        data.selected_type
                            .as_ref()
                            .and_then(|t| ad_report_type(t))
                            .map_or_else(|| "—".to_string(), |c| c.label.to_string())
                    );
                    let (displayed, filtered_total, page, _page_count) =
                        table.read(cx).stats(cx);
                    let page_size = table.read(cx).page_size;
                    render_loaded(
                        &theme,
                        &data,
                        table,
                        &subtitle,
                        displayed,
                        filtered_total,
                        page,
                        page_size,
                        crate::motion::reduce_motion(cx),
                    )
                    .into_any_element()
                }
            })
    }
}

// ---------------------------------------------------------------------------
// 筛选栏（项目 / 站点 / 报表类型 / 搜索 / 刷新）
// ---------------------------------------------------------------------------

/// 筛选栏：项目 + 站点 + 报表类型 + 搜索框 + 刷新（控件用公共 filter_bar 组件）。
#[allow(clippy::too_many_arguments)]
fn render_filter_bar(
    view: &Entity<AdDataView>,
    app_theme: &AppTheme,
    projects: &[ManagedProject],
    selected_project_id: Option<i64>,
    country: &'static str,
    available_types: &[String],
    selected_report_type: Option<&str>,
    search_input: Option<Entity<InputState>>,
) -> impl IntoElement {
    let projects_owned = projects.to_vec();
    let available_owned = available_types.to_vec();
    let project_label: SharedString = match selected_project_id {
        Some(id) => projects
            .iter()
            .find(|p| p.id == id)
            .map(|p| SharedString::from(p.name.clone()))
            .unwrap_or_else(|| SharedString::from("请选择项目")),
        None => SharedString::from("请选择项目"),
    };
    let type_label: SharedString = match selected_report_type {
        Some(t) => ad_report_type(t)
            .map(|c| SharedString::from(c.label.to_string()))
            .unwrap_or_else(|| SharedString::from("请选择报表类型")),
        None => {
            if available_types.is_empty() {
                SharedString::from("暂无报表数据")
            } else {
                SharedString::from("请选择报表类型")
            }
        }
    };
    // 闭包须 'static：把 &str 引用转成 owned 再捕获
    let selected_type_owned = selected_report_type.map(|s| s.to_string());
    let view_for_project = view.clone();
    let view_for_country = view.clone();
    let view_for_type = view.clone();
    let view_for_refresh = view.clone();

    filter_bar::filter_bar_layout(app_theme)
        .child(filter_bar::filter_select(app_theme, "项目", project_label, "ad-data-project-filter", move |menu, _window, _cx| {
            let mut menu = menu;
            for project in &projects_owned {
                let checked = selected_project_id == Some(project.id);
                let id = project.id;
                let name = project.name.clone();
                let view = view_for_project.clone();
                menu = menu.item(
                    PopupMenuItem::new(name).checked(checked).on_click(move |_, _window, cx| {
                        view.update(cx, |this, cx| this.select_project(Some(id), cx));
                    }),
                );
            }
            menu
        }))
        .child(filter_bar::filter_select(app_theme, "站点", ad_country_label(country).into(), "ad-data-country-filter", move |menu, _window, _cx| {
            let mut menu = menu;
            for (value, label) in COUNTRY_OPTIONS {
                let checked = country == value;
                let view = view_for_country.clone();
                menu = menu.item(
                    PopupMenuItem::new(label).checked(checked).on_click(move |_, _window, cx| {
                        view.update(cx, |this, cx| this.select_country(value, cx));
                    }),
                );
            }
            menu
        }))
        .child(filter_bar::filter_select(app_theme, "报表类型", type_label, "ad-data-type-filter", move |menu, _window, _cx| {
            let mut menu = menu;
            for t in &available_owned {
                let checked = selected_type_owned.as_deref() == Some(t.as_str());
                let Some(config) = ad_report_type(t) else { continue; };
                let label = config.label.to_string();
                let t_owned = t.clone();
                let view = view_for_type.clone();
                menu = menu.item(
                    PopupMenuItem::new(label).checked(checked).on_click(move |_, _window, cx| {
                        view.update(cx, |this, cx| {
                            this.select_report_type(Some(t_owned.clone()), cx)
                        });
                    }),
                );
            }
            menu
        }))
        // 搜索框
        .child(
            h_flex()
                .gap_2()
                .items_center()
                .child(
                    div()
                        .text_sm()
                        .text_color(app_theme.text_muted)
                        .child("搜索"),
                )
                .when(search_input.is_some(), |this| {
                    this.child(
                        div()
                            .w(px(200.))
                            .child(Input::new(search_input.as_ref().expect("已判 Some"))),
                    )
                }),
        )
        .child(div().flex_1())
        .child(
            Button::new("ad-data-refresh")
                .outline()
                .small()
                .label("刷新")
                .on_click(move |_, _window, cx| {
                    let view = view_for_refresh.clone();
                    view.update(cx, |this, cx| this.reload(cx));
                }),
        )
}

/// Loaded：概览徽章 + 原始表 + 分页栏
#[allow(clippy::too_many_arguments)]
fn render_loaded(
    app_theme: &AppTheme,
    data: &AdDataPayload,
    table: Entity<AdRawTable>,
    report_label: &str,
    displayed: usize,
    filtered_total: usize,
    page: usize,
    page_size: i64,
    reduce: bool,
) -> impl IntoElement {
    let first = if displayed == 0 {
        0
    } else {
        filtered_total.saturating_sub(displayed) + 1
    };
    let last = filtered_total;
    // P4-2：表格 enter 轻量 fade-in（一次性；减弱动态时瞬时）
    crate::motion::enter_fade_in(
        gpui::SharedString::from("ad-data-loaded-fade"),
        v_flex()
            .id("ad-data-loaded")
            .gap_3()
            .child(
                h_flex()
                    .id("ad-data-badges")
                    .gap_2()
                    .items_center()
                    .flex_wrap()
                    .text_sm()
                    .text_color(app_theme.text_muted)
                    .child(badge(app_theme, report_label))
                    .child(badge(
                        app_theme,
                        &format!("服务端总行数：{}", format_count(data.total_rows)),
                    ))
                    .child(badge(
                        app_theme,
                        &format!(
                            "当前显示：第 {first}-{last} / 共 {} 行",
                            format_count(filtered_total as i64)
                        ),
                    )),
            )
            .child(table.clone())
            .child({
                let state = pagination::PageState::new(page, page_size.max(1) as usize, filtered_total);
                pagination::pagination_bar(
                    &table,
                    app_theme,
                    "ad-data-pagination",
                    &state,
                    &PAGE_SIZE_OPTIONS,
                    |this, page, cx| this.set_page(page, cx),
                    |this, size, cx| this.set_page_size(size as i64, cx),
                )
            }),
        reduce,
    )
}

fn badge(app_theme: &AppTheme, text: &str) -> impl IntoElement {
    div()
        .px_2()
        .py_0p5()
        .rounded_full()
        .bg(app_theme.muted_fill)
        .text_color(app_theme.text_muted)
        .child(text.to_string())
}

/// 千分位（对齐 frontend toLocaleString）
fn format_count(v: i64) -> String {
    let digits = v.abs().to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    if v < 0 {
        out.insert(0, '-');
    }
    out
}

// ---------------------------------------------------------------------------
// 筛选栏（项目 / 站点 / 报表类型 / 搜索 / 刷新）
// ---------------------------------------------------------------------------
// 原始表（搜索 / 排序 / 分页全部在 delegate 内部完成）
// ---------------------------------------------------------------------------

/// 从行中取数值（缺省 → NEG_INFINITY，排序到末尾；对齐前端 Number() 语义的容错）
fn row_number(row: &serde_json::Value, key: &str) -> f64 {
    match row.get(key) {
        Some(serde_json::Value::Number(n)) => n.as_f64().unwrap_or(f64::NEG_INFINITY),
        Some(serde_json::Value::String(s)) => s
            .parse::<f64>()
            .unwrap_or(f64::NEG_INFINITY),
        _ => f64::NEG_INFINITY,
    }
}

/// 从行中取文本（缺省 → ""；对齐前端 `String(av ?? '')`）
fn row_text(row: &serde_json::Value, key: &str) -> String {
    match row.get(key) {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(v) => v.to_string(),
        None => String::new(),
    }
}

/// 原始表数据委托：持有全量行 + 搜索词 + 排序 + 分页，展示行（当前页）由内部派生。
struct AdRawDelegate {
    config: AdReportType,
    /// 服务端返回的全部行（搜索/排序/分页的输入）
    all_rows: Vec<serde_json::Value>,
    /// 客户端搜索词（空 = 不过滤）
    search: String,
    /// 当前页（1-based；recompute 时收敛到安全范围）
    page: usize,
    page_size: i64,
    /// 当前排序列（列索引）
    sort_col: Option<usize>,
    sort_dir: ColumnSort,
    columns: Vec<Column>,
    formats: Vec<AdFormat>,
    /// 当前页展示行
    display: Vec<serde_json::Value>,
    /// 过滤（+排序）后的总行数（分页/徽章用）
    filtered_total: usize,
}

impl AdRawDelegate {
    fn new(
        config: AdReportType,
        rows: Vec<serde_json::Value>,
        search: String,
        page: usize,
        page_size: i64,
        sort_col: Option<usize>,
        sort_dir: ColumnSort,
    ) -> Self {
        let formats = config.columns.iter().map(|c| c.format).collect();
        let columns = Self::build_columns(&config, None);
        let mut this = Self {
            config,
            all_rows: rows,
            search,
            page,
            page_size,
            sort_col,
            sort_dir,
            columns,
            formats,
            display: Vec::new(),
            filtered_total: 0,
        };
        this.recompute();
        this
    }

    fn build_columns(config: &AdReportType, sort: Option<(usize, ColumnSort)>) -> Vec<Column> {
        config
            .columns
            .iter()
            .enumerate()
            .map(|(ix, c)| {
                let mut col = Column::new(c.key, c.label).selectable(false).movable(false);
                if is_numeric_format(c.format) {
                    col = col.text_right();
                }
                if let Some((six, s)) = sort {
                    if six == ix {
                        col = col.sort(s);
                    }
                }
                col
            })
            .collect()
    }

    /// 注入全量状态并重算展示行；返回是否发生变化（无变化 → 调用方跳过 refresh）。
    #[allow(clippy::too_many_arguments)]
    fn set_all(
        &mut self,
        config: &AdReportType,
        rows: &[serde_json::Value],
        search: &str,
        page: usize,
        page_size: i64,
        sort_col: Option<usize>,
        sort_dir: ColumnSort,
    ) -> bool {
        let config_changed = self.config.report_type != config.report_type;
        let changed = config_changed
            || self.all_rows.len() != rows.len()
            || self.search != search
            || self.page != page
            || self.page_size != page_size
            || self.sort_col != sort_col
            || self.sort_dir != sort_dir;
        if !changed {
            return false;
        }
        if config_changed {
            self.config = config.clone();
            self.formats = config.columns.iter().map(|c| c.format).collect();
        }
        self.all_rows = rows.to_vec();
        self.search = search.to_string();
        self.page = page;
        self.page_size = page_size;
        self.sort_col = sort_col;
        self.sort_dir = sort_dir;
        self.columns = Self::build_columns(&self.config, sort_col.map(|six| (six, sort_dir)));
        self.recompute();
        true
    }

    /// 搜索词变化（仅更新 + 重算；全量行保留）
    fn set_search(&mut self, search: &str) -> bool {
        if self.search == search {
            return false;
        }
        self.search = search.to_string();
        self.page = 1;
        self.recompute();
        true
    }

    /// 排序切换（对齐 frontend toggleSort：同列 asc↔desc，新列 → asc）
    fn toggle_sort(&mut self, col_ix: usize) {
        if self.sort_col == Some(col_ix) {
            self.sort_dir = if self.sort_dir == ColumnSort::Ascending {
                ColumnSort::Descending
            } else {
                ColumnSort::Ascending
            };
        } else {
            self.sort_col = Some(col_ix);
            self.sort_dir = ColumnSort::Ascending;
        }
        self.columns = Self::build_columns(
            &self.config,
            self.sort_col.map(|six| (six, self.sort_dir)),
        );
        self.recompute();
    }

    /// 过滤（按任意列内容）+ 排序 + 分页，派生当前页展示行。
    fn recompute(&mut self) {
        let q = self.search.trim().to_lowercase();
        let mut filtered: Vec<&serde_json::Value> = if q.is_empty() {
            self.all_rows.iter().collect()
        } else {
            self.all_rows
                .iter()
                .filter(|row| {
                    self.config.columns.iter().any(|c| {
                        let raw = row.get(c.key).unwrap_or(&serde_json::Value::Null);
                        format_ad_value(raw, c.format)
                            .to_lowercase()
                            .contains(&q)
                    })
                })
                .collect()
        };

        if let Some(col_ix) = self.sort_col {
            let key = self.config.columns[col_ix].key;
            let numeric = is_numeric_format(self.config.columns[col_ix].format);
            let ascending = self.sort_dir == ColumnSort::Ascending;
            filtered.sort_by(|a, b| {
                let ord = if numeric {
                    row_number(a, key).total_cmp(&row_number(b, key))
                } else {
                    row_text(a, key).cmp(&row_text(b, key))
                };
                if ascending {
                    ord
                } else {
                    ord.reverse()
                }
            });
        }

        self.filtered_total = filtered.len();
        let page_count = filtered
            .len()
            .div_ceil(self.page_size.max(1) as usize)
            .max(1);
        self.page = self.page.min(page_count);
        let start = (self.page - 1) * self.page_size.max(1) as usize;
        self.display = filtered
            .into_iter()
            .skip(start)
            .take(self.page_size.max(1) as usize)
            .cloned()
            .collect();
    }

    /// 过滤后总行数（分页 / 徽章用）
    fn filtered_total(&self) -> usize {
        self.filtered_total
    }

    /// 当前页（已收敛到安全范围）
    fn page(&self) -> usize {
        self.page
    }

    /// 页数（过滤后）
    fn page_count(&self) -> usize {
        self.filtered_total
            .div_ceil(self.page_size.max(1) as usize)
            .max(1)
    }
}

impl TableDelegate for AdRawDelegate {
    fn columns_count(&self, _: &App) -> usize {
        self.columns.len()
    }

    fn rows_count(&self, _: &App) -> usize {
        self.display.len()
    }

    fn column(&self, col_ix: usize, _: &App) -> &Column {
        &self.columns[col_ix]
    }

    /// 表头点击切换排序（对齐 frontend：任意列可排序，数值列按数值、文本列按字符串）
    fn render_th(
        &mut self,
        col_ix: usize,
        _: &mut Window,
        cx: &mut Context<TableState<Self>>,
    ) -> impl IntoElement {
        let name = self.columns[col_ix].name.clone();
        let sort = self.columns[col_ix].sort;
        let theme = AppTheme::current(cx);
        h_flex()
            .id(("ad-th", col_ix))
            .items_center()
            .gap_1()
            .cursor(CursorStyle::PointingHand)
            .text_color(theme.text_primary)
            .on_click(cx.listener(move |table, _, _, cx| {
                table.delegate_mut().toggle_sort(col_ix);
                table.refresh(cx);
                cx.notify();
            }))
            .child(div().child(name))
            .child(match sort {
                Some(ColumnSort::Ascending) => {
                    Icon::new(IconName::SortAscending)
                        .with_size(px(12.))
                        .text_color(theme.accent)
                        .into_any_element()
                }
                Some(ColumnSort::Descending) => {
                    Icon::new(IconName::SortDescending)
                        .with_size(px(12.))
                        .text_color(theme.accent)
                        .into_any_element()
                }
                _ => Icon::new(IconName::ChevronsUpDown)
                    .with_size(px(12.))
                    .text_color(theme.text_muted.opacity(0.6))
                    .into_any_element(),
            })
    }

    fn render_td(
        &mut self,
        row_ix: usize,
        col_ix: usize,
        _: &mut Window,
        cx: &mut Context<TableState<Self>>,
    ) -> impl IntoElement {
        let row = &self.display[row_ix];
        let col = &self.config.columns[col_ix];
        let theme = AppTheme::current(cx);
        let text = format_ad_value(row.get(col.key).unwrap_or(&serde_json::Value::Null), col.format);
        let numeric = is_numeric_format(col.format);
        div()
            .text_size(px(13.))
            .text_color(if numeric { theme.text_secondary } else { theme.text_primary })
            .when(numeric, |this| this.text_right())
            .child(text)
    }

    /// 空态：Inbox 图标 + 文案
    fn render_empty(
        &mut self,
        _: &mut Window,
        cx: &mut Context<TableState<Self>>,
    ) -> impl IntoElement {
        let theme = AppTheme::current(cx);
        v_flex()
            .size_full()
            .items_center()
            .justify_center()
            .gap_2()
            .text_color(theme.text_muted)
            .child(Icon::new(IconName::Inbox).with_size(px(24.)))
            .child(div().text_size(px(13.)).child("当前筛选条件下没有广告原始数据"))
    }
}

/// 原始表 Widget：懒建 TableState；搜索 / 分页 / 排序状态镜像 + 幂等推送。
struct AdRawTable {
    table: Option<Entity<TableState<AdRawDelegate>>>,
    config: Option<AdReportType>,
    rows: Vec<serde_json::Value>,
    search: String,
    page: usize,
    page_size: i64,
    sort_col: Option<usize>,
    sort_dir: ColumnSort,
    /// 状态是否已变化待推送（render 时同步到 delegate）
    dirty: bool,
    /// 最近一次过滤后总行数（视图徽章 / 分页用）
    filtered_total: usize,
}

impl AdRawTable {
    fn new() -> Self {
        Self {
            table: None,
            config: None,
            rows: Vec::new(),
            search: String::new(),
            page: 1,
            page_size: DEFAULT_PAGE_SIZE,
            sort_col: None,
            sort_dir: ColumnSort::Default,
            dirty: false,
            filtered_total: 0,
        }
    }

    /// 注入报表类型 + 全量行（apply_result 时调用；类型变化 → 重建 TableState）
    fn set_data(&mut self, config: &AdReportType, rows: Vec<serde_json::Value>, cx: &mut Context<Self>) {
        let config_changed = self.config.as_ref() != Some(config);
        self.config = Some(config.clone());
        self.rows = rows;
        self.page = 1;
        self.dirty = true;
        let table = self.table.clone();
        if config_changed {
            self.table = None; // 列结构变化 → 重建 delegate
        } else if let Some(table) = table {
            self.sync_to(&table, cx);
        }
        cx.notify();
    }

    /// 搜索词变化（客户端过滤；重置到第 1 页）
    fn set_search(&mut self, search: String, cx: &mut Context<Self>) {
        if self.search == search {
            return;
        }
        self.search = search;
        self.page = 1;
        self.dirty = true;
        let table = self.table.clone();
        if let Some(table) = table {
            let search = self.search.clone();
            table.update(cx, |state, cx| {
                if state.delegate_mut().set_search(&search) {
                    state.refresh(cx);
                    cx.notify();
                }
            });
        }
        cx.notify();
    }

    /// 翻页
    fn set_page(&mut self, page: usize, cx: &mut Context<Self>) {
        if self.page == page {
            return;
        }
        self.page = page;
        self.dirty = true;
        let table = self.table.clone();
        if let Some(table) = table {
            self.sync_to(&table, cx);
        }
        cx.notify();
    }

    /// 每页行数
    fn set_page_size(&mut self, size: i64, cx: &mut Context<Self>) {
        if self.page_size == size {
            return;
        }
        self.page_size = size;
        self.page = 1;
        self.dirty = true;
        let table = self.table.clone();
        if let Some(table) = table {
            self.sync_to(&table, cx);
        }
        cx.notify();
    }

    /// 把镜像状态同步到 delegate（存在时）；返回是否发生变更
    fn sync_to(
        &mut self,
        table: &Entity<TableState<AdRawDelegate>>,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(config) = self.config.clone() else {
            return false;
        };
        let changed = table.update(cx, |state, cx| {
            let changed = state.delegate_mut().set_all(
                &config,
                &self.rows,
                &self.search,
                self.page,
                self.page_size,
                self.sort_col,
                self.sort_dir,
            );
            if changed {
                state.refresh(cx);
                cx.notify();
            }
            changed
        });
        if changed {
            self.filtered_total = table.read(cx).delegate().filtered_total();
        }
        changed
    }

    /// 视图读取统计：(当前页行数, 过滤后总行数, 页码, 页数)
    fn stats(&self, cx: &App) -> (usize, usize, usize, usize) {
        let filtered_total = self
            .table
            .as_ref()
            .map(|t| t.read(cx).delegate().filtered_total())
            .unwrap_or(self.filtered_total);
        let page = self
            .table
            .as_ref()
            .map(|t| t.read(cx).delegate().page())
            .unwrap_or(self.page);
        let page_count = self
            .table
            .as_ref()
            .map(|t| t.read(cx).delegate().page_count())
            .unwrap_or(1);
        let displayed = self
            .table
            .as_ref()
            .map(|t| t.read(cx).delegate().rows_count(cx))
            .unwrap_or(0);
        (displayed, filtered_total, page, page_count)
    }

}

impl Default for AdRawTable {
    fn default() -> Self {
        Self::new()
    }
}

impl Render for AdRawTable {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(config) = self.config.clone() else {
            return v_flex()
                .id("ad-data-table-empty")
                .w_full()
                .h_80()
                .items_center()
                .justify_center()
                .text_color(AppTheme::current(cx).text_muted)
                .child(div().text_sm().child("暂无数据"))
                .into_any_element();
        };
        let table_entity = {
            let table = self.table.get_or_insert_with(|| {
                let delegate = AdRawDelegate::new(
                    config.clone(),
                    self.rows.clone(),
                    self.search.clone(),
                    self.page,
                    self.page_size,
                    self.sort_col,
                    self.sort_dir,
                );
                cx.new(|cx| TableState::new(delegate, window, cx))
            });
            table.clone()
        };
        // 幂等推送（无变化时 sync_to 返回 false，跳过 refresh）
        let changed = self.sync_to(&table_entity, cx);
        if changed {
            self.filtered_total = table_entity.read(cx).delegate().filtered_total();
        }
        self.dirty = false;

        let theme = AppTheme::current(cx);
        v_flex()
            .id("ad-data-table-card")
            .w_full()
            .rounded(px(theme.radius_lg))
            .bg(theme.card_bg)
            .shadow(vec![theme.card_shadow_box()])
            .overflow_hidden()
            .child(
                div()
                    .flex_1()
                    .min_h(px(260.))
                    .child(Table::new(&table_entity).bordered(false).large()),
            )
            .into_any_element()
    }
}

// ---------------------------------------------------------------------------
// 分页栏
#[cfg(test)]
struct AdDataHost {
    view: Entity<AdDataView>,
}

#[cfg(test)]
impl gpui::Render for AdDataHost {
    fn render(
        &mut self,
        _window: &mut gpui::Window,
        _cx: &mut gpui::Context<Self>,
    ) -> impl IntoElement {
        self.view.clone().into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ---------- 纯函数：过滤 / 排序 / 分页 ----------

    fn rows() -> Vec<serde_json::Value> {
        vec![
            json!({"id": 1, "campaign_name": "活动 A", "impressions": 1200, "clicks": 60, "spend": 30.5, "sales_7d": 500.0, "orders_7d": 4, "acos": 0.061}),
            json!({"id": 2, "campaign_name": "活动 B", "impressions": 800, "clicks": 30, "spend": 12.0, "sales_7d": 200.0, "orders_7d": 1, "acos": 0.06}),
            json!({"id": 3, "campaign_name": "活动 C", "impressions": 2000, "clicks": 100, "spend": 60.0, "sales_7d": 900.0, "orders_7d": 7, "acos": 0.0667}),
        ]
    }

    fn campaign_config() -> AdReportType {
        ad_report_type("ad_campaign_report").expect("campaign 配置存在")
    }

    fn delegate(rows: Vec<serde_json::Value>) -> AdRawDelegate {
        AdRawDelegate::new(
            campaign_config(),
            rows,
            String::new(),
            1,
            DEFAULT_PAGE_SIZE,
            None,
            ColumnSort::Default,
        )
    }

    #[test]
    fn search_filters_across_all_columns() {
        let mut d = delegate(rows());
        assert_eq!(d.filtered_total(), 3);
        assert!(d.set_search("活动 B"));
        assert_eq!(d.filtered_total(), 1);
        assert_eq!(d.display.len(), 1);
        assert_eq!(row_text(&d.display[0], "campaign_name"), "活动 B");
        // 数值列也能搜到（spend 30.5 → "$30.50"）
        d.set_search("30.50");
        assert_eq!(d.filtered_total(), 1);
        assert_eq!(row_text(&d.display[0], "campaign_name"), "活动 A");
        // 空搜索恢复全部
        d.set_search("");
        assert_eq!(d.filtered_total(), 3);
    }

    #[test]
    fn numeric_sort_orders_by_value() {
        let mut d = delegate(rows());
        d.toggle_sort(12); // spend 列（campaign 配置第 13 列 = spend）
        assert_eq!(d.sort_col, Some(12));
        // 升序：12.0 → 30.5 → 60.0
        assert_eq!(row_number(&d.display[0], "spend"), 12.0);
        assert_eq!(row_number(&d.display[2], "spend"), 60.0);
        // 同列再点 → 降序
        d.toggle_sort(12);
        assert_eq!(row_number(&d.display[0], "spend"), 60.0);
        // 新列 → 升序
        d.toggle_sort(15); // sales_7d
        assert_eq!(d.sort_col, Some(15));
        assert_eq!(row_number(&d.display[0], "sales_7d"), 200.0);
    }

    #[test]
    fn text_sort_orders_by_string() {
        let mut d = delegate(rows());
        d.toggle_sort(2); // campaign_name（第 3 列）
        assert_eq!(row_text(&d.display[0], "campaign_name"), "活动 A");
        d.toggle_sort(2);
        assert_eq!(row_text(&d.display[0], "campaign_name"), "活动 C");
    }

    #[test]
    fn pagination_slices_rows_and_clamps_page() {
        let many: Vec<serde_json::Value> = (0..12)
            .map(|i| json!({"id": i, "campaign_name": format!("活动 {i}"), "spend": i as f64}))
            .collect();
        let mut d = AdRawDelegate::new(
            campaign_config(),
            many,
            String::new(),
            1,
            5,
            None,
            ColumnSort::Default,
        );
        assert_eq!(d.display.len(), 5);
        assert_eq!(d.page_count(), 3);
        // 第 3 页只有 2 行
        d.set_all(
            &campaign_config(),
            &d.all_rows.clone(),
            "",
            3,
            5,
            None,
            ColumnSort::Default,
        );
        assert_eq!(d.display.len(), 2);
        // 页码收敛（请求第 99 页 → 第 3 页）
        d.set_all(
            &campaign_config(),
            &d.all_rows.clone(),
            "",
            99,
            5,
            None,
            ColumnSort::Default,
        );
        assert_eq!(d.page(), 3);
        assert_eq!(d.display.len(), 2);
    }

    // ---------- 视图级状态转移 ----------

    fn create_view(cx: &mut gpui::TestAppContext) -> Entity<AdDataView> {
        cx.update(|cx| {
            let client = Client::new("http://127.0.0.1:1");
            cx.new(|cx| AdDataView::new(cx, client))
        })
    }

    fn read_state(cx: &mut gpui::TestAppContext, view: &Entity<AdDataView>) -> AdDataState {
        cx.read(|app| view.read(app).state.read(app).clone())
    }

    fn sample_payload() -> AdDataPayload {
        AdDataPayload {
            projects: vec![ManagedProject {
                id: 1,
                name: "测试项目".to_string(),
                brand_name: None,
                store_address: None,
                project_operator: None,
                assistant_operator: None,
                commission_basis: None,
                commission_rate: None,
                sort_order: 0,
                is_active: true,
                source_file: None,
                has_context: false,
                project_tier: None,
                vat_enabled: false,
            }],
            available_types: vec!["ad_campaign_report".to_string()],
            selected_type: Some("ad_campaign_report".to_string()),
            rows: rows(),
            total_rows: 3,
            period: Some(AdPeriodInfo {
                r#type: "custom".to_string(),
                value: "custom".to_string(),
                start_date: "2000-01-01".to_string(),
                end_date: "2100-12-31".to_string(),
            }),
        }
    }

    #[gpui::test]
    async fn initial_state_is_loading(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx);
        assert_eq!(read_state(cx, &view), AdDataState::Loading);
    }

    #[gpui::test]
    async fn stale_request_result_is_discarded(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx);
        let data = sample_payload();

        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 2;
                this.apply_result(1, Ok(data.clone()), cx);
            });
        });
        assert_eq!(read_state(cx, &view), AdDataState::Loading);

        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.apply_result(2, Ok(data.clone()), cx);
            });
        });
        assert_eq!(read_state(cx, &view), AdDataState::Loaded(data));
    }

    #[gpui::test]
    async fn apply_result_feeds_table_and_records_selection(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx);
        let data = sample_payload();

        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 1;
                this.apply_result(1, Ok(data), cx);
            });
        });
        cx.read(|app| {
            let view = view.read(app);
            assert_eq!(view.available_types.len(), 1);
            assert_eq!(
                view.selected_report_type.as_deref(),
                Some("ad_campaign_report")
            );
            // 表格收到 3 行
            let widget = view.table.read(app);
            assert_eq!(widget.rows.len(), 3);
            assert_eq!(widget.config.as_ref().map(|c| c.report_type), Some("ad_campaign_report"));
        });
    }

    #[gpui::test]
    async fn select_project_and_country_reset_report_type(cx: &mut gpui::TestAppContext) {
        let view = create_view(cx);
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                assert_eq!(this.selected_project_id, None);
                assert_eq!(this.country, "US");
                assert_eq!(this.latest_request_id, 0);

                this.select_project(Some(1), cx);
                assert_eq!(this.selected_project_id, Some(1));
                assert_eq!(this.latest_request_id, 1);
                assert_eq!(this.current_state(cx), AdDataState::Loading);

                // 重复选择同一项目：no-op
                this.select_project(Some(1), cx);
                assert_eq!(this.latest_request_id, 1);

                // 切换站点 → reload
                this.select_country("DE", cx);
                assert_eq!(this.country, "DE");
                assert_eq!(this.latest_request_id, 2);
                this.select_country("DE", cx);
                assert_eq!(this.latest_request_id, 2);
            });
        });
    }

    // ---------- 渲染冒烟 ----------

    #[gpui::test]
    async fn ad_data_loading_state_renders(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
        });
        let view = create_view(cx);
        let (_host, _cx2) = cx.add_window_view(|_window, _cx| AdDataHost { view: view.clone() });
    }

    #[gpui::test]
    async fn ad_data_loaded_state_renders(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
        });
        let view = create_view(cx);
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 1;
                this.apply_result(1, Ok(sample_payload()), cx);
            });
        });
        let (_host, _cx2) = cx.add_window_view(|_window, _cx| AdDataHost { view: view.clone() });
    }

    #[gpui::test]
    async fn ad_data_error_state_renders(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
        });
        let view = create_view(cx);
        cx.update(|cx| {
            view.update(cx, |this, cx| {
                this.latest_request_id = 1;
                this.apply_result(1, Err("接口 500".to_string()), cx);
            });
        });
        let (_host, _cx2) = cx.add_window_view(|_window, _cx| AdDataHost { view: view.clone() });
    }
}
