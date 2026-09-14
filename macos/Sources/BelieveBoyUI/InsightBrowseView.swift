import BelieveBoyKit
import SwiftUI

/// 「AI 智能」组三页共用的浏览页（洞察列表 + 明细 + 旧链路流式 + 定时只读 + canonical run 观察）。
///
/// 三页的**差异全部收进 `InsightBrowseConfig`**（标题 / 是否显示类型筛选 / 是否显示定时 /
/// 是否显示维度面板 / 是否带 canonical run 观察 / 空态文案），共用的部分（三态、分页、
/// 刷新失败保留旧表、取消不落错误态、Markdown + 图表降级、流式草稿切分）只写一遍。
/// 这是 BLF-1062 §口径 4 的原话落点：「三页共用同一份 run/流式底座，一批做完比拆三轮
/// 少写两遍底座」。
///
/// 视图不使用属性包装器宏（工具链约束，见 `Package.swift` 顶部）：双向绑定走显式
/// `Binding`，所有展示态（选中洞察、run id 输入、定时区块）都住在 store 里。
public struct InsightBrowseView: View {
    /// 一页的差异配置。
    public struct Config: Sendable {
        public let routeID: String
        public let title: String
        public let symbol: String
        /// 页头右侧的端点清单说明。
        public let endpointNote: String
        /// 是否显示「洞察类型」筛选（AI 洞察页有；广告分析页的类型是固定 `ad_analysis`）。
        public let showsTypeFilter: Bool
        /// 是否显示定时任务区块（只读）。
        public let showsSchedules: Bool
        /// 是否显示维度面板（`strategy_metadata.evolution_metadata`，广告分析页专用）。
        public let showsDimensionPanel: Bool
        /// 是否显示 canonical run 观察入口。
        public let showsRunObserver: Bool
        /// 列表空态文案。
        public let emptyText: String

        public init(
            routeID: String,
            title: String,
            symbol: String,
            endpointNote: String,
            showsTypeFilter: Bool,
            showsSchedules: Bool,
            showsDimensionPanel: Bool,
            showsRunObserver: Bool,
            emptyText: String
        ) {
            self.routeID = routeID
            self.title = title
            self.symbol = symbol
            self.endpointNote = endpointNote
            self.showsTypeFilter = showsTypeFilter
            self.showsSchedules = showsSchedules
            self.showsDimensionPanel = showsDimensionPanel
            self.showsRunObserver = showsRunObserver
            self.emptyText = emptyText
        }
    }

    private let config: Config
    private let model: AppModel
    private let navigation: NavigationStore
    private let store: AIInsightsStore
    private let runStore: CanonicalRunStore?

    public init(
        config: Config,
        model: AppModel,
        navigation: NavigationStore,
        store: AIInsightsStore,
        runStore: CanonicalRunStore? = nil
    ) {
        self.config = config
        self.model = model
        self.navigation = navigation
        self.store = store
        self.runStore = runStore
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 14) {
                    stateBanners
                    detailSection
                    content
                    if config.showsSchedules { schedulesSection }
                    if let runStore { InsightRunObserverSection(store: runStore, model: model, navigation: navigation) }
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(minWidth: 560, minHeight: 440)
        // 筛选 / 翻页 / 刷新票号任一变化 → 重新加载（登记在 route id 下：同 key 的新请求
        // 会先取消上一个，切模块时由外壳整体取消）。
        .task(id: store.loadKey) { await reload() }
        // 明细：打开哪条就取哪条的权威 detail；仍在生成时顺带订阅旧链路流。
        .task(id: store.detailKey) { await reloadDetail() }
    }

    // MARK: - 页头

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Image(systemName: config.symbol)
                    .font(.title3)
                    .foregroundStyle(.secondary)
                Text(config.title)
                    .font(.title2.weight(.semibold))
                Text("只读")
                    .font(.caption.weight(.medium))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(.quaternary, in: Capsule())
                Spacer()
                Text(config.endpointNote)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            AdFilterBar(
                store: store,
                isRefreshing: store.isRefreshing,
                onRefresh: { store.requestRefresh() }
            )
            if config.showsTypeFilter {
                HStack(spacing: 10) {
                    Picker("类型", selection: insightTypeSelection) {
                        Text("全部类型").tag(String?.none)
                        ForEach(InsightTypes.all) { option in
                            Text(option.label).tag(String?.some(option.value))
                        }
                    }
                    .labelsHidden()
                    .frame(minWidth: 140, maxWidth: 180)
                    Spacer(minLength: 0)
                }
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 16)
        .padding(.bottom, 10)
    }

    private var insightTypeSelection: Binding<String?> {
        Binding(
            get: { store.insightTypeFilter },
            set: { store.setInsightTypeFilter($0) }
        )
    }

    // MARK: - 状态提示

    @ViewBuilder
    private var stateBanners: some View {
        switch store.projectGate {
        case .failed(let message):
            VStack(alignment: .leading, spacing: 8) {
                NoticeRow(kind: .failure, message: "项目列表加载失败：\(message)")
                Button { store.requestRefresh() } label: {
                    Label("重试", systemImage: "arrow.clockwise")
                }
            }
        case .noProjects:
            NoticeRow(
                kind: .warning,
                message: "当前账号在这个后端上没有可见项目（`/projects/manage` 返回空列表）——"
                    + "洞察列表按项目可见性过滤，没有可见项目就看不到任何洞察。"
            )
        case .pending, .ready:
            if let failure = store.failureMessage {
                VStack(alignment: .leading, spacing: 8) {
                    NoticeRow(kind: .failure, message: failure)
                    Button { store.requestRefresh() } label: {
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

    // MARK: - 列表

    @ViewBuilder
    private var content: some View {
        switch store.contentState {
        case .loading:
            HStack(spacing: 10) {
                ProgressView().controlSize(.small)
                Text("正在加载洞察列表…").font(.callout).foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
            .padding(.vertical, 30)
        case .failed(let message):
            NoticeRow(kind: .failure, message: message)
        case .empty:
            NoticeRow(kind: .warning, message: config.emptyText)
        case .ready:
            listContent
        }
    }

    private var listContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            GroupBox {
                VStack(alignment: .leading, spacing: 0) {
                    listHeaderRow
                    Divider()
                    ForEach(store.items) { item in
                        InsightListRow(
                            item: item,
                            isSelected: store.detailID == item.id,
                            onOpen: { store.openInsight(id: item.id) }
                        )
                        if item.id != store.items.last?.id { Divider().opacity(0.4) }
                    }
                }
                .padding(4)
            } label: {
                Text("洞察记录（共 \(store.total) 条）")
            }
            paginationBar
        }
    }

    private var listHeaderRow: some View {
        HStack(spacing: 10) {
            Text("标题").font(.caption.weight(.semibold)).frame(maxWidth: .infinity, alignment: .leading)
            Text("项目").font(.caption.weight(.semibold)).frame(width: 110, alignment: .leading)
            Text("站点").font(.caption.weight(.semibold)).frame(width: 46, alignment: .leading)
            Text("类型").font(.caption.weight(.semibold)).frame(width: 70, alignment: .leading)
            Text("日期范围").font(.caption.weight(.semibold)).frame(width: 170, alignment: .leading)
            Text("状态").font(.caption.weight(.semibold)).frame(width: 96, alignment: .leading)
            Text("生成时间").font(.caption.weight(.semibold)).frame(width: 130, alignment: .leading)
        }
        .padding(.vertical, 4)
    }

    private var paginationBar: some View {
        HStack(spacing: 10) {
            Button { store.previousPage() } label: {
                Label("上一页", systemImage: "chevron.left")
            }
            .disabled(!store.canGoPrevious)
            Text("第 \(store.page) / \(store.totalPages) 页")
                .font(.caption)
                .foregroundStyle(.secondary)
            Button { store.nextPage() } label: {
                Label("下一页", systemImage: "chevron.right")
            }
            .disabled(!store.canGoNext)
            Spacer(minLength: 0)
            Text("共 \(store.total) 条记录（后端 `total`，非本页行数）")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
    }

    // MARK: - 明细 + 流式草稿 + 维度面板

    @ViewBuilder
    private var detailSection: some View {
        if let insightID = store.detailID {
            GroupBox {
                VStack(alignment: .leading, spacing: 10) {
                    switch store.detailPhase {
                    case .loading:
                        HStack(spacing: 10) {
                            ProgressView().controlSize(.small)
                            Text("正在加载洞察明细…").font(.callout).foregroundStyle(.secondary)
                        }
                    case .failed(let message):
                        NoticeRow(kind: .failure, message: message)
                    case .idle, .loaded:
                        detailBody
                    }
                }
                .padding(6)
            } label: {
                HStack(spacing: 8) {
                    Text("洞察明细 #\(insightID)").font(.caption)
                    if let detail = store.detail {
                        Text("\(detail.projectName) · \(detail.country)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                    Button { store.openInsight(id: nil) } label: {
                        Label("关闭", systemImage: "xmark").font(.caption)
                    }
                    .buttonStyle(.borderless)
                }
            }
        }
    }

    @ViewBuilder
    private var detailBody: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let detail = store.detail {
                HStack(spacing: 8) {
                    Text(detail.title.isEmpty ? "（无标题）" : detail.title)
                        .font(.headline)
                    InsightStatusPill(
                        status: InsightPanelMapping.legacyListStatus(
                            detail.status,
                            subStatus: detail.subStatus
                        ),
                        label: store.stream.panel.label,
                        showsSpinner: store.stream.panel.isStreaming
                    )
                    Spacer(minLength: 0)
                    if store.stream.reconnects > 0 {
                        Text("已重连 \(store.stream.reconnects) 次")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Text(
                    "\(detail.dateRangeStart) ~ \(detail.dateRangeEnd)"
                        + " · \(InsightTypes.label(value: detail.insightType))"
                        + " · \(detail.createdBy)"
                        + " · \(AgentOpsFormatting.absoluteTime(lastActiveAt: detail.createdAt))"
                )
                .font(.caption)
                .foregroundStyle(.secondary)

                if config.showsDimensionPanel,
                   let coverage = InsightDimensionCoverage.parse(
                       strategyMetadata: detail.strategyMetadata
                   )
                {
                    InsightDimensionPanelView(coverage: coverage)
                }
            }

            if store.isDetailLive {
                Text(
                    "旧洞察链路（`/ai-insights/{id}/stream`）每 2s 轮询一次 DB，只在状态变化时发 `status`、"
                        + "其余发 `ping`，正文只随终态帧回来。该端点**不发 `id:`、后端也不认 `Last-Event-ID`**，"
                        + "所以断线恢复的口径是「重连后回读 detail 权威快照」，不是游标续传。"
                )
                .font(.caption)
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
            }

            if let streamError = store.stream.errorMessage {
                NoticeRow(kind: .failure, message: streamError)
            }

            InsightStreamPanel(
                state: store.stream.panel,
                content: store.detailContent,
                contentState: store.stream.contentState == .final ? .final : .draft,
                errorMessage: nil,
                digest: nil,
                headerTrailing: nil,
                emptyText: store.isDetailLive
                    ? "\(store.stream.panel.label)正文会实时出现在这里"
                    : "本条洞察没有正文。"
            )

            if !store.stream.eventTypes.isEmpty {
                Text("已收到帧类型序列：\(store.stream.eventTypes.joined(separator: " → "))")
                    .font(.caption.monospaced())
                    .foregroundStyle(.tertiary)
                    .textSelection(.enabled)
            }
        }
    }

    // MARK: - 定时列表（只读）

    private var schedulesSection: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                switch store.schedulesPhase {
                case .loading:
                    HStack(spacing: 10) {
                        ProgressView().controlSize(.small)
                        Text("正在加载定时任务…").font(.callout).foregroundStyle(.secondary)
                    }
                case .failed(let message):
                    NoticeRow(
                        kind: .warning,
                        message: "定时任务列表不可用（\(message)）——不影响上面的洞察记录。"
                    )
                case .idle, .loaded:
                    if store.schedules.isEmpty {
                        Text("暂无定时任务（当前筛选下后端返回 0 条）。新建 / 启停属写链路，桌面端本批不做。")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(store.schedules) { schedule in
                            HStack(spacing: 10) {
                                InsightStatusPill(
                                    status: schedule.isActive ? "completed" : "cancelled",
                                    label: schedule.isActive ? "已启用" : "已停用"
                                )
                                Text(schedule.projectName)
                                    .font(.callout)
                                    .frame(width: 130, alignment: .leading)
                                Text(schedule.country).font(.callout).frame(width: 40)
                                Text(schedule.cronExpression)
                                    .font(.callout.monospaced())
                                    .frame(width: 110, alignment: .leading)
                                Text(InsightTypes.label(value: schedule.insightType))
                                    .font(.callout)
                                    .frame(width: 70, alignment: .leading)
                                Text("成功 \(schedule.runCount) · 失败 \(schedule.failureCount)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Spacer(minLength: 0)
                                Text(AgentOpsFormatting.absoluteTime(lastActiveAt: schedule.nextRunAt))
                                    .font(.caption)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                    }
                }
            }
            .padding(6)
        } label: {
            Text("定时任务（只读 · \(store.schedules.count) 条）")
        }
    }

    // MARK: - 加载

    private func reload() async {
        guard let provider = model.insightProvider() else {
            store.failWithoutCredential()
            return
        }
        await store.load(
            using: provider,
            scope: navigation.tasks,
            key: navigation.selectionTaskKey
        )
    }

    private func reloadDetail() async {
        guard store.detailID != nil, let provider = model.insightProvider() else { return }
        await store.loadDetailAndWatch(
            using: provider,
            scope: navigation.tasks,
            key: navigation.selectionTaskKey
        )
    }
}

/// 列表一行（点开看明细）。
private struct InsightListRow: View {
    let item: InsightListItem
    let isSelected: Bool
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 10) {
                Text(item.title.isEmpty ? "（无标题）" : item.title)
                    .font(.callout)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(item.projectName)
                    .font(.callout)
                    .lineLimit(1)
                    .frame(width: 110, alignment: .leading)
                Text(item.country).font(.callout).frame(width: 46, alignment: .leading)
                Text(InsightTypes.label(value: item.insightType))
                    .font(.caption)
                    .frame(width: 70, alignment: .leading)
                Text("\(item.dateRangeStart) ~ \(item.dateRangeEnd)")
                    .font(.caption)
                    .frame(width: 170, alignment: .leading)
                InsightStatusPill(
                    status: InsightPanelMapping.legacyListStatus(
                        item.status,
                        subStatus: item.subStatus
                    ),
                    label: statusLabel,
                    showsSpinner: InsightStatusMachine.isActive(item.status)
                )
                .frame(width: 96, alignment: .leading)
                Text(AgentOpsFormatting.absoluteTime(lastActiveAt: item.createdAt))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(width: 130, alignment: .leading)
            }
            .padding(.vertical, 3)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(isSelected ? Color.accentColor.opacity(0.12) : .clear)
    }

    private var statusLabel: String {
        if item.status == "completed" { return "已完成" }
        if item.status == "failed" { return "失败" }
        if item.status == "pending" { return "排队中" }
        return InsightLegacySubStatus.label(item.subStatus) ?? "生成中"
    }
}

/// 「分析策略」维度面板（Web `dimension-panel.tsx` 的口径：L1 单维度 / L2 交叉 / L3 跨周期 / 跳过）。
struct InsightDimensionPanelView: View {
    let coverage: InsightDimensionCoverage

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "waveform.path.ecg").font(.caption).foregroundStyle(.secondary)
                Text("分析策略").font(.caption.weight(.semibold))
                Text("\(coverage.total) 维度覆盖" + (coverage.skipped.isEmpty ? "" : "，\(coverage.skipped.count) 跳过"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if !coverage.analyzed.isEmpty {
                dimensionGroup(title: "单维度深挖 (L1)", items: coverage.analyzed, color: .green)
            }
            if !coverage.cross.isEmpty {
                dimensionGroup(title: "交叉分析 (L2)", items: coverage.cross, color: .blue)
            }
            if !coverage.temporal.isEmpty {
                dimensionGroup(title: "跨周期分析 (L3)", items: coverage.temporal, color: .purple)
            }
            if !coverage.skipped.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("跳过维度").font(.caption.weight(.medium)).foregroundStyle(.secondary)
                    ForEach(coverage.skipped) { entry in
                        Text("• \(entry.name) — \(entry.reason)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(8)
        .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 8))
    }

    private func dimensionGroup(
        title: String,
        items: [InsightDimensionCoverage.Dimension],
        color: Color
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption.weight(.medium)).foregroundStyle(color)
            HStack(spacing: 6) {
                ForEach(items) { dimension in
                    Text(dimension.name)
                        .font(.caption2)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(color.opacity(0.12), in: Capsule())
                }
                Spacer(minLength: 0)
            }
        }
    }
}

/// canonical run 观察区（`/insight/runs/{run_id}` + `/{run_id}/stream`）。
///
/// 两页共用。**没有 list 端点**这一事实写在 `CanonicalRunStore` 的文档里，这里把它显式
/// 讲给用户看：入口是「填 run id 观察」，而不是假装有一个列表。
struct InsightRunObserverSection: View {
    let store: CanonicalRunStore
    let model: AppModel
    let navigation: NavigationStore

    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    TextField(
                        "canonical run id（UUID）",
                        text: Binding(
                            get: { store.runIDInput },
                            set: { store.setRunIDInput($0) }
                        )
                    )
                    .textFieldStyle(.roundedBorder)
                    .frame(minWidth: 260)
                    Button("观察") { store.submit() }
                    Button("停止") { store.clear() }
                        .disabled(store.runID == nil)
                    Spacer(minLength: 0)
                }

                Text(
                    "canonical 侧只有「建 / 读 / 流 / 取消 / 重试」，**没有 run 列表端点**；"
                        + "桌面端本批不做写链路（生成 / 取消 / 重试属 S6），因此这里按 run id 观察 —— "
                        + "Web 侧的 run id 来自台账行的 `insight_run_id`，桌面端台账页还没搬。"
                )
                .font(.caption)
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)

                if let notice = store.inputNotice {
                    NoticeRow(kind: .warning, message: notice)
                }

                if store.runID != nil {
                    observerBody
                }
            }
            .padding(6)
        } label: {
            Text("canonical run 观察（\(store.domain == .inventoryHealth ? "库存健康" : "广告分析") 口径）")
        }
        .task(id: store.watchKey) { await watch() }
    }

    @ViewBuilder
    private var observerBody: some View {
        VStack(alignment: .leading, spacing: 10) {
            switch store.detailPhase {
            case .loading:
                HStack(spacing: 10) {
                    ProgressView().controlSize(.small)
                    Text("正在读取 run 快照…").font(.callout).foregroundStyle(.secondary)
                }
            case .failed(let message):
                NoticeRow(kind: .failure, message: message)
            case .idle, .loaded:
                if let detail = store.detail {
                    HStack(spacing: 10) {
                        Text("run \(detail.runId.prefix(8))…")
                            .font(.callout.monospaced())
                        Text("attempt \(detail.attempt)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text("stage \(detail.stage)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        if let usage = detail.usage {
                            Text("tokens \(usage.totalTokens)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                        if store.stream.reconnects > 0 {
                            Text("已重连 \(store.stream.reconnects) 次")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Text(
                        "role \(detail.roleId).v\(detail.roleVersion)"
                            + " · project \(detail.projectId) · \(detail.country)"
                            + " · 创建 \(AgentOpsFormatting.absoluteTime(lastActiveAt: detail.createdAt))"
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
            }

            if let error = store.detailErrorMessage {
                NoticeRow(kind: .failure, message: "run 失败：\(error)")
            }
            if let streamError = store.stream.errorMessage {
                NoticeRow(kind: .warning, message: streamError)
            }

            InsightStreamPanel(
                state: store.panel,
                content: store.content,
                contentState: store.contentState == .final ? .final : .draft,
                errorMessage: nil,
                digest: store.digest,
                headerTrailing: nil,
                emptyText: store.panel.busy
                    ? "\(store.panel.label)，正文会实时出现在这里"
                    : "这条 run 没有正文输出。"
            )

            if let lastEventID = store.stream.lastEventID {
                Text(
                    "游标：\(lastEventID)（已去重 \(store.stream.seenCount) 帧；"
                        + "断线重连时作为 `Last-Event-ID` 回传，按 id 去重）"
                )
                .font(.caption.monospaced())
                .foregroundStyle(.tertiary)
                .textSelection(.enabled)
            }
            if !store.stream.eventTypes.isEmpty {
                Text("事件类型序列：\(store.stream.eventTypes.joined(separator: " → "))")
                    .font(.caption.monospaced())
                    .foregroundStyle(.tertiary)
                    .textSelection(.enabled)
            }
        }
    }

    private func watch() async {
        guard store.runID != nil else { return }
        guard let provider = model.insightProvider() else {
            store.failWithoutCredential()
            return
        }
        await store.watch(
            using: provider,
            scope: navigation.tasks,
            key: navigation.selectionTaskKey
        )
    }
}
