import AppKit
import BelieveBoyKit
import SwiftUI

// MARK: - 状态色板

/// 洞察状态 → 颜色（canonical 7 态 + 旧链接归一后的词表）。
///
/// 与 Web `components/insight/insight-status.tsx` 同口径：`completed` 绿、`failed` 红、
/// `cancelled` 灰、其余在跑的状态用强调色 / 警示色。
enum InsightStatusTone {
    static func color(for status: String) -> Color {
        switch status {
        case "completed": return .green
        case "failed": return .red
        case "cancelled": return .secondary
        case "finalizing": return .teal
        case "generating": return .accentColor
        case "aggregating": return .orange
        case "queued", "connecting", "reconnecting": return .secondary
        default: return .secondary
        }
    }

    static func symbol(for status: String) -> String {
        switch status {
        case "completed": return "checkmark.circle.fill"
        case "failed": return "xmark.octagon.fill"
        case "cancelled": return "slash.circle.fill"
        case "queued": return "clock"
        case "connecting", "reconnecting": return "arrow.triangle.2.circlepath"
        default: return "circle.dotted"
        }
    }
}

/// 状态药丸（图标 + 文案），三页共用。
struct InsightStatusPill: View {
    let status: String
    let label: String
    var showsSpinner: Bool = false

    var body: some View {
        let color = InsightStatusTone.color(for: status)
        HStack(spacing: 5) {
            if showsSpinner {
                ProgressView().controlSize(.mini)
            } else {
                Image(systemName: InsightStatusTone.symbol(for: status))
                    .font(.caption2)
            }
            Text(label).font(.caption)
        }
        .foregroundStyle(color)
        .padding(.horizontal, 7)
        .padding(.vertical, 2)
        .background(color.opacity(0.12), in: Capsule())
        .overlay(Capsule().stroke(color.opacity(0.35), lineWidth: 0.5))
    }
}

// MARK: - Markdown 渲染

/// Markdown 正文渲染（块级由 `InsightMarkdown.parse` 切好，行内交给系统
/// `AttributedString(markdown:)`）。
///
/// `tail`（流式未完成尾部）以**纯等宽文本**追加在末尾：它可能停在半行表格 / 未闭合围栏上，
/// 再解析一次就会把后续内容误渲染（BLF-1062 §口径 3）。
struct InsightMarkdownView: View {
    let blocks: [InsightBlock]
    var tail: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .heading(let level, let text):
                    InlineMarkdownText(text)
                        .font(headingFont(level))
                        .fontWeight(level <= 2 ? .semibold : .medium)
                case .paragraph(let text):
                    InlineMarkdownText(text)
                        .font(.callout)
                        .fixedSize(horizontal: false, vertical: true)
                case .bulletList(let items):
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Text("•").font(.callout).foregroundStyle(.secondary)
                                InlineMarkdownText(item).font(.callout)
                            }
                        }
                    }
                case .orderedList(let items):
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Text("\(index + 1).")
                                    .font(.callout.monospacedDigit())
                                    .foregroundStyle(.secondary)
                                InlineMarkdownText(item).font(.callout)
                            }
                        }
                    }
                case .quote(let text):
                    HStack(alignment: .top, spacing: 8) {
                        Rectangle()
                            .fill(.quaternary)
                            .frame(width: 3)
                        InlineMarkdownText(text)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                case .table(let headers, let rows):
                    InsightTableBlock(headers: headers, rows: rows)
                case .thematicBreak:
                    Divider()
                case .chart(let language, let code):
                    InsightChartFallbackBlock(language: language, code: code)
                case .code(let language, let code):
                    InsightCodeBlock(language: language, code: code)
                }
            }
            if !tail.isEmpty {
                // 流式尾部：纯文本，不解析（半行表格 / 未闭合围栏都会在这里被误解析）。
                Text(tail)
                    .font(.callout.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: return .title2
        case 2: return .title3
        case 3: return .headline
        default: return .subheadline
        }
    }
}

/// 行内 Markdown（粗体 / 斜体 / 行内代码 / 链接）。
///
/// 解析失败就原样显示 —— 一段行内标记坏掉不该让整块内容消失。
private struct InlineMarkdownText: View {
    private let source: String

    init(_ source: String) {
        self.source = source
    }

    var body: some View {
        Text(attributed)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var attributed: AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            allowsExtendedAttributes: false,
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
        return (try? AttributedString(markdown: source, options: options))
            ?? AttributedString(source)
    }
}

/// Markdown 表格（`| a | b |`），等宽 + 首行加粗。
struct InsightTableBlock: View {
    let headers: [String]
    let rows: [[String]]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            row(headers, isHeader: true)
            Divider()
            ForEach(Array(rows.enumerated()), id: \.offset) { _, cells in
                row(cells, isHeader: false)
                if cells != rows.last { Divider().opacity(0.4) }
            }
        }
        .padding(6)
        .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 6))
    }

    private func row(_ cells: [String], isHeader: Bool) -> some View {
        HStack(alignment: .top, spacing: 10) {
            ForEach(Array(cells.enumerated()), id: \.offset) { _, cell in
                Text(cell)
                    .font(.caption)
                    .fontWeight(isHeader ? .semibold : .regular)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }
        }
        .padding(.vertical, 3)
    }
}

/// **图表围栏的降级呈现**（BLF-1062 §口径 3）。
///
/// 桌面端本批不复刻 Web 的 `chart` 图 DSL（react-markdown + recharts），而是把原文按
/// 「可读可复制的代码块」呈现，并在块头**明示图表未渲染** —— 静默丢掉整块正文会被读成
/// 「模型没写这一节」。
struct InsightChartFallbackBlock: View {
    let language: String
    let code: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "chart.xyaxis.line")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text("图表未渲染（桌面端本批不渲染 `\(language)` 图 DSL）")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
                InsightCopyButton(text: code, label: "复制图表数据")
            }
            Text(code)
                .font(.caption.monospaced())
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
                .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 6))
        }
        .padding(8)
        .background(.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8).stroke(.orange.opacity(0.3), lineWidth: 0.5)
        )
    }
}

/// 普通代码块。
struct InsightCodeBlock: View {
    let language: String?
    let code: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "chevron.left.forwardslash.chevron.right")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(language ?? "代码").font(.caption).foregroundStyle(.secondary)
                Spacer(minLength: 0)
                InsightCopyButton(text: code, label: "复制代码")
            }
            Text(code)
                .font(.caption.monospaced())
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
                .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 6))
        }
    }
}

/// 复制按钮（`NSPasteboard`）—— 图表降级块与代码块都要「可复制」。
///
/// 不用 `@State` 做「已复制」反馈（CLT 工具链下属性包装器宏不可用，见 `Package.swift`
/// 顶部）：按钮的反馈交给 hover 提示，而不是让整个组件为了一行文案引入包装器。
struct InsightCopyButton: View {
    let text: String
    let label: String

    var body: some View {
        Button {
            let pasteboard = NSPasteboard.general
            pasteboard.clearContents()
            pasteboard.setString(text, forType: .string)
        } label: {
            Label(label, systemImage: "doc.on.doc")
                .font(.caption)
        }
        .buttonStyle(.borderless)
        .disabled(text.isEmpty)
        .help(text.isEmpty ? "没有可复制的内容" : "复制到剪贴板")
    }
}

// MARK: - 流式面板

/// 三页共用的流式面板：状态行 + 进度 + 正文（Markdown / 流式草稿）+ 错误 + 空态。
///
/// 与 Web `components/insight/insight-stream-panel.tsx` 同构（header / content / meta /
/// emptyState 四个插槽），差异只在「谁喂参数」。
struct InsightStreamPanel: View {
    let state: InsightPanelState
    let content: String
    let contentState: InsightContentState
    let errorMessage: String?
    let digest: String?
    /// 正文槽说明（`main` / 输出长度 / 数据来源），可为空。
    var metaText: String?
    var headerTrailing: AnyView?
    var emptyText: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                InsightStatusPill(
                    status: state.status,
                    label: state.label,
                    showsSpinner: state.busy && state.isStreaming
                )
                if let progress = state.progress, state.busy {
                    ProgressView(value: Double(progress), total: 100)
                        .frame(width: 120)
                    Text("\(progress)%").font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                if let headerTrailing { headerTrailing }
            }

            if let errorMessage {
                NoticeRow(kind: .failure, message: errorMessage)
            }

            if content.isEmpty {
                HStack(spacing: 8) {
                    if state.busy {
                        ProgressView().controlSize(.small)
                    }
                    Text(emptyText)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                }
                .padding(.vertical, 24)
            } else {
                GroupBox {
                    ScrollView(.vertical) {
                        contentBody
                            .padding(4)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                } label: {
                    HStack(spacing: 6) {
                        Text(contentState == .draft ? "流式草稿" : "正文")
                            .font(.caption)
                        if contentState == .draft {
                            Text("（未完成，尾部按纯文本呈现）")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }

            if let metaText {
                Text(metaText).font(.caption).foregroundStyle(.tertiary)
            }
            if let digest, !digest.isEmpty {
                Text("内容摘要（sha256）：\(digest)")
                    .font(.caption.monospaced())
                    .foregroundStyle(.tertiary)
                    .textSelection(.enabled)
            }
        }
    }

    @ViewBuilder
    private var contentBody: some View {
        if contentState == .draft {
            // 流式：stable 走 Markdown，未完成的 tail 走纯文本（口径 3）。
            let split = InsightMarkdown.splitStreamingMarkdown(content)
            InsightMarkdownView(blocks: InsightMarkdown.parse(split.stable), tail: split.tail)
        } else {
            InsightMarkdownView(blocks: InsightMarkdown.parse(content))
        }
    }
}

/// 正文是「流式草稿」还是「终态正文」。
enum InsightContentState: Equatable {
    case draft
    case final
}
