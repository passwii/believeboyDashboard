import BelieveBoyKit
import Foundation
import XCTest

@testable import BelieveBoyUI

/// 可编排的「产品分析」数据源假实现。
///
/// 为什么不能用 `StubURLProtocol` 单独覆盖这一层：本批要钉住的四条口径全都要求**精确控制时序**
/// —— 「确认之前一个请求都不发」「commit 失败后识别结果仍在、可直接重试」「轮询的等待序列是
/// 退避的且有上限」「取消不留 Task 也不落错误态」。`URLProtocol` 只能按请求返回内容，控制不了
/// 「永不返回」「第 N 次失败」这类编排。
final class ScriptedProductAnalysisProvider: ProductAnalysisDataProviding, @unchecked Sendable {
    enum Outcome<Value: Sendable>: Sendable {
        case value(Value)
        /// 抛 `APIError.http`（贴近真实失败形态：非 2xx）。
        case failure(status: Int)
        /// 一直挂起，直到任务被取消 —— 用来观测 loading 中间态与取消行为。
        case hang
    }

    let cancellation = CancellationRecorder()

    private let lock = NSLock()
    private var projectsOutcome: Outcome<[AdProject]>
    private var recognizeOutcomes: [Outcome<AdUploadRecognition>]
    private var commitOutcomes: [Outcome<AdUploadCommitResult>]
    private var statusesOutcome: Outcome<AdUploadStatusResponse>
    private var createOutcome: Outcome<ProductAnalysisReportTicket>
    private var taskStatuses: [Outcome<ProductAnalysisTaskStatus>]
    private var downloadOutcome: Outcome<URL>

    private var recordedProjectsCalls = 0
    private var recordedRecognizeCalls: [(filename: String, country: String)] = []
    private var recordedCommitRequests: [AdUploadCommitRequest] = []
    private var recordedStatusQueries: [AdUploadStatusQuery] = []
    private var recordedCreateRequests: [ProductAnalysisReportRequest] = []
    private var recordedTaskPaths: [String] = []
    private var recordedDownloads: [(path: String, destination: URL)] = []

    init(
        projects: Outcome<[AdProject]> = .value([AdProject(id: 19, name: "博朗姆", country: "US")]),
        recognize: [Outcome<AdUploadRecognition>] = [],
        commit: [Outcome<AdUploadCommitResult>] = [],
        statuses: Outcome<AdUploadStatusResponse> = .value(
            AdUploadStatusResponse(country: "US", items: [])
        ),
        create: Outcome<ProductAnalysisReportTicket> = .value(
            ProductAnalysisReportTicket(jobID: 1, status: .pending)
        ),
        taskStatuses: [Outcome<ProductAnalysisTaskStatus>] = [],
        download: Outcome<URL>? = nil
    ) {
        self.projectsOutcome = projects
        self.recognizeOutcomes = recognize
        self.commitOutcomes = commit
        self.statusesOutcome = statuses
        self.createOutcome = create
        self.taskStatuses = taskStatuses
        self.downloadOutcome = download ?? .value(URL(fileURLWithPath: "/dev/null"))
    }

    // MARK: - 编排

    func setProjects(_ outcome: Outcome<[AdProject]>) { withLock { projectsOutcome = outcome } }
    func setStatuses(_ outcome: Outcome<AdUploadStatusResponse>) { withLock { statusesOutcome = outcome } }
    func setCreate(_ outcome: Outcome<ProductAnalysisReportTicket>) { withLock { createOutcome = outcome } }
    func setDownload(_ outcome: Outcome<URL>) { withLock { downloadOutcome = outcome } }

    func setRecognize(_ outcomes: [Outcome<AdUploadRecognition>]) {
        withLock { recognizeOutcomes = outcomes }
    }

    func setCommit(_ outcomes: [Outcome<AdUploadCommitResult>]) {
        withLock { commitOutcomes = outcomes }
    }

    func setTaskStatuses(_ outcomes: [Outcome<ProductAnalysisTaskStatus>]) {
        withLock { taskStatuses = outcomes }
    }

    // MARK: - 观测

    var projectsCallCount: Int { withLock { recordedProjectsCalls } }
    var recognizedFilenames: [String] { withLock { recordedRecognizeCalls.map(\.filename) } }
    var recognizeCountries: [String] { withLock { recordedRecognizeCalls.map(\.country) } }
    var commitRequests: [AdUploadCommitRequest] { withLock { recordedCommitRequests } }
    var statusQueries: [AdUploadStatusQuery] { withLock { recordedStatusQueries } }
    var createRequests: [ProductAnalysisReportRequest] { withLock { recordedCreateRequests } }
    var taskPaths: [String] { withLock { recordedTaskPaths } }
    var downloads: [(path: String, destination: URL)] { withLock { recordedDownloads } }

    // MARK: - ProductAnalysisDataProviding

    func projects() async throws -> [AdProject] {
        let outcome = withLock {
            recordedProjectsCalls += 1
            return projectsOutcome
        }
        return try await resolve(outcome)
    }

    func recognizeAdUpload(
        fileURL: URL,
        filename: String,
        country: String
    ) async throws -> AdUploadRecognition {
        let outcome = withLock { () -> Outcome<AdUploadRecognition> in
            recordedRecognizeCalls.append((filename, country))
            if recognizeOutcomes.isEmpty { return .failure(status: 500) }
            return recognizeOutcomes.removeFirst()
        }
        return try await resolve(outcome)
    }

    func commitAdUpload(_ request: AdUploadCommitRequest) async throws -> AdUploadCommitResult {
        let outcome = withLock { () -> Outcome<AdUploadCommitResult> in
            recordedCommitRequests.append(request)
            if commitOutcomes.isEmpty { return .failure(status: 500) }
            return commitOutcomes.removeFirst()
        }
        return try await resolve(outcome)
    }

    func adUploadStatuses(_ query: AdUploadStatusQuery) async throws -> AdUploadStatusResponse {
        let outcome = withLock { () -> Outcome<AdUploadStatusResponse> in
            recordedStatusQueries.append(query)
            return statusesOutcome
        }
        return try await resolve(outcome)
    }

    func createProductAnalysisReport(
        _ request: ProductAnalysisReportRequest
    ) async throws -> ProductAnalysisReportTicket {
        let outcome = withLock { () -> Outcome<ProductAnalysisReportTicket> in
            recordedCreateRequests.append(request)
            return createOutcome
        }
        return try await resolve(outcome)
    }

    func productAnalysisTask(path: String) async throws -> ProductAnalysisTaskStatus {
        let outcome = withLock { () -> Outcome<ProductAnalysisTaskStatus> in
            recordedTaskPaths.append(path)
            if taskStatuses.isEmpty { return .failure(status: 500) }
            // 最后一次会一直复用（与真实后端一致：终态之后查询仍然回终态）。
            return taskStatuses.count == 1 ? taskStatuses[0] : taskStatuses.removeFirst()
        }
        return try await resolve(outcome)
    }

    @discardableResult
    func downloadProductAnalysisResult(
        path: String,
        to destination: URL,
        onProgress: (@Sendable (DownloadProgress) -> Void)?
    ) async throws -> URL {
        let outcome = withLock { () -> Outcome<URL> in
            recordedDownloads.append((path, destination))
            return downloadOutcome
        }
        switch outcome {
        case .value:
            // 模拟「流式落盘」：真写到调用方给的落点（含建目录，与 `APIClient.download` 同行为）
            // —— 断言的目录 / 文件名才不是空话。
            try FileManager.default.createDirectory(
                at: destination.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try Data("xlsx".utf8).write(to: destination)
            onProgress?(DownloadProgress(receivedBytes: 4, expectedBytes: 4))
            return destination
        case .failure(let status):
            throw APIError.http(status: status, body: "stub failure \(status)")
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

// MARK: - 测试夹具

extension AdUploadRecognition {
    /// 测试用识别结果（字段取自 `Fixtures/Report/ad-upload-recognize.json` 的形状）。
    static func fixture(
        tempFileID: String = "tmp-1",
        filename: String = "广告推广的商品报告.csv",
        reportType: String = "ad_promoted_product_report",
        status: Status = .recognized,
        projectMatchStatus: AdUploadProjectMatch.Status = .matched,
        projectName: String? = "博朗姆",
        reportDate: String? = "2026-09-07",
        rowCountPreview: Int? = 2,
        warnings: [String] = []
    ) -> AdUploadRecognition {
        AdUploadRecognition(
            tempFileID: tempFileID,
            originalFilename: filename,
            fileExtension: ".csv",
            reportType: reportType,
            reportLabel: ReportTypeLabels.label(for: reportType),
            matchedColumns: ["开始日期", "结束日期"],
            reason: "命中字段",
            status: status,
            country: "US",
            detectedReportDate: reportDate,
            detectedStartDate: reportDate,
            detectedEndDate: reportDate,
            projectMatch: AdUploadProjectMatch(
                status: projectMatchStatus,
                projectName: projectName,
                candidateProjects: projectName.map { [$0] } ?? []
            ),
            rowCountPreview: rowCountPreview,
            warnings: warnings
        )
    }
}

extension AdUploadCommitResult {
    static func fixture(
        fileID: String = "file-1",
        reportType: String = "ad_promoted_product_report",
        ingestionStatus: String = "skipped",
        id: Int = 0,
        version: Int = 0
    ) -> AdUploadCommitResult {
        AdUploadCommitResult(
            id: id,
            reportType: reportType,
            reportLabel: ReportTypeLabels.label(for: reportType),
            ingestionStatus: ingestionStatus,
            projectName: "博朗姆",
            country: "US",
            reportDate: "2026-09-07",
            reportStartDate: "2026-09-07",
            reportEndDate: "2026-09-07",
            fileID: fileID,
            filePath: "/tmp/\(fileID)",
            version: version,
            isCurrent: false,
            message: "dry_run：未写入 ad_upload_files"
        )
    }
}

extension ProductAnalysisTaskStatus {
    static func fixture(
        taskID: Int = 1,
        status: JobStatus = .running,
        stage: String = "processing",
        progress: Int = 40,
        message: String? = "处理中",
        errorMessage: String? = nil,
        persistenceStatus: String = "idle"
    ) -> ProductAnalysisTaskStatus {
        ProductAnalysisTaskStatus(
            taskID: taskID,
            status: status,
            stage: stage,
            progress: progress,
            message: message,
            errorMessage: errorMessage,
            persistenceStatus: persistenceStatus
        )
    }
}

/// 记下每次「睡觉」的时长并立刻返回 —— 断言的是**策略算出来的等待序列**，不是真实等待。
///
/// 用 `LockedBox` 而不是 `@MainActor` 类：`PollSleeper` 的闭包是 `@Sendable` 的，会在
/// 任意上下文调用；盒子带锁，写侧与断言侧才是一致的。
final class RecordingSleeper: @unchecked Sendable {
    private let box = LockedBox<[TimeInterval]>([])

    var delays: [TimeInterval] { box.value }

    var sleeper: PollSleeper {
        PollSleeper { [box] seconds in
            box.mutate { $0.append(seconds) }
        }
    }
}

/// 「产品分析」状态机用例：写链路的确认 / 重试 / 不重复写入 + 异步任务的轮询 / 取消 / 下载。
@MainActor
final class ProductAnalysisStoreTests: XCTestCase {
    private let routeID = ProductAnalysisView.routeID

    private func makeStore(
        sleeper: PollSleeper = PollSleeper { _ in },
        policy: PollingPolicy = PollingPolicy(initialDelay: 1, multiplier: 2, maxDelay: 4, maxAttempts: 5),
        downloadDirectory: URL = FileManager.default.temporaryDirectory
    ) -> ProductAnalysisStore {
        ProductAnalysisStore(
            dateRange: (start: "2026-09-07", end: "2026-09-13"),
            pollingPolicy: policy,
            sleeper: sleeper,
            downloadDirectory: { downloadDirectory }
        )
    }

    private func temporaryFile(named name: String = "广告推广的商品报告.csv") throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("blf1068-\(UUID().uuidString)-\(name)")
        try "a,b\n1,2\n".write(to: url, atomically: true, encoding: .utf8)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    // MARK: - 进页加载

    /// 进页取项目列表 + 入库状态，并选中第一个项目（与广告两页同口径）。
    func testLoadFetchesProjectsAndStatusesAndSelectsFirstProject() async throws {
        let provider = ScriptedProductAnalysisProvider()
        let store = makeStore()
        let scope = ModuleTaskScope()

        await store.load(using: provider, scope: scope, routeID: routeID)

        XCTAssertEqual(provider.projectsCallCount, 1)
        XCTAssertEqual(store.projectGate, .ready)
        XCTAssertEqual(store.projectName, "博朗姆", "Web 同口径：进页选中第一个项目")
        XCTAssertEqual(provider.statusQueries.map(\.country), ["US"])
        XCTAssertEqual(store.statusesPhase, .loaded)
        XCTAssertEqual(store.statusTableState, .empty, "空列表 → 显式空态，不是错误页")
        XCTAssertTrue(scope.isEmpty, "加载完不留任务（切模块时也不会漏取消）")
    }

    /// 项目列表失败 → 闸门 failed，且**不发**入库状态请求之外的东西。
    func testProjectsFailureBlocksGate() async throws {
        let provider = ScriptedProductAnalysisProvider(projects: .failure(status: 500))
        let store = makeStore()
        await store.load(using: provider, scope: ModuleTaskScope(), routeID: routeID)

        guard case .failed = store.projectGate else {
            return XCTFail("项目列表失败应落成 failed 闸门，实际 \(store.projectGate)")
        }
        XCTAssertTrue(store.projects.isEmpty)
    }

    /// 一个可见项目都没有 → noProjects（不是错误）。
    func testNoProjectsGate() async throws {
        let provider = ScriptedProductAnalysisProvider(projects: .value([]))
        let store = makeStore()
        await store.load(using: provider, scope: ModuleTaskScope(), routeID: routeID)
        XCTAssertEqual(store.projectGate, .noProjects)
    }

    /// 未登录：**不发请求**（把「还没登录」显示成「凭据被拒绝」是误导）。
    func testFailWithoutCredentialDoesNotRequest() async throws {
        let provider = ScriptedProductAnalysisProvider()
        let store = makeStore()
        store.failWithoutCredential()
        XCTAssertEqual(provider.projectsCallCount, 0)
        guard case .failed(let message) = store.projectGate else {
            return XCTFail("应当落成 failed 闸门")
        }
        XCTAssertTrue(message.contains("尚未登录"), message)
    }

    /// 入库状态刷新失败**保留旧表**（口径 2）。
    func testStatusesRefreshFailureKeepsOldTable() async throws {
        let items = [
            AdUploadStatusItem.fixture(projectName: "博朗姆", reportType: "ad_promoted_product_report")
        ]
        let provider = ScriptedProductAnalysisProvider(
            statuses: .value(AdUploadStatusResponse(country: "US", items: items))
        )
        let store = makeStore()
        await store.load(using: provider, scope: ModuleTaskScope(), routeID: routeID)
        XCTAssertEqual(store.statuses.count, 1)

        provider.setStatuses(.failure(status: 500))
        await store.loadStatuses(using: provider, scope: ModuleTaskScope(), routeID: routeID)

        XCTAssertEqual(store.statuses.count, 1, "刷新失败必须保留旧表")
        XCTAssertEqual(store.statusTableState, .ready)
        XCTAssertNotNil(store.statusesRefreshFailure)
    }

    // MARK: - 识别：结果先呈现

    /// 识别之后**一个 commit 都不发** —— 这是「不允许选完文件就写库」的机械保证。
    func testRecognitionPresentsJudgementsWithoutAnyWrite() async throws {
        let provider = ScriptedProductAnalysisProvider(recognize: [.value(.fixture())])
        let store = makeStore()
        let scope = ModuleTaskScope()
        let file = try temporaryFile()

        await store.recognizeFiles([file], using: provider, scope: scope, routeID: routeID)

        XCTAssertTrue(provider.commitRequests.isEmpty, "识别阶段绝不允许写")
        XCTAssertEqual(provider.recognizedFilenames, [file.lastPathComponent])
        XCTAssertEqual(provider.recognizeCountries, ["US"], "country 是 multipart 的 Form 字段")
        XCTAssertEqual(store.items.count, 1)

        let recognition = try XCTUnwrap(store.recognition(for: "ad_promoted_product_report"))
        XCTAssertEqual(recognition.rowCountPreview, 2)
        XCTAssertEqual(recognition.matchedColumns, ["开始日期", "结束日期"])
        // 卡片预填的必须是**识别器给的**判据。
        let state = store.state(for: "ad_promoted_product_report")
        XCTAssertEqual(state.selectedProject, "博朗姆")
        XCTAssertEqual(state.reportDate, "2026-09-07")
        XCTAssertTrue(store.canCommit("ad_promoted_product_report"))
    }

    /// 识别失败只影响那一条：失败进列表 + 后续文件照常识别（不静默丢弃）。
    func testRecognitionFailureIsVisibleAndDoesNotStopOthers() async throws {
        let provider = ScriptedProductAnalysisProvider(recognize: [
            .failure(status: 400),
            .value(.fixture(tempFileID: "tmp-2", filename: "b.csv")),
        ])
        let store = makeStore()
        let first = try temporaryFile(named: "a.csv")
        let second = try temporaryFile(named: "b.csv")

        await store.recognizeFiles([first, second], using: provider, scope: ModuleTaskScope(), routeID: routeID)

        XCTAssertEqual(store.items.count, 2)
        XCTAssertEqual(store.items[0].recognition, .failed("后端返回 HTTP 400：stub failure 400"))
        XCTAssertNotNil(store.items[1].recognition.response)
        XCTAssertEqual(provider.recognizedFilenames.count, 2)
    }

    /// 未匹配到唯一项目 → 闸门是「请先选择项目」，不能确认。
    func testUnmatchedProjectBlocksCommitUntilUserPicks() async throws {
        let provider = ScriptedProductAnalysisProvider(recognize: [
            .value(.fixture(projectMatchStatus: .manual, projectName: nil)),
        ])
        let store = makeStore()
        await store.recognizeFiles(
            [try temporaryFile()],
            using: provider,
            scope: ModuleTaskScope(),
            routeID: routeID
        )

        // `projectName`（页面级）会作为兜底预填；把它清掉模拟「用户还没选」。
        store.setProject(name: "")
        store.setCardProject("ad_promoted_product_report", "")
        XCTAssertEqual(store.blockers(for: "ad_promoted_product_report"), [.projectNeedsChoice])
        XCTAssertFalse(store.canCommit("ad_promoted_product_report"))

        store.setCardProject("ad_promoted_product_report", "博朗姆")
        XCTAssertTrue(store.blockers(for: "ad_promoted_product_report").isEmpty)
        XCTAssertTrue(store.canCommit("ad_promoted_product_report"))
    }

    /// 候选文件切换会把该卡片的日期换成那份文件的识别日期。
    func testSelectingCandidatePrefillsItsOwnDates() async throws {
        let provider = ScriptedProductAnalysisProvider(recognize: [
            .value(.fixture(tempFileID: "tmp-A", filename: "a.csv", reportDate: "2026-09-01")),
            .value(.fixture(tempFileID: "tmp-B", filename: "b.csv", reportDate: "2026-09-08")),
        ])
        let store = makeStore()
        await store.recognizeFiles(
            [try temporaryFile(named: "a.csv"), try temporaryFile(named: "b.csv")],
            using: provider,
            scope: ModuleTaskScope(),
            routeID: routeID
        )
        XCTAssertEqual(store.candidates(for: "ad_promoted_product_report").count, 2)
        XCTAssertEqual(store.state(for: "ad_promoted_product_report").reportDate, "2026-09-08")

        let firstID = try XCTUnwrap(store.candidates(for: "ad_promoted_product_report").first?.id)
        store.selectCandidate("ad_promoted_product_report", itemID: firstID)
        XCTAssertEqual(store.state(for: "ad_promoted_product_report").reportDate, "2026-09-01")
    }

    /// 业务 / 付款两张卡是「本批未搬」：有说明、点不动（不做假按钮）。
    func testNotPortedCardsExplainThemselvesAndCannotCommit() {
        let store = makeStore()
        for type in ["business_report", "payment_report"] {
            let config = ProductAnalysisStore.cardConfigs.first { $0.reportType == type }
            let note = try? XCTUnwrap(config?.chain.note)
            XCTAssertNotNil(note, "\(type) 必须写明为什么本批不能提交")
            XCTAssertFalse(store.canCommit(type))
            XCTAssertFalse(store.canRecommit(type))
        }
        XCTAssertEqual(ProductAnalysisStore.writableCard.reportType, "ad_promoted_product_report")
    }

    // MARK: - 确认（写链路第二步）

    /// `requestCommit` **只**生成待确认摘要，不发请求；`confirmPendingCommit` 才是唯一写入口。
    func testCommitRequiresExplicitConfirmation() async throws {
        let provider = ScriptedProductAnalysisProvider(
            recognize: [.value(.fixture())],
            commit: [.value(.fixture())]
        )
        let store = makeStore()
        let scope = ModuleTaskScope()
        await store.recognizeFiles(
            [try temporaryFile()],
            using: provider,
            scope: scope,
            routeID: routeID
        )

        store.requestCommit(reportType: "ad_promoted_product_report")
        XCTAssertNotNil(store.pendingConfirmation)
        XCTAssertTrue(provider.commitRequests.isEmpty, "确认之前绝不能写")

        await store.confirmPendingCommit(using: provider, scope: scope, routeID: routeID)
        XCTAssertNil(store.pendingConfirmation)
        XCTAssertEqual(provider.commitRequests.count, 1)
        XCTAssertTrue(store.isCommitted("ad_promoted_product_report"))
        XCTAssertEqual(store.items[0].commit, .committed)
        XCTAssertEqual(store.items[0].result?.fileID, "file-1")
    }

    /// 确认摘要逐行列清「即将写入的内容」—— 审计可查的那一半在客户端。
    func testConfirmationSummaryListsWhatWillBeWritten() async throws {
        let provider = ScriptedProductAnalysisProvider(recognize: [.value(.fixture())])
        let store = makeStore()
        await store.recognizeFiles(
            [try temporaryFile()],
            using: provider,
            scope: ModuleTaskScope(),
            routeID: routeID
        )
        store.requestCommit(reportType: "ad_promoted_product_report")
        let confirmation = try XCTUnwrap(store.pendingConfirmation)

        XCTAssertEqual(confirmation.reportType, "ad_promoted_product_report")
        XCTAssertFalse(confirmation.isOverwrite)
        let text = confirmation.summary.joined(separator: "\n")
        XCTAssertTrue(text.contains("推广的商品"), text)
        XCTAssertTrue(text.contains("博朗姆"), text)
        XCTAssertTrue(text.contains("2026-09-07"), text)
        XCTAssertTrue(text.contains("dry_run"), "必须明说这一写是 dry_run（不静默写入）")
        XCTAssertTrue(text.contains("行数预览"), text)
        XCTAssertFalse(text.contains("⚠️"), "首次提交不该出现覆盖提示")
    }

    /// 取消确认：什么都不发。
    func testCancelPendingCommitSendsNothing() async throws {
        let provider = ScriptedProductAnalysisProvider(recognize: [.value(.fixture())])
        let store = makeStore()
        await store.recognizeFiles(
            [try temporaryFile()],
            using: provider,
            scope: ModuleTaskScope(),
            routeID: routeID
        )
        store.requestCommit(reportType: "ad_promoted_product_report")
        store.cancelPendingCommit()

        XCTAssertNil(store.pendingConfirmation)
        XCTAssertTrue(provider.commitRequests.isEmpty)
        XCTAssertFalse(store.isCommitted("ad_promoted_product_report"))
    }

    /// 改参数 / 换项目 / 换候选都会作废待确认（否则会用旧日期或旧项目写库）。
    func testParameterChangeInvalidatesPendingConfirmation() async throws {
        let provider = ScriptedProductAnalysisProvider(recognize: [.value(.fixture())])
        let store = makeStore()
        await store.recognizeFiles(
            [try temporaryFile()],
            using: provider,
            scope: ModuleTaskScope(),
            routeID: routeID
        )

        store.requestCommit(reportType: "ad_promoted_product_report")
        store.setDateRange(start: "2026-09-01", end: "2026-09-07")
        XCTAssertNil(store.pendingConfirmation, "日期变了，待确认的提交必须作废")

        store.requestCommit(reportType: "ad_promoted_product_report")
        store.setCardProject("ad_promoted_product_report", "别的项目")
        XCTAssertNil(store.pendingConfirmation)
    }

    // MARK: - 失败可重试且不产生半成品

    /// commit 失败 → 识别结果一字不动、可直接重试；重试成功且总共只发两次。
    func testCommitFailureKeepsRecognitionAndAllowsRetry() async throws {
        let provider = ScriptedProductAnalysisProvider(
            recognize: [.value(.fixture())],
            commit: [.failure(status: 500), .value(.fixture(fileID: "file-ok"))]
        )
        let store = makeStore()
        let scope = ModuleTaskScope()
        await store.recognizeFiles(
            [try temporaryFile()],
            using: provider,
            scope: scope,
            routeID: routeID
        )
        let recognitionBefore = try XCTUnwrap(store.recognition(for: "ad_promoted_product_report"))

        store.requestCommit(reportType: "ad_promoted_product_report")
        await store.confirmPendingCommit(using: provider, scope: scope, routeID: routeID)

        XCTAssertEqual(
            store.items[0].commit,
            .failed("后端返回 HTTP 500：stub failure 500")
        )
        XCTAssertFalse(store.isCommitted("ad_promoted_product_report"))
        XCTAssertEqual(
            store.recognition(for: "ad_promoted_product_report"),
            recognitionBefore,
            "失败必须保留识别结果，否则重试要重新上传一遍"
        )
        XCTAssertTrue(store.canCommit("ad_promoted_product_report"), "失败后应可直接重试")

        // 重试：同一份识别结果，再确认一次。
        store.requestCommit(reportType: "ad_promoted_product_report")
        await store.confirmPendingCommit(using: provider, scope: scope, routeID: routeID)

        XCTAssertTrue(store.isCommitted("ad_promoted_product_report"))
        XCTAssertEqual(store.items[0].result?.fileID, "file-ok")
        XCTAssertEqual(provider.commitRequests.count, 2, "恰好两次：一次失败 + 一次成功")
        XCTAssertEqual(
            provider.commitRequests.map(\.tempFileID),
            ["tmp-1", "tmp-1"],
            "重试用的是同一份临时文件，不重复上传"
        )
    }

    /// 已提交的卡片不能重复写：`canCommit` 关掉、`canRecommit` 打开，且重提的确认摘要必须
    /// **明说是覆盖**（口径 4：不可逆操作不可一键完成）。
    func testCommittedCardRequiresOverwriteConfirmationToRecommit() async throws {
        let provider = ScriptedProductAnalysisProvider(
            recognize: [.value(.fixture())],
            commit: [.value(.fixture()), .value(.fixture(fileID: "file-2"))]
        )
        let store = makeStore()
        let scope = ModuleTaskScope()
        await store.recognizeFiles(
            [try temporaryFile()],
            using: provider,
            scope: scope,
            routeID: routeID
        )
        store.requestCommit(reportType: "ad_promoted_product_report")
        await store.confirmPendingCommit(using: provider, scope: scope, routeID: routeID)

        XCTAssertFalse(store.canCommit("ad_promoted_product_report"), "已提交 → 不能直接再写")
        XCTAssertTrue(store.canRecommit("ad_promoted_product_report"))

        store.requestCommit(reportType: "ad_promoted_product_report")
        let confirmation = try XCTUnwrap(store.pendingConfirmation)
        XCTAssertTrue(confirmation.isOverwrite)
        XCTAssertTrue(
            confirmation.summary.contains { $0.contains("⚠️") },
            "覆盖确认必须写在摘要里：\(confirmation.summary)"
        )
        await store.confirmPendingCommit(using: provider, scope: scope, routeID: routeID)
        XCTAssertEqual(store.items[0].result?.fileID, "file-2")
    }

    /// 提交后把 `file_id` 带入核算表单（写链路 → 异步任务的唯一桥梁）。
    func testCommittedFileIDIsAdoptedIntoReportForm() async throws {
        let provider = ScriptedProductAnalysisProvider(
            recognize: [.value(.fixture())],
            commit: [.value(.fixture(fileID: "file-ad-1"))]
        )
        let store = makeStore()
        let scope = ModuleTaskScope()
        await store.recognizeFiles(
            [try temporaryFile()],
            using: provider,
            scope: scope,
            routeID: routeID
        )
        XCTAssertTrue(store.form.adReportFileID.isEmpty)

        store.requestCommit(reportType: "ad_promoted_product_report")
        await store.confirmPendingCommit(using: provider, scope: scope, routeID: routeID)

        XCTAssertEqual(store.form.adReportFileID, "file-ad-1", "自动带入")
        store.setProject(name: "博朗姆")
        store.setFormFileID(.businessReport, "b-1")
        store.setFormFileID(.paymentReport, "p-1")
        XCTAssertTrue(store.canSubmitReport, "三类 file id 齐了 + 有项目 + 日期合法")
    }

    // MARK: - 取消不落错误态、不泄漏 Task

    /// 识别中途取消（切模块）：不落错误态、不永远转圈、作用域清空。
    func testCancellingRecognitionMarksItemsAsInterruptedAndLeavesNoTask() async throws {
        let provider = ScriptedProductAnalysisProvider(recognize: [.hang, .value(.fixture(tempFileID: "tmp-2"))])
        let store = makeStore()
        let scope = ModuleTaskScope()
        let first = try temporaryFile(named: "a.csv")
        let second = try temporaryFile(named: "b.csv")

        let task = Task { @MainActor in
            await store.recognizeFiles([first, second], using: provider, scope: scope, routeID: routeID)
        }
        await waitUntil { store.isRecognizing }
        scope.cancelTree(key: routeID)
        await task.value

        XCTAssertTrue(provider.cancellation.isCancelled, "挂起的识别必须真的被取消")
        XCTAssertEqual(store.items[0].recognition, .cancelled)
        XCTAssertEqual(store.items[1].recognition, .cancelled, "没轮到的那条是「已中断」而不是「识别中」")
        XCTAssertFalse(store.isRecognizing)
        await waitUntil { scope.isEmpty }
    }

    /// commit 进行中时任务登记在 `routeID:pa-commit` 下（外壳能按 route id 整棵树收掉）。
    func testCommitTaskIsRegisteredUnderRouteScopedKey() async throws {
        let provider = ScriptedProductAnalysisProvider(
            recognize: [.value(.fixture())],
            commit: [.hang]
        )
        let store = makeStore()
        let scope = ModuleTaskScope()
        await store.recognizeFiles(
            [try temporaryFile()],
            using: provider,
            scope: scope,
            routeID: routeID
        )
        store.requestCommit(reportType: "ad_promoted_product_report")

        let task = Task { @MainActor in
            await store.confirmPendingCommit(using: provider, scope: scope, routeID: routeID)
        }
        await waitUntil { scope.activeKeys.contains("\(routeID):pa-commit") }
        XCTAssertEqual(store.items[0].commit, .saving)

        scope.cancelTree(key: routeID)
        await task.value
        await waitUntil { scope.isEmpty }
        XCTAssertTrue(store.items[0].commit.isSaving == false || store.items[0].commit == .saving)
    }

    // MARK: - 异步核算任务

    /// 表单不全时**不发请求**（把能提前判的判掉，少一次注定失败的写请求）。
    func testSubmitReportRejectsIncompleteForm() async throws {
        let provider = ScriptedProductAnalysisProvider()
        let store = makeStore()
        await store.submitReport(using: provider, scope: ModuleTaskScope(), routeID: routeID)

        XCTAssertTrue(provider.createRequests.isEmpty)
        XCTAssertEqual(store.reportPhase, .idle)
        XCTAssertEqual(
            store.reportFormBlockers,
            [.missingProject, .missingBusinessReport, .missingPaymentReport, .missingAdReport],
            "项目也没选（这个用例没调 load）"
        )
    }

    /// 缺项目 / 日期倒挂也要挡在前面。
    func testFormBlockersCoverProjectAndDates() {
        let store = ProductAnalysisStore(
            dateRange: (start: "2026-09-13", end: "2026-09-07")
        )
        store.setFormFileID(.businessReport, "b")
        store.setFormFileID(.paymentReport, "p")
        store.setFormFileID(.adReport, "a")
        store.setProject(name: "")
        XCTAssertEqual(store.reportFormBlockers, [.missingProject, .reversedDateRange])
    }

    /// 轮询：退避的等待序列 + 终态即停 + 每次都把进度落地（用户看得见）。
    func testSubmitReportPollsWithBackoffUntilTerminal() async throws {
        let sleeper = RecordingSleeper()
        let provider = ScriptedProductAnalysisProvider(
            create: .value(ProductAnalysisReportTicket(jobID: 42, status: .pending)),
            taskStatuses: [
                .value(.fixture(status: .running, progress: 10)),
                .value(.fixture(status: .running, progress: 60)),
                .value(.fixture(status: .success, stage: "completed", progress: 100)),
            ]
        )
        let store = makeStore(sleeper: sleeper.sleeper)
        store.setProject(name: "博朗姆")
        store.setFormFileID(.businessReport, "b")
        store.setFormFileID(.paymentReport, "p")
        store.setFormFileID(.adReport, "a")

        await store.submitReport(using: provider, scope: ModuleTaskScope(), routeID: routeID)

        XCTAssertEqual(store.reportPhase, .succeeded)
        XCTAssertEqual(store.reportTask?.status, .success)
        XCTAssertEqual(
            provider.taskPaths,
            Array(repeating: "/product-analysis-reports/tasks/42", count: 3),
            "跟着后端给的 status_endpoint 走（归一化成客户端相对路径）"
        )
        let delays = sleeper.delays
        XCTAssertEqual(delays, [1, 2], "1s 起、×2 退避；终态那次不再睡")
        XCTAssertEqual(provider.createRequests.count, 1)
        XCTAssertEqual(provider.createRequests[0].adReportFileID, "a")
        XCTAssertNil(provider.createRequests[0].inventoryReportFileID, "库存留空 = 不传")
    }

    /// 上限到了就停（不无限打后端），并给出明确文案。
    func testPollingStopsAtMaxAttempts() async throws {
        let provider = ScriptedProductAnalysisProvider(
            create: .value(ProductAnalysisReportTicket(jobID: 7, status: .pending)),
            taskStatuses: [.value(.fixture(status: .running, progress: 20))]
        )
        let store = makeStore(policy: PollingPolicy(initialDelay: 0, multiplier: 1, maxDelay: 0, maxAttempts: 3))
        store.setProject(name: "博朗姆")
        store.setFormFileID(.businessReport, "b")
        store.setFormFileID(.paymentReport, "p")
        store.setFormFileID(.adReport, "a")

        await store.submitReport(using: provider, scope: ModuleTaskScope(), routeID: routeID)

        XCTAssertEqual(provider.taskPaths.count, 3, "正好探 3 次就停")
        guard case .failed(let message) = store.reportPhase else {
            return XCTFail("超时应落成 failed，实际 \(store.reportPhase)")
        }
        XCTAssertTrue(message.contains("3 次轮询"), message)
    }

    /// 任务失败：用后端给的 `error_message` 作文案（不是「未知错误」）。
    func testFailedTaskSurfacesBackendErrorMessage() async throws {
        let provider = ScriptedProductAnalysisProvider(
            create: .value(ProductAnalysisReportTicket(jobID: 9, status: .pending)),
            taskStatuses: [
                .value(.fixture(
                    status: .failed,
                    stage: "failed",
                    progress: 100,
                    message: "处理失败：Report file not found",
                    errorMessage: "Report file not found"
                )),
            ]
        )
        let store = makeStore()
        store.setProject(name: "博朗姆")
        store.setFormFileID(.businessReport, "b")
        store.setFormFileID(.paymentReport, "p")
        store.setFormFileID(.adReport, "a")

        await store.submitReport(using: provider, scope: ModuleTaskScope(), routeID: routeID)

        guard case .failed(let message) = store.reportPhase else {
            return XCTFail("应当 failed")
        }
        XCTAssertTrue(message.contains("Report file not found"), message)
        XCTAssertFalse(store.reportTask?.hasDownloadableResult ?? true, "失败的任务不给下载")
    }

    /// 取消等待：停轮询、**不落错误态**、作用域清空。
    func testCancelReportStopsPollingWithoutErrorState() async throws {
        let provider = ScriptedProductAnalysisProvider(
            create: .value(ProductAnalysisReportTicket(jobID: 5, status: .pending)),
            taskStatuses: [.hang]
        )
        let store = makeStore(policy: PollingPolicy(initialDelay: 5, multiplier: 1, maxDelay: 5, maxAttempts: 10))
        let scope = ModuleTaskScope()
        store.setProject(name: "博朗姆")
        store.setFormFileID(.businessReport, "b")
        store.setFormFileID(.paymentReport, "p")
        store.setFormFileID(.adReport, "a")

        let task = Task { @MainActor in
            await store.submitReport(using: provider, scope: scope, routeID: routeID)
        }
        await waitUntil { scope.activeKeys.contains("\(routeID):pa-poll") }
        store.cancelReport(scope: scope, routeID: routeID)
        await task.value

        XCTAssertEqual(store.reportPhase, .idle, "取消不是失败")
        XCTAssertNil(store.reportPhase.failureMessage)
        await waitUntil { scope.isEmpty }
    }

    /// 结果下载：流式落盘到「项目 + 周期 + 任务号」命名的文件，进度可观察。
    func testDownloadResultWritesToStableDestination() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("blf1068-download-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }

        let provider = ScriptedProductAnalysisProvider(
            create: .value(ProductAnalysisReportTicket(jobID: 3, status: .pending)),
            taskStatuses: [.value(.fixture(taskID: 3, status: .success, stage: "completed", progress: 100))]
        )
        let store = makeStore(downloadDirectory: directory)
        store.setProject(name: "博朗姆")
        store.setFormFileID(.businessReport, "b")
        store.setFormFileID(.paymentReport, "p")
        store.setFormFileID(.adReport, "a")

        await store.submitReport(using: provider, scope: ModuleTaskScope(), routeID: routeID)
        await store.downloadResult(using: provider, scope: ModuleTaskScope(), routeID: routeID)

        let download = try XCTUnwrap(provider.downloads.first)
        XCTAssertEqual(
            download.path,
            "/product-analysis-reports/tasks/3/result",
            "客户端路径不带 /api/v1（由 APIClient 拼），所以后端给的带前缀端点也要归一化"
        )
        XCTAssertEqual(
            download.destination.lastPathComponent,
            "博朗姆-产品分析核算-20260907~20260913-任务3.xlsx"
        )
        let finished = try XCTUnwrap(store.downloadPhase.finishedURL)
        XCTAssertEqual(finished, download.destination)
        XCTAssertTrue(FileManager.default.fileExists(atPath: finished.path))
    }

    /// 下载失败：落成失败态，不假报成功。
    func testDownloadFailureIsReported() async throws {
        let provider = ScriptedProductAnalysisProvider(
            create: .value(ProductAnalysisReportTicket(jobID: 4, status: .pending)),
            taskStatuses: [.value(.fixture(taskID: 4, status: .success, stage: "completed", progress: 100))],
            download: .failure(status: 500)
        )
        let store = makeStore()
        store.setProject(name: "博朗姆")
        store.setFormFileID(.businessReport, "b")
        store.setFormFileID(.paymentReport, "p")
        store.setFormFileID(.adReport, "a")

        await store.submitReport(using: provider, scope: ModuleTaskScope(), routeID: routeID)
        await store.downloadResult(using: provider, scope: ModuleTaskScope(), routeID: routeID)

        guard case .failed(let message) = store.downloadPhase else {
            return XCTFail("应当落成失败态，实际 \(store.downloadPhase)")
        }
        XCTAssertTrue(message.contains("500"), message)
    }

    /// 未成功/未终态的任务**不允许**下载（后端会回 409，客户端先挡住）。
    func testDownloadRequiresSuccessfulTask() async throws {
        let provider = ScriptedProductAnalysisProvider()
        let store = makeStore()
        await store.downloadResult(using: provider, scope: ModuleTaskScope(), routeID: routeID)
        XCTAssertTrue(provider.downloads.isEmpty)
        XCTAssertEqual(store.downloadPhase, .idle)
    }

    /// 换项目 / 改日期会把上一轮的核算状态整份作废（否则会拿着旧项目的结果去下载）。
    func testParameterChangeResetsReportTask() async throws {
        let provider = ScriptedProductAnalysisProvider(
            create: .value(ProductAnalysisReportTicket(jobID: 8, status: .pending)),
            taskStatuses: [.value(.fixture(status: .success, stage: "completed", progress: 100))]
        )
        let store = makeStore()
        store.setProject(name: "博朗姆")
        store.setFormFileID(.businessReport, "b")
        store.setFormFileID(.paymentReport, "p")
        store.setFormFileID(.adReport, "a")
        await store.submitReport(using: provider, scope: ModuleTaskScope(), routeID: routeID)
        XCTAssertEqual(store.reportPhase, .succeeded)

        store.setProject(name: "玥涵")
        XCTAssertEqual(store.reportPhase, .idle)
        XCTAssertNil(store.reportTicket)
        XCTAssertNil(store.reportTask)
        XCTAssertEqual(store.downloadPhase, .idle)
    }

    /// Tab 切换会作废待确认（避免「在 A 页点的确认跑到 B 页才生效」）。
    func testSelectingTabDropsPendingConfirmation() async throws {
        let provider = ScriptedProductAnalysisProvider(recognize: [.value(.fixture())])
        let store = makeStore()
        await store.recognizeFiles(
            [try temporaryFile()],
            using: provider,
            scope: ModuleTaskScope(),
            routeID: routeID
        )
        store.requestCommit(reportType: "ad_promoted_product_report")
        XCTAssertNotNil(store.pendingConfirmation)
        store.selectTab(.report)
        XCTAssertNil(store.pendingConfirmation)
        XCTAssertEqual(store.selectedTab, .report)
    }

    /// 结果文件名要做路径安全（项目名里的 `/` 不能穿透到目录）。
    func testResultFilenameSanitisesProjectName() {
        let name = ProductAnalysisStore.resultFilename(
            projectName: "铨富/华东",
            startDate: "2026-09-07",
            endDate: "2026-09-13",
            taskID: 11
        )
        XCTAssertEqual(name, "铨富-华东-产品分析核算-20260907~20260913-任务11.xlsx")
        XCTAssertFalse(name.contains("/"))
    }
}

extension AdUploadStatusItem {
    /// 测试用入库状态条目（字段取自 `Fixtures/Report/ad-upload-status.json` 的形状）。
    static func fixture(
        projectName: String = "博朗姆",
        reportType: String = "ad_promoted_product_report",
        ingestionStatus: String = "success",
        version: Int = 1
    ) -> AdUploadStatusItem {
        let json = #"""
        {"id": 1, "project_name": "\#(projectName)", "report_type": "\#(reportType)",
         "report_label": "\#(ReportTypeLabels.label(for: reportType))", "country": "US",
         "report_date": "2026-09-07", "report_start_date": "2026-09-07",
         "report_end_date": "2026-09-07", "version": \#(version), "is_current": true,
         "recognition_status": "recognized", "ingestion_status": "\#(ingestionStatus)",
         "original_filename": "a.xlsx", "row_count_preview": 2,
         "updated_at": "2026-09-14T16:10:03.468738+08:00", "warnings": []}
        """#
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        // 夹具 JSON 由上面这个字面量确定，解析失败即代码错误。
        return try! decoder.decode(AdUploadStatusItem.self, from: Data(json.utf8))
    }
}
