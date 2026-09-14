import Foundation

/// 「广告分析」的数据源抽象。
///
/// 抽协议的理由与 S4 的 `AgentOpsDataProviding` 相同：三态（加载 / 空 / 错误）、
/// 切 Tab 与改筛选时的取消、刷新失败保留旧表 —— 这些是**状态机逻辑**，必须在
/// 不碰网络的前提下逐条钉住。测试注入假实现（含失败 / 挂起 / 取消三种）。
public protocol AdAnalysisDataProviding: Sendable {
    /// 当前账号可见的项目（`/projects/manage`，按 `X-Operator` 过滤）。
    func projects() async throws -> [AdProject]
    /// 某个 Tab 的一次查询。
    func payload(tab: AdAnalysisTab, query: AdAnalysisQuery) async throws -> AdAnalysisPayload
}

/// `AdAnalysisDataProviding` 的真实实现：直连 `backend/` 既有端点（**零后端改动**）。
///
/// 两层超时（对齐 Web 的代理策略与 `frontend/lib/ad-client-cache.ts:25` 的 15s）：
///
/// | 用途 | 端点 | 超时档 |
/// | --- | --- | --- |
/// | 项目列表 | `GET /projects/manage` | `.list`（5s） —— Web 走默认 5s 代理档 |
/// | 10 个 ad-analysis 端点 | `GET /ad-analysis/{key}` | `.stats`（15s） —— 全是报表聚合，Web 客户端 15s 超时 |
///
/// 为什么 ad-analysis 走统计档而不是列表档：这 10 个端点每次都在 `ad_upload_*` 报表行上
/// 按项目 + 站点 + 日期区间做聚合（`backend/app/services/ad/`），全量历史（不传日期）时
/// 开销随报表量增长；5s 档会在 Web 上正常、在桌面端偶发「提前超时 → 整页变空」。
/// Web 的前端取数用的是 15s（`AD_FETCH_TIMEOUT_MS`），这里与它对齐。
///
/// 请求头由 `APIClient` 统一注入：`X-API-Key` + 账号上下文（`X-Operator` /
/// `X-User-Id` / `X-Is-Admin`）—— 后端按 `X-Operator` 判定项目可见性，缺了它
/// 可能拿到 403（或看到别人的数据，取决于端点）。
public struct AdAnalysisClient: AdAnalysisDataProviding {
    private let client: APIClient

    public init(client: APIClient) {
        self.client = client
    }

    public func projects() async throws -> [AdProject] {
        try await client.get(AdAnalysisCatalog.projectsEndpoint, tier: .list)
    }

    public func payload(tab: AdAnalysisTab, query: AdAnalysisQuery) async throws -> AdAnalysisPayload {
        try await client.get(tab.endpoint, query: query.parameters, tier: .stats)
    }
}
