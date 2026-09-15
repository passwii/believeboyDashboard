import BelieveBoyKit
import Foundation
import Observation

/// 「报表中心 → 报表自动化」（`/dashboard/reports/auto-upload`）的 RPA 状态矩阵状态。
///
/// 本批只搬这张**只读**状态表（`GET /rpa-reports/status`）：
///
/// | 口径 | 落点 |
/// | --- | --- |
/// | 数据与 Web 同源同值 | 请求参数逐字照抄（`report_date` + `country`），列序照抄 `report-type-labels.ts` |
/// | 三态齐备 | `contentState`（loading / failed / empty / ready）+ 显式空态文案（「<日期> 暂时没有可展示的报表状态」） |
/// | 刷新失败保留旧表 | `refreshFailure` 走黄条，`rows` 一字不动 |
/// | 分层超时 | `ReportAutomationClient`：项目列表 `.list`（5s）/ 状态矩阵 `.stats`（15s） |
/// | 切页不泄漏 Task | 全部经 `ModuleTaskScope.run(key: TaskPurpose.key(routeID, …))` 登记 |
///
/// 项目列表只服务于「项目筛选」下拉：Web 是**首次打开下拉才拉**（BEL-422），桌面端同口径
/// （`ensureProjects` 只跑一次），避免进页就多打一个请求。
@MainActor
@Observable
public final class ReportAutomationStore {
    public enum TaskPurpose {
        public static let status = "ra-status"
        public static let projects = "ra-projects"

        public static func key(_ routeID: String, _ purpose: String) -> String {
            "\(routeID):\(purpose)"
        }
    }

    /// 视图 `.task(id:)` 的驱动器：日期 / 站点 / 刷新票号任一变化即重跑一次加载。
    public struct LoadKey: Equatable, Sendable {
        public let reportDate: String
        public let country: String
        public let refreshTicket: Int
    }

    public enum ContentState: Equatable {
        case loading
        case failed(String)
        case empty
        case ready
    }

    public private(set) var reportDate: String
    public private(set) var country: String
    public private(set) var refreshTicket = 0

    public private(set) var phase: AdLoadPhase = .idle
    public private(set) var rows: [RpaProjectStatus] = []
    /// 有旧数据、最近一次刷新失败的提示。
    public private(set) var refreshFailure: String?
    public private(set) var loadedAt: Date?

    /// 项目筛选（空集 = 全部项目，与 Web 的 `selectedProjects.length === 0` 同义）。
    public private(set) var projectFilter: Set<String> = []
    public private(set) var projectsPhase: AdLoadPhase = .idle
    public private(set) var projects: [AdProject] = []
    private var projectsRequested = false

    private var loadToken: UUID?
    private var projectsToken: UUID?

    public init(
        reportDate: String = ReportCatalog.localDateString(Date()),
        country: String = ReportCatalog.defaultCountry
    ) {
        self.reportDate = reportDate
        self.country = country
    }

    // MARK: - 派生

    public var loadKey: LoadKey {
        LoadKey(reportDate: reportDate, country: country, refreshTicket: refreshTicket)
    }

    /// 三态判定：有数据 → ready/empty；无数据 → loading/failed。
    ///
    /// 「已加载但列表为空」必须是**空态**而不是继续 loading —— 否则该日期没有 RPA 数据时，
    /// 界面会永远转圈，而用户看不到那句「暂时没有可展示的报表状态」。
    public var contentState: ContentState {
        if !rows.isEmpty { return .ready }
        if let message = phase.failureMessage { return .failed(message) }
        if case .loaded = phase { return .empty }
        return .loading
    }

    public var isRefreshing: Bool { phase.isLoading }

    /// 应用项目筛选之后的行。
    public var filteredRows: [RpaProjectStatus] {
        guard !projectFilter.isEmpty else { return rows }
        return rows.filter { projectFilter.contains($0.projectName) }
    }

    /// 全表上传完成度（M/N）—— 分母是「后端真的报了状态的格子数」。
    public var completeness: ReportAutomationCatalog.Completeness {
        ReportAutomationCatalog.completeness(filteredRows)
    }

    /// 列目录（Web `REPORT_TYPES` 的等价物）。
    public var columns: [ReportAutomationColumn] { ReportAutomationCatalog.columns }

    public var hasProjectFilter: Bool { !projectFilter.isEmpty }

    public var projectFilterLabel: String {
        if projectFilter.isEmpty { return "全部项目" }
        if projectFilter.count == 1 { return projectFilter.first ?? "全部项目" }
        return "已选 \(projectFilter.count) 个项目"
    }

    /// 筛选下拉里的候选（不筛掉后端已经返回的行 —— 后端返回哪些项目是它的事）。
    public var projectOptions: [String] {
        let names = Set(rows.map(\.projectName)).union(projects.map(\.name))
        return names.sorted()
    }

    /// 空态文案里的日期。
    public var emptyMessage: String { "\(reportDate) 暂时没有可展示的报表状态" }

    /// 请求参数是否可用（日期必须是 `YYYY-MM-DD`；后端 `min_length=10` 会直接 422）。
    public var query: RpaReportStatusQuery? {
        let query = RpaReportStatusQuery(reportDate: reportDate, country: country)
        return query.isValid ? query : nil
    }

    /// 查询摘要（比对数值时照这行念）。
    public var filterSummary: String {
        var text = "查询：\(reportDate) · \(AdCountries.label(code: country))"
        if !projectFilter.isEmpty {
            text += " · 项目筛选 \(projectFilter.sorted().joined(separator: "/"))"
        }
        if let loadedAt {
            text += " · 本页数据 \(AgentOpsFormatting.clockTime(loadedAt)) 拉取"
        }
        return text
    }

    // MARK: - 维度

    public func setReportDate(_ value: String) {
        guard reportDate != value else { return }
        reportDate = value
    }

    public func shiftDate(days: Int) {
        setReportDate(ReportCatalog.shiftDateString(reportDate, days: days))
    }

    public func goToToday(now: Date = Date()) {
        setReportDate(ReportCatalog.localDateString(now))
    }

    public func setCountry(_ value: String) {
        guard country != value else { return }
        country = value
    }

    public func toggleProject(_ name: String) {
        if projectFilter.contains(name) {
            projectFilter.remove(name)
        } else {
            projectFilter.insert(name)
        }
    }

    public func isProjectSelected(_ name: String) -> Bool { projectFilter.contains(name) }

    public func clearProjectFilter() { projectFilter = [] }

    /// 请求一次强制刷新（即使当前参数已经加载过）。
    public func requestRefresh() { refreshTicket += 1 }

    /// 未登录：不发请求（没有 key 的请求必然 401，把「还没登录」显示成「凭据被拒绝」是误导）。
    public func failWithoutCredential() {
        phase = .failed("尚未登录，无法加载 RPA 报表状态。")
    }

    // MARK: - 加载

    /// 在模块任务作用域里加载状态矩阵（入口即登记）。
    public func load(
        using provider: ReportAutomationDataProviding,
        scope: ModuleTaskScope,
        routeID: String,
        now: Date = Date()
    ) async {
        await scope.run(key: TaskPurpose.key(routeID, TaskPurpose.status)) { [weak self] in
            await self?.performLoad(using: provider, now: now)
        }.value
    }

    func performLoad(using provider: ReportAutomationDataProviding, now: Date) async {
        guard let query else {
            // 日期还不完整（用户正在输入）：不请求，也不留错误态。
            phase = rows.isEmpty ? .idle : .loaded
            return
        }
        let token = UUID()
        loadToken = token
        if rows.isEmpty { phase = .loading }

        let outcome = await Self.capture { try await provider.rpaStatus(query) }
        guard loadToken == token, !Task.isCancelled else {
            abandon(token: token)
            return
        }
        switch outcome {
        case .success(let response):
            rows = response.items
            phase = .loaded
            loadedAt = now
            refreshFailure = nil
        case .failure(let message):
            if rows.isEmpty {
                phase = .failed(message)
                refreshFailure = nil
            } else {
                // 口径 2：刷新失败**保留旧表**，只挂一条提示。
                phase = .loaded
                refreshFailure = message
            }
        }
    }

    /// 首次打开项目筛选下拉时才拉项目列表（Web BEL-422 同口径）；只跑一次。
    public func ensureProjects(
        using provider: ReportAutomationDataProviding,
        scope: ModuleTaskScope,
        routeID: String
    ) {
        guard !projectsRequested else { return }
        projectsRequested = true
        let token = UUID()
        projectsToken = token
        projectsPhase = .loading
        scope.run(key: TaskPurpose.key(routeID, TaskPurpose.projects)) { [weak self] in
            guard let self else { return }
            let outcome = await Self.capture { try await provider.projects() }
            guard self.projectsToken == token, !Task.isCancelled else { return }
            switch outcome {
            case .success(let list):
                self.projects = list
                self.projectsPhase = .loaded
            case .failure(let message):
                // 项目筛选是**附属**功能：拉不到只让下拉空着，不拖垮状态矩阵。
                self.projectsPhase = .failed(message)
                self.projectsRequested = false
            }
        }
    }

    /// 取消（切页 / 改参数）：把还在 loading 的整页退回 idle，**已有数据一律保留**。
    private func abandon(token: UUID) {
        guard loadToken == token else { return }
        guard phase.isLoading else { return }
        phase = rows.isEmpty ? .idle : .loaded
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
