import Foundation

/// 「AI 智能」组三页（AI 洞察 / AI 广告分析 / AI 库存健康）的端点目录与口径常量。
///
/// 三页共用一份底座（BLF-1062 §口径 4 的原话：「三页共用同一份 run/流式底座」），
/// 差异只在「看哪条链路」：
///
/// | 页 | 历史列表 | 明细 | 流式 | 备注 |
/// | --- | --- | --- | --- | --- |
/// | AI 洞察 | `GET /ai-insights` | `GET /ai-insights/{id}` | `GET /ai-insights/{id}/stream` | 旧链路（整型 id） |
/// | AI 广告分析 | `GET /ai-insights?insight_type=ad_analysis` | 同上 | 同上 | 旧链路 + 维度面板 |
/// | AI 库存健康 | （canonical 侧无 list 端点） | `GET /insight/runs/{run_id}` | `GET /insight/runs/{run_id}/stream` | canonical（UUID + 游标） |
///
/// **两条流式的传输语义不同，不能共用一套消费代码就以为等价**：
///
/// - 旧链路（`ai_insight.py::stream_insight`）：2s 轮询 DB，只在状态变化时发 `status`，
///   其余发 `ping`，终态发一次 `done` / `error`；帧里**没有 `id:`**，后端**不认**
///   `Last-Event-ID`（只有 `insight_runs.py` 与 `ai_chat_v2.py` 读这个头）。正文只在
///   终态帧里回来。
/// - canonical（`insight_runs.py::stream_insight_run`）：每帧带 `id: {run_id}:{attempt}:{seq}`
///   游标，后端按 `Last-Event-ID` 续传，终态是 `done` / `error`。
///
/// 于是「续传」这件事在旧链路上只能落成「重连后重新拉一次 detail（权威快照）」，在
/// canonical 上才是真游标续传（BLF-1062 §口径 2）。本目录把这条差异写成两个显式的
/// 布尔量，而不是让调用方去猜。
public enum InsightCatalog {
    // MARK: - Web 路由（同时是 `NavigationItem.id` 与模块任务作用域的 key）

    public static let insightsRouteID = "/dashboard/ai/insights"
    public static let adAnalysisRouteID = "/dashboard/ai/ad-analysis"
    public static let inventoryHealthRouteID = "/dashboard/ai/inventory-health"

    // MARK: - 端点（6 条，全部 `protected`，账号 `blf_` key + `X-Operator` 直连）

    /// `GET /ai-insights`（洞察列表，分页 + 筛选）。
    public static let insightsEndpoint = "/ai-insights"

    /// `GET /ai-insights/{insight_id}`（洞察明细）。
    public static func insightDetailEndpoint(id: Int) -> String { "/ai-insights/\(id)" }

    /// `GET /ai-insights/{insight_id}/stream`（旧链路 SSE）。
    public static func insightStreamEndpoint(id: Int) -> String { "/ai-insights/\(id)/stream" }

    /// `GET /ai-insights/schedules`（定时列表，**只读**部分；CRUD 属 S6 写链路）。
    public static let schedulesEndpoint = "/ai-insights/schedules"

    /// `GET /insight/runs/{run_id}`（canonical run 快照）。
    public static func runDetailEndpoint(runID: String) -> String {
        "/insight/runs/\(runID)"
    }

    /// `GET /insight/runs/{run_id}/stream`（canonical SSE，带 `id:` 游标）。
    public static func runStreamEndpoint(runID: String) -> String {
        "/insight/runs/\(runID)/stream"
    }

    // MARK: - 分页口径

    /// 列表每页条数（对齐 Web `HistoryList` 与 `/dashboard/ai/insights` 的 `limit: 20`）。
    public static let pageSize = 20

    /// 「AI 广告分析」页历史列表固定带的 `insight_type`（Web `history-list.tsx` 同值）。
    public static let adAnalysisInsightType = "ad_analysis"

    // MARK: - 传输语义

    /// 旧链路流是否发 `id:` 游标（`ai_insight.py` 不发 → 无法按游标续传）。
    public static let legacyStreamCarriesCursor = false

    /// canonical 流是否认 `Last-Event-ID`（`insight_runs.py:159` 认）。
    public static let canonicalStreamCarriesCursor = true

    // MARK: - 超时分层

    /// 列表 / 明细 / 定时列表：**明细与列表档 5s**（BLF-1062 §口径 6，对齐
    /// `backend-proxy-timeout-policy.ts` 的 `detail` / `list` 两档都是 5s）。
    public static let readTier: RequestTier = .list

    /// 流式：走 `.stream` 档（无超时，用既有的极大有限值）。
    public static let streamTier: RequestTier = .stream
}

/// 旧洞察的类型词表（Web `INSIGHT_TYPE_OPTIONS`，四选一 + 广告专项）。
public struct InsightTypeOption: Sendable, Hashable, Identifiable {
    public let value: String
    public let label: String

    public var id: String { value }

    public init(value: String, label: String) {
        self.value = value
        self.label = label
    }
}

/// 洞察类型选项。
///
/// Web `/dashboard/ai/insights` 的生成表单只有四选一（`INSIGHT_TYPE_OPTIONS`），
/// 而**列表筛选**还多一个 `ad_analysis`（「AI 广告分析」页用它筛历史）。两处并在一张表里，
/// 「全部」由 `nil` 表示（不传 `insight_type` 参数 = 不过滤）。
public enum InsightTypes {
    public static let all: [InsightTypeOption] = [
        InsightTypeOption(value: "daily", label: "日报"),
        InsightTypeOption(value: "weekly", label: "周报"),
        InsightTypeOption(value: "monthly", label: "月报"),
        InsightTypeOption(value: "custom", label: "自定义"),
        InsightTypeOption(value: "ad_analysis", label: "广告分析"),
    ]

    public static func label(value: String) -> String {
        all.first { $0.value == value }?.label ?? value
    }
}

/// 旧洞察状态机（后端 `InsightStatus`：`pending | generating | completed | failed`
/// 加上细粒度 `sub_status`）。
public enum InsightStatusMachine {
    /// 旧状态里「仍在推进」的两个（`sub_status` 才是细阶段）。
    public static let active: Set<String> = ["pending", "generating"]

    public static func isTerminal(_ status: String) -> Bool {
        status == "completed" || status == "failed"
    }

    public static func isActive(_ status: String) -> Bool { active.contains(status) }
}

/// canonical run 状态机（后端 `InsightStatus`：7 态，权威）。
public enum InsightRunStatusMachine {
    /// 仍在推进的四态。
    public static let active: Set<String> = ["queued", "aggregating", "generating", "finalizing"]

    public static let terminal: Set<String> = ["completed", "failed", "cancelled"]

    public static func isActive(_ status: String) -> Bool { active.contains(status) }

    public static func isTerminal(_ status: String) -> Bool { terminal.contains(status) }

    /// 阶段（`InsightStage`）是状态（`InsightStatus`）的子集。
    public static let stages: Set<String> = ["queued", "aggregating", "generating", "finalizing"]
}

/// canonical 流的事件类型（后端 `events.py` 的 `InsightEvent` 家族）。
public enum InsightEventType {
    public static let snapshot = "snapshot"
    public static let status = "status"
    public static let contentDelta = "content.delta"
    public static let contentSnapshot = "content.snapshot"
    public static let done = "done"
    public static let error = "error"
    public static let ping = "ping"

    /// 终态帧（`insight_runs.py` 的 `TERMINAL_EVENT_TYPES`）。
    public static let terminal: Set<String> = [done, error]
}

/// 旧链路的 `sub_status` → 人话标签（Web `LEGACY_SUB_STATUS_LABELS`，逐条照抄）。
public enum InsightLegacySubStatus {
    public static let labels: [String: String] = [
        "queued": "排队中...",
        "data_aggregating": "正在聚合数据...",
        "data_aggregating_sales": "抓取销售数据...",
        "data_aggregating_ad": "抓取广告数据...",
        "data_aggregating_inventory": "抓取库存数据...",
        "data_aggregating_comparison_sales": "抓取对比期销售...",
        "data_aggregating_comparison_ad": "抓取对比期广告...",
        "data_aggregating_top_skus": "抓取 Top SKU...",
        "data_aggregating_ad_campaigns": "抓取广告活动...",
        "ai_generating": "正在生成洞察...",
        "title_generating": "正在生成标题...",
    ]

    public static func label(_ subStatus: String?) -> String? {
        guard let subStatus else { return nil }
        return labels[subStatus]
    }
}
