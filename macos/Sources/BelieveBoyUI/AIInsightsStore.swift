import BelieveBoyKit
import Foundation
import Observation

/// 「AI 智能 → AI 洞察」的视图状态：洞察列表（分页 + 筛选）+ 明细 + 旧链路流式草稿 + 定时列表。
///
/// 五条口径决定了这个 store 的形状（BLF-1062）：
///
/// 1. **旧链路（`/ai-insights/*`）**：整型 id、状态词表 `pending | generating | completed |
///    failed`（细阶段在 `sub_status`），SSE 帧**不带 `id:`**、后端**不认 `Last-Event-ID`**
///    （`insight_runs.py` / `ai_chat_v2.py` 才认）。所以旧链路的「断线恢复」只能落成
///    「重连 + 回读 detail 权威快照」，不是游标续传 —— 这条差异写在 `InsightCatalog`
///    的两个布尔量里，不藏在实现里。
/// 2. **列表分页用后端 `total`**（窗口内总数），不用 `items.count`；`offset` 由本 store 持有，
///    切筛选即回第一页。
/// 3. **刷新失败保留旧表** + 一条黄条（`refreshFailure`），不闪空。
/// 4. **切筛选 / 切页 / 切模块都要取消在跑请求，且取消不落错误态**：所有请求经
///    `ModuleTaskScope.run(key: 当前 route id)` 登记，被取消的任务在写入前判 token。
/// 5. **不做写链路**：生成 / 重试 / 删除 / 定时 CRUD 全属 S6，这里一个写端点都没有。
///    定时列表只读。
///
/// 状态住在 `NavigationStore`（不是视图）：视图是值类型、重绘即重建 —— 放视图里等于
/// 「切走再回来 = 重新拉 + 翻页位置与选中洞察被重置」。
@MainActor
@Observable
public final class AIInsightsStore: AdFilterDriving {
    public typealias Phase = AdLoadPhase
    public typealias ProjectGate = AdProjectGate

    /// 旧链路明细 + 流式的状态。
    public struct DetailStream: Equatable {
        /// `idle`（没有在看的 run）/ `running` / `completed` / `failed`（Web 同词表）。
        public var status: String = "idle"
        public var subStatus: String?
        public var content: String = ""
        public var title: String?
        public var errorMessage: String?
        public var transport: InsightTransportState = .connecting
        /// 断线重连次数（面板上显示「已重连 N 次」）。
        public var reconnects: Int = 0
        /// 收到的帧类型序列（`status` / `ping` / `done` / `error`）—— 事件序列对照用。
        public var eventTypes: [String] = []
        public var isFinished: Bool = false

        public init() {}

        /// 面板状态（旧链路口径）。
        public var panel: InsightPanelState {
            InsightPanelMapping.legacy(
                status: status,
                subStatus: subStatus,
                transport: transport
            )
        }

        public var contentState: InsightContentStateAdapter {
            status == "completed" || status == "failed" ? .final : .draft
        }
    }

    /// 由视图 `.task(id:)` 驱动的列表加载键。
    public struct LoadKey: Equatable, Sendable {
        public let signature: AdQuerySignature
        public let insightType: String?
        public let offset: Int
        public let refreshTicket: Int
    }

    /// 由视图 `.task(id:)` 驱动的明细加载键。
    public struct DetailKey: Equatable, Sendable {
        public let insightID: Int?
        public let ticket: Int
    }

    public private(set) var filters: AdFilters
    /// 洞察类型筛选（`nil` = 全部，即不传 `insight_type`）。
    public private(set) var insightTypeFilter: String?
    public private(set) var projects: [AdProject] = []
    public private(set) var projectsPhase: Phase = .idle

    public private(set) var listPhase: Phase = .idle
    public private(set) var items: [InsightListItem] = []
    public private(set) var total = 0
    public private(set) var loadedAt: Date?
    public private(set) var refreshFailure: String?
    /// 最近一次成功加载的筛选签名（相同则不必重取）。
    public private(set) var loadedSignature: AdQuerySignature?
    public private(set) var loadedOffset: Int?
    public private(set) var loadedTicket = -1
    public private(set) var offset = 0
    public private(set) var refreshTicket = 0

    public private(set) var schedulesPhase: Phase = .idle
    public private(set) var schedules: [InsightScheduleItem] = []

    /// 当前正在看明细的洞察 id。
    public private(set) var detailID: Int?
    public private(set) var detailPhase: Phase = .idle
    public private(set) var detail: InsightDetail?
    public private(set) var detailTicket = 0
    public private(set) var stream = DetailStream()

    private var loadToken: UUID?
    private var projectsToken: UUID?
    private var detailToken: UUID?
    private var schedulesToken: UUID?
    /// 已加载定时列表的那组筛选（只有它变了才重取）。
    private var schedulesSignature: AdQuerySignature?
    private let reconnectDelay: Duration
    private let maxReconnects: Int

    public init(
        filters: AdFilters = AdFilters(),
        insightTypeFilter: String? = nil,
        reconnectDelay: Duration = .milliseconds(1500),
        maxReconnects: Int = 3
    ) {
        self.filters = filters
        self.insightTypeFilter = insightTypeFilter
        self.reconnectDelay = reconnectDelay
        self.maxReconnects = maxReconnects
    }

    // MARK: - 派生

    public var loadKey: LoadKey {
        LoadKey(
            signature: filters.signature,
            insightType: insightTypeFilter,
            offset: offset,
            refreshTicket: refreshTicket
        )
    }

    public var detailKey: DetailKey {
        DetailKey(insightID: detailID, ticket: detailTicket)
    }

    public var pageSize: Int { InsightCatalog.pageSize }

    public var page: Int { offset / pageSize + 1 }

    public var totalPages: Int { max(1, Int(ceil(Double(total) / Double(pageSize)))) }

    public var canGoPrevious: Bool { offset > 0 }

    public var canGoNext: Bool { offset + pageSize < total }

    public var projectGate: ProjectGate {
        if let message = projectsPhase.failureMessage { return .failed(message) }
        if projectsPhase.isLoading { return .pending }
        if case .loaded = projectsPhase {
            return projects.isEmpty ? .noProjects : .ready
        }
        return .pending
    }

    public var isRefreshing: Bool { listPhase.isLoading }

    public var failureMessage: String? { listPhase.failureMessage }

    /// 内容三态：有数据 → ready / empty；无数据 → loading / failed。
    public var contentState: AdContentState {
        if loadedOffset != nil {
            return items.isEmpty ? .empty : .ready
        }
        if let message = listPhase.failureMessage { return .failed(message) }
        return .loading
    }

    /// 明细是否仍在生成（决定是否订阅旧链路流）。
    public var isDetailLive: Bool {
        guard let detail else { return false }
        return InsightStatusMachine.isActive(detail.status)
    }

    /// 当前明细要展示的正文：流式草稿优先，其次 detail 正文。
    public var detailContent: String {
        if !stream.content.isEmpty { return stream.content }
        return detail?.content ?? ""
    }

    // MARK: - 共享筛选条的文案（`AdFilterDriving`）

    /// 旧链路的时间筛选是**本地展示口径**：`/ai-insights` 的查询串里没有日期参数
    /// （后端按 `created_at` 倒序返回，日期区间只落在记录的 `date_range_*` 上）。
    /// 因此日期开关关掉时的说明要讲实话 —— 不是「不传日期 = 全量」，而是「本页不发日期参数」。
    public var dateRangeOffNote: String {
        "洞察列表按创建时间倒序（该端点不接日期参数）"
    }

    public var filterSummary: String {
        let project = filters.projectID
            .flatMap { id in projects.first { $0.id == id }?.name } ?? "全部项目"
        var text = "查询：\(project) · \(AdCountries.label(code: filters.country))"
        text += " · 类型 \(insightTypeFilter.map(InsightTypes.label(value:)) ?? "全部")"
        text += " · 第 \(page)/\(totalPages) 页 · 每页 \(pageSize) 条"
        if let loadedAt {
            text += " · 本页数据 \(AgentOpsFormatting.clockTime(loadedAt)) 拉取"
        }
        return text
    }

    // MARK: - 筛选与分页

    public func setProject(id: Int?) {
        guard filters.projectID != id else { return }
        filters.projectID = id
        offset = 0
    }

    public func setCountry(_ country: String) {
        guard filters.country != country else { return }
        filters.country = country
        offset = 0
    }

    /// 该端点不接日期参数，开关只影响展示（见 `dateRangeOffNote`）。保留实现是为了复用共享筛选条。
    public func setUsesDateRange(_ enabled: Bool) {
        guard filters.usesDateRange != enabled else { return }
        filters.usesDateRange = enabled
        if !enabled {
            filters.dateFrom = nil
            filters.dateTo = nil
        }
    }

    public func setDateFrom(_ date: String?) { filters.dateFrom = date }

    public func setDateTo(_ date: String?) { filters.dateTo = date }

    public func setInsightTypeFilter(_ value: String?) {
        guard insightTypeFilter != value else { return }
        insightTypeFilter = value
        offset = 0
    }

    public func goToPage(_ target: Int) {
        let clamped = min(max(1, target), totalPages)
        let next = (clamped - 1) * pageSize
        guard next != offset else { return }
        offset = next
    }

    public func nextPage() { goToPage(page + 1) }

    public func previousPage() { goToPage(page - 1) }

    /// 强制刷新（即使当前筛选已经加载过）。
    public func requestRefresh() { refreshTicket += 1 }

    /// 打开明细（`nil` = 关闭）。
    public func openInsight(id: Int?) {
        guard detailID != id else { return }
        detailID = id
        detailTicket += 1
        detail = nil
        detailPhase = .idle
        stream = DetailStream()
    }

    /// 没有可用凭据（未登录）时把页面置为失败态：不发请求 —— 没有 key 的请求必然 401，
    /// 显示成「凭据被拒绝」会把「还没登录」误导成「凭据失效」（同 S5.1 / S5.2 口径）。
    public func failWithoutCredential() {
        projectsPhase = .failed("尚未登录，无法加载 AI 洞察。")
    }

    // MARK: - 加载

    /// 加载列表（**入口即登记**在模块任务作用域里）。
    public func load(
        using provider: InsightDataProviding,
        scope: ModuleTaskScope,
        key: String,
        now: Date = Date()
    ) async {
        let pending = loadKey
        if loadedSignature == pending.signature,
           loadedOffset == pending.offset,
           loadedTicket == pending.refreshTicket,
           loadedTicket >= 0
        {
            return
        }
        await scope.run(key: key) { [weak self] in
            await self?.performLoad(using: provider, now: now)
        }.value
    }

    func performLoad(using provider: InsightDataProviding, now: Date = Date()) async {
        let pending = loadKey
        let token = UUID()
        loadToken = token

        if projects.isEmpty {
            await loadProjects(using: provider)
        }
        guard case .loaded = projectsPhase else { return }

        // **生效签名在项目闸门之后取**：进页会自动选中第一个项目（`loadProjects` 里写
        // `filters.projectID`），那一改会让 `filters.signature` 变一次。若拿闸门之前的
        // 签名去记账，视图 `.task(id:)` 因选中项目而重跑时就会认定「筛选变了」再发一次
        // 同一组参数（S5.1 踩过的坑，PLAN §3 ②）。
        let signature = filters.signature

        // 定时列表与主表同批：它是只读附属信息，失败不拖垮主表。
        await loadSchedulesIfNeeded(using: provider)

        listPhase = .loading
        let outcome = await Self.capture {
            try await provider.insights(
                query: InsightListQuery(
                    projectID: signature.projectID,
                    country: signature.country,
                    statusFilter: nil,
                    insightType: pending.insightType,
                    limit: InsightCatalog.pageSize,
                    offset: pending.offset
                )
            )
        }
        guard isCurrent(loadToken: token) else { return abandonLoad() }

        switch outcome {
        case .success(let response):
            items = response.items
            total = response.total
            listPhase = .loaded
            loadedAt = now
            refreshFailure = nil
            loadedSignature = signature
            loadedOffset = pending.offset
            loadedTicket = pending.refreshTicket
        case .failure(let message):
            if loadedOffset != nil {
                listPhase = .loaded
                refreshFailure = message
            } else {
                listPhase = .failed(message)
                refreshFailure = nil
            }
        }
    }

    /// 打开明细：先取权威 detail，若仍在生成则订阅旧链路流。
    public func loadDetailAndWatch(
        using provider: InsightDataProviding,
        scope: ModuleTaskScope,
        key: String
    ) async {
        guard let insightID = detailID else { return }
        await scope.run(key: key) { [weak self] in
            await self?.performDetailWatch(insightID: insightID, using: provider)
        }.value
    }

    func performDetailWatch(insightID: Int, using provider: InsightDataProviding) async {
        let token = UUID()
        detailToken = token
        detailPhase = .loading

        let outcome = await Self.capture { try await provider.insightDetail(id: insightID) }
        guard isCurrent(detailToken: token) else { return abandonDetail() }
        switch outcome {
        case .success(let payload):
            detail = payload
            detailPhase = .loaded
            stream = DetailStream()
            stream.status = InsightStatusMachine.isActive(payload.status) ? "running" : payload.status
            stream.subStatus = payload.subStatus
            stream.content = payload.content ?? ""
            stream.title = payload.title
            stream.errorMessage = payload.errorMessage
            stream.isFinished = !InsightStatusMachine.isActive(payload.status)
        case .failure(let message):
            detailPhase = .failed(message)
            return
        }

        guard isDetailLive else { return }
        await watchLegacyStream(insightID: insightID, using: provider, token: token)
    }

    /// 旧链路流的订阅 + 重连。
    ///
    /// 重连口径（口径 1 的落点）：旧链路**没有游标可用**，所以每次重连前先回读一次 detail
    /// （权威快照）再重新订阅 —— 而不是假装能按 `Last-Event-ID` 续传。终态帧到达即收尾：
    /// 回读一次 detail 把权威正文与发布稿状态定住，再刷新列表。
    private func watchLegacyStream(
        insightID: Int,
        using provider: InsightDataProviding,
        token: UUID
    ) async {
        var attempt = 0
        while isCurrent(detailToken: token), !Task.isCancelled, !stream.isFinished {
            stream.transport = attempt == 0 ? .live : .reconnecting
            var receivedTerminal = false
            do {
                for try await frame in provider.insightStream(id: insightID) {
                    try Task.checkCancellation()
                    guard isCurrent(detailToken: token) else { return }
                    guard let parsed = LegacyInsightFrame.parse(frame.data) else { continue }
                    stream.eventTypes.append(parsed.name)
                    applyLegacy(frame: parsed)
                    if parsed.name == "done" || parsed.name == "error" {
                        receivedTerminal = true
                        break
                    }
                }
            } catch is CancellationError {
                // 取消不是错误（切明细 / 切模块）：状态归位由 abandonDetail 负责。
                return
            } catch {
                // 断流：下面按重连策略处理，不落成终态错误。
            }

            guard isCurrent(detailToken: token) else { return }
            if receivedTerminal || stream.isFinished {
                await refreshDetailSnapshot(insightID: insightID, using: provider, token: token)
                requestRefresh()
                return
            }

            attempt += 1
            stream.reconnects = attempt
            if attempt > maxReconnects {
                // 重连上限：把「流没接上」如实说出来，但**不**把 run 判成失败
                // （run 由后端继续跑，detail 才是权威；用户可手动刷新）。
                stream.transport = .reconnecting
                stream.errorMessage =
                    "生成流已断开且重连 \(attempt - 1) 次未成功；后台任务仍在运行，可稍后刷新查看。"
                await refreshDetailSnapshot(insightID: insightID, using: provider, token: token)
                return
            }
            // 重连前回读权威快照（旧链路没有游标可续传）。
            await refreshDetailSnapshot(insightID: insightID, using: provider, token: token)
            guard isCurrent(detailToken: token), !stream.isFinished else { return }
            try? await Task.sleep(for: reconnectDelay)
        }
    }

    /// 回读 detail 并把权威结论写进面板（「重连即回读」的唯一落点）。
    private func refreshDetailSnapshot(
        insightID: Int,
        using provider: InsightDataProviding,
        token: UUID
    ) async {
        let outcome = await Self.capture { try await provider.insightDetail(id: insightID) }
        guard isCurrent(detailToken: token) else { return }
        guard case .success(let payload) = outcome else { return }
        detail = payload
        detailPhase = .loaded
        let active = InsightStatusMachine.isActive(payload.status)
        stream.status = active ? "running" : payload.status
        stream.subStatus = payload.subStatus
        stream.title = payload.title
        if !active {
            // 终态：以 detail 的正文与错误为准（终态帧可能因为断线而没收到）。
            stream.content = payload.content ?? stream.content
            stream.errorMessage = payload.errorMessage
            stream.isFinished = true
            stream.transport = .live
        }
        // 运行中**不**回写 `error_message`：那里放的是 run 自己的失败原因，而这一层可能
        // 已经写了一行「生成流已断开」的传输提示 —— 回写会把它抹掉（`nil` 覆盖 `nil` 之外
        // 的一切），用户就再也看不到「流断了但 run 还在跑」。
    }

    /// 把一帧旧链路帧应用到面板。
    private func applyLegacy(frame: LegacyInsightFrame) {
        switch frame {
        case .ping:
            return
        case .chunk(let delta):
            stream.content += delta
        case .status(let status, let subStatus, _, let title, let content, let errorMessage):
            if status == "failed" {
                stream.status = "failed"
                stream.errorMessage = errorMessage ?? "生成任务失败"
                stream.isFinished = true
                return
            }
            stream.status = "running"
            stream.subStatus = subStatus ?? (status == "pending" ? "queued" : stream.subStatus)
            if let title { stream.title = title }
            if let content, !content.isEmpty { stream.content = content }
        case .done(_, let title, let content, let status, let errorMessage):
            if status == "failed" {
                stream.status = "failed"
                stream.errorMessage = errorMessage ?? "生成任务失败"
            } else {
                stream.status = "completed"
                if let title { stream.title = title }
                if let content, !content.isEmpty { stream.content = content }
            }
            stream.isFinished = true
        case .error(let message, _, _, let errorMessage):
            stream.status = "failed"
            stream.errorMessage = errorMessage ?? message
            stream.isFinished = true
        }
    }

    /// 定时列表：只读，且只有 (项目, 站点) 变了才重取。
    private func loadSchedulesIfNeeded(using provider: InsightDataProviding) async {
        let signature = filters.signature
        if schedulesSignature == signature, !schedulesPhase.isLoading,
           schedulesPhase.failureMessage == nil
        {
            return
        }
        schedulesSignature = signature
        schedulesPhase = .loading
        let token = UUID()
        schedulesToken = token
        let outcome = await Self.capture {
            try await provider.schedules(
                query: InsightScheduleQuery(
                    projectID: signature.projectID,
                    isActive: nil,
                    insightType: nil
                )
            )
        }
        guard schedulesToken == token, !Task.isCancelled else {
            schedulesPhase = .idle
            schedulesSignature = nil
            return
        }
        switch outcome {
        case .success(let response):
            schedules = response.items
            schedulesPhase = .loaded
        case .failure(let message):
            schedules = []
            schedulesPhase = .failed(message)
        }
    }

    private func loadProjects(using provider: InsightDataProviding) async {
        let token = UUID()
        projectsToken = token
        projectsPhase = .loading
        let outcome = await Self.capture { try await provider.projects() }
        guard isCurrent(projectsToken: token) else { return abandonProjects() }
        switch outcome {
        case .success(let list):
            projects = list
            projectsPhase = .loaded
            // 与 S5.1 / S5.2 同口径：进页取列表并选中第一个（Web `payload[0].id`）。
            if filters.projectID == nil { filters.projectID = list.first?.id }
        case .failure(let message):
            projectsPhase = .failed(message)
        }
    }

    // MARK: - 取消归位（取消不落错误态）

    private func isCurrent(loadToken token: UUID) -> Bool {
        loadToken == token && !Task.isCancelled
    }

    private func isCurrent(projectsToken token: UUID) -> Bool {
        self.projectsToken == token && !Task.isCancelled
    }

    private func isCurrent(detailToken token: UUID) -> Bool {
        detailToken == token && !Task.isCancelled
    }

    private func abandonLoad() {
        guard loadToken != nil, case .loading = listPhase else { return }
        // 已有数据一律保留；没有数据就退回 idle（不落错误态）。
        listPhase = loadedOffset == nil ? .idle : .loaded
    }

    private func abandonProjects() {
        guard projectsPhase.isLoading else { return }
        projectsPhase = .idle
    }

    private func abandonDetail() {
        guard detailPhase.isLoading else { return }
        detailPhase = .idle
    }

    // MARK: - 工具

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
}

/// `AIInsightsStore` 里 `DetailStream.contentState` 的类型。
///
/// 与 UI 层的 `InsightContentState` 同义但不 import SwiftUI（Kit 不依赖视图层）；
/// 视图侧用 `InsightContentState.from(_:)` 映射。
public enum InsightContentStateAdapter: Equatable, Sendable {
    case draft
    case final
}

/// 列表内容三态（与 S5.2 的 `AdDataStore.ContentState` 同义，独立命名避免跨文件耦合）。
public enum AdContentState: Equatable, Sendable {
    case loading
    case failed(String)
    case empty
    case ready
}
