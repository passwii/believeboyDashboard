import BelieveBoyKit
import Foundation

/// 可编排的「数据流总览」数据源假实现：每个源独立可设「成功值 / 失败 / 挂起」。
///
/// 为什么需要它：这一页的状态机有两条容易写错的分支 —— 「一个源失败不影响其它列」与
/// 「切换模块时在跑的请求被取消且不落成错误态」。两条都要求**精确控制哪个源什么时候
/// 返回**，打桩 URLProtocol 做不到「让第二个请求永远不返回」（它只能在响应里返回内容），
/// 故在 provider 这一层做假实现。
///
/// `@unchecked Sendable` + 锁：测试从一个 `@MainActor` 用例里改配置、从后台任务里读配置。
final class ScriptedAgentOpsProvider: AgentOpsDataProviding, @unchecked Sendable {
    /// 单个源的编排结果。
    enum Outcome<Value: Sendable>: Sendable {
        case value(Value)
        /// 抛 `APIError.http`（贴近真实失败形态：非 2xx）。
        case failure(status: Int)
        /// 一直挂起，直到任务被取消 —— 用来观测 loading 中间态与取消行为。
        case hang
    }

    /// 挂起源被取消时的记录器（断言「确实取消了」）。
    let cancellation = CancellationRecorder()

    private let lock = NSLock()
    private var matrixOutcome: Outcome<DomainSummaryResponse>
    private var complaintsOutcome: Outcome<ComplaintProduction>
    private var inspectionsOutcome: Outcome<InspectionProduction>
    private var reportsOutcome: Outcome<ReportUploadCompletion>

    private var recordedDates: [String] = []
    private var recordedCountries: [String] = []
    private var recordedWindows: [Int] = []
    private var recordedManifest: [String] = []

    init(
        matrix: Outcome<DomainSummaryResponse> = .value(DomainSummaryResponse(items: [])),
        complaints: Outcome<ComplaintProduction> = .value(ComplaintProduction(hasRun: false, needsReply: nil)),
        inspections: Outcome<InspectionProduction> = .value(InspectionProduction(submitted: 0, total: 0)),
        reports: Outcome<ReportUploadCompletion> = .value(ReportUploadCompletion(uploaded: 0, total: 0))
    ) {
        matrixOutcome = matrix
        complaintsOutcome = complaints
        inspectionsOutcome = inspections
        reportsOutcome = reports
    }

    // MARK: - 编排

    func setMatrix(_ outcome: Outcome<DomainSummaryResponse>) { withLock { matrixOutcome = outcome } }
    func setComplaints(_ outcome: Outcome<ComplaintProduction>) { withLock { complaintsOutcome = outcome } }
    func setInspections(_ outcome: Outcome<InspectionProduction>) { withLock { inspectionsOutcome = outcome } }
    func setReports(_ outcome: Outcome<ReportUploadCompletion>) { withLock { reportsOutcome = outcome } }

    // MARK: - 观测

    /// 请求过的美西日期（断言「今天」确实是**美西**今天，而不是本机时区）。
    var requestedDates: [String] { withLock { recordedDates } }
    var requestedCountries: [String] { withLock { recordedCountries } }
    var requestedWindows: [Int] { withLock { recordedWindows } }
    /// 被调用过的源顺序（`matrix` / `complaints` / `inspections` / `reports`）。
    var requestedSources: [String] { withLock { recordedManifest } }

    // MARK: - AgentOpsDataProviding

    func domainSummary(windowDays: Int) async throws -> DomainSummaryResponse {
        let outcome = withLock {
            recordedManifest.append("matrix")
            recordedWindows.append(windowDays)
            return matrixOutcome
        }
        return try await resolve(outcome)
    }

    func complaintProduction(usDate: String) async throws -> ComplaintProduction {
        let outcome = withLock {
            recordedManifest.append("complaints")
            recordedDates.append(usDate)
            return complaintsOutcome
        }
        return try await resolve(outcome)
    }

    func inspectionProduction() async throws -> InspectionProduction {
        let outcome = withLock {
            recordedManifest.append("inspections")
            return inspectionsOutcome
        }
        return try await resolve(outcome)
    }

    func reportUploadCompletion(usDate: String, country: String) async throws -> ReportUploadCompletion {
        let outcome = withLock {
            recordedManifest.append("reports")
            recordedDates.append(usDate)
            recordedCountries.append(country)
            return reportsOutcome
        }
        return try await resolve(outcome)
    }

    private func resolve<Value: Sendable>(_ outcome: Outcome<Value>) async throws -> Value {
        switch outcome {
        case .value(let value):
            return value
        case .failure(let status):
            // 与 `APIClient.statusError` 同口径：401/403 是「凭据需修」，不是普通 http 错误。
            // 假实现若一律抛 `.http`，就测不到 UI 对凭据失效的处理。
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

/// 记录请求 URL（含 query）的线程安全盒子 —— 打桩 handler 是 `@Sendable`，捕获不了可变数组。
final class URLCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [URL] = []

    func append(_ url: URL?) {
        guard let url else { return }
        withLock { storage.append(url) }
    }

    var urls: [URL] { withLock { storage } }
    /// 请求 URL 的完整字符串（断言 query 用）。
    var strings: [String] { urls.map(\.absoluteString) }

    /// 某个路径的 query（`nil` = 该路径没被请求过）。
    func query(forPath path: String) -> String? {
        urls.first { $0.path == path }?.query
    }

    private func withLock<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}

extension DomainActivity {
    /// 测试用条目（只给关心的字段，其余置 0）。参数名与属性名一致（`…24H` / `…7D`）——
    /// 避免调用点再出现一套「看起来更顺眼但与真实字段不同名」的标签。
    static func fixture(
        domain: String,
        calls24H: Int = 0,
        calls7D: Int = 0,
        writes24H: Int = 0,
        writes7D: Int = 0,
        errors7D: Int = 0,
        lastActiveAt: String? = nil
    ) -> DomainActivity {
        DomainActivity(
            domain: domain,
            calls24H: calls24H,
            calls7D: calls7D,
            writes24H: writes24H,
            writes7D: writes7D,
            errors7D: errors7D,
            lastActiveAt: lastActiveAt
        )
    }
}
