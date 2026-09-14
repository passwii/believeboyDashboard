import Foundation

/// 列对齐。
public enum AdAnalysisColumnAlignment: Sendable, Equatable {
    case leading
    case trailing
}

/// 单元格着色语义（具体颜色由视图层决定，Kit 只给语义）。
public enum AdAnalysisToneRule: Sendable, Equatable {
    /// 主文本。
    case plain
    /// 次要文本（状态 / 匹配类型 / 动作 / 下一步 这类描述字段）。
    case muted
    /// ACoS 类比率：> 30% 标红、否则标绿（Web `item.acos > 0.3 ? neg : pos`）。
    case acos
    /// 风险等级：高 / 中 / 其余 三档着色（Web `traffic-quality` 的 `risk_level` 分档）。
    case risk
}

/// 一个明细列（标题 + 取值键 + 格式）。
public struct AdAnalysisColumn: Sendable, Equatable, Identifiable {
    public let key: String
    public let title: String
    public let format: AdAnalysisFieldFormat
    public let width: Double
    public let alignment: AdAnalysisColumnAlignment
    public let tone: AdAnalysisToneRule

    public var id: String { key }

    public init(
        _ title: String,
        _ key: String,
        _ format: AdAnalysisFieldFormat = .text,
        width: Double = 110,
        alignment: AdAnalysisColumnAlignment = .leading,
        tone: AdAnalysisToneRule = .plain
    ) {
        self.title = title
        self.key = key
        self.format = format
        self.width = width
        self.alignment = alignment
        self.tone = tone
    }

    /// 该列在某行的显示文本。
    public func text(in row: AdAnalysisRow) -> String {
        AdAnalysisFormatting.text(of: row, key: key, format: format)
    }
}

private func text(_ title: String, _ key: String, width: Double = 160) -> AdAnalysisColumn {
    AdAnalysisColumn(title, key, .text, width: width, tone: .muted)
}

private func number(
    _ title: String,
    _ key: String,
    _ format: AdAnalysisFieldFormat = .money,
    width: Double = 96
) -> AdAnalysisColumn {
    AdAnalysisColumn(title, key, format, width: width, alignment: .trailing)
}

/// 各 Tab 的明细列表格（列序与 Web 桌面表格一致；Web 的「下钻」列在桌面端不做，
/// 跨 Tab 下钻不在本批范围内）。
///
/// 列键**必须**与后端返回的原始字段名逐字相同（动态行不解 snake→camel，见
/// `AdAnalysisValue` 的说明）；`AdAnalysisDecodingTests` 拿真实快照断言每个键都取到值。
public enum AdAnalysisColumns {
    public static func columns(forTabKey tabKey: String) -> [AdAnalysisColumn] {
        switch tabKey {
        case "overview": return overview
        case "time-trend": return timeTrend
        case "campaigns": return campaigns
        case "products": return products
        case "purchased-products": return purchasedProducts
        case "search-terms": return searchTerms
        case "targets": return targets
        case "placements": return placements
        case "budget": return budget
        case "traffic-quality": return trafficQuality
        default: return []
        }
    }

    /// 「总览」把五个来源合并成一张明细网格（Web `overview-client.tsx` 的 DETAILS 区），
    /// 故列键是合并后的统一键（`group` / `name` / …），见 `AdAnalysisOverviewGrid`。
    public static let overview: [AdAnalysisColumn] = [
        text("分组", "group", width: 116),
        text("名称", "name", width: 220),
        number("Spend", "spend", .moneyGroupedOrDash),
        number("Sales", "sales_7d", .moneyGroupedOrDash),
        number("Orders", "orders_7d", .integerOrDash, width: 78),
        AdAnalysisColumn("ACOS", "acos", .percentOrDash, width: 84, alignment: .trailing, tone: .acos),
        number("CPC", "cpc", .moneyGroupedOrDash, width: 84),
        number("Clicks", "clicks", .integerOrDash, width: 78),
    ]

    public static let timeTrend: [AdAnalysisColumn] = [
        text("日期", "report_date", width: 118),
        number("Clicks", "clicks", .integer, width: 82),
        number("Spend", "spend"),
        number("CPC", "cpc"),
        number("Running Spend", "running_spend", .money, width: 124),
    ]

    public static let campaigns: [AdAnalysisColumn] = [
        text("活动", "campaign_name", width: 220),
        text("状态", "status", width: 88),
        text("类型", "targeting_type", width: 96),
        AdAnalysisColumn("Grade", "grade", .text, width: 72, tone: .muted),
        number("CTR", "ctr", .percent, width: 82),
        number("预算在线", "budget_utilization_rate", .percent, width: 92),
        number("Spend", "spend"),
        number("Sales", "sales_7d"),
        AdAnalysisColumn("ACOS", "acos", .percent, width: 84, alignment: .trailing, tone: .acos),
        number("预算缺口", "budget_gap", .money, width: 96),
        number("错失销售", "missed_sales_max", .money, width: 96),
        number("关联销售", "cross_sell_sales_7d", .money, width: 96),
        text("下一步", "next_action", width: 150),
    ]

    public static let products: [AdAnalysisColumn] = [
        text("SKU", "ad_sku", width: 150),
        text("ASIN", "ad_asin", width: 118),
        AdAnalysisColumn("Grade", "grade", .text, width: 72, tone: .muted),
        number("活动数", "campaign_count", .integer, width: 78),
        number("CTR", "ctr", .percent, width: 82),
        number("CVR", "cvr_7d", .percent, width: 82),
        number("Spend", "spend"),
        number("Sales", "sales_7d"),
        number("Orders", "orders_7d", .integer, width: 82),
        AdAnalysisColumn("ACOS", "acos", .percent, width: 84, alignment: .trailing, tone: .acos),
        number("关联销售", "cross_sell_sales_7d", .money, width: 96),
        number("关联单数", "cross_sell_orders_7d", .integer, width: 88),
        text("Top 关联 ASIN", "top_purchased_asin", width: 140),
        text("下一步", "next_action", width: 150),
    ]

    public static let purchasedProducts: [AdAnalysisColumn] = [
        text("关联 ASIN", "purchased_asin", width: 130),
        text("广告 SKU", "ad_sku", width: 140),
        text("动作", "action", width: 120),
        number("活动数", "campaign_count", .integer, width: 78),
        number("Units", "other_sku_units_7d", .integer, width: 82),
        number("Orders", "other_sku_orders_7d", .integer, width: 82),
        number("Sales", "other_sku_sales_7d"),
    ]

    public static let searchTerms: [AdAnalysisColumn] = [
        text("搜索词", "search_term", width: 220),
        text("匹配", "match_type", width: 82),
        number("活动数", "campaign_count", .integer, width: 78),
        text("主活动", "primary_campaign", width: 180),
        number("份额", "impression_share", .percent, width: 82),
        number("排名", "impression_rank", .rank, width: 72),
        number("Spend", "spend"),
        number("Sales", "sales_7d"),
        number("Orders", "orders_7d", .integer, width: 82),
        number("CTR", "ctr", .percent, width: 82),
        number("CVR", "cvr_7d", .percent, width: 82),
        AdAnalysisColumn("ACOS", "acos", .percent, width: 84, alignment: .trailing, tone: .acos),
        text("动作", "action", width: 120),
    ]

    public static let targets: [AdAnalysisColumn] = [
        text("投放", "target_text", width: 200),
        text("匹配", "match_type", width: 82),
        number("活动数", "campaign_count", .integer, width: 78),
        text("主活动", "primary_campaign", width: 180),
        number("首页份额", "top_of_search_impression_share", .percent, width: 96),
        number("Spend", "spend"),
        number("Sales", "sales_7d"),
        number("Orders", "orders_7d", .integer, width: 82),
        number("CTR", "ctr", .percent, width: 82),
        number("CVR", "cvr_7d", .percent, width: 82),
        AdAnalysisColumn("ACOS", "acos", .percent, width: 84, alignment: .trailing, tone: .acos),
        text("动作", "action", width: 120),
    ]

    public static let placements: [AdAnalysisColumn] = [
        text("广告位", "placement", width: 190),
        text("活动", "campaign_name", width: 200),
        text("建议", "action", width: 120),
        number("Spend", "spend"),
        number("Sales", "sales_7d"),
        number("Orders", "orders_7d", .integer, width: 82),
        AdAnalysisColumn("ACOS", "acos", .percent, width: 84, alignment: .trailing, tone: .acos),
        number("CTR", "ctr", .percent, width: 82),
        number("CPC", "cpc"),
        number("CVR", "cvr_7d", .percent, width: 82),
        number("ROAS", "roas", .decimal2, width: 82),
        text("下一步", "next_step", width: 150),
    ]

    public static let budget: [AdAnalysisColumn] = [
        text("活动", "campaign_name", width: 220),
        text("状态", "status", width: 88),
        text("动作", "action", width: 130),
        number("当前预算", "budget", .money, width: 96),
        number("建议预算", "suggested_budget", .money, width: 96),
        number("预算缺口", "budget_gap", .money, width: 96),
        number("预算在线", "budget_utilization_rate", .percent, width: 92),
        number("Spend", "spend"),
        number("Sales", "sales_7d"),
        number("Orders", "orders_7d", .integer, width: 82),
        AdAnalysisColumn("ACOS", "acos", .percent, width: 84, alignment: .trailing, tone: .acos),
        // Web 把这列渲染成「区间」：`$min - $max`。
        AdAnalysisColumn(
            "错失销售（区间）",
            "missed_sales_min",
            .moneyRange(until: "missed_sales_max"),
            width: 168,
            alignment: .trailing
        ),
        text("下一步", "next_step", width: 150),
    ]

    public static let trafficQuality: [AdAnalysisColumn] = [
        text("活动", "campaign_name", width: 220),
        text("状态", "status", width: 88),
        AdAnalysisColumn("风险等级", "risk_level", .text, width: 92, tone: .risk),
        number("总曝光", "total_impressions", .integer, width: 92),
        number("无效曝光", "invalid_impressions", .integer, width: 92),
        number("无效曝光率", "invalid_impression_rate", .percent, width: 100),
        number("总点击", "total_clicks", .integer, width: 84),
        number("无效点击", "invalid_clicks", .integer, width: 88),
        number("无效点击率", "invalid_click_rate", .percent, width: 100),
        text("下一步", "next_step", width: 150),
    ]
}

/// 「总览」明细网格：把 `top_campaigns` / `top_products` / `top_waste_terms` /
/// `trend_summary`（末 7 天）/ `top_cross_sell_products` 五个来源合并成一张网格。
///
/// Web 用五个 `DetailRow` 循环拼在同一张 `<table>` 里，各自传不同的值（例如浪费词行的
/// `sales` 恒为 0 → 显示占位「—」、日趋势行只给 `cpc`/`clicks`）。这里同样按行映射成统一
/// 键：没有的键就不写，占位「—」由 `moneyOrDash` 一族格式自然产生。
public enum AdAnalysisOverviewGrid {
    /// 分组标签（Web 的 `活动 CAMP` / `SKU` / `浪费词 WASTE` / `日趋势 DAILY` / `关联购买 X-SELL`）。
    public static let campaignGroup = "活动 CAMP"
    public static let productGroup = "SKU"
    public static let wasteTermGroup = "浪费词 WASTE"
    public static let trendGroup = "日趋势 DAILY"
    public static let crossSellGroup = "关联购买 X-SELL"

    /// 日趋势在总览明细里只取末日 7 天（Web `data.trend_summary.slice(-7)`）。
    public static let trailingTrendDays = 7

    public static func rows(from payload: AdAnalysisPayload) -> [AdAnalysisRow] {
        var rows: [AdAnalysisRow] = []

        rows += payload.topCampaigns.map { row in
            merged(group: campaignGroup, name: row.nonEmptyString("campaign_name"), from: row,
                   keys: ["spend", "sales_7d", "orders_7d", "acos"])
        }
        rows += payload.topProducts.map { row in
            merged(group: productGroup, name: row.nonEmptyString("ad_sku"), from: row,
                   keys: ["spend", "sales_7d", "orders_7d", "acos"])
        }
        rows += payload.topWasteTerms.map { row in
            merged(group: wasteTermGroup, name: row.nonEmptyString("search_term"), from: row,
                   keys: ["spend", "orders_7d", "clicks"])
        }
        rows += payload.trendSummary.suffix(trailingTrendDays).map { row in
            merged(group: trendGroup, name: row.nonEmptyString("report_date"), from: row,
                   keys: ["spend", "clicks", "cpc"])
        }
        rows += payload.topCrossSellProducts.map { row in
            var values: [String: AdAnalysisValue] = [:]
            let sku = row.nonEmptyString("ad_sku") ?? AdAnalysisFormatting.missing
            let asin = row.nonEmptyString("purchased_asin") ?? AdAnalysisFormatting.missing
            values["name"] = .string("\(sku) → \(asin)")
            // Web 把「其他 SKU 的销售 / 订单」当成这一行的 Sales / Orders 展示。
            values["sales_7d"] = row["other_sku_sales_7d"]
            values["orders_7d"] = row["other_sku_orders_7d"]
            return AdAnalysisRow(fields: mergedFields(group: crossSellGroup, name: nil, values: values))
        }

        return rows
    }

    private static func merged(
        group: String,
        name: String?,
        from row: AdAnalysisRow,
        keys: [String]
    ) -> AdAnalysisRow {
        var values: [String: AdAnalysisValue] = [:]
        for key in keys {
            values[key] = row[key]
        }
        return AdAnalysisRow(fields: mergedFields(group: group, name: name, values: values))
    }

    private static func mergedFields(
        group: String,
        name: String?,
        values: [String: AdAnalysisValue]
    ) -> [String: AdAnalysisValue] {
        var fields: [String: AdAnalysisValue] = ["group": .string(group)]
        if let name {
            fields["name"] = .string(name)
        }
        for (key, value) in values {
            if case .null = value { continue }
            fields[key] = value
        }
        return fields
    }
}
