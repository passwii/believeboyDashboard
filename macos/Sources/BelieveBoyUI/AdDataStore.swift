import BelieveBoyKit
import Foundation
import Observation

/// 「广告 → 广告数据」的视图状态：共享筛选条 + 10 种报表类型各自的原始行表 + 客户端搜索 /
/// 排序 / 翻页。
///
/// 五条口径决定了这个 store 的形状（见 issue BLF-1057）：
///
/// 1. **日期契约与广告分析页不同**：`period` 必填，没有「不传=全量」。未限定日期时查询落到
///    哨兵窗口（`AdDataQuery` 的 `2000-01-01 ~ 2100-12-31`），照 Web 逐字同参数 —— 照搬
///    广告分析那种「日期为空就不传参数」会被后端 400 拒。
/// 2. **单发 `limit=10000` + 客户端翻页**：不做服务端 offset 翻页（后端排序没有 tiebreaker，
///    实测 `offset=0` 与 `offset=100` 有 4 行重复），`data.count == limit` 时按「可能被截断」
///    提示，而不是静默当作完整数据。
/// 3. **报表类型不做可用性置灰**：`ad-upload-files` 被截断（实测 US 有 1405 份 current 文件，
///    端点上限 500），照抄 Web 会把「搜索词」这类久未入库的类型误判成「暂无数据」。可用性由
///    所选类型 raw 响应的 `data` 是否为空决定；入库文件列表只用于显示「最近一次入库」。
/// 4. **切类型 / 改筛选 / 切模块都要取消在跑请求，且取消不落错误态**：所有请求都经
///    `ModuleTaskScope.run(key: 当前 route id)` 登记 —— 同 key 的新请求会先取消上一个
///    （切类型、改筛选），外壳切模块时按 route id 整体取消（`NavigationStore.changeRoute`）。
///    被取消的任务在写入前判 token，把还在 loading 的那一格退回 idle，**已有数据一律保留**。
/// 5. **不做缓存层**：只有「同一组筛选 + 同一类型已加载过就不再请求」这一条（同 S5.1 的
///    在飞去重与选择保留），没有 TTL 缓存复刻；要拿最新数据按「刷新」。
///
/// 状态住在 `NavigationStore`（不是视图）：视图是值类型，重绘即重建 —— 放视图里等于
/// 「切走再回来 = 重新拉 + 搜索/翻页/展开被重置」。
@MainActor
@Observable
public final class AdDataStore: AdFilterDriving {
    /// 一个报表类型的加载阶段（共享类型，见 `AdLoadPhase`）。
    public typealias Phase = AdLoadPhase

    /// 项目列表这道闸门（共享类型，见 `AdProjectGate`）。
    public typealias ProjectGate = AdProjectGate

    /// 单个报表类型的表状态。
    public struct TableState: Equatable {
        public var phase: Phase = .idle
        /// 上一次**成功**的响应（刷新失败时保留它 → 界面不闪空）。
        public var payload: AdDataRawPayload?
        public var loadedAt: Date?
        /// 有旧数据、但最近一次刷新失败的提示。
        public var refreshFailure: String?
        /// 这份 payload 对应的筛选签名与刷新票号（相同 → 不重复请求）。
        var loadedSignature: AdQuerySignature?
        var loadedTicket: Int = -1

        public init() {}

        public var hasPayload: Bool { payload != nil }
        public var rows: [DynamicJSONRow] { payload?.data ?? [] }
        /// 顶到单次拉取上限 → 可能被截断（口径 2）。
        public var isTruncated: Bool { payload?.isTruncated() ?? false }
        /// 后端回填的「本页返回行数」（`summary.total_rows`）。
        public var returnedRowCount: Int { payload?.returnedRowCount ?? 0 }
    }

    /// `ad-upload-files`（附属信息）的状态。
    public struct UploadFilesState: Equatable {
        public var phase: Phase = .idle
        public var items: [AdUploadFileItem] = []

        public init() {}

        public var failureMessage: String? { phase.failureMessage }
    }

    /// 内容三态（加一个 ready）。
    public enum ContentState: Equatable {
        case loading
        case failed(String)
        case empty
        case ready
    }

    /// 视图 `.task(id:)` 的驱动器：报表类型 / 筛选 / 刷新票号任一变化即重跑一次加载。
    public struct LoadKey: Equatable, Sendable {
        public let reportTypeCode: String
        public let signature: AdQuerySignature
        public let refreshTicket: Int
    }

    public private(set) var filters: AdFilters
    public private(set) var selectedReportTypeCode: String
    public private(set) var tableStates: [String: TableState]
    public private(set) var projects: [AdProject] = []
    public private(set) var projectsPhase: Phase = .idle
    /// `ad-upload-files`（最近入库文件）：附属信息，失败不影响主表。
    public private(set) var uploadFiles = UploadFilesState()

    // MARK: - 客户端表格状态（搜索 / 排序 / 翻页 / 行展开）

    public private(set) var search = ""
    public private(set) var sort: AdDataSort?
    public private(set) var page = 1
    /// 展开的行 id（`raw_row` 中文列详情）。
    public private(set) var expandedRowIDs: Set<Int> = []
    /// 每页行数（口径 5：固定 100，对齐 Web 的默认值与 issue 的口径）。
    public let pageSize: Int

    /// 手动刷新票号（筛选条上的「刷新」）。
    public private(set) var refreshTicket = 0

    private var loadTokens: [String: UUID] = [:]
    private var projectsToken: UUID?
    /// 已加载入库文件列表的那组（项目 + 站点）——只有它变了才重取。
    private var uploadFilesKey: String?

    /// 正在跑的原始行请求（报表类型 → 那次请求的签名与票号）。
    ///
    /// 用途是**在飞请求去重**：视图的 `.task(id:)` 在「自动选中第一个项目」时会把筛选值改一次，
    /// 于是同一组筛选会再触发一次加载 —— 若第二次照常走 `ModuleTaskScope.run`，它会把第一次
    /// 还在飞的请求取消掉，结果是同一个端点发两次、还白等一轮（S5.1 踩过的坑）。
    private struct InFlight {
        let token: UUID
        let signature: AdQuerySignature
        let ticket: Int
    }

    private var inFlight: [String: InFlight] = [:]

    public init(
        filters: AdFilters = AdFilters(),
        selectedReportTypeCode: String = AdDataCatalog.defaultReportTypeCode,
        pageSize: Int = AdDataCatalog.pageSize
    ) {
        self.filters = filters
        self.selectedReportTypeCode = AdDataCatalog.reportType(code: selectedReportTypeCode) != nil
            ? selectedReportTypeCode
            : AdDataCatalog.defaultReportTypeCode
        self.pageSize = pageSize
        self.tableStates = Dictionary(
            uniqueKeysWithValues: AdDataCatalog.reportTypes.map { ($0.reportType, TableState()) }
        )
    }

    // MARK: - 派生

    /// 当前报表类型。
    public var selectedReportType: AdDataReportType {
        AdDataCatalog.reportType(code: selectedReportTypeCode) ?? AdDataCatalog.reportTypes[0]
    }

    /// 当前报表类型的列定义。
    public var columns: [AdDataColumn] { selectedReportType.columns }

    public func state(forReportTypeCode code: String) -> TableState {
        tableStates[code] ?? TableState()
    }

    public var selectedTableState: TableState { state(forReportTypeCode: selectedReportTypeCode) }

    /// 当前表经「搜索 → 排序 → 翻页」之后的这一页（纯函数流水线）。
    public var tablePage: AdDataTablePage {
        AdDataTablePipeline.resolve(
            rows: selectedTableState.rows,
            columns: columns,
            search: search,
            sort: sort,
            page: page,
            pageSize: pageSize
        )
    }

    /// 本类型本页拿到的原始行数（未过滤）。
    public var returnedRowCount: Int { selectedTableState.returnedRowCount }

    /// 是否可能被单次拉取上限截断。
    public var isTruncated: Bool { selectedTableState.isTruncated }

    /// 驱动加载的键（类型 + 筛选 + 刷新票号）。
    public var loadKey: LoadKey {
        LoadKey(
            reportTypeCode: selectedReportTypeCode,
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

    /// 当前表是否正在刷新（页头转圈）。
    public var isRefreshing: Bool { selectedTableState.phase.isLoading }

    /// 当前表的失败文案（有旧数据时是「刷新失败」，否则是整页失败）。
    public var failureMessage: String? { selectedTableState.phase.failureMessage }

    /// 有旧数据、最近一次刷新失败的提示。
    public var refreshFailure: String? { selectedTableState.refreshFailure }

    /// 三态判定：有数据 → ready/empty，无数据 → loading/failed。
    public var contentState: ContentState {
        let state = selectedTableState
        if let payload = state.payload {
            return payload.data.isEmpty ? .empty : .ready
        }
        if let message = state.phase.failureMessage { return .failed(message) }
        return .loading
    }

    /// 入库文件信息（附属信息：口径 3 的「最近一次入库」+ 截断说明）。
    public var uploadFilesNote: String {
        switch uploadFiles.phase {
        case .failed(let message):
            return "入库文件信息不可用（\(message)）——不影响本表，可用性以本表实际返回行为准。"
        case .loaded:
            if let item = uploadFiles.items.first(where: { $0.reportType == selectedReportTypeCode }) {
                var text = "入库文件："
                text += item.uploadedDay.map { "最近入库 \($0)" } ?? "已入库"
                if let version = item.version { text += " · v\(version)" }
                if let status = item.ingestionStatus { text += " · \(status)" }
                if item.isCurrent == false { text += " · 非当前版本" }
                return text
            }
            return "入库文件：本类型不在最近 \(uploadFiles.items.count) 份之内（列表按入库时间倒序、"
                + "上限 \(AdUploadFilesQuery.maxLimit)，可能被截断）——可用性以本表实际返回行为准。"
        case .idle, .loading:
            return "入库文件：加载中…"
        }
    }

    // MARK: - 共享筛选条的文案（`AdFilterDriving`）

    /// 日期区间关掉时的口径说明 —— 广告数据用**哨兵窗口**（口径 1）。
    public var dateRangeOffNote: String {
        "未限定日期 → 全量窗口 \(AdDataCatalog.sentinelStartDate) ~ \(AdDataCatalog.sentinelEndDate)"
    }

    /// 当前**实际**发出的筛选条件（比对数值时照这行念）。
    public var filterSummary: String {
        let project = projects.first { $0.id == filters.projectID }?.name ?? "（未选）"
        let country = AdCountries.label(code: filters.country)
        var text = "查询：\(project) · \(country) · \(selectedReportType.label)"
        if let from = filters.effectiveDateFrom, let to = filters.effectiveDateTo {
            text += " · \(from) ~ \(to)"
        } else {
            text += " · 全量窗口（\(AdDataCatalog.sentinelStartDate) ~ \(AdDataCatalog.sentinelEndDate)）"
        }
        text += " · limit=\(AdDataCatalog.pageLimit)"
        if let loadedAt = selectedTableState.loadedAt {
            text += " · 本页数据 \(AgentOpsFormatting.clockTime(loadedAt)) 拉取"
        }
        return text
    }

    // MARK: - 筛选

    public func setProject(id: Int?) {
        guard filters.projectID != id else { return }
        filters.projectID = id
        resetTableViewport()
    }

    public func setCountry(_ country: String) {
        guard filters.country != country else { return }
        filters.country = country
        resetTableViewport()
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
        resetTableViewport()
    }

    public func setDateFrom(_ date: String?) {
        guard filters.dateFrom != date else { return }
        filters.dateFrom = date
        resetTableViewport()
    }

    public func setDateTo(_ date: String?) {
        guard filters.dateTo != date else { return }
        filters.dateTo = date
        resetTableViewport()
    }

    public func clearDateRange() {
        filters.usesDateRange = false
        filters.dateFrom = nil
        filters.dateTo = nil
        resetTableViewport()
    }

    // MARK: - 页内维度（报表类型 / 搜索 / 排序 / 翻页 / 展开）

    public func selectReportType(code: String) {
        guard AdDataCatalog.reportType(code: code) != nil, code != selectedReportTypeCode else { return }
        selectedReportTypeCode = code
        // 换表即回到第一页并收起展开行（Web 换类型后也会 `setPage(1)`）。
        page = 1
        expandedRowIDs = []
    }

    public func setSearch(_ query: String) {
        guard search != query else { return }
        search = query
        page = 1
    }

    /// 点表头：同列反向、换列升序（Web `toggleSort`）。**不**重置页码 —— 越界页由
    /// `tablePage` 夹回，与 Web 的 `safePage` 同口径。
    public func toggleSort(key: String) {
        guard let sort else {
            // 首点必须**升序**：`(nil ?? AdDataSort(key:)).toggling(key:)` 会得到降序，
            // 那是「先升再翻」的中间态，与 Web 的「首次点列头 → 升序」不一致。
            self.sort = AdDataSort(key: key)
            return
        }
        self.sort = sort.toggling(key: key)
    }

    public func goToPage(_ target: Int) {
        let clamped = max(1, target)
        guard page != clamped else { return }
        page = clamped
    }

    public func nextPage() {
        goToPage(tablePage.page + 1)
    }

    public func previousPage() {
        goToPage(tablePage.page - 1)
    }

    public func toggleRowExpansion(id: Int) {
        if expandedRowIDs.contains(id) {
            expandedRowIDs.remove(id)
        } else {
            expandedRowIDs.insert(id)
        }
    }

    public func isExpanded(id: Int) -> Bool { expandedRowIDs.contains(id) }

    /// 筛选或类型变化时把表格视口恢复默认（页码回第一页、展开行收起）。
    private func resetTableViewport() {
        page = 1
        expandedRowIDs = []
    }

    /// 请求一次强制刷新（即使当前筛选已经加载过）。
    public func requestRefresh() {
        refreshTicket += 1
    }

    /// 没有可用凭据（未登录）时把当前表置为失败态。
    ///
    /// 不发请求：没有 key 的请求必然 401，把它显示成「凭据被拒绝」会把「还没登录」
    /// 误导成「凭据失效」（同 S5.1 的口径）。
    public func failWithoutCredential() {
        projectsPhase = .failed("尚未登录，无法加载广告数据。")
    }

    // MARK: - 加载

    /// 在模块任务作用域里加载当前表（**入口即登记**）。
    public func load(
        using provider: AdDataDataProviding,
        scope: ModuleTaskScope,
        key: String,
        now: Date = Date()
    ) async {
        let pending = loadKey
        if let running = inFlight[pending.reportTypeCode],
           running.signature == pending.signature,
           running.ticket == pending.refreshTicket
        {
            return
        }
        await scope.run(key: key) { [weak self] in
            await self?.performLoad(using: provider, now: now)
        }.value
    }

    /// 真正的一次加载：项目列表 → 入库文件信息（附属）→ 当前类型的原始行。
    func performLoad(using provider: AdDataDataProviding, now: Date = Date()) async {
        let reportType = selectedReportType
        let ticket = refreshTicket
        let token = UUID()
        loadTokens[reportType.reportType] = token

        // 1) 项目列表：进页取一次。项目是必填参数（在路径里），没它就发不出原始行请求。
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

        // 2) 入库文件信息：附属信息 —— 失败只影响那一行提示，不拖垮主表；同一 (项目, 站点)
        //    只取一次（它不随日期 / 报表类型变化）。
        await loadUploadFilesIfNeeded(using: provider, projectID: projectID)

        // 3) 当前报表类型的原始行。
        var state = state(forReportTypeCode: reportType.reportType)
        let signature = AdQuerySignature(
            projectID: projectID,
            country: filters.country,
            dateFrom: filters.effectiveDateFrom,
            dateTo: filters.effectiveDateTo
        )
        if state.hasPayload, state.loadedSignature == signature, state.loadedTicket == ticket {
            return
        }

        state.phase = .loading
        tableStates[reportType.reportType] = state
        inFlight[reportType.reportType] = InFlight(token: token, signature: signature, ticket: ticket)

        let query = AdDataQuery(
            country: signature.country,
            dateFrom: signature.dateFrom,
            dateTo: signature.dateTo
        )
        let outcome = await Self.capture {
            try await provider.rawPayload(
                reportType: reportType,
                projectID: projectID,
                query: query
            )
        }
        clearInFlight(reportTypeCode: reportType.reportType, token: token)
        guard isCurrent(reportTypeCode: reportType.reportType, token: token) else {
            return abandon(reportTypeCode: reportType.reportType, token: token)
        }
        apply(
            outcome,
            reportTypeCode: reportType.reportType,
            signature: signature,
            ticket: ticket,
            now: now
        )
    }

    /// 取入库文件列表（附属信息）：同一 (项目, 站点) 只取一次；失败**不**影响主表，
    /// 但也不静默 —— 由 `uploadFilesNote` 显示成一行提示。
    private func loadUploadFilesIfNeeded(
        using provider: AdDataDataProviding,
        projectID: Int
    ) async {
        let key = "\(projectID)|\(filters.country)"
        if uploadFilesKey == key, uploadFiles.phase.isLoading == false, uploadFiles.failureMessage == nil {
            return
        }
        uploadFilesKey = key
        uploadFiles.phase = .loading
        let outcome = await Self.capture {
            try await provider.uploadFiles(
                projectID: projectID,
                query: AdUploadFilesQuery(country: filters.country)
            )
        }
        // 取消（切类型 / 切模块）不算失败，也不留假数据。
        guard !Task.isCancelled else {
            uploadFiles = UploadFilesState()
            uploadFilesKey = nil
            return
        }
        switch outcome {
        case .success(let items):
            uploadFiles.items = items
            uploadFiles.phase = .loaded
        case .failure(let message):
            uploadFiles.items = []
            uploadFiles.phase = .failed(message)
        }
    }

    /// 只有在飞的那次请求还是自己的时候才清（更新的任务已经接管时不动它）。
    private func clearInFlight(reportTypeCode: String, token: UUID) {
        guard inFlight[reportTypeCode]?.token == token else { return }
        inFlight[reportTypeCode] = nil
    }

    /// 落地一次结果：成功即换 payload（并回到第一页）；失败时**有旧数据就保留旧表**并挂一条黄条。
    private func apply(
        _ outcome: LoadOutcome<AdDataRawPayload>,
        reportTypeCode: String,
        signature: AdQuerySignature,
        ticket: Int,
        now: Date
    ) {
        var state = state(forReportTypeCode: reportTypeCode)
        switch outcome {
        case .success(let payload):
            state.payload = payload
            state.phase = .loaded
            state.loadedAt = now
            state.refreshFailure = nil
            state.loadedSignature = signature
            state.loadedTicket = ticket
            tableStates[reportTypeCode] = state
            // 换了新数据 → 回第一页、收起展开行（Web 在取数成功后也会 `setPage(1)`）。
            if reportTypeCode == selectedReportTypeCode { resetTableViewport() }
        case .failure(let message):
            if state.hasPayload {
                state.phase = .loaded
                state.refreshFailure = message
            } else {
                state.phase = .failed(message)
                state.refreshFailure = nil
            }
            tableStates[reportTypeCode] = state
        }
    }

    private func isCurrent(reportTypeCode: String, token: UUID) -> Bool {
        loadTokens[reportTypeCode] == token && !Task.isCancelled
    }

    private func isCurrent(projectsToken: UUID) -> Bool {
        self.projectsToken == projectsToken && !Task.isCancelled
    }

    /// 本次加载被取消（切类型 / 改筛选 / 切模块）：把还在 loading 的那一格退回 idle。
    ///
    /// 只清「还是我这一轮」的状态：更新的任务已经接管时不动它（否则会把新任务的
    /// loading 抹掉）。已有数据一律保留。
    private func abandon(reportTypeCode: String, token: UUID) {
        defer { clearInFlight(reportTypeCode: reportTypeCode, token: token) }
        guard loadTokens[reportTypeCode] == token else { return }
        guard var state = tableStates[reportTypeCode], state.phase.isLoading else { return }
        state.phase = .idle
        tableStates[reportTypeCode] = state
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
