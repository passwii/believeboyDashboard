import Foundation

/// AI 会话的 Markdown 口径：**解析复用 S5.3 的 `InsightMarkdown`，只分叉呈现**。
///
/// 为什么复用而不是另写一套：流式草稿的「未闭合围栏留在纯文本 tail」这条口径是本批最
/// 容易写错的一处（` ``` ` 开了没关会把后面整篇吞进代码块），S5.3 已经用
/// `InsightStreamBlocks` 把它钉死并配了用例。同一份规则写两遍，只会在下一次改动时
/// 分成两种行为。
///
/// 为什么呈现要分叉：Web 的 AI 会话正文是 `react-markdown` + `remark-gfm`
/// （`components/ai-chat-message-content.tsx`），**没有图表渲染器** —— 所以 `` ```chart ``
/// 在会话页就是一个「语言标签为 chart 的普通代码块」，而不是洞察页那种「图表未渲染」的
/// 降级块。桌面端因此照 Web 会话页呈现，只把解析结果拿过来用。
public enum AIChatMarkdown {

    /// 流式草稿切分：`stable` 可以安全解析，`tail` 以纯文本呈现。
    public static func splitDraft(_ content: String) -> InsightStreamBlocks {
        InsightMarkdown.splitStreamingMarkdown(content)
    }

    /// 块级解析（不丢内容：认不出的行按段落收下）。
    public static func blocks(_ content: String) -> [InsightBlock] {
        InsightMarkdown.parse(content)
    }

    /// 代码块的语言标签（Web 头行：`language || 'text'`）。
    public static func codeLanguageLabel(_ language: String?) -> String {
        language?.trimmedNonEmpty ?? "text"
    }

    /// 这个块是不是「按普通代码块呈现」的（会话页对 `chart` 围栏与普通围栏同待遇）。
    public static func isPlainCodeBlock(_ block: InsightBlock) -> Bool {
        switch block {
        case .code, .chart: return true
        default: return false
        }
    }

    /// 取代码块的语言与正文（`chart` 与 `code` 统一入口，避免调用点各写一遍 switch）。
    public static func codeText(_ block: InsightBlock) -> (language: String, code: String)? {
        switch block {
        case .code(let language, let code): return (codeLanguageLabel(language), code)
        case .chart(let language, let code): return (codeLanguageLabel(language), code)
        default: return nil
        }
    }

    /// 流式草稿的纯文本尾（未闭合围栏 / 半行）。
    public static func draftTailText(_ content: String) -> String {
        splitDraft(content).tail
    }
}
