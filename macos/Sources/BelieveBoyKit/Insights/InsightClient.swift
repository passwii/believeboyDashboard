import Foundation

/// 洞察列表查询（`GET /ai-insights` 的查询串）。
///
/// `insight_type` 是**可选**的：Web 的洞察页只按项目过滤（`loadInsights` 里只发
/// `project_id` + `limit`），而「AI 广告分析」页的历史列表固定带
/// `insight_type=ad_analysis` —— 两种口径都在这一个结构体里表达，不写两套。
public struct InsightListQuery: Equatable, Sendable {
    public var projectID: Int?
    public var country: String?
    /// 旧状态机筛选（`pending | generating | completed | failed`）。
    public var statusFilter: String?
    public var insightType: String?
    public var limit: Int
    public var offset: Int

    public init(
        projectID: Int? = nil,
        country: String? = nil,
        statusFilter: String? = nil,
        insightType: String? = nil,
        limit: Int = InsightCatalog.pageSize,
        offset: Int = 0
    ) {
        self.projectID = projectID
        self.country = country
        self.statusFilter = statusFilter
        self.insightType = insightType
        self.limit = limit
        self.offset = offset
    }

    /// 实际发出去的查询参数（空值一律不发 —— 后端按 `is not None` 判分支，
    /// 发一个空串会被当成「筛 `country == ''`」）。
    public var parameters: [String: String] {
        var result: [String: String] = [
            "limit": String(limit),
            "offset": String(offset),
        ]
        if let projectID { result["project_id"] = String(projectID) }
        if let country { result["country"] = country }
        if let statusFilter { result["status_filter"] = statusFilter }
        if let insightType { result["insight_type"] = insightType }
        return result
    }
}

/// 定时列表查询（`GET /ai-insights/schedules`）。
public struct InsightScheduleQuery: Equatable, Sendable {
    public var projectID: Int?
    public var isActive: Bool?
    public var insightType: String?

    public init(projectID: Int? = nil, isActive: Bool? = nil, insightType: String? = nil) {
        self.projectID = projectID
        self.isActive = isActive
        self.insightType = insightType
    }

    public var parameters: [String: String] {
        var result: [String: String] = [:]
        if let projectID { result["project_id"] = String(projectID) }
        if let isActive { result["is_active"] = isActive ? "true" : "false" }
        if let insightType { result["insight_type"] = insightType }
        return result
    }
}

/// 「AI 洞察三页」的数据源抽象。
///
/// 抽协议的理由与 S5.1 / S5.2 相同：三态（加载 / 空 / 错误 + 重试）、切筛选 / 切页 /
/// 切模块时的取消不落错误态、刷新失败保留旧表、SSE 断线重连 —— 这些是**状态机逻辑**，
/// 必须在完全不碰网络的前提下逐条钉住。测试注入假实现（成功 / 失败 / 挂起 / 逐帧四种编排）。
public protocol InsightDataProviding: Sendable {
    /// 当前账号可见的项目（`/projects/manage`，按 `X-Operator` 过滤）。
    func projects() async throws -> [AdProject]
    /// 洞察列表（分页 + 筛选）。
    func insights(query: InsightListQuery) async throws -> InsightListResponse
    /// 洞察明细（含 Markdown 正文与 `strategy_metadata`）。
    func insightDetail(id: Int) async throws -> InsightDetail
    /// 定时任务列表（只读）。
    func schedules(query: InsightScheduleQuery) async throws -> InsightScheduleListResponse
    /// canonical run 快照（权威 detail）。
    func runDetail(runID: String) async throws -> InsightRunDetail
    /// 旧链路 SSE（**不带** `id:`，后端不认 `Last-Event-ID`）。
    func insightStream(id: Int) -> AsyncThrowingStream<ServerSentEvent, Error>
    /// canonical SSE（带 `id:` 游标，认 `Last-Event-ID`）。
    func runStream(runID: String, lastEventID: String?) -> AsyncThrowingStream<ServerSentEvent, Error>
}

/// 真实实现：直连 `backend/` 既有端点（零后端新增路由）。
///
/// 分层超时（对齐 BLF-1062 §口径 6 与 Web `backend-proxy-timeout-policy.ts`）：
///
/// | 用途 | 档 | 值 |
/// | --- | --- | --- |
/// | 列表 / 明细 / 定时列表 / run detail | `.list` | 5s |
/// | 两条 SSE | `.stream` | 不设超时（写 `RequestTier.unboundedTimeout` 极大有限值） |
///
/// **没有**「run 启动档 30s」那一档：本批不做写链路（启动 run 属 S6），因此不需要它 ——
/// 写进这里只会是一条永不生效的常量。
public struct InsightClient: InsightDataProviding {
    private let client: APIClient

    public init(client: APIClient) {
        self.client = client
    }

    public func projects() async throws -> [AdProject] {
        try await client.get(AdSharedCatalog.projectsEndpoint, tier: InsightCatalog.readTier)
    }

    public func insights(query: InsightListQuery) async throws -> InsightListResponse {
        try await client.get(
            InsightCatalog.insightsEndpoint,
            query: query.parameters,
            tier: InsightCatalog.readTier
        )
    }

    public func insightDetail(id: Int) async throws -> InsightDetail {
        try await client.get(
            InsightCatalog.insightDetailEndpoint(id: id),
            tier: InsightCatalog.readTier
        )
    }

    public func schedules(query: InsightScheduleQuery) async throws -> InsightScheduleListResponse {
        try await client.get(
            InsightCatalog.schedulesEndpoint,
            query: query.parameters,
            tier: InsightCatalog.readTier
        )
    }

    public func runDetail(runID: String) async throws -> InsightRunDetail {
        try await client.get(
            InsightCatalog.runDetailEndpoint(runID: runID),
            tier: InsightCatalog.readTier
        )
    }

    public func insightStream(id: Int) -> AsyncThrowingStream<ServerSentEvent, Error> {
        // 旧链路不发 `id:`，也不认 `Last-Event-ID`（只有 `insight_runs.py` / `ai_chat_v2.py` 读它）
        // —— 故不传 `lastEventID`，游标由「重连后回读 detail 权威快照」承担。
        client.stream(
            InsightCatalog.insightStreamEndpoint(id: id),
            tier: InsightCatalog.streamTier
        )
    }

    public func runStream(
        runID: String,
        lastEventID: String?
    ) -> AsyncThrowingStream<ServerSentEvent, Error> {
        client.stream(
            InsightCatalog.runStreamEndpoint(runID: runID),
            lastEventID: lastEventID,
            tier: InsightCatalog.streamTier
        )
    }
}

/// 游标簿记：`id:` → 去重 + 续传头（对齐 Web `consumeInsightStream` 的
/// `lastEventId` / `seenEventIds` 两条语义）。
///
/// 纯值类型、无网络：**「重连后同一帧只应用一次」**这条最容易错的地方（少一个去重就会让
/// 续传把正文写两遍、进度条来回跳）因此可以离线逐条钉住。
public struct InsightCursorTracker: Sendable, Equatable {
    /// 最近一次 `id:` —— 断线重连时原样回传为 `Last-Event-ID`。
    public private(set) var lastEventID: String?
    private var seenEventIDs: Set<String>

    public init(seenEventIDs: Set<String> = []) {
        self.seenEventIDs = seenEventIDs
    }

    /// 已见游标数（测试与「续传是否真的去重」用）。
    public var seenCount: Int { seenEventIDs.count }

    public func hasSeen(_ eventID: String) -> Bool { seenEventIDs.contains(eventID) }

    /// 登记一帧并回答「该不该应用」。
    ///
    /// - `id:` 存在：记为最新游标；已见过 → `false`（重复帧，丢弃）。
    /// - `id:` 缺失（旧链路 / 无游标的中间件）：无游标可去重，一律 `true`。
    public mutating func accept(eventID: String?) -> Bool {
        guard let eventID else { return true }
        lastEventID = eventID
        return seenEventIDs.insert(eventID).inserted
    }

    /// 从 canonical 事件信封补记游标（帧里 `id:` 缺失但 `run_id/attempt/seq` 齐全时）。
    public mutating func accept(event: InsightRunEvent) -> Bool {
        accept(eventID: InsightEventCursor(event: event).wireValue)
    }
}
