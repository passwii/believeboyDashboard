import AppKit
import BelieveBoyKit
import SwiftUI

/// 「AI 智能 → AI Chat」页（Web `/dashboard/ai/chat`）。
///
/// 12 条端点里的 10 条在这页上跑（`AIChatCatalog` 的 1~10 与 12；11 在输入区附件按钮上）：
/// 会话列表 / 新建 / 重命名 / 删除 / 消息历史 / 编辑消息 / 删除消息 / 发送（POST-SSE）/
/// 停止生成 / 配置 / 用量。
///
/// 视图不使用属性包装器宏（工具链约束，见 `Package.swift` 顶部）：需要双向绑定的地方走显式
/// `Binding`；「正在进行中的就地编辑」这类瞬时状态住在 store 里（`renameTargetID` /
/// `editTargetID`）—— 住视图里切一次模块就丢。
public struct AIChatView: View {
    /// Web 路由 —— 模块路由表的命中键，也是模块任务作用域的根 key。
    public static let routeID = AIChatCatalog.chatRouteID

    private let model: AppModel
    private let navigation: NavigationStore

    public init(model: AppModel, navigation: NavigationStore) {
        self.model = model
        self.navigation = navigation
    }

    private var store: AIChatStore { navigation.aiChat }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            HStack(alignment: .top, spacing: 0) {
                conversationColumn
                Divider()
                messageColumn
            }
        }
        .frame(minWidth: 720, minHeight: 480)
        .task { await reload() }
        .alert(
            store.pendingConfirmation?.title ?? "确认",
            isPresented: confirmationBinding,
            presenting: store.pendingConfirmation
        ) { _ in
            Button("取消", role: .cancel) { store.dismissConfirmation() }
            Button("删除", role: .destructive) {
                Task { await store.confirmPending(using: provider, scope: navigation.tasks, routeID: Self.routeID) }
            }
        } message: { confirmation in
            Text(confirmation.message)
        }
    }

    // MARK: - 装配

    private var provider: AIChatDataProviding {
        model.aiChatProvider() ?? AIChatClient(client: APIClient(baseURL: model.effectiveBaseURL, apiKey: nil))
    }

    private var identity: AIChatIdentity {
        guard let userID = model.currentUser?.id.trimmedNonEmpty else { return .undeclared }
        return .declared(userID: userID)
    }

    private var confirmationBinding: Binding<Bool> {
        Binding(
            get: { store.pendingConfirmation != nil },
            set: { if !$0 { store.dismissConfirmation() } }
        )
    }

    private func reload() async {
        guard model.aiChatProvider() != nil else {
            store.failWithoutCredential()
            return
        }
        await store.load(
            using: provider,
            scope: navigation.tasks,
            routeID: Self.routeID,
            identity: identity
        )
    }

    // MARK: - 页头

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Image(systemName: "sparkles")
                    .font(.title3)
                    .foregroundStyle(.secondary)
                Text("AI Chat")
                    .font(.title2.weight(.semibold))
                Text("会话")
                    .font(.caption.weight(.medium))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(.quaternary, in: Capsule())
                Spacer()
                Text("12 条端点 · POST-SSE 流式")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            if let config = store.config {
                HStack(spacing: 10) {
                    Label("模型 \(store.composer.model ?? config.defaultModel)", systemImage: "cpu")
                        .font(.caption)
                    Label(
                        config.providerConfigured ? "provider 已配置" : "provider 未配置",
                        systemImage: config.providerConfigured ? "checkmark.seal" : "exclamationmark.triangle"
                    )
                    .font(.caption)
                    .foregroundStyle(config.providerConfigured ? Color.secondary : Color.orange)
                    Label(
                        config.webSearchConfigured ? "联网搜索可用" : "联网搜索未配置",
                        systemImage: "globe"
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    Spacer()
                }
            }
        }
        .padding(.horizontal, 18)
        .padding(.top, 14)
        .padding(.bottom, 10)
    }

    // MARK: - 左栏：会话列表

    private var conversationColumn: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text("会话")
                    .font(.callout.weight(.semibold))
                Spacer(minLength: 0)
                Button {
                    Task {
                        await store.createConversation(
                            using: provider,
                            scope: navigation.tasks,
                            routeID: Self.routeID
                        )
                    }
                } label: {
                    Label("新对话", systemImage: "square.and.pencil")
                        .font(.caption)
                }
                .buttonStyle(.plain)
                .disabled(!store.providerReady && store.config != nil)
                .help("新建一个会话（POST /ai/conversations）")
            }

            inboxBody

            if let failure = store.conversationsRefreshFailure {
                NoticeRow(kind: .warning, message: "会话列表刷新失败，下面是上一次的列表：\(failure)")
            }
        }
        .padding(12)
        .frame(width: 268, alignment: .leading)
    }

    @ViewBuilder
    private var inboxBody: some View {
        switch store.inboxState {
        case .pending:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("加载中…").font(.caption).foregroundStyle(.secondary)
            }
            .padding(.vertical, 12)
            Spacer()

        case .failed(let message):
            VStack(alignment: .leading, spacing: 8) {
                NoticeRow(kind: .failure, message: message)
                Button {
                    Task { await reload() }
                } label: {
                    Label("重试", systemImage: "arrow.clockwise")
                }
            }
            Spacer()

        case .undeclaredAccount:
            // 口径 3：缺 X-User-Id 时后端静默返回空表 —— 与「真的没有会话」必须区分。
            VStack(alignment: .leading, spacing: 8) {
                NoticeRow(
                    kind: .warning,
                    message: "未声明账号：这次请求没有携带 `X-User-Id`，后端因此按「无归属」过滤、"
                        + "静默返回空表。重新登录后才会看到本账号的会话。"
                )
                Text("这与「账号下确实没有会话」是两回事 —— 后者会显示成正常空态。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()

        case .noConversations:
            VStack(alignment: .leading, spacing: 4) {
                Text("暂无会话")
                    .font(.callout.weight(.medium))
                Text("按「新对话」开始，或在下方输入内容后发送（会自动使用当前会话）。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.vertical, 10)
            Spacer()

        case .ready:
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(store.conversations) { conversation in
                        conversationRow(conversation)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func conversationRow(_ conversation: AIChatConversation) -> some View {
        let isSelected = conversation.id == store.selectedConversationID
        VStack(alignment: .leading, spacing: 3) {
            if store.renameTargetID == conversation.id {
                HStack(spacing: 6) {
                    TextField(
                        "会话标题",
                        text: Binding(get: { store.renameDraft }, set: { store.setRenameDraft($0) })
                    )
                    .textFieldStyle(.roundedBorder)
                    .onSubmit {
                        Task {
                            await store.renameConversation(
                                id: conversation.id,
                                title: store.renameDraft,
                                using: provider,
                                scope: navigation.tasks,
                                routeID: Self.routeID
                            )
                            store.cancelRename()
                        }
                    }
                    Button("取消") { store.cancelRename() }
                        .font(.caption)
                }
            } else {
                Button {
                    Task {
                        await store.selectConversation(
                            id: conversation.id,
                            using: provider,
                            scope: navigation.tasks,
                            routeID: Self.routeID
                        )
                    }
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(conversation.title)
                            .font(.callout)
                            .lineLimit(1)
                        Text(AIChatFormatting.conversationSubtitle(conversation))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.plain)

                HStack(spacing: 6) {
                    Button {
                        store.beginRename(id: conversation.id, current: conversation.title)
                    } label: {
                        Text("重命名").font(.caption2)
                    }
                    .buttonStyle(.plain)
                    .help("PATCH /ai/conversations/\(conversation.id)")

                    Button {
                        store.requestDelete(conversation: conversation)
                    } label: {
                        Text("删除").font(.caption2).foregroundStyle(.red)
                    }
                    .buttonStyle(.plain)
                    .help("DELETE /ai/conversations/\(conversation.id)（二次确认）")
                    Spacer(minLength: 0)
                }
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            isSelected ? Color.accentColor.opacity(0.14) : Color.secondary.opacity(0.05),
            in: RoundedRectangle(cornerRadius: 8)
        )
    }

    // MARK: - 右栏：消息 + 输入

    private var messageColumn: some View {
        VStack(alignment: .leading, spacing: 0) {
            messageArea
            Divider()
            composerArea
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    @ViewBuilder
    private var messageArea: some View {
        switch store.messageAreaState {
        case .noConversation:
            VStack(alignment: .leading, spacing: 6) {
                Text("未选中会话").font(.headline)
                Text("在左侧选择一个会话，或按「新对话」新建一个。")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .padding(18)

        case .loading:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("加载消息…").font(.callout).foregroundStyle(.secondary)
            }
            .padding(18)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)

        case .failed(let message):
            VStack(alignment: .leading, spacing: 8) {
                NoticeRow(kind: .failure, message: "消息历史加载失败：\(message)")
                Button {
                    Task {
                        await store.retryMessages(
                            using: provider,
                            scope: navigation.tasks,
                            routeID: Self.routeID
                        )
                    }
                } label: {
                    Label("重试", systemImage: "arrow.clockwise")
                }
            }
            .padding(18)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)

        case .empty:
            VStack(alignment: .leading, spacing: 6) {
                Text("这个会话还没有消息").font(.headline)
                Text("在下面输入框写点什么，或先勾选联网搜索。")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            .padding(18)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)

        case .ready:
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(store.messages) { message in
                            VStack(alignment: .leading, spacing: 4) {
                                if store.editTargetID == message.id {
                                    editRow(message)
                                } else {
                                    AIChatMessageRow(
                                        message: message,
                                        onCopy: { copy(message.content) },
                                        onEdit: message.isUser
                                            ? { store.beginEdit(id: message.id, current: message.content) }
                                            : nil,
                                        onDelete: { store.requestDelete(message: message) }
                                    )
                                }
                            }
                            .id(message.id)
                        }

                        if store.isStreaming {
                            AIChatDraftRow(
                                draft: store.draft,
                                isAwaitingFirstToken: store.isAwaitingFirstToken,
                                canStop: !store.isStopping,
                                onStop: {
                                    store.stopGeneration(
                                        using: provider,
                                        scope: navigation.tasks,
                                        routeID: Self.routeID
                                    )
                                }
                            )
                            .id("draft")
                        }

                        if let failure = store.messagesRefreshFailure {
                            NoticeRow(kind: .warning, message: failure)
                        }
                    }
                    .padding(16)
                }
                .onChange(of: store.messages.count) { _, _ in
                    if let last = store.messages.last?.id { proxy.scrollTo(last, anchor: .bottom) }
                }
                .onChange(of: store.isStreaming) { _, streaming in
                    if streaming { proxy.scrollTo("draft", anchor: .bottom) }
                }
            }
        }
    }

    @ViewBuilder
    private func editRow(_ message: AIChatMessage) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("编辑用户消息 · PATCH /ai/conversations/\(message.conversationId)/messages/\(message.id)")
                .font(.caption2)
                .foregroundStyle(.secondary)
            TextEditor(
                text: Binding(get: { store.editDraft }, set: { store.setEditDraft($0) })
            )
            .font(.body)
            .frame(minHeight: 72)
            .overlay(
                RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.3), lineWidth: 0.5)
            )
            HStack(spacing: 8) {
                Button("保存") {
                    Task {
                        await store.editMessage(
                            id: message.id,
                            content: store.editDraft,
                            using: provider,
                            scope: navigation.tasks,
                            routeID: Self.routeID
                        )
                        store.cancelEdit()
                    }
                }
                Button("取消") { store.cancelEdit() }
                Spacer()
            }
        }
        .padding(10)
        .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - 输入区

    private var composerArea: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let warning = store.composer.lengthWarning {
                NoticeRow(kind: .warning, message: warning)
            }
            if store.config != nil, !store.providerReady {
                NoticeRow(
                    kind: .warning,
                    message: "后端未配置 LLM provider（`GET /ai/config` 的 `provider_configured = false`）——"
                        + "发出去的对话请求会失败，配置好之前不建议发。"
                )
            }
            if let failure = store.streamError {
                HStack(alignment: .top, spacing: 8) {
                    NoticeRow(kind: .failure, message: failure)
                    if store.canResume {
                        Button {
                            Task {
                                await store.resume(
                                    using: provider,
                                    scope: navigation.tasks,
                                    routeID: Self.routeID
                                )
                            }
                        } label: {
                            Label("续传", systemImage: "arrow.clockwise.circle")
                                .font(.caption)
                        }
                        .help("带 Last-Event-ID 与同一份 body 重发这个 POST（从断点继续，不重放）")
                    }
                    Button {
                        store.clearStreamError()
                    } label: {
                        Image(systemName: "xmark.circle")
                    }
                    .buttonStyle(.plain)
                }
            }

            attachmentRow

            TextEditor(
                text: Binding(get: { store.composer.text }, set: { store.setText($0) })
            )
            .font(.body)
            .frame(minHeight: 68)
            .overlay(
                RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.3), lineWidth: 0.5)
            )
            .onKeyPress { press in
                // ⌘↩ 发送；单独 ↩ 换行（与 Web 输入框同口径）。
                guard press.modifiers.contains(.command) else { return .ignored }
                sendAction()
                return .handled
            }

            composerControls
        }
        .padding(14)
    }

    @ViewBuilder
    private var attachmentRow: some View {
        switch store.composer.attachment {
        case .none:
            EmptyView()
        case .parsing(let filename):
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("正在解析 \(filename)…").font(.caption)
                Spacer()
            }
        case .parsed(let filename, let content, let truncated, let note):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "paperclip").font(.caption)
                Text("附件 \(filename) · 解析出 \(content.count) 字")
                    .font(.caption)
                    .lineLimit(1)
                if truncated {
                    Text(note ?? "内容被截断")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                        .lineLimit(1)
                }
                if store.composer.attachment.exceedsPayloadLimit() {
                    Text("超过 \(AIChatCatalog.maxAttachedFileContentLength) 字上限，发送会被 422 拒")
                        .font(.caption2)
                        .foregroundStyle(.red)
                }
                Spacer()
                Button {
                    store.clearAttachment()
                } label: {
                    Image(systemName: "xmark.circle")
                }
                .buttonStyle(.plain)
            }
        case .failed(let filename, let message):
            HStack(spacing: 8) {
                NoticeRow(kind: .failure, message: "附件 \(filename) 解析失败：\(message)")
                Button("移除") { store.clearAttachment() }
                    .font(.caption)
            }
        }
    }

    private var composerControls: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                // 模型：默认项 + 后端给的可用模型（分组标签照后端的三组，不自己重新分组）
                Picker(
                    "模型",
                    selection: Binding(
                        get: { store.composer.model ?? "__default__" },
                        set: { store.setModel($0 == "__default__" ? nil : $0) }
                    )
                ) {
                    Text("默认（\(store.config?.defaultModel ?? "未取到")）").tag("__default__")
                    ForEach(store.modelOptions, id: \.self) { option in
                        Text(modelLabel(option)).tag(option)
                    }
                }
                .labelsHidden()
                .frame(maxWidth: 260)
                .disabled(store.modelOptions.isEmpty)

                Picker(
                    "推理",
                    selection: Binding(
                        get: { store.composer.reasoningEffort ?? "__auto__" },
                        set: { store.setReasoningEffort($0 == "__auto__" ? nil : $0) }
                    )
                ) {
                    Text("推理：默认（\(store.config?.defaultReasoningEffort ?? "medium")）").tag("__auto__")
                    ForEach(AIChatCatalog.reasoningEfforts, id: \.self) { effort in
                        Text("推理：\(AIChatCatalog.reasoningEffortLabel(effort))").tag(effort)
                    }
                }
                .labelsHidden()
                .frame(maxWidth: 180)

                Toggle(
                    "联网搜索",
                    isOn: Binding(
                        get: { store.composer.webSearchEnabled },
                        set: { store.setWebSearchEnabled($0) }
                    )
                )
                .toggleStyle(.checkbox)
                .disabled(!(store.config?.webSearchConfigured ?? false))
                .help(
                    store.config?.webSearchConfigured == false
                        ? "后端 `web_search_configured = false`，联网搜索不可用"
                        : "启用后后端会调用搜索工具（并且「重新生成」才可用）"
                )

                Spacer(minLength: 0)

                Button {
                    attachFile()
                } label: {
                    Label("附件", systemImage: "paperclip")
                }
                .disabled(store.composer.attachment.isParsing)
                .help("POST /ai/upload（multipart）解析附件文本")

                Button {
                    sendAction()
                } label: {
                    Label("发送", systemImage: "paperplane.fill")
                }
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(!store.canSend)
                .help("⌘↩ 发送（POST .../messages/stream）")
            }

            promptPresetRow
        }
    }

    private var promptPresetRow: some View {
        HStack(spacing: 10) {
            Text("结构化 prompt")
                .font(.caption)
                .foregroundStyle(.secondary)
            Picker(
                "摘要",
                selection: Binding(
                    get: { store.composer.overviewPromptID ?? "none" },
                    set: { store.setOverviewPromptID($0 == "none" ? nil : $0) }
                )
            ) {
                Text("摘要：不注入").tag("none")
                ForEach(AIChatPresetCatalog.overviewOptions) { option in
                    Text("摘要：\(option.label)").tag(option.id)
                }
            }
            .labelsHidden()
            .frame(maxWidth: 200)

            Picker(
                "展开",
                selection: Binding(
                    get: { store.composer.detailPromptID ?? "none" },
                    set: { store.setDetailPromptID($0 == "none" ? nil : $0) }
                )
            ) {
                Text("展开：不注入").tag("none")
                ForEach(AIChatPresetCatalog.detailOptions) { option in
                    Text("展开：\(option.label)").tag(option.id)
                }
            }
            .labelsHidden()
            .frame(maxWidth: 200)

            Spacer(minLength: 0)

            if !store.lastEventKinds.isEmpty {
                Text("事件序列：\(store.lastEventKinds.joined(separator: " → "))")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.head)
                    .help("本次流经过的事件类型（同源同结构核对用）")
            }
        }
    }

    // MARK: - 行为

    private func modelLabel(_ name: String) -> String {
        let config = store.config
        let premium = config?.premiumModels.contains { $0.caseInsensitiveCompare(name) == .orderedSame } ?? false
        let reasoning = config?.reasoningModels.contains { $0.caseInsensitiveCompare(name) == .orderedSame } ?? false
        var tags: [String] = []
        if premium { tags.append("高级") }
        if reasoning { tags.append("推理") }
        return tags.isEmpty ? name : "\(name)（\(tags.joined(separator: "/"))）"
    }

    private func sendAction() {
        guard store.canSend else { return }
        Task {
            await store.send(using: provider, scope: navigation.tasks, routeID: Self.routeID)
        }
    }

    private func copy(_ text: String) {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
    }

    /// 附件选择：`NSOpenPanel`。只把**路径**交给上传端点（multipart 走磁盘流，不整份进内存）。
    private func attachFile() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.allowedContentTypes = []
        panel.message = "选择要交给 AI 解析的附件（CSV / Excel / 图片 / PDF / TXT）"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let filename = url.lastPathComponent
        Task {
            await store.attach(
                fileURL: url,
                filename: filename,
                mimeType: AIChatView.mimeType(for: url),
                using: provider,
                scope: navigation.tasks,
                routeID: Self.routeID
            )
        }
    }

    /// 按扩展名给出 MIME（后端 `ai_file_upload_service` 的 allowlist 同一组后缀）。
    static func mimeType(for url: URL) -> String {
        switch url.pathExtension.lowercased() {
        case "csv": return "text/csv"
        case "xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        case "xls": return "application/vnd.ms-excel"
        case "jpg", "jpeg": return "image/jpeg"
        case "png": return "image/png"
        case "pdf": return "application/pdf"
        case "txt": return "text/plain"
        default: return "application/octet-stream"
        }
    }
}

extension AppModel {
    /// AI 会话片的数据源：用当前会话（key + 账号上下文，含 `X-User-Id`）构造；未登录返回 nil。
    ///
    /// 复用 `AppModel` 的 `URLSession` 是刻意的 —— 单测用打桩 session 跑通链路时，模块请求
    /// 必须走同一个 session，否则「离屏渲染模块」的用例会静默打真实网络。
    func aiChatProvider() -> AIChatDataProviding? {
        guard let client = makeAPIClient() else { return nil }
        return AIChatClient(client: client)
    }
}
