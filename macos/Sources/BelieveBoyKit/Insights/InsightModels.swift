import Foundation

// MARK: - 旧链路（`/ai-insights`）：列表 / 明细 / 定时列表

/// 洞察列表的一行（后端 `InsightItem`）。
///
/// 列表**不含正文**（`content` 只在 `GET /ai-insights/{id}` 上）—— 桌面端因此把「点开明细」
/// 当成一次真请求，而不是从列表里凑。
public struct InsightListItem: Decodable, Sendable, Equatable, Identifiable {
    public let id: Int
    public let projectId: Int
    public let projectName: String
    public let country: String
    public let title: String
    public let insightType: String
    public let dateRangeStart: String
    public let dateRangeEnd: String
    /// 旧状态机：`pending | generating | completed | failed`。
    public let status: String
    public let subStatus: String?
    public let errorMessage: String?
    public let createdBy: String
    public let createdAt: String?
    public let updatedAt: String?

    public init(
        id: Int,
        projectId: Int,
        projectName: String,
        country: String,
        title: String,
        insightType: String,
        dateRangeStart: String,
        dateRangeEnd: String,
        status: String,
        subStatus: String?,
        errorMessage: String?,
        createdBy: String,
        createdAt: String?,
        updatedAt: String?
    ) {
        self.id = id
        self.projectId = projectId
        self.projectName = projectName
        self.country = country
        self.title = title
        self.insightType = insightType
        self.dateRangeStart = dateRangeStart
        self.dateRangeEnd = dateRangeEnd
        self.status = status
        self.subStatus = subStatus
        self.errorMessage = errorMessage
        self.createdBy = createdBy
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

/// 洞察列表响应（`{items, total}`）。
///
/// `total` 是**窗口内总数**（后端 `select count(*)`），与列表长度不是一回事 —— 分页判定
/// 必须用它，不能用 `items.count`。
public struct InsightListResponse: Decodable, Sendable, Equatable {
    public let items: [InsightListItem]
    public let total: Int

    public init(items: [InsightListItem], total: Int) {
        self.items = items
        self.total = total
    }
}


/// 洞察明细（后端 `InsightDetail`；列表字段 + `content` + `strategy_metadata`）。
public struct InsightDetail: Decodable, Sendable, Equatable, Identifiable {
    public let id: Int
    public let projectId: Int
    public let projectName: String
    public let country: String
    public let title: String
    public let insightType: String
    public let dateRangeStart: String
    public let dateRangeEnd: String
    public let status: String
    public let subStatus: String?
    public let errorMessage: String?
    public let createdBy: String
    public let createdAt: String?
    public let updatedAt: String?
    /// Markdown 正文。终态前可能是空串（正文只在终态帧里回来）。
    public let content: String?
    /// JSON **字符串**（不是对象）：后端 `strategy_metadata` 是 `Text` 列，原样透出。
    /// 「AI 广告分析」的维度面板要从它里面取 `evolution_metadata`（见 `InsightDimensionCoverage`）。
    public let strategyMetadata: String?

    public init(
        id: Int,
        projectId: Int,
        projectName: String,
        country: String,
        title: String,
        insightType: String,
        dateRangeStart: String,
        dateRangeEnd: String,
        status: String,
        subStatus: String?,
        errorMessage: String?,
        createdBy: String,
        createdAt: String?,
        updatedAt: String?,
        content: String?,
        strategyMetadata: String?
    ) {
        self.id = id
        self.projectId = projectId
        self.projectName = projectName
        self.country = country
        self.title = title
        self.insightType = insightType
        self.dateRangeStart = dateRangeStart
        self.dateRangeEnd = dateRangeEnd
        self.status = status
        self.subStatus = subStatus
        self.errorMessage = errorMessage
        self.createdBy = createdBy
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.content = content
        self.strategyMetadata = strategyMetadata
    }
}

/// 定时洞察任务（后端 `InsightScheduleItem`）。
///
/// 本批只读：`is_active` / `run_count` / `failure_count` / `next_run_at` 全部照 Web 展示，
/// 但**不提供** toggle / run-now / CRUD（属 S6 写链路）。
public struct InsightScheduleItem: Decodable, Sendable, Equatable, Identifiable {
    public let id: Int
    public let projectId: Int
    public let projectName: String
    public let country: String
    public let insightType: String
    public let cronExpression: String
    public let dateRangeStrategy: String?
    public let model: String?
    public let isActive: Bool
    public let runCount: Int
    public let failureCount: Int
    public let lastRunAt: String?
    public let lastInsightId: Int?
    public let lastError: String?
    public let nextRunAt: String?
    public let createdBy: String?
    public let createdAt: String?
    public let updatedAt: String?

    public init(
        id: Int,
        projectId: Int,
        projectName: String,
        country: String,
        insightType: String,
        cronExpression: String,
        dateRangeStrategy: String?,
        model: String?,
        isActive: Bool,
        runCount: Int,
        failureCount: Int,
        lastRunAt: String?,
        lastInsightId: Int?,
        lastError: String?,
        nextRunAt: String?,
        createdBy: String?,
        createdAt: String?,
        updatedAt: String?
    ) {
        self.id = id
        self.projectId = projectId
        self.projectName = projectName
        self.country = country
        self.insightType = insightType
        self.cronExpression = cronExpression
        self.dateRangeStrategy = dateRangeStrategy
        self.model = model
        self.isActive = isActive
        self.runCount = runCount
        self.failureCount = failureCount
        self.lastRunAt = lastRunAt
        self.lastInsightId = lastInsightId
        self.lastError = lastError
        self.nextRunAt = nextRunAt
        self.createdBy = createdBy
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

/// 定时列表响应。
public struct InsightScheduleListResponse: Decodable, Sendable, Equatable {
    public let items: [InsightScheduleItem]
    public let total: Int

    public init(items: [InsightScheduleItem], total: Int) {
        self.items = items
        self.total = total
    }
}

// MARK: - 旧链路 SSE 帧

/// 旧链路（`/ai-insights/{id}/stream`）的一帧。
///
/// 与 Web `legacy-insight-compat.ts` 的 `LegacyInsightFrame` 逐字段同义：后端把每帧的
/// 「业务形状」直接 JSON 序列化进 `data:`，帧本身不带 `id:` / `event:`。
///
/// `chunk` 帧后端**当前并不发**（正文只在终态帧里回来），但 Web 做了向后兼容读取，
/// 桌面端照做 —— 少了这一支，后端哪天开始续写草稿就会整段丢正文。
public enum LegacyInsightFrame: Sendable, Equatable {
    case status(
        status: String,
        subStatus: String?,
        insightID: Int?,
        title: String?,
        content: String?,
        errorMessage: String?
    )
    case chunk(delta: String)
    case done(
        insightID: Int?,
        title: String?,
        content: String?,
        status: String?,
        errorMessage: String?
    )
    case error(message: String, insightID: Int?, status: String?, errorMessage: String?)
    case ping

    /// 帧类型名（`status` / `chunk` / `done` / `error` / `ping`）。
    public var name: String {
        switch self {
        case .status: return "status"
        case .chunk: return "chunk"
        case .done: return "done"
        case .error: return "error"
        case .ping: return "ping"
        }
    }

    /// 解析一帧的 `data:` 正文。非法载荷返回 `nil`（不抛 —— 一帧坏数据不该杀掉整条流）。
    public static func parse(_ data: String) -> LegacyInsightFrame? {
        let trimmed = data.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let bytes = trimmed.data(using: .utf8) else { return nil }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        guard let payload = try? decoder.decode(Payload.self, from: bytes) else { return nil }

        switch payload.type {
        case "status":
            guard let status = payload.status else { return nil }
            return .status(
                status: status,
                subStatus: payload.subStatus,
                insightID: payload.insightId,
                title: payload.title,
                content: payload.content,
                errorMessage: payload.errorMessage
            )
        case "chunk":
            guard let delta = payload.delta else { return nil }
            return .chunk(delta: delta)
        case "done":
            return .done(
                insightID: payload.insightId,
                title: payload.title,
                content: payload.content,
                status: payload.status,
                errorMessage: payload.errorMessage
            )
        case "error":
            let message = payload.error ?? payload.errorMessage ?? "洞察生成失败"
            return .error(
                message: message,
                insightID: payload.insightId,
                status: payload.status,
                errorMessage: payload.errorMessage
            )
        case "ping":
            return .ping
        default:
            return nil
        }
    }

    /// 帧信封：所有字段可选，由 `type` 决定该读哪几个。
    private struct Payload: Decodable {
        let type: String
        let status: String?
        let subStatus: String?
        let insightId: Int?
        let title: String?
        let content: String?
        let errorMessage: String?
        let delta: String?
        let error: String?
    }
}

// MARK: - canonical run（`/insight/runs/{run_id}`）

/// canonical 输出的一个槽（后端 `InsightOutput`）。
public struct InsightRunOutput: Decodable, Sendable, Equatable {
    public let format: String?
    public let content: String
    public let contentSha256: String?

    public init(format: String?, content: String, contentSha256: String?) {
        self.format = format
        self.content = content
        self.contentSha256 = contentSha256
    }
}

/// token 用量（后端 `InsightUsage`）。
public struct InsightRunUsage: Decodable, Sendable, Equatable {
    public let inputTokens: Int
    public let outputTokens: Int
    public let totalTokens: Int

    public init(inputTokens: Int, outputTokens: Int, totalTokens: Int) {
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.totalTokens = totalTokens
    }
}

/// canonical typed error（后端 `InsightError`）。
public struct InsightRunError: Decodable, Sendable, Equatable {
    public let code: String
    public let message: String
    public let retryable: Bool?
    public let retryAfterSeconds: Int?
    public let partialAvailable: Bool?
    public let field: String?
    public let slot: String?

    public init(
        code: String,
        message: String,
        retryable: Bool?,
        retryAfterSeconds: Int?,
        partialAvailable: Bool?,
        field: String?,
        slot: String?
    ) {
        self.code = code
        self.message = message
        self.retryable = retryable
        self.retryAfterSeconds = retryAfterSeconds
        self.partialAvailable = partialAvailable
        self.field = field
        self.slot = slot
    }
}

/// 可恢复性描述（后端 `InsightResumeInfo`）。
public struct InsightRunResume: Decodable, Sendable, Equatable {
    public let latestEventId: String?
    public let currentAttempt: Int
    public let historyAvailable: Bool

    public init(latestEventId: String?, currentAttempt: Int, historyAvailable: Bool) {
        self.latestEventId = latestEventId
        self.currentAttempt = currentAttempt
        self.historyAvailable = historyAvailable
    }
}

/// canonical run 快照（后端 `InsightRunDetail`）—— 页面重开、SSE 过期、后台完成后
/// 都靠它恢复（BLF-1062 §口径 2 的「权威快照」）。
///
/// `title` / `artifact_id` / `usage` / `error` / `completed_at` 都可能为 `null`（真实响应
/// 里就如此，见 `Fixtures/Insight/insight-run-detail-*.json`），故全部可选。
public struct InsightRunDetail: Decodable, Sendable, Equatable {
    public let schemaVersion: Int
    public let runId: String
    public let attempt: Int
    public let roleId: String
    public let roleVersion: Int
    public let projectId: Int
    public let country: String
    /// canonical 状态机，7 态（`queued | aggregating | generating | finalizing |
    /// completed | failed | cancelled`）。
    public let status: String
    /// 阶段，是 `status` 的子集。
    public let stage: String
    public let progressPercent: Int
    public let outputFormat: String?
    public let title: String?
    /// 槽 → 输出。终态才有内容。
    public let outputs: [String: InsightRunOutput]
    public let artifactId: String?
    public let usage: InsightRunUsage?
    public let error: InsightRunError?
    public let resume: InsightRunResume?
    public let createdAt: String?
    public let startedAt: String?
    public let completedAt: String?
    public let updatedAt: String?

    public init(
        schemaVersion: Int,
        runId: String,
        attempt: Int,
        roleId: String,
        roleVersion: Int,
        projectId: Int,
        country: String,
        status: String,
        stage: String,
        progressPercent: Int,
        outputFormat: String?,
        title: String?,
        outputs: [String: InsightRunOutput],
        artifactId: String?,
        usage: InsightRunUsage?,
        error: InsightRunError?,
        resume: InsightRunResume?,
        createdAt: String?,
        startedAt: String?,
        completedAt: String?,
        updatedAt: String?
    ) {
        self.schemaVersion = schemaVersion
        self.runId = runId
        self.attempt = attempt
        self.roleId = roleId
        self.roleVersion = roleVersion
        self.projectId = projectId
        self.country = country
        self.status = status
        self.stage = stage
        self.progressPercent = progressPercent
        self.outputFormat = outputFormat
        self.title = title
        self.outputs = outputs
        self.artifactId = artifactId
        self.usage = usage
        self.error = error
        self.resume = resume
        self.createdAt = createdAt
        self.startedAt = startedAt
        self.completedAt = completedAt
        self.updatedAt = updatedAt
    }

    /// 默认输出槽（旧链路正文所在槽）。
    public static let defaultSlot = "main"

    /// 取某个槽的正文（缺槽返回空串，不返回 nil —— 调用方只关心「有没有正文」）。
    public func content(slot: String = defaultSlot) -> String {
        outputs[slot]?.content ?? ""
    }

    /// 是否仍在推进（决定面板给「取消」还是「重试」；本批不做动作，只决定文案与转圈）。
    public var isActive: Bool { InsightRunStatusMachine.isActive(status) }

    public var isTerminal: Bool { InsightRunStatusMachine.isTerminal(status) }
}

// MARK: - canonical SSE 事件

/// canonical 流的一帧（后端 `InsightEvent` 家族 + `_sse_frame` 的 `id:` 游标）。
///
/// 形状是「一个信封 + 各类型可选字段」的**并集**：后端用 Pydantic 的判别联合序列化，
/// 但字段名在同一层，桌面端解成并集比解 7 个联合分支简单得多，也不会因为后端新增类型
/// 而整帧解码失败（未知类型只丢 `type` 之外的语义，不丢 `seq` / 游标）。
public struct InsightRunEvent: Decodable, Sendable, Equatable {
    public let schemaVersion: Int
    public let runId: String
    public let attempt: Int
    /// 单调序号（游标 `{run_id}:{attempt}:{seq}` 的第三段）。
    public let seq: Int
    /// `snapshot | status | content.delta | content.snapshot | done | error | ping`。
    public let type: String
    public let status: String?
    public let stage: String?
    public let progressPercent: Int?
    public let detail: String?
    // content.delta / content.snapshot
    public let slot: String?
    public let blockId: String?
    public let format: String?
    public let delta: String?
    public let content: String?
    public let contentSha256: String?
    public let checkpointSeq: Int?
    // snapshot / done
    public let outputs: [String: InsightRunOutput]?
    public let isTerminal: Bool?
    public let artifactId: String?
    public let title: String?
    // error
    public let error: InsightRunError?
    public let usage: InsightRunUsage?

    public var isTerminalEvent: Bool { InsightEventType.terminal.contains(type) }

    /// 本帧携带的正文（`content.delta` 取 `delta`，`content.snapshot` 取 `content`，
    /// 快照 / done 取 `outputs[slot]`）—— `nil` = 本帧不改正文。
    public func textContent(slot target: String = InsightRunDetail.defaultSlot) -> String? {
        switch type {
        case InsightEventType.contentDelta:
            return delta
        case InsightEventType.contentSnapshot:
            if let content, !content.isEmpty { return content }
            return outputs?[slot ?? target]?.content
        case InsightEventType.snapshot, InsightEventType.done:
            return outputs?[target]?.content
        default:
            return nil
        }
    }
}

/// `Last-Event-ID` 游标（后端 `cursor.py` 的 `{run_id}:{attempt}:{seq}`）。
///
/// 解析放在客户端不是为了「自己造游标」，而是为了：① 断言续传头写的是后端认的形状；
/// ② 在本地去重（同一 `(attempt, seq)` 只应用一次）。后端对非法游标返回 typed 400
/// `RESUME_CURSOR_INVALID`（真实响应见 `Fixtures/Insight/insight-run-stream-invalid-cursor.json`），
/// 所以客户端**只在确实解析出来之后**才发这个头。
public struct InsightEventCursor: Equatable, Sendable {
    public let runId: String
    public let attempt: Int
    public let sequence: Int

    public init(runId: String, attempt: Int, sequence: Int) {
        self.runId = runId
        self.attempt = attempt
        self.sequence = sequence
    }

    /// 从帧字段构造（`id:` 缺失时用 `run_id` / `attempt` / `seq` 拼，两者同源的规范就写在后端
    /// `cursor.event_id_of` 里）。
    public init(event: InsightRunEvent) {
        self.init(runId: event.runId, attempt: event.attempt, sequence: event.seq)
    }

    public var wireValue: String { "\(runId):\(attempt):\(sequence)" }

    /// 解析 `{run_id}:{attempt}:{seq}`；段数不对 / 数字不合法都返回 `nil`。
    public static func parse(_ raw: String) -> InsightEventCursor? {
        let parts = raw.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 3,
              let attempt = Int(parts[1]), attempt > 0,
              let sequence = Int(parts[2]), sequence > 0
        else { return nil }
        let runId = String(parts[0])
        guard !runId.isEmpty else { return nil }
        return InsightEventCursor(runId: runId, attempt: attempt, sequence: sequence)
    }

    /// 与另一个游标是否构成「严格更新」（`(attempt, seq)` 字典序 —— 后端 `_after_cursor` 同口径）。
    public func isStrictlyAfter(_ other: InsightEventCursor) -> Bool {
        (attempt, sequence) > (other.attempt, other.sequence)
    }
}

// MARK: - 维度面板（「AI 广告分析」）

/// 「AI 广告分析」的维度面板数据（Web `view-dialog.tsx` 从 `strategy_metadata` 里现取）。
///
/// 口径与 Web 逐字一致：`meta.evolution_metadata` 的四个键 →
/// `dimensions_analyzed`（L1）/ `cross_analyses_performed`（L2，字符串数组）/
/// `temporal_analyses_performed`（L3，字符串数组）/ `dimensions_skipped`（带 `reason`）。
public struct InsightDimensionCoverage: Sendable, Equatable {
    public struct Dimension: Sendable, Equatable, Identifiable {
        public let id: String
        public let name: String
        public let level: Int
        public let signalStrength: String?
        public let dependsOn: [String]

        public init(
            id: String,
            name: String,
            level: Int,
            signalStrength: String? = nil,
            dependsOn: [String] = []
        ) {
            self.id = id
            self.name = name
            self.level = level
            self.signalStrength = signalStrength
            self.dependsOn = dependsOn
        }
    }

    public struct Skipped: Sendable, Equatable, Identifiable {
        public let id: String
        public let name: String
        public let reason: String

        public init(id: String, name: String, reason: String) {
            self.id = id
            self.name = name
            self.reason = reason
        }
    }

    public let analyzed: [Dimension]
    public let cross: [Dimension]
    public let temporal: [Dimension]
    public let skipped: [Skipped]

    public init(
        analyzed: [Dimension] = [],
        cross: [Dimension] = [],
        temporal: [Dimension] = [],
        skipped: [Skipped] = []
    ) {
        self.analyzed = analyzed
        self.cross = cross
        self.temporal = temporal
        self.skipped = skipped
    }

    public var total: Int { analyzed.count + cross.count + temporal.count }

    public var isEmpty: Bool { total == 0 && skipped.isEmpty }

    /// 从 `strategy_metadata`（JSON 字符串）解析。
    ///
    /// 解析失败 / 没有 `evolution_metadata` / 四个键全空 → `nil`（面板整块不渲染，
    /// 与 Web `view-dialog.tsx` 的 `return null` 同义）。**不做**「解析失败给个空面板」——
    /// 空面板会被读成「这次分析零维度覆盖」，那是另一个意思。
    public static func parse(strategyMetadata: String?) -> InsightDimensionCoverage? {
        guard let raw = strategyMetadata?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty, let data = raw.data(using: .utf8)
        else { return nil }
        // 必须用与 `APIClient` 相同的 `snake_case` 策略：`strategy_metadata` 里的键名是
        // 后端原样写进去的 `evolution_metadata` / `dimensions_analyzed` / `content_sha256`，
        // 默认策略下这些键全部取不到 —— 面板会静默消失，而不是报错。
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        guard let root = try? decoder.decode(Metadata.self, from: data),
              let evolution = root.evolutionMetadata
        else { return nil }

        let analyzed = (evolution.dimensionsAnalyzed ?? []).map { entry in
            Dimension(
                id: entry.dimensionId ?? entry.name ?? "",
                name: entry.name ?? entry.dimensionId ?? "",
                level: entry.level ?? 1,
                signalStrength: entry.signalStrength,
                dependsOn: entry.dependsOn ?? []
            )
        }
        let cross = (evolution.crossAnalysesPerformed ?? []).map {
            Dimension(id: $0, name: $0, level: 2)
        }
        let temporal = (evolution.temporalAnalysesPerformed ?? []).map {
            Dimension(id: $0, name: $0, level: 3)
        }
        let skipped = (evolution.dimensionsSkipped ?? []).map { entry in
            Skipped(
                id: entry.dimensionId ?? entry.name ?? "",
                name: entry.name ?? entry.dimensionId ?? "",
                reason: entry.reason ?? ""
            )
        }

        let coverage = InsightDimensionCoverage(
            analyzed: analyzed,
            cross: cross,
            temporal: temporal,
            skipped: skipped
        )
        return coverage.isEmpty ? nil : coverage
    }

    private struct Metadata: Decodable {
        let evolutionMetadata: Evolution?

        struct Evolution: Decodable {
            let dimensionsAnalyzed: [AnalyzedDimension]?
            let crossAnalysesPerformed: [String]?
            let temporalAnalysesPerformed: [String]?
            let dimensionsSkipped: [SkippedDimension]?
        }

        struct AnalyzedDimension: Decodable {
            let dimensionId: String?
            let name: String?
            let level: Int?
            let signalStrength: String?
            let dependsOn: [String]?
        }

        struct SkippedDimension: Decodable {
            let dimensionId: String?
            let name: String?
            let reason: String?
        }
    }
}
