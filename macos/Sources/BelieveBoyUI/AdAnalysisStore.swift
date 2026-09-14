import BelieveBoyKit
import Foundation
import Observation

/// 「广告 → 广告分析」的视图状态：共享筛选条 + 10 个子 Tab 的各自三态。
///
/// 三条口径决定了这个 store 的形状（见 issue BLF-1056）：
///
/// 1. **不传日期 ≠ 最近 N 天**：`filters.usesDateRange == false` 时查询里根本不放
///    `date_from` / `date_to`（后端在参数为空时不加日期条件 → 聚合全量历史）。UI 上
///    没有「默认最近 7 天」这种东西，避免与 Web 的数值不一致。
/// 2. **10 个 Tab 共用一组筛选值**：切 Tab 只换 `selectedTabKey`，`filters` 不动。
/// 3. **切 Tab / 改筛选 / 切模块都要取消在跑请求，且取消不落错误态**：所有请求都经
///    `ModuleTaskScope.run(key: 当前 route id)` 登记 —— 同 key 的新请求会先取消上一个
///    （切 Tab、改筛选），外壳切模块时按 route id 整体取消（`NavigationStore.changeRoute`）。
///    被取消的任务在写入前判 `Task.isCancelled` / 自己的 token，把还在 loading 的那一格
///    退回 idle，**已有数据一律保留**。
///
/// 状态住在 `NavigationStore`（不是视图）：视图是值类型，重绘即重建 —— 放视图里等于
/// 「切走再回来 = 重新拉、筛选被重置」（S4 结论，PLAN §3）。
@MainActor
@Observable
public final class AdAnalysisStore: AdFilterDriving {
    /// 单格的加载阶段（共享类型，见 `AdLoadPhase`）。
    public typealias Phase = AdLoadPhase

    /// 项目列表这道闸门（共享类型，见 `AdProjectGate`）。
    public typealias ProjectGate = AdProjectGate

    /// 共享筛选条的值（共享类型，见 `AdFilters`）—— 与「广告数据」页用的是同一份实现，
    /// 两页的筛选口径不许各写一份。
    public typealias Filters = AdFilters

    /// 一次查询的筛选签名（共享类型，见 `AdQuerySignature`；不含 Tab 与刷新票号）。
    public typealias QuerySignature = AdQuerySignature

    /// 视图 `.task(id:)` 的驱动器：Tab / 筛选 / 刷新票号任一变化即重跑一次加载。
    public struct LoadKey: Equatable, Sendable {
        public let tabKey: String
        public let signature: QuerySignature
        public let refreshTicket: Int
    }

    /// 单个 Tab 的状态。
    public struct TabState: Equatable {
        public var phase: Phase = .idle
        /// 上一次**成功**的响应（刷新失败时保留它 → 界面不闪空）。
        public var payload: AdAnalysisPayload?
        public var loadedAt: Date?
        /// 有旧数据、但最近一次刷新失败的提示。
        public var refreshFailure: String?
        /// 这份 payload 对应的筛选签名与刷新票号（相同 → 不重复请求）。
        var loadedSignature: QuerySignature?
        var loadedTicket: Int = -1

        public init() {}

        /// 是否有可展示数据。
        public var hasPayload: Bool { payload != nil }
    }

    public private(set) var filters: Filters
    public private(set) var selectedTabKey: String
    public private(set) var tabStates: [String: TabState]
    public private(set) var projects: [AdProject] = []
    public private(set) var projectsPhase: Phase = .idle

    /// 手动刷新票号（`⌘R` / 刷新按钮）。
    public private(set) var refreshTicket = 0

    private var loadTokens: [String: UUID] = [:]
    private var projectsToken: UUID?
    /// 正在跑的明细请求（Tab → 那次请求的签名与票号）。
    ///
    /// 用途是**在飞请求去重**：视图的 `.task(id:)` 在「自动选中第一个项目」时会把 id 改一次，
    /// 于是同一组筛选会再触发一次加载 —— 若第二次照常 `ModuleTaskScope.run`，它会把第一次
    /// 还在飞的请求取消掉，结果是同一个端点发两次、还白等一轮。这里让它直接返回，等第一次
    /// 自己落地（Web 的 `ad-client-cache.ts` 用 `INFLIGHT` map 做同一件事）。
    private struct InFlight {
        let token: UUID
        let signature: QuerySignature
        let ticket: Int
    }

    private var inFlight: [String: InFlight] = [:]

    public init(
        filters: Filters = Filters(),
        selectedTabKey: String = AdAnalysisCatalog.defaultTabKey
    ) {
        self.filters = filters
        self.selectedTabKey = AdAnalysisCatalog.tab(key: selectedTabKey) != nil
            ? selectedTabKey
            : AdAnalysisCatalog.defaultTabKey
        self.tabStates = Dictionary(
            uniqueKeysWithValues: AdAnalysisCatalog.tabs.map { ($0.key, TabState()) }
        )
    }

    // MARK: - 派生

    /// 当前 Tab。
    public var selectedTab: AdAnalysisTab {
        AdAnalysisCatalog.tab(key: selectedTabKey)
            ?? AdAnalysisCatalog.tabs[0]
    }

    /// 当前 Tab 的状态。
    public var selectedTabState: TabState { state(forTabKey: selectedTabKey) }

    public func state(forTabKey tabKey: String) -> TabState {
        tabStates[tabKey] ?? TabState()
    }

    /// 驱动加载的键（Tab + 筛选 + 刷新票号）。
    public var loadKey: LoadKey {
        LoadKey(
            tabKey: selectedTabKey,
            signature: filters.signature,
            refreshTicket: refreshTicket
        )
    }

    /// 项目列表这道闸门的当前状态。
    public var projectGate: ProjectGate {
        if let message = projectsPhase.failureMessage { return .failed(message) }
        if projectsPhase.isLoading { return .pending }
        if case .loaded = projectsPhase {
            return projects.isEmpty ? .noProjects : .ready
        }
        return .pending
    }

    /// 当前 Tab 是否正在刷新（页头转圈）。
    public var isRefreshing: Bool { selectedTabState.phase.isLoading }

    /// 当前 Tab 的失败文案（有旧数据时是「刷新失败」，否则是整页失败）。
    public var failureMessage: String? { selectedTabState.phase.failureMessage }

    /// 有旧数据、最近一次刷新失败的提示。
    public var refreshFailure: String? { selectedTabState.refreshFailure }

    /// 当前 Tab 的明细行（各 Tab 明细字段名不同，由 payload 统一收口）。
    public var detailRows: [AdAnalysisRow] {
        selectedTabState.payload?.detailRows(forTabKey: selectedTabKey) ?? []
    }

    /// 三态判定：有数据 → ready/empty，无数据 → loading/failed。
    public enum ContentState: Equatable {
        case loading
        case failed(String)
        case empty
        case ready
    }

    public var contentState: ContentState {
        let state = selectedTabState
        if state.payload != nil {
            return state.payload?.isEmpty(forTabKey: selectedTabKey) == true ? .empty : .ready
        }
        if let message = state.phase.failureMessage { return .failed(message) }
        return .loading
    }

    // MARK: - 共享筛选条的文案（`AdFilterDriving`）

    /// 日期区间关掉时的口径说明 —— 广告分析**不传** `date_from` / `date_to`（口径 1）。
    public var dateRangeOffNote: String { "未限定日期 → 不传日期参数（全量历史）" }

    /// 当前**实际**发出的筛选条件（比对数值时照这行念）。
    public var filterSummary: String {
        let project = projects.first { $0.id == filters.projectID }?.name ?? "（未选）"
        let country = AdCountries.label(code: filters.country)
        var text = "查询：\(project) · \(country)"
        if let from = filters.effectiveDateFrom, let to = filters.effectiveDateTo {
            text += " · \(from) ~ \(to)"
        } else {
            text += " · 未传日期（全量历史）"
        }
        if let loadedAt = selectedTabState.loadedAt {
            text += " · 本页数据 \(AgentOpsFormatting.clockTime(loadedAt)) 拉取"
        }
        return text
    }

    // MARK: - 筛选（口径 1：不传日期 ≠ 最近 N 天）

    public func setProject(id: Int?) {
        guard filters.projectID != id else { return }
        filters.projectID = id
    }

    public func setCountry(_ country: String) {
        guard filters.country != country else { return }
        filters.country = country
    }

    /// 开关「按日期筛选」。关掉时清空日期值 —— 留着旧的日期只会让下一次打开时
    /// 突然换一个区间，而用户以为它还是空的。
    public func setUsesDateRange(_ enabled: Bool) {
        guard filters.usesDateRange != enabled else { return }
        filters.usesDateRange = enabled
        if !enabled {
            filters.dateFrom = nil
            filters.dateTo = nil
        }
    }

    public func setDateFrom(_ date: String?) {
        guard filters.dateFrom != date else { return }
        filters.dateFrom = date
    }

    public func setDateTo(_ date: String?) {
        guard filters.dateTo != date else { return }
        filters.dateTo = date
    }

    public func clearDateRange() {
        filters.usesDateRange = false
        filters.dateFrom = nil
        filters.dateTo = nil
    }

    public func selectTab(key: String) {
        guard AdAnalysisCatalog.tab(key: key) != nil, key != selectedTabKey else { return }
        selectedTabKey = key
    }

    /// 请求一次强制刷新（即使当前筛选已经加载过）。
    public func requestRefresh() {
        refreshTicket += 1
    }

    /// 没有可用凭据（未登录）时把当前 Tab 置为失败态。
    ///
    /// 不发请求：没有 key 的请求必然 401，把它显示成「凭据被拒绝」会把「还没登录」
    /// 误导成「凭据失效」（同 `AgentOverviewStore.failWithoutCredential` 的口径）。
    public func failWithoutCredential() {
        projectsPhase = .failed("尚未登录，无法加载广告分析。")
    }

    // MARK: - 加载

    /// 在模块任务作用域里加载当前 Tab（**入口即登记**）。
    ///
    /// 用同一个 key（当前 route id）登记全部请求：同 key 的新请求会先取消上一个 ——
    /// 这正是「切 Tab / 改筛选时取消在跑请求」的机制；切模块时由外壳按 route id 取消。
    public func load(
        using provider: AdAnalysisDataProviding,
        scope: ModuleTaskScope,
        key: String,
        now: Date = Date()
    ) async {
        let pending = loadKey
        // 同一组筛选已经在跑 → 不重复登记（否则这次登记会把上一次取消掉）。
        if let running = inFlight[pending.tabKey],
           running.signature == pending.signature,
           running.ticket == pending.refreshTicket
        {
            return
        }
        await scope.run(key: key) { [weak self] in
            await self?.performLoad(using: provider, now: now)
        }.value
    }

    /// 真正的一次加载：先保项目列表，再取当前 Tab 的明细。
    func performLoad(using provider: AdAnalysisDataProviding, now: Date = Date()) async {
        let tab = selectedTab
        let ticket = refreshTicket
        let token = UUID()
        loadTokens[tab.key] = token

        // 1) 项目列表：进页取一次。项目是必填参数，没它就发不出明细请求。
        if projects.isEmpty {
            let projectsToken = UUID()
            self.projectsToken = projectsToken
            projectsPhase = .loading
            let outcome = await Self.capture { try await provider.projects() }
            guard isCurrent(projectsToken: projectsToken) else {
                return abandonProjects(token: projectsToken)
            }
            switch outcome {
            case .success(let list):
                projects = list
                projectsPhase = .loaded
                // Web 同口径：进页取列表并选中第一个（`top-filters.tsx` 的 `payload[0].id`）。
                if filters.projectID == nil { filters.projectID = list.first?.id }
            case .failure(let message):
                projectsPhase = .failed(message)
            }
        }

        guard case .loaded = projectsPhase, let projectID = filters.projectID else { return }

        // 2) 当前 Tab 的明细。
        var state = state(forTabKey: tab.key)
        let signature = QuerySignature(
            projectID: projectID,
            country: filters.country,
            dateFrom: filters.effectiveDateFrom,
            dateTo: filters.effectiveDateTo
        )
        // 同一组筛选已经加载过、且这次不是手动刷新 → 不重复请求（Web 的 2 分钟缓存同义）。
        if state.hasPayload, state.loadedSignature == signature, state.loadedTicket == ticket {
            return
        }

        state.phase = .loading
        tabStates[tab.key] = state
        inFlight[tab.key] = InFlight(token: token, signature: signature, ticket: ticket)

        let query = AdAnalysisQuery(
            projectID: projectID,
            country: signature.country,
            dateFrom: signature.dateFrom,
            dateTo: signature.dateTo
        )
        let outcome = await Self.capture { try await provider.payload(tab: tab, query: query) }
        clearInFlight(tabKey: tab.key, token: token)
        guard isCurrent(tabKey: tab.key, token: token) else {
            return abandon(tabKey: tab.key, token: token)
        }
        apply(outcome, tabKey: tab.key, signature: signature, ticket: ticket, now: now)
    }

    /// 只有在飞的那次请求还是自己的时候才清（更新的任务已经接管时不动它）。
    private func clearInFlight(tabKey: String, token: UUID) {
        guard inFlight[tabKey]?.token == token else { return }
        inFlight[tabKey] = nil
    }

    /// 落地一次明细结果：成功即换 payload；失败时**有旧数据就保留旧表**并挂一条黄条。
    private func apply(
        _ outcome: LoadOutcome<AdAnalysisPayload>,
        tabKey: String,
        signature: QuerySignature,
        ticket: Int,
        now: Date
    ) {
        var state = state(forTabKey: tabKey)
        switch outcome {
        case .success(let payload):
            state.payload = payload
            state.phase = .loaded
            state.loadedAt = now
            state.refreshFailure = nil
            state.loadedSignature = signature
            state.loadedTicket = ticket
        case .failure(let message):
            if state.hasPayload {
                state.phase = .loaded
                state.refreshFailure = message
            } else {
                state.phase = .failed(message)
                state.refreshFailure = nil
            }
        }
        tabStates[tabKey] = state
    }

    private func isCurrent(tabKey: String, token: UUID) -> Bool {
        loadTokens[tabKey] == token && !Task.isCancelled
    }

    private func isCurrent(projectsToken: UUID) -> Bool {
        self.projectsToken == projectsToken && !Task.isCancelled
    }

    /// 本次加载被取消（切 Tab / 改筛选 / 切模块）：把还在 loading 的那一格退回 idle。
    ///
    /// 只清「还是我这一轮」的状态：更新的任务已经接管时不动它（否则会把新任务的
    /// loading 抹掉）。已有数据一律保留。
    private func abandon(tabKey: String, token: UUID) {
        defer { clearInFlight(tabKey: tabKey, token: token) }
        guard loadTokens[tabKey] == token else { return }
        guard var state = tabStates[tabKey], state.phase.isLoading else { return }
        state.phase = .idle
        tabStates[tabKey] = state
    }

    private func abandonProjects(token: UUID) {
        guard projectsToken == token, projectsPhase.isLoading else { return }
        projectsPhase = .idle
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
