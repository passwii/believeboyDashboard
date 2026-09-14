import BelieveBoyKit
import SwiftUI

// MARK: - 报表类型 / 搜索

/// 报表类型选择器 + 搜索框 + 元信息。
///
/// **不**给类型置灰（口径 3）：`ad-upload-files` 是截断的列表，拿它判定「有没有数据」会把
/// 「搜索词」这种久未入库的类型误判成「暂无数据」（实测该项目该站点有 1321 行搜索词数据）。
/// 可用性由所选类型 raw 响应的 `data` 是否为空决定 —— 空态文案会说清「是没数据，不是失败」。
struct AdDataControls: View {
    let store: AdDataStore

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 12) {
                reportTypePicker
                Divider().frame(height: 18)
                searchField
                Spacer(minLength: 8)
                if store.selectedTableState.hasPayload {
                    summaryLine
                }
            }
            Text(store.uploadFilesNote)
                .font(.caption)
                .foregroundStyle(.tertiary)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var reportTypePicker: some View {
        HStack(spacing: 6) {
            Text("报表类型")
                .font(.caption)
                .foregroundStyle(.secondary)
            Picker("报表类型", selection: reportTypeSelection) {
                ForEach(AdDataCatalog.reportTypes) { type in
                    Text(type.label).tag(type.reportType)
                }
            }
            .labelsHidden()
            .frame(minWidth: 180, maxWidth: 240)
            .help("10 种报表类型全部可选；某类型是否真的有数据，以取数结果为准")
        }
    }

    private var reportTypeSelection: Binding<String> {
        Binding(
            get: { store.selectedReportTypeCode },
            set: { store.selectReportType(code: $0) }
        )
    }

    private var searchField: some View {
        HStack(spacing: 6) {
            Text("搜索")
                .font(.caption)
                .foregroundStyle(.secondary)
            TextField("按任意列内容过滤…", text: searchText)
                .textFieldStyle(.roundedBorder)
                .frame(minWidth: 160, maxWidth: 260)
        }
    }

    private var searchText: Binding<String> {
        Binding(
            get: { store.search },
            set: { store.setSearch($0) }
        )
    }

    /// 行数元信息。
    ///
    /// 刻意**不**显示 Web 那句「服务端总行数：N」：后端的 `summary.total_rows` 就是
    /// **本页返回行数**（`len(rows)`），照抄会让人以为它是窗口内总数（口径 2）。
    private var summaryLine: some View {
        let page = store.tablePage
        return HStack(spacing: 8) {
            Text(page.rangeText)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
            Text("· 本页返回 \(store.returnedRowCount) 行")
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.tertiary)
                .help(
                    "后端 summary.total_rows 就是本页返回行数（不是窗口内总行数）——"
                        + "服务端不提供窗口内总数，故这里是「本页返回」，不是「服务端总行数」。"
                )
        }
    }
}

// MARK: - 明细表

/// 原始行表格：可点表头排序 + 行内展开 `raw_row` 中文列详情。
///
/// 列宽定宽 + 双向滚动（Web 是 `min-w-full` 自适应，桌面端三栏外壳的详情栏装不下 18 列，
/// 定宽 + 横滑更可读）；列序与中文列名仍与 Web 逐列一致，抽样对照时不必换算。
struct AdDataTable: View {
    let store: AdDataStore
    let page: AdDataTablePage

    private var columns: [AdDataColumn] { store.columns }

    private var totalWidth: Double {
        columns.reduce(0) { $0 + $1.width } + Double(max(0, columns.count - 1)) * 8 + 28
    }

    var body: some View {
        ScrollView([.horizontal, .vertical]) {
            LazyVStack(alignment: .leading, spacing: 0) {
                headerRow
                Divider()
                ForEach(Array(page.rows.enumerated()), id: \.element.id) { index, item in
                    rowView(item, index: index)
                    if store.isExpanded(id: item.id) {
                        AdRawRowDetail(row: item.row)
                    }
                    if index != page.rows.count - 1 {
                        Divider().opacity(0.35)
                    }
                }
            }
            .frame(width: totalWidth, alignment: .leading)
        }
        .frame(minHeight: 240)
    }

    private var headerRow: some View {
        HStack(spacing: 8) {
            Text("")
                .frame(width: 20)
            ForEach(columns) { column in
                Button {
                    store.toggleSort(key: column.key)
                } label: {
                    HStack(spacing: 4) {
                        if column.alignment == .trailing { Spacer(minLength: 0) }
                        Text(column.label)
                            .font(.caption.weight(.medium))
                            .foregroundStyle(sortTint(column))
                            .lineLimit(1)
                        Image(systemName: sortSymbol(column))
                            .font(.system(size: 9))
                            .foregroundStyle(sortTint(column))
                        if column.alignment == .leading { Spacer(minLength: 0) }
                    }
                    .frame(width: column.width, alignment: alignment(column.alignment))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("\(column.key)（点表头排序；本页排序在客户端做）")
            }
        }
        .padding(.vertical, 6)
    }

    private func rowView(_ item: AdDataPageRow, index: Int) -> some View {
        HStack(spacing: 8) {
            Button {
                store.toggleRowExpansion(id: item.id)
            } label: {
                Image(systemName: store.isExpanded(id: item.id) ? "chevron.down" : "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 20)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("展开该行的原始上传数据（raw_row 中文列）")

            ForEach(columns) { column in
                Text(column.text(in: item.row))
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(column.isNumeric ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                    .lineLimit(2)
                    .truncationMode(.tail)
                    .frame(width: column.width, alignment: alignment(column.alignment))
            }
        }
        .padding(.vertical, 4)
        .background(index.isMultiple(of: 2) ? Color.clear : Color.primary.opacity(0.03))
    }

    private func alignment(_ alignment: AdDataColumnAlignment) -> Alignment {
        alignment == .trailing ? .trailing : .leading
    }

    private func sortSymbol(_ column: AdDataColumn) -> String {
        guard let sort = store.sort, sort.key == column.key else { return "arrow.up.arrow.down" }
        return sort.direction.symbolName
    }

    private func sortTint(_ column: AdDataColumn) -> AnyShapeStyle {
        if let sort = store.sort, sort.key == column.key { return AnyShapeStyle(.primary) }
        return AnyShapeStyle(.secondary)
    }
}

/// 行内展开：该行的 `raw_row`（后端保留的**未解析中文列**）。
///
/// Web 是 `JSON.stringify(row.raw_row, null, 2)` 塞进 `<pre>`；桌面端把同一份数据画成
/// 「中文列名 → 值」的逐行清单（键排序），既保留了 Web 的全部信息，又不逼人数着括号看。
struct AdRawRowDetail: View {
    let row: DynamicJSONRow

    private var entries: [(key: String, value: JSONValue)] {
        guard let object = row["raw_row"]?.objectValue else { return [] }
        return object.sorted { $0.key < $1.key }.map { (key: $0.key, value: $0.value) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("原始上传数据（raw_row · 未解析的中文列）")
                .font(.caption2.weight(.medium))
                .foregroundStyle(.tertiary)
            if entries.isEmpty {
                Text("该行没有保留 raw_row（后端未存原始中文列）。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(entries, id: \.key) { entry in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(entry.key)
                            .font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(.tertiary)
                            .frame(width: 180, alignment: .leading)
                        Text(entry.value.text ?? "null")
                            .font(.system(.caption, design: .monospaced))
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                }
            }
        }
        .padding(.leading, 28)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.accentColor.opacity(0.06))
    }
}

// MARK: - 翻页

/// 客户端翻页条：只在内存数组上翻页（口径 5，不做服务端 offset 翻页）。
struct AdDataPagingBar: View {
    let store: AdDataStore
    let page: AdDataTablePage

    var body: some View {
        HStack(spacing: 10) {
            Button {
                store.previousPage()
            } label: {
                Label("上一页", systemImage: "chevron.left")
            }
            .disabled(page.page <= 1)

            Text("第 \(page.page) / \(page.totalPages) 页")
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)

            Button {
                store.nextPage()
            } label: {
                Label("下一页", systemImage: "chevron.right")
            }
            .disabled(page.page >= page.totalPages)

            Divider().frame(height: 14)

            Text("每页 \(store.pageSize) 行 · \(page.rangeText)")
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.tertiary)

            Spacer()
        }
    }
}

// MARK: - 正文分支（纯判定，可离线钉住）

/// 正文渲染分支 —— 纯数据，判定收在 `resolve`（口径与 S5.1 的 `AdAnalysisTabContent` 同）。
///
/// 为什么把这一支挑出视图：验收标准 3 的「空态必须显示『无数据』」只在
/// `projectGate == .ready` **且** `contentState == .empty` 这一支上成立，而这一支最容易被外层
/// 提前吃掉（S5.1 首版就是这么漏的：`.empty` 先命中 `EmptyView()`，提示永远画不出来）。
/// 判定挑出来后，单测可以直接钉住「空态 → notice」。
enum AdDataContent: Equatable {
    case loading(String)
    case notice(String)
    case blocked
    case ready

    static func resolve(
        gate: AdProjectGate,
        content: AdDataStore.ContentState,
        reportLabel: String
    ) -> AdDataContent {
        switch gate {
        case .pending:
            return .loading("正在加载项目列表…")
        case .failed, .noProjects:
            return .blocked
        case .ready:
            switch content {
            case .loading:
                return .loading("正在加载「\(reportLabel)」…")
            case .empty:
                return .notice(emptyNoticeMessage(reportLabel: reportLabel))
            case .failed:
                return .blocked
            case .ready:
                return .ready
            }
        }
    }

    /// 空态文案（验收标准 3 的「无数据」提示原文）。
    static func emptyNoticeMessage(reportLabel: String) -> String {
        "当前筛选条件下「\(reportLabel)」没有原始数据 ——"
            + "不是加载失败：该项目的报表里没有落在这个项目 / 站点 / 日期窗口内的该报表类型记录。"
    }
}
