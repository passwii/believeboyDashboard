import Foundation

/// 「最近活动」的新鲜度档位（Web `freshnessFor` 的三档）。
public enum AgentFreshness: String, Sendable, Equatable, CaseIterable {
    /// < 24h。
    case green
    /// 1–7 天（每日巡检域落到黄灯即需人工介入）。
    case yellow
    /// > 7 天，或从未活动（无 `last_active_at`）。
    case grey
}

/// 矩阵上那几个「时间是相对量」的列：新鲜度、相对时间、错误率、美西今天。
///
/// 全部是**纯函数**并显式接受 `now` / `timeZone`：这些口径最容易错（时区、四舍五入、
/// 边界），而它们的正确性只能靠边界用例钉住 —— 把 `Date()` 藏在函数体内就没法测了。
public enum AgentOpsFormatting {
    /// 业务日期以西海岸为准（Web `use-agent-production.ts` / `use-report-upload-status.ts`
    /// 的 `US_TIMEZONE`）。
    ///
    /// 桌面端若用**本地时区**算「今天」，在美西 16:00 之后（北京次日 07:00 之后）
    /// 「今日产出」整列会指向明天 —— 后端那天还没有 run / 没有上传记录，整列都会是
    /// 「—」。这是本模块最容易错、也最难靠肉眼发现的一处。
    public static let usTimeZoneIdentifier = "America/Los_Angeles"

    public static var usTimeZone: TimeZone {
        // 自带 tzdata，标识符不存在只可能是在裁剪过的容器里；退回固定偏移会静默算错，
        // 故这里用一个「宁可显式失败」的写法：取不到就退回 UTC —— 至少不会错到本地时区。
        TimeZone(identifier: usTimeZoneIdentifier) ?? TimeZone(secondsFromGMT: 0)!
    }

    /// 美西「今天」`YYYY-MM-DD`（等价 `Intl.DateTimeFormat('en-CA', {timeZone})`）。
    ///
    /// 手工拼 `yyyy-MM-dd` 而不是走 `DateFormatter` / `Date.FormatStyle`：这一串是
    /// **请求参数**（`?date=` / `?report_date=`），一旦被本地化（`2026/09/14`、
    /// 佛历 / 和历年份）后端会 400 或静默落到另一天。`Calendar` 取分量是最不易出错的写法。
    public static func usToday(now: Date = Date(), timeZone: TimeZone = AgentOpsFormatting.usTimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let components = calendar.dateComponents([.year, .month, .day], from: now)
        return String(
            format: "%04d-%02d-%02d",
            components.year ?? 0,
            components.month ?? 0,
            components.day ?? 0
        )
    }

    /// ISO8601 → `Date`（带 / 不带小数秒都认）。
    ///
    /// 后端返回的 `last_active_at` 带 6 位小数秒 + 偏移量（如
    /// `2026-09-11T18:31:32.647904+08:00`）；`Date.ISO8601FormatStyle` 显式声明小数秒
    /// 与否都能吃下这两种形态（已对真实响应实测），且它是 `Sendable` 的值类型 ——
    /// 不像 `ISO8601DateFormatter`（非 Sendable，作静态常量在 Swift 6 严格并发下直接
    /// 编译不过）。
    public static func parseISO8601(_ value: String?) -> Date? {
        guard let raw = value?.trimmedNonEmpty else { return nil }
        return try? Date(raw, strategy: iso8601Format)
    }

    private static let iso8601Format = Date.ISO8601FormatStyle(includingFractionalSeconds: true)

    /// 新鲜度档位：<24h 绿 / 1–7d 黄 / >7d 或从未活动 灰。
    public static func freshness(lastActiveAt: String?, now: Date = Date()) -> AgentFreshness {
        guard let activeAt = parseISO8601(lastActiveAt) else { return .grey }
        let hours = now.timeIntervalSince(activeAt) / 3_600
        if hours < 24 { return .green }
        if hours < 24 * 7 { return .yellow }
        return .grey
    }

    /// 相对时间文案：刚刚 / N 分钟前 / N 小时前 / N 天前 / M/D；无值或不可解析 → 从未。
    ///
    /// 与 Web `formatRelativeTime` 同口径（含「未来时间戳算刚刚」这条：时钟漂移时
    /// 差值可能为负，`< 1 分钟` 分支自然会吸收它）。
    public static func relativeTime(
        lastActiveAt: String?,
        now: Date = Date(),
        timeZone: TimeZone = .current
    ) -> String {
        guard let activeAt = parseISO8601(lastActiveAt) else { return "从未" }
        let minutes = now.timeIntervalSince(activeAt) / 60
        if minutes < 1 { return "刚刚" }
        if minutes < 60 { return "\(Int(minutes.rounded(.down))) 分钟前" }
        let hours = minutes / 60
        if hours < 24 { return "\(Int(hours.rounded(.down))) 小时前" }
        let days = hours / 24
        if days < 30 { return "\(Int(days.rounded(.down))) 天前" }
        // Web 的 M/D 用**浏览器本地时区**的月/日；桌面端同口径用系统时区。
        return monthDayText(activeAt, timeZone: timeZone)
    }

    /// `M/D`（不补零，与 Web 的 `getMonth()+1` / `getDate()` 同形）。
    private static func monthDayText(_ date: Date, timeZone: TimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let components = calendar.dateComponents([.month, .day], from: date)
        guard let month = components.month, let day = components.day else { return "从未" }
        return "\(month)/\(day)"
    }

    /// 时刻（`HH:mm:ss`）——页头「本页数据于 … 拉取」。
    public static func clockTime(_ date: Date, timeZone: TimeZone = .current) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let components = calendar.dateComponents([.hour, .minute, .second], from: date)
        return String(
            format: "%02d:%02d:%02d",
            components.hour ?? 0,
            components.minute ?? 0,
            components.second ?? 0
        )
    }

    /// 7 天错误率：`Math.round(errors / calls * 100)%`；无调用 → 占位「—」。
    ///
    /// 保留整数百分比（Web 同口径）—— 这里不是精度取舍，而是与 Web 逐字对齐：
    /// 两端显示同一个数字，抽样比对才有意义。
    public static func errorRateText(errors7d: Int, calls7d: Int) -> String {
        guard calls7d > 0 else { return "—" }
        let rate = (Double(errors7d) / Double(calls7d) * 100).rounded()
        return "\(Int(rate))%"
    }

    /// 绝对时间（详情 / hover 用，矩阵上只放相对时间）。
    ///
    /// 同样手工拼 `yyyy-MM-dd HH:mm:ss`（不本地化）——详情里给出的是可粘贴、可对照
    /// 后端日志/Audit 的时间字符串，换成任何一种本地化格式都会在复制粘贴时变形。
    public static func absoluteTime(
        lastActiveAt: String?,
        timeZone: TimeZone = .current
    ) -> String {
        guard let activeAt = parseISO8601(lastActiveAt) else { return "从未活动" }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let components = calendar.dateComponents(
            [.year, .month, .day, .hour, .minute, .second],
            from: activeAt
        )
        return String(
            format: "%04d-%02d-%02d %02d:%02d:%02d",
            components.year ?? 0,
            components.month ?? 0,
            components.day ?? 0,
            components.hour ?? 0,
            components.minute ?? 0,
            components.second ?? 0
        )
    }
}
