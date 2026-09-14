import Foundation

/// 三页共用的面板口径：把「run 事实」翻译成面板要显示的「状态 / 文案 / 进度 / 是否在流」。
///
/// 从 Web 逐字搬的是三张表（`ad-insight.ts` / `inventory-insight.ts` 的
/// `*_RUN_LABELS` / `*_TRANSPORT_LABELS` / `*_ACTIVE_RUN`）与它们的两条判据：
///
/// 1. **run 状态（后端权威）优先于传输层状态**：断流重连期间 run 可能已经完成，
///    此时以 `runStatus` 为准；只有拿不到 run 状态时才退到传输层文案。
/// 2. **只有真的在推增量时才有光标**（`isStreaming`）：`connecting` / `reconnecting`
///    期间没有内容在动 —— 照抄 Web，不用别的判据。
///
/// 放在 Kit（纯逻辑、不 import SwiftUI）而不是视图里：这两条判据正是「面板显示错动作」
/// 的来源（对已断的流显示「取消」却不给「重试」），必须能离线逐条钉住。
public enum InsightPanelDomain: Sendable, Equatable {
    /// 「AI 广告分析」（`ad_analysis.v1`，输出槽 `main`）。
    case adAnalysis
    /// 「AI 库存健康」（`inventory_health.v1`，输出槽 `main`）。
    case inventoryHealth
    /// 「AI 洞察」旧链路（状态词表是 `pending | generating | completed | failed`）。
    case legacyInsight
}

/// 面板状态（视图直接读它判色 / 判文案 / 判动作）。
public struct InsightPanelState: Equatable, Sendable {
    /// 喂状态色板的 canonical 状态字符串（旧链路已归一成 7 态词表）。
    public let status: String
    public let label: String
    public let progress: Int?
    public let isStreaming: Bool
    /// 仍在推进：决定显示「取消」还是「重试」（本批只读，不做动作，但仍要判对，
    /// 否则「已完成」的 run 会被标成还在跑）。
    public let busy: Bool

    public init(status: String, label: String, progress: Int?, isStreaming: Bool, busy: Bool) {
        self.status = status
        self.label = label
        self.progress = progress
        self.isStreaming = isStreaming
        self.busy = busy
    }
}

/// 传输层状态（≥ run 状态词表 + 三个传输专有态）。
public enum InsightTransportState: String, Sendable, Equatable, CaseIterable {
    case queued
    case aggregating
    case generating
    case finalizing
    case completed
    case failed
    case cancelled
    case connecting
    case live
    case reconnecting
}

/// 面板映射的纯函数集合（一域一表，对齐 Web 的两份 `*-insight.ts`）。
public enum InsightPanelMapping {
    // MARK: - 文案表

    /// 广告域 run 状态文案。
    public static let adRunLabels: [String: String] = [
        "queued": "排队中",
        "aggregating": "正在聚合广告数据",
        "generating": "正在生成广告分析",
        "finalizing": "正在收尾",
        "completed": "广告分析已完成",
        "failed": "广告分析生成失败",
        "cancelled": "已取消",
    ]

    /// 广告域传输层文案。
    public static let adTransportLabels: [String: String] = [
        "queued": "准备提交分析任务",
        "connecting": "正在连接生成流",
        "live": "正在生成广告分析",
        "reconnecting": "连接中断，正在重连",
        "aggregating": "正在聚合广告数据",
        "generating": "正在生成广告分析",
        "finalizing": "正在收尾",
        "completed": "广告分析已完成",
        "failed": "广告分析生成失败",
        "cancelled": "已取消",
    ]

    /// 库存域 run 状态文案。
    public static let inventoryRunLabels: [String: String] = [
        "queued": "排队中",
        "aggregating": "正在聚合库存与补货数据",
        "generating": "正在生成库存健康分析",
        "finalizing": "正在收尾",
        "completed": "库存健康分析已完成",
        "failed": "库存健康分析生成失败",
        "cancelled": "已取消",
    ]

    /// 库存域传输层文案。
    public static let inventoryTransportLabels: [String: String] = [
        "queued": "准备提交分析任务",
        "connecting": "正在连接生成流",
        "live": "正在生成库存健康分析",
        "reconnecting": "连接中断，正在重连",
        "aggregating": "正在聚合库存与补货数据",
        "generating": "正在生成库存健康分析",
        "finalizing": "正在收尾",
        "completed": "库存健康分析已完成",
        "failed": "库存健康分析生成失败",
        "cancelled": "已取消",
    ]

    /// 旧链路文案（Web `legacy-insight-compat.ts` 的 `toLegacyPanelState`）。
    public static let legacyAggregatingFallback = "正在聚合数据..."
    public static let legacyGenerating = "正在生成洞察..."

    /// 传输层文案（域属）。
    public static func transportLabel(_ transport: InsightTransportState, domain: InsightPanelDomain)
        -> String
    {
        switch domain {
        case .adAnalysis:
            return adTransportLabels[transport.rawValue] ?? transport.rawValue
        case .inventoryHealth:
            return inventoryTransportLabels[transport.rawValue] ?? transport.rawValue
        case .legacyInsight:
            return legacyTransportLabels[transport] ?? transport.rawValue
        }
    }

    private static let legacyTransportLabels: [InsightTransportState: String] = [
        .queued: "等待开始",
        .connecting: "连接生成流",
        .live: "正在生成洞察...",
        .reconnecting: "连接中断，正在重连",
        .aggregating: legacyAggregatingFallback,
        .generating: legacyGenerating,
        .finalizing: "正在生成标题...",
        .completed: "生成完成",
        .failed: "生成失败",
        .cancelled: "已取消",
    ]

    // MARK: - canonical run 面板

    /// canonical run 事实 → 面板状态。
    ///
    /// - Parameters:
    ///   - runStatus: 后端权威状态；`nil` = 还没拿到 detail。
    ///   - transport: 传输层状态。
    ///   - progress: `progress_percent`（0…100）。
    public static func canonical(
        runStatus: String?,
        transport: InsightTransportState,
        progress: Int?,
        domain: InsightPanelDomain
    ) -> InsightPanelState {
        guard let runStatus else {
            return InsightPanelState(
                status: transport.rawValue,
                label: transportLabel(transport, domain: domain),
                progress: nil,
                // 只有真的在推增量时才有光标；connecting / reconnecting 期间没有内容在动。
                isStreaming: transport == .live,
                busy: true
            )
        }

        let active = InsightRunStatusMachine.isActive(runStatus)
        let runLabels = domain == .inventoryHealth ? inventoryRunLabels : adRunLabels
        let reconnecting = active && transport == .reconnecting
        let label = reconnecting
            ? transportLabel(.reconnecting, domain: domain)
            : (runLabels[runStatus] ?? runStatus)
        return InsightPanelState(
            status: runStatus,
            label: label,
            progress: active ? progress : nil,
            isStreaming: active && transport == .live,
            busy: active
        )
    }

    // MARK: - 旧链路面板

    /// 旧链路的 `sub_status` → canonical 状态（Web `legacySubStatusToCanonical`）。
    public static func legacyCanonicalStatus(subStatus: String?) -> String {
        guard let subStatus else { return "generating" }
        if subStatus == "queued" { return "queued" }
        if subStatus == "ai_generating" { return "generating" }
        if subStatus == "title_generating" { return "finalizing" }
        if subStatus.hasPrefix("data_aggregating") { return "aggregating" }
        return "generating"
    }

    /// 旧链路面板状态（Web `toLegacyPanelState`）。
    ///
    /// - Parameters:
    ///   - status: `idle`（没有在跑的 run）/ `running` / `completed` / `failed`。
    ///   - subStatus: 细阶段。
    ///   - transport: 传输层状态。
    public static func legacy(
        status: String,
        subStatus: String?,
        transport: InsightTransportState
    ) -> InsightPanelState {
        switch status {
        case "completed":
            return InsightPanelState(
                status: "completed",
                label: "生成完成",
                progress: nil,
                isStreaming: false,
                busy: false
            )
        case "failed":
            return InsightPanelState(
                status: "failed",
                label: "生成失败",
                progress: nil,
                isStreaming: false,
                busy: false
            )
        case "idle":
            return InsightPanelState(
                status: "queued",
                label: "等待开始",
                progress: nil,
                isStreaming: false,
                busy: false
            )
        default:
            break
        }

        if transport == .reconnecting {
            return InsightPanelState(
                status: "reconnecting",
                label: "连接中断，正在重连",
                progress: nil,
                isStreaming: false,
                busy: true
            )
        }

        let label = InsightLegacySubStatus.label(subStatus)
            ?? subStatus.map { _ in legacyAggregatingFallback }
            ?? legacyGenerating
        return InsightPanelState(
            status: legacyCanonicalStatus(subStatus: subStatus),
            label: label,
            progress: nil,
            isStreaming: true,
            busy: true
        )
    }

    // MARK: - 旧状态机 → canonical 词表（喂状态色板）

    /// 旧列表状态（`pending | generating | completed | failed`）→ 面板色板用的状态串。
    public static func legacyListStatus(_ status: String, subStatus: String?) -> String {
        if status == "completed" || status == "failed" { return status }
        if status == "pending" { return "queued" }
        return legacyCanonicalStatus(subStatus: subStatus)
    }
}
