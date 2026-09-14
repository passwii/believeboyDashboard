import AppKit
import BelieveBoyKit
import SwiftUI

/// 「AI 智能 → 客服交流」页（Web `/dashboard/ai/customer-service`）。
///
/// 与 AI Chat **共用同一份底座**：`GET /ai/config`（1）→ `POST /ai/conversations`（3）→
/// `POST .../messages/stream`（9），外加停止生成（10）。输入区是「场景 + 语气 + 语言 + 篇幅」
/// 与引导字段，产出是一块可复制 / 可导出 `.md` 的正文。
///
/// 两端一致性的关键在两处**纯函数**上（都已落用例）：
/// `AIChatPresetCatalog.buildScenarioSystemPrompt`（system prompt）与
/// `buildUserContent`（把自由文本与引导字段拼成 `content`）—— Web 侧同一份逻辑在
/// `frontend/lib/server/ai-chat.ts` 与 `frontend/components/customer-service/build-prompt.ts`。
public struct CustomerServiceView: View {
    public static let routeID = AIChatCatalog.customerServiceRouteID

    private let model: AppModel
    private let navigation: NavigationStore

    public init(model: AppModel, navigation: NavigationStore) {
        self.model = model
        self.navigation = navigation
    }

    private var store: CustomerServiceStore { navigation.customerService }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            HStack(alignment: .top, spacing: 0) {
                inputColumn
                Divider()
                outputColumn
            }
        }
        .frame(minWidth: 720, minHeight: 480)
        .task { await reload() }
    }

    private var provider: AIChatDataProviding {
        model.aiChatProvider() ?? AIChatClient(client: APIClient(baseURL: model.effectiveBaseURL, apiKey: nil))
    }

    private func reload() async {
        guard model.aiChatProvider() != nil else {
            store.failWithoutCredential()
            return
        }
        await store.load(using: provider, scope: navigation.tasks, routeID: Self.routeID)
    }

    // MARK: - 页头

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Image(systemName: "bubble.left.and.bubble.right")
                    .font(.title3)
                    .foregroundStyle(.secondary)
                Text("客服交流")
                    .font(.title2.weight(.semibold))
                Text("生成")
                    .font(.caption.weight(.medium))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(.quaternary, in: Capsule())
                Spacer()
                Text("与 AI Chat 同一套底座 · 3 条端点")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }

            // 场景标签（Web `scenario-tabs.tsx`：置灰项显示「即将上线」）
            HStack(spacing: 6) {
                ForEach(store.scenarios) { scenario in
                    Button {
                        store.selectScenario(id: scenario.id)
                    } label: {
                        Text(scenario.isDisabled ? "\(scenario.label)（即将上线）" : scenario.label)
                            .font(.caption)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 4)
                            .background(
                                scenario.id == store.scenarioID
                                    ? Color.accentColor.opacity(0.18)
                                    : Color.clear,
                                in: Capsule()
                            )
                            .overlay(Capsule().stroke(Color.secondary.opacity(0.25), lineWidth: 0.5))
                    }
                    .buttonStyle(.plain)
                    .disabled(scenario.isDisabled)
                    .help(scenario.isDisabled ? "即将上线" : scenario.description)
                }
                Spacer()
            }

            if let scenario = store.scenario {
                Text("输出结构：\(scenario.outputFormat) · 模式：\(scenario.mode == .refine ? "润色" : "撰写")")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 18)
        .padding(.top, 14)
        .padding(.bottom, 10)
    }

    // MARK: - 左栏：输入

    private var inputColumn: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                if store.config != nil, !store.providerReady {
                    NoticeRow(
                        kind: .warning,
                        message: "后端未配置 LLM provider（`GET /ai/config` 的 `provider_configured = false`）——"
                            + "生成请求会失败。"
                    )
                }
                if case .failed(let message) = store.configPhase {
                    NoticeRow(kind: .failure, message: "AI 配置加载失败：\(message)")
                }

                if let scenario = store.scenario {
                    if scenario.showFreeTextArea {
                        fieldLabel("原始内容（粘贴草稿 / 数据 / 零散想法）")
                        TextEditor(
                            text: Binding(get: { store.freeText }, set: { store.setFreeText($0) })
                        )
                        .font(.body)
                        .frame(minHeight: 110)
                        .overlay(
                            RoundedRectangle(cornerRadius: 6)
                                .stroke(Color.secondary.opacity(0.3), lineWidth: 0.5)
                        )
                    }

                    ForEach(scenario.inputSchema) { field in
                        fieldLabel(field.label)
                        TextEditor(
                            text: Binding(
                                get: { store.guidedFields[field.key] ?? "" },
                                set: { store.setGuidedField(field.key, $0) }
                            )
                        )
                        .font(.callout)
                        .frame(minHeight: field.type == .text ? 44 : 62)
                        .overlay(
                            RoundedRectangle(cornerRadius: 6)
                                .stroke(Color.secondary.opacity(0.3), lineWidth: 0.5)
                        )
                    }

                    // 语气档（Web `tone-card` 的 tone 选择）
                    if !store.toneOptions.isEmpty {
                        fieldLabel("语气")
                        HStack(spacing: 6) {
                            ForEach(store.toneOptions) { tone in
                                Button {
                                    store.selectTone(id: store.toneID == tone.id ? nil : tone.id)
                                } label: {
                                    Text(tone.label)
                                        .font(.caption)
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 3)
                                        .background(
                                            store.toneID == tone.id
                                                ? Color.accentColor.opacity(0.18)
                                                : Color.clear,
                                            in: Capsule()
                                        )
                                        .overlay(Capsule().stroke(Color.secondary.opacity(0.25), lineWidth: 0.5))
                                }
                                .buttonStyle(.plain)
                                .help(tone.description)
                            }
                            Spacer()
                        }
                    }

                    HStack(spacing: 14) {
                        Picker(
                            "篇幅",
                            selection: Binding(
                                get: { store.length },
                                set: { store.setLength($0) }
                            )
                        ) {
                            ForEach(AIChatLength.allCases) { option in
                                Text("篇幅：\(option.label)").tag(option)
                            }
                        }
                        .labelsHidden()
                        .frame(maxWidth: 160)

                        if scenario.languageToggle {
                            Picker(
                                "语言",
                                selection: Binding(
                                    get: { store.language },
                                    set: { store.setLanguage($0) }
                                )
                            ) {
                                ForEach(AIChatLanguage.allCases) { option in
                                    Text("语言：\(option.label)").tag(option)
                                }
                            }
                            .labelsHidden()
                            .frame(maxWidth: 160)
                        }
                        Spacer()
                    }
                }

                promptPreview

                HStack(spacing: 10) {
                    Button {
                        Task {
                            await store.generate(
                                using: provider,
                                scope: navigation.tasks,
                                routeID: Self.routeID
                            )
                        }
                    } label: {
                        Label("生成", systemImage: "sparkles")
                    }
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(!store.canGenerate)

                    if store.canStop {
                        Button {
                            store.stop(
                                using: provider,
                                scope: navigation.tasks,
                                routeID: Self.routeID
                            )
                        } label: {
                            Label("停止", systemImage: "stop.circle")
                        }
                    }

                    Button("清空输入") { store.clearInputs() }
                        .disabled(store.isGenerating)

                    Spacer()
                }
            }
            .padding(14)
        }
        .frame(width: 420, alignment: .leading)
    }

    private func fieldLabel(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// 实际拼出的 system prompt / user content（可展开核对 —— 两端提示词不一致最难查）。
    private var promptPreview: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 6) {
                Text("system_prompt").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                Text(store.systemPromptPreview)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text("content").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                Text(store.userContentPreview)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.top, 4)
        } label: {
            Text("实际拼出的 prompt（与 Web 同源）")
                .font(.caption)
        }
    }

    // MARK: - 右栏：输出

    private var outputColumn: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if store.isGenerating {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text(store.isAwaitingFirstToken ? "正在生成…" : "生成中…")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                            Spacer()
                        }
                    }
                    if let error = store.error {
                        HStack(alignment: .top, spacing: 8) {
                            NoticeRow(kind: .failure, message: error)
                            if store.canResume {
                                Button {
                                    Task {
                                        await store.generate(
                                            using: provider,
                                            scope: navigation.tasks,
                                            routeID: Self.routeID,
                                            resume: true
                                        )
                                    }
                                } label: {
                                    Label("续传", systemImage: "arrow.clockwise.circle")
                                        .font(.caption)
                                }
                                .help("带 Last-Event-ID 与同一份 body 续传（口径 2）")
                            }
                            Button {
                                store.clearError()
                            } label: {
                                Image(systemName: "xmark.circle")
                            }
                            .buttonStyle(.plain)
                        }
                    }

                    if store.output.hasVisibleText || store.isGenerating {
                        if !store.output.thinking.isEmpty {
                            DisclosureGroup {
                                Text(store.output.thinking)
                                    .font(.callout.monospaced())
                                    .textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            } label: {
                                Text("思考过程（\(store.output.thinking.count) 字）")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        AIChatMarkdownView(content: store.outputText, streaming: store.isGenerating)
                        if let footer = AIChatFormatting.duration(store.output.done?.durationMs) {
                            Text("耗时 \(footer)")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    } else {
                        Text(store.outputPlaceholder)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    if !store.lastEventKinds.isEmpty {
                        Text("事件序列：\(store.lastEventKinds.joined(separator: " → "))")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .lineLimit(2)
                            .help("本次流经过的事件类型（同源同结构核对用）")
                    }
                }
                .padding(16)
            }
            Divider()
            HStack(spacing: 10) {
                Button {
                    copyOutput()
                } label: {
                    Label("复制", systemImage: "doc.on.doc")
                }
                .disabled(!store.output.hasVisibleText)

                Button {
                    saveMarkdown()
                } label: {
                    Label("导出 .md", systemImage: "square.and.arrow.down")
                }
                .disabled(!store.output.hasVisibleText)

                Button("清空输出") { store.clearOutput() }
                    .disabled(store.isGenerating)

                Spacer()
                if store.generationCount > 0 {
                    Text("第 \(store.generationCount) 次生成")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(12)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    // MARK: - 行为

    private func copyOutput() {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(store.markdownDocument, forType: .string)
    }

    /// 导出 `.md`（Web `tone-card.tsx` 的 `exportMd` 展开成一次保存面板）。
    private func saveMarkdown() {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "\(store.selectedTone?.label ?? store.scenario?.label ?? "客服交流").md"
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let url = panel.url else { return }
        try? store.markdownDocument.write(to: url, atomically: true, encoding: .utf8)
    }
}
