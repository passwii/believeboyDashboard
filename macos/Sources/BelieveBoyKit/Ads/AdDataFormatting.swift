import Foundation

/// 「广告数据」原始行的一个列格式 —— 与 Web `frontend/lib/ad-data.ts` 的 `AdDataFormat` 逐项对应。
public enum AdDataFieldFormat: Sendable, Equatable {
    case text
    /// 整数（Web `Number(value).toLocaleString()`，**带千分位**）。
    case int
    /// 金额（Web `'$' + toLocaleString({minimumFractionDigits: 2})`，带千分位、两位小数）。
    case money
    /// 比率 → 百分比两位（Web `(x * 100).toFixed(2) + '%'`）。
    case percent
    /// 倍数两位（Web `Number(value).toFixed(2)`，如 ROAS）。
    case ratio
    /// 纯日期串（`report_start_date` / `report_end_date`，原样显示）。
    case date
}

/// 单元格文本格式 —— 逐字对齐 Web `formatAdDataValue`。
///
/// 与广告分析页的 `AdAnalysisFormatting` **有意分开**：两页的展示口径本来就不同，
/// 合并只能靠一堆开关参数：
///
/// | | 广告数据（本类型） | 广告分析 |
/// | --- | --- | --- |
/// | 缺位占位 | `-`（Web `formatAdDataValue` 原文） | `—` |
/// | 整数列 | 带千分位（`7,775`） | 不带（`7775`） |
/// | 金额 | 带千分位（`$1,234.56`） | 明细不带、总览带 |
///
/// 共用的**数字原语**（分组 / 两位小数 / 百分比）在 `NumberText` 里只有一份，这里只做
/// 「哪一列用哪种口径 + 占位符」的映射。
public enum AdDataFormatting {
    /// 缺位占位 —— Web `formatAdDataValue` 的 `'-'`。
    public static let missing = "-"

    /// 一个值的展示文本（`nil` / `null` / 空串 → `-`，与 Web 的三条判空逐条对应）。
    ///
    /// 形状不符（对象 / 数组落在数值列上）也当缺位：Web 那种情况下渲染出来的是 `NaN`
    /// —— 那不是数字，也不是应当出现在表格里的东西。
    public static func text(_ value: JSONValue?, as format: AdDataFieldFormat) -> String {
        guard let value, !value.isNull else { return missing }
        switch format {
        case .text, .date:
            guard let text = value.text else { return missing }
            return text.isEmpty ? missing : text
        case .int:
            guard let number = value.number, number.isFinite else { return missing }
            return integer(number)
        case .money:
            guard let number = value.number, number.isFinite else { return missing }
            return money(number)
        case .percent:
            guard let number = value.number, number.isFinite else { return missing }
            return NumberText.percent(number)
        case .ratio:
            guard let number = value.number, number.isFinite else { return missing }
            return NumberText.fixed2(number)
        }
    }

    /// 带千分位的整数（`7775 → "7,775"`；`2.5 → "2.5"`，不硬取整）。
    public static func integer(_ value: Double) -> String {
        guard value.isFinite else { return missing }
        return NumberText.grouped(NumberText.plain(value))
    }

    /// 带千分位的两位金额（`1234.5 → "$1,234.50"`）。
    public static func money(_ value: Double) -> String {
        guard value.isFinite else { return missing }
        return "$" + NumberText.grouped(NumberText.fixed2(value))
    }
}
