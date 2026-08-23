//! 共享页面头部组件（P4-5，BLF-760；BLF-792 紧凑化）
//!
//! 统一全部业务视图的页面头部结构：**大标题（FONT_TITLE_LG semibold）+
//! 副标题（FONT_XS muted）+ 可选操作区（右侧）**。此前各视图手写
//! 头部块，口径不一且 site/store navigation 缺失；
//! 收敛为本组件后，chrome 头部（root content_header）只保留面包屑路径，
//! 页面标题唯一来源即本组件（标题去重决策见 BLF-760 完成评论）。
//!
//! BLF-792：标题字号从 rem 系 text_2xl（24px）切换到紧凑字阶
//! [`crate::theme::FONT_TITLE_LG`]（17px ≈ 13pt bold 上限）；副标题
//! text_sm → [`crate::theme::FONT_XS`]。头部随主工作区全幅平铺
//! （高密度模式取消内容居中上限）。

use gpui::{prelude::*, px, AnyElement, App, SharedString, Window};
use gpui_component::{h_flex, v_flex, StyledExt};

use crate::theme::{AppTheme, FONT_TITLE_LG, FONT_XS};
use crate::widgets::layout::content_guard;

/// 页面头部：大标题 + 副标题 + 可选操作区
#[derive(IntoElement)]
pub struct PageHeader {
    title: SharedString,
    subtitle: Option<SharedString>,
    actions: Vec<AnyElement>,
}

impl PageHeader {
    /// 新建页面头部（仅大标题）
    pub fn new(title: impl Into<SharedString>) -> Self {
        Self {
            title: title.into(),
            subtitle: None,
            actions: Vec::new(),
        }
    }

    /// 副标题（text_sm muted）：筛选上下文 / 页面说明，口径由调用方决定
    pub fn subtitle(mut self, text: impl Into<SharedString>) -> Self {
        self.subtitle = Some(text.into());
        self
    }

    /// 操作区（右侧）：按钮 / 菜单等，可叠加多个（公共 API 面；
    /// 当前业务视图尚未使用，留接口）
    #[allow(dead_code)]
    pub fn action(mut self, el: impl IntoElement) -> Self {
        self.actions.push(el.into_any_element());
        self
    }

    /// 当前标题文本（测试 / 内省用）
    #[allow(dead_code)]
    pub fn title(&self) -> &str {
        &self.title
    }

    /// 当前副标题文本（测试 / 内省用）
    #[allow(dead_code)]
    pub fn subtitle_text(&self) -> Option<&str> {
        self.subtitle.as_ref().map(|s| s.as_str())
    }

    /// 操作区元素数量（测试 / 内省用）
    #[allow(dead_code)]
    pub fn action_count(&self) -> usize {
        self.actions.len()
    }
}

impl RenderOnce for PageHeader {
    fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = AppTheme::current(cx);
        let subtitle = self.subtitle;
        let actions = self.actions;

        let head = h_flex()
            .w_full()
            .min_w_0()
            .items_start()
            .justify_between()
            .gap_4()
            .child(
                v_flex()
                    .min_w_0()
                    .gap_1()
                    .child(
                        gpui::div()
                            .id("page-header-title")
                            .text_size(px(FONT_TITLE_LG))
                            .font_semibold()
                            .text_color(theme.text_primary)
                            .child(self.title),
                    )
                    .when_some(subtitle, |col, sub| {
                        col.child(
                            gpui::div()
                                .id("page-header-subtitle")
                                .text_size(px(FONT_XS))
                                .text_color(theme.text_muted)
                                .child(sub),
                        )
                    }),
            )
            .when(!actions.is_empty(), |row| {
                row.child(
                    h_flex()
                        .id("page-header-actions")
                        .items_center()
                        .gap_2()
                        .children(actions),
                )
            });

        gpui::div()
            .id("page-header")
            .w_full()
            .child(content_guard().child(head))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui_component::button::Button;

    // ---------- 构建器契约 ----------

    #[test]
    fn page_header_builder_configures_fields() {
        let header = PageHeader::new("广告分析");
        assert_eq!(header.title(), "广告分析");
        assert!(header.subtitle_text().is_none());
        assert_eq!(header.action_count(), 0);

        let header = PageHeader::new("销售数据")
            .subtitle("项目 A · US · 近 7 天")
            .action(Button::new("h-act").label("刷新"));
        assert_eq!(header.title(), "销售数据");
        assert_eq!(header.subtitle_text(), Some("项目 A · US · 近 7 天"));
        assert_eq!(header.action_count(), 1);
    }

    // ---------- 渲染冒烟（亮 / 暗 × 有/无副标题/操作区） ----------

    /// 宿主：并列渲染三种头部形态（纯标题 / 带副标题 / 带操作区）
    struct HeaderHost;

    impl Render for HeaderHost {
        fn render(
            &mut self,
            _window: &mut Window,
            _cx: &mut gpui::Context<Self>,
        ) -> impl IntoElement {
            v_flex()
                .gap_4()
                .child(PageHeader::new("纯标题"))
                .child(PageHeader::new("带副标题").subtitle("筛选上下文说明"))
                .child(
                    PageHeader::new("带操作区")
                        .subtitle("副标题")
                        .action(Button::new("host-act").label("操作")),
                )
        }
    }

    #[gpui::test]
    async fn page_header_renders_light_and_dark(cx: &mut gpui::TestAppContext) {
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
            let (_host, cx2) = cx.add_window_view(|_window, _cx| HeaderHost);
            cx2.read(|app| {
                assert_eq!(crate::theme::AppTheme::current(app).is_dark(), dark);
            });
        }
    }

    // ---------- 全视图页面头部一致性契约（P4-5） ----------

    /// 全部业务视图必须用共享 [`PageHeader`] 渲染页面头部（源码级契约：
    /// 新视图接入时忘加 PageHeader 会被本测试拦下）。占位视图 / 登录窗
    /// 不在此列（占位为临时居中卡片，登录窗无页面头部语义）。
    #[test]
    fn all_business_views_use_shared_page_header() {
        // (文件源码，视图名) —— 新增业务视图时同步补入本清单
        let views: &[(&str, &str)] = &[
            (include_str!("../views/ad_analysis.rs"), "广告分析"),
            (include_str!("../views/ad_data.rs"), "广告数据"),
            (include_str!("../views/crm_follow_ups.rs"), "CRM 待跟进"),
            (include_str!("../views/daily_analysis.rs"), "销售数据"),
            (include_str!("../views/dashboard.rs"), "数据看板"),
            (include_str!("../views/inventory_analysis.rs"), "库存分析"),
            (include_str!("../views/monthly_report.rs"), "财务月报"),
            (include_str!("../views/platform_inspection.rs"), "平台巡检"),
            (include_str!("../views/platform_revenue.rs"), "平台回款"),
            (include_str!("../views/portfolio_overview.rs"), "组合分析"),
            (include_str!("../views/project_goals.rs"), "项目目标"),
            (include_str!("../views/research_analysis.rs"), "调研分析"),
            (include_str!("../views/return_analysis.rs"), "退货分析"),
            (include_str!("../views/scheduled_reports.rs"), "定时报告"),
            (include_str!("../views/auto_upload.rs"), "报表自动化"),
            (include_str!("../views/sku_info.rs"), "SKU 信息"),
            (include_str!("../views/site_navigation.rs"), "站点导航"),
            (include_str!("../views/store_navigation.rs"), "店铺导航"),
        ];
        for (src, name) in views {
            assert!(
                src.contains("PageHeader::new("),
                "视图「{name}」必须用共享 PageHeader 渲染页面头部"
            );
            // 头部标题不得再手写 text_2xl 大标题块（PageHeader 承载）；
            // KPI 数值等场景的 text_2xl 不在此限（它们不在 v_flex gap_1
            // 头部结构里）。这里用「旧头部块特征」拦截回退。
            assert!(
                !src.contains("大标题区：标题 + 副标题"),
                "视图「{name}」不得保留手写大标题区（应改用 PageHeader）"
            );
        }
    }

    // ---------- 排版层级契约（P4-7，BLF-762；BLF-792 紧凑字阶） ----------

    /// 全部视图与组件的字号必须走显式来源，禁止裸像素字面量字号：
    /// - **活跃契约（BLF-792 紧凑字阶）**：theme.rs 字号 token
    ///   （`FONT_2XS/XS/SM/BASE/TITLE/TITLE_LG`），即 `text_size(px(FONT_*))`；
    /// - **过渡兼容**：gpui rem 系 `text_xs/sm/base/...` 字阶（存量视图迁移期
    ///   保留，由各视图迁移批次切换到 token）。
    ///
    /// 本测试拦下 `text_size(px(<数字字面量>))` 形式的散落临时字号
    /// （P4-7 审计一次性收敛 13 文件 52 处；新代码回退会被本测试拦下）。
    #[test]
    fn no_raw_text_size_px_in_views_and_widgets() {
        let files: &[(&str, &str)] = &[
            // 视图层
            (
                include_str!("../views/ad_analysis.rs"),
                "views/ad_analysis.rs",
            ),
            (include_str!("../views/ad_data.rs"), "views/ad_data.rs"),
            (
                include_str!("../views/daily_analysis.rs"),
                "views/daily_analysis.rs",
            ),
            (include_str!("../views/dashboard.rs"), "views/dashboard.rs"),
            (
                include_str!("../views/inventory_analysis.rs"),
                "views/inventory_analysis.rs",
            ),
            (
                include_str!("../views/inventory_ledger.rs"),
                "views/inventory_ledger.rs",
            ),
            (include_str!("../views/login.rs"), "views/login.rs"),
            (
                include_str!("../views/master_rail.rs"),
                "views/master_rail.rs",
            ),
            (include_str!("../views/mod.rs"), "views/mod.rs"),
            (
                include_str!("../views/monthly_report.rs"),
                "views/monthly_report.rs",
            ),
            (
                include_str!("../views/placeholder.rs"),
                "views/placeholder.rs",
            ),
            (
                include_str!("../views/platform_inspection.rs"),
                "views/platform_inspection.rs",
            ),
            (
                include_str!("../views/platform_inspection_edit.rs"),
                "views/platform_inspection_edit.rs",
            ),
            (
                include_str!("../views/platform_revenue.rs"),
                "views/platform_revenue.rs",
            ),
            (
                include_str!("../views/portfolio_overview.rs"),
                "views/portfolio_overview.rs",
            ),
            (
                include_str!("../views/project_goals.rs"),
                "views/project_goals.rs",
            ),
            (
                include_str!("../views/replenishment.rs"),
                "views/replenishment.rs",
            ),
            (
                include_str!("../views/return_analysis.rs"),
                "views/return_analysis.rs",
            ),
            (include_str!("../views/root.rs"), "views/root.rs"),
            (
                include_str!("../views/scheduled_reports.rs"),
                "views/scheduled_reports.rs",
            ),
            (
                include_str!("../views/auto_upload.rs"),
                "views/auto_upload.rs",
            ),
            (
                include_str!("../views/seasonal_replenishment.rs"),
                "views/seasonal_replenishment.rs",
            ),
            (
                include_str!("../views/sub_nav.rs"),
                "views/sub_nav.rs",
            ),
            (
                include_str!("../views/command_palette.rs"),
                "views/command_palette.rs",
            ),
            (
                include_str!("../views/site_navigation.rs"),
                "views/site_navigation.rs",
            ),
            (include_str!("../views/stat_band.rs"), "views/stat_band.rs"),
            (
                include_str!("../views/store_navigation.rs"),
                "views/store_navigation.rs",
            ),
            (
                include_str!("../views/weekly_product_analysis.rs"),
                "views/weekly_product_analysis.rs",
            ),
            // 组件层
            (
                include_str!("chart_primitives.rs"),
                "widgets/chart_primitives.rs",
            ),
            (include_str!("charts.rs"), "widgets/charts.rs"),
            (include_str!("data_table.rs"), "widgets/data_table.rs"),
            (include_str!("date_range.rs"), "widgets/date_range.rs"),
            (include_str!("filter_bar.rs"), "widgets/filter_bar.rs"),
            (include_str!("layout.rs"), "widgets/layout.rs"),
            (include_str!("mod.rs"), "widgets/mod.rs"),
            (include_str!("page_header.rs"), "widgets/page_header.rs"),
            (include_str!("pagination.rs"), "widgets/pagination.rs"),
            (include_str!("state_views.rs"), "widgets/state_views.rs"),
            (include_str!("top_projects.rs"), "widgets/top_projects.rs"),
        ];
        for (src, path) in files {
            assert!(
                !contains_raw_px_font_size(src),
                "「{path}」存在裸像素字号字面量：必须改走 theme 字号 token（BLF-792 紧凑字阶）\
                 或 gpui text_* 过渡字阶"
            );
        }
    }

    /// 检测裸像素字号：`text_size(px(<数字字面量>))`。
    ///
    /// theme 字号 token 调用（如 `text_size(px(FONT_BASE))`）放行——token 值
    /// 统一在 theme.rs 收口并有独立回归锁；rem 系 `text_*` 助手不经过
    /// `text_size(`，天然放行。检测器自身源码不含完整危险形态，可安全扫描
    /// 包含本文件的清单。
    fn contains_raw_px_font_size(src: &str) -> bool {
        const NEEDLE: &str = concat!("text_size", "(");
        let mut rest = src;
        while let Some(pos) = rest.find(NEEDLE) {
            let after = &rest[pos + NEEDLE.len()..];
            if let Some(stripped) = after.trim_start().strip_prefix(concat!("px", "(")) {
                if let Some(first) = stripped.trim_start().chars().next() {
                    if first.is_ascii_digit() || first == '.' || first == '-' || first == '+' {
                        return true;
                    }
                }
            }
            rest = after;
        }
        false
    }

    #[test]
    fn raw_px_font_size_detector_contract() {
        let call = |inner: &str| format!(".child(el.text_size(px({inner})))");
        assert!(
            contains_raw_px_font_size(&call("13.0")),
            "裸数字字面量必须命中"
        );
        assert!(
            contains_raw_px_font_size(&call("14")),
            "整数裸字面量必须命中"
        );
        assert!(contains_raw_px_font_size(&call(" 12.5 ")), "带空白仍须命中");
        assert!(
            !contains_raw_px_font_size(&call("FONT_BASE")),
            "theme 字号 token 必须放行"
        );
        assert!(
            !contains_raw_px_font_size(".text_sm().text_base()"),
            "rem 系助手不经过 text_size(，放行"
        );
        assert!(!contains_raw_px_font_size("plain source without sizes"));
    }
}
