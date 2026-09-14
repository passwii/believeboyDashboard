import Foundation

/// 「广告数据」的一个列（中文表头 + 取值键 + 格式），与 Web `AD_DATA_REPORT_TYPES[].columns` 一一对应。
public struct AdDataColumn: Sendable, Hashable, Identifiable {
    /// `Ad*RawRow` 上的字段名（也是排序 / 取值键）。**照抄后端字段名**，不做 snake→camel。
    public let key: String
    /// 中文列名（Web 原文）。
    public let label: String
    public let format: AdDataFieldFormat
    /// 列宽（Web 表格自适应，桌面端定宽 + 横向滚动，便于对照）。
    public let width: Double
    public let alignment: AdDataColumnAlignment

    public var id: String { key }

    public init(
        _ label: String,
        _ key: String,
        _ format: AdDataFieldFormat = .text,
        width: Double = 160,
        alignment: AdDataColumnAlignment = .leading
    ) {
        self.label = label
        self.key = key
        self.format = format
        self.width = width
        self.alignment = alignment
    }

    /// 该列在某行的显示文本（口径见 `AdDataFormatting`）。
    public func text(in row: DynamicJSONRow) -> String {
        AdDataFormatting.text(row[key], as: format)
    }

    /// 该列按数值排序？（Web `isNumericFormat`：非 `text` / `date` 即数值。）
    public var isNumeric: Bool {
        switch format {
        case .text, .date: return false
        case .int, .money, .percent, .ratio: return true
        }
    }
}

/// 列对齐（具体由视图层使用）。
public enum AdDataColumnAlignment: Sendable, Equatable {
    case leading
    case trailing
}

/// 一种报表类型（= 一个端点 = 一张表）。
public struct AdDataReportType: Sendable, Hashable, Identifiable {
    /// 后端 `report_type`（如 `ad_campaign_report`）。
    public let reportType: String
    /// 选择器显示名（Web 原文）。
    public let label: String
    /// 接口路径段：`campaigns` → `/ad-campaigns-raw`。
    public let endpoint: String
    /// 聚合分组维度（本批不做聚合视图，留着供后续批次与对照用）。
    public let groupBy: [String]
    public let columns: [AdDataColumn]

    public var id: String { reportType }

    public init(
        reportType: String,
        label: String,
        endpoint: String,
        groupBy: [String],
        columns: [AdDataColumn]
    ) {
        self.reportType = reportType
        self.label = label
        self.endpoint = endpoint
        self.groupBy = groupBy
        self.columns = columns
    }
}

/// 「广告数据」页的端点目录与口径常量。
///
/// 权威来源是 `frontend/lib/ad-data.ts` 的 `AD_DATA_REPORT_TYPES`：**顺序、`reportType`、
/// `label`、`endpoint`、`groupBy`、列序与中文列名**逐项照抄，两端才谈得上「同值」。
/// 列 key 与 `backend/app/schemas/external/ad_raw.py` 的 `*RawRow` 业务字段逐字相同
/// （10/10，已在 BLF-1057 逐类型 diff 过），`AdDataDecodingTests` 再用**真实响应快照**
/// 断言「每个列键都取到值」—— 列 key 写错在 Swift 侧既不报错也不失败，只会静默少一列。
public enum AdDataCatalog {
    /// Web 路由 —— 同时是 `NavigationItem.id`，也是模块路由表与任务作用域的命中键。
    public static let routeID = "/dashboard/advertising/ad-data"

    /// 默认落地并自动拉取的报表类型（Web 会选中「第一个有数据的类型」；本页不做可用性
    /// 预筛，见口径 3，故落到目录第一项）。
    public static let defaultReportTypeCode = "ad_campaign_report"

    /// 单次请求的行上限（对齐 Web 的 `limit: '10000'`）。
    ///
    /// **不往 50000 抬**：后端允许到 50000，但单响应可达 60 MB+，客户端解码常驻按 3× 估更差
    /// （BLF-1057 评估结论）。`data.count == pageLimit` 时按「可能被截断」提示，而不是静默当作
    /// 完整数据。
    public static let pageLimit = 10000

    /// 客户端翻页每页行数（口径 5：只在内存数组上翻页，不做服务端 offset 翻页）。
    ///
    /// 服务端翻页做不出来的原因：`_run_raw_query` 只按**单个列**排序、没有 tiebreaker，
    /// 实测 `offset=0` 与 `offset=100` 两页有 4 行重复 —— offset 翻页会重复 / 漏行。
    public static let pageSize = 100

    /// 「不限定日期」时发出的哨兵窗口（Web `ad-data-explorer.tsx` 的原文）。
    ///
    /// ⚠️ 与广告分析页**不同**：这里的 `period` 是必填的，不传日期会被 400 拒
    /// （`{"detail":"period is required"}`），所以「不限定日期」必须落成一个宽到覆盖历史与
    /// 未来数据的窗口，而不是省略参数。
    public static let sentinelStartDate = "2000-01-01"
    public static let sentinelEndDate = "2100-12-31"

    /// 10 种报表类型，顺序与 Web 下拉一致。
    public static let reportTypes: [AdDataReportType] = [
        AdDataReportType(
            reportType: "ad_campaign_report",
            label: "广告活动",
            endpoint: "campaigns",
            groupBy: ["campaign_name"],
            columns: [
                date("报告开始日期", "report_start_date"),
                date("报告结束日期", "report_end_date"),
                text("广告活动名称", "campaign_name", width: 210),
                text("投资组合", "portfolio_name", width: 140),
                text("广告活动类型", "campaign_type", width: 130),
                text("定位类型", "targeting_type", width: 110),
                text("竞价策略", "bidding_strategy", width: 130),
                text("状态", "status", width: 88),
                money("预算", "budget"),
                integer("展示量", "impressions"),
                integer("点击量", "clicks"),
                percent("点击率 CTR", "ctr"),
                money("花费", "spend"),
                money("单次点击成本 CPC", "cpc", width: 140),
                integer("7天订单数", "orders_7d"),
                money("7天销售额", "sales_7d", width: 110),
                percent("ACOS", "acos", width: 88),
                ratio("ROAS", "roas", width: 84),
            ]
        ),
        AdDataReportType(
            reportType: "ad_budget_report",
            label: "预算",
            endpoint: "budgets",
            groupBy: ["campaign_name"],
            columns: [
                date("报告开始日期", "report_start_date"),
                date("报告结束日期", "report_end_date"),
                text("广告活动名称", "campaign_name", width: 210),
                text("状态", "status", width: 88),
                money("当前预算", "budget", width: 110),
                money("建议预算", "suggested_budget", width: 110),
                percent("预算利用率", "budget_utilization_rate", width: 104),
                integer("预计错失展示(最小)", "missed_impressions_min", width: 148),
                integer("预计错失展示(最大)", "missed_impressions_max", width: 148),
                integer("预计错失点击(最小)", "missed_clicks_min", width: 140),
                integer("预计错失点击(最大)", "missed_clicks_max", width: 140),
                money("预计错失销售(最小)", "missed_sales_min", width: 140),
                money("预计错失销售(最大)", "missed_sales_max", width: 140),
                money("花费", "spend"),
                money("7天销售额", "sales_7d", width: 110),
                integer("7天订单数", "orders_7d"),
                percent("ACOS", "acos", width: 88),
            ]
        ),
        AdDataReportType(
            reportType: "ad_target_report",
            label: "搜索词投放",
            endpoint: "targets",
            groupBy: ["target_text"],
            columns: [
                date("报告开始日期", "report_start_date"),
                date("报告结束日期", "report_end_date"),
                text("广告活动名称", "campaign_name", width: 210),
                text("广告组名称", "ad_group_name", width: 150),
                text("投放", "target_text", width: 170),
                text("匹配类型", "match_type", width: 90),
                integer("展示量", "impressions"),
                percent("首页首位展示量份额", "top_of_search_impression_share", width: 152),
                integer("点击量", "clicks"),
                percent("点击率 CTR", "ctr"),
                money("单次点击成本 CPC", "cpc", width: 140),
                money("花费", "spend"),
                money("7天销售额", "sales_7d", width: 110),
                integer("7天订单数", "orders_7d"),
                integer("7天单位数", "units_7d"),
                percent("ACOS", "acos", width: 88),
                ratio("ROAS", "roas", width: 84),
                percent("7天转化率", "cvr_7d", width: 104),
            ]
        ),
        AdDataReportType(
            reportType: "ad_placement_report",
            label: "广告位",
            endpoint: "placements",
            groupBy: ["placement"],
            columns: [
                date("报告开始日期", "report_start_date"),
                date("报告结束日期", "report_end_date"),
                text("广告活动名称", "campaign_name", width: 210),
                text("广告位", "placement", width: 150),
                text("竞价策略", "bidding_strategy", width: 130),
                integer("展示量", "impressions"),
                integer("点击量", "clicks"),
                money("花费", "spend"),
                money("单次点击成本 CPC", "cpc", width: 140),
                money("7天销售额", "sales_7d", width: 110),
                integer("7天订单数", "orders_7d"),
                integer("7天单位数", "units_7d"),
                percent("ACOS", "acos", width: 88),
                ratio("ROAS", "roas", width: 84),
            ]
        ),
        AdDataReportType(
            reportType: "ad_search_term_report",
            label: "搜索词",
            endpoint: "search-terms",
            groupBy: ["search_term"],
            columns: [
                date("报告开始日期", "report_start_date"),
                date("报告结束日期", "report_end_date"),
                text("广告活动名称", "campaign_name", width: 210),
                text("广告组名称", "ad_group_name", width: 150),
                text("匹配类型", "match_type", width: 90),
                text("客户搜索词", "search_term", width: 190),
                text("定位类型", "targeting_type", width: 110),
                integer("展示量", "impressions"),
                integer("点击量", "clicks"),
                percent("点击率 CTR", "ctr"),
                money("花费", "spend"),
                money("单次点击成本 CPC", "cpc", width: 140),
                integer("7天订单数", "orders_7d"),
                money("7天销售额", "sales_7d", width: 110),
                percent("ACOS", "acos", width: 88),
                ratio("ROAS", "roas", width: 84),
                percent("7天转化率", "cvr_7d", width: 104),
            ]
        ),
        AdDataReportType(
            reportType: "ad_search_term_share_report",
            label: "搜索词展示量份额",
            endpoint: "search-term-shares",
            groupBy: ["search_term"],
            columns: [
                date("报告开始日期", "report_start_date"),
                date("报告结束日期", "report_end_date"),
                text("客户搜索词", "search_term", width: 190),
                integer("展示量排名", "impression_rank", width: 100),
                percent("展示量份额", "impression_share", width: 104),
                text("投放", "target_text", width: 170),
                text("匹配类型", "match_type", width: 90),
                text("广告活动名称", "campaign_name", width: 210),
                text("广告组名称", "ad_group_name", width: 150),
                integer("点击量", "clicks"),
                integer("展示量", "impressions"),
                percent("点击率 CTR", "ctr"),
                money("花费", "spend"),
                money("单次点击成本 CPC", "cpc", width: 140),
                integer("7天订单数", "orders_7d"),
                money("7天销售额", "sales_7d", width: 110),
                percent("ACOS", "acos", width: 88),
                ratio("ROAS", "roas", width: 84),
                percent("7天转化率", "cvr_7d", width: 104),
            ]
        ),
        AdDataReportType(
            reportType: "ad_promoted_product_report",
            label: "推广的商品",
            endpoint: "promoted-products",
            groupBy: ["ad_sku"],
            columns: [
                date("报告开始日期", "report_start_date"),
                date("报告结束日期", "report_end_date"),
                text("广告活动名称", "campaign_name", width: 210),
                text("广告组名称", "ad_group_name", width: 150),
                text("广告SKU", "ad_sku", width: 150),
                text("广告ASIN", "ad_asin", width: 124),
                integer("展示量", "impressions"),
                integer("点击量", "clicks"),
                percent("点击率 CTR", "ctr"),
                money("花费", "spend"),
                money("单次点击成本 CPC", "cpc", width: 140),
                integer("7天订单数", "orders_7d"),
                integer("7天单位数", "units_7d"),
                money("7天销售额", "sales_7d", width: 110),
                percent("ACOS", "acos", width: 88),
                ratio("ROAS", "roas", width: 84),
                percent("7天转化率", "cvr_7d", width: 104),
                integer("广告SKU 7天单位数", "ad_sku_units_7d", width: 140),
                integer("其他SKU 7天单位数", "other_sku_units_7d", width: 140),
                money("广告SKU 7天销售额", "ad_sku_sales_7d", width: 140),
                money("其他SKU 7天销售额", "other_sku_sales_7d", width: 140),
                text("范围状态", "scope_status", width: 110),
            ]
        ),
        AdDataReportType(
            reportType: "ad_time_trend_report",
            label: "按时间查看效果",
            endpoint: "time-trends",
            groupBy: ["report_end_date"],
            columns: [
                date("报告开始日期", "report_start_date"),
                date("报告结束日期", "report_end_date"),
                text("国家/地区", "country", width: 100),
                text("货币", "currency", width: 84),
                integer("点击量", "clicks"),
                money("单次点击成本 CPC", "cpc", width: 140),
                money("花费", "spend"),
            ]
        ),
        AdDataReportType(
            reportType: "ad_invalid_traffic_report",
            label: "总流量和无效流量",
            endpoint: "invalid-traffic",
            groupBy: ["campaign_name"],
            columns: [
                date("报告开始日期", "report_start_date"),
                date("报告结束日期", "report_end_date"),
                text("广告活动名称", "campaign_name", width: 210),
                text("状态", "status", width: 88),
                integer("总展示量", "total_impressions", width: 104),
                integer("有效展示量", "valid_impressions", width: 110),
                integer("无效展示量", "invalid_impressions", width: 110),
                percent("无效展示率", "invalid_impression_rate", width: 104),
                integer("总点击量", "total_clicks", width: 100),
                integer("有效点击量", "valid_clicks", width: 104),
                integer("无效点击量", "invalid_clicks", width: 104),
                percent("无效点击率", "invalid_click_rate", width: 104),
            ]
        ),
        AdDataReportType(
            reportType: "ad_purchased_product_report",
            label: "已购买商品",
            endpoint: "purchased-products",
            groupBy: ["purchased_asin"],
            columns: [
                date("报告开始日期", "report_start_date"),
                date("报告结束日期", "report_end_date"),
                text("广告活动名称", "campaign_name", width: 210),
                text("广告组名称", "ad_group_name", width: 150),
                text("广告SKU", "ad_sku", width: 150),
                text("广告ASIN", "ad_asin", width: 124),
                text("投放", "target_text", width: 170),
                text("匹配类型", "match_type", width: 90),
                text("已购买ASIN", "purchased_asin", width: 124),
                integer("其他SKU 7天单位数", "other_sku_units_7d", width: 140),
                integer("其他SKU 7天订单数", "other_sku_orders_7d", width: 140),
                money("其他SKU 7天销售额", "other_sku_sales_7d", width: 140),
            ]
        ),
    ]

    public static func reportType(code: String) -> AdDataReportType? {
        reportTypes.first { $0.reportType == code }
    }

    /// `ad-{endpoint}-raw` 的完整路径（`APIClient` 会自动补 `/api/v1`）。
    public static func rawEndpoint(projectID: Int, endpoint: String) -> String {
        "/internal/ad-data/projects/\(projectID)/ad-\(endpoint)-raw"
    }

    /// `ad-upload-files` 的完整路径（项目在路径里）。
    public static func uploadFilesEndpoint(projectID: Int) -> String {
        "/internal/ad-data/projects/\(projectID)/ad-upload-files"
    }

    // MARK: - 列构造助手（Web 的 `DATE_COLS` + 各列格式）

    private static func date(_ label: String, _ key: String) -> AdDataColumn {
        AdDataColumn(label, key, .date, width: 112)
    }

    private static func text(_ label: String, _ key: String, width: Double = 160) -> AdDataColumn {
        AdDataColumn(label, key, .text, width: width)
    }

    private static func integer(_ label: String, _ key: String, width: Double = 96) -> AdDataColumn {
        AdDataColumn(label, key, .int, width: width, alignment: .trailing)
    }

    private static func money(_ label: String, _ key: String, width: Double = 104) -> AdDataColumn {
        AdDataColumn(label, key, .money, width: width, alignment: .trailing)
    }

    private static func percent(_ label: String, _ key: String, width: Double = 92) -> AdDataColumn {
        AdDataColumn(label, key, .percent, width: width, alignment: .trailing)
    }

    private static func ratio(_ label: String, _ key: String, width: Double = 84) -> AdDataColumn {
        AdDataColumn(label, key, .ratio, width: width, alignment: .trailing)
    }
}
