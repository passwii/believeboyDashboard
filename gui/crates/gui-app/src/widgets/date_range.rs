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

    /// 本周：`[本周一, 今天]`（ISO 周，周一为一周起点）
    pub fn this_week(today: NaiveDate) -> Self {
        let days_since_monday = today.weekday().num_days_from_monday();
        let monday = today.checked_sub_days(chrono::Days::new(days_since_monday as u64));
        Self {
            from: monday,
            to: Some(today),
        }
    }

    /// 上周：完整 `[上周一, 上周日]`
    pub fn last_week(today: NaiveDate) -> Self {
        let days_since_monday = today.weekday().num_days_from_monday();
        let this_monday = today.checked_sub_days(chrono::Days::new(days_since_monday as u64));
        let last_monday = this_monday.and_then(|d| d.checked_sub_days(chrono::Days::new(7)));
        let last_sunday = this_monday.and_then(|d| d.checked_sub_days(chrono::Days::new(1)));
        Self {
            from: last_monday,
            to: last_sunday,
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

    /// 展示文案：优先匹配预设（全部 / 近 N 天 / 本周 / 上周 / 本月 / 上个月），否则
    /// `YYYY-MM-DD ~ YYYY-MM-DD` / 单日 / 单端（`起` / `至`）
    pub fn label(&self, today: NaiveDate) -> String {
        for preset in [
            DateRangePreset::Last7,
            DateRangePreset::Last30,
            DateRangePreset::ThisWeek,
            DateRangePreset::LastWeek,
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

/// 预设快捷（弹层第一行；日 → 周 → 月粒度排列，BLF-795）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DateRangePreset {
    Last7,
    Last30,
    ThisWeek,
    LastWeek,
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
            Self::ThisWeek => "本周",
            Self::LastWeek => "上周",
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
            Self::ThisWeek => DateRange::this_week(today),
            Self::LastWeek => DateRange::last_week(today),
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
    /// BLF-795：Console Bar 翻页模式——触发按钮两侧渲染 ◀ ▶，按当前区间跨度
    /// 前后翻页（整月对齐区间按月平移；默认关闭，普通视图不受影响）
    paging: bool,
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
            paging: false,
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

    /// BLF-795：开启 Console Bar 翻页模式（触发按钮两侧渲染 ◀ ▶）
    pub fn set_paging(&mut self, paging: bool) {
        self.paging = paging;
    }

    /// 前后翻页（`dir` = -1 上一段 / +1 下一段）：整月对齐区间按月平移保持
    /// 月粒度；其余完整区间按自身跨度天数平移；「全部」/单端区间不翻页。
    /// 翻页立即生效并 emit `Change`。
    pub fn page(&mut self, dir: i32, cx: &mut Context<Self>) {
        let Some(range) = page_range(self.range, dir) else {
            return;
        };
        self.draft = range;
        self.synced_draft = range;
        self.range = range;
        cx.emit(DateRangeEvent::Change(range));
        cx.notify();
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
            // 翻页模式更紧凑（◀ label ▶ 贴合），普通视图保持原间距
            .map(|this| {
                if self.paging {
                    this.gap_1()
                } else {
                    this.gap_2()
                }
            })
            .items_center()
            // BLF-795：翻页模式（Console Bar）不渲染「日期」label——36px 控制条
            // 空间紧凑，区间文案已足够表意；普通视图保持原样
            .when(!self.paging, |this| {
                this.child(div().text_sm().text_color(theme.text_muted).child("日期"))
            })
            .when(self.paging, |this| {
                this.child(
                    Button::new("date-range-page-prev")
                        .ghost()
                        .small()
                        .icon(Icon::new(IconName::ChevronLeft).with_size(px(12.)))
                        .tab_stop(false)
                        .on_click(cx.listener(|this, _, _, cx| this.page(-1, cx))),
                )
            })
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
                                anchored().snap_to_window_with_margin(px(8.)).child(
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
                                                .child(h_flex().gap_2().flex_wrap().children(
                                                    PRESETS.iter().enumerate().map(|(i, p)| {
                                                        let p = *p;
                                                        Button::new(("date-range-preset", i))
                                                            .small()
                                                            .ghost()
                                                            .tab_stop(false)
                                                            .label(p.label())
                                                            .on_click(cx.listener(
                                                                move |this, _, _, cx| {
                                                                    this.select_preset(p, cx)
                                                                },
                                                            ))
                                                    }),
                                                ))
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
                                                            Button::new("date-range-clear")
                                                                .ghost()
                                                                .small()
                                                                .label("清除")
                                                                .on_click(cx.listener(
                                                                    |this, _, _, cx| this.clear(cx),
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
            .when(self.paging, |this| {
                this.child(
                    Button::new("date-range-page-next")
                        .ghost()
                        .small()
                        .icon(Icon::new(IconName::ChevronRight).with_size(px(12.)))
                        .tab_stop(false)
                        .on_click(cx.listener(|this, _, _, cx| this.page(1, cx))),
                )
            })
    }
}

/// 前后翻页（纯函数，`dir` = -1 上一段 / +1 下一段）：
/// 1) 整月对齐区间（from = 月首 且 to = 同月末）→ 按月平移，保持月粒度；
/// 2) 其余完整区间 → 按自身跨度天数平移；
/// 3) 「全部」/ 单端区间 → `None`（不翻页）。
fn page_range(range: DateRange, dir: i32) -> Option<DateRange> {
    let (from, to) = match (range.from, range.to) {
        (Some(f), Some(t)) => (f, t),
        _ => return None,
    };
    // 整月对齐判定：to 恰为 from 所在月最后一天
    if to.day() == days_in_month(to.year(), to.month())
        && from.day() == 1
        && from.year() == to.year()
        && from.month() == to.month()
    {
        let months = chrono::Months::new(dir.unsigned_abs());
        let new_from = if dir < 0 {
            from.checked_sub_months(months)
        } else {
            from.checked_add_months(months)
        }?;
        let new_to = month_end(new_from.year(), new_from.month())?;
        return Some(DateRange {
            from: Some(new_from),
            to: Some(new_to),
        });
    }
    // 一般区间：按跨度平移
    let span = (to - from).num_days() + 1;
    let shift = chrono::Days::new((span * dir as i64).unsigned_abs());
    let new_from = if dir < 0 {
        from.checked_sub_days(shift)
    } else {
        from.checked_add_days(shift)
    }?;
    let new_to = if dir < 0 {
        to.checked_sub_days(shift)
    } else {
        to.checked_add_days(shift)
    }?;
    Some(DateRange {
        from: Some(new_from),
        to: Some(new_to),
    })
}

/// 某年某月的天数（闰年按格里历规则）
fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

/// 某年某月最后一天
fn month_end(year: i32, month: u32) -> Option<NaiveDate> {
    NaiveDate::from_ymd_opt(year, month, days_in_month(year, month))
}

/// 预设列表（弹层第一行展示顺序；日 → 周 → 月粒度排列）
const PRESETS: [DateRangePreset; 7] = [
    DateRangePreset::Last7,
    DateRangePreset::Last30,
    DateRangePreset::ThisWeek,
    DateRangePreset::LastWeek,
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

    /// BLF-795：周粒度预设——本周 [周一, 今天]、上周完整 [周一, 周日]
    #[test]
    fn week_presets_align_to_iso_monday() {
        let today = d(2026, 8, 15); // 2026-08-15 是周六
        let this_week = DateRangePreset::ThisWeek.range(today);
        assert_eq!(this_week.from, Some(d(2026, 8, 10)), "本周一");
        assert_eq!(this_week.to, Some(d(2026, 8, 15)));
        let last_week = DateRangePreset::LastWeek.range(today);
        assert_eq!(last_week.from, Some(d(2026, 8, 3)), "上周一");
        assert_eq!(last_week.to, Some(d(2026, 8, 9)), "上周日");
    }

    /// BLF-795：整月对齐区间翻页按月平移（本月 → 上/下个月，保持月末对齐）
    #[test]
    fn page_range_shifts_whole_months_for_month_aligned_ranges() {
        let aug = DateRange::new(Some(d(2026, 8, 1)), Some(d(2026, 8, 31)));
        let jul = page_range(aug, -1).expect("上月");
        assert_eq!(jul.from, Some(d(2026, 7, 1)));
        assert_eq!(jul.to, Some(d(2026, 7, 31)));
        let sep = page_range(aug, 1).expect("下月");
        assert_eq!(sep.from, Some(d(2026, 9, 1)));
        assert_eq!(sep.to, Some(d(2026, 9, 30)), "9 月只有 30 天");
        // 跨年：1 月上翻 → 去年 12 月；平年 1 月下翻 → 2 月末 28 天
        let jan = page_range(
            DateRange::new(Some(d(2026, 1, 1)), Some(d(2026, 1, 31))),
            -1,
        )
        .expect("去年12月");
        assert_eq!(jan.from, Some(d(2025, 12, 1)));
        assert_eq!(jan.to, Some(d(2025, 12, 31)));
        let feb = DateRange::new(Some(d(2027, 2, 1)), Some(d(2027, 2, 28)));
        assert_eq!(
            page_range(feb, 1).map(|r| r.to),
            Some(Some(d(2027, 3, 31))),
            "3 月末"
        );
    }

    /// BLF-795：非整月完整区间按自身跨度平移；「全部」不翻页
    #[test]
    fn page_range_shifts_by_span_and_ignores_open_ranges() {
        let last7 = DateRange::new(Some(d(2026, 8, 9)), Some(d(2026, 8, 15)));
        let prev7 = page_range(last7, -1).expect("前一段");
        assert_eq!(prev7.from, Some(d(2026, 8, 2)));
        assert_eq!(prev7.to, Some(d(2026, 8, 8)));
        let next7 = page_range(last7, 1).expect("后一段");
        assert_eq!(next7.from, Some(d(2026, 8, 16)));
        assert_eq!(next7.to, Some(d(2026, 8, 22)));
        assert_eq!(page_range(DateRange::all(), -1), None, "全部不翻页");
        assert_eq!(
            page_range(DateRange::new(Some(d(2026, 8, 1)), None), 1),
            None
        );
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
        fn render(
            &mut self,
            _window: &mut gpui::Window,
            _cx: &mut gpui::Context<Self>,
        ) -> impl IntoElement {
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
