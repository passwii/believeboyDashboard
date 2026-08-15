//! 通用日期区间选择（P5-0 公共基建，BLF-759）
//!
//! - [`DateRange`]：纯日期区间值（闭区间；None = 不限），提供预设派生
//!   （近 7 天 / 近 30 天 / 本月 / 上个月）与展示文案——不依赖 GPUI，可单测；
//! - [`DateRangePickerState`]：弹层选择器实体（触发器按钮 + 预设快捷 +
//!   起止两个内联 Calendar），通过 [`DateRangeEvent::Change`] 把结构化区间
//!   发回宿主视图（视图 `cx.subscribe` 接收）。
//!
//! 使用：
//! ```ignore
//! let picker = cx.new(|_| DateRangePickerState::new(cx));   // 视图持有
//! cx.subscribe(&picker, |this, _ev, cx| {
//!     let range = picker.read(cx).range();
//!     this.apply_range(range, cx);                          // 视图动作
//! });
//! ```

use chrono::{Datelike, NaiveDate};
use gpui::{
    anchored, deferred, div, prelude::*, px, Context, Entity, EventEmitter, IntoElement,
    MouseButton, ParentElement, SharedString, Styled, Window,
};
use gpui_component::{
    button::{Button, ButtonVariants},
    calendar::{Calendar, CalendarEvent, CalendarState, Date},
    h_flex, v_flex, Icon, IconName, Sizable,
};

use crate::theme::AppTheme;

/// 日期区间（闭区间；None = 不限）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct DateRange {
    /// 区间起始（含）
    pub from: Option<NaiveDate>,
    /// 区间结束（含）
    pub to: Option<NaiveDate>,
}

impl DateRange {
    /// 构造区间
    pub fn new(from: Option<NaiveDate>, to: Option<NaiveDate>) -> Self {
        Self { from, to }
    }

    /// 不限区间（全部）
    pub fn all() -> Self {
        Self::default()
    }

    /// 是否为空区间（全部；公共 API 面）
    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.from.is_none() && self.to.is_none()
    }

    /// 近 N 天（含今天）：`[today - n + 1, today]`
    pub fn last_days(n: u64, today: NaiveDate) -> Self {
        if n == 0 {
            return Self::all();
        }
        Self {
            from: today.checked_sub_days(chrono::Days::new(n - 1)),
            to: Some(today),
        }
    }

    /// 本月：`[当月 1 日, 当天]`
    pub fn this_month(today: NaiveDate) -> Self {
        Self {
            from: NaiveDate::from_ymd_opt(today.year(), today.month(), 1),
            to: Some(today),
        }
    }

    /// 上个月：整月
    pub fn last_month(today: NaiveDate) -> Self {
        let (y, m) = if today.month() == 1 {
            (today.year() - 1, 12)
        } else {
            (today.year(), today.month() - 1)
        };
        let from = NaiveDate::from_ymd_opt(y, m, 1);
        let to = from
            .and_then(|d| d.checked_add_months(chrono::Months::new(1)))
            .and_then(|d| d.checked_sub_days(chrono::Days::new(1)));
        Self { from, to }
    }

    /// 展示文案：优先匹配预设（全部 / 近 N 天 / 本月 / 上个月），否则
    /// `YYYY-MM-DD ~ YYYY-MM-DD` / 单日 / 单端（`起` / `至`）
    pub fn label(&self, today: NaiveDate) -> String {
        for preset in [
            DateRangePreset::Last7,
            DateRangePreset::Last30,
            DateRangePreset::ThisMonth,
            DateRangePreset::LastMonth,
            DateRangePreset::All,
        ] {
            if *self == preset.range(today) {
                return preset.label().to_string();
            }
        }
        match (self.from, self.to) {
            (Some(from), Some(to)) if from == to => from.to_string(),
            (Some(from), Some(to)) => format!("{from} ~ {to}"),
            (Some(from), None) => format!("{from} 起"),
            (None, Some(to)) => format!("至 {to}"),
            (None, None) => "全部".to_string(),
        }
    }
}

/// 预设快捷（弹层第一行）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DateRangePreset {
    Last7,
    Last30,
    ThisMonth,
    LastMonth,
    All,
}

impl DateRangePreset {
    /// 菜单显示名
    pub fn label(&self) -> &'static str {
        match self {
            Self::Last7 => "近 7 天",
            Self::Last30 => "近 30 天",
            Self::ThisMonth => "本月",
            Self::LastMonth => "上个月",
            Self::All => "全部",
        }
    }

    /// 按 `today` 计算对应区间
    pub fn range(&self, today: NaiveDate) -> DateRange {
        match self {
            Self::Last7 => DateRange::last_days(7, today),
            Self::Last30 => DateRange::last_days(30, today),
            Self::ThisMonth => DateRange::this_month(today),
            Self::LastMonth => DateRange::last_month(today),
            Self::All => DateRange::all(),
        }
    }
}

/// 选择器事件（宿主视图订阅）
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DateRangeEvent {
    /// 应用了新的区间（含清空 → All）
    Change(DateRange),
}

/// 日期区间选择器实体：触发器按钮 + 弹层（预设 + 起止 Calendar）
pub struct DateRangePickerState {
    /// 当前生效区间
    range: DateRange,
    /// 今天（预设计算基准；构造时取系统日期）
    today: NaiveDate,
    /// 弹层是否打开
    open: bool,
    /// 弹层内草稿区间（Calendar 点选先落这里，「应用」才提交）
    draft: DateRange,
    /// 已同步到日历实体的草稿（render 时比对，变了才调 set_date）
    synced_draft: DateRange,
    /// 起 / 止 Calendar（首个渲染帧懒建 + 订阅）
    from_calendar: Option<Entity<CalendarState>>,
    to_calendar: Option<Entity<CalendarState>>,
    /// 日历事件订阅（必须持有，否则事件不送达）
    _subscriptions: Vec<gpui::Subscription>,
}

impl DateRangePickerState {
    /// 新建（初始「全部」）
    pub fn new(_cx: &mut Context<Self>) -> Self {
        Self {
            range: DateRange::all(),
            today: chrono::Local::now().naive_local().date(),
            open: false,
            draft: DateRange::all(),
            synced_draft: DateRange::all(),
            from_calendar: None,
            to_calendar: None,
            _subscriptions: Vec::new(),
        }
    }

    /// 当前生效区间（公共 API 面）
    #[allow(dead_code)]
    pub fn range(&self) -> DateRange {
        self.range
    }

    /// 外部设置区间（如视图恢复上次筛选；同步草稿；公共 API 面）
    #[allow(dead_code)]
    pub fn set_range(&mut self, range: DateRange) {
        self.range = range;
        self.draft = range;
    }

    /// 触发器切换开合
    fn toggle(&mut self, cx: &mut Context<Self>) {
        self.open = !self.open;
        cx.notify();
    }

    /// 把草稿同步到日历实体（仅草稿变化时；render 提供 window）
    fn sync_calendars(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.draft == self.synced_draft {
            return;
        }
        if let Some(cal) = &self.from_calendar {
            let date = Date::Single(self.draft.from);
            cal.update(cx, |cal, cx| cal.set_date(date, window, cx));
        }
        if let Some(cal) = &self.to_calendar {
            let date = Date::Single(self.draft.to);
            cal.update(cx, |cal, cx| cal.set_date(date, window, cx));
        }
        self.synced_draft = self.draft;
    }

    /// 日历选中回调（把单日写进草稿对应端）
    fn on_calendar_selected(&mut self, ev: &CalendarEvent, cx: &mut Context<Self>) {
        let picked = match ev {
            CalendarEvent::Selected(date) => match date {
                Date::Single(d) => *d,
                Date::Range(a, _) => *a,
            },
        };
        // 写进草稿但先不提交（用户点「应用」才生效）
        self.draft = DateRange {
            from: picked.or(self.draft.from),
            to: picked.or(self.draft.to),
        };
        cx.notify();
    }

    /// 预设快捷：立即生效并关闭弹层
    fn select_preset(&mut self, preset: DateRangePreset, cx: &mut Context<Self>) {
        let range = preset.range(self.today);
        self.draft = range;
        self.range = range;
        self.open = false;
        cx.emit(DateRangeEvent::Change(range));
        cx.notify();
    }

    /// 应用草稿（Calendar 手动点选后）
    fn apply_draft(&mut self, cx: &mut Context<Self>) {
        let range = self.draft;
        // 起 > 止 → 交换修正（防脏输入）
        let range = match (range.from, range.to) {
            (Some(from), Some(to)) if from > to => DateRange {
                from: Some(to),
                to: Some(from),
            },
            _ => range,
        };
        self.range = range;
        self.open = false;
        cx.emit(DateRangeEvent::Change(range));
        cx.notify();
    }

    /// 清除为「全部」并关闭
    fn clear(&mut self, cx: &mut Context<Self>) {
        self.draft = DateRange::all();
        self.range = DateRange::all();
        self.open = false;
        cx.emit(DateRangeEvent::Change(DateRange::all()));
        cx.notify();
    }
}

impl EventEmitter<DateRangeEvent> for DateRangePickerState {}

impl Render for DateRangePickerState {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = AppTheme::current(cx);

        // 懒建 Calendar 实体 + 订阅选中事件（订阅须持有，否则事件不送达）
        if self.from_calendar.is_none() {
            let cal = cx.new(|cx| CalendarState::new(window, cx));
            let date = Date::Single(self.draft.from);
            cal.update(cx, |cal, cx| cal.set_date(date, window, cx));
            let sub = cx.subscribe(&cal, |this, _entity, ev, cx| {
                this.on_calendar_selected(ev, cx);
            });
            self._subscriptions.push(sub);
            self.from_calendar = Some(cal);
        }
        if self.to_calendar.is_none() {
            let cal = cx.new(|cx| CalendarState::new(window, cx));
            let date = Date::Single(self.draft.to);
            cal.update(cx, |cal, cx| cal.set_date(date, window, cx));
            let sub = cx.subscribe(&cal, |this, _entity, ev, cx| {
                this.on_calendar_selected(ev, cx);
            });
            self._subscriptions.push(sub);
            self.to_calendar = Some(cal);
        }

        // 草稿变化 → 同步到日历（render 持有 window）
        self.sync_calendars(window, cx);

        let label = self.range.label(self.today);
        let open = self.open;

        h_flex()
            .gap_2()
            .items_center()
            .child(
                div()
                    .text_sm()
                    .text_color(theme.text_muted)
                    .child("日期"),
            )
            .child(
                div()
                    .relative()
                    .child(
                        Button::new("date-range-trigger")
                            .outline()
                            .small()
                            .label(SharedString::from(label))
                            .icon(Icon::new(IconName::Calendar).with_size(px(12.)))
                            .on_click(cx.listener(|this, _, _, cx| this.toggle(cx))),
                    )
                    .when(open, |this| {
                        this.child(
                            deferred(
                                anchored()
                                    .snap_to_window_with_margin(px(8.))
                                    .child(
                                        div()
                                            .occlude()
                                            .mt_1p5()
                                            .p_3()
                                            .w(px(460.))
                                            .border_1()
                                            .border_color(theme.separator)
                                            .shadow_lg()
                                            .rounded(px(theme.radius_lg))
                                            .bg(theme.card_bg)
                                            .text_color(theme.text_primary)
                                            .on_mouse_up_out(
                                                MouseButton::Left,
                                                cx.listener(|this, _, _, cx| {
                                                    this.open = false;
                                                    cx.notify();
                                                }),
                                            )
                                            .child(
                                                v_flex()
                                                    .gap_3()
                                                    .child(
                                                        h_flex()
                                                            .gap_2()
                                                            .flex_wrap()
                                                            .children(
                                                                PRESETS.iter().enumerate().map(
                                                                    |(i, p)| {
                                                                        let p = *p;
                                                                        Button::new((
                                                                            "date-range-preset",
                                                                            i,
                                                                        ))
                                                                        .small()
                                                                        .ghost()
                                                                        .tab_stop(false)
                                                                        .label(p.label())
                                                                        .on_click(
                                                                            cx.listener(move |this, _, _, cx| {
                                                                                this.select_preset(
                                                                                    p, cx,
                                                                                )
                                                                            }),
                                                                        )
                                                                    },
                                                                ),
                                                            ),
                                                    )
                                                    .child(
                                                        h_flex()
                                                            .gap_3()
                                                            .items_start()
                                                            .child(
                                                                v_flex()
                                                                    .gap_1()
                                                                    .child(
                                                                        div()
                                                                            .text_xs()
                                                                            .text_color(
                                                                                theme.text_muted,
                                                                            )
                                                                            .child("起始"),
                                                                    )
                                                                    .child(
                                                                        Calendar::new(
                                                                            self.from_calendar
                                                                                .as_ref()
                                                                                .expect("已懒建"),
                                                                        )
                                                                        .number_of_months(1),
                                                                    ),
                                                            )
                                                            .child(
                                                                v_flex()
                                                                    .gap_1()
                                                                    .child(
                                                                        div()
                                                                            .text_xs()
                                                                            .text_color(
                                                                                theme.text_muted,
                                                                            )
                                                                            .child("结束"),
                                                                    )
                                                                    .child(
                                                                        Calendar::new(
                                                                            self.to_calendar
                                                                                .as_ref()
                                                                                .expect("已懒建"),
                                                                        )
                                                                        .number_of_months(1),
                                                                    ),
                                                            ),
                                                    )
                                                    .child(
                                                        h_flex()
                                                            .w_full()
                                                            .justify_end()
                                                            .gap_2()
                                                            .child(
                                                                Button::new(
                                                                    "date-range-clear",
                                                                )
                                                                .ghost()
                                                                .small()
                                                                .label("清除")
                                                                .on_click(cx.listener(
                                                                    |this, _, _, cx| {
                                                                        this.clear(cx)
                                                                    },
                                                                )),
                                                            )
                                                            .child(
                                                                Button::new("date-range-apply")
                                                                    .primary()
                                                                    .small()
                                                                    .label("应用")
                                                                    .on_click(cx.listener(
                                                                        |this, _, _, cx| {
                                                                            this.apply_draft(cx)
                                                                        },
                                                                    )),
                                                            ),
                                                    ),
                                            ),
                                    ),
                            )
                            .with_priority(2),
                        )
                    }),
            )
    }
}

/// 预设列表（弹层第一行展示顺序）
const PRESETS: [DateRangePreset; 5] = [
    DateRangePreset::Last7,
    DateRangePreset::Last30,
    DateRangePreset::ThisMonth,
    DateRangePreset::LastMonth,
    DateRangePreset::All,
];

#[cfg(test)]
mod tests {
    use super::*;

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    // ---------- DateRange 纯逻辑 ----------

    #[test]
    fn date_range_all_is_empty() {
        let r = DateRange::all();
        assert!(r.is_empty());
        assert_eq!(r.label(d(2026, 8, 15)), "全部");
    }

    #[test]
    fn last_days_includes_today() {
        let r = DateRange::last_days(7, d(2026, 8, 15));
        assert_eq!(r.from, Some(d(2026, 8, 9)));
        assert_eq!(r.to, Some(d(2026, 8, 15)));
        assert_eq!(r.label(d(2026, 8, 15)), "近 7 天");
        // n=0 → 全部
        assert!(DateRange::last_days(0, d(2026, 8, 15)).is_empty());
    }

    #[test]
    fn this_month_starts_at_first() {
        let r = DateRange::this_month(d(2026, 8, 15));
        assert_eq!(r.from, Some(d(2026, 8, 1)));
        assert_eq!(r.to, Some(d(2026, 8, 15)));
    }

    #[test]
    fn last_month_is_whole_month_across_year_boundary() {
        let r = DateRange::last_month(d(2026, 1, 15));
        assert_eq!(r.from, Some(d(2025, 12, 1)));
        assert_eq!(r.to, Some(d(2025, 12, 31)));
        let r = DateRange::last_month(d(2026, 3, 10));
        assert_eq!(r.from, Some(d(2026, 2, 1)));
        assert_eq!(r.to, Some(d(2026, 2, 28)));
    }

    #[test]
    fn label_formats_ranges_and_single_ends() {
        let r = DateRange::new(Some(d(2026, 8, 1)), Some(d(2026, 8, 13)));
        assert_eq!(r.label(d(2026, 8, 15)), "2026-08-01 ~ 2026-08-13");
        // 单日
        let r = DateRange::new(Some(d(2026, 8, 13)), Some(d(2026, 8, 13)));
        assert_eq!(r.label(d(2026, 8, 15)), "2026-08-13");
        // 单端
        assert_eq!(
            DateRange::new(Some(d(2026, 8, 1)), None).label(d(2026, 8, 15)),
            "2026-08-01 起"
        );
        assert_eq!(
            DateRange::new(None, Some(d(2026, 8, 13))).label(d(2026, 8, 15)),
            "至 2026-08-13"
        );
    }

    #[test]
    fn preset_ranges_match_labels() {
        let today = d(2026, 8, 15);
        for preset in PRESETS {
            let range = preset.range(today);
            // 预设区间与 DateRange::label 回显一致（不误判为普通区间）
            assert_eq!(range.label(today), preset.label(), "{:?}", preset);
        }
    }

    // ---------- 渲染冒烟 ----------

    /// 宿主视图：渲染 DateRangePicker（亮 / 暗 + 打开弹层两态）
    struct DateRangeHost {
        picker: Option<Entity<DateRangePickerState>>,
        last_range: Option<DateRange>,
        _subscription: Option<gpui::Subscription>,
    }

    impl DateRangeHost {
        fn new(cx: &mut gpui::Context<Self>) -> Self {
            let picker = cx.new(DateRangePickerState::new);
            let subscription = cx.subscribe(&picker, |this, _entity, ev, cx| {
                let DateRangeEvent::Change(range) = ev;
                this.last_range = Some(*range);
                cx.notify();
            });
            Self {
                picker: Some(picker),
                last_range: None,
                _subscription: Some(subscription),
            }
        }
    }

    impl Render for DateRangeHost {
        fn render(&mut self, _window: &mut gpui::Window, _cx: &mut gpui::Context<Self>) -> impl IntoElement {
            self.picker.clone().expect("持有选择器")
        }
    }

    #[gpui::test]
    async fn date_range_picker_renders_in_light_mode(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Light, None, cx);
        });
        cx.add_window_view(|_window, cx| DateRangeHost::new(cx));
    }

    #[gpui::test]
    async fn date_range_picker_renders_in_dark_mode(cx: &mut gpui::TestAppContext) {
        cx.update(|cx| {
            gpui_component::init(cx);
            crate::theme::set_theme_pref(crate::theme::ThemePreference::Dark, None, cx);
        });
        let (_host, cx2) = cx.add_window_view(|_window, cx| DateRangeHost::new(cx));
        cx2.read(|app| assert!(AppTheme::current(app).is_dark()));
    }
}
