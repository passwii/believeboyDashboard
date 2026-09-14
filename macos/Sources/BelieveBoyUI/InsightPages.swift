import BelieveBoyKit
import SwiftUI

/// 「AI 智能 → AI 洞察」页（Web `/dashboard/ai/insights`）。
///
/// 4 条端点：列表 / 明细 / 旧链路流式 / 定时列表（只读）。
public struct AIInsightsView: View {
    public static let routeID = InsightCatalog.insightsRouteID

    private let model: AppModel
    private let navigation: NavigationStore

    public init(model: AppModel, navigation: NavigationStore) {
        self.model = model
        self.navigation = navigation
    }

    public var body: some View {
        InsightBrowseView(
            config: InsightBrowseView.Config(
                routeID: Self.routeID,
                title: "AI 洞察",
                symbol: "chart.line.uptrend.xyaxis",
                endpointNote: "4 个端点 · 旧洞察链路（整型 id）",
                showsTypeFilter: true,
                showsSchedules: true,
                showsDimensionPanel: false,
                showsRunObserver: false,
                emptyText: "暂无洞察记录（该筛选下后端返回 0 条）。生成洞察属写链路，桌面端本批不做 ——"
                    + "在 Web 端生成后这里会看到记录。"
            ),
            model: model,
            navigation: navigation,
            store: navigation.aiInsights
        )
    }
}

/// 「AI 智能 → AI 广告分析」页（Web `/dashboard/ai/ad-analysis`）。
///
/// 5 条端点消费点：历史列表（`/ai-insights?insight_type=ad_analysis`）/ 明细 /
/// 旧链路流式 / canonical run 快照 / canonical run 流式。
///
/// 「维度面板」口径照 Web `view-dialog.tsx`：从 `strategy_metadata.evolution_metadata`
/// 现取，四个键（analyzed / cross / temporal / skipped）逐字对应。
public struct AIAdAnalysisView: View {
    public static let routeID = InsightCatalog.adAnalysisRouteID

    private let model: AppModel
    private let navigation: NavigationStore

    public init(model: AppModel, navigation: NavigationStore) {
        self.model = model
        self.navigation = navigation
    }

    public var body: some View {
        InsightBrowseView(
            config: InsightBrowseView.Config(
                routeID: Self.routeID,
                title: "AI 广告分析",
                symbol: "chart.bar",
                endpointNote: "历史列表 + 明细 / 流式 + 维度面板 + canonical run 观察",
                // 类型固定 `ad_analysis`（Web `history-list.tsx` 写死），故不再给类型筛选。
                showsTypeFilter: false,
                showsSchedules: false,
                showsDimensionPanel: true,
                showsRunObserver: true,
                emptyText: "暂无广告分析报告（`insight_type=ad_analysis` 下后端返回 0 条）。"
                    + "启动分析属写链路，桌面端本批不做。"
            ),
            model: model,
            navigation: navigation,
            store: navigation.adAnalysisInsights,
            runStore: navigation.adAnalysisRun
        )
    }
}

/// 「AI 智能 → AI 库存健康」页（Web `/dashboard/ai/inventory-health`）。
///
/// **只有 canonical 侧**：库存健康没有旧洞察链路（Web `inventory-health/page.tsx` 的注释
/// 原话：「canonical 侧暂无 list 端点」），因此本页不做列表，只做
/// `GET /insight/runs/{run_id}` + `/{run_id}/stream` 的观察，口径用库存域文案表
/// （`InsightPanelMapping.inventoryRunLabels`，逐条对齐 `inventory-insight.ts`）。
public struct AIInventoryHealthView: View {
    public static let routeID = InsightCatalog.inventoryHealthRouteID

    private let model: AppModel
    private let navigation: NavigationStore

    public init(model: AppModel, navigation: NavigationStore) {
        self.model = model
        self.navigation = navigation
    }

    private var store: CanonicalRunStore { navigation.inventoryRun }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 14) {
                    NoticeRow(
                        kind: .warning,
                        message: "库存健康**没有旧洞察链路**：canonical 侧也没有 run 列表端点，"
                            + "而启动分析（`POST /insight/inventory-health/runs`）属写链路。"
                            + "因此本页只做「按 run id 观察明细 + 流式」—— 这是本页可达的那两条端点。"
                    )
                    InsightRunObserverSection(
                        store: store,
                        model: model,
                        navigation: navigation
                    )
                   scopeNotes
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(minWidth: 560, minHeight: 420)
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "shippingbox")
                .font(.title3)
                .foregroundStyle(.secondary)
            Text("AI 库存健康")
                .font(.title2.weight(.semibold))
            Text("只读")
                .font(.caption.weight(.medium))
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(.quaternary, in: Capsule())
            Spacer()
            Text("2 个端点 · canonical run（UUID + 游标）")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 20)
        .padding(.top, 16)
        .padding(.bottom, 10)
    }

    /// 库存scopeNotes（对齐 `inventory-insight.ts` 的两个常量与「单日快照」语义）。
    private var scopeNotes: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("库存口径").font(.caption.weight(.semibold))
            Text("• 单日快照：run 的 slots 里是 `report_date`（可缺省 = 按最新库存快照分析），"
                + "不是广告那种日期区间。")
            Text("• 输出槽固定 `main`（`roles.py` 的 `inventory_health.v1` output_slot）。")
            Text("• 进度数值 `progress_percent` 直通展示；终态后不再显示进度（对齐 "
                + "`toInventoryPanelState` 的 `progress: null`）。")
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 8))
    }
}
