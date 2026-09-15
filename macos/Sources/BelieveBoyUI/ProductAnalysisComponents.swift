import AppKit
import BelieveBoyKit
import SwiftUI

// 「产品分析」页的共用件：参数条、识别卡片、识别结果、入库状态表、异构布局助手。
//
// 视图不使用属性包装器宏（工具链约束，见 `Package.swift` 顶部）：需要双向绑定的地方一律
// 手写 `Binding`（取值走 store 的派生属性、写值走 store 的命令式 setter）。

/// 参数条：项目 / 站点 / 日期范围 + 「上周」快捷。
///
/// 两个 Tab 共用同一组参数（`ProductAnalysisStore` 只有一份），因为两者的语义就是
/// 「同一个核算周期」的两种动作 —— 各存一份只会让「切 Tab 后日期悄悄变了」变成 bug 来源。
struct ProductParameterBar: View {
    let store: ProductAnalysisStore
    /// 是否显示「上周」快捷（产品分析的默认区间就是上周）。
    var showsLastWeek = true

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                projectPicker
                Divider().frame(height: 18)
                countryPicker
                Divider().frame(height: 18)
                dateRange
                Spacer(minLength: 8)
                if showsLastWeek {
                    Button {
                        let range = ReportDateRanges.lastWeek()
                        store.setDateRange(start: range.start, end: range.end)
                    } label: {
                        Label("上周", systemImage: "calendar.badge.clock")
                    }
                    .help("把日期范围复位到上一个完整自然周（周一~周日）")
                }
            }
            HStack(spacing: 8) {
                Text(querySummary)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                if !store.dateRangeValid {
                    Text("开始日期不能晚于结束日期")
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
        }
    }

    private var querySummary: String {
        let project = store.projectName.trimmedNonEmpty ?? "（未选项目）"
        return "核算对象：\(project) · \(AdCountries.label(code: store.country)) · "
            + "\(store.startDate) ~ \(store.endDate)"
    }

    private var projectPicker: some View {
        HStack(spacing: 6) {
            Text("项目")
                .font(.caption)
                .foregroundStyle(.secondary)
            Picker("项目", selection: projectSelection) {
                if store.projectName.trimmedNonEmpty == nil {
                    Text(placeholderForProjects).tag("")
                }
                ForEach(store.projects) { project in
                    Text(project.name).tag(project.name)
                }
            }
            .labelsHidden()
            .frame(minWidth: 160, maxWidth: 220)
            .disabled(store.projects.isEmpty)
        }
    }

    private var placeholderForProjects: String {
        switch store.projectGate {
        case .pending: return "项目加载中…"
        case .failed: return "项目列表加载失败"
        case .noProjects: return "暂无可选项目"
        case .ready: return "请选择项目"
        }
    }

    private var projectSelection: Binding<String> {
        Binding(
            get: { store.projectName },
            set: { store.setProject(name: $0) }
        )
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

    private var dateRange: some View {
        HStack(spacing: 6) {
            Text("日期范围")
                .font(.caption)
                .foregroundStyle(.secondary)
            DatePicker("起", selection: startSelection, displayedComponents: .date)
                .labelsHidden()
            Text("~")
                .font(.caption)
                .foregroundStyle(.secondary)
            DatePicker("止", selection: endSelection, displayedComponents: .date)
                .labelsHidden()
        }
    }

    private var startSelection: Binding<Date> {
        Binding(
            get: { AdAnalysisFormatting.date(fromDayString: store.startDate) ?? Date() },
            set: { store.setDateRange(start: AdAnalysisFormatting.dayString($0), end: store.endDate) }
        )
    }

    private var endSelection: Binding<Date> {
        Binding(
            get: { AdAnalysisFormatting.date(fromDayString: store.endDate) ?? Date() },
            set: { store.setDateRange(start: store.startDate, end: AdAnalysisFormatting.dayString($0)) }
        )
    }
}

/// 识别 / 提交状态的小徽标。
struct UploadBadge: View {
    enum Kind {
        case pending
        case recognized
        case unsupported
        case failed
        case cancelled
        case saving
        case committed
        case notPorted

        var text: String {
            switch self {
            case .pending: return "识别中"
            case .recognized: return "待确认"
            case .unsupported: return "不支持"
            case .failed: return "失败"
            case .cancelled: return "已中断"
            case .saving: return "提交中"
            case .committed: return "已提交"
            case .notPorted: return "本批未搬"
            }
        }

        var color: Color {
            switch self {
            case .pending, .saving: return .accentColor
            case .recognized: return .orange
            case .unsupported, .notPorted, .cancelled: return .secondary
            case .failed: return .red
            case .committed: return .green
            }
        }
    }

    let kind: Kind

    var body: some View {
        Text(kind.text)
            .font(.caption2.weight(.medium))
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(kind.color.opacity(0.15), in: Capsule())
            .foregroundStyle(kind.color)
    }
}

/// 一条识别记录：文件名 + 识别类型 + 关键判据（项目匹配 / 日期 / 行数 / 警告）+ 提交状态。
///
/// 「识别结果先呈现」的落点：这里逐条把识别器给的判据画出来，用户才有东西可确认。
struct UploadItemRow: View {
    let item: ProductAnalysisStore.UploadItem
    let projects: [String]
    let onSelectProject: (String) -> Void
    let onRemove: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "doc.text")
                    .foregroundStyle(.secondary)
                Text(item.filename)
                    .font(.callout.weight(.medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 8)
                badge
                Button(role: .destructive, action: onRemove) {
                    Image(systemName: "xmark.circle")
                }
                .buttonStyle(.borderless)
                .help("从本页移除（不影响后端已落盘的临时文件）")
            }

            switch item.recognition {
            case .pending:
                Text("正在识别…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            case .cancelled:
                Text("识别已中断（切页 / 切模块，或又重新选了一批文件）——重新选择文件即可再来一次。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            case .failed(let message):
                NoticeRow(kind: .failure, message: "识别失败：\(message)")
            case .recognized(let recognition):
                details(recognition)
            }

            if let message = item.commit.failureMessage {
                NoticeRow(kind: .failure, message: "提交失败（识别结果已保留，可直接重试）：\(message)")
            }
        }
        .padding(12)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 10))
    }

    private var badge: some View {
        if item.commit.isCommitted {
            return UploadBadge(kind: .committed)
        }
        if case .saving = item.commit {
            return UploadBadge(kind: .saving)
        }
        if case .failed = item.commit {
            return UploadBadge(kind: .failed)
        }
        switch item.recognition {
        case .pending:
            return UploadBadge(kind: .pending)
        case .cancelled:
            return UploadBadge(kind: .cancelled)
        case .failed:
            return UploadBadge(kind: .failed)
        case .recognized(let recognition):
            return UploadBadge(kind: recognition.status.isRecognized ? .recognized : .unsupported)
        }
    }

    @ViewBuilder
    private func details(_ recognition: AdUploadRecognition) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            fact("报表类型", "\(recognition.displayLabel)（\(recognition.reportType)）")
            fact("站点", recognition.country)
            if let range = recognition.detectedRange {
                fact("识别日期", "\(range.start) ~ \(range.end)")
            } else {
                fact("识别日期", "未识别到（需手动填）")
            }
            fact("命中列", recognition.matchedColumns.isEmpty
                ? "（无）"
                : recognition.matchedColumns.joined(separator: "、"))
            fact("行数预览", recognition.rowCountPreview.map(String.init) ?? "未提供")
            projectRow(recognition)
            if recognition.status.isRecognized == false {
                NoticeRow(
                    kind: .warning,
                    message: "识别未通过（\(recognition.reason.isEmpty ? recognition.status.rawValue : recognition.reason)）"
                        + "—— 该文件不会进入确认流程。"
                )
            }
            if !recognition.warnings.isEmpty {
                NoticeRow(kind: .warning, message: recognition.warnings.joined(separator: "；"))
            }
            if let message = recognition.projectMatch.message?.trimmedNonEmpty {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
    }

    @ViewBuilder
    private func projectRow(_ recognition: AdUploadRecognition) -> some View {
        HStack(spacing: 6) {
            Text("项目匹配")
                .font(.caption)
                .foregroundStyle(.secondary)
            switch recognition.projectMatch.status {
            case .matched:
                Text(recognition.projectMatch.projectName ?? "已匹配")
                    .font(.caption)
            case .conflict:
                Text("冲突（候选 \(recognition.projectMatch.candidateProjects.count) 个）")
                    .font(.caption)
                    .foregroundStyle(.orange)
            default:
                Text("未匹配")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
            if case .matched = recognition.projectMatch.status {} else {
                Picker("覆盖项目", selection: Binding(
                    get: { recognition.projectMatch.projectName ?? "" },
                    set: { onSelectProject($0) }
                )) {
                    Text("手动选择").tag("")
                    ForEach(projects, id: \.self) { name in
                        Text(name).tag(name)
                    }
                }
                .labelsHidden()
                .frame(minWidth: 140, maxWidth: 200)
            }
        }
    }

    private func fact(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 64, alignment: .leading)
            Text(value)
                .font(.caption)
                .textSelection(.enabled)
            Spacer(minLength: 0)
        }
    }
}

/// 一张报表卡片（Web `ReportStatusCard` 的等价物）：本批只有广告报告能走完整链路。
struct ReportUploadCard: View {
    let config: ProductAnalysisStore.CardConfig
    let store: ProductAnalysisStore
    let onRequestCommit: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Text(config.title)
                    .font(.callout.weight(.semibold))
                Spacer(minLength: 4)
                if !config.chain.isUsable {
                    UploadBadge(kind: .notPorted)
                } else if store.isCommitted(config.reportType) {
                    UploadBadge(kind: .committed)
                }
            }
            Text(config.subtitle)
                .font(.caption)
                .foregroundStyle(.secondary)

            if let note = config.chain.note {
                NoticeRow(
                    kind: .warning,
                    message: note + "；本批只搬了 /ad-upload 三件套（BLF-1068 的范围），"
                        + "该类型需另开子 issue 接入 /report-upload。"
                )
            } else {
                body(recognition: store.recognition(for: config.reportType))
            }

            if config.chain.isUsable {
                commitButton
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 10))
    }

    @ViewBuilder
    private func body(recognition: AdUploadRecognition?) -> some View {
        if let recognition {
            VStack(alignment: .leading, spacing: 4) {
                fact("当前文件", recognition.originalFilename)
                fact("识别类型", recognition.displayLabel)
                if let range = recognition.detectedRange {
                    fact("识别日期", "\(range.start) ~ \(range.end)")
                }
                fact("行数预览", recognition.rowCountPreview.map(String.init) ?? "未提供")
                if !recognition.warnings.isEmpty {
                    Text(recognition.warnings.joined(separator: "；"))
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                let state = store.state(for: config.reportType)
                fact("确认写入", "\(state.selectedProject) · \(dateText(state))")
                let blockers = store.blockers(for: config.reportType)
                if !blockers.isEmpty {
                    Text(blockers.map(\.message).joined(separator: "；"))
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }
        } else {
            Text("等待左侧上传区识别到该报表。")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
    }

    private func dateText(_ state: ProductAnalysisStore.CardState) -> String {
        if AdUploadReportTypes.requiresDateRange(config.reportType) {
            return "\(state.startDate) ~ \(state.endDate)"
        }
        return state.reportDate
    }

    private func fact(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 64, alignment: .leading)
            Text(value)
                .font(.caption)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private var commitButton: some View {
        HStack(spacing: 8) {
            if store.canCommit(config.reportType) {
                Button(action: onRequestCommit) {
                    Label("确认保存", systemImage: "checkmark.circle")
                }
                .help("先看确认摘要，再真正发请求（二次确认）")
            } else if store.canRecommit(config.reportType) {
                Button(action: onRequestCommit) {
                    Label("重新提交（新版本）", systemImage: "arrow.clockwise")
                }
                .help("该类型此前已提交过；确认后会产生新的临时文件与版本")
            } else if store.isCommitted(config.reportType) {
                Text("已提交（不入库：dry_run）")
                    .font(.caption)
                    .foregroundStyle(.green)
            }
        }
    }
}

/// 入库状态表（`GET /ad-upload/status`）。
struct AdUploadStatusTable: View {
    let store: ProductAnalysisStore
    /// 刷新按钮要重新发请求，故把数据源与任务作用域一起传进来（视图不自己造凭据）。
    let provider: ProductAnalysisDataProviding
    let scope: ModuleTaskScope
    let routeID: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text("广告报表入库状态")
                    .font(.callout.weight(.semibold))
                if let loadedAt = store.statusesLoadedAt {
                    Text("· \(AgentOpsFormatting.clockTime(loadedAt)) 拉取")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
                Spacer(minLength: 8)
                Button {
                    Task { await store.loadStatuses(using: provider, scope: scope, routeID: routeID) }
                } label: {
                    Label("刷新", systemImage: "arrow.clockwise")
                }
                .disabled(store.statusesPhase.isLoading)
            }
            if let failure = store.statusesRefreshFailure {
                NoticeRow(kind: .warning, message: "本次刷新失败，下表仍是上一次的数据：\(failure)")
            }
            switch store.statusTableState {
            case .loading:
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("正在加载入库状态…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            case .failed(let message):
                NoticeRow(kind: .failure, message: "入库状态加载失败：\(message)")
            case .empty:
                NoticeRow(
                    kind: .warning,
                    message: "当前站点（\(store.country)）下没有入库记录 —— 上传过一次就会出现在这里。"
                )
            case .ready:
                rows
            }
        }
    }

    private var rows: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                headerCell("项目", width: 150, alignment: .leading)
                headerCell("报表类型", width: 150, alignment: .leading)
                headerCell("日期", width: 190, alignment: .leading)
                headerCell("版本", width: 60, alignment: .trailing)
                headerCell("入库状态", width: 90, alignment: .leading)
                headerCell("文件", width: 220, alignment: .leading)
            }
            .background(.quaternary.opacity(0.5))
            ForEach(store.statuses) { item in
                HStack(spacing: 0) {
                    cell(item.projectName, width: 150, alignment: .leading)
                    cell(item.reportLabel, width: 150, alignment: .leading)
                    cell(item.dateText, width: 190, alignment: .leading)
                    cell("v\(item.version)\(item.isCurrent ? "" : "（非当前）")", width: 60, alignment: .trailing)
                    cell(item.ingestionStatus, width: 90, alignment: .leading)
                    cell(item.originalFilename ?? "—", width: 220, alignment: .leading)
                }
                .padding(.vertical, 3)
                Divider()
            }
        }
        .font(.caption)
        .textSelection(.enabled)
    }

    private func headerCell(
        _ text: String,
        width: CGFloat,
        alignment: Alignment
    ) -> some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .frame(width: width, alignment: alignment)
            .padding(.vertical, 4)
    }

    private func cell(_ text: String, width: CGFloat, alignment: Alignment) -> some View {
        Text(text)
            .lineLimit(1)
            .truncationMode(.middle)
            .frame(width: width, alignment: alignment)
            .help(text)
    }
}
