import BelieveBoyKit
import XCTest

/// 格式化与列定义：两端「同一个数显示成同一串文本」的判定点。
///
/// 这些断言全部针对 Web 的格式化口径（`toFixed(2)` / `toLocaleString('zh-CN')` /
/// `(x * 100).toFixed(2)%`），并且**刻意不走 `NumberFormatter`** —— 后者的千分位与
/// 小数点跟随系统区域，开发机换成 `de_DE` 就会输出 `1.234,56`，两端口径立刻分叉。
final class AdAnalysisFormattingTests: XCTestCase {
    // MARK: - 基础格式化

    func testPlainNumberDropsFractionForWholeNumbers() {
        XCTAssertEqual(AdAnalysisFormatting.plainNumber(48), "48")
        XCTAssertEqual(AdAnalysisFormatting.plainNumber(0), "0")
        XCTAssertEqual(AdAnalysisFormatting.plainNumber(0.3434), "0.3434")
        XCTAssertEqual(AdAnalysisFormatting.plainNumber(1468.65), "1468.65")
    }

    func testMoneyAlwaysTwoDecimalsWithoutGrouping() {
        XCTAssertEqual(AdAnalysisFormatting.money(32.67), "$32.67")
        XCTAssertEqual(AdAnalysisFormatting.money(0), "$0.00")
        XCTAssertEqual(AdAnalysisFormatting.money(1468.65), "$1468.65")
    }

    func testMoneyGroupedInsertsThousandsSeparators() {
        XCTAssertEqual(AdAnalysisFormatting.moneyGrouped(6872.17), "$6,872.17")
        XCTAssertEqual(AdAnalysisFormatting.moneyGrouped(999.9), "$999.90")
        XCTAssertEqual(AdAnalysisFormatting.moneyGrouped(1234567.891), "$1,234,567.89")
        XCTAssertEqual(AdAnalysisFormatting.moneyGrouped(-1234.5), "$-1,234.50")
    }

    func testPercentIsRatioTimesHundred() {
        XCTAssertEqual(AdAnalysisFormatting.percent(0.3434), "34.34%")
        XCTAssertEqual(AdAnalysisFormatting.percent(0.0057), "0.57%")
        XCTAssertEqual(AdAnalysisFormatting.percent(1), "100.00%")
        XCTAssertEqual(AdAnalysisFormatting.percent(0), "0.00%")
    }

    // MARK: - 行取值 + 占位

    func testCellFormatsAndPlaceholders() throws {
        let row = AdAnalysisRow(fields: [
            "spend": .number(1468.65),
            "sales_7d": .number(0),
            "orders_7d": .number(3),
            "acos": .number(0.3434),
            "zero_ratio": .number(0),
            "rank": .number(0),
            "roas": .number(1.7273),
            "missed_sales_min": .number(0),
            "missed_sales_max": .number(177.85),
            "empty_text": .string("   "),
            "text": .string("自动投放"),
        ])

        XCTAssertEqual(AdAnalysisFormatting.text(of: row, key: "spend", format: .money), "$1468.65")
        XCTAssertEqual(AdAnalysisFormatting.text(of: row, key: "spend", format: .moneyGrouped), "$1,468.65")
        XCTAssertEqual(AdAnalysisFormatting.text(of: row, key: "orders_7d", format: .integer), "3")
        XCTAssertEqual(AdAnalysisFormatting.text(of: row, key: "acos", format: .percent), "34.34%")
        XCTAssertEqual(AdAnalysisFormatting.text(of: row, key: "roas", format: .decimal2), "1.73")
        XCTAssertEqual(AdAnalysisFormatting.text(of: row, key: "rank", format: .rank), "-")
        XCTAssertEqual(AdAnalysisFormatting.text(of: row, key: "text", format: .text), "自动投放")

        // 0 / 缺位 → 占位「—」（**不是 0**，与 Web 的 `> 0 ? … : —` 同口径）。
        XCTAssertEqual(AdAnalysisFormatting.text(of: row, key: "sales_7d", format: .moneyOrDash), "—")
        XCTAssertEqual(AdAnalysisFormatting.text(of: row, key: "sales_7d", format: .moneyGroupedOrDash), "—")
        XCTAssertEqual(AdAnalysisFormatting.text(of: row, key: "zero_ratio", format: .percentOrDash), "—")
        XCTAssertEqual(AdAnalysisFormatting.text(of: row, key: "missing_key", format: .integerOrDash), "—")
        XCTAssertEqual(AdAnalysisFormatting.text(of: row, key: "missing_key", format: .money), "—")
        XCTAssertEqual(AdAnalysisFormatting.text(of: row, key: "empty_text", format: .text), "—")
        XCTAssertEqual(
            AdAnalysisFormatting.text(of: row, key: "missed_sales_min", format: .moneyRange(until: "missed_sales_max")),
            "$0.00 - $177.85"
        )
        XCTAssertEqual(
            AdAnalysisFormatting.text(of: row, key: "missing_key", format: .moneyRange(until: "missing_key")),
            "—"
        )
    }

    /// 值类型容错：后端偶尔把数字写成字符串（Excel 导入链路的遗留），不要退化成占位。
    func testStringEncodedNumbersStillFormat() {
        let row = AdAnalysisRow(fields: ["spend": .string("1468.65"), "clicks": .string("47")])
        XCTAssertEqual(AdAnalysisFormatting.text(of: row, key: "spend", format: .money), "$1468.65")
        XCTAssertEqual(AdAnalysisFormatting.text(of: row, key: "clicks", format: .integer), "47")
    }

    // MARK: - 日期（纯日期串）

    func testDayStringRoundTrip() throws {
        var calendar = Calendar(identifier: .gregorian)
        let timeZone = TimeZone(identifier: "UTC")!
        calendar.timeZone = timeZone
        let date = try XCTUnwrap(
            calendar.date(from: DateComponents(year: 2026, month: 8, day: 1, hour: 12))
        )

        XCTAssertEqual(AdAnalysisFormatting.dayString(date, timeZone: timeZone), "2026-08-01")
        let parsed = try XCTUnwrap(
            AdAnalysisFormatting.date(fromDayString: "2026-08-01", timeZone: timeZone)
        )
        XCTAssertEqual(AdAnalysisFormatting.dayString(parsed, timeZone: timeZone), "2026-08-01")
        XCTAssertNil(AdAnalysisFormatting.date(fromDayString: "2026-8"))
        XCTAssertNil(AdAnalysisFormatting.date(fromDayString: "not-a-date"))
    }

    /// 日期区间打开时的初值：今天往前 29 天（30 天窗口）。
    func testDayStringDaysFromTodayUsesCalendarArithmetic() throws {
        let timeZone = TimeZone(identifier: "UTC")!
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let now = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 3, day: 5)))

        XCTAssertEqual(
            AdAnalysisFormatting.dayString(daysFromToday: -29, now: now, timeZone: timeZone),
            "2026-02-04",
            "跨月要按日历算，不能按「减 29*86400 秒」"
        )
        XCTAssertEqual(
            AdAnalysisFormatting.dayString(daysFromToday: 0, now: now, timeZone: timeZone),
            "2026-03-05"
        )
    }

    // MARK: - 列定义

    /// 列标题与顺序对齐 Web 桌面表格；数值列右对齐。
    func testColumnDefinitionsFollowWebTables() {
        XCTAssertEqual(
            AdAnalysisColumns.columns(forTabKey: "campaigns").map(\.title),
            ["活动", "状态", "类型", "Grade", "CTR", "预算在线", "Spend", "Sales", "ACOS", "预算缺口", "错失销售", "关联销售", "下一步"]
        )
        XCTAssertEqual(
            AdAnalysisColumns.columns(forTabKey: "purchased-products").map(\.title),
            ["关联 ASIN", "广告 SKU", "动作", "活动数", "Units", "Orders", "Sales"]
        )
        XCTAssertEqual(
            AdAnalysisColumns.columns(forTabKey: "time-trend").map(\.title),
            ["日期", "Clicks", "Spend", "CPC", "Running Spend"]
        )
        XCTAssertEqual(
            AdAnalysisColumns.columns(forTabKey: "traffic-quality").map(\.title),
            ["活动", "状态", "风险等级", "总曝光", "无效曝光", "无效曝光率", "总点击", "无效点击", "无效点击率", "下一步"]
        )
        for tabKey in ["overview", "time-trend", "campaigns", "products", "purchased-products",
                       "search-terms", "targets", "placements", "budget", "traffic-quality"] {
            for column in AdAnalysisColumns.columns(forTabKey: tabKey) {
                XCTAssertGreaterThan(column.width, 0, "\(tabKey).\(column.key): 列宽")
                if column.format == .text {
                    XCTAssertEqual(column.alignment, .leading, "\(tabKey).\(column.key): 文本列不右对齐")
                }
            }
        }
        XCTAssertTrue(AdAnalysisColumns.columns(forTabKey: "unknown-tab").isEmpty)
    }

    /// 语义着色规则：ACoS 列用于涨跌着色，风险等级列用于分档着色。
    func testToneRulesAreWiredToTheRightColumns() {
        func column(_ tabKey: String, _ key: String) -> AdAnalysisColumn? {
            AdAnalysisColumns.columns(forTabKey: tabKey).first { $0.key == key }
        }

        XCTAssertEqual(column("campaigns", "acos")?.tone, .acos)
        XCTAssertEqual(column("products", "acos")?.tone, .acos)
        XCTAssertEqual(column("search-terms", "acos")?.tone, .acos)
        XCTAssertEqual(column("traffic-quality", "risk_level")?.tone, .risk)
        XCTAssertEqual(column("campaigns", "status")?.tone, .muted)
        XCTAssertEqual(column("campaigns", "spend")?.tone, .plain)
    }

    // MARK: - 真实快照里的单元格文本

    /// 用真实快照断言单元格文本（数值 + 占位 + 千分位差异逐条对齐 Web）。
    func testCellTextFromRealSnapshots() throws {
        let campaigns = try AdAnalysisFixtures.payload(forTabKey: "campaigns")
        let campaign = try XCTUnwrap(campaigns.items.first)
        let campaignColumns = AdAnalysisColumns.columns(forTabKey: "campaigns")
        func text(_ key: String) throws -> String {
            let column = try XCTUnwrap(campaignColumns.first { $0.key == key })
            return column.text(in: campaign)
        }
        // Web 表格用 `toFixed(2)`：**没有**千分位（与「总览」明细的 toLocaleString 不同）。
        XCTAssertEqual(try text("spend"), "$1468.65")
        XCTAssertEqual(try text("sales_7d"), "$4276.93")
        XCTAssertEqual(try text("acos"), "34.34%")
        XCTAssertEqual(try text("ctr"), "0.55%")
        XCTAssertEqual(try text("budget_utilization_rate"), "0.00%")
        XCTAssertEqual(try text("budget_gap"), "$78.88")
        XCTAssertEqual(try text("next_action"), "稳定放量")
        XCTAssertEqual(try text("grade"), "B")

        let overview = try AdAnalysisFixtures.payload(forTabKey: "overview")
        let gridRow = try XCTUnwrap(AdAnalysisOverviewGrid.rows(from: overview).first)
        let gridColumns = AdAnalysisColumns.overview
        func gridText(_ key: String) throws -> String {
            try XCTUnwrap(gridColumns.first { $0.key == key }).text(in: gridRow)
        }
        // 总览明细用 `toLocaleString('zh-CN')`：有千分位；0/缺位显示占位。
        XCTAssertEqual(try gridText("name"), "A-Close 250NM")
        XCTAssertEqual(try gridText("spend"), "$32.67")
        XCTAssertEqual(try gridText("sales_7d"), "—", "该行 sales_7d == 0 → 占位")
        XCTAssertEqual(try gridText("orders_7d"), "—")

        let searchTerms = try AdAnalysisFixtures.payload(forTabKey: "search-terms")
        let term = try XCTUnwrap(searchTerms.items.first)
        let termColumns = AdAnalysisColumns.columns(forTabKey: "search-terms")
        let share = try XCTUnwrap(termColumns.first { $0.key == "impression_share" })
        let rank = try XCTUnwrap(termColumns.first { $0.key == "impression_rank" })
        XCTAssertEqual(share.text(in: term), "0.00%")
        XCTAssertEqual(rank.text(in: term), "-", "排名 0 → `-`（Web `rank || '-'`）")

        let budget = try AdAnalysisFixtures.payload(forTabKey: "budget")
        let budgetRow = try XCTUnwrap(budget.items.first)
        let missedSales = try XCTUnwrap(
            AdAnalysisColumns.columns(forTabKey: "budget").first { $0.key == "missed_sales_min" }
        )
        XCTAssertEqual(missedSales.text(in: budgetRow), "$0.00 - $0.00")
    }

    /// 「总览」明细的金额列用带千分位的格式（Web `toLocaleString('zh-CN')`）—— 这一批的
    /// 真实数据里头部活动花费都 < 1000，所以分组效果要用一条造出来的行才能看到。
    func testOverviewDetailMoneyUsesGroupedFormat() throws {
        let column = try XCTUnwrap(AdAnalysisColumns.overview.first { $0.key == "spend" })
        XCTAssertEqual(column.format, .moneyGroupedOrDash)
        XCTAssertEqual(
            column.text(in: AdAnalysisRow(fields: ["spend": .number(1234.5)])),
            "$1,234.50"
        )

        // 快照里的真实值：不带千分位时与 Web 的 `toFixed(2)` 一致。
        let overview = try AdAnalysisFixtures.payload(forTabKey: "overview")
        let first = try XCTUnwrap(AdAnalysisOverviewGrid.rows(from: overview).first)
        XCTAssertEqual(column.text(in: first), "$32.67")
    }
}
