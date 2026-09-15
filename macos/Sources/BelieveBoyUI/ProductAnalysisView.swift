import AppKit
import BelieveBoyKit
import SwiftUI
import UniformTypeIdentifiers

/// 「报表中心 → 产品分析」（Web `/dashboard/reports/product-analysis`）。
///
/// 本批（BLF-1068）搬两条链路，都在这一页上：
///
/// 1. **识别 → 确认 → 提交**（`ad-upload` 三件套）—— 本计划的**第一条真实写链路**，
///    因此按 S6 的写操作口径实现：识别结果先逐条呈现，用户看过确认摘要才发 `commit`，
///    失败保留识别结果以便重试，`dry_run` 明确写在确认摘要里（不静默写入）。
/// 2. **产品分析核算**（`product-analysis-reports` 异步任务）—— 发起 → 轮询（退避 + 上限 +
///    可取消）→ 结果**流式落盘**。
///
/// 范围事实（写在页面上，不藏在实现里）：
/// - Web 同页的「业务报告 / 付款报告」走 `/report-upload`（A 表），本批的端点面只有
///   `/ad-upload`，故那两张卡片显式标成「本批未搬」而不是画三个点了没反应的按钮；
/// - `POST /product-analysis-reports` 要三类报表的 `file_id`，其中广告报告那份可以由
///   写链路的结果直接带入，业务 / 付款两份需从既有链路取得后填入表单。
public struct ProductAnalysisView: View {
    /// Web 路由 —— 模块路由表的命中键，也是模块任务作用域的 key。
    public static let routeID = ReportCatalog.productAnalysisRouteID

    private let model: AppModel
    private let navigation: NavigationStore

    public init(model: AppModel, navigation: NavigationStore) {
        self.model = model
        self.navigation = navigation
    }

    private var store: ProductAnalysisStore { navigation.productAnalysis }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 14) {
                    stateBanners
                    ProductParameterBar(store: store)
                    Divider()
                    tabPicker
                    switch store.selectedTab {
                    case .upload:
                        uploadTab
                    case .report:
                        reportTab
                    }
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(minWidth: 640, minHeight: 460)
        // 进页就取项目列表 + 入库状态；拖入/选中的文件走同一条 `.task` 触发链
        // （视图不自己发请求 —— 它拿不到 provider）。
        .task { await reload() }
        .task(id: store.droppedFiles) { await recognizeDroppedFiles() }
        .alert(
            store.pendingConfirmation.map { "确认写入：\($0.title)" } ?? "确认",
            isPresented: confirmationBinding,
            presenting: store.pendingConfirmation
        ) { _ in
            Button("取消", role: .cancel) { store.cancelPendingCommit() }
            Button("确认提交") {
                Task {
                    await store.confirmPendingCommit(
                        using: provider,
                        scope: navigation.tasks,
                        routeID: Self.routeID
                    )
                }
            }
        } message: { confirmation in
            Text(confirmation.summary.joined(separator: "\n"))
        }
    }

    // MARK: - 装配

    private var provider: ProductAnalysisDataProviding {
        model.productAnalysisProvider()
            ?? ProductAnalysisClient(client: APIClient(baseURL: model.effectiveBaseURL, apiKey: nil))
    }

    private var confirmationBinding: Binding<Bool> {
        Binding(
            get: { store.pendingConfirmation != nil },
            set: { if !$0 { store.cancelPendingCommit() } }
        )
    }

    // MARK: - 页头

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "function")
                .font(.title3)
                .foregroundStyle(.secondary)
            Text("产品分析")
                .font(.title2.weight(.semibold))
            Text("含写链路")
                .font(.caption.weight(.medium))
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(.quaternary, in: Capsule())
            Spacer()
            Text("ad-upload 三件套 + 产品分析核算异步任务")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 20)
        .padding(.top, 16)
        .padding(.bottom, 10)
    }

    private var tabPicker: some View {
        Picker("视图", selection: tabSelection) {
            ForEach(ProductAnalysisStore.Tab.allCases) { tab in
                Label(tab.title, systemImage: tab.symbol).tag(tab)
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .frame(maxWidth: 420)
    }

    private var tabSelection: Binding<ProductAnalysisStore.Tab> {
        Binding(
            get: { store.selectedTab },
            set: { store.selectTab($0) }
        )
    }

    // MARK: - 状态提示

    @ViewBuilder
    private var stateBanners: some View {
        switch store.projectGate {
        case .failed(let message):
            VStack(alignment: .leading, spacing: 8) {
                NoticeRow(kind: .failure, message: "项目列表加载失败：\(message)")
                Button {
                    Task { await reload() }
                } label: {
                    Label("重试", systemImage: "arrow.clockwise")
                }
            }
        case .noProjects:
            NoticeRow(
                kind: .warning,
                message: "当前账号在这个后端上没有可见项目（`/projects/manage` 返回空列表）——"
                    + "识别后的项目匹配与入库都要求项目，没有项目就没有可写对象。"
            )
        case .pending, .ready:
            EmptyView()
        }
    }

    // MARK: - Tab 1：识别与提交（写链路）

    private var uploadTab: some View {
        VStack(alignment: .leading, spacing: 14) {
            uploadPanel
            cardsPanel()
            AdUploadStatusTable(
                store: store,
                provider: provider,
                scope: navigation.tasks,
                routeID: Self.routeID
            )
            .padding(14)
            .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 10))
        }
    }

    private var uploadPanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Button {
                    pickFiles()
                } label: {
                    Label("选择文件…", systemImage: "tray.and.arrow.down")
                }
                .disabled(store.isRecognizing)
                Text("支持 .xlsx / .csv（广告报表）；也可以把文件拖到这里")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 8)
                if store.isRecognizing {
                    ProgressView().controlSize(.small)
                }
                if !store.items.isEmpty {
                    Button("清空列表") { store.clearItems() }
                }
            }
            dropTarget
            if store.items.isEmpty {
                NoticeRow(
                    kind: .warning,
                    message: "还没有识别结果。识别只把文件存成后端临时文件并回读判据，**不会**写业务表；"
                        + "写动作只发生在你点「确认保存」并在确认摘要里点「确认提交」之后。"
                )
            } else {
                ForEach(store.items) { item in
                    UploadItemRow(
                        item: item,
                        projects: store.projects.map(\.name),
                        onSelectProject: { name in
                            // 手动纠正识别出的项目：只改这次确认要写的项目名，不重跑识别。
                            if let reportType = item.recognition.response?.reportType {
                                store.setCardProject(reportType, name)
                            }
                        },
                        onRemove: { store.removeItem(id: item.id) }
                    )
                }
            }
        }
        .padding(14)
        .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 10))
    }

    private var dropTarget: some View {
        RoundedRectangle(cornerRadius: 8)
            .strokeBorder(
                store.isDropTargeted ? Color.accentColor : Color.secondary.opacity(0.4),
                style: StrokeStyle(lineWidth: 1, dash: [5, 4])
            )
            .frame(height: 44)
            .overlay(
                Text(store.isDropTargeted ? "松开即识别" : "拖入报表文件")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            )
            .onDrop(of: [.fileURL], isTargeted: dropTargetBinding) { providers in
                loadDroppedURLs(providers)
            }
    }

    private var dropTargetBinding: Binding<Bool> {
        Binding(
            get: { store.isDropTargeted },
            set: { store.setDropTargeted($0) }
        )
    }

    private func cardsPanel() -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("三类报表：识别结果 → 确认 → 提交")
                .font(.callout.weight(.semibold))
            HStack(alignment: .top, spacing: 12) {
                ForEach(ProductAnalysisStore.cardConfigs) { config in
                    ReportUploadCard(config: config, store: store) {
                        store.requestCommit(reportType: config.reportType)
                    }
                }
            }
        }
        .padding(14)
        .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 10))
    }

    /// 从拖入的 `NSItemProvider` 里取 `file://` URL。
    ///
    /// `loadObject(ofClass:)` 的回调在后台线程，故结果先收进队列，回到主 actor 再交给 store
    /// （store 是 `@MainActor`，跨域直接写会编不过）。
    private func loadDroppedURLs(_ providers: [NSItemProvider]) -> Bool {
        let group = DispatchGroup()
        let box = LockedURLBox()
        for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            group.enter()
            _ = provider.loadObject(ofClass: URL.self) { url, _ in
                if let url { box.append(url) }
                group.leave()
            }
        }
        guard group.wait(timeout: .now() + 2) == .success else { return false }
        let urls = box.values
        guard !urls.isEmpty else { return false }
        store.enqueueFiles(urls)
        return true
    }

    private func pickFiles() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.allowedContentTypes = []
        panel.message = "选择要识别的报表文件（广告报表：.xlsx / .csv）"
        guard panel.runModal() == .OK else { return }
        store.enqueueFiles(panel.urls)
    }

    // MARK: - Tab 2：产品分析核算（异步任务）

    private var reportTab: some View {
        VStack(alignment: .leading, spacing: 14) {
            reportFormPanel
            reportTaskPanel
        }
    }

    private var reportFormPanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("报表来源（file_id）")
                .font(.callout.weight(.semibold))
            Text(
                "`POST /product-analysis-reports` 需要业务 / 付款 / 广告三份报表的 `file_id`。"
                    + "广告报告那一份可以直接从上面的识别结果带入（提交成功后才有 `file_id`）；"
                    + "业务与付款报告在 Web 侧走 `/report-upload`（A 表）链路，本批未搬，需手工填入。"
            )
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)

            fileIDField(.businessReport, "业务报告 file_id", placeholder: "如 3f2c…_business.csv")
            fileIDField(.paymentReport, "付款报告 file_id", placeholder: "如 3f2c…_payment.csv")
            HStack(spacing: 8) {
                fileIDField(.adReport, "广告报告 file_id", placeholder: "可点右侧「带入」")
                Button {
                    store.adoptCommittedFileID(from: ProductAnalysisStore.writableCard.reportType)
                } label: {
                    Label("带入广告报告", systemImage: "arrow.down.doc")
                }
                .disabled(store.recognition(for: ProductAnalysisStore.writableCard.reportType) == nil)
                .help("把广告报告一次成功提交得到的 file_id 填进来")
            }
            fileIDField(.inventoryReport, "库存报告 file_id（可选）", placeholder: "留空 = 不传")

            let blockers = store.reportFormBlockers
            if !blockers.isEmpty {
                Text(blockers.map(\.message).joined(separator: "；"))
                    .font(.caption)
                    .foregroundStyle(.orange)
            }

            HStack(spacing: 10) {
                Button {
                    Task {
                        await store.submitReport(
                            using: provider,
                            scope: navigation.tasks,
                            routeID: Self.routeID
                        )
                    }
                } label: {
                    Label("发起核算", systemImage: "play.circle")
                }
                .disabled(!store.canSubmitReport || store.reportPhase.isBusy)

                if store.reportPhase.isBusy {
                    Button("取消等待") {
                        store.cancelReport(scope: navigation.tasks, routeID: Self.routeID)
                    }
                    .help("停止本地轮询；后端任务不会被取消（该端点没有 cancel）")
                }
                if store.reportPhase.isBusy {
                    ProgressView().controlSize(.small)
                }
            }
        }
        .padding(14)
        .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 10))
    }

    private func fileIDField(
        _ field: ProductAnalysisStore.ReportFormField,
        _ label: String,
        placeholder: String
    ) -> some View {
        LabeledField(label) {
            TextField(placeholder, text: formBinding(field))
                .textFieldStyle(.roundedBorder)
                .font(.system(.caption, design: .monospaced))
        }
    }

    private func formBinding(_ field: ProductAnalysisStore.ReportFormField) -> Binding<String> {
        Binding(
            get: {
                switch field {
                case .businessReport: return store.form.businessReportFileID
                case .paymentReport: return store.form.paymentReportFileID
                case .adReport: return store.form.adReportFileID
                case .inventoryReport: return store.form.inventoryReportFileID
                }
            },
            set: { store.setFormFileID(field, $0) }
        )
    }

    @ViewBuilder
    private var reportTaskPanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("核算任务")
                .font(.callout.weight(.semibold))

            switch store.reportPhase {
            case .idle:
                Text("尚未发起核算。发起后会轮询任务状态（退避 + 上限），完成后可下载结果文件。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            case .submitting:
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("正在提交核算请求…")
                        .font(.caption)
                }
            case .running:
                runningPanel
            case .succeeded:
                NoticeRow(kind: .success, message: "核算完成：\(store.reportTask?.summaryText ?? "")")
                resultPanel
            case .failed(let message):
                NoticeRow(kind: .failure, message: message)
            }

            if let ticket = store.reportTicket {
                Text("任务号 \(ticket.jobID) · 状态端点 \(ticket.resolvedStatusPath)")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .textSelection(.enabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 10))
    }

    private var runningPanel: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                ProgressView(value: store.reportTask?.progressFraction ?? 0)
                    .frame(maxWidth: 260)
                Text("\(store.reportTask?.progress ?? 0)%")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            Text(store.reportTask?.summaryText ?? "任务已提交，等待后端返回状态…")
                .font(.caption)
                .foregroundStyle(.secondary)
            if let persistence = store.reportTask?.persistenceMessage?.trimmedNonEmpty {
                Text("落库：\(persistence)")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
    }

    @ViewBuilder
    private var resultPanel: some View {
        HStack(spacing: 10) {
            Button {
                Task {
                    await store.downloadResult(
                        using: provider,
                        scope: navigation.tasks,
                        routeID: Self.routeID
                    )
                }
            } label: {
                Label("下载结果（.xlsx）", systemImage: "square.and.arrow.down")
            }
            .disabled(store.downloadPhase.isDownloading)

            switch store.downloadPhase {
            case .idle:
                EmptyView()
            case .downloading(let fraction):
                if let fraction {
                    ProgressView(value: fraction).frame(maxWidth: 160)
                } else {
                    ProgressView().controlSize(.small)
                }
            case .finished(let url):
                Text("已落盘：\(url.path)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .lineLimit(1)
                    .truncationMode(.middle)
            case .failed(let message):
                Text("下载失败：\(message)")
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
    }

    // MARK: - 加载

    private func reload() async {
        guard model.productAnalysisProvider() != nil else {
            store.failWithoutCredential()
            return
        }
        await store.load(
            using: provider,
            scope: navigation.tasks,
            routeID: Self.routeID
        )
    }

    private func recognizeDroppedFiles() async {
        let files = store.consumeDroppedFiles()
        guard !files.isEmpty, model.productAnalysisProvider() != nil else { return }
        await store.recognizeFiles(
            files,
            using: provider,
            scope: navigation.tasks,
            routeID: Self.routeID
        )
    }
}

/// 拖拽回调里收集 URL 的线程安全盒子（`loadObject` 的回调不在主线程）。
final class LockedURLBox: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [URL] = []

    var values: [URL] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }

    func append(_ url: URL) {
        lock.lock()
        storage.append(url)
        lock.unlock()
    }
}

extension AppModel {
    /// 产品分析 / 报表自动化的数据源：用当前会话（key + 账号上下文）构造；未登录返回 nil。
    ///
    /// 与 S5.1~S5.4 同样复用 `AppModel` 的 `URLSession` —— 单测用打桩 session 跑通链路时，
    /// 模块请求必须走同一个 session，否则「离屏渲染模块」的用例会静默打真实网络。
    func productAnalysisProvider() -> ProductAnalysisDataProviding? {
        guard let client = makeAPIClient() else { return nil }
        return ProductAnalysisClient(client: client)
    }

    /// 报表自动化状态页的数据源。
    func reportAutomationProvider() -> ReportAutomationDataProviding? {
        guard let client = makeAPIClient() else { return nil }
        return ReportAutomationClient(client: client)
    }
}
