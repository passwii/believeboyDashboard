import BelieveBoyKit
import Foundation
import Observation

/// 「运营 → 数据流总览」的视图状态：业务域矩阵 + 三个今日产出源。
///
/// 四个请求**并发、各自降级**（对齐 Web：`useAgentDomainSummary` + `useAgentProduction`
/// 是四个独立 hook，任一失败只让它那一列变成占位「—」）。状态机与网络解耦：provider
/// 由调用方注入，测试可以逐条钉住加载 / 空 / 错误三态与「一个源失败不影响其它列」。
///
/// 视图不使用属性包装器宏（CLT 约束），本 store 是 `@MainActor @Observable`，
/// 视图以普通常量持有它、只读其状态，改动走下面的命令式方法。
@MainActor
@Observable
public final class AgentOverviewStore {
    /// 单个数据源的加载阶段（矩阵与三个产出源各有一份）。
    public enum Phase: Equatable {
        case idle
        case loading
        case loaded
        case failed(String)

        public var isLoading: Bool { self == .loading }

        /// 失败文案（非失败态为 nil）。
        public var failureMessage: String? {
            if case .failed(let message) = self { return message }
            return nil
        }
    }

    /// 整页状态 —— 验收 2「加载 / 空 / 错误三态齐备」的落点。
    public enum PageState: Equatable {
        /// 首次加载中（还没有任何矩阵数据）。
        case loading
        /// 矩阵请求失败且没有可展示的旧数据。
        case failed(String)
        /// 矩阵加载成功，但窗口内**没有任何业务域被调用过** —— 全部行都是占位「—」，
        /// 必须说清「不是加载失败、是这段时间真的没人用」，否则用户会以为界面坏了。
        case empty
        /// 有数据可展示。
        case ready
    }

    /// 矩阵行的最终形态（注册表补全 + 排序 + 今日产出映射）。
    public private(set) var rows: [AgentOverviewRow] = []

    public private(set) var matrixPhase: Phase = .idle
    public private(set) var complaintsPhase: Phase = .idle
    public private(set) var inspectionsPhase: Phase = .idle
    public private(set) var reportsPhase: Phase = .idle

    /// 上一次成功加载的矩阵（刷新期间保留旧值，界面不闪空）。
    public private(set) var matrix: DomainSummaryResponse?
    public private(set) var complaints: ComplaintProduction?
    public private(set) var inspections: InspectionProduction?
    public private(set) var reports: ReportUploadCompletion?

    /// 选中的业务域（`nil` = 未选中，详情区显示提示）。点同一行再点一次 = 取消选中。
    public private(set) var selectedDomainCode: String?

    /// 最近一次成功拉到矩阵的时刻（页头「数据时间」）。
    public private(set) var lastLoadedAt: Date?

    /// 每次加载的唯一标记：并发 / 取消时用来判断「这个结果还是我这次的么」。
    private var loadToken = UUID()

    private let domains: [AgentDomain]

    public init(domains: [AgentDomain] = AgentDomainCatalog.domains) {
        self.domains = domains
    }

    // MARK: - 派生状态

    /// 整页三态（见 `PageState`）。
    public var pageState: PageState {
        if matrix != nil {
            // 有旧数据时刷新失败 → 仍按 ready 渲染（表格还在），失败由页头横幅提示，
            // 不把整页打成错误页 —— 那会把一份可用的数据藏起来。
            if matrixPhase.failureMessage != nil { return .ready }
            return (matrix?.activityItems ?? []).isEmpty ? .empty : .ready
        }
        if let message = matrixPhase.failureMessage { return .failed(message) }
        return .loading
    }

    /// 有旧数据、但最近一次刷新失败时的告警文案。
    public var matrixRefreshFailure: String? {
        guard matrix != nil else { return nil }
        return matrixPhase.failureMessage
    }

    /// 是否还有请求在跑（页头转圈）。
    public var isRefreshing: Bool {
        [matrixPhase, complaintsPhase, inspectionsPhase, reportsPhase].contains { $0.isLoading }
    }

    /// 失败的今日产出源（用于「哪几列是占位」的提示）。
    public var failedProductionSources: [String] {
        var names: [String] = []
        if complaintsPhase.failureMessage != nil { names.append("客诉") }
        if inspectionsPhase.failureMessage != nil { names.append("巡检") }
        if reportsPhase.failureMessage != nil { names.append("报表") }
        return names
    }

    public var windowDays: Int { matrix?.windowDays ?? 7 }

    /// 窗口内有活动记录的域数（空态判定与页头描述用）。
    public var activityDomainCount: Int {
        rows.filter { $0.activity != nil }.count
    }

    public var selectedRow: AgentOverviewRow? {
        guard let selectedDomainCode else { return nil }
        return rows.first { $0.id == selectedDomainCode }
    }

    // MARK: - 选中

    public func select(domainCode: String) {
        selectedDomainCode = selectedDomainCode == domainCode ? nil : domainCode
    }

    public func clearSelection() {
        selectedDomainCode = nil
    }

    // MARK: - 加载

    /// 没有可用凭据（未登录）时把矩阵置为失败态。
    ///
    /// 不伪造「加载中」也不发请求：没有 key 的请求必然 401，把它显示成「key 被拒绝」
    /// 会把「还没登录」误导成「凭据失效」（同 `AppModel.checkConnection` 的口径）。
    public func failWithoutCredential() {
        matrixPhase = .failed("尚未登录，无法加载业务域矩阵。")
    }

    /// 在模块任务作用域里加载一次（**入口即登记**）。
    ///
    /// 登记到 `scope`（key = 当前选中项的 route id）而不是裸 `Task`：切换模块时由外壳
    /// 统一取消（`ModuleTaskScope`），本模块不必自己记得取消。同一 key 上重复调用
    /// （例如用户连点刷新）会先取消上一次，只保留最后一次结果。
    public func load(
        using provider: AgentOpsDataProviding,
        scope: ModuleTaskScope,
        key: String,
        now: Date = Date(),
        windowDays: Int = 7
    ) async {
        await scope.run(key: key) { [weak self] in
            await self?.performLoad(using: provider, now: now, windowDays: windowDays)
        }.value
    }

    /// 真正的一次加载：四个源并发发起，**谁先回来谁先落地**（不做「全成功才算成功」）。
    func performLoad(
        using provider: AgentOpsDataProviding,
        now: Date = Date(),
        windowDays: Int = 7
    ) async {
        let token = UUID()
        loadToken = token
        let usDate = AgentOpsFormatting.usToday(now: now)

        matrixPhase = .loading
        complaintsPhase = .loading
        inspectionsPhase = .loading
        reportsPhase = .loading

        // 任务组而不是四个 `async let` + 顺序 await：顺序 await 会让「慢的源」把「已经回来
        // 的源」挡在后面（Web 是四个独立 hook，回来一个就点亮一个）。
        await withTaskGroup(of: SourceEvent.self) { group in
            group.addTask {
                .matrix(await Self.capture { try await provider.domainSummary(windowDays: windowDays) })
            }
            group.addTask {
                .complaints(await Self.capture { try await provider.complaintProduction(usDate: usDate) })
            }
            group.addTask {
                .inspections(await Self.capture { try await provider.inspectionProduction() })
            }
            group.addTask {
                .reports(
                    await Self.capture {
                        try await provider.reportUploadCompletion(usDate: usDate, country: "US")
                    }
                )
            }

            for await event in group {
                guard isCurrent(token) else {
                    // 本次加载已作废（切了模块 / 又发起了新的刷新）：取消剩下的子请求并退出，
                    // 不留一个「还给旧 token 写状态」的机会。
                    group.cancelAll()
                    break
                }
                apply(event, now: now)
            }
        }

        guard isCurrent(token) else { return abandonLoad(token: token) }
        rebuildRows()
    }
    private func rebuildRows() {
        rows = AgentOverviewBuilder.rows(
            activity: matrix?.activityItems ?? [],
            // 源失败 → 传 nil → 该列占位「—」（**不**沿用上一次的值：这一版的口径是
            // 「失败即占位」，与 Web 一致；沿用旧值会让用户以为自己看到的是当下的数）。
            complaints: complaintsPhase.failureMessage == nil ? complaints : nil,
            inspections: inspectionsPhase.failureMessage == nil ? inspections : nil,
            reports: reportsPhase.failureMessage == nil ? reports : nil,
            domains: domains
        )
    }

    private func isCurrent(_ token: UUID) -> Bool {
        token == loadToken && !Task.isCancelled
    }

    /// 落地一个先回来的子请求。
    private func apply(_ event: SourceEvent, now: Date) {
        switch event {
        case .matrix(let outcome):
            switch outcome {
            case .success(let value):
                matrix = value
                matrixPhase = .loaded
                lastLoadedAt = now
            case .failure(let message):
                matrixPhase = .failed(message)
            }
        case .complaints(let outcome):
            switch outcome {
            case .success(let value):
                complaints = value
                complaintsPhase = .loaded
            case .failure(let message):
                complaintsPhase = .failed(message)
            }
        case .inspections(let outcome):
            switch outcome {
            case .success(let value):
                inspections = value
                inspectionsPhase = .loaded
            case .failure(let message):
                inspectionsPhase = .failed(message)
            }
        case .reports(let outcome):
            switch outcome {
            case .success(let value):
                reports = value
                reportsPhase = .loaded
            case .failure(let message):
                reportsPhase = .failed(message)
            }
        }
        // 每落地一个源就重算行：单元格立即从占位「—」变成真值（与 Web 的观感一致）。
        rebuildRows()
    }

    /// 一个子请求的归属（任务组里四个源混在同一个流里，靠它分派）。
    private enum SourceEvent: Sendable {
        case matrix(LoadOutcome<DomainSummaryResponse>)
        case complaints(LoadOutcome<ComplaintProduction>)
        case inspections(LoadOutcome<InspectionProduction>)
        case reports(LoadOutcome<ReportUploadCompletion>)
    }

    /// 一次子请求的结果：成功带值 / 失败带**已本地化**的文案。
    private enum LoadOutcome<Value: Sendable>: Sendable {
        case success(Value)
        case failure(String)
    }

    /// 本次加载被取消（切换模块）：把还在 loading 的源退回 idle。
    ///
    /// 退回 idle 而不是留在 loading：留在 loading 会让下次进入本页看到一个「一直在转」
    /// 的界面（旧任务的收尾不会再回来写状态）。已有数据一律保留。
    private func abandonLoad(token: UUID) {
        guard token == loadToken else { return }
        // 逐个把仍在 loading 的源退回 idle（`for` 循环变量是拷贝，无法就地改属性）。
        if matrixPhase.isLoading { matrixPhase = .idle }
        if complaintsPhase.isLoading { complaintsPhase = .idle }
        if inspectionsPhase.isLoading { inspectionsPhase = .idle }
        if reportsPhase.isLoading { reportsPhase = .idle }
        rebuildRows()
    }

    static func message(for error: Error) -> String {
        if let apiError = error as? APIError { return apiError.displayMessage }
        return error.localizedDescription
    }

    /// 把「可能抛错」的一次调用收敛成 `LoadOutcome`，让四个源可以并发发起后各自落地。
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
