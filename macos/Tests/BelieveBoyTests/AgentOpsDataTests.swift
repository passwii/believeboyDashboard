import BelieveBoyKit
import XCTest

/// 真实响应快照 → 矩阵的派生口径（`AgentOpsFixtures` 的四份实测响应）。
///
/// 这一层要钉住的都是「与 Web 同源同值」的判定点：
/// - 注册表补全：窗口内没调用的域显示占位「—」而**不是** 0；
/// - 未知 code（后端上线了新域、注册表还没跟上）整条忽略，不新增行；
/// - 今日产出只映射到那 5 个产出域，其余列恒为占位；
/// - 巡检的读写两侧（`platform_inspection` / `account_health`）共用同一格，
///   报表状态与报表上传同理 —— 少映射一个域就是少一格数字。
final class AgentOpsDataTests: XCTestCase {
    private let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        // 必须与 `APIClient` 的解码策略一致（`convertFromSnakeCase`）——
        // 这也是为什么快照用后端原样字段名，而不是先手工转成 camelCase。
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }()

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try decoder.decode(T.self, from: Data(json.utf8))
    }

    // MARK: - 业务域活动

    func testDomainSummaryFixtureDecodesRealPayload() throws {
        let response = try decode(DomainSummaryResponse.self, AgentOpsFixtures.domainSummary)

        XCTAssertEqual(response.windowDays, 7)
        XCTAssertEqual(response.activityItems.count, 8, "实测 8 个域在 7 天窗口内有调用")

        let shipments = try XCTUnwrap(response.activityItems.first { $0.domain == "shipments" })
        XCTAssertEqual(shipments.calls7D, 353)
        XCTAssertEqual(shipments.writes7D, 34)
        XCTAssertEqual(shipments.errors7D, 38)
        XCTAssertEqual(shipments.calls24H, 0)
        // 6 位小数秒 + `+08:00`：原样保留字符串，由格式化层解析（解成 Date 会整条失败）。
        XCTAssertEqual(shipments.lastActiveAt, "2026-09-11T18:31:32.647904+08:00")
    }

    /// 注册表补全：17 行里 8 行有活动，其余 9 行 `activity == nil`（占位「—」）。
    func testMatrixFillsRegistryAndLeavesInactiveDomainsBlank() throws {
        let response = try decode(DomainSummaryResponse.self, AgentOpsFixtures.domainSummary)
        let rows = AgentOverviewBuilder.rows(activity: response.activityItems)

        XCTAssertEqual(rows.count, 17)
        XCTAssertEqual(rows.filter { $0.activity != nil }.count, 8)
        XCTAssertEqual(rows.filter { $0.activity == nil }.count, 9)

        let inactive = try XCTUnwrap(rows.first { $0.domain.code == "ad_analysis" })
        XCTAssertNil(inactive.activity, "窗口内没调用过的域必须没有活动条目")
        XCTAssertNil(
            inactive.activity?.calls7D,
            "缺位要显示占位「—」，不能显示 0（0 会被读成「用了但没用几次」）"
        )
    }

    /// 后端可能返回注册表里没有的 code：忽略该条目，不新增行（Web `summary?.[code]` 落空）。
    func testUnknownDomainCodeIsIgnored() throws {
        let json = """
        {"generated_at":"2026-09-14T08:31:33.689918Z","window_days":7,"items":[
          {"domain":"shipments","calls_24h":0,"calls_7d":5,"writes_24h":0,"writes_7d":0,"errors_7d":0,"last_active_at":null},
          {"domain":"brand_new_domain","calls_24h":0,"calls_7d":9,"writes_24h":0,"writes_7d":0,"errors_7d":0,"last_active_at":null}
        ]}
        """
        let response = try decode(DomainSummaryResponse.self, json)
        let rows = AgentOverviewBuilder.rows(activity: response.activityItems)

        XCTAssertEqual(rows.count, 17, "未知 code 不得新增行")
        XCTAssertFalse(rows.contains { $0.domain.code == "brand_new_domain" })
        XCTAssertEqual(rows.filter { $0.activity != nil }.count, 1)
    }

    /// `items: null` / 缺字段 → 空矩阵，而不是解码失败（Web 同口径容错）。
    func testDomainSummaryToleratesMissingItems() throws {
        let response = try decode(DomainSummaryResponse.self, #"{"generated_at":null,"window_days":7,"items":null}"#)
        XCTAssertTrue(response.activityItems.isEmpty)
        XCTAssertNil(response.generatedAt)

        let rows = AgentOverviewBuilder.rows(activity: response.activityItems)
        XCTAssertEqual(rows.count, 17, "空窗口也要给出完整注册表行（全占位）")
    }

    // MARK: - 今日产出

    func testComplaintProductionWithRunShowsPendingCount() throws {
        let response = try decode(ComplaintOverviewResponse.self, AgentOpsFixtures.complaintsWithRun)
        let production = response.production

        XCTAssertTrue(production.hasRun)
        XCTAssertEqual(production.needsReply, 1)
        XCTAssertEqual(production.displayText, "待回复 1")
    }

    func testComplaintProductionWithoutRunIsPlaceholder() throws {
        let response = try decode(ComplaintOverviewResponse.self, AgentOpsFixtures.complaintsWithoutRun)
        let production = response.production

        XCTAssertFalse(production.hasRun, "没有巡检 run 的那天不算有产出")
        XCTAssertNil(production.displayText, "无 run → 占位「—」")
    }

    /// 快照证明「有 run」的唯一可用信号是 `projects`（Web 读的是已废弃的 `shops`）。
    ///
    /// 这条断言同时钉住一个**跨端已知差异**：Web 的 `parseComplaintsOverview` 读
    /// `payload.shops`，而后端在 `shop_id → project_id` 重构后只返回 `projects`
    /// （`OverviewResponse` 里没有 `shops` 字段），所以 Web 那一列恒为「—」。
    /// 桌面端按后端真实语义（`projects` 非空 = 有 run）实现，取样日会显示出值。
    /// 这是一条**已被记录在案的 Web 侧待修项**，不是桌面端的口径漂移。
    func testComplaintPayloadExposesProjectsNotShops() throws {
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(AgentOpsFixtures.complaintsWithRun.utf8)) as? [String: Any]
        )
        XCTAssertNotNil(object["projects"])
        XCTAssertNil(object["shops"], "后端响应里没有 shops —— Web 读它必然落空")
    }

    func testInspectionProductionFromRealPeriodAndOverview() throws {
        let period = try decode(InspectionPeriodResponse.self, AgentOpsFixtures.currentInspectionPeriod)
        let overview = try decode(InspectionOverviewResponse.self, AgentOpsFixtures.inspectionOverview)

        let production = InspectionProduction(
            submitted: overview.submittedCount,
            total: overview.totalProjects,
            weekStart: period.weekStart,
            weekEnd: period.weekEnd
        )

        XCTAssertEqual(period.id, 17)
        XCTAssertEqual(production.submitted, 0)
        XCTAssertEqual(production.total, 10)
        XCTAssertEqual(production.displayText, "0/10 报告")
        XCTAssertEqual(production.weekStart, "2026-09-14")
    }

    /// `total_projects` / `submitted_count` 缺一个 → 占位（Web 要求两者都非 null）。
    func testInspectionProductionNeedsBothCounts() {
        XCTAssertNil(InspectionProduction(submitted: nil, total: 10).displayText)
        XCTAssertNil(InspectionProduction(submitted: 0, total: nil).displayText)
        XCTAssertEqual(InspectionProduction(submitted: 0, total: 0).displayText, "0/0 报告")
    }

    func testReportCompletionAggregatesRealMatrix() throws {
        let response = try decode(ReportStatusResponse.self, AgentOpsFixtures.reportStatus)
        let completion = ReportUploadCompletion(items: response.items)

        XCTAssertEqual(completion.total, AgentOpsFixtures.reportStatusTotal)
        XCTAssertEqual(completion.uploaded, AgentOpsFixtures.reportStatusUploaded)
        XCTAssertEqual(completion.total, 150, "10 个项目 × 15 类报表")
        XCTAssertEqual(completion.uploaded, 134)
        XCTAssertEqual(completion.missing, 16)
        XCTAssertEqual(completion.displayText, "134/150 报表")
    }

    /// 只有 `is_uploaded == true` 计入已上传（`null` / 缺字段都不算，Web 是 `=== true`）。
    func testReportCompletionCountsOnlyExplicitTrue() {
        let items: [ReportStatusResponse.Item] = [
            .init(statuses: [
                .init(isUploaded: true),
                .init(isUploaded: false),
                .init(isUploaded: nil),
            ]),
            // `statuses` 缺失 → 0 个 cell（Web 同口径容错）
            .init(statuses: nil),
        ]
        let completion = ReportUploadCompletion(items: items)

        XCTAssertEqual(completion.uploaded, 1)
        XCTAssertEqual(completion.total, 3)
    }

    // MARK: - 矩阵装配（今日产出映射）

    func testProductionColumnMapsOnlyProduceDomains() throws {
        let summary = try decode(DomainSummaryResponse.self, AgentOpsFixtures.domainSummary)
        let complaints = try decode(ComplaintOverviewResponse.self, AgentOpsFixtures.complaintsWithRun).production
        let overview = try decode(InspectionOverviewResponse.self, AgentOpsFixtures.inspectionOverview)
        let inspections = InspectionProduction(
            submitted: overview.submittedCount,
            total: overview.totalProjects
        )
        let reports = ReportUploadCompletion(
            items: try decode(ReportStatusResponse.self, AgentOpsFixtures.reportStatus).items
        )

        let rows = AgentOverviewBuilder.rows(
            activity: summary.activityItems,
            complaints: complaints,
            inspections: inspections,
            reports: reports
        )
        let production = Dictionary(uniqueKeysWithValues: rows.map { ($0.domain.code, $0.production) })

        XCTAssertEqual(production["complaint_center"], "待回复 1")
        XCTAssertEqual(production["platform_inspection"], "0/10 报告", "巡检读侧共用同一格")
        XCTAssertEqual(production["account_health"], "0/10 报告")
        XCTAssertEqual(production["report_upload"], "134/150 报表")
        XCTAssertEqual(production["report_upload_status"], "134/150 报表")
        XCTAssertNil(production["sales"] ?? nil)
        XCTAssertNil(production["finance_profit"] ?? nil)
        XCTAssertEqual(
            rows.filter { $0.production != nil }.count,
            5,
            "只有 5 个产出域有今日产出，其余 12 行恒为占位"
        )
    }

    /// 行序与「活动域数字」的联合校验：产出域置顶不影响运行时列的取值来源。
    func testRowsShipmentValuesAndOrdering() throws {
        let summary = try decode(DomainSummaryResponse.self, AgentOpsFixtures.domainSummary)
        let rows = AgentOverviewBuilder.rows(activity: summary.activityItems)

        XCTAssertEqual(rows.first?.domain.code, "complaint_center")
        XCTAssertEqual(rows.map(\.domain.code), AgentDomainCatalog.orderedDomains().map(\.code))

        let shipments = try XCTUnwrap(rows.first { $0.domain.code == "shipments" })
        XCTAssertEqual(shipments.activity?.calls7D, 353)
        XCTAssertEqual(
            AgentOpsFormatting.errorRateText(
                errors7d: shipments.activity?.errors7D ?? 0,
                calls7d: shipments.activity?.calls7D ?? 0
            ),
            "11%"
        )
    }

    /// 注入自定义注册表时行数随之变化（S5 搬新域时的扩展点）。
    func testRowsRespectInjectedRegistry() throws {
        let response = try decode(DomainSummaryResponse.self, AgentOpsFixtures.domainSummary)
        let subset = AgentDomainCatalog.domains.filter { $0.code == "shipments" }

        let rows = AgentOverviewBuilder.rows(activity: response.activityItems, domains: subset)

        XCTAssertEqual(rows.map(\.domain.code), ["shipments"])
        XCTAssertEqual(rows.first?.activity?.calls7D, 353)
    }
}
