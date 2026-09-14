import BelieveBoyKit
import Charts
import SwiftUI

// MARK: - 筛选条

/// 共享筛选条：项目 / 站点 / 日期区间（**可空**）。
///
/// 10 个 Tab 共用同一组值（改筛选只改 store，切 Tab 不重置）。日期区间的默认是
/// **关闭 = 不传参数**（口径 1）；打开后才会带 `date_from` / `date_to`。
struct AdAnalysisFilterBar: View {
    let store: AdAnalysisStore
    let isRefreshing: Bool
    let onRefresh: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                projectPicker
                Divider().frame(height: 18)
                countryPicker
                Divider().frame(height: 18)
                dateControls
                Spacer(minLength: 8)
                Button(action: onRefresh) {
                    Label("刷新", systemImage: "arrow.clockwise")
                }
                .disabled(isRefreshing)
                .help("按当前筛选条件重新拉取当前 Tab")
                if isRefreshing {
                    ProgressView().controlSize(.small)
                }
            }
            Text(effectiveQueryDescription)
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
    }

    private var projectPicker: some View {
        HStack(spacing: 6) {
            Text("项目")
                .font(.caption)
                .foregroundStyle(.secondary)
            Picker("项目", selection: projectSelection) {
                if store.filters.projectID == nil {
                    Text("选择项目").tag(Int?.none)
                }
                ForEach(store.projects) { project in
                    Text(project.name).tag(Int?.some(project.id))
                }
            }
            .labelsHidden()
            .frame(minWidth: 160, maxWidth: 220)
        }
    }

    private var projectSelection: Binding<Int?> {
        Binding(
            get: { store.filters.projectID },
            set: { store.setProject(id: $0) }
        )
    }

    private var countryPicker: some View {
        HStack(spacing: 6) {
            Text("站点")
                .font(.caption)
                .foregroundStyle(.secondary)
            Picker("站点", selection: countrySelection) {
                ForEach(AdAnalysisCatalog.countries) { country in
                    Text(country.label).tag(country.code)
                }
            }
            .labelsHidden()
            .frame(minWidth: 120, maxWidth: 150)
        }
    }

    private var countrySelection: Binding<String> {
        Binding(
            get: { store.filters.country },
            set: { store.setCountry($0) }
        )
    }

    private var dateControls: some View {
        HStack(spacing: 8) {
            Toggle("按日期筛选", isOn: dateRangeToggle)
                .toggleStyle(.checkbox)
                .help("关闭时**不发送** date_from / date_to —— 后端按全量历史聚合（与 Web 一致）")
            if store.filters.usesDateRange {
                DatePicker(
                    "起",
                    selection: dateFromSelection,
                    displayedComponents: .date
                )
                .labelsHidden()
                DatePicker(
                    "止",
                    selection: dateToSelection,
                    displayedComponents: .date
                )
                .labelsHidden()
            } else {
                Text("未限定日期 → 不传日期参数（全量历史）")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var dateRangeToggle: Binding<Bool> {
        Binding(
            get: { store.filters.usesDateRange },
            set: { enabled in
                store.setUsesDateRange(enabled)
                if enabled, store.filters.dateFrom == nil {
                    let today = AdAnalysisFormatting.dayString(Date())
                    store.setDateFrom(AdAnalysisFormatting.dayString(daysFromToday: -29))
                    store.setDateTo(today)
                }
            }
        )
    }

    private var dateFromSelection: Binding<Date> {
        Binding(
            get: {
                store.filters.dateFrom.flatMap { AdAnalysisFormatting.date(fromDayString: $0) }
                    ?? Date()
            },
            set: { store.setDateFrom(AdAnalysisFormatting.dayString($0)) }
        )
    }

    private var dateToSelection: Binding<Date> {
        Binding(
            get: {
                store.filters.dateTo.flatMap { AdAnalysisFormatting.date(fromDayString: $0) }
                    ?? Date()
            },
            set: { store.setDateTo(AdAnalysisFormatting.dayString($0)) }
        )
    }

    /// 当前**实际**发出的筛选条件（比对数值时照这行念）。
    private var effectiveQueryDescription: String {
        let project = store.projects.first { $0.id == store.filters.projectID }?.name ?? "（未选）"
        let country = AdAnalysisCatalog.countryLabel(code: store.filters.country)
        var text = "查询：\(project) · \(country)"
        if let from = store.filters.effectiveDateFrom, let to = store.filters.effectiveDateTo {
            text += " · \(from) ~ \(to)"
        } else {
            text += " · 未传日期（全量历史）"
        }
        if let loadedAt = store.selectedTabState.loadedAt {
            text += " · 本页数据 \(AgentOpsFormatting.clockTime(loadedAt)) 拉取"
        }
        return text
    }
}

// MARK: - Tab 栏

/// 10 个子 Tab 的横向切换条（顺序与文案以 Web `config.ts` 为准）。
struct AdAnalysisTabStrip: View {
    let store: AdAnalysisStore

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                ForEach(AdAnalysisCatalog.tabs) { tab in
                    tabButton(tab)
                }
            }
            .padding(.vertical, 1)
        }
    }

    private func tabButton(_ tab: AdAnalysisTab) -> some View {
        let isSelected = store.selectedTabKey == tab.key
        return Button {
            store.selectTab(key: tab.key)
        } label: {
            Text(tab.label)
                .font(.callout.weight(isSelected ? .semibold : .regular))
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(
                    isSelected ? Color.accentColor.opacity(0.18) : Color.clear,
                    in: RoundedRectangle(cornerRadius: 6)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(tab.endpoint)
        .accessibilityLabel("\(tab.label)（\(tab.key)）")
    }
}

// MARK: - KPI 磁贴

/// 指标磁贴（对齐 Web 的 `TermMetricTile`：标题 + 数值 + 环比着色箭头）。
struct AdMetricTile: View {
    let label: String
    let value: String
    let changeRatio: Double?
    let helper: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 4) {
                Text(label.uppercased())
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer(minLength: 2)
                changeBadge
            }
            Text(value)
                .font(.system(.callout, design: .monospaced).weight(.semibold))
                .lineLimit(1)
                .help(helper ?? "")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 6))
    }

    @ViewBuilder
    private var changeBadge: some View {
        if let changeRatio, changeRatio.isFinite {
            let positive = changeRatio >= 0
            Text("\(positive ? "▲" : "▼")\(String(format: "%.2f", abs(changeRatio)))%")
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(positive ? Color.green : Color.red)
        } else {
            Text("—")
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.tertiary)
        }
    }
}

/// `overview.metrics` 的磁贴带（label 用 Web 的短名映射，helper 进 hover）。
struct AdMetricTiles: View {
    let metrics: [AdAnalysisMetricCard]
    let comparison: AdAnalysisPeriodComparison?

    private static let shortLabels: [String: String] = [
        "Spend": "SPEND",
        "Sales 7d": "SALES",
        "ACOS": "ACOS",
        "ROAS": "ROAS",
        "Orders 7d": "ORDERS",
        "CTR": "CTR",
        "CPC": "CPC",
        "Trend Days": "DAYS",
        "Cross-sell Sales 7d": "X-SELL",
    ]

    var body: some View {
        LazyVGrid(
            columns: Array(repeating: GridItem(.flexible(minimum: 96), spacing: 8), count: 4),
            spacing: 8
        ) {
            ForEach(metrics, id: \.label) { metric in
                AdMetricTile(
                    label: Self.shortLabels[metric.label] ?? metric.label.uppercased(),
                    value: metric.displayValue,
                    changeRatio: comparison?.changeRatio(forMetricLabel: metric.label),
                    helper: helper(for: metric)
                )
            }
        }
    }

    private func helper(for metric: AdAnalysisMetricCard) -> String {
        let short = Self.shortLabels[metric.label] ?? metric.label
        var text = metric.helper ?? ""
        if metric.label != short {
            text += text.isEmpty ? metric.label : " · \(metric.label)"
        }
        return text
    }
}

/// `summary_cards` 的磁贴带（`value` 已是后端格式化好的字符串）。
struct AdSummaryCardTiles: View {
    let cards: [AdAnalysisSummaryCard]

    var body: some View {
        LazyVGrid(
            columns: Array(repeating: GridItem(.flexible(minimum: 96), spacing: 8), count: 4),
            spacing: 8
        ) {
            ForEach(Array(cards.enumerated()), id: \.offset) { _, card in
                AdMetricTile(
                    label: card.label,
                    value: card.value,
                    changeRatio: nil,
                    helper: card.helper
                )
            }
        }
    }
}

// MARK: - 周期对比 / 叙述 / 风险提醒

/// 周期对比面板（`time-trend` / `overview` 的 `comparison`；无日期时后端返回 null）。
struct AdComparisonPanel: View {
    let comparison: AdAnalysisPeriodComparison

    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                Text(periodText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let summary = comparison.summary, !summary.isEmpty {
                    Text(summary)
                        .font(.callout)
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack(spacing: 8) {
                    ratioTile("花费变化", comparison.spendChangeRatio)
                    ratioTile("点击变化", comparison.clicksChangeRatio)
                    ratioTile("CPC 变化", comparison.cpcChangeRatio)
                }
            }
            .padding(6)
            .frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            Text("周期对比")
        }
    }

    private var periodText: String {
        let current = "\(comparison.currentStart ?? "—") ~ \(comparison.currentEnd ?? "—")"
        let previous = "\(comparison.previousStart ?? "—") ~ \(comparison.previousEnd ?? "—")"
        return "当前周期 \(current) 对比上一周期 \(previous)"
    }

    private func ratioTile(_ label: String, _ ratio: Double?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(ratio.map { String(format: "%.2f%%", $0 * 100) } ?? "-")
                .font(.system(.callout, design: .monospaced).weight(.medium))
                .foregroundStyle(ratio == nil ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 6))
    }
}

/// 结构化分析段落（`narrative_sections`）。
struct AdNarrativeSectionList: View {
    let sections: [AdAnalysisNarrativeSection]

    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(sections.enumerated()), id: \.offset) { _, section in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(section.title)
                            .font(.callout.weight(.medium))
                        Text(section.summary)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        ForEach(section.evidence, id: \.self) { evidence in
                            Text("- \(evidence)")
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        if let action = section.action, !action.isEmpty {
                            Text("动作：\(action)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 4)
                }
            }
            .padding(6)
            .frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            Text("结构化分析（\(sections.count) 段）")
        }
    }
}

/// 风险提醒（`overview.issue_cards`）—— 默认折叠，不占首屏。
struct AdIssueCardList: View {
    let cards: [AdAnalysisIssueCard]

    var body: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(cards.enumerated()), id: \.offset) { _, card in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            Text(card.level)
                                .font(.caption2.weight(.semibold))
                                .padding(.horizontal, 6)
                                .padding(.vertical, 1)
                                .background(levelColor(card.level).opacity(0.16), in: Capsule())
                                .foregroundStyle(levelColor(card.level))
                            Text(card.title)
                                .font(.callout.weight(.medium))
                        }
                        Text(card.summary)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        if let next = card.nextStep, !next.isEmpty {
                            Text("下一步：\(next)")
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 4)
                }
            }
            .padding(.top, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            Text("风险提醒 · \(cards.count) 条")
                .font(.callout.weight(.medium))
        }
        .padding(10)
        .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 8))
    }

    private func levelColor(_ level: String) -> Color {
        switch level.lowercased() {
        case "high", "高": return .red
        case "medium", "中": return .orange
        default: return .secondary
        }
    }
}

// MARK: - 明细网格

/// 通用明细网格：列取自 `AdAnalysisColumns`，行是动态字段。
///
/// 被精简掉的字段不会消失 —— 每行都有 hover 提示列出该行**全部**字段（同 S4 的口径），
/// 需要逐字段核对时不必回到 Web。
struct AdDataGrid: View {
    let columns: [AdAnalysisColumn]
    let rows: [AdAnalysisRow]
    /// 折叠的次要字段：值相同的行不重复显示（例如「总览」的分组列）。
    let hiddenKeys: Set<String>

    init(
        columns: [AdAnalysisColumn],
        rows: [AdAnalysisRow],
        hiddenKeys: Set<String> = []
    ) {
        self.columns = columns
        self.rows = rows
        self.hiddenKeys = hiddenKeys
    }

    private var totalWidth: Double {
        columns.reduce(0) { $0 + $1.width } + Double(max(0, columns.count - 1)) * 8
    }

    var body: some View {
        ScrollView([.horizontal, .vertical]) {
            LazyVStack(alignment: .leading, spacing: 0) {
                headerRow
                Divider()
                ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                    rowView(row, index: index)
                    if index != rows.count - 1 {
                        Divider().opacity(0.35)
                    }
                }
            }
            .frame(width: totalWidth, alignment: .leading)
        }
        .frame(minHeight: 200)
    }

    private var headerRow: some View {
        HStack(spacing: 8) {
            ForEach(columns) { column in
                Text(column.title)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .frame(width: column.width, alignment: alignment(column.alignment))
            }
        }
        .padding(.vertical, 6)
    }

    private func rowView(_ row: AdAnalysisRow, index: Int) -> some View {
        HStack(spacing: 8) {
            ForEach(columns) { column in
                Text(column.text(in: row))
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(style(for: column, row: row))
                    .lineLimit(2)
                    .truncationMode(.tail)
                    .frame(width: column.width, alignment: alignment(column.alignment))
            }
        }
        .padding(.vertical, 4)
        .background(index.isMultiple(of: 2) ? Color.clear : Color.primary.opacity(0.03))
        .help(tooltip(for: row))
    }

    private func alignment(_ alignment: AdAnalysisColumnAlignment) -> Alignment {
        alignment == .trailing ? .trailing : .leading
    }

    private func style(for column: AdAnalysisColumn, row: AdAnalysisRow) -> AnyShapeStyle {
        switch column.tone {
        case .plain: return AnyShapeStyle(.primary)
        case .muted: return AnyShapeStyle(.secondary)
        case .acos:
            guard let value = row.number(column.key) else { return AnyShapeStyle(.tertiary) }
            return AnyShapeStyle(value > 0.3 ? Color.red : Color.green)
        case .risk:
            switch row.nonEmptyString(column.key) {
            case "高风险": return AnyShapeStyle(Color.red)
            case "中风险": return AnyShapeStyle(Color.orange)
            default: return AnyShapeStyle(.secondary)
            }
        }
    }

    /// 该行的全部字段（`key: value`），被精简掉的列都在这里。
    private func tooltip(for row: AdAnalysisRow) -> String {
        row.fields
            .filter { !hiddenKeys.contains($0.key) }
            .sorted { $0.key < $1.key }
            .map { "\($0.key): \($0.value.text ?? "null")" }
            .joined(separator: "\n")
    }
}

// MARK: - 图表

/// 趋势折线（`overview.trend_summary`）：Spend 与 Sales 7d 两条线。
struct AdTrendChart: View {
    struct Point: Identifiable {
        let id: Int
        let day: String
        let spend: Double
        let sales: Double
    }

    let points: [Point]

    var body: some View {
        Chart {
            ForEach(points) { point in
                LineMark(
                    x: .value("日期", point.day),
                    y: .value("花费", point.spend)
                )
                .foregroundStyle(by: .value("指标", "花费"))

                LineMark(
                    x: .value("日期", point.day),
                    y: .value("销售额", point.sales)
                )
                .foregroundStyle(by: .value("指标", "销售额"))
            }
        }
        .chartForegroundStyleScale([
            "花费": Color.orange,
            "销售额": Color.green,
        ])
        .frame(height: 170)
        .padding(6)
    }
}

/// 「高消耗活动」横向柱状（`overview.top_campaigns`，Web 的分布柱状同源）。
struct AdCampaignBarChart: View {
    struct Point: Identifiable {
        let id: Int
        let name: String
        let spend: Double
    }

    let points: [Point]

    var body: some View {
        Chart(points) { point in
            BarMark(
                x: .value("花费", point.spend),
                y: .value("活动", point.name)
            )
            .foregroundStyle(Color.accentColor)
        }
        .frame(height: 170)
        .padding(6)
    }
}
