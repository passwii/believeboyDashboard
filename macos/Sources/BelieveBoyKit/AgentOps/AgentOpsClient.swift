import Foundation

/// 「运营 → 数据流总览」的数据源抽象。
///
/// 单独抽协议而不是让 store 直接持有 `APIClient`：矩阵的三态（加载 / 空 / 错误）与
/// 单频道降级（一个源失败只影响自己那列）是**状态机逻辑**，必须能在不碰网络、
/// 不依赖真实后端的前提下逐条钉住。测试注入假实现（含失败 / 挂起 / 取消三种）。
public protocol AgentOpsDataProviding: Sendable {
    /// 业务域活动聚合（统计档，见 `AgentOpsClient`）。
    func domainSummary(windowDays: Int) async throws -> DomainSummaryResponse
    /// 客诉产出（美西 `usDate` 当天）。
    func complaintProduction(usDate: String) async throws -> ComplaintProduction
    /// 巡检产出（当前周期的已提交 / 总报告数）。
    func inspectionProduction() async throws -> InspectionProduction
    /// 报表上传完成度（美西 `usDate` 当天）。`country` 为站点（Web 前端恒传 `US`）。
    func reportUploadCompletion(usDate: String, country: String) async throws -> ReportUploadCompletion
}

public extension AgentOpsDataProviding {
    /// 默认窗口天数 = Web 前端契约里的恒值 7。
    func domainSummary() async throws -> DomainSummaryResponse {
        try await domainSummary(windowDays: 7)
    }

    func reportUploadCompletion(usDate: String) async throws -> ReportUploadCompletion {
        try await reportUploadCompletion(usDate: usDate, country: "US")
    }
}

/// `AgentOpsDataProviding` 的真实实现：直连 `backend/` 的 4 个既有端点（零后端改动）。
///
/// 端点与口径（`backend/app/api/v1/endpoints/`）：
///
/// | 用途 | 端点 | 超时档 |
/// | --- | --- | --- |
/// | 业务域活动矩阵 | `GET /agent-ops/domain-summary?days=7` | `.stats`（15s） |
/// | 今日产出·客诉 | `GET /complaints/overview?date=<美西今天>` | `.list`（5s） |
/// | 今日产出·巡检 | `GET /inspections/periods/current` → `/periods/{id}/overview` | `.list`（5s） |
/// | 今日产出·报表 | `GET /rpa-reports/status?report_date=<美西今天>&country=US` | `.list`（5s） |
///
/// 为什么矩阵走统计档：它是 `agent_api_audit_log` 上的时间范围聚合（`GROUP BY
/// operation_type`），命中 `idx_aaal_created_at` range scan 后仍要扫一个 7 天窗口 ——
/// 这类查询在 5s 档上偶发超时（Web 走代理时正是拿默认 5s 档），超时表现为「整个矩阵
/// 变空 + 占位」，用户分不清是没数据还是被掐断。今日产出三源是轻量读取，保持 5s 档。
public struct AgentOpsClient: AgentOpsDataProviding {
    private let client: APIClient

    public init(client: APIClient) {
        self.client = client
    }

    public func domainSummary(windowDays: Int = 7) async throws -> DomainSummaryResponse {
        try await client.get(
            "/agent-ops/domain-summary",
            query: ["days": String(windowDays)],
            tier: .stats
        )
    }

    public func complaintProduction(usDate: String) async throws -> ComplaintProduction {
        let response: ComplaintOverviewResponse = try await client.get(
            "/complaints/overview",
            query: ["date": usDate],
            tier: .list
        )
        return response.production
    }

    public func inspectionProduction() async throws -> InspectionProduction {
        let current: InspectionPeriodResponse = try await client.get(
            "/inspections/periods/current",
            tier: .list
        )
        let overview: InspectionOverviewResponse = try await client.get(
            "/inspections/periods/\(current.id)/overview",
            tier: .list
        )
        return InspectionProduction(
            submitted: overview.submittedCount,
            total: overview.totalProjects,
            weekStart: current.weekStart,
            weekEnd: current.weekEnd
        )
    }

    public func reportUploadCompletion(
        usDate: String,
        country: String = "US"
    ) async throws -> ReportUploadCompletion {
        let response: ReportStatusResponse = try await client.get(
            "/rpa-reports/status",
            query: ["report_date": usDate, "country": country],
            tier: .list
        )
        return ReportUploadCompletion(items: response.items)
    }
}
