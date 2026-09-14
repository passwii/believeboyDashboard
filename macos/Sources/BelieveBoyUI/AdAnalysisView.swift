import BelieveBoyKit
import SwiftUI

/// 正文（`tabContent`）的渲染分支 —— 纯数据，判定收在 `resolve`。
///
/// 为什么把这一支挑出视图：验收标准 3 的「空态必须显示『无数据』」只在
/// `projectGate == .ready` **且** `contentState == .empty` 这一支上成立，而这一支最容易被
/// 外层提前吃掉 —— S5.1 首版把 `emptyNotice` 写在 `readyContent` 里，`.empty` 却是先命中
/// 外层 `EmptyView()`，于是「项目存在但报表为空」时页面一片空白，提示永远画不出来（离屏
/// 像素非零的断言照样通过）。判定挑出来之后，单测可以直接钉住「空态 → notice」。
enum AdAnalysisTabContent: Equatable {
    /// 正文位置放一行加载提示（项目列表 / 当前 Tab）。
    case loading(String)
    /// 正文位置放提示条 —— 当前是「无数据」空态，**不能渲染成空白**。
    case notice(String)
    /// 正文留空：项目列表或当前 Tab 加载失败，提示与重试在 `stateBanners`。
    case blocked
    /// 有数据，走 `readyContent`。
    case ready

    /// 正文分支口径（视图只负责把它画出来）。
    static func resolve(
        gate: AdAnalysisStore.ProjectGate,
        content: AdAnalysisStore.ContentState,
        tabLabel: String
    ) -> AdAnalysisTabContent {
        switch gate {
        case .pending:
            return .loading("正在加载项目列表…")
        case .failed, .noProjects:
            // 项目列表本身不可用：整页提示在 `stateBanners`，正文没有可加载的 Tab。
            return .blocked
        case .ready:
            switch content {
            case .loading:
                return .loading("正在加载「\(tabLabel)」…")
            case .empty:
                // 空态 = 报表里没有落在这组筛选里的记录，**不是** 0、也**不是**报错。
                return .notice(emptyNoticeMessage(tabLabel: tabLabel))
            case .failed:
                return .blocked
            case .ready:
                return .ready
            }
        }
    }

    /// 空态文案（验收标准 3 的「无数据」提示原文）。
    static func emptyNoticeMessage(tabLabel: String) -> String {
        "当前筛选条件下「\(tabLabel)」没有数据 ——"
            + "不是加载失败：该项目的报表里没有落在这个项目 / 站点 / 日期区间内的记录。"
    }
}

/// 「广告 → 广告分析」只读页（Web `/dashboard/advertising/ad-analysis`，默认落地 `overview`）。
///
/// 一个 Tab 一个端点（10 个 GET，见 `AdAnalysisCatalog.tabs`），全部共用顶部的项目 /
/// 站点 / 日期筛选条；切 Tab 不重置筛选（状态住在 `NavigationStore.adAnalysis`）。
///
/// 视图不使用属性包装器宏（工具链约束，见 `Package.swift` 顶部）：需要双向绑定的地方
/// 走显式 `Binding`（见 `AdAnalysisComponents` 里的 Picker / Toggle）。
///
/// 正文分支口径在 `AdAnalysisTabContent.resolve`（含「空态必须画出提示」那条）。
public struct AdAnalysisView: View {
    /// Web 路由 —— 模块路由表的命中键，也是模块任务作用域的 key。
    public static let routeID = AdAnalysisCatalog.routeID

    private let model: AppModel
    private let navigation: NavigationStore

    public init(model: AppModel, navigation: NavigationStore) {
        self.model = model
        self.navigation = navigation
    }

    private var store: AdAnalysisStore { navigation.adAnalysis }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            scrollableBody
        }
        .frame(minWidth: 520, minHeight: 420)
        // Tab / 筛选 / 刷新票号任一变化 → 重新加载当前 Tab。请求登记在
        // `navigation.selectionTaskKey`（= 当前 route id）下：同 key 的新请求会先取消
        // 上一个（切 Tab、改筛选），切模块时由外壳按 route id 整体取消。
        .task(id: store.loadKey) { await reload() }
    }

    private var scrollableBody: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 14) {
                stateBanners
                tabContent
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: - 页头

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Image(systemName: "chart.bar")
                    .font(.title3)
                    .foregroundStyle(.secondary)
                Text("广告分析")
                    .font(.title2.weight(.semibold))
                Text("只读")
                    .font(.caption.weight(.medium))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(.quaternary, in: Capsule())
                Spacer()
                Text("10 个端点 · 一个 Tab 一个")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            AdFilterBar(
                store: store,
                isRefreshing: store.isRefreshing,
                onRefresh: { store.requestRefresh() }
            )
            AdAnalysisTabStrip(store: store)
        }
        .padding(.horizontal, 20)
        .padding(.top, 16)
        .padding(.bottom, 10)
    }

    // MARK: - 状态提示（项目失败 / 无项目 / 内容失败 / 刷新失败）

    @ViewBuilder
    private var stateBanners: some View {
        switch store.projectGate {
        case .failed(let message):
            VStack(alignment: .leading, spacing: 8) {
                NoticeRow(kind: .failure, message: "项目列表加载失败：\(message)")
                Button {
                    store.requestRefresh()
                } label: {
                    Label("重试", systemImage: "arrow.clockwise")
                }
            }
        case .noProjects:
            NoticeRow(
                kind: .warning,
                message: "当前账号在这个后端上没有可见项目（`/projects/manage` 返回空列表）——"
                    + "广告分析的所有端点都要求 `project_id`，没有项目就没有可分析的数据。"
            )
        case .pending, .ready:
            if let failure = store.failureMessage {
                VStack(alignment: .leading, spacing: 8) {
                    NoticeRow(kind: .failure, message: failure)
                    Button {
                        store.requestRefresh()
                    } label: {
                        Label("重试", systemImage: "arrow.clockwise")
                    }
                }
            }
            if let refreshFailure = store.refreshFailure {
                NoticeRow(
                    kind: .warning,
                    message: "本次刷新失败，下表仍是上一次的数据：\(refreshFailure)"
                )
            }
        }
    }

    // MARK: - Tab 内容

    @ViewBuilder
    private var tabContent: some View {
        switch AdAnalysisTabContent.resolve(
            gate: store.projectGate,
            content: store.contentState,
            tabLabel: store.selectedTab.label
        ) {
        case .loading(let text):
            loadingRow(text)
        case .notice(let message):
            // 空态提示走同一个 `NoticeRow`，与错误 / 刷新失败提示同构。
            NoticeRow(kind: .warning, message: message)
        case .blocked:
            EmptyView()
        case .ready:
            readyContent
        }
    }

    private func loadingRow(_ text: String) -> some View {
        HStack(spacing: 10) {
            ProgressView().controlSize(.small)
            Text(text)
                .font(.callout)
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(.vertical, 30)
    }

    /// 有数据时的正文（只由 `AdAnalysisTabContent.ready` 进入；空态在 `tabContent` 里
    /// 就已经走掉 `notice` 那一支，不会到这里）。
    @ViewBuilder
    private var readyContent: some View {
        let payload = store.selectedTabState.payload
        let tabKey = store.selectedTabKey

        if let payload {
            if !payload.metrics.isEmpty {
                AdMetricTiles(metrics: payload.metrics, comparison: payload.comparison)
            }
            if !payload.summaryCards.isEmpty {
                AdSummaryCardTiles(cards: payload.summaryCards)
            }
            if tabKey == "time-trend" {
                timeTrendExtra(payload)
            }
            if tabKey == "overview" {
                overviewCharts(payload)
            }
            if !payload.narrativeSections.isEmpty {
                AdNarrativeSectionList(sections: payload.narrativeSections)
            }
            if !payload.issueCards.isEmpty {
                AdIssueCardList(cards: payload.issueCards)
            }
            if !store.detailRows.isEmpty {
                dataGrid(rows: store.detailRows)
            }
        }
    }

    /// 「趋势」页的 KPI（Web 取**最后一天**的三个数：累计花费 / 点击 / CPC）。
    @ViewBuilder
    private func timeTrendExtra(_ payload: AdAnalysisPayload) -> some View {
        if let latest = payload.summary.last {
            HStack(spacing: 8) {
                AdMetricTile(
                    label: "累计花费",
                    value: AdAnalysisFormatting.money(latest.number("running_spend") ?? 0),
                    changeRatio: nil,
                    helper: "最后一天（\(latest.string("report_date") ?? "—")）的累计花费"
                )
                AdMetricTile(
                    label: "最新单日点击",
                    value: AdAnalysisFormatting.integer(latest.number("clicks") ?? 0),
                    changeRatio: nil,
                    helper: "最后一天的点击量"
                )
                AdMetricTile(
                    label: "最新单日 CPC",
                    value: AdAnalysisFormatting.money(latest.number("cpc") ?? 0),
                    changeRatio: nil,
                    helper: "最后一天的 CPC"
                )
            }
        }
        if let comparison = payload.comparison {
            AdComparisonPanel(comparison: comparison)
        }
    }

    /// 「总览」的两张图（趋势折线 + 高消耗活动柱状），与 Web 的同源字段。
    @ViewBuilder
    private func overviewCharts(_ payload: AdAnalysisPayload) -> some View {
        HStack(alignment: .top, spacing: 12) {
            GroupBox {
                AdTrendChart(
                    points: payload.trendSummary.enumerated().map { index, row in
                        AdTrendChart.Point(
                            id: index,
                            day: row.string("report_date") ?? "—",
                            spend: row.number("spend") ?? 0,
                            sales: row.number("sales_7d") ?? 0
                        )
                    }
                )
            } label: {
                Text("趋势（花费 / 销售额 7d）")
            }
            GroupBox {
                AdCampaignBarChart(
                    points: payload.topCampaigns.prefix(8).enumerated().map { index, row in
                        AdCampaignBarChart.Point(
                            id: index,
                            name: String((row.string("campaign_name") ?? "-").prefix(14)),
                            spend: row.number("spend") ?? 0
                        )
                    }
                )
            } label: {
                Text("高消耗活动 Top 8")
            }
        }
    }

    /// 明细网格：小表全展示、大表限高独立滚动。
    private func dataGrid(rows: [AdAnalysisRow]) -> some View {
        let height = min(460, 34 + Double(rows.count) * 30)
        return GroupBox {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text("\(rows.count) 行")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text("· 悬停任意一行可看到该行全部字段")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                    Spacer()
                }
                AdDataGrid(columns: AdAnalysisColumns.columns(forTabKey: store.selectedTabKey), rows: rows)
            }
            .padding(4)
        } label: {
            Text("\(store.selectedTab.label)明细")
        }
        .frame(height: height)
    }

    // MARK: - 加载

    private func reload() async {
        guard let provider = model.adAnalysisProvider() else {
            store.failWithoutCredential()
            return
        }
        await store.load(
            using: provider,
            scope: navigation.tasks,
            key: navigation.selectionTaskKey
        )
    }
}

extension AppModel {
    /// 广告分析数据源：用当前会话（key + 账号上下文）构造；未登录返回 nil。
    ///
    /// 与 S4 的 `agentOpsProvider()` 同样复用 `AppModel` 的 `URLSession` ——
    /// 单测用打桩 session 跑通链路时，模块请求必须走同一个 session。
    func adAnalysisProvider() -> AdAnalysisClient? {
        guard let client = makeAPIClient() else { return nil }
        return AdAnalysisClient(client: client)
    }
}
