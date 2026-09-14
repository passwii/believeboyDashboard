import Foundation

/// 数字 → 文本的**朴素**规则：无 `NumberFormatter`、无 `Locale`。
///
/// 为什么手写而不是用 `NumberFormatter` / `String(format:)` 配 locale：广告两页的验收口径是
/// 「同一个数在 Web 与 Mac 上是同一串文本」。`NumberFormatter` 的千分位与小数点跟随系统区域，
/// 开发机是 `zh_CN` 时对得上、换 `de_DE` 就变成 `1.234,56`；`String(format:)` 不注入 locale，
/// 故小数点恒为 `.`（这一点照用）。
///
/// 这里只放**两端共用的原语**（广告分析页与广告数据页都要），页面各自的占位符与列格式
/// （「—」还是 `-`、整数列要不要千分位）留在 `AdAnalysisFormatting` / `AdDataFormatting`。
public enum NumberText {
    /// 本模块的缺位占位（广告分析页的「—」）。
    ///
    /// 广告数据页用的是 Web `formatAdDataValue` 原文的 `-`，它在自己的格式化器里替换 ——
    /// 占位符属于**页面口径**，不是数字格式的一部分。
    public static let missing = "—"

    /// 无小数的整数形态（`48.0 → "48"`，`0.3434 → "0.3434"`）。非有限值返回 `missing`。
    public static func plain(_ value: Double) -> String {
        guard value.isFinite else { return missing }
        if value == value.rounded(), abs(value) < 1e15 {
            return String(Int64(value))
        }
        return String(value)
    }

    /// 两位小数（`1.7273 → "1.73"`）。非有限值返回 `missing`。
    public static func fixed2(_ value: Double) -> String {
        guard value.isFinite else { return missing }
        return String(format: "%.2f", value)
    }

    /// 给整数部分插千分位：`"1234.56" → "1,234.56"`、`"7775" → "7,775"`。
    ///
    /// 两种入参形态都要支持：金额先过 `fixed2`（必带小数点），而整数列（广告数据页的
    /// `int` 格式，Web 用 `toLocaleString()`）是没有小数点的裸整数。
    /// 非纯数字整数部分（如 `"—"`）原样返回，不猜。
    public static func grouped(_ text: String) -> String {
        let negative = text.hasPrefix("-")
        let body = negative ? String(text.dropFirst()) : text
        let dotIndex = body.firstIndex(of: ".")
        let integerPart = dotIndex.map { String(body[body.startIndex..<$0]) } ?? body
        let fractionPart = dotIndex.map { String(body[$0...]) } ?? ""
        guard integerPart.count > 3, integerPart.allSatisfy(\.isNumber) else { return text }

        var grouped = ""
        for (offset, character) in integerPart.reversed().enumerated() {
            if offset > 0, offset % 3 == 0 { grouped.append(",") }
            grouped.append(character)
        }
        let result = String(grouped.reversed()) + fractionPart
        return negative ? "-" + result : result
    }

    /// 比率 → 百分比两位（`0.3434 → "34.34%"`）。非有限值返回 `missing`。
    public static func percent(_ ratio: Double) -> String {
        guard ratio.isFinite else { return missing }
        return String(format: "%.2f%%", ratio * 100)
    }
}
