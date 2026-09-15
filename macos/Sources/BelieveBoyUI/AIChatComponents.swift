import AppKit
import BelieveBoyKit
import SwiftUI

// 「AI 会话片」两页共用的渲染件：Markdown 正文、消息行、会话行、搜索来源、用量面板。
//
// 视图层不使用属性包装器宏（`@State` / `@Bindable` / `@Environment`）—— 工具链约束，
// 见 Package.swift 顶部。需要双向绑定的地方一律走显式 `Binding`。

// MARK: - Markdown 正文

/// 一段 Markdown 正文（块级解析复用 S5.3 的 `InsightMarkdown`，见 `AIChatMarkdown`）。
///
/// 呈现口径与 Web 的会话正文（`components/ai-chat-message-content.tsx`）对齐：
/// 标题 / 段落 / 列表 / 引用 / 表格 / 分隔线 / 代码块；`` ```chart `` 围栏在会话页
/// **按普通代码块**呈现（Web 会话页没有图表渲染器，与洞察页的降级块是两回事）。
/// 行内标记交给 `AttributedString(markdown:)`（系统自带、行为确定）。
struct AIChatMarkdownView: View {
    let content: String
    /// 流式草稿：`stable` 走解析，`tail` 以纯文本呈现（未闭合围栏不参与解析）。
    let streaming: Bool

    var body: some View {
        let blocks = AIChatMarkdown.blocks(streaming ? AIChatMarkdown.splitDraft(content).stable : content)
        let tail = streaming ? AIChatMarkdown.splitDraft(content).tail : ""

        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                AIChatMarkdownBlockView(block: block)
            }
            if !tail.isEmpty {
                // 未闭合围栏 / 半行：纯文本，等它闭合后再交给解析器。
                Text(tail)
                    .font(.body.monospaced())
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

private struct AIChatMarkdownBlockView: View {
    let block: InsightBlock

    var body: some View {
        switch block {
        case .heading(let level, let text):
            Text(inline(text))
                .font(headingFont(level))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)

        case .paragraph(let text):
            Text(inline(text))
                .font(.body)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)

        case .bulletList(let items):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("•").foregroundStyle(.secondary)
                        Text(inline(item))
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

        case .orderedList(let items):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("\(index + 1).")
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                        Text(inline(item))
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

        case .quote(let text):
            HStack(alignment: .top, spacing: 8) {
                Rectangle()
                    .fill(.tertiary)
                    .frame(width: 2)
                Text(inline(text))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

        case .table(let headers, let rows):
            AIChatTableBlock(headers: headers, rows: rows)

        case .thematicBreak:
            Divider()

        case .chart, .code:
            if let code = AIChatMarkdown.codeText(block) {
                AIChatCodeBlock(language: code.language, code: code.code)
            }
        }
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: return .title3.weight(.semibold)
        case 2: return .headline
        default: return .subheadline.weight(.semibold)
        }
    }

    /// 行内标记（粗体 / 斜体 / 行内代码 / 链接）。解析失败就退回原文 —— 一段没闭合的
    /// `**` 不该让整块内容消失。
    private func inline(_ text: String) -> AttributedString {
        (try? AttributedString(
            markdown: text,
            options: AttributedString.MarkdownParsingOptions(
                interpretedSyntax: .inlineOnlyPreservingWhitespace
            )
        )) ?? AttributedString(text)
    }
}

private struct AIChatCodeBlock: View {
    let language: String
    let code: String

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text(language.uppercased())
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
                Button {
                    let pasteboard = NSPasteboard.general
                    pasteboard.clearContents()
                    pasteboard.setString(code, forType: .string)
                } label: {
                    Label("复制", systemImage: "doc.on.doc")
                        .labelStyle(.titleAndIcon)
                        .font(.caption2)
                }
                .buttonStyle(.plain)
                .help("复制代码块内容")
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(.quaternary)

            ScrollView(.horizontal) {
                Text(code)
                    .font(.callout.monospaced())
                    .textSelection(.enabled)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.25), lineWidth: 0.5)
        )
    }
}

private struct AIChatTableBlock: View {
    let headers: [String]
    let rows: [[String]]

    var body: some View {
        ScrollView(.horizontal) {
            Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
                    ForEach(Array(headers.enumerated()), id: \.offset) { _, header in
                        cell(header, isHeader: true)
                    }
                }
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { _, value in
                            cell(value, isHeader: false)
                        }
                    }
                }
            }
            .padding(1)
        }
        .overlay(
            RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.25), lineWidth: 0.5)
        )
    }

    private func cell(_ text: String, isHeader: Bool) -> some View {
        Text(text)
            .font(isHeader ? .caption.weight(.semibold) : .caption)
            .textSelection(.enabled)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .frame(minWidth: 60, alignment: .leading)
            .background(isHeader ? Color.secondary.opacity(0.12) : Color.clear)
    }
}

// MARK: - 消息行

/// 一条消息（assistant 走 Markdown，user 走纯文本 —— 与 Web `chat-message-list.tsx` 同口径：
/// 用户输入不解析 Markdown，免得把自己写的 `*` 渲染成列表）。
struct AIChatMessageRow: View {
    let message: AIChatMessage
    let onCopy: () -> Void
    let onEdit: (() -> Void)?
    let onDelete: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: message.isUser ? "person.crop.circle" : "sparkles")
                    .foregroundStyle(message.isUser ? Color.secondary : Color.accentColor)
                Text(message.isUser ? "我" : "助手")
                    .font(.caption.weight(.semibold))
                if let range = AIChatFormatting.searchTimeRangeLabel(message.searchTimeRange) {
                    Text(range)
                        .font(.caption2)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(.quaternary, in: Capsule())
                }
                if !message.isComplete {
                    Text("未完成")
                        .font(.caption2)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(Color.orange.opacity(0.2), in: Capsule())
                }
                Spacer(minLength: 0)
                actions
            }

            if message.isUser {
                Text(message.content)
                    .font(.body)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                AIChatMarkdownView(content: message.content, streaming: false)
            }

            if !message.searchSources.isEmpty {
                AIChatSearchSourcesView(sources: message.searchSources)
            }

            if let footer = AIChatFormatting.tokenFooter(message) {
                Text(footer)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .monospacedDigit()
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            message.isUser ? Color.secondary.opacity(0.07) : Color.accentColor.opacity(0.06),
            in: RoundedRectangle(cornerRadius: 10)
        )
    }

    @ViewBuilder
    private var actions: some View {
        HStack(spacing: 4) {
            Button {
                onCopy()
            } label: {
                Image(systemName: "doc.on.doc")
            }
            .buttonStyle(.plain)
            .help("复制这条消息")

            if let onEdit {
                Button {
                    onEdit()
                } label: {
                    Image(systemName: "pencil")
                }
                .buttonStyle(.plain)
                .help("编辑（后端只接受用户消息）")
            }

            Button(role: .destructive) {
                onDelete()
            } label: {
                Image(systemName: "trash")
            }
            .buttonStyle(.plain)
            .help("删除这条消息（会二次确认）")
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }
}

/// 联网搜索结果卡片（Web `components/ai-chat-search-sources.tsx`）。
struct AIChatSearchSourcesView: View {
    let sources: [AIChatSearchSource]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("来源（\(sources.count)）")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            ForEach(Array(sources.enumerated()), id: \.offset) { _, source in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: "link")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(source.displayTitle)
                            .font(.caption)
                            .lineLimit(1)
                        if let url = source.url, !url.isEmpty {
                            Text(url)
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }
                }
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
    }
}

// MARK: - 生成中的草稿

/// 生成中的助手消息（流式草稿 + 光标 + 停止按钮）。
struct AIChatDraftRow: View {
    let draft: AIChatTurnAccumulator
    let isAwaitingFirstToken: Bool
    let canStop: Bool
    let onStop: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "sparkles")
                    .foregroundStyle(Color.accentColor)
                Text("助手")
                    .font(.caption.weight(.semibold))
                if draft.isSearching {
                    HStack(spacing: 4) {
                        ProgressView().controlSize(.mini)
                        Text("搜索中…").font(.caption2).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
                if canStop {
                    Button {
                        onStop()
                    } label: {
                        Label("停止", systemImage: "stop.circle")
                            .font(.caption)
                    }
                    .buttonStyle(.plain)
                    .help("停止生成（同时通知后端取消这条流）")
                }
            }

            if isAwaitingFirstToken {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("思考中…").font(.callout).foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)
            } else {
                if !draft.thinking.isEmpty {
                    DisclosureGroup {
                        Text(draft.thinking)
                            .font(.callout.monospaced())
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } label: {
                        Text("思考过程（\(draft.thinking.count) 字）")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                AIChatMarkdownView(content: draft.text, streaming: true)
            }

            if !draft.unknownEventTypes.isEmpty {
                Text("收到未识别的事件类型：\(draft.unknownEventTypes.joined(separator: "、"))（已忽略，正文不受影响）")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.accentColor.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
    }
}

// MARK: - 用量面板（端点 12）

/// token 用量面板（`GET /ai/usage/stats`）。
///
/// 与 Web 的关系：Web 的 `TokenFooter` 只显示**单条消息**的用量（来自流里的 `done` 事件），
/// 并没有历史汇总；`/ai/usage/stats` 在后端存在（BEL-379 物化表）但目前**只有类型定义、
/// 没有 Web 消费点**。桌面端把它接成一块可切换区间的汇总面板 —— 端点因此可达，
/// 同时不假称「Web 也是这么显示的」。
struct AIChatUsagePanel: View {
    let phase: AIChatPhase
    let stats: AIChatUsageStats?
    let range: AIChatUsageRange
    let onSelectRange: (AIChatUsageRange) -> Void
    let onReload: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text("Token 用量")
                    .font(.callout.weight(.semibold))
                Spacer(minLength: 0)
                ForEach(AIChatUsageRange.allCases) { option in
                    Button {
                        onSelectRange(option)
                    } label: {
                        Text(option.label)
                            .font(.caption)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(
                                option == range ? Color.accentColor.opacity(0.18) : Color.clear,
                                in: Capsule()
                            )
                    }
                    .buttonStyle(.plain)
                }
                Button {
                    onReload()
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.plain)
                .help("重新拉取用量")
            }

            switch phase {
            case .idle, .loading:
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("加载中…").font(.caption).foregroundStyle(.secondary)
                }
            case .failed(let message):
                NoticeRow(kind: .warning, message: "用量统计不可用：\(message)")
            case .loaded:
                if let stats {
                    totals(stats)
                    byModel(stats)
                    freshness(stats)
                }
            }
        }
    }

    @ViewBuilder
    private func totals(_ stats: AIChatUsageStats) -> some View {
        let totals = stats.totals
        Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 2) {
            GridRow {
                metric("总 tokens", AIChatFormatting.integer(totals.totalTokens))
                metric("输入", AIChatFormatting.integer(totals.promptTokens))
                metric("输出", AIChatFormatting.integer(totals.completionTokens))
                metric("消息", AIChatFormatting.integer(totals.messageCount))
            }
        }
        Text("会话数 \(totals.conversationCount) 是 **上界**（后端按日 distinct 求和，同一会话跨会被重复计入）—— 不是「不重复会话数」。")
            .font(.caption2)
            .foregroundStyle(.tertiary)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func metric(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.caption2).foregroundStyle(.secondary)
            Text(value).font(.callout.weight(.medium)).monospacedDigit()
        }
    }

    @ViewBuilder
    private func byModel(_ stats: AIChatUsageStats) -> some View {
        if !stats.byModel.isEmpty {
            VStack(alignment: .leading, spacing: 3) {
                Text("按模型").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                ForEach(stats.byModel.prefix(6)) { item in
                    HStack(spacing: 8) {
                        Text(item.model)
                            .font(.caption)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer(minLength: 0)
                        Text(AIChatFormatting.integer(item.totalTokens))
                            .font(.caption)
                            .monospacedDigit()
                        Text("· \(item.messageCount) 条")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func freshness(_ stats: AIChatUsageStats) -> some View {
        let text = freshnessText(stats)
        if !text.isEmpty {
            Text(text).font(.caption2).foregroundStyle(.tertiary)
        }
    }

    private func freshnessText(_ stats: AIChatUsageStats) -> String {
        var parts: [String] = ["区间 \(stats.startDate) ~ \(stats.endDate)"]
        if let date = stats.snapshotFreshness.latestDataDate {
            parts.append("物化表数据到 \(date)")
        } else {
            parts.append("物化表暂无数据")
        }
        if stats.daily.contains(where: { $0.totalTokens > 0 }) {
            let active = stats.daily.filter { $0.totalTokens > 0 }.count
            parts.append("区间内 \(active) 天有用量")
        }
        return parts.joined(separator: " · ")
    }
}
