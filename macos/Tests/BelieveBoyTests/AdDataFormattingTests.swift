import BelieveBoyKit
import BelieveBoyUI
import Foundation
import XCTest

/// 「广告数据」单元格文本口径（对齐 Web `formatAdDataValue`）。
///
/// 两端数值「看起来差不多但不相等」多半就出在这一层：同一个数在 Web 是 `7,775`（千分位）
/// 还是 `7775`、是 `0.66%` 还是 `0.00658`，逐条钉在这里，抽样比对时才有共同基准。
final class AdDataFormattingTests: XCTestCase {
    // MARK: - 判空（Web 的三条：null / undefined / 空串）

    func testMissingValuesBecomeDash() {
        XCTAssertEqual(AdDataFormatting.text(nil, as: .text), "-")
        XCTAssertEqual(AdDataFormatting.text(.null, as: .text), "-")
        XCTAssertEqual(AdDataFormatting.text(.string(""), as: .text), "-")
        XCTAssertEqual(AdDataFormatting.text(nil, as: .int), "-")
        XCTAssertEqual(AdDataFormatting.text(.null, as: .money), "-")
        XCTAssertEqual(AdDataFormatting.text(.string(""), as: .money), "-")
        XCTAssertEqual(AdDataFormatting.missing, "-", "Web 的占位就是这一个字符")
    }

    // MARK: - 各格式

    func testIntegerUsesThousandsSeparator() {
        XCTAssertEqual(AdDataFormatting.text(.number(7775), as: .int), "7,775")
        XCTAssertEqual(AdDataFormatting.text(.number(760), as: .int), "760")
        XCTAssertEqual(AdDataFormatting.text(.number(0), as: .int), "0", "0 不判空（Web 的判空只认 ''）")
        XCTAssertEqual(AdDataFormatting.text(.number(1_234_567), as: .int), "1,234,567")
        XCTAssertEqual(AdDataFormatting.text(.number(-1234), as: .int), "-1,234")
        XCTAssertEqual(
            AdDataFormatting.integer(2.5),
            "2.5",
            "不硬取整：JS 的 toLocaleString 对 2.5 也是 \"2.5\""
        )
    }

    func testMoneyUsesThousandsAndTwoDecimals() {
        XCTAssertEqual(AdDataFormatting.text(.number(1234.5), as: .money), "$1,234.50")
        XCTAssertEqual(AdDataFormatting.text(.number(14.59), as: .money), "$14.59")
        XCTAssertEqual(AdDataFormatting.text(.number(0), as: .money), "$0.00")
        XCTAssertEqual(AdDataFormatting.text(.number(95.85), as: .money), "$95.85")
        XCTAssertEqual(AdDataFormatting.text(.number(-1234.5), as: .money), "$-1,234.50")
        XCTAssertEqual(
            AdDataFormatting.text(.string("17.5"), as: .money),
            "$17.50",
            "后端偶有把数值写成字符串的行（Number(value) 同样能解读）"
        )
    }

    func testPercentMultipliesByHundred() {
        XCTAssertEqual(AdDataFormatting.text(.number(0.00658), as: .percent), "0.66%")
        XCTAssertEqual(AdDataFormatting.text(.number(0.475358), as: .percent), "47.54%")
        XCTAssertEqual(AdDataFormatting.text(.number(1), as: .percent), "100.00%")
        XCTAssertEqual(AdDataFormatting.text(.number(0), as: .percent), "0.00%")
    }

    func testRatioUsesTwoDecimalsWithoutScaling() {
        XCTAssertEqual(AdDataFormatting.text(.number(1.7273), as: .ratio), "1.73")
        XCTAssertEqual(AdDataFormatting.text(.number(0), as: .ratio), "0.00")
    }

    func testTextAndDatePassThrough() {
        XCTAssertEqual(AdDataFormatting.text(.string("Auto-DL18"), as: .text), "Auto-DL18")
        XCTAssertEqual(AdDataFormatting.text(.string("2026-09-13"), as: .date), "2026-09-13")
        XCTAssertEqual(
            AdDataFormatting.text(.string("亚马逊站内的商品页面"), as: .text),
            "亚马逊站内的商品页面"
        )
        // 文本列拿到数字时按朴素数字显示（JS 的 String(42) 也是 "42"）。
        XCTAssertEqual(AdDataFormatting.text(.number(42), as: .text), "42")
    }

    /// 形状不符（对象 / 数组落在数值列）当缺位 —— Web 那种情况渲染的是 `NaN`，
    /// 那不是数字、也不该出现在表格里。
    func testWrongShapeOnNumericColumnIsMissing() {
        XCTAssertEqual(AdDataFormatting.text(.object(["a": .number(1)]), as: .int), "-")
        XCTAssertEqual(AdDataFormatting.text(.array([.number(1)]), as: .money), "-")
        XCTAssertEqual(AdDataFormatting.text(.string("abc"), as: .int), "-", "解析不出数值 → 占位")
    }

    // MARK: - 列

    func testColumnFormatsThroughItsOwnFormat() throws {
        let payload = try AdDataFixtures.payload(forEndpoint: "campaigns")
        let row = try XCTUnwrap(payload.data.first)
        let type = try XCTUnwrap(AdDataCatalog.reportType(code: "ad_campaign_report"))

        func column(_ key: String) throws -> AdDataColumn {
            try XCTUnwrap(type.columns.first { $0.key == key })
        }

        XCTAssertEqual(try column("campaign_name").text(in: row), "Auto-DL18")
        XCTAssertEqual(try column("spend").text(in: row), "$14.59")
        XCTAssertEqual(try column("budget").text(in: row), "$20.00")
        XCTAssertEqual(try column("impressions").text(in: row), "760")
        XCTAssertEqual(try column("ctr").text(in: row), "0.66%")
        XCTAssertEqual(try column("roas").text(in: row), "0.00")
        XCTAssertEqual(try column("report_start_date").text(in: row), "2026-09-13")
    }

    /// 数值列 / 文本列的划分（Web `isNumericFormat`）—— 决定排序与右对齐。
    func testNumericFormatClassification() {
        XCTAssertFalse(AdDataColumn("日期", "report_end_date", .date).isNumeric)
        XCTAssertFalse(AdDataColumn("名称", "campaign_name", .text).isNumeric)
        XCTAssertTrue(AdDataColumn("展示量", "impressions", .int).isNumeric)
        XCTAssertTrue(AdDataColumn("花费", "spend", .money).isNumeric)
        XCTAssertTrue(AdDataColumn("CTR", "ctr", .percent).isNumeric)
        XCTAssertTrue(AdDataColumn("ROAS", "roas", .ratio).isNumeric)
    }

    /// 列定义与 Web `lib/ad-data.ts` 的逐列对照（列数 + 中文表头 + key 顺序）。
    func testCatalogMatchesWebColumnLayout() throws {
        let expected: [String: [(String, String)]] = [
            "ad_campaign_report": [
                ("report_start_date", "报告开始日期"), ("report_end_date", "报告结束日期"),
                ("campaign_name", "广告活动名称"), ("portfolio_name", "投资组合"),
                ("campaign_type", "广告活动类型"), ("targeting_type", "定位类型"),
                ("bidding_strategy", "竞价策略"), ("status", "状态"), ("budget", "预算"),
                ("impressions", "展示量"), ("clicks", "点击量"), ("ctr", "点击率 CTR"),
                ("spend", "花费"), ("cpc", "单次点击成本 CPC"), ("orders_7d", "7天订单数"),
                ("sales_7d", "7天销售额"), ("acos", "ACOS"), ("roas", "ROAS"),
            ],
            "ad_time_trend_report": [
                ("report_start_date", "报告开始日期"), ("report_end_date", "报告结束日期"),
                ("country", "国家/地区"), ("currency", "货币"), ("clicks", "点击量"),
                ("cpc", "单次点击成本 CPC"), ("spend", "花费"),
            ],
            "ad_purchased_product_report": [
                ("report_start_date", "报告开始日期"), ("report_end_date", "报告结束日期"),
                ("campaign_name", "广告活动名称"), ("ad_group_name", "广告组名称"),
                ("ad_sku", "广告SKU"), ("ad_asin", "广告ASIN"), ("target_text", "投放"),
                ("match_type", "匹配类型"), ("purchased_asin", "已购买ASIN"),
                ("other_sku_units_7d", "其他SKU 7天单位数"),
                ("other_sku_orders_7d", "其他SKU 7天订单数"),
                ("other_sku_sales_7d", "其他SKU 7天销售额"),
            ],
        ]

        for (code, pairs) in expected {
            let type = try XCTUnwrap(AdDataCatalog.reportType(code: code))
            XCTAssertEqual(
                type.columns.map { ($0.key, $0.label) }.map { "\($0.0)|\($0.1)" },
                pairs.map { "\($0.0)|\($0.1)" },
                "\(code) 的列序 / 中文表头必须与 Web lib/ad-data.ts 一致"
            )
        }
    }

    /// 10 个报表类型的 `reportType` / `label` / `endpoint` / `groupBy` 与 Web 逐项一致
    /// —— 端点写错一个字母就会 404，`label` 对不上就会与 Web 的下拉对不上号。
    func testCatalogMatchesWebReportTypes() throws {
        let expected: [(String, String, String, [String])] = [
            ("ad_campaign_report", "广告活动", "campaigns", ["campaign_name"]),
            ("ad_budget_report", "预算", "budgets", ["campaign_name"]),
            ("ad_target_report", "搜索词投放", "targets", ["target_text"]),
            ("ad_placement_report", "广告位", "placements", ["placement"]),
            ("ad_search_term_report", "搜索词", "search-terms", ["search_term"]),
            ("ad_search_term_share_report", "搜索词展示量份额", "search-term-shares", ["search_term"]),
            ("ad_promoted_product_report", "推广的商品", "promoted-products", ["ad_sku"]),
            ("ad_time_trend_report", "按时间查看效果", "time-trends", ["report_end_date"]),
            ("ad_invalid_traffic_report", "总流量和无效流量", "invalid-traffic", ["campaign_name"]),
            ("ad_purchased_product_report", "已购买商品", "purchased-products", ["purchased_asin"]),
        ]

        XCTAssertEqual(
            AdDataCatalog.reportTypes.map(\.reportType),
            expected.map(\.0),
            "顺序与 Web 下拉一致"
        )
        for (index, item) in expected.enumerated() {
            let type = AdDataCatalog.reportTypes[index]
            XCTAssertEqual(type.reportType, item.0)
            XCTAssertEqual(type.label, item.1)
            XCTAssertEqual(type.endpoint, item.2)
            XCTAssertEqual(type.groupBy, item.3)
        }
    }

    /// 10 个端点路径的拼法（`project_id` 在路径里）+ 哨兵窗口参数。
    func testEndpointPathsAndQueryShape() {
        XCTAssertEqual(
            AdDataCatalog.rawEndpoint(projectID: 7, endpoint: "search-terms"),
            "/internal/ad-data/projects/7/ad-search-terms-raw"
        )
        XCTAssertEqual(
            AdDataCatalog.uploadFilesEndpoint(projectID: 7),
            "/internal/ad-data/projects/7/ad-upload-files"
        )

        let query = AdDataQuery(country: "US")
        XCTAssertEqual(query.parameters["period"], "custom")
        XCTAssertEqual(query.parameters["country"], "US")
        XCTAssertEqual(query.parameters["limit"], "10000")
        XCTAssertEqual(query.parameters["start_date"], "2000-01-01")
        XCTAssertEqual(query.parameters["end_date"], "2100-12-31")
        XCTAssertNil(query.parameters["offset"], "口径 2：不做 offset 翻页")
        XCTAssertNil(query.parameters["order_by"], "排序在客户端做，不发 order_by")
        XCTAssertNil(query.parameters["project_id"], "project_id 在路径里，不在查询串")

        // 空白日期串落到哨兵（JS 的 `'' || '2000-01-01'` 同义）。
        let blank = AdDataQuery(country: "DE", dateFrom: "  ", dateTo: "")
        XCTAssertEqual(blank.parameters["start_date"], AdDataCatalog.sentinelStartDate)
        XCTAssertEqual(blank.parameters["end_date"], AdDataCatalog.sentinelEndDate)

        // 显式日期照原样发出。
        let windowed = AdDataQuery(country: "DE", dateFrom: "2026-08-01", dateTo: "2026-09-12", limit: 500)
        XCTAssertEqual(windowed.parameters["start_date"], "2026-08-01")
        XCTAssertEqual(windowed.parameters["end_date"], "2026-09-12")
        XCTAssertEqual(windowed.parameters["limit"], "500")

        let upload = AdUploadFilesQuery(country: "US")
        XCTAssertEqual(upload.parameters, ["country": "US", "limit": "500"])
    }
}
