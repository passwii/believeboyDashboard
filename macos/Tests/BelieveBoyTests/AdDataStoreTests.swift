import BelieveBoyKit
import Foundation
import XCTest

@testable import BelieveBoyUI

/// 可编排的广告数据源假实现：项目列表 / 入库文件列表 / 每个端点都能独立设
/// 「成功值 / 失败 / 挂起」。
///
/// 为什么需要它（而不是只打桩 URLProtocol）：本页有四条必须精确控制时序的分支 ——
/// 「切类型 / 改筛选 / 切模块时在跑的请求被取消，且取消不落成错误态」「刷新失败保留旧表」
/// 「入库文件失败不拖垮主表」「在飞请求去重」。前三条都要求**让某个请求永远不返回**，
/// 而 `URLProtocol` 只能在响应里返回内容。
final class ScriptedAdDataProvider: AdDataDataProviding, @unchecked Sendable {
    enum Outcome<Value: Sendable>: Sendable {
        case value(Value)
        /// 抛 `APIError.http`（贴近真实失败形态：非 2xx）。
        case failure(status: Int)
        /// 一直挂起，直到任务被取消 —— 用来观测 loading 中间态与取消行为。
        case hang
    }

    /// 挂起源 / 失败源被取消时的记录器。
    let cancellation = CancellationRecorder()

    private let lock = NSLock()
    private var projectsOutcome: Outcome<[AdProject]>
    private var uploadOutcome: Outcome<[AdUploadFileItem]>
    private var defaultEndpointOutcome: Outcome<AdDataRawPayload>
    private var endpointOutcomes: [String: Outcome<AdDataRawPayload>]
    private var recordedProjectsCalls = 0
    private var recordedUploadCalls = 0
    private var recordedRequests: [(endpoint: String, projectID: Int, query: AdDataQuery)] = []

    init(
        projects: Outcome<[AdProject]> = .value([
            AdProject(id: 1, name: "铨富", country: "US"),
            AdProject(id: 4, name: "玥涵", country: "DE"),
        ]),
        uploadFiles: Outcome<[AdUploadFileItem]> = .value([]),
        defaultEndpoint: Outcome<AdDataRawPayload> = .value(AdDataRawPayload(data: [])),
        endpointOutcomes: [String: Outcome<AdDataRawPayload>] = [:]
    ) {
        self.projectsOutcome = projects
        self.uploadOutcome = uploadFiles
        self.defaultEndpointOutcome = defaultEndpoint
        self.endpointOutcomes = endpointOutcomes
    }

    // MARK: - 编排

    func setProjects(_ outcome: Outcome<[AdProject]>) { withLock { projectsOutcome = outcome } }

    func setUploadFiles(_ outcome: Outcome<[AdUploadFileItem]>) { withLock { uploadOutcome = outcome } }

    func setEndpoint(_ endpoint: String, _ outcome: Outcome<AdDataRawPayload>) {
        withLock { endpointOutcomes[endpoint] = outcome }
    }

    func setDefaultEndpoint(_ outcome: Outcome<AdDataRawPayload>) {
        withLock { defaultEndpointOutcome = outcome }
    }

    // MARK: - 观测

    var projectsCallCount: Int { withLock { recordedProjectsCalls } }
    var uploadFilesCallCount: Int { withLock { recordedUploadCalls } }

    /// 收到的原始行请求（顺序即调用顺序）。
    var requests: [(endpoint: String, projectID: Int, query: AdDataQuery)] { withLock { recordedRequests } }
    var requestedEndpoints: [String] { withLock { recordedRequests.map(\.endpoint) } }

    func query(forEndpoint endpoint: String) -> AdDataQuery? {
        withLock { recordedRequests.first { $0.endpoint == endpoint }?.query }
    }

    // MARK: - AdDataDataProviding

    func projects() async throws -> [AdProject] {
        let outcome = withLock {
            recordedProjectsCalls += 1
            return projectsOutcome
        }
        return try await resolve(outcome)
    }

    func uploadFiles(
        projectID: Int,
        query: AdUploadFilesQuery
    ) async throws -> [AdUploadFileItem] {
        let outcome = withLock {
            recordedUploadCalls += 1
            return uploadOutcome
        }
        return try await resolve(outcome)
    }

    func rawPayload(
        reportType: AdDataReportType,
        projectID: Int,
        query: AdDataQuery
    ) async throws -> AdDataRawPayload {
        let outcome = withLock {
            recordedRequests.append((reportType.endpoint, projectID, query))
            return endpointOutcomes[reportType.endpoint] ?? defaultEndpointOutcome
        }
        return try await resolve(outcome)
    }

    private func resolve<Value: Sendable>(_ outcome: Outcome<Value>) async throws -> Value {
        switch outcome {
        case .value(let value):
            return value
        case .failure(let status):
            let body = "stub failure \(status)"
            if status == 401 || status == 403 {
                throw APIError.unauthorized(status: status, body: body)
            }
            throw APIError.http(status: status, body: body)
        case .hang:
            do {
                try await Task.sleep(nanoseconds: 30_000_000_000)
            } catch {
                cancellation.markCancelled()
                throw error
            }
            throw APIError.transport("stub 挂起源未在取消时退出")
        }
    }

    private func withLock<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}

extension AdUploadFileItem {
    /// 测试用入库文件条目。
    static func fixture(
        reportType: String,
        uploadedAt: String = "2026-09-14T15:37:46.494148+08:00",
        version: Int = 1,
        ingestionStatus: String = "success",
        isCurrent: Bool = true
    ) -> AdUploadFileItem {
        AdUploadFileItem(
            fileID: 1,
            reportType: reportType,
            reportLabel: "标签",
            country: "US",
            periodStartDate: "2026-09-13",
            periodEndDate: "2026-09-13",
            version: version,
            isCurrent: isCurrent,
            ingestionStatus: ingestionStatus,
            rowCountPreview: 10,
            uploadedAt: uploadedAt
        )
    }
}

/// 「广告数据」状态机用例：三态、取消、刷新失败保留旧表、在飞去重、附属信息降级、截断判定。
@MainActor
final class AdDataStoreTests: XCTestCase {
    private let routeID = AdDataCatalog.routeID

    private func makeStore(
        projectID: Int? = 1,
        reportTypeCode: String = AdDataCatalog.defaultReportTypeCode
    ) -> AdDataStore {
        AdDataStore(
            filters: AdFilters(projectID: projectID),
            selectedReportTypeCode: reportTypeCode
        )
    }

    /// 起一个与视图 `.task(id:)` 等价的加载（真并发：后一次加载靠同 key 取消前一次）。
    @discardableResult
    private func startLoad(
        _ store: AdDataStore,
        provider: AdDataDataProviding,
        scope: ModuleTaskScope
    ) -> Task<Void, Never> {
        Task { @MainActor in
            await store.load(using: provider, scope: scope, key: routeID)
        }
    }

    private func waitUntil(timeout: TimeInterval = 3, _ condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        XCTFail("等待条件超时（\(timeout)s）")
    }

    private func campaignsPayload() throws -> AdDataRawPayload {
        try AdDataFixtures.payload(forReportTypeCode: "ad_campaign_report")
    }

    private func trendsPayload() throws -> AdDataRawPayload {
        try AdDataFixtures.payload(forReportTypeCode: "ad_time_trend_report")
    }

    // MARK: - 正常装载

    /// 进页：先取项目列表 → 自动选中第一个 → 取默认类型的原始行；查询落哨兵窗口。
    func testLoadsProjectsThenSelectedReportType() async throws {
        let store = makeStore(projectID: nil)
        let provider = ScriptedAdDataProvider(defaultEndpoint: .value(try campaignsPayload()))
        let scope = ModuleTaskScope()

        await store.load(using: provider, scope: scope, key: routeID)

        XCTAssertEqual(provider.projectsCallCount, 1)
        XCTAssertEqual(provider.requestedEndpoints, ["campaigns"], "默认落地「广告活动」")
        XCTAssertEqual(store.filters.projectID, 1, "Web 同口径：进页选中列表第一个项目")
        let query = try XCTUnwrap(provider.query(forEndpoint: "campaigns"))
        XCTAssertEqual(query.country, "US")
        XCTAssertNil(query.dateFrom, "未限定日期 → store 侧是 nil")
        XCTAssertEqual(
            query.parameters["start_date"],
            AdDataCatalog.sentinelStartDate,
            "口径 1：nil 落到哨兵窗口（不是省略参数）"
        )
        XCTAssertEqual(query.parameters["end_date"], AdDataCatalog.sentinelEndDate)
        XCTAssertEqual(query.limit, AdDataCatalog.pageLimit)
        XCTAssertEqual(store.selectedTableState.phase, .loaded)
        XCTAssertEqual(store.contentState, .ready)
        XCTAssertEqual(store.returnedRowCount, 200)
    }

    func testNoProjectsShowsGateWithoutRawRequests() async throws {
        let store = makeStore(projectID: nil)
        let provider = ScriptedAdDataProvider(projects: .value([]))
        let scope = ModuleTaskScope()

        await store.load(using: provider, scope: scope, key: routeID)

        XCTAssertEqual(store.projectGate, .noProjects)
        XCTAssertTrue(provider.requestedEndpoints.isEmpty, "没有可见项目 → 不发原始行请求")
        XCTAssertEqual(store.selectedTableState.phase, .idle)
    }

    func testProjectsFailureBlocksRawRequestsAndCanRetry() async throws {
        let store = makeStore()
        let provider = ScriptedAdDataProvider(
            projects: .failure(status: 500),
            defaultEndpoint: .value(try campaignsPayload())
        )
        let scope = ModuleTaskScope()

        await store.load(using: provider, scope: scope, key: routeID)

        guard case .failed(let message) = store.projectGate else {
            return XCTFail("项目列表失败应落成 failed 闸门，实际 \(store.projectGate)")
        }
        XCTAssertFalse(message.isEmpty)
        XCTAssertTrue(provider.requestedEndpoints.isEmpty)

        provider.setProjects(.value([AdProject(id: 1, name: "铨富")]))
        await store.load(using: provider, scope: scope, key: routeID)

        XCTAssertEqual(store.projectGate, .ready)
        XCTAssertEqual(provider.requestedEndpoints, ["campaigns"])
    }

    // MARK: - 三态

    func testEmptyPayloadIsEmptyState() async throws {
        let store = makeStore()
        let provider = ScriptedAdDataProvider(defaultEndpoint: .value(AdDataRawPayload()))
        let scope = ModuleTaskScope()

        await store.load(using: provider, scope: scope, key: routeID)

        XCTAssertEqual(store.contentState, .empty, "无数据要显示「无数据」，不是 0 也不是错误")
        XCTAssertEqual(store.selectedTableState.phase, .loaded)
        XCTAssertNil(store.failureMessage)
        XCTAssertTrue(store.tablePage.isEmpty)
    }

    func testFailureWithoutDataIsFailedState() async throws {
        let store = makeStore()
        let provider = ScriptedAdDataProvider(defaultEndpoint: .failure(status: 500))
        let scope = ModuleTaskScope()

        await store.load(using: provider, scope: scope, key: routeID)

        XCTAssertNotNil(store.failureMessage)
        XCTAssertEqual(store.contentState, .failed(store.failureMessage ?? ""))
        XCTAssertNil(store.refreshFailure, "没有旧数据时是整页失败，不是「刷新失败」")
        XCTAssertFalse(store.selectedTableState.hasPayload)
    }

    /// 有旧数据时刷新失败：**保留旧表** + 一条黄条，不把可用数据藏起来。
    func testRefreshFailureKeepsPreviousPayload() async throws {
        let store = makeStore()
        let provider = ScriptedAdDataProvider(defaultEndpoint: .value(try campaignsPayload()))
        let scope = ModuleTaskScope()

        await store.load(using: provider, scope: scope, key: routeID)
        let rowCount = store.returnedRowCount
        XCTAssertGreaterThan(rowCount, 0)

        provider.setDefaultEndpoint(.failure(status: 500))
        store.requestRefresh()
        await store.load(using: provider, scope: scope, key: routeID)

        XCTAssertNotNil(store.refreshFailure, "刷新失败要提示")
        XCTAssertEqual(store.selectedTableState.phase, .loaded)
        XCTAssertEqual(store.contentState, .ready, "有旧数据 → 仍是 ready，表格还在")
        XCTAssertEqual(store.returnedRowCount, rowCount, "旧表必须保留")
        XCTAssertEqual(store.tablePage.rows.count, AdDataCatalog.pageSize)
    }

    // MARK: - 取消（不落错误态、不泄漏）

    /// 挂起的请求被取消 → 退回 idle（不是 failed），并且已有数据保留。
    func testCancelledLoadFallsBackToIdleNotFailure() async throws {
        let store = makeStore()
        let provider = ScriptedAdDataProvider(defaultEndpoint: .hang)
        let scope = ModuleTaskScope()

        let task = startLoad(store, provider: provider, scope: scope)
        await waitUntil { store.selectedTableState.phase == .loading }

        scope.cancel(key: routeID)
        await task.value

        XCTAssertEqual(store.selectedTableState.phase, .idle, "取消不是错误")
        XCTAssertNil(store.failureMessage)
        XCTAssertTrue(provider.cancellation.isCancelled, "挂起源应收到取消")
        XCTAssertTrue(scope.isEmpty, "取消后任务作用域应为空（不泄漏 Task）")
    }

    /// 切报表类型：同 key 的新加载会取消上一个类型在跑的请求，且不落成错误态。
    func testSwitchingReportTypeCancelsInFlightRequest() async throws {
        let store = makeStore()
        let provider = ScriptedAdDataProvider(
            defaultEndpoint: .hang,
            endpointOutcomes: ["time-trends": .value(try trendsPayload())]
        )
        let scope = ModuleTaskScope()

        let first = startLoad(store, provider: provider, scope: scope)
        await waitUntil { store.selectedTableState.phase == .loading }

        store.selectReportType(code: "ad_time_trend_report")
        let second = startLoad(store, provider: provider, scope: scope)
        await second.value
        await first.value

        XCTAssertEqual(
            store.state(forReportTypeCode: "ad_campaign_report").phase,
            .idle,
            "被取消的类型退回 idle，不挂错误"
        )
        XCTAssertEqual(store.selectedTableState.phase, .loaded)
        XCTAssertEqual(store.contentState, .ready)
        XCTAssertTrue(provider.cancellation.isCancelled)
    }

    /// 改筛选（站点）：取消在跑请求、用新筛选重发，取消不落错误态。
    func testFilterChangeCancelsInFlightAndUsesNewFilters() async throws {
        let store = makeStore()
        let provider = ScriptedAdDataProvider(defaultEndpoint: .hang)
        let scope = ModuleTaskScope()

        let first = startLoad(store, provider: provider, scope: scope)
        await waitUntil { store.selectedTableState.phase == .loading }

        store.setCountry("DE")
        provider.setDefaultEndpoint(.value(try campaignsPayload()))
        let second = startLoad(store, provider: provider, scope: scope)
        await second.value
        await first.value

        XCTAssertEqual(store.selectedTableState.phase, .loaded)
        XCTAssertEqual(provider.requestedEndpoints, ["campaigns", "campaigns"])
        XCTAssertEqual(provider.requests.last?.query.country, "DE")
        XCTAssertEqual(store.filters.country, "DE")
    }

    /// 切模块（外壳按 route id 取消）：任务作用域清空、不落错误态。
    func testModuleSwitchCancelsAndLeavesNoTask() async throws {
        let store = makeStore()
        let provider = ScriptedAdDataProvider(defaultEndpoint: .hang)
        let scope = ModuleTaskScope()

        let task = startLoad(store, provider: provider, scope: scope)
        await waitUntil { store.selectedTableState.phase == .loading }

        scope.cancel(key: routeID)
        await task.value

        XCTAssertTrue(scope.isEmpty)
        XCTAssertEqual(store.selectedTableState.phase, .idle)
        XCTAssertNil(store.failureMessage)
    }

    // MARK: - 在飞请求去重

    /// 「进页自动选中第一个项目」会让视图的 `.task(id:)` 重跑一次；同一组筛选在飞时不得重发
    /// （否则第二次会把第一次取消掉 → 同一端点发两次、还白等一轮）。
    func testDuplicateLoadWhileInFlightIsNotRefetched() async throws {
        let store = makeStore(projectID: nil)
        let provider = ScriptedAdDataProvider(defaultEndpoint: .hang)
        let scope = ModuleTaskScope()

        let first = startLoad(store, provider: provider, scope: scope)
        await waitUntil { store.selectedTableState.phase == .loading }
        XCTAssertEqual(provider.requestedEndpoints, ["campaigns"])

        // 项目已就绪（第一次加载里已经取到），筛选被自动改成第一个项目 → 视图会再触发一次。
        await waitUntil { store.filters.projectID == 1 }
        let second = startLoad(store, provider: provider, scope: scope)
        await waitUntil { store.selectedTableState.phase == .loading }

        XCTAssertEqual(
            provider.requestedEndpoints,
            ["campaigns"],
            "同一签名在飞时第二次加载直接返回，不重发"
        )

        scope.cancel(key: routeID)
        await first.value
        await second.value
    }

    /// 已加载过的同一组筛选不重复请求（同 S5.1 的「已加载签名」；本批不做 TTL 缓存）。
    func testSameFiltersDoNotRefetch() async throws {
        let store = makeStore()
        let provider = ScriptedAdDataProvider(defaultEndpoint: .value(try campaignsPayload()))
        let scope = ModuleTaskScope()

        await store.load(using: provider, scope: scope, key: routeID)
        await store.load(using: provider, scope: scope, key: routeID)

        XCTAssertEqual(provider.requestedEndpoints, ["campaigns"], "同一签名不重发")

        store.requestRefresh()
        await store.load(using: provider, scope: scope, key: routeID)

        XCTAssertEqual(provider.requestedEndpoints, ["campaigns", "campaigns"], "刷新票号变化 → 重发")
    }

    /// 切回已看过的类型：用保留的 payload，不重发（切走再回来不该重新拉）。
    func testSwitchingBackToLoadedTypeReusesPayload() async throws {
        let store = makeStore()
        let provider = ScriptedAdDataProvider(
            endpointOutcomes: [
                "campaigns": .value(try campaignsPayload()),
                "time-trends": .value(try trendsPayload()),
            ]
        )
        let scope = ModuleTaskScope()

        await store.load(using: provider, scope: scope, key: routeID)
        store.selectReportType(code: "ad_time_trend_report")
        await store.load(using: provider, scope: scope, key: routeID)
        store.selectReportType(code: "ad_campaign_report")
        await store.load(using: provider, scope: scope, key: routeID)

        XCTAssertEqual(provider.requestedEndpoints, ["campaigns", "time-trends"])
        XCTAssertEqual(store.returnedRowCount, 200)
    }

    // MARK: - 入库文件信息（附属信息，口径 3）

    func testUploadFilesFailureDoesNotBlockTable() async throws {
        let store = makeStore()
        let provider = ScriptedAdDataProvider(
            uploadFiles: .failure(status: 500),
            defaultEndpoint: .value(try campaignsPayload())
        )
        let scope = ModuleTaskScope()

        await store.load(using: provider, scope: scope, key: routeID)

        XCTAssertEqual(store.contentState, .ready, "附属信息失败不得拖垮主表")
        XCTAssertEqual(store.returnedRowCount, 200)
        XCTAssertNotNil(store.uploadFiles.failureMessage)
        XCTAssertTrue(store.uploadFilesNote.contains("入库文件信息不可用"))
    }

    /// 同一 (项目, 站点) 只取一次 —— 改日期或切类型不该重取这份元数据。
    func testUploadFilesIsLoadedOncePerProjectAndCountry() async throws {
        let store = makeStore()
        let provider = ScriptedAdDataProvider(
            uploadFiles: .value([.fixture(reportType: "ad_campaign_report")]),
            endpointOutcomes: [
                "campaigns": .value(try campaignsPayload()),
                "time-trends": .value(try trendsPayload()),
            ]
        )
        let scope = ModuleTaskScope()

        await store.load(using: provider, scope: scope, key: routeID)
        store.selectReportType(code: "ad_time_trend_report")
        await store.load(using: provider, scope: scope, key: routeID)
        store.requestRefresh()
        await store.load(using: provider, scope: scope, key: routeID)

        XCTAssertEqual(provider.uploadFilesCallCount, 1)

        store.setCountry("DE")
        await store.load(using: provider, scope: scope, key: routeID)
        XCTAssertEqual(provider.uploadFilesCallCount, 2, "换站点 → 重新取")
    }

    /// 入库文件里**没有**这个类型时，提示要明说可能是列表截断，而不是暗示「没数据」。
    func testUploadFilesNoteTellsTruncationWhenTypeMissing() async throws {
        let store = makeStore()
        let provider = ScriptedAdDataProvider(
            uploadFiles: .value([.fixture(reportType: "ad_budget_report")]),
            defaultEndpoint: .value(try campaignsPayload())
        )
        let scope = ModuleTaskScope()

        await store.load(using: provider, scope: scope, key: routeID)

        XCTAssertTrue(store.uploadFilesNote.contains("不在最近 1 份之内"))
        XCTAssertTrue(store.uploadFilesNote.contains("可能被截断"))
        XCTAssertTrue(store.uploadFilesNote.contains("可用性以本表实际返回行为准"))
    }

    /// 有该类型的入库文件时，提示给出「最近入库 / 版本 / 状态」。
    func testUploadFilesNoteReportsLatestIngestion() async throws {
        let store = makeStore()
        let provider = ScriptedAdDataProvider(
            uploadFiles: .value([.fixture(reportType: "ad_campaign_report", version: 3)]),
            defaultEndpoint: .value(try campaignsPayload())
        )
        let scope = ModuleTaskScope()

        await store.load(using: provider, scope: scope, key: routeID)

        XCTAssertEqual(
            store.uploadFilesNote,
            "入库文件：最近入库 2026-09-14 · v3 · success"
        )
    }

    // MARK: - 截断与页内脏状态

    func testTruncationFlagWhenRowCountHitsLimit() async throws {
        let store = makeStore()
        // 夹具是 200 行，用 200 作 limit 复现「顶到上限」；页面口径 10000 时同一条判断。
        let payload = AdDataRawPayload(
            data: (0..<5).map { DynamicJSONRow(fields: ["campaign_name": .string("C\($0)")]) }
        )
        let provider = ScriptedAdDataProvider(defaultEndpoint: .value(payload))
        let scope = ModuleTaskScope()

        await store.load(using: provider, scope: scope, key: routeID)

        XCTAssertFalse(store.isTruncated, "5 行没顶到 10000 → 完整")
        XCTAssertTrue(store.selectedTableState.hasPayload)
        XCTAssertTrue(
            payload.isTruncated(limit: 5),
            "行数等于 limit 时必须判成「可能被截断」"
        )
    }

    func testSearchAndSortAndPagingState() async throws {
        let store = makeStore()
        let provider = ScriptedAdDataProvider(defaultEndpoint: .value(try campaignsPayload()))
        let scope = ModuleTaskScope()

        await store.load(using: provider, scope: scope, key: routeID)

        XCTAssertEqual(store.pageSize, 100, "口径 5：pageSize=100")
        XCTAssertEqual(store.tablePage.page, 1)
        XCTAssertEqual(store.tablePage.totalPages, 2, "200 行 / 每页 100")
        XCTAssertEqual(store.tablePage.rows.count, 100)

        store.nextPage()
        XCTAssertEqual(store.tablePage.page, 2)
        XCTAssertEqual(store.tablePage.rows.count, 100)
        XCTAssertEqual(store.tablePage.rangeText, "第 101-200 / 共 200 行")

        store.previousPage()
        XCTAssertEqual(store.tablePage.page, 1)

        store.setSearch("Auto-DL18")
        XCTAssertEqual(store.page, 1, "搜索后回到第一页")
        XCTAssertLessThan(store.tablePage.filteredCount, 200)
        XCTAssertEqual(
            store.tablePage.filteredCount,
            20,
            "真实快照里 20 行含 Auto-DL18（同一条广告活动跨多个报表日）"
        )

        store.toggleSort(key: "spend")
        XCTAssertEqual(store.sort, AdDataSort(key: "spend", direction: .ascending))
        store.toggleSort(key: "spend")
        XCTAssertEqual(store.sort, AdDataSort(key: "spend", direction: .descending))

        store.setSearch("")
        XCTAssertEqual(store.tablePage.filteredCount, 200)
    }

    /// 切类型回第一页、收起展开行；搜索词**保留**（Web 的搜索状态是跨类型共享的）。
    func testSwitchingTypeResetsPageAndExpansionButKeepsSearch() async throws {
        let store = makeStore()
        let provider = ScriptedAdDataProvider(
            endpointOutcomes: [
                "campaigns": .value(try campaignsPayload()),
                "time-trends": .value(try trendsPayload()),
            ]
        )
        let scope = ModuleTaskScope()

        await store.load(using: provider, scope: scope, key: routeID)
        store.nextPage()
        let rowID = try XCTUnwrap(store.tablePage.rows.first?.id)
        store.toggleRowExpansion(id: rowID)
        store.setSearch("auto")
        XCTAssertTrue(store.isExpanded(id: rowID))

        store.selectReportType(code: "ad_time_trend_report")

        XCTAssertEqual(store.page, 1)
        XCTAssertFalse(store.isExpanded(id: rowID), "换表要收起展开行")
        XCTAssertEqual(store.search, "auto", "搜索词跨类型保留（与 Web 一致）")
    }

    /// 筛选变化时页码与展开行归位。
    func testFilterChangeResetsTableViewport() async throws {
        let store = makeStore()
        let provider = ScriptedAdDataProvider(defaultEndpoint: .value(try campaignsPayload()))
        let scope = ModuleTaskScope()

        await store.load(using: provider, scope: scope, key: routeID)
        store.nextPage()
        let rowID = try XCTUnwrap(store.tablePage.rows.first?.id)
        store.toggleRowExpansion(id: rowID)

        store.setUsesDateRange(true)
        store.setDateFrom("2026-08-01")
        store.setDateTo("2026-09-12")

        XCTAssertEqual(store.page, 1)
        XCTAssertTrue(store.expandedRowIDs.isEmpty)
        XCTAssertEqual(store.filters.effectiveDateFrom, "2026-08-01")
    }

    /// 关掉日期开关要清空日期值（留着旧的只会让下次打开时突然换区间）。
    func testTurningOffDateRangeClearsDates() async throws {
        let store = makeStore()

        store.setUsesDateRange(true)
        store.setDateFrom("2026-08-01")
        store.setDateTo("2026-09-12")
        XCTAssertEqual(store.filters.effectiveDateFrom, "2026-08-01")

        store.setUsesDateRange(false)
        XCTAssertNil(store.filters.effectiveDateFrom)
        XCTAssertNil(store.filters.dateFrom)
        XCTAssertNil(store.filters.dateTo)
    }

    /// 未登录：不发请求，直接把闸门置成失败态（避免一次必然 401 的往返）。
    func testFailWithoutCredentialMarksGateFailed() {
        let store = makeStore()

        store.failWithoutCredential()

        guard case .failed(let message) = store.projectGate else {
            return XCTFail("应当是 failed 闸门，实际 \(store.projectGate)")
        }
        XCTAssertTrue(message.contains("尚未登录"))
    }

    /// 筛选条文案：未限定日期时要写明落的是哨兵窗口（这是本页与广告分析页的口径差异）。
    func testFilterSummaryDescribesSentinelWindow() async throws {
        let store = makeStore()
        let provider = ScriptedAdDataProvider(defaultEndpoint: .value(try campaignsPayload()))
        let scope = ModuleTaskScope()

        XCTAssertEqual(
            store.dateRangeOffNote,
            "未限定日期 → 全量窗口 2000-01-01 ~ 2100-12-31"
        )

        await store.load(using: provider, scope: scope, key: routeID)
        XCTAssertTrue(store.filterSummary.contains("全量窗口（2000-01-01 ~ 2100-12-31）"))
        XCTAssertTrue(store.filterSummary.contains("广告活动"))
        XCTAssertTrue(store.filterSummary.contains("limit=10000"))
    }

    /// 下载/加载中时 `loadKey` 随类型、筛选、票号变化（视图的 `.task(id:)` 靠它驱动）。
    func testLoadKeyTracksTypeFiltersAndTicket() {
        let store = makeStore()
        let initial = store.loadKey

        store.selectReportType(code: "ad_time_trend_report")
        XCTAssertNotEqual(store.loadKey, initial)
        XCTAssertEqual(store.loadKey.reportTypeCode, "ad_time_trend_report")

        let afterType = store.loadKey
        store.setCountry("DE")
        XCTAssertNotEqual(store.loadKey, afterType)

        let afterCountry = store.loadKey
        store.requestRefresh()
        XCTAssertNotEqual(store.loadKey, afterCountry)
        XCTAssertEqual(store.loadKey.refreshTicket, 1)
    }
}
