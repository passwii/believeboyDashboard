//! 共享页面头部组件（P4-5，BLF-760）
//!
//! 统一全部业务视图的页面头部结构：**大标题（text_2xl semibold）+
//! 副标题（text_sm muted）+ 可选操作区（右侧）**。此前各视图手写
//! 「text_2xl + text_sm」头部块，口径不一且 site/store navigation 缺失；
//! 收敛为本组件后，chrome 头部（root content_header）只保留面包屑路径，
//! 页面标题唯一来源即本组件（标题去重决策见 BLF-760 完成评论）。
//!
//! 宽窗度量：头部随 [`crate::widgets::layout::content_guard`] 受
//! [`crate::theme::CONTENT_MAX_WIDTH`] 上限约束并居中，与卡片 / 图表内容对齐。

use gpui::{prelude::*, AnyElement, App, SharedString, Window};
use gpui_component::{h_flex, v_flex, StyledExt};

use crate::theme::AppTheme;
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
                            .text_2xl()
                            .font_semibold()
                            .text_color(theme.text_primary)
                            .child(self.title),
                    )
                    .when_some(subtitle, |col, sub| {
                        col.child(
                            gpui::div()
                                .id("page-header-subtitle")
                                .text_sm()
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
        fn render(&mut self, _window: &mut Window, _cx: &mut gpui::Context<Self>) -> impl IntoElement {
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

    // ---------- 排版层级契约（P4-7，BLF-762） ----------

    /// 全部视图与组件的字号必须走 gpui `text_*` 字阶（theme.rs 排版层级
    /// 章节：xs=12 / sm=14 / base=16 / lg=18 / xl=20 / 2xl=24），禁止裸
    /// 像素字面量字号——消除散落临时字号（P4-7 审计一次性收敛 13 文件
    /// 52 处；新代码回退会被本测试拦下）。
    #[test]
    fn no_raw_text_size_px_in_views_and_widgets() {
        let files: &[(&str, &str)] = &[
            // 视图层
            (include_str!("../views/ad_analysis.rs"), "views/ad_analysis.rs"),
            (include_str!("../views/ad_data.rs"), "views/ad_data.rs"),
            (include_str!("../views/daily_analysis.rs"), "views/daily_analysis.rs"),
            (include_str!("../views/dashboard.rs"), "views/dashboard.rs"),
            (include_str!("../views/inventory_analysis.rs"), "views/inventory_analysis.rs"),
            (include_str!("../views/inventory_ledger.rs"), "views/inventory_ledger.rs"),
            (include_str!("../views/login.rs"), "views/login.rs"),
            (include_str!("../views/mod.rs"), "views/mod.rs"),
            (include_str!("../views/monthly_report.rs"), "views/monthly_report.rs"),
            (include_str!("../views/placeholder.rs"), "views/placeholder.rs"),
            (include_str!("../views/platform_inspection.rs"), "views/platform_inspection.rs"),
            (include_str!("../views/platform_inspection_edit.rs"), "views/platform_inspection_edit.rs"),
            (include_str!("../views/platform_revenue.rs"), "views/platform_revenue.rs"),
            (include_str!("../views/portfolio_overview.rs"), "views/portfolio_overview.rs"),
            (include_str!("../views/project_goals.rs"), "views/project_goals.rs"),
            (include_str!("../views/replenishment.rs"), "views/replenishment.rs"),
            (include_str!("../views/return_analysis.rs"), "views/return_analysis.rs"),
            (include_str!("../views/root.rs"), "views/root.rs"),
            (include_str!("../views/scheduled_reports.rs"), "views/scheduled_reports.rs"),
            (include_str!("../views/auto_upload.rs"), "views/auto_upload.rs"),
            (include_str!("../views/seasonal_replenishment.rs"), "views/seasonal_replenishment.rs"),
            (include_str!("../views/sidebar.rs"), "views/sidebar.rs"),
            (include_str!("../views/site_navigation.rs"), "views/site_navigation.rs"),
            (include_str!("../views/stat_band.rs"), "views/stat_band.rs"),
            (include_str!("../views/store_navigation.rs"), "views/store_navigation.rs"),
            (include_str!("../views/weekly_product_analysis.rs"), "views/weekly_product_analysis.rs"),
            // 组件层
            (include_str!("chart_primitives.rs"), "widgets/chart_primitives.rs"),
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
        // 模式用拼接构造，避免断言文案里的字面量自匹配（本测试源码也在 include_str! 范围内）
        let raw_size_pat = "text_size(".to_string() + "px(";
        for (src, path) in files {
            assert!(
                !src.contains(&raw_size_pat),
                "「{path}」存在裸字号字面量：必须改走 gpui text_* 字阶（theme.rs 排版层级）"
            );
        }
    }
}
