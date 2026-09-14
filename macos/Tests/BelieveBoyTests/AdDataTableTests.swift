import BelieveBoyKit
import XCTest

/// 客户端表格流水线（搜索 → 排序 → 翻页）的口径核对。
///
/// 这三步是「搜索框输入 / 点表头 / 翻页」三条交互的全部逻辑，最容易被写成视图里的一堆
/// `onChange` —— 那样口径只能靠肉眼在界面上验。抽成纯函数之后，每条分支在这里钉住，
/// 而且能顺带钉住它**等于** Web（`ad-data-explorer.tsx` 的 `filtered` / `sorted` / `pageRows`）。
final class AdDataTableTests: XCTestCase {
    private let columns: [AdDataColumn] = [
        AdDataColumn("广告活动名称", "campaign_name", .text, width: 200),
        AdDataColumn("花费", "spend", .money, alignment: .trailing),
        AdDataColumn("展示量", "impressions", .int, alignment: .trailing),
        AdDataColumn("报告结束日期", "report_end_date", .date),
    ]

    private func row(
        id: Int,
        name: String,
        spend: Double,
        impressions: Int,
        endDate: String = "2026-09-13"
    ) -> DynamicJSONRow {
        DynamicJSONRow(fields: [
            "id": .number(Double(id)),
            "campaign_name": .string(name),
            "spend": .number(spend),
            "impressions": .number(Double(impressions)),
            "report_end_date": .string(endDate),
        ])
    }

    private var fixtures: [DynamicJSONRow] {
        [
            row(id: 1, name: "M-KW-250C", spend: 9, impressions: 100),
            row(id: 2, name: "Auto-DL18", spend: 10, impressions: 760),
            row(id: 3, name: "自动-TR250E", spend: 2, impressions: 5),
            row(id: 4, name: "auto-dl18", spend: 10, impressions: 30),
        ]
    }

    // MARK: - 搜索

    /// 命中的判据是**格式化后**的单元格文本 —— 所以带千分位的金额要用 `1,000` 搜得到，
    /// 用 `1000` 搜不到（Web 的 `formatAdDataValue(...).includes(q)` 就是这个语义）。
    func testSearchMatchesFormattedCellText() {
        let rows = [
            row(id: 1, name: "A", spend: 1000, impressions: 10),
            row(id: 2, name: "B", spend: 25, impressions: 20),
        ]

        XCTAssertEqual(
            AdDataTablePipeline.search(rows, columns: columns, query: "1,000").count,
            1,
            "金额格式化后是 $1,000.00，用带千分位的串搜得到"
        )
        XCTAssertTrue(
            AdDataTablePipeline.search(rows, columns: columns, query: "1000").isEmpty,
            "用未格式化的串搜不到（两端口径一致：搜的是单元格文本）"
        )
        XCTAssertEqual(
            AdDataTablePipeline.search(rows, columns: columns, query: "$1,000.00").count,
            1
        )
    }

    func testSearchIsCaseInsensitiveAndTrimmed() {
        XCTAssertEqual(
            AdDataTablePipeline.search(fixtures, columns: columns, query: "  AUTO-DL18 ").count,
            2,
            "大小写不敏感 + 首尾空白忽略（两条 auto-dl18 / Auto-DL18）"
        )
        XCTAssertEqual(
            AdDataTablePipeline.search(fixtures, columns: columns, query: "自动").count,
            1,
            "中文同样按子串命中"
        )
    }

    func testBlankSearchReturnsEveryRowUnchanged() {
        XCTAssertEqual(AdDataTablePipeline.search(fixtures, columns: columns, query: "").count, 4)
        XCTAssertEqual(AdDataTablePipeline.search(fixtures, columns: columns, query: "   ").count, 4)
        XCTAssertEqual(
            AdDataTablePipeline.search(fixtures, columns: [], query: "x").count,
            4,
            "没有列定义时不把整表滤空（Web 的 `!displayColumns.length` 早退同义）"
        )
    }

    // MARK: - 排序

    /// 数值列按**数值**排（不是按字符串）：9 < 10，而字符串序会是 "10" < "9"。
    func testNumericColumnSortsByValueNotText() {
        let sorted = AdDataTablePipeline.sort(
            fixtures,
            columns: columns,
            sort: AdDataSort(key: "spend", direction: .ascending)
        )

        XCTAssertEqual(sorted.map { $0.number("spend") ?? 0 }, [2, 9, 10, 10])

        let descending = AdDataTablePipeline.sort(
            fixtures,
            columns: columns,
            sort: AdDataSort(key: "spend", direction: .descending)
        )
        XCTAssertEqual(descending.map { $0.number("spend") ?? 0 }, [10, 10, 9, 2])
    }

    func testTextColumnSortsLexically() {
        let sorted = AdDataTablePipeline.sort(
            fixtures,
            columns: columns,
            sort: AdDataSort(key: "campaign_name", direction: .ascending)
        )
        XCTAssertEqual(sorted.first?.string("campaign_name"), "Auto-DL18")
    }

    /// 同值必须**稳定**（保持原序）—— Web 的 `Array.prototype.sort` 自 ES2019 起是稳定排序，
    /// 不稳定的话「点两下同一个表头」会得到与点一下不同的行序。
    func testEqualKeysKeepOriginalOrder() {
        let sorted = AdDataTablePipeline.sort(
            fixtures,
            columns: columns,
            sort: AdDataSort(key: "spend", direction: .descending)
        )
        let ids = sorted.map { $0.int("id") ?? 0 }

        XCTAssertEqual(ids, [2, 4, 1, 3], "两条 spend=10 保持 id 2→4 的原序")
    }

    /// 换了报表类型后旧的排序键不存在 → 原序返回（Web 的 `displayColumns.find(...)` 落空同义）。
    func testUnknownSortKeyLeavesOrderUntouched() {
        let sorted = AdDataTablePipeline.sort(
            fixtures,
            columns: columns,
            sort: AdDataSort(key: "not_a_column", direction: .ascending)
        )
        XCTAssertEqual(sorted.map { $0.int("id") ?? 0 }, [1, 2, 3, 4])
    }

    func testSortStateTogglesLikeWeb() {
        var sort = AdDataSort(key: "spend")
        XCTAssertEqual(sort.direction, .ascending)

        sort = sort.toggling(key: "spend")
        XCTAssertEqual(sort.direction, .descending, "同列 → 反向")

        sort = sort.toggling(key: "impressions")
        XCTAssertEqual(sort.key, "impressions")
        XCTAssertEqual(sort.direction, .ascending, "换列 → 升序")

        XCTAssertEqual(AdDataSort.Direction.ascending.symbolName, "arrow.up")
        XCTAssertEqual(AdDataSort.Direction.descending.symbolName, "arrow.down")
    }

    // MARK: - 翻页

    func testPagingSlicesIntoSortedRows() {
        let rows = (1...250).map { row(id: $0, name: "C\($0)", spend: Double($0), impressions: $0) }

        let first = AdDataTablePipeline.page(rows, page: 1, pageSize: 100, columns: columns)
        XCTAssertEqual(first.rows.count, 100)
        XCTAssertEqual(first.totalPages, 3)
        XCTAssertEqual(first.page, 1)
        XCTAssertEqual(first.pageStart, 1)
        XCTAssertEqual(first.pageEnd, 100)
        XCTAssertEqual(first.filteredCount, 250)
        XCTAssertEqual(first.rangeText, "第 1-100 / 共 250 行")

        let last = AdDataTablePipeline.page(rows, page: 3, pageSize: 100, columns: columns)
        XCTAssertEqual(last.rows.count, 50)
        XCTAssertEqual(last.pageStart, 201)
        XCTAssertEqual(last.pageEnd, 250)
        XCTAssertEqual(last.rangeText, "第 201-250 / 共 250 行")
    }

    /// 越界页夹回最后一页（Web 的 `safePage = Math.min(page, totalPages)`）。
    func testOutOfRangePageIsClamped() {
        let rows = (1...30).map { row(id: $0, name: "C\($0)", spend: 1, impressions: 1) }

        let clamped = AdDataTablePipeline.page(rows, page: 99, pageSize: 100, columns: columns)
        XCTAssertEqual(clamped.page, 1)
        XCTAssertEqual(clamped.totalPages, 1)
        XCTAssertEqual(clamped.rows.count, 30)

        let tooSmall = AdDataTablePipeline.page(rows, page: 0, pageSize: 10, columns: columns)
        XCTAssertEqual(tooSmall.page, 1, "0 或负数夹到第一页")
    }

    func testEmptyRowsProduceAnEmptyPage() {
        let page = AdDataTablePipeline.page([], page: 2, pageSize: 100, columns: columns)
        XCTAssertTrue(page.isEmpty)
        XCTAssertEqual(page.totalPages, 1)
        XCTAssertEqual(page.page, 1)
        XCTAssertEqual(page.rangeText, "共 0 行")
        XCTAssertTrue(page.rows.isEmpty)
    }

    /// 行 id 取后端原始行的 `id`（展开态按它记，翻页 / 排序后不串行）；缺失时退回页内序号。
    func testPageRowsCarryBackendRowIDsWithFallback() {
        let rows = [
            row(id: 7465, name: "A", spend: 1, impressions: 1),
            DynamicJSONRow(fields: ["campaign_name": .string("B"), "spend": .number(2)]),
        ]

        let page = AdDataTablePipeline.page(rows, page: 1, pageSize: 100, columns: columns)
        XCTAssertEqual(page.rows.map(\.id), [7465, 1], "缺失 id 的行退回 0-based 页内序号")
    }

    // MARK: - 组合

    func testResolveAppliesSearchThenSortThenPaging() {
        let rows = (1...220).map { row(id: $0, name: "C\($0)", spend: Double(221 - $0), impressions: $0) }

        let page = AdDataTablePipeline.resolve(
            rows: rows,
            columns: columns,
            search: "C2",
            sort: AdDataSort(key: "spend", direction: .ascending),
            page: 1,
            pageSize: 5
        )

        // 「C2」命中 C2 / C20-C29 / C200-C220 共 32 行（实测），按 spend 升序 = 按 id 降序，
        // 故第一页是 220 起的 5 行。
        XCTAssertEqual(page.filteredCount, 32)
        XCTAssertEqual(page.totalPages, 7)
        XCTAssertEqual(page.rows.map(\.id), [220, 219, 218, 217, 216])
    }

    /// 搜不到东西时给的是一个空页（界面据此显示「本页 N 行里没有匹配…」而不是空表）。
    func testResolveWithNoMatchesReturnsEmptyPage() {
        let page = AdDataTablePipeline.resolve(
            rows: fixtures,
            columns: columns,
            search: "不存在的串",
            sort: nil,
            page: 1,
            pageSize: 100
        )
        XCTAssertTrue(page.isEmpty)
        XCTAssertEqual(page.filteredCount, 0)
    }
}
