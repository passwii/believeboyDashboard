import BelieveBoyKit
import SwiftUI

/// 「报表中心 → 报表自动化」（Web `/dashboard/reports/auto-upload`）的 **RPA 状态**页。
///
/// 本批只搬这张只读状态矩阵（`GET /rpa-reports/status`）：行 = 项目，列 = 15 个已激活报表
/// 类型（列序照抄 Web `report-type-labels.ts`），单元格 = 该类型该日期是否已上传。
/// 顶部的日期导航 / 站点 / 项目筛选与 Web 一致（含「今天」与左右各挪一天）。
///
/// 视图不使用属性包装器宏（工具链约束，见 `Package.swift` 顶部）：绑定一律手写。
public struct ReportAutomationView: View {
    /// Web 路由 —— 模块路由表的命中键，也是模块任务作用域的 key。
    public static let routeID = ReportCatalog.reportAutomationRouteID

    private let model: AppModel
    private let navigation: NavigationStore

    public init(model: AppModel, navigation: NavigationStore) {
        self.model = model
        self.navigation = navigation
    }

    private var store: ReportAutomationStore { navigation.reportAutomation }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            scrollableBody
        }
        .frame(minWidth: 640, minHeight: 420)
        // 日期 / 站点 / 刷新票号任一变化 → 重新加载。请求登记在
        // `navigation.selectionTaskKey`（= 当前 route id）下：同 key 的新请求先取消上一个
        // （改日期、切站点），切模块时由外壳按 route id 整体取消。
        .task(id: store.loadKey) { await reload() }
    }

    private var scrollableBody: some View {
        ScrollView([.vertical, .horizontal]) {
            VStack(alignment: .leading, spacing: 12) {
                stateBanners
                content
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: - 页头

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Image(systemName: "arrow.triangle.2.circlepath")
                    .font(.title3)
                    .foregroundStyle(.secondary)
                Text("报表自动化")
                    .font(.title2.weight(.semibold))
                Text("RPA 状态 · 只读")
                    .font(.caption.weight(.medium))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(.quaternary, in: Capsule())
                Spacer()
                if !store.completeness.isEmpty {
                    Text("完成度 \(store.completeness.text)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(store.completeness.uploaded == store.completeness.reported
                            ? .green : .secondary)
                }
            }
            controls
        }
        .padding(.horizontal, 20)
        .padding(.top, 16)
        .padding(.bottom, 10)
    }

    private var controls: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                projectFilter
                Divider().frame(height: 18)
                countryPicker
                Divider().frame(height: 18)
                dateNavigation
                Spacer(minLength: 8)
                Button {
                    store.requestRefresh()
                } label: {
                    Label("刷新", systemImage: "arrow.clockwise")
                }
                .disabled(store.isRefreshing)
                if store.isRefreshing {
                    ProgressView().controlSize(.small)
                }
            }
            Text(store.filterSummary)
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
    }

    private var projectFilter: some View {
        Menu {
            Button("全部项目") { store.clearProjectFilter() }
            Divider()
            switch store.projectsPhase {
            case .loading:
                Text("项目加载中…")
            case .failed(let message):
                Text("项目加载失败：\(message)")
            default:
                EmptyView()
            }
            ForEach(store.projectOptions, id: \.self) { name in
                Button {
                    store.toggleProject(name)
                } label: {
                    Label(
                        name,
                        systemImage: store.isProjectSelected(name) ? "checkmark" : ""
                    )
                }
            }
        } label: {
            Label(store.projectFilterLabel, systemImage: "line.3.horizontal.decrease.circle")
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        // Web 口径（BEL-422）：项目列表只在首次打开筛选时才拉，不随进页预拉。
        .simultaneousGesture(TapGesture().onEnded {
            store.ensureProjects(
                using: provider,
                scope: navigation.tasks,
                routeID: Self.routeID
            )
        })
    }

    private var countryPicker: some View {
        HStack(spacing: 6) {
            Text("站点")
                .font(.caption)
                .foregroundStyle(.secondary)
            Picker("站点", selection: countrySelection) {
                ForEach(AdCountries.all) { country in
                    Text(country.label).tag(country.code)
                }
            }
            .labelsHidden()
            .frame(minWidth: 120, maxWidth: 160)
        }
    }

    private var countrySelection: Binding<String> {
        Binding(
            get: { store.country },
            set: { store.setCountry($0) }
        )
    }

    private var dateNavigation: some View {
        HStack(spacing: 6) {
            Button {
                store.shiftDate(days: -1)
            } label: {
                Image(systemName: "chevron.left")
            }
            .help("前一天")

            DatePicker("报表日期", selection: dateSelection, displayedComponents: .date)
                .labelsHidden()

            Button {
                store.shiftDate(days: 1)
            } label: {
                Image(systemName: "chevron.right")
            }
            .help("后一天")

            Button("今天") { store.goToToday() }
                .help("回到本机今天（与 Web 同口径：浏览器本地日期）")
        }
    }

    private var dateSelection: Binding<Date> {
        Binding(
            get: { ReportCatalog.parseDateString(store.reportDate) ?? Date() },
            set: { store.setReportDate(ReportCatalog.localDateString($0)) }
        )
    }

    // MARK: - 状态提示

    @ViewBuilder
    private var stateBanners: some View {
        if let failure = store.refreshFailure {
            NoticeRow(
                kind: .warning,
                message: "本次刷新失败，下表仍是上一次的数据：\(failure)"
            )
        }
    }

    // MARK: - 正文

    @ViewBuilder
    private var content: some View {
        switch store.contentState {
        case .loading:
            HStack(spacing: 10) {
                ProgressView().controlSize(.small)
                Text("正在加载 RPA 报表状态…")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Spacer()
            }
            .padding(.vertical, 30)
        case .failed(let message):
            VStack(alignment: .leading, spacing: 8) {
                NoticeRow(kind: .failure, message: "报表状态加载失败：\(message)")
                Button {
                    store.requestRefresh()
                } label: {
                    Label("重试", systemImage: "arrow.clockwise")
                }
            }
        case .empty:
            VStack(alignment: .leading, spacing: 6) {
                Text(store.emptyMessage)
                    .font(.callout.weight(.medium))
                Text("切换左右日期，或检查 RPA 是否已接入该日期的数据。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.vertical, 40)
        case .ready:
            grid
        }
    }

    private var grid: some View {
        let columns = store.columns
        let rows = store.filteredRows

        return VStack(alignment: .leading, spacing: 0) {
            if rows.isEmpty {
                // 有数据但被项目筛选清空：筛选是客户端行为，与「该日期无数据」是两回事。
                NoticeRow(
                    kind: .warning,
                    message: "当前项目筛选（\(store.projectFilterLabel)）下没有匹配的项目 ——"
                        + "后端返回了 \(store.rows.count) 个项目。"
                )
            } else {
                headerRow(columns)
                ForEach(rows) { project in
                    projectRow(project, columns: columns)
                }
            }
        }
    }

    private func headerRow(_ columns: [ReportAutomationColumn]) -> some View {
        HStack(spacing: 0) {
            headerCell("项目", width: 170, alignment: .leading)
            ForEach(columns) { column in
                headerCell(column.label, width: 74, alignment: .center)
            }
            headerCell("完成度", width: 80, alignment: .center)
        }
        .background(.quaternary.opacity(0.5))
    }

    private func projectRow(
        _ project: RpaProjectStatus,
        columns: [ReportAutomationColumn]
    ) -> some View {
        let completeness = ReportAutomationCatalog.completeness(project)
        return HStack(spacing: 0) {
            Text(project.projectName)
                .font(.caption)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(width: 170, alignment: .leading)
                .padding(.vertical, 6)
                .padding(.leading, 6)
                .help(project.projectName)
            ForEach(columns) { column in
                cellView(ReportAutomationCatalog.cellState(project, column: column), column: column)
            }
            Text(completeness.isEmpty ? "—" : completeness.text)
                .font(.caption.monospacedDigit())
                .foregroundStyle(completeness.uploaded == completeness.reported && !completeness.isEmpty
                    ? .green : .secondary)
                .frame(width: 80, alignment: .center)
        }
        .background(projectRowBackground)
    }

    private var projectRowBackground: some View {
        Rectangle()
            .fill(.clear)
            .overlay(alignment: .bottom) { Divider() }
    }

    private func cellView(
        _ state: ReportAutomationCatalog.CellState,
        column: ReportAutomationColumn
    ) -> some View {
        let symbol: String
        let color: Color
        let help: String
        switch state {
        case .uploaded:
            symbol = "checkmark.circle.fill"
            color = .green
            help = "\(column.label)：已上传"
        case .missing:
            symbol = "xmark.circle.fill"
            color = .red
            help = "\(column.label)：未上传"
        case .unreported:
            symbol = "minus.circle"
            color = .secondary
            help = "\(column.label)：后端未返回该类型状态（少一列 ≠ 没上传）"
        }
        return Image(systemName: symbol)
            .font(.system(size: 13))
            .foregroundStyle(color)
            .frame(width: 74, height: 26)
            .help(help)
    }

    private func headerCell(
        _ text: String,
        width: CGFloat,
        alignment: Alignment
    ) -> some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            .frame(width: width, alignment: alignment)
            .padding(.vertical, 5)
            .padding(.horizontal, 2)
    }

    // MARK: - 装配与加载

    private var provider: ReportAutomationDataProviding {
        model.reportAutomationProvider()
            ?? ReportAutomationClient(client: APIClient(baseURL: model.effectiveBaseURL, apiKey: nil))
    }

    private func reload() async {
        guard model.reportAutomationProvider() != nil else {
            store.failWithoutCredential()
            return
        }
        await store.load(
            using: provider,
            scope: navigation.tasks,
            routeID: Self.routeID
        )
    }
}
