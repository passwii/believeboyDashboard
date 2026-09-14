import Foundation

/// 「广告数据」的数据源抽象。
///
/// 抽协议的理由与 S5.1 的 `AdAnalysisDataProviding` 相同：三态（加载 / 空 / 错误）、切报表类型与
/// 改筛选时的取消、刷新失败保留旧表、附属的入库文件信息失败不拖垮主表 —— 这些是**状态机逻辑**，
/// 必须在完全不碰网络的前提下逐条钉住。测试注入假实现（含成功 / 失败 / 挂起三种编排）。
public protocol AdDataDataProviding: Sendable {
    /// 当前账号可见的项目（`/projects/manage`，按 `X-Operator` 过滤）。
    func projects() async throws -> [AdProject]
    /// 某个项目 + 站点下「最近入库的广告报表文件」（只用于显示最近一次入库信息）。
    func uploadFiles(projectID: Int, query: AdUploadFilesQuery) async throws -> [AdUploadFileItem]
    /// 某个报表类型的原始行。
    func rawPayload(
        reportType: AdDataReportType,
        projectID: Int,
        query: AdDataQuery
    ) async throws -> AdDataRawPayload
}

/// `AdDataDataProviding` 的真实实现：直连 `backend/` **既有**内部端点（零后端新增路由）。
///
/// 通道选择（BLF-1057 已核实）：走 `/internal/ad-data/*`，**不走** `/api/v1/agent/*`。
/// agent 域的 raw 路由要 `require_agent_credential`（Bearer + `X-Agent-Id` + agent key）
/// 外加 `require_business_scope("ad_analysis")`，而桌面端登录拿到的是账号 `blf_` key，
/// 打不通；`/internal/ad-data/*` 的 `protected` = `require_api_key`，本来就支持 `blf_` 账号 key
/// （BLF-711），桌面端直连即可。
///
/// 分层超时（两档，对齐 Web 的 `AD_FETCH_TIMEOUT_MS = 15_000`）：
///
/// | 用途 | 端点 | 超时档 |
/// | --- | --- | --- |
/// | 项目列表 | `GET /projects/manage` | `.list`（5s） |
/// | 入库文件列表 | `GET /internal/ad-data/projects/{id}/ad-upload-files` | `.list`（5s） |
/// | 10 个原始行端点 | `GET /internal/ad-data/projects/{id}/ad-{ep}-raw` | `.stats`（15s） |
///
/// 原始行端点走统计档的理由：它们要在 `ad_upload_*_rows` 上按项目 + 站点 + 日期窗口取整段
/// 原始行（最大端点实测 7805 行 / 9.9 MB / 1.78 s），5s 档会在数据量再涨一档时偶发「提前超时
/// → 整页变空」。入库文件列表是纯元数据查询（500 条约 150 KB / 30 ms），列表档足够，
/// 且它超时只影响一行提示、不影响主表。
public struct AdDataClient: AdDataDataProviding {
    private let client: APIClient

    public init(client: APIClient) {
        self.client = client
    }

    public func projects() async throws -> [AdProject] {
        try await client.get(AdSharedCatalog.projectsEndpoint, tier: .list)
    }

    public func uploadFiles(
        projectID: Int,
        query: AdUploadFilesQuery
    ) async throws -> [AdUploadFileItem] {
        try await client.get(
            AdDataCatalog.uploadFilesEndpoint(projectID: projectID),
            query: query.parameters,
            tier: .list
        )
    }

    public func rawPayload(
        reportType: AdDataReportType,
        projectID: Int,
        query: AdDataQuery
    ) async throws -> AdDataRawPayload {
        try await client.get(
            AdDataCatalog.rawEndpoint(projectID: projectID, endpoint: reportType.endpoint),
            query: query.parameters,
            tier: .stats
        )
    }
}
