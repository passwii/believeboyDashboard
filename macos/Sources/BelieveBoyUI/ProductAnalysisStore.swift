import BelieveBoyKit
import Foundation
import Observation

/// 「报表中心 → 产品分析」（`/dashboard/reports/product-analysis`）的视图状态。
///
/// 这是本计划（PLAN §8）的**第一条真实写链路**，因此同时承担 S6 的写操作口径：
///
/// | 口径（issue BLF-1068） | 落点 |
/// | --- | --- |
/// | 识别 → 确认 → 提交三步对用户可见 | `UploadItem`（识别结果）+ `pendingConfirmation`（待确认摘要）+ `confirmPendingCommit`（唯一写入口） |
/// | 失败可重试且不产生半成品 | 失败只改 `commit` 档，识别结果 / 日期 / 项目一律保留；已提交的卡再点提交会走「覆盖确认」而不是重复写入 |
/// | 审计可查 | 确认摘要里逐行列「谁 / 何时 / 哪个项目 / 哪种报表类型 / 写什么」；响应里的 `version` / `is_current` / `message` 留在结果里 |
/// | 不可逆操作不可一键完成 | 提交必须经 `requestCommit` → 确认摘要 → `confirmPendingCommit` 两步 |
/// | 长任务不裸写轮询 | `reportPhase` 由 `PollingPolicy`（退避 + 上限）+ 注入的 `PollSleeper` 驱动，可取消 |
/// | 切页 / 切模块不泄漏 Task | 每次 `scope.run(key:)` 用 `TaskPurpose.key(routeID, …)` 登记，外壳按 route id 整棵树取消 |
///
/// 状态住在 `NavigationStore`（不是视图）：切走再回来不该重新识别、也不该丢掉已提交的 file id。
@MainActor
@Observable
public final class ProductAnalysisStore {
    /// 任务 key 的用途后缀（外壳切模块时按 `routeID` 整棵树取消，见 `ModuleTaskScope.cancelTree`）。
    public enum TaskPurpose {
        public static let projects = "pa-projects"
        public static let recognize = "pa-recognize"
        public static let commit = "pa-commit"
        public static let statuses = "pa-statuses"
        public static let create = "pa-create"
        public static let poll = "pa-poll"
        public static let download = "pa-download"

        public static func key(_ routeID: String, _ purpose: String) -> String {
            "\(routeID):\(purpose)"
        }
    }

    // MARK: - 上报链路

    /// 一条上传链路的归属。
    ///
    /// 本批的端点面只有 `ad-upload` 三件套，故三类报表里只有**广告报告**能走完整链路；
    /// 业务 / 付款报告在 Web 侧走 `/report-upload`（A 表，`uploads.py`），本批刻意没搬
    /// （issue 的范围只列了 `ad-upload`）。这里把它显式写成「未搬 + 为什么」，
    /// 而不是画一个点了没反应的按钮。
    public enum UploadChain: Sendable, Equatable {
        case adUpload
        case notPortedYet(String)

        public var isUsable: Bool { self == .adUpload }

        public var note: String? {
            if case .notPortedYet(let reason) = self { return reason }
            return nil
        }
    }

    /// 一张报表卡片的静态配置（Web `PRODUCT_ANALYSIS_CARD_CONFIGS`）。
    public struct CardConfig: Sendable, Equatable, Identifiable {
        public let reportType: String
        public let title: String
        public let subtitle: String
        public let chain: UploadChain

        public var id: String { reportType }
    }

    /// Web 的 `PRODUCT_ANALYSIS_TYPES`（顺序照抄）。
    public static let cardConfigs: [CardConfig] = [
        CardConfig(
            reportType: "business_report",
            title: "业务报告",
            subtitle: "流量、销量、会话数据（单日）",
            chain: .notPortedYet("业务报告在 Web 侧走 /report-upload（A 表）链路，本批未搬")
        ),
        CardConfig(
            reportType: "ad_promoted_product_report",
            title: "广告报告",
            subtitle: "广告曝光、点击、花费（单日）",
            chain: .adUpload
        ),
        CardConfig(
            reportType: "payment_report",
            title: "付款报告",
            subtitle: "佣金、FBA 费用、退款（周期）",
            chain: .notPortedYet("付款报告在 Web 侧走 /report-upload（A 表）链路，本批未搬")
        ),
    ]

    /// 识别结果 + 入库进度（一个本地文件一条）。
    public struct UploadItem: Identifiable, Equatable, Sendable {
        public enum Recognition: Equatable, Sendable {
            case pending
            case recognized(AdUploadRecognition)
            /// 识别失败（后端 400 / 传输失败）—— 错误文案由 `commit`/`recognition` 两侧共用。
            case failed(String)
            /// 识别被中断（切页 / 切模块 / 又选了一批文件）。
            ///
            /// 与 `.failed` 分开：**取消不是失败**（PLAN §3 的取消口径）—— 界面上不该出现
            /// 一条「识别失败」的红条，那会让人以为文件有问题；也不能留着「识别中」永远转圈。
            case cancelled

            public var response: AdUploadRecognition? {
                if case .recognized(let value) = self { return value }
                return nil
            }

            public var isPending: Bool { self == .pending }
        }

        public enum Commit: Equatable, Sendable {
            case idle
            case saving
            case committed
            case failed(String)

            public var isSaving: Bool { self == .saving }
            public var failureMessage: String? {
                if case .failed(let message) = self { return message }
                return nil
            }

            public var isCommitted: Bool { self == .committed }
        }

        public let id: UUID
        public let filename: String
        /// 识别时读的本地路径（按块流式上传，不进内存）。
        public let fileURL: URL
        public var recognition: Recognition = .pending
        public var commit: Commit = .idle
        /// 入库响应的原样保留（`file_id` / `version` / `message` 都要给用户看）。
        public var result: AdUploadCommitResult?

        public init(id: UUID = UUID(), filename: String, fileURL: URL) {
            self.id = id
            self.filename = filename
            self.fileURL = fileURL
        }
    }

    /// 一张卡片的可变状态。
    public struct CardState: Equatable, Sendable {
        /// 该卡片当前选中的文件（识别出该类型的最新一条）。
        public var activeItemID: UUID?
        /// 用户为这次确认选的项目（识别能唯一命中时预填）。
        public var selectedProject: String = ""
        public var reportDate: String = ""
        public var startDate: String = ""
        public var endDate: String = ""

        public init() {}
    }

    /// 待确认的提交（二次确认的载体）。
    public struct CommitConfirmation: Equatable, Sendable {
        public let reportType: String
        public let title: String
        public let itemID: UUID
        /// 逐行的「即将写入什么」。
        public let summary: [String]
        /// 这张卡之前已经成功提交过 → 这次是新版本（覆盖既有数据），确认文案要说清。
        public let isOverwrite: Bool
    }

    /// 发起核算的表单（三个 file id 是必填，第四个可选）。
    public struct ReportForm: Equatable, Sendable {
        public var businessReportFileID: String = ""
        public var paymentReportFileID: String = ""
        public var adReportFileID: String = ""
        public var inventoryReportFileID: String = ""

        public init() {}

        /// 库存报告的 file id 留空即视为不传（后端同判据：`strip()` 后非空才认）。
        var resolvedInventoryFileID: String? { inventoryReportFileID.trimmedNonEmpty }
    }

    /// 异步核算任务的阶段。
    public enum ReportPhase: Equatable, Sendable {
        case idle
        case submitting
        case running
        case succeeded
        case failed(String)

        public var isBusy: Bool { self == .submitting || self == .running }
        public var failureMessage: String? {
            if case .failed(let message) = self { return message }
            return nil
        }
    }

    /// 结果下载的阶段。
    public enum DownloadPhase: Equatable, Sendable {
        case idle
        case downloading(Double?)
        case finished(URL)
        case failed(String)

        public var isDownloading: Bool {
            if case .downloading = self { return true }
            return false
        }

        public var failureMessage: String? {
            if case .failed(let message) = self { return message }
            return nil
        }

        public var finishedURL: URL? {
            if case .finished(let url) = self { return url }
            return nil
        }
    }

    /// 页内 Tab。
    ///
    /// 放 store 而不是视图：视图是值类型、重绘即重建，放视图里等于「切走再回来又跳回第一个
    /// Tab」。与 `NavigationStore.agentOverview` 那条「状态住外壳」的理由同源。
    public enum Tab: String, CaseIterable, Sendable, Identifiable {
        /// 识别 → 确认 → 提交（本批的写链路）。
        case upload
        /// 发起产品分析核算（异步任务 + 结果下载）。
        case report

        public var id: String { rawValue }

        public var title: String {
            switch self {
            case .upload: return "识别与提交"
            case .report: return "产品分析核算"
            }
        }

        public var symbol: String {
            switch self {
            case .upload: return "square.and.arrow.up"
            case .report: return "chart.bar.doc.horizontal"
            }
        }
    }

    public private(set) var selectedTab: Tab = .upload

    /// 拖拽文件悬停在投放区上（纯视图态，同样住 store）。
    public private(set) var isDropTargeted = false

    // MARK: - 状态

    /// 核算参数（三个 Tab 共用的同一组参数：项目 / 站点 / 日期范围）。
    ///
    /// 共用而不是各存一份：两处 Tab 的语义就是「同一个核算周期」的不同动作（识别入库 vs
    /// 发起核算），各存一份只会让「切 Tab 后日期悄悄变了」变成一个 bug 来源。
    public private(set) var projectName: String = ""
    public private(set) var country: String = ReportCatalog.defaultCountry
    public private(set) var startDate: String
    public private(set) var endDate: String

    public private(set) var projects: [AdProject] = []
    public private(set) var projectsPhase: AdLoadPhase = .idle

    /// 本页签内已识别的文件（识别结果先呈现 → 用户确认 → 才提交）。
    public private(set) var items: [UploadItem] = []
    /// 逐卡状态（键 = `CardConfig.reportType`）。
    public private(set) var cardStates: [String: CardState]
    public private(set) var isRecognizing = false
    /// 待确认的提交；非 nil 时视图必须先把摘要画出来（这是「不可一键完成」的落点）。
    public private(set) var pendingConfirmation: CommitConfirmation?
    /// 已提交过的卡片（`reportType`）—— 用来把「再次提交」标成覆盖。
    public private(set) var committedTypes: Set<String> = []

    /// 入库状态表（`GET /ad-upload/status`）。
    public private(set) var statusesPhase: AdLoadPhase = .idle
    public private(set) var statuses: [AdUploadStatusItem] = []
    /// 有旧数据、最近一次刷新失败的提示（口径：保留旧表而不是打成错误页）。
    public private(set) var statusesRefreshFailure: String?
    public private(set) var statusesLoadedAt: Date?

    /// 发起核算的表单与任务状态。
    public private(set) var form = ReportForm()
    public private(set) var reportPhase: ReportPhase = .idle
    public private(set) var reportTicket: ProductAnalysisReportTicket?
    public private(set) var reportTask: ProductAnalysisTaskStatus?
    public private(set) var downloadPhase: DownloadPhase = .idle

    /// 轮询策略（测试注入小上限档，生产用 `.job`）。
    public let pollingPolicy: PollingPolicy
    /// 睡觉的注入点（测试注入「立刻返回 + 记录时长」）。
    public let sleeper: PollSleeper
    /// 结果落盘目录的解析（默认 `~/Downloads`）。
    public let downloadDirectory: @Sendable () -> URL

    // MARK: - 内部

    private var recognitionToken: UUID?
    private var commitTokens: [String: UUID] = [:]
    private var projectsToken: UUID?
    private var statusesToken: UUID?
    private var reportToken: UUID?
    private var downloadToken: UUID?

    public init(
        projectName: String = "",
        country: String = ReportCatalog.defaultCountry,
        dateRange: (start: String, end: String) = ReportDateRanges.lastWeek(),
        pollingPolicy: PollingPolicy = .job,
        sleeper: PollSleeper = .task,
        downloadDirectory: @escaping @Sendable () -> URL = {
            FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
                ?? URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        }
    ) {
        self.projectName = projectName
        self.country = country
        self.startDate = dateRange.start
        self.endDate = dateRange.end
        self.pollingPolicy = pollingPolicy
        self.sleeper = sleeper
        self.downloadDirectory = downloadDirectory
        self.cardStates = Dictionary(
            uniqueKeysWithValues: Self.cardConfigs.map { ($0.reportType, CardState()) }
        )
    }

    // MARK: - 派生

    public var dateRangeValid: Bool {
        !startDate.isEmpty && !endDate.isEmpty && startDate <= endDate
    }

    /// 项目列表这道闸门（与广告两页同一套语义：没项目就发不出任何明细请求）。
    public var projectGate: AdProjectGate {
        if let message = projectsPhase.failureMessage { return .failed(message) }
        if projectsPhase.isLoading { return .pending }
        if case .loaded = projectsPhase {
            return projects.isEmpty ? .noProjects : .ready
        }
        return .pending
    }

    public var selectedProject: AdProject? {
        projects.first { $0.name == projectName }
    }

    /// 广告卡片的已接入链路（本批唯一能走完整写链路的类型）。
    public static var writableCard: CardConfig { cardConfigs[1] }

    public func state(for reportType: String) -> CardState {
        cardStates[reportType] ?? CardState()
    }

    /// 该卡片可作为候选的文件（识别为该类型且成功）。
    public func candidates(for reportType: String) -> [UploadItem] {
        items.filter { $0.recognition.response?.reportType == reportType }
    }

    /// 该卡片当前选中的条目。
    public func activeItem(for reportType: String) -> UploadItem? {
        let state = state(for: reportType)
        if let id = state.activeItemID, let match = items.first(where: { $0.id == id }) {
            return match
        }
        return candidates(for: reportType).last
    }

    /// 该卡片当前的识别结果（`nil` = 还没识别到）。
    public func recognition(for reportType: String) -> AdUploadRecognition? {
        activeItem(for: reportType)?.recognition.response
    }

    /// 该卡片当前是否已成功提交。
    public func isCommitted(_ reportType: String) -> Bool {
        committedTypes.contains(reportType)
    }

    /// 确认前的阻塞项（空数组 = 可以确认）。
    public func blockers(for reportType: String) -> [AdUploadConfirmBlocker] {
        guard let config = Self.cardConfigs.first(where: { $0.reportType == reportType }),
              config.chain.isUsable
        else { return [.notRecognized] }
        guard let recognition = recognition(for: reportType) else { return [.notRecognized] }
        let state = state(for: reportType)
        return recognition.confirmBlockers(
            selectedProject: state.selectedProject,
            startDate: state.startDate,
            endDate: state.endDate
        )
    }

    /// 可以点「确认保存」吗（未提交过、不在保存中、没有阻塞项）。
    public func canCommit(_ reportType: String) -> Bool {
        guard !isCommitted(reportType) else { return false }
        guard let item = activeItem(for: reportType), !item.commit.isSaving else { return false }
        return blockers(for: reportType).isEmpty
    }

    /// 「重新提交」是否可用（已提交过的卡片：允许重来，但会走覆盖确认）。
    public func canRecommit(_ reportType: String) -> Bool {
        guard isCommitted(reportType) else { return false }
        guard let item = activeItem(for: reportType), !item.commit.isSaving else { return false }
        return blockers(for: reportType).isEmpty
    }

    /// 入库状态表的展示态。
    public enum StatusTableState: Equatable, Sendable {
        case loading
        case failed(String)
        case empty
        case ready
    }

    public var statusTableState: StatusTableState {
        if !statuses.isEmpty { return .ready }
        if let message = statusesPhase.failureMessage { return .failed(message) }
        // 「已加载但列表为空」是**空态**，不是「加载中」—— 这两者混起来，界面会永远转圈。
        if case .loaded = statusesPhase { return .empty }
        return .loading
    }

    /// 核算表单是否可提交。
    public var canSubmitReport: Bool { reportFormRequest?.isSubmittable == true }

    /// 表单 → 请求体（不可提交时返回 nil，并把逐条原因交给 `reportFormBlockers`）。
    public var reportFormRequest: ProductAnalysisReportRequest? {
        ProductAnalysisReportRequest(
            projectName: projectName,
            reportStartDate: startDate,
            reportEndDate: endDate,
            businessReportFileID: form.businessReportFileID,
            paymentReportFileID: form.paymentReportFileID,
            adReportFileID: form.adReportFileID,
            inventoryReportFileID: form.resolvedInventoryFileID,
            country: country
        )
    }

    public var reportFormBlockers: [ProductAnalysisRequestBlocker] {
        reportFormRequest?.blockers ?? []
    }

    // MARK: - 核算参数

    public func setProject(name: String) {
        guard projectName != name else { return }
        projectName = name
        // 换项目 = 换核算对象：三类报表的识别结果都属于旧项目，留着只会写错库。
        // 与 Web 同口径（换项目会清空候选与下游状态）。
        for config in Self.cardConfigs {
            var state = state(for: config.reportType)
            state.selectedProject = name
            cardStates[config.reportType] = state
        }
        resetReportTask()
    }

    public func setCountry(_ value: String) {
        guard country != value else { return }
        country = value
    }

    public func setDateRange(start: String, end: String) {
        guard startDate != start || endDate != end else { return }
        startDate = start
        endDate = end
        // 日期变了 → 待确认的提交作废（否则会用旧日期写库）。
        pendingConfirmation = nil
        resetReportTask()
    }

    public func setCardProject(_ reportType: String, _ value: String) {
        var state = state(for: reportType)
        guard state.selectedProject != value else { return }
        state.selectedProject = value
        cardStates[reportType] = state
        pendingConfirmation = nil
    }

    public func setCardDates(_ reportType: String, start: String, end: String) {
        var state = state(for: reportType)
        guard state.startDate != start || state.endDate != end else { return }
        state.startDate = start
        state.endDate = end
        if start == end {
            state.reportDate = start
        } else {
            state.reportDate = state.reportDate.isEmpty ? end : state.reportDate
        }
        cardStates[reportType] = state
        pendingConfirmation = nil
    }

    /// 选中某个候选文件（多份同类型文件时用）。
    public func selectCandidate(_ reportType: String, itemID: UUID) {
        var state = state(for: reportType)
        guard state.activeItemID != itemID else { return }
        state.activeItemID = itemID
        if let recognition = items.first(where: { $0.id == itemID })?.recognition.response {
            state.reportDate = recognition.detectedReportDate ?? recognition.detectedEndDate ?? ""
            state.startDate = recognition.detectedStartDate
                ?? recognition.detectedReportDate ?? state.startDate
            state.endDate = recognition.detectedEndDate
                ?? recognition.detectedReportDate ?? state.endDate
        }
        cardStates[reportType] = state
        pendingConfirmation = nil
    }

    public func removeItem(id: UUID) {
        items.removeAll { $0.id == id }
        for config in Self.cardConfigs {
            if state(for: config.reportType).activeItemID == id {
                var state = state(for: config.reportType)
                state.activeItemID = nil
                cardStates[config.reportType] = state
            }
        }
        pendingConfirmation = nil
    }

    public func clearItems() {
        items = []
        committedTypes = []
        for config in Self.cardConfigs {
            var state = CardState()
            state.selectedProject = projectName
            cardStates[config.reportType] = state
        }
        pendingConfirmation = nil
    }

    public func setFormFileID(_ field: ReportFormField, _ value: String) {
        switch field {
        case .businessReport: form.businessReportFileID = value
        case .paymentReport: form.paymentReportFileID = value
        case .adReport: form.adReportFileID = value
        case .inventoryReport: form.inventoryReportFileID = value
        }
    }

    public func selectTab(_ tab: Tab) {
        guard selectedTab != tab else { return }
        selectedTab = tab
        // 换 Tab 取消上一页挂着的确认（避免「在 A 页点的确认跑到 B 页才生效」）。
        pendingConfirmation = nil
    }

    public func setDropTargeted(_ targeted: Bool) {
        guard isDropTargeted != targeted else { return }
        isDropTargeted = targeted
    }

    /// 拖入本地文件（只接 `file://`；目录与非文件 URL 一律忽略）。
    public func handleDrop(_ urls: [URL]) -> Bool {
        let files = urls.filter { $0.isFileURL }
        guard !files.isEmpty else { return false }
        droppedFiles = files
        return true
    }

    /// 待识别的拖入文件（视图取走后再调 `consumeDroppedFiles` —— 视图不能直接发起请求，
    /// 它拿不到 provider；由视图的 `.task(id:)` 观察这个值来触发）。
    public private(set) var droppedFiles: [URL] = []

    public func consumeDroppedFiles() -> [URL] {
        let files = droppedFiles
        droppedFiles = []
        return files
    }

    /// 打开文件选择面板的结果交给它（与拖拽同一条路径）。
    public func enqueueFiles(_ urls: [URL]) {
        let files = urls.filter { $0.isFileURL }
        guard !files.isEmpty else { return }
        droppedFiles = files
    }

    /// 把某张卡片刚提交成功的 `file_id` 带入核算表单（广告报告这一项）。
    public func adoptCommittedFileID(from reportType: String) {
        guard reportType == Self.writableCard.reportType,
              let item = activeItem(for: reportType),
              let result = item.result
        else { return }
        form.adReportFileID = result.fileID
    }

    /// 没有可用凭据（未登录）：不发请求，只把闸门标红。
    public func failWithoutCredential() {
        projectsPhase = .failed("尚未登录，无法加载产品分析数据。")
    }

    // MARK: - 项目 / 入库状态加载

    /// 进页加载：项目列表 + 入库状态表。
    public func load(
        using provider: ProductAnalysisDataProviding,
        scope: ModuleTaskScope,
        routeID: String,
        now: Date = Date()
    ) async {
        await scope.run(key: TaskPurpose.key(routeID, TaskPurpose.projects)) { [weak self] in
            await self?.loadProjects(using: provider)
        }.value
        await loadStatuses(using: provider, scope: scope, routeID: routeID, now: now)
    }

    func loadProjects(using provider: ProductAnalysisDataProviding) async {
        let token = UUID()
        projectsToken = token
        projectsPhase = .loading
        let outcome = await Self.capture { try await provider.projects() }
        guard projectsToken == token else { return }
        guard !Task.isCancelled else {
            projectsPhase = projects.isEmpty ? .idle : .loaded
            return
        }
        switch outcome {
        case .success(let list):
            projects = list
            projectsPhase = .loaded
            if projectName.isEmpty, let first = list.first {
                setProject(name: first.name)
            }
        case .failure(let message):
            projectsPhase = projects.isEmpty ? .failed(message) : .loaded
            if projects.isEmpty { projectsPhase = .failed(message) }
        }
    }

    /// 刷新入库状态表。刷新失败**保留旧表**（口径 2）。
    public func loadStatuses(
        using provider: ProductAnalysisDataProviding,
        scope: ModuleTaskScope? = nil,
        routeID: String? = nil,
        now: Date = Date()
    ) async {
        let run: @MainActor () async -> Void = { [weak self] in
            await self?.performLoadStatuses(using: provider, now: now)
        }
        if let scope, let routeID {
            await scope.run(key: TaskPurpose.key(routeID, TaskPurpose.statuses), operation: run).value
        } else {
            await run()
        }
    }

    func performLoadStatuses(using provider: ProductAnalysisDataProviding, now: Date) async {
        let token = UUID()
        statusesToken = token
        if statuses.isEmpty { statusesPhase = .loading }
        let outcome = await Self.capture {
            try await provider.adUploadStatuses(AdUploadStatusQuery(country: self.country))
        }
        guard statusesToken == token, !Task.isCancelled else {
            if statuses.isEmpty { statusesPhase = .idle }
            return
        }
        switch outcome {
        case .success(let response):
            statuses = response.items
            statusesPhase = .loaded
            statusesLoadedAt = now
            statusesRefreshFailure = nil
        case .failure(let message):
            if statuses.isEmpty {
                statusesPhase = .failed(message)
                statusesRefreshFailure = nil
            } else {
                statusesPhase = .loaded
                statusesRefreshFailure = message
            }
        }
    }

    // MARK: - 识别（写链路第一步）

    /// 识别一组本地文件。
    ///
    /// 逐条**串行**而不是并发：识别结果要按用户选择的顺序呈现，且一条失败不该让整批
    /// 静默（Web 的 `Promise.all` 会把失败项落成 `unknown`，桌面端保留同样的「失败也进列表」，
    /// 但顺带把失败原因显示出来）。
    public func recognizeFiles(
        _ files: [URL],
        using provider: ProductAnalysisDataProviding,
        scope: ModuleTaskScope,
        routeID: String
    ) async {
        guard !files.isEmpty else { return }
        let token = UUID()
        recognitionToken = token
        isRecognizing = true

        let newItems = files.map { url in
            UploadItem(filename: url.lastPathComponent, fileURL: url)
        }
        items.append(contentsOf: newItems)

        await scope.run(key: TaskPurpose.key(routeID, TaskPurpose.recognize)) { [weak self] in
            guard let self else { return }
            for item in newItems {
                guard self.recognitionToken == token, !Task.isCancelled else { break }
                let outcome = await Self.capture {
                    try await provider.recognizeAdUpload(
                        fileURL: item.fileURL,
                        filename: item.filename,
                        country: self.country
                    )
                }
                guard self.recognitionToken == token, !Task.isCancelled else { break }
                self.applyRecognition(outcome, itemID: item.id)
            }
            guard self.recognitionToken == token else { return }
            // 中断时把还没轮到的那几条标成「已中断」：既不留「识别中」永远转圈，
            // 也不把它们写成「失败」（取消不是失败）。
            self.markPendingItemsAsCancelled()
            self.isRecognizing = false
        }.value
    }

    private func markPendingItemsAsCancelled() {
        for index in items.indices where items[index].recognition.isPending {
            items[index].recognition = .cancelled
        }
    }

    private func applyRecognition(
        _ outcome: LoadOutcome<AdUploadRecognition>,
        itemID: UUID
    ) {
        guard let index = items.firstIndex(where: { $0.id == itemID }) else { return }
        switch outcome {
        case .success(let recognition):
            items[index].recognition = .recognized(recognition)
            items[index].commit = .idle
            // 识别成功即为该类型卡片预填「即将写入的内容」—— 用户看到的必须是**识别器给的**
            // 判据（项目 / 日期），不是客户端猜的。
            guard let config = Self.cardConfigs.first(where: { $0.reportType == recognition.reportType })
            else { return }
            var state = state(for: config.reportType)
            state.activeItemID = itemID
            state.selectedProject = state.selectedProject.trimmedNonEmpty
                ?? recognition.projectMatch.projectName
                ?? projectName
            state.reportDate = recognition.detectedReportDate ?? recognition.detectedEndDate ?? ""
            state.startDate = recognition.detectedStartDate ?? recognition.detectedReportDate ?? startDate
            state.endDate = recognition.detectedEndDate ?? recognition.detectedReportDate ?? endDate
            cardStates[config.reportType] = state
        case .failure(let message):
            items[index].recognition = .failed(message)
        }
    }

    // MARK: - 确认（写链路第二步）

    /// 请求提交某张卡片 —— **只生成待确认摘要，不发请求**。
    public func requestCommit(reportType: String) {
        guard let config = Self.cardConfigs.first(where: { $0.reportType == reportType }),
              config.chain.isUsable,
              let item = activeItem(for: reportType),
              let recognition = item.recognition.response
        else { return }
        let state = state(for: reportType)
        let isOverwrite = isCommitted(reportType)
        var summary: [String] = [
            "报表类型：\(recognition.displayLabel)（\(recognition.reportType)）",
            "来源文件：\(item.filename)",
            "项目：\(state.selectedProject)",
            "站点：\(country)",
        ]
        if AdUploadReportTypes.requiresDateRange(reportType) {
            summary.append("日期范围：\(state.startDate) ~ \(state.endDate)")
        } else {
            summary.append("报表日期：\(state.reportDate)")
        }
        summary.append("识别行数预览：\(recognition.rowCountPreview.map(String.init) ?? "未提供")")
        summary.append("写入范围：仅识别校验 + 临时文件复制（dry_run，不写业务表）")
        if isOverwrite {
            summary.append("⚠️ 该类型此前已提交过一次，本次将产生新的临时文件与版本")
        }
        pendingConfirmation = CommitConfirmation(
            reportType: reportType,
            title: config.title,
            itemID: item.id,
            summary: summary,
            isOverwrite: isOverwrite
        )
    }

    public func cancelPendingCommit() {
        pendingConfirmation = nil
    }

    /// 确认待确认的提交（`Alert` / 确认条的确认按钮）—— **唯一的写入口**。
    public func confirmPendingCommit(
        using provider: ProductAnalysisDataProviding,
        scope: ModuleTaskScope,
        routeID: String
    ) async {
        guard let confirmation = pendingConfirmation else { return }
        pendingConfirmation = nil
        await commit(
            reportType: confirmation.reportType,
            itemID: confirmation.itemID,
            using: provider,
            scope: scope,
            routeID: routeID
        )
    }

    /// 真正发 `commit`。
    ///
    /// - Parameter itemID: **归属**。确认期间用户可能已经换了候选文件，此时这次提交必须
    ///   落到原来那份文件上（否则「确认的是 A，写进去的是 B」）。
    func commit(
        reportType: String,
        itemID: UUID,
        using provider: ProductAnalysisDataProviding,
        scope: ModuleTaskScope,
        routeID: String
    ) async {
        guard let index = items.firstIndex(where: { $0.id == itemID }),
              let recognition = items[index].recognition.response
        else { return }
        let state = state(for: reportType)
        let request = AdUploadCommitRequest(
            tempFileID: recognition.tempFileID,
            reportType: recognition.reportType,
            originalFilename: recognition.originalFilename.trimmedNonEmpty ?? items[index].filename,
            projectName: state.selectedProject,
            country: country,
            reportDate: state.reportDate.trimmedNonEmpty ?? recognition.detectedReportDate,
            reportStartDate: state.startDate.trimmedNonEmpty ?? recognition.detectedStartDate,
            reportEndDate: state.endDate.trimmedNonEmpty ?? recognition.detectedEndDate,
            // 与 Web 两处手动核算面板一致：只做识别校验 + 临时文件复制，不写业务表。
            dryRun: true
        )

        let token = UUID()
        commitTokens[reportType] = token
        items[index].commit = .saving
        items[index].result = nil

        await scope.run(key: TaskPurpose.key(routeID, TaskPurpose.commit)) { [weak self] in
            guard let self else { return }
            let outcome = await Self.capture { try await provider.commitAdUpload(request) }
            // 归属校验：更新的提交已经接管 → 不动状态（旧回包不许串写新状态）。
            guard self.commitTokens[reportType] == token, !Task.isCancelled else { return }
            guard let target = self.items.firstIndex(where: { $0.id == itemID }) else { return }
            switch outcome {
            case .success(let result):
                self.items[target].commit = .committed
                self.items[target].result = result
                self.committedTypes.insert(reportType)
                self.adoptCommittedFileID(from: reportType)
            case .failure(let message):
                // 失败**保留识别结果**（同一 `item` 的 `recognition` 一字不动）→ 可直接重试。
                self.items[target].commit = .failed(message)
            }
        }.value
    }

    // MARK: - 异步核算任务（写链路第三步）

    /// 发起核算并轮询到终态。
    public func submitReport(
        using provider: ProductAnalysisDataProviding,
        scope: ModuleTaskScope,
        routeID: String
    ) async {
        guard let request = reportFormRequest, request.isSubmittable else { return }
        let token = UUID()
        reportToken = token
        reportPhase = .submitting
        reportTask = nil
        reportTicket = nil
        downloadPhase = .idle

        await scope.run(key: TaskPurpose.key(routeID, TaskPurpose.create)) { [weak self] in
            guard let self else { return }
            let outcome = await Self.capture { try await provider.createProductAnalysisReport(request) }
            guard self.reportToken == token, !Task.isCancelled else { return }
            switch outcome {
            case .success(let ticket):
                self.reportTicket = ticket
                self.reportPhase = .running
                await self.pollReport(using: provider, scope: scope, routeID: routeID)
            case .failure(let message):
                self.reportPhase = .failed(message)
            }
        }.value
    }

    /// 轮询任务状态到终态。
    ///
    /// 退避 + 上限全部由 `PollingPolicy` 决定（不在这里数循环次数）；取消原样向上抛，
    /// 由 `ModuleTaskScope` 收尾，**取消不落错误态**（口径：切模块回来看到的必须是 idle）。
    func pollReport(
        using provider: ProductAnalysisDataProviding,
        scope: ModuleTaskScope,
        routeID: String
    ) async {
        guard let ticket = reportTicket else { return }
        let path = ticket.resolvedStatusPath
        let token = reportToken

        await scope.run(key: TaskPurpose.key(routeID, TaskPurpose.poll)) { [weak self] in
            guard let self else { return }
            do {
                let final = try await self.pollingPolicy.run(sleeper: self.sleeper) { _ in
                    let status = try await provider.productAnalysisTask(path: path)
                    // 每探到一次就落地一次：用户看到的进度不是「转圈 5 分钟」。
                    await MainActor.run { self.reportTask = status }
                    return status.isTerminal ? .finished(status) : .pending
                }
                guard self.reportToken == token, !Task.isCancelled else { return }
                self.reportTask = final
                if final.isSuccess {
                    self.reportPhase = .succeeded
                } else {
                    self.reportPhase = .failed(final.summaryText)
                }
            } catch is CancellationError {
                guard self.reportToken == token else { return }
                self.reportPhase = .idle
            } catch {
                guard self.reportToken == token, !Task.isCancelled else { return }
                self.reportPhase = .failed(Self.message(for: error))
            }
        }.value
    }

    /// 取消这次核算（停止轮询；后端任务本身照跑 —— 它没有取消端点）。
    public func cancelReport(scope: ModuleTaskScope, routeID: String) {
        // 换 token 让在跑的回包作废，再取消任务树：两道都要，单靠取消是异步的。
        reportToken = UUID()
        scope.cancel(key: TaskPurpose.key(routeID, TaskPurpose.poll))
        scope.cancel(key: TaskPurpose.key(routeID, TaskPurpose.create))
        reportPhase = reportTask?.isTerminal == true
            ? (reportTask?.isSuccess == true ? .succeeded : .failed(reportTask?.summaryText ?? ""))
            : .idle
    }

    /// 下载结果文件（**流式落盘**，不整份进内存）。
    public func downloadResult(
        using provider: ProductAnalysisDataProviding,
        scope: ModuleTaskScope,
        routeID: String
    ) async {
        guard let task = reportTask, task.hasDownloadableResult else { return }
        let ticket = reportTicket
        let path = ticket?.resolvedResultPath
            ?? ReportCatalog.productAnalysisResultEndpoint(taskID: task.taskID)
        let destination = downloadDirectory().appendingPathComponent(Self.resultFilename(
            projectName: projectName,
            startDate: startDate,
            endDate: endDate,
            taskID: task.taskID
        ))
        let token = UUID()
        downloadToken = token
        downloadPhase = .downloading(nil)

        await scope.run(key: TaskPurpose.key(routeID, TaskPurpose.download)) { [weak self] in
            guard let self else { return }
            let outcome = await Self.captureURL {
                try await provider.downloadProductAnalysisResult(path: path, to: destination) { progress in
                    Task { @MainActor in
                        guard self.downloadToken == token else { return }
                        self.downloadPhase = .downloading(progress.fraction)
                    }
                }
            }
            guard self.downloadToken == token, !Task.isCancelled else {
                return self.abandonDownload(token: token)
            }
            switch outcome {
            case .success(let url):
                self.downloadPhase = .finished(url)
            case .failure(let message):
                self.downloadPhase = .failed(message)
            }
        }.value
    }

    /// 结果文件名 —— 后端把它放在 `Content-Disposition` 里，而流式落盘路径拿不到响应头
    /// （`APIClient.download` 只回最终 URL）。用「项目 + 周期 + 任务号」自造一个稳定名字，
    /// 比落到一个 `result.xlsx` 更容易在 Finder 里认出来。
    static func resultFilename(
        projectName: String,
        startDate: String,
        endDate: String,
        taskID: Int
    ) -> String {
        let safeProject = projectName
            .replacingOccurrences(of: "/", with: "-")
            .replacingOccurrences(of: ":", with: "-")
            .trimmedNonEmpty ?? "未知项目"
        let start = startDate.replacingOccurrences(of: "-", with: "")
        let end = endDate.replacingOccurrences(of: "-", with: "")
        return "\(safeProject)-产品分析核算-\(start)~\(end)-任务\(taskID).xlsx"
    }

    private func abandonDownload(token: UUID) {
        guard downloadToken == token else { return }
        downloadPhase = .idle
    }

    private func resetReportTask() {
        reportToken = nil
        reportPhase = .idle
        reportTicket = nil
        reportTask = nil
        downloadPhase = .idle
    }

    // MARK: - 工具

    /// 字段枚举（避免字符串字面量散在视图里）。
    public enum ReportFormField: Sendable, Equatable {
        case businessReport
        case paymentReport
        case adReport
        case inventoryReport
    }

    enum LoadOutcome<Value: Sendable>: Sendable {
        case success(Value)
        case failure(String)
    }

    static func message(for error: Error) -> String {
        if let apiError = error as? APIError { return apiError.displayMessage }
        return error.localizedDescription
    }

    private static func capture<T: Sendable>(
        _ operation: @Sendable () async throws -> T
    ) async -> LoadOutcome<T> {
        do {
            return .success(try await operation())
        } catch {
            return .failure(message(for: error))
        }
    }

    /// 同 `capture`，但**不吞**取消 —— 下载中途取消要走 `abandonDownload` 而不是错误态。
    private static func captureURL(
        _ operation: @Sendable () async throws -> URL
    ) async -> LoadOutcome<URL> {
        do {
            return .success(try await operation())
        } catch {
            return .failure(message(for: error))
        }
    }
}
