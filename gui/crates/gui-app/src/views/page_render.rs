//! 工具箱 → Markdown/HTML 渲染（Stage13，BLF-804）
//!
//! 对齐 web 端 `app/dashboard/tools/page-render/page-render-client.tsx` 的
//! **查看主面**：已上传页面历史列表（标题 / 格式 / 大小 / 上传时间）+
//! 选中页 markdown 正文渲染（gpui-component `TextView`）+ 公开链接展示。
//!
//! 数据源（gui-api-client::page_render，只读接入）：
//! - `GET /api/v1/page-render/history` → 历史列表
//! - `GET /api/v1/page-render/{id}` → 正文内容（markdown 渲染）
//!
//! ## 与 web 端的取舍
//!
//! - **保留**：历史列表四态、选中查看 markdown 渲染、公开链接复制；
//! - **精简**：上传 / 删除写链路不移植——GUI 无文件拖放先例，上传走 web 端；
//!   HTML 源码高亮预览不接（TextView markdown 渲染覆盖主场景，html 页面
//!   展示源码原文）。


// Stage13 视图：URL 常量与测试钩子属模块契约面，root.rs 接线前允许暂未消费。
#![allow(dead_code)] // ⚠️ 内部属性必须在文件顶部——见下方等价实现

use gpui::prelude::*;
use gpui::{
    div, px, App, AsyncApp, Context, Entity, FontWeight, IntoElement, Render, SharedString,
    WeakEntity, Window,
};
use gpui_component::button::{Button, ButtonVariants};
use gpui_component::{h_flex, v_flex, Sizable};
use gui_api_client::Client;
use gui_domain::page_render::{PageRenderDetail, PageRenderHistoryItem};

use crate::theme::{AppTheme, FONT_BASE};
use crate::widgets::layout::content_guard;
use crate::widgets::page_header::PageHeader;
use crate::widgets::state_views::{self, SkeletonBlock};

/// sidebar「工具箱 → Markdown/HTML 渲染」URL（数据权威 gui-domain::sidebar）
pub const PAGE_RENDER_URL: &str = "/dashboard/tools/page-render";

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum PageRenderState {
    Loading,
    Loaded(Vec<PageRenderHistoryItem>),
    Empty,
    Error(String),
}

/// 视图（历史列表 + 详情查看；四态 + 竞态保护）
pub struct PageRenderView {
    state: Entity<PageRenderState>,
    client: Client,
    /// 当前选中的页面 id（详情面板数据源）
    selected_id: Option<String>,
    /// 选中页正文缓存（id → 内容；切换选中时懒拉）
    detail: Option<(String, String)>,
    latest_request_id: u64,
}

impl PageRenderView {
    pub fn new(cx: &mut Context<Self>, client: Client) -> Self {
        let state = cx.new(|_| PageRenderState::Loading);
        Self {
            state,
            client,
            selected_id: None,
            detail: None,
            latest_request_id: 0,
        }
    }

    #[allow(dead_code)]
    pub(crate) fn current_state(&self, cx: &App) -> PageRenderState {
        self.state.read(cx).clone()
    }

    /// 首屏拉取历史列表
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        self.latest_request_id = self.latest_request_id.wrapping_add(1);
        let request_id = self.latest_request_id;

        self.state.update(cx, |state, cx| {
            *state = PageRenderState::Loading;
            cx.notify();
        });

        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime()
                        .block_on(async { client.page_render_history().await })
                        .map_err(|e| e.user_message())
                })
                .await;
            this.update(&mut *cx, |this, cx| this.apply_history(request_id, result, cx))
                .ok();
        })
        .detach();
    }

    fn apply_history(
        &mut self,
        request_id: u64,
        result: Result<Vec<PageRenderHistoryItem>, String>,
        cx: &mut Context<Self>,
    ) {
        if request_id != self.latest_request_id {
            return;
        }
        // 历史变化后详情缓存失效；默认选中第一条
        self.detail = None;
        let next = match &result {
            Ok(items) if items.is_empty() => PageRenderState::Empty,
            Ok(_) => PageRenderState::Loaded(result.clone().expect("已判 Ok")),
            Err(msg) => PageRenderState::Error(msg.clone()),
        };
        if let PageRenderState::Loaded(items) = &next {
            self.selected_id = items.first().map(|i| i.id.clone());
            // 首条详情懒拉由 select_page 统一走
            if let Some(id) = self.selected_id.clone() {
                self.fetch_detail(id, cx);
            }
        }
        self.state.update(cx, |state, cx| {
            *state = next;
            cx.notify();
        });
    }

    /// 选中页面 → 拉取正文
    pub fn select_page(&mut self, id: String, cx: &mut Context<Self>) {
        if self.selected_id.as_deref() == Some(id.as_str()) {
            return;
        }
        self.selected_id = Some(id.clone());
        self.fetch_detail(id, cx);
        cx.notify();
    }

    fn fetch_detail(&mut self, id: String, cx: &mut Context<Self>) {
        if self.detail.as_ref().is_some_and(|(cached, _)| *cached == id) {
            return; // 已缓存
        }
        let client = self.client.clone();
        let bg = cx.background_executor().clone();
        cx.spawn(async move |this: WeakEntity<Self>, cx: &mut AsyncApp| {
            let result = bg
                .spawn(async move {
                    crate::runtime::runtime()
                        .block_on(async { client.page_render_detail(&id).await })
                        .map(|d: PageRenderDetail| (d.id.clone(), d.content_markdown()))
                        .map_err(|e| e.user_message())
                })
                .await;
            this.update(&mut *cx, |this, _cx| {
                if let Ok((id, content)) = result {
                    this.detail = Some((id, content));
                }
            })
            .ok();
        })
        .detach();
    }

    /// 复制公开链接到剪贴板（对齐 web Copy 按钮）
    pub fn copy_public_url(&mut self, url: String, cx: &mut Context<Self>) {
        cx.write_to_clipboard(gpui::ClipboardItem::new_string(url));
    }

    /// 当前选中项（Loaded 态）
    fn current_item(&self, cx: &App) -> Option<PageRenderHistoryItem> {
        let PageRenderState::Loaded(items) = self.state.read(cx) else {
            return None;
        };
        let sel = self.selected_id.as_deref()?;
        items.iter().find(|i| i.id == sel).cloned()
    }
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

impl Render for PageRenderView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let app_theme = AppTheme::current(cx);
        let view = cx.entity();
        let state = self.state.read(cx).clone();

        let header = PageHeader::new("Markdown/HTML 渲染")
            .subtitle("已分享页面查看 · 上传与删除走 web 端")
            .action({
                let view = view.clone();
                Button::new("page-render-refresh")
                    .outline()
                    .small()
                    .label("刷新")
                    .on_click(move |_ev, _w, cx| {
                        view.update(cx, |this, cx| this.reload(cx));
                    })
            });

        match state {
            PageRenderState::Loading => v_flex()
                .id("page-render-loading")
                .size_full()
                .gap_4()
                .p_6()
                .overflow_y_scroll()
                .bg(app_theme.window_bg)
                .child(header)
                .child(content_guard().child(state_views::skeleton_loading(
                    &app_theme,
                    &[SkeletonBlock::Filter(1), SkeletonBlock::Table(280.0)],
                ))),
            PageRenderState::Error(msg) => v_flex()
                .id("page-render-error")
                .size_full()
                .gap_4()
                .p_6()
                .overflow_y_scroll()
                .bg(app_theme.window_bg)
                .child(header)
                .child(content_guard().child(state_views::error_state(
                    &view,
                    &app_theme,
                    "page-render-error-state",
                    "页面列表加载失败",
                    msg,
                    |this, cx| this.reload(cx),
                ))),
            PageRenderState::Empty => v_flex()
                .id("page-render-empty")
                .size_full()
                .gap_4()
                .p_6()
                .overflow_y_scroll()
                .bg(app_theme.window_bg)
                .child(header)
                .child(content_guard().child(state_views::empty_state_with_action_desc(
                    &view,
                    &app_theme,
                    "page-render-empty-state",
                    "icons/file-code.svg",
                    "暂无已分享页面",
                    Some("上传 Markdown/HTML 文件请走 web 端「工具箱」页".to_string()),
                    "刷新",
                    |this, cx| this.reload(cx),
                ))),
            PageRenderState::Loaded(items) => {
                let selected = self.current_item(cx);
                // 左列：历史行；右区：详情（markdown 渲染需要 window）
                let list = render_history_list(&items, self.selected_id.as_deref(), view.clone(), &app_theme);
                let detail = render_detail(selected.as_ref(), self.detail.as_ref(), view.clone(), window, cx, &app_theme);

                v_flex()
                    .id("page-render-loaded")
                    .size_full()
                    .min_h_0()
                    .bg(app_theme.window_bg)
                    .child(header)
                    .child(
                        h_flex()
                            .id("page-render-body")
                            .flex_1()
                            .min_h_0()
                            .border_t_1()
                            .border_color(app_theme.separator)
                            .child(list)
                            .child(detail),
                    )
            }
        }
    }
}

/// 左列：历史列表（240px 会话列风格）
fn render_history_list(
    items: &[PageRenderHistoryItem],
    selected_id: Option<&str>,
    view: Entity<PageRenderView>,
    theme: &AppTheme,
) -> gpui::AnyElement {
    v_flex()
        .id("page-render-history")
        .w(px(260.0))
        .h_full()
        .flex_none()
        .border_r_1()
        .border_color(theme.separator)
        .overflow_y_scroll()
        .children(items.iter().enumerate().map(|(ix, item)| {
            let active = selected_id == Some(item.id.as_str());
            let view = view.clone();
            let id = item.id.clone();
            h_flex()
                .id(SharedString::from(format!("page-render-item-{ix}")))
                .items_center()
                .justify_between()
                .px_3()
                .py_2()
                .gap_2()
                .cursor(gpui::CursorStyle::PointingHand)
                .when(ix > 0, |row| {
                    row.border_t_1().border_color(theme.separator.opacity(0.5))
                })
                .when(active, |row| row.bg(theme.table_row_hover))
                .hover(|h| h.bg(theme.table_row_hover))
                .on_click(move |_ev, _w, cx| {
                    view.update(cx, |this, cx| this.select_page(id.clone(), cx));
                })
                .child(
                    v_flex()
                        .min_w_0()
                        .gap_0p5()
                        .child(
                            div().text_size(px(crate::theme::fs(FONT_BASE)))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(if active {
                                    theme.text_primary
                                } else {
                                    theme.text_secondary
                                })
                                .text_ellipsis()
                                .child(item.title.clone()),
                        )
                        .child(
                            div()
                                .text_xs()
                                .text_color(theme.text_muted)
                                .child(format!(
                                    "{} · {}",
                                    item.source_format.to_uppercase(),
                                    gui_app_file_size(item.file_size),
                                )),
                        ),
                )
                .into_any_element()
        }))
        .into_any_element()
}

/// 右区：详情（标题 + 公开链接 + markdown 正文 / html 源码）
fn render_detail(
    item: Option<&PageRenderHistoryItem>,
    detail: Option<&(String, String)>,
    view: Entity<PageRenderView>,
    window: &mut Window,
    cx: &mut App,
    theme: &AppTheme,
) -> gpui::AnyElement {
    let Some(item) = item else {
        return div().flex_1().into_any_element();
    };
    let content = detail.and_then(|(id, c)| (item.id == *id).then(|| c.clone()));

    let mut header_row = h_flex()
        .items_center()
        .justify_between()
        .px_3()
        .py_2()
        .border_b_1()
        .border_color(theme.separator);
    header_row = header_row.child(
        div()
            .text_sm()
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(theme.text_primary)
            .child(item.title.clone()),
    );
    header_row = header_row.child(
        Button::new("page-render-copy-url")
            .ghost()
            .small()
            .label("复制链接")
            .on_click({
                let view = view.clone();
                let url = item.public_url.clone();
                move |_ev, _w, cx| {
                    view.update(cx, |this, cx| this.copy_public_url(url.clone(), cx));
                }
            }),
    );

    let body: gpui::AnyElement = match content {
        Some(text) => gpui_component::text::TextView::markdown(
            "page-render-doc",
            text,
            window,
            cx,
        )
        .selectable(true)
        .into_any_element(),
        None => div()
            .p_4()
            .text_xs()
            .text_color(theme.text_muted)
            .child("正文加载中…")
            .into_any_element(),
    };

    v_flex()
        .id("page-render-detail")
        .flex_1()
        .min_h_0()
        .min_w_0()
        .child(header_row)
        .child(
            div()
                .id("page-render-detail-scroll")
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .child(div().p_3().child(body)),
        )
        .into_any_element()
}

/// 文件大小人性化（本地辅助；避免跨模块引入导出模块依赖）
fn gui_app_file_size(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.2} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}
