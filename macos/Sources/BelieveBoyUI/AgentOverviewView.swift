import BelieveBoyKit
import SwiftUI

/// 模块视图路由表：**已搬运**的模块在这里按 route id 命中，未命中的仍走占位视图。
///
/// S4 之前所有二级页都是占位（`ModulePlaceholderView`）；从 S4 起每搬一个模块，就在
/// 这里加一条分支 —— 命中即真模块（发请求、有加载态），未命中即占位（零请求）。
/// 把「哪条路由已经实现」收在一个 switch 里，是为了让占位与实现的边界**只有一个
/// 编辑点**：散在各处判断 `item.id == ...` 迟早会出现「页面已实现但还显示未实现」。
@MainActor
enum ModuleRegistry {
    static func view(
        for item: NavigationItem,
        model: AppModel,
        navigation: NavigationStore
    ) -> AnyView? {
        switch item.id {
        case AgentOverviewView.routeID:
            return AnyView(AgentOverviewView(model: model, navigation: navigation))
        case AdAnalysisView.routeID:
            return AnyView(AdAnalysisView(model: model, navigation: navigation))
        default:
            return nil
        }
    }
}

extension AppModel {
    /// 业务域数据源：用当前会话（key + 账号上下文）构造；未登录返回 nil。
    ///
    /// 复用 `AppModel` 的 `URLSession` 是刻意的 —— 单测用打桩 session 跑通链路时，
    /// 模块请求也必须走同一个 session，否则「离屏渲染模块」的用例会静默打真实网络。
    func agentOpsProvider() -> AgentOpsClient? {
        guard let client = makeAPIClient() else { return nil }
        return AgentOpsClient(client: client)
    }
}

/// 「运营 → 数据流总览」只读页（`/dashboard/agent-center/overview`）。
///
/// 信息密度口径（PLAN §8 S4）：Web 是 11 列定宽 `min-w-[1040px]` 横滑表，Mac 三栏外壳
/// 的详情栏装不下 —— 故矩阵只放 7 列（业务域 / 最近活动 / 调用 24h / 调用 7d / 7d 错误 /
/// 今日产出 / 状态），**说明 / 能力 / 路由数 / 读写量 / Web 入口进详情面板与 hover 提示**。
/// 数据口径与列序仍与 Web 逐行对齐，抽样比对时不必换算。
///
/// 视图不使用属性包装器宏（工具链约束，见 Package.swift 顶部）：状态住在
/// `AgentOverviewStore`（由 `NavigationStore` 持有，切换模块不丢），需要双向绑定的
/// 地方走显式 `Binding`。
public struct AgentOverviewView: View {
    /// Web 路由（同时是 `NavigationItem.id`）——模块路由表的命中键。
    public static let routeID = "/dashboard/agent-center/overview"

    private let model: AppModel
    private let navigation: NavigationStore

    public init(model: AppModel, navigation: NavigationStore) {
        self.model = model
        self.navigation = navigation
    }

    private var store: AgentOverviewStore { navigation.agentOverview }

    /// 矩阵列宽：`说明` 之外的运行时列都是定宽，避免行与表头错位。
    private enum Column {
        static let domain: CGFloat = 118
        static let activity: CGFloat = 92
        static let calls: CGFloat = 68
        static let errors: CGFloat = 68
        static let production: CGFloat = 104
        static let status: CGFloat = 72
    }

    public var body: some View {
        ScrollView([.vertical, .horizontal]) {
            VStack(alignment: .leading, spacing: 18) {
                header
                stateSection
                if showsMatrix {
                    matrixSection
                    productionNotice
                    detailSection
                }
            }
            .padding(24)
            .frame(minWidth: 620, alignment: .leading)
        }
        .frame(minWidth: 420, minHeight: 360)
        // 模块自己的加载走 `NavigationStore.tasks`（按 route id 登记），切换模块时由
        // 外壳统一取消 —— 见 `ModuleTaskScope`。
        .task { await reload() }
    }

    /// 加载中 / 失败态下不渲染矩阵（空态**要**渲染：那时表格是真实的、只是全为占位）。
    private var showsMatrix: Bool {
        switch store.pageState {
        case .ready, .empty: return true
        case .loading, .failed: return false
        }
    }

    // MARK: - 页头

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("运营 · 数据流总览")
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
            HStack(spacing: 10) {
                Image(systemName: "waveform.path.ecg")
                    .font(.title3)
                    .foregroundStyle(.secondary)
                Text("数据流总览")
                    .font(.title2.weight(.semibold))
                Text("只读")
                    .font(.caption.weight(.medium))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(.quaternary, in: Capsule())
                Spacer()
                Button {
                    Task { await reload() }
                } label: {
                    Label("刷新", systemImage: "arrow.clockwise")
                }
                .disabled(store.isRefreshing)
                .help("重新拉取业务域矩阵与今日产出（四个源并发，各自降级）")
                if store.isRefreshing {
                    ProgressView().controlSize(.small)
                }
            }
            Text(
                "共 \(store.rows.count) 个业务域、\(store.activityDomainCount) 个窗口内有活动，产出域置顶。"
                    + "「今日产出」为实时业务数据，运行时活动与 7d 错误率由 domain-summary 提供，缺位显示占位「—」。"
            )
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            dataTimeLine
        }
    }

    private var dataTimeLine: some View {
        HStack(spacing: 10) {
            Text("统计窗口 \(store.windowDays) 天")
            Text("·")
            Text("最近活动时间")
            Text(AgentOpsFormatting.relativeTime(lastActiveAt: lastActiveText))
                .font(.system(.caption, design: .monospaced))
            if let loadedAt = store.lastLoadedAt {
                Text("· 本页数据于 \(AgentOpsFormatting.clockTime(loadedAt)) 拉取")
            }
        }
        .font(.caption)
        .foregroundStyle(.tertiary)
    }

    /// 矩阵里最新的 `last_active_at`（页头「最近活动时间」）。
    private var lastActiveText: String? {
        store.rows.compactMap(\.activity?.lastActiveAt).max() ?? nil
    }

    // MARK: - 三态

    @ViewBuilder
    private var stateSection: some View {
        switch store.pageState {
        case .loading:
            HStack(spacing: 10) {
                ProgressView().controlSize(.small)
                Text("正在加载业务域矩阵…")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Spacer()
            }
            .padding(.vertical, 24)
        case .failed(let message):
            VStack(alignment: .leading, spacing: 10) {
                NoticeRow(kind: .failure, message: message)
                HStack(spacing: 10) {
                    Button {
                        Task { await reload() }
                    } label: {
                        Label("重试", systemImage: "arrow.clockwise")
                    }
                    Text("矩阵请求失败时，今日产出列随表一并不可见（它们只在这张表里展示）。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        case .empty:
            NoticeRow(
                kind: .warning,
                message: "近 \(store.windowDays) 天窗口内没有任何业务域调用记录 —— 下方各行的运行时列都是占位「—」，"
                    + "不是加载失败。"
            )
        case .ready:
            if let failure = store.matrixRefreshFailure {
                NoticeRow(kind: .warning, message: "本次刷新失败，下表仍是上一次的数据：\(failure)")
            }
        }
    }

    // MARK: - 矩阵

    private var matrixSection: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 0) {
                tableHeader
                Divider()
                ForEach(Array(store.rows.enumerated()), id: \.element.id) { index, row in
                    rowView(row)
                    if index != store.rows.count - 1 {
                        Divider().opacity(0.4)
                    }
                }
            }
            .padding(.vertical, 4)
        } label: {
            Text("业务域活动矩阵")
        }
    }

    private var tableHeader: some View {
        HStack(spacing: 8) {
            headerCell("业务域", width: Column.domain, alignment: .leading)
            headerCell("最近活动", width: Column.activity, alignment: .leading)
            headerCell("调用 24h", width: Column.calls, alignment: .trailing)
            headerCell("调用 7d", width: Column.calls, alignment: .trailing)
            headerCell("7d 错误", width: Column.errors, alignment: .trailing)
            headerCell("今日产出", width: Column.production, alignment: .leading)
            headerCell("状态", width: Column.status, alignment: .leading)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 6)
    }

    private func headerCell(
        _ title: String,
        width: CGFloat,
        alignment: Alignment
    ) -> some View {
        Text(title)
            .font(.caption.weight(.medium))
            .foregroundStyle(.secondary)
            .frame(width: width, alignment: alignment)
    }

    private func rowView(_ row: AgentOverviewRow) -> some View {
        let isSelected = store.selectedDomainCode == row.id
        return Button {
            store.select(domainCode: row.id)
        } label: {
            HStack(spacing: 8) {
                Text(row.domain.label)
                    .font(.callout.weight(.medium))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(width: Column.domain, alignment: .leading)

                activityCell(row)
                numberCell(row.activity.map { String($0.calls24H) })
                numberCell(row.activity.map { String($0.calls7D) })
                errorCell(row)
                productionCell(row)
                statusCell(row)

                Spacer(minLength: 0)
            }
            .padding(.vertical, 6)
            .contentShape(Rectangle())
            .background(
                isSelected ? Color.accentColor.opacity(0.16) : Color.clear,
                in: RoundedRectangle(cornerRadius: 6)
            )
            // 精简列的代价：完整字段进 hover 提示（PLAN §8 S4 的口径）。
            .help(tooltip(for: row))
        }
        .buttonStyle(.plain)
        .opacity(row.domain.isLive ? 1 : 0.55)
        .accessibilityLabel("\(row.domain.label)，\(row.domain.isLive ? "已接入" : "规划中")")
    }

    private func activityCell(_ row: AgentOverviewRow) -> some View {
        HStack(spacing: 6) {
            Circle()
                .fill(freshnessColor(AgentOpsFormatting.freshness(lastActiveAt: row.activity?.lastActiveAt)))
                .frame(width: 6, height: 6)
            Text(AgentOpsFormatting.relativeTime(lastActiveAt: row.activity?.lastActiveAt))
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .frame(width: Column.activity, alignment: .leading)
    }

    /// 运行时数值列：`nil`（窗口内无调用）显示占位「—」，**不是 0**。
    private func numberCell(_ text: String?) -> some View {
        Text(text ?? "—")
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(text == nil ? AnyShapeStyle(.tertiary) : AnyShapeStyle(.secondary))
            .frame(width: Column.calls, alignment: .trailing)
    }

    private func errorCell(_ row: AgentOverviewRow) -> some View {
        let text = row.activity.map {
            AgentOpsFormatting.errorRateText(errors7d: $0.errors7D, calls7d: $0.calls7D)
        }
        let hasErrors = (row.activity?.errors7D ?? 0) > 0
        return Text(text ?? "—")
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(hasErrors ? AnyShapeStyle(Color.red) : AnyShapeStyle(.secondary))
            .frame(width: Column.errors, alignment: .trailing)
    }

    private func productionCell(_ row: AgentOverviewRow) -> some View {
        Text(row.production ?? "—")
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(row.production == nil ? AnyShapeStyle(.tertiary) : AnyShapeStyle(.secondary))
            .lineLimit(1)
            .frame(width: Column.production, alignment: .leading)
    }

    private func statusCell(_ row: AgentOverviewRow) -> some View {
        Text(row.domain.isLive ? "已接入" : "规划中")
            .font(.caption.weight(.medium))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(.quaternary, in: Capsule())
            .frame(width: Column.status, alignment: .leading)
    }

    private func freshnessColor(_ freshness: AgentFreshness) -> Color {
        switch freshness {
        case .green: return .green
        case .yellow: return .orange
        case .grey: return .secondary
        }
    }

    /// 行的完整字段（hover 提示）：矩阵上被精简掉的列都在这里。
    private func tooltip(for row: AgentOverviewRow) -> String {
        var lines = [
            "\(row.domain.label)（\(row.domain.code)）",
            row.domain.summary,
            "能力：\(row.domain.capabilities.labels.isEmpty ? "—" : row.domain.capabilities.labels.joined(separator: " · "))",
            "路由数：\(row.domain.isLive ? String(row.domain.routeCount) : "—")",
        ]
        if let activity = row.activity {
            lines.append("写 24h / 7d：\(activity.writes24H) / \(activity.writes7D)")
            lines.append("7d 错误：\(activity.errors7D) 次（\(AgentOpsFormatting.errorRateText(errors7d: activity.errors7D, calls7d: activity.calls7D))）")
            lines.append("最近活动：\(AgentOpsFormatting.absoluteTime(lastActiveAt: activity.lastActiveAt))")
        } else {
            lines.append("窗口内无调用记录（运行时列均为占位「—」）")
        }
        lines.append("今日产出：\(row.production ?? "—")")
        return lines.joined(separator: "\n")
    }

    // MARK: - 今日产出降级提示

    @ViewBuilder
    private var productionNotice: some View {
        let failed = store.failedProductionSources
        if !failed.isEmpty {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                NoticeRow(
                    kind: .warning,
                    message: "今日产出有 \(failed.count) 个数据源失败（\(failed.joined(separator: "、"))）："
                        + "对应列显示占位「—」，其它列与矩阵不受影响。"
                )
                Button {
                    Task { await reload() }
                } label: {
                    Label("重试", systemImage: "arrow.clockwise")
                }
            }
        }
    }

    // MARK: - 详情

    private var detailSection: some View {
        GroupBox {
            if let row = store.selectedRow {
                detailRows(for: row)
            } else {
                Text("点击矩阵中任意一行，这里显示完整字段（说明 / 能力 / 路由数 / 读写量 / 7d 错误 / Web 入口）。")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(6)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        } label: {
            HStack {
                Text("业务域详情")
                Spacer()
                if store.selectedRow != nil {
                    Button("清除选中") { store.clearSelection() }
                        .buttonStyle(.link)
                        .font(.caption)
                }
            }
        }
    }

    private func detailRows(for row: AgentOverviewRow) -> some View {
        let activity = row.activity
        return VStack(alignment: .leading, spacing: 8) {
            LabeledContent("标识") {
                Text(row.domain.code)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
            }
            LabeledContent("说明") {
                Text(row.domain.summary)
                    .font(.caption)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            LabeledContent("能力") {
                Text(row.domain.capabilities.labels.isEmpty ? "—" : row.domain.capabilities.labels.joined(separator: " · "))
                    .font(.system(.caption, design: .monospaced))
            }
            LabeledContent("路由数") {
                Text(row.domain.isLive ? String(row.domain.routeCount) : "—")
                    .font(.system(.caption, design: .monospaced))
            }
            LabeledContent("调用 24h / 7d") {
                Text(activity.map { "\($0.calls24H) / \($0.calls7D)" } ?? "—")
                    .font(.system(.caption, design: .monospaced))
            }
            LabeledContent("写 24h / 7d") {
                Text(activity.map { "\($0.writes24H) / \($0.writes7D)" } ?? "—")
                    .font(.system(.caption, design: .monospaced))
            }
            LabeledContent("7d 错误") {
                Text(
                    activity.map {
                        "\($0.errors7D) 次（\(AgentOpsFormatting.errorRateText(errors7d: $0.errors7D, calls7d: $0.calls7D))）"
                    } ?? "—"
                )
                .font(.system(.caption, design: .monospaced))
            }
            LabeledContent("最近活动") {
                Text(
                    activity == nil
                        ? "从未活动"
                        : "\(AgentOpsFormatting.relativeTime(lastActiveAt: activity?.lastActiveAt)) · \(AgentOpsFormatting.absoluteTime(lastActiveAt: activity?.lastActiveAt))"
                )
                .font(.system(.caption, design: .monospaced))
            }
            LabeledContent("今日产出") {
                Text(row.production ?? "—")
                    .font(.system(.caption, design: .monospaced))
            }
            LabeledContent("Web 入口") {
                Text(row.domain.dashboardPath ?? "—")
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
        .padding(6)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - 加载

    /// 加载 / 刷新（同一个入口：都登记在模块任务作用域里，切换模块即取消）。
    private func reload() async {
        guard let provider = model.agentOpsProvider() else {
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
