import Foundation

/// 一个单元格的展示格式（对齐 Web 各 Tab 的 `toFixed` 口径）。
public enum AdAnalysisFieldFormat: Sendable, Equatable {
    case text
    /// 整数（`48`、`1020`）。
    case integer
    /// 金额两位，无千分位：`$32.67`（Web 表格里是 `item.spend.toFixed(2)`）。
    case money
    /// 金额两位带千分位：`$1,234.56`（Web「总览」明细用的 `toLocaleString('zh-CN')`）。
    case moneyGrouped
    /// 比率 → 百分比两位：`0.3434 → 34.34%`（Web `(x * 100).toFixed(2)%`）。
    case percent
    /// 排名类整数：`0` 显示成 `-`（Web `item.impression_rank || '-'`）。
    case rank
    /// 两位小数（ROAS 这类倍数，如 `1.7273 → 1.73`）。
    case decimal2
    /// 金额区间：`$0.00 - $177.85`（Web `budget` 页的错失销售列 `${min} - ${max}`）。
    case moneyRange(until: String)
    /// 数值为 0 / 缺位时显示占位「—」（Web「总览」明细行的 `> 0 ? … : —`）。
    case moneyOrDash
    case moneyGroupedOrDash
    case integerOrDash
    case percentOrDash
}

/// 数字与文本格式化 —— 全部为纯函数，可离线钉住（不依赖本机 locale）。
///
/// 刻意不用 `NumberFormatter` / `Locale`：两端比对要求「同一个数在 Web 与 Mac 上是同一串
/// 文本」，而 `NumberFormatter` 的千分位与小数点跟随系统区域，开发机是 `zh_CN` 时对得上、
/// 换 `de_DE` 就变成 `1.234,56`。这里手写分组，输出与 Web 的 `zh-CN` / `toFixed` 一致。
public enum AdAnalysisFormatting {
    /// 缺位占位（与 Web 各表的 `-` / `—` 同义；本页统一用「—」）。
    ///
    /// 注意：如果 S5.2 广告数据页用 `-`（Web `formatAdDataValue` 的原文）—— 占位符是**页面
    /// 口径**，数字原语（`NumberText`）不替它做决定。
    public static let missing = NumberText.missing

    /// 无小数的整数形态（`48.0 → "48"`，`0.3434 → "0.3434"`）。
    public static func plainNumber(_ value: Double) -> String {
        NumberText.plain(value)
    }

    public static func integer(_ value: Double) -> String {
        plainNumber(value.rounded())
    }

    public static func money(_ value: Double) -> String {
        "$" + fixed2(value)
    }

    /// 两位小数（`String(format:)` 不注入 locale，故小数点恒为 `.`）。
    public static func fixed2(_ value: Double) -> String {
        NumberText.fixed2(value)
    }

    /// 带千分位的两位金额（`$1,234.56`）。
    public static func moneyGrouped(_ value: Double) -> String {
        "$" + grouped(fixed2(value))
    }

    /// 给「整数部分」插千分位（`"1234.56" → "1,234.56"`）。
    public static func grouped(_ text: String) -> String {
        NumberText.grouped(text)
    }

    /// 比率 → 百分比两位（`0.3434 → "34.34%"`）。
    public static func percent(_ ratio: Double) -> String {
        NumberText.percent(ratio)
    }

    // MARK: - 日期（`YYYY-MM-DD` 纯日期串）

    /// 后端把 `date_from` / `date_to` 声明为 `date`（纯日期，无时区语义），`report_date`
    /// 也是 `YYYY-MM-DD` —— 所以两端都按「纯日期」处理，不引入时刻。这里的转换只用
    /// `Calendar` + 字符串，不经 `DateFormatter`（它的输出跟随系统区域，会让同一台机器
    /// 换个语言就发出不同的日期串）。
    public static func dayString(_ date: Date, timeZone: TimeZone = .current) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(
            format: "%04d-%02d-%02d",
            parts.year ?? 0,
            parts.month ?? 0,
            parts.day ?? 0
        )
    }

    /// 今天前 / 后 `offset` 天的纯日期串（日期区间打开时的初值）。
    public static func dayString(
        daysFromToday offset: Int,
        now: Date = Date(),
        timeZone: TimeZone = .current
    ) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let shifted = calendar.date(byAdding: .day, value: offset, to: now) ?? now
        return dayString(shifted, timeZone: timeZone)
    }

    /// `YYYY-MM-DD` → `Date`（拿不到合法日期时返回 nil）。
    public static func date(fromDayString value: String, timeZone: TimeZone = .current) -> Date? {
        let parts = value.split(separator: "-")
        guard parts.count == 3,
              let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2])
        else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        var components = DateComponents()
        components.year = year
        components.month = month
        components.day = day
        components.timeZone = timeZone
        return calendar.date(from: components)
    }

    /// 按格式取一条动态行的单元格文本。
    public static func text(of row: AdAnalysisRow, key: String, format: AdAnalysisFieldFormat) -> String {
        switch format {
        case .text:
            return row.nonEmptyString(key) ?? missing
        case .integer:
            guard let value = row.number(key) else { return missing }
            return integer(value)
        case .money:
            guard let value = row.number(key) else { return missing }
            return money(value)
        case .moneyGrouped:
            guard let value = row.number(key) else { return missing }
            return moneyGrouped(value)
        case .percent:
            guard let value = row.number(key) else { return missing }
            return percent(value)
        case .rank:
            guard let value = row.number(key) else { return missing }
            let rank = Int(value.rounded())
            return rank > 0 ? String(rank) : "-"
        case .decimal2:
            guard let value = row.number(key) else { return missing }
            return fixed2(value)
        case .moneyRange(let upperKey):
            guard let lower = row.number(key), let upper = row.number(upperKey) else { return missing }
            return "\(money(lower)) - \(money(upper))"
        case .moneyOrDash:
            guard let value = row.number(key), value > 0 else { return missing }
            return moneyGrouped(value)
        case .moneyGroupedOrDash:
            guard let value = row.number(key), value > 0 else { return missing }
            return moneyGrouped(value)
        case .integerOrDash:
            guard let value = row.number(key), value > 0 else { return missing }
            return integer(value)
        case .percentOrDash:
            // Web 的 `hasAcos = sales > 0 && spend > 0`：没有销售额就没有 ACoS 可言，
            // 显示占位而不是 0%。
            guard let value = row.number(key), value > 0 else { return missing }
            return percent(value)
        }
    }
}
