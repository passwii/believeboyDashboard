//! 系统管理 → 更新日志（Stage13，BLF-804）
//!
//! 对齐 web 端 `app/dashboard/system/changelog/page.tsx`：版本时间线
//! （V1~V8 发布卡：代号 / 状态 / 起止日期 / 摘要 / 重点方向 chips）。
//!
//! 数据源结论：web 数据是**编译期内嵌静态数组**
//! （`frontend/lib/server/changelog.ts` 的 `RELEASES`），无后端 API。本视图
//! 同样内嵌快照（与 web 同步维护；GUI 重编译自动带上，对齐 model_selection
//! 静态文档范式）。
//!
//! ## 与 web 端的取舍
//!
//! - **保留**：版本时间线结构、状态语义色（current/stable/archived）、
//!   起止日期、摘要、focus 方向 chips；
//! - **精简**：「原始 log 线索」折叠面板不移植（调试用途，价值密度低）；
//!   渐变卡头不接（终端化设计禁装饰渐变，统一 1px 边框卡）。


// Stage13 视图：URL 常量与测试钩子属模块契约面，root.rs 接线前允许暂未消费。
#![allow(dead_code)] // ⚠️ 内部属性必须在文件顶部——见下方等价实现

use gpui::prelude::*;
use gpui::{
    div, px, Context, FontWeight, IntoElement, Render, SharedString, Window,
};
use gpui_component::{h_flex, v_flex};

use crate::theme::{AppTheme, FONT_BASE, FONT_TITLE};
use crate::widgets::data_table::TabularNumsExt;
use crate::widgets::layout::content_guard;
use crate::widgets::page_header::PageHeader;

/// sidebar「系统管理 → 更新日志」URL（数据权威 gui-domain::sidebar）
pub const CHANGELOG_URL: &str = "/dashboard/system/changelog";

// ---------------------------------------------------------------------------
// 快照数据（对齐 frontend/lib/server/changelog.ts RELEASES；
// web 更新后此处同步——刻意不引外部文件，保持 GUI 编译自包含）
// ---------------------------------------------------------------------------

/// 版本状态（archived / stable / current）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReleaseStatus {
    Archived,
    Stable,
    Current,
}

impl ReleaseStatus {
    pub fn label(self) -> &'static str {
        match self {
            Self::Archived => "已归档",
            Self::Stable => "稳定版",
            Self::Current => "当前",
        }
    }
}

/// 一个版本的发布记录
#[derive(Debug, Clone)]
pub struct ReleaseEntry {
    pub version: &'static str,
    pub codename: &'static str,
    pub status: ReleaseStatus,
    /// 起始日（`YYYY-MM-DD`）
    pub start_date: &'static str,
    /// 结束日（`None` = 至今）
    pub end_date: Option<&'static str>,
    pub summary: &'static str,
    /// 重点方向（focus chips）
    pub focus: &'static [&'static str],
}

/// 版本时间线快照（对齐 web RELEASES V1~V8 的版本号 / 代号 / 状态 / 区间 /
/// focus；summary 为压缩版——完整文案走 web 端查看）
pub const RELEASES: &[ReleaseEntry] = &[
    ReleaseEntry {
        version: "V8",
        codename: "终端化外壳",
        status: ReleaseStatus::Current,
        start_date: "2026-08-18",
        end_date: None,
        summary: "高密度交易终端外壳落地：六区布局、设计令牌、52 模块迁移与全局筛选四件套。",
        focus: &["终端外壳", "模块迁移", "全局筛选", "动效"],
    },
    ReleaseEntry {
        version: "V7",
        codename: "CRM 深水区",
        status: ReleaseStatus::Stable,
        start_date: "2026-08-02",
        end_date: Some("2026-08-17"),
        summary: "客户/线索/任务闭环、公海机制、P9 规则引擎与无跟进提醒自动化。",
        focus: &["CRM", "规则引擎", "待跟进"],
    },
    ReleaseEntry {
        version: "V6",
        codename: "库存纵深",
        status: ReleaseStatus::Stable,
        start_date: "2026-07-21",
        end_date: Some("2026-08-01"),
        summary: "库存分类账、月度盘点、在途统计与补货分析链路打通。",
        focus: &["库存", "补货", "盘点"],
    },
    ReleaseEntry {
        version: "V5",
        codename: "广告与财务",
        status: ReleaseStatus::Archived,
        start_date: "2026-07-10",
        end_date: Some("2026-07-20"),
        summary: "广告数据 raw 表、平台回款、佣金管理与 VAT 发票。",
        focus: &["广告", "财务", "回款"],
    },
    ReleaseEntry {
        version: "V4",
        codename: "报表体系",
        status: ReleaseStatus::Archived,
        start_date: "2026-06-28",
        end_date: Some("2026-07-09"),
        summary: "定时报告、报表自动化 RPA 与订单信息大表。",
        focus: &["定时报告", "RPA", "订单"],
    },
    ReleaseEntry {
        version: "V3",
        codename: "AI 能力面",
        status: ReleaseStatus::Archived,
        start_date: "2026-06-15",
        end_date: Some("2026-06-27"),
        summary: "AI Chat、AI洞察、模型选型与客服交流场景化生成。",
        focus: &["AI Chat", "洞察", "客服"],
    },
    ReleaseEntry {
        version: "V2",
        codename: "运营主面",
        status: ReleaseStatus::Archived,
        start_date: "2026-03-01",
        end_date: Some("2026-06-14"),
        summary: "销售数据、SKU 信息、发货管理、站点/店铺导航等运营核心页。",
        focus: &["销售", "SKU", "导航"],
    },
    ReleaseEntry {
        version: "V1",
        codename: "基础搭建",
        status: ReleaseStatus::Archived,
        start_date: "2026-02-23",
        end_date: Some("2026-02-24"),
        summary: "Dashboard 基础骨架、侧边栏结构与销售日报首轮重构。",
        focus: &["控制台框架", "侧边栏导航", "销售日报"],
    },
];

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

/// 更新日志视图：纯静态文档（编译期内嵌，无网络请求）
pub struct ChangelogView;

impl ChangelogView {
    pub fn new() -> Self {
        Self
    }
}

impl Default for ChangelogView {
    fn default() -> Self {
        Self::new()
    }
}

impl Render for ChangelogView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = AppTheme::current(cx);

        let header = PageHeader::new("更新日志")
            .subtitle("产品版本时间线 · 完整发布说明走 web 端");

        let timeline: gpui::AnyElement = v_flex()
            .id("changelog-timeline")
            .w_full()
            .gap_3()
            .children(RELEASES.iter().map(|release| {
                render_release_card(release, &theme)
            }))
            .into_any_element();

        v_flex()
            .id("changelog-view")
            .size_full()
            .gap_4()
            .p_6()
            .overflow_y_scroll()
            .bg(theme.window_bg)
            .child(header)
            .child(content_guard().child(timeline))
    }
}

/// 单个版本卡：版本号 + 代号 + 状态徽标 + 日期区间 + 摘要 + focus chips
fn render_release_card(release: &ReleaseEntry, theme: &AppTheme) -> gpui::AnyElement {
    let (status_label, status_color) = match release.status {
        ReleaseStatus::Current => ("当前", theme.success),
        ReleaseStatus::Stable => ("稳定版", theme.accent),
        ReleaseStatus::Archived => ("已归档", theme.text_muted),
    };
    let date_range = match release.end_date {
        None => format!("{} - 至今", release.start_date),
        Some(end) => format!("{} - {}", release.start_date, end),
    };

    v_flex()
        .id(SharedString::from(format!(
            "changelog-release-{}",
            release.version
        )))
        .w_full()
        .rounded(px(theme.radius_lg))
        .border_1()
        .border_color(theme.separator)
        .bg(theme.card_bg)
        .child(
            h_flex()
                .items_center()
                .gap_2()
                .px_4()
                .py_2()
                .border_b_1()
                .border_color(theme.separator)
                .child(
                    div()
                        .text_size(px(FONT_TITLE))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme.text_primary)
                        .child(format!("{} · {}", release.version, release.codename)),
                )
                .child(
                    div()
                        .px_1p5()
                        .py_0p5()
                        .rounded(px(theme.radius))
                        .text_xs()
                        .text_color(status_color)
                        .child(status_label),
                )
                .child(
                    h_flex()
                        .flex_1()
                        .justify_end()
                        .child(
                            div()
                                .text_xs()
                                .mono_tabular_nums()
                                .text_color(theme.text_muted)
                                .child(date_range),
                        ),
                ),
        )
        .child(
            v_flex()
                .px_4()
                .py_3()
                .gap_2()
                .child(
                    div()
                        .text_size(px(FONT_BASE))
                        .text_color(theme.text_secondary)
                        .child(release.summary),
                )
                .child(
                    h_flex()
                        .flex_wrap()
                        .gap_1()
                        .children(release.focus.iter().map(|f| {
                            div()
                                .id(SharedString::from(format!(
                                    "changelog-focus-{f}"
                                )))
                                .px_1p5()
                                .py_0p5()
                                .rounded(px(theme.radius))
                                .border_1()
                                .border_color(theme.separator.opacity(0.6))
                                .text_xs()
                                .text_color(theme.text_muted)
                                .child(*f)
                        })),
                ),
        )
        .into_any_element()
}
