import Foundation

/// 流式草稿的安全切分（Web `lib/insight/stream-blocks.ts` 的 Swift 复刻）。
///
/// 为什么需要它：流式正文随时可能停在半句话上。整段交给 Markdown 渲染器时，**未闭合的
/// 围栏**会把后面的全部内容吞进代码块（` ``` ` 开了没关 → 后面整篇当代码）；表格 / 列表
/// 停在半行同理。所以切成两段：
///
/// - `stable`：已闭合的 Markdown 前缀，可以安全交给渲染器（其中每个围栏都在自身内部闭合，
///   于是「图表围栏只在闭合后挂载」天然成立）；
/// - `tail`：仍在输入中的尾部（未闭合围栏、未换行的末行），以**纯文本**呈现，不参与解析。
///
/// 纯函数：同一份草稿必然得到同一份切分（渲染确定性的前提）。
public struct InsightStreamBlocks: Equatable, Sendable {
    public let stable: String
    public let tail: String

    public init(stable: String, tail: String) {
        self.stable = stable
        self.tail = tail
    }
}

/// Markdown 文档解析出来的一个块。
///
/// 桌面端**自己解析块级结构**而不是把整段丢给某个渲染器，原因是本批最硬的一条口径
/// （BLF-1062 §口径 3）：`\`\`\`chart` 围栏必须显式降级成「可读可复制的代码块 + 明示
/// 图表未渲染」，**不得静默丢块**。要做到这一点，就得在渲染之前把围栏块识别出来 ——
/// 顺带把其余块级结构识别出来，渲染层只剩「块 → 视图」这一层映射。
///
/// 行内标记（粗体 / 斜体 / 行内代码 / 链接）不在这一层解析：交给渲染层的
/// `AttributedString(markdown:)`，这是系统自带、有确定性行为的那一段。
public enum InsightBlock: Equatable, Sendable {
    case heading(level: Int, text: String)
    case paragraph(String)
    case bulletList([String])
    case orderedList([String])
    case quote(String)
    case table(headers: [String], rows: [[String]])
    case thematicBreak
    /// **图表围栏**（`chart` / `lineChart` / `pieChart` / `line` / `pie` …）—— 降级渲染。
    case chart(language: String, code: String)
    /// 其它语言的代码块（原样成块）。
    case code(language: String?, code: String)
}

/// Markdown 相关的纯逻辑：流式切分 + 块级解析。
public enum InsightMarkdown {
    /// 图表围栏语言（Web 两处并集）：
    /// `insight-markdown.tsx` 的 `DEFAULT_CHART_LANGUAGES = ['chart']`，
    /// 加上旧洞察页 `chart-code-block.tsx` 的 `LEGACY_CHART_LANGUAGES`（7 个）。
    public static let chartFenceLanguages: Set<String> = [
        "chart", "line", "linechart", "lineChart",
        "pie", "piechart", "pieChart",
    ]

    // MARK: - 流式切分

    /// 流式切分（见 `InsightStreamBlocks`）。
    public static func splitStreamingMarkdown(_ content: String) -> InsightStreamBlocks {
        guard !content.isEmpty else { return InsightStreamBlocks(stable: "", tail: "") }

        var pending: OpenFence?
        var lineStart = content.startIndex

        while lineStart < content.endIndex {
            let newline = content[lineStart...].firstIndex(of: "\n")
            let lineEnd = newline ?? content.endIndex
            let line = String(content[lineStart..<lineEnd])

            if let fence = pending {
                if closesFence(line: line, marker: fence.marker, length: fence.length) {
                    pending = nil
                }
            } else if let opened = openedFence(in: line, at: lineStart) {
                pending = opened
            }

            guard let newline else { break }
            lineStart = content.index(after: newline)
        }

        // 未闭合围栏会吞掉其后全部内容：整段围栏留在 tail，绝不让后续块被解析成代码。
        if let fence = pending {
            return InsightStreamBlocks(
                stable: String(content[content.startIndex..<fence.start]),
                tail: String(content[fence.start...])
            )
        }

        // 末行尚未换行 → 仍在输入中（半行表格 / 列表项 / 行内标记），保留为纯文本。
        guard let lastNewline = content.lastIndex(of: "\n") else {
            return InsightStreamBlocks(stable: "", tail: content)
        }
        return InsightStreamBlocks(
            stable: String(content[content.startIndex...lastNewline]),
            tail: String(content[content.index(after: lastNewline)...])
        )
    }

    // MARK: - 块级解析

    /// 把 Markdown 正文切成块序列。**绝不丢内容**：认不出的行按段落收下。
    public static func parse(_ content: String) -> [InsightBlock] {
        var blocks: [InsightBlock] = []
        var lines = content.split(separator: "\n", omittingEmptySubsequences: false)
            .map(String.init)
        // `split` 会给结尾换行多切一个空串，去掉它（免得每篇都以一个空段落收尾）。
        if content.hasSuffix("\n"), lines.last == "" { lines.removeLast() }

        var index = 0
        while index < lines.count {
            let line = lines[index]

            if let fence = openFenceParts(in: line) {
                let opening = (
                    language: fence.language,
                    marker: fence.marker.first!,
                    length: fence.length
                )
                var code = ""
                index += 1
                while index < lines.count {
                    if closesFence(
                        line: lines[index],
                        marker: opening.marker,
                        length: opening.length
                    ) {
                        index += 1
                        break
                    }
                    code += lines[index] + "\n"
                    index += 1
                }
                if let language = opening.language, chartFenceLanguages.contains(language) {
                    blocks.append(.chart(language: language, code: code))
                } else {
                    blocks.append(.code(language: opening.language, code: code))
                }
                continue
            }

            if line.trimmingCharacters(in: .whitespaces).isEmpty {
                index += 1
                continue
            }

            if let heading = headingParts(in: line) {
                blocks.append(.heading(level: heading.level, text: heading.text))
                index += 1
                continue
            }

            if isThematicBreak(line) {
                blocks.append(.thematicBreak)
                index += 1
                continue
            }

            // 表格：本行含 `|` 且下一行是分隔行（`| --- | :--: |`）。
            if line.contains("|"), index + 1 < lines.count, isTableDelimiter(lines[index + 1]) {
                let headers = tableCells(line)
                var rows: [[String]] = []
                index += 2
                while index < lines.count, lines[index].contains("|"),
                      !lines[index].trimmingCharacters(in: .whitespaces).isEmpty
                {
                    rows.append(tableCells(lines[index]))
                    index += 1
                }
                blocks.append(.table(headers: headers, rows: rows))
                continue
            }

            if let items = collectList(&index, lines: lines, ordered: false) {
                blocks.append(.bulletList(items))
                continue
            }
            if let items = collectList(&index, lines: lines, ordered: true) {
                blocks.append(.orderedList(items))
                continue
            }

            if let quote = collectQuote(&index, lines: lines) {
                blocks.append(.quote(quote))
                continue
            }

            var paragraph: [String] = []
            while index < lines.count,
                  !lines[index].trimmingCharacters(in: .whitespaces).isEmpty,
                  openFenceParts(in: lines[index]) == nil,
                  headingParts(in: lines[index]) == nil,
                  !isThematicBreak(lines[index]),
                  !(lines[index].contains("|") && index + 1 < lines.count
                      && isTableDelimiter(lines[index + 1])),
                  bulletItemText(in: lines[index]) == nil,
                  orderedItemText(in: lines[index]) == nil,
                  !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix(">")
            {
                paragraph.append(lines[index].trimmingCharacters(in: .whitespaces))
                index += 1
            }
            if paragraph.isEmpty {
                // 认不出的行也不能丢（例如只有 `|` 的单行表格残片）。
                paragraph.append(line.trimmingCharacters(in: .whitespaces))
                index += 1
            }
            blocks.append(.paragraph(paragraph.joined(separator: "\n")))
        }
        return blocks
    }

    // MARK: - 块级辅助

    private static func collectList(
        _ index: inout Int,
        lines: [String],
        ordered: Bool
    ) -> [String]? {
        var items: [String] = []
        var cursor = index
        while cursor < lines.count {
            let line = lines[cursor]
            let text = ordered ? orderedItemText(in: line) : bulletItemText(in: line)
            guard let text else { break }
            items.append(text)
            cursor += 1
        }
        guard !items.isEmpty else { return nil }
        index = cursor
        return items
    }

    private static func collectQuote(_ index: inout Int, lines: [String]) -> String? {
        var collected: [String] = []
        var cursor = index
        while cursor < lines.count {
            let trimmed = lines[cursor].trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix(">") else { break }
            collected.append(String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces))
            cursor += 1
        }
        guard !collected.isEmpty else { return nil }
        index = cursor
        return collected.joined(separator: "\n")
    }

    /// `^ {0,3}#{1,6}\s+`（CommonMark 要求 `#` 后有空格；`#标题` 不是标题）。
    private static func headingParts(in line: String) -> (level: Int, text: String)? {
        var index = line.startIndex
        var spaces = 0
        while index < line.endIndex, line[index] == " ", spaces < 4 {
            spaces += 1
            index = line.index(after: index)
        }
        guard spaces <= 3 else { return nil }

        var level = 0
        while index < line.endIndex, line[index] == "#", level < 7 {
            level += 1
            index = line.index(after: index)
        }
        guard (1...6).contains(level), index < line.endIndex, line[index] == " " else { return nil }
        let text = String(line[index...]).trimmingCharacters(in: .whitespaces)
        return text.isEmpty ? nil : (level: level, text: text)
    }

    private static func isThematicBreak(_ line: String) -> Bool {
        let stripped = line.filter { $0 != " " }
        guard stripped.count >= 3 else { return false }
        if stripped.allSatisfy({ $0 == "-" || $0 == "*" || $0 == "_" }) { return true }
        return false
    }

    private static func bulletItemText(in line: String) -> String? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard let first = trimmed.first, "-*+".contains(first) else { return nil }
        let rest = trimmed.dropFirst()
        guard rest.hasPrefix(" ") else { return nil }
        return rest.trimmingCharacters(in: .whitespaces)
    }

    private static func orderedItemText(in line: String) -> String? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        var cursor = trimmed.startIndex
        var digits = 0
        while cursor < trimmed.endIndex, trimmed[cursor].isNumber {
            digits += 1
            cursor = trimmed.index(after: cursor)
        }
        guard digits > 0, digits <= 9, cursor < trimmed.endIndex else { return nil }
        guard trimmed[cursor] == "." || trimmed[cursor] == ")" else { return nil }
        let rest = trimmed[trimmed.index(after: cursor)...]
        guard rest.hasPrefix(" ") else { return nil }
        return rest.trimmingCharacters(in: .whitespaces)
    }

    /// `| a | b |` → `["a", "b"]`（去掉首尾空格与两侧竖线）。
    private static func tableCells(_ line: String) -> [String] {
        var text = line.trimmingCharacters(in: .whitespaces)
        if text.hasPrefix("|") { text.removeFirst() }
        if text.hasSuffix("|") { text.removeLast() }
        return text.split(separator: "|", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
    }

    /// 分隔行：至少一个格，每格形如 `:?-+:?`。
    private static func isTableDelimiter(_ line: String) -> Bool {
        let cells = tableCells(line)
        guard !cells.isEmpty, line.contains("-") else { return false }
        return cells.allSatisfy { cell in
            var body = cell
            if body.hasPrefix(":") { body.removeFirst() }
            if body.hasSuffix(":") { body.removeLast() }
            return body.count >= 3 && body.allSatisfy { $0 == "-" }
        }
    }

    // MARK: - 围栏辅助

    private struct OpenFence {
        let marker: Character
        let length: Int
        let start: String.Index
    }

    /// 行首围栏开启判定；返回起始位置供「从围栏处切尾」使用。
    private static func openedFence(in line: String, at start: String.Index) -> OpenFence? {
        guard let parts = openFenceParts(in: line) else { return nil }
        return OpenFence(marker: parts.marker.first!, length: parts.length, start: start)
    }

    /// `^ {0,3}(`{3,}|~{3,})(.*)$`：返回围栏标记、长度与信息串（语言）。
    private static func openFenceParts(
        in line: String
    ) -> (language: String?, marker: String, length: Int)? {
        var index = line.startIndex
        var spaces = 0
        while index < line.endIndex, line[index] == " ", spaces < 4 {
            spaces += 1
            index = line.index(after: index)
        }
        guard spaces <= 3, index < line.endIndex else { return nil }

        let markerCharacter = line[index]
        guard markerCharacter == "`" || markerCharacter == "~" else { return nil }

        var length = 0
        while index < line.endIndex, line[index] == markerCharacter {
            length += 1
            index = line.index(after: index)
        }
        guard length >= 3 else { return nil }

        let info = String(line[index...]).trimmingCharacters(in: .whitespaces)
        // 反引号围栏的信息串不能含反引号（CommonMark）；`~` 围栏无此限制。
        if markerCharacter == "`", info.contains("`") { return nil }

        let language = info.split(separator: " ").first.map(String.init)
        return (
            language: language?.isEmpty == true ? nil : language,
            marker: String(repeating: String(markerCharacter), count: length),
            length: length
        )
    }

    /// `^ {0,3}(`{3,}|~{3,})[ \t]*$`：闭合围栏必须同标记、长度不小于开启者。
    private static func closesFence(line: String, marker: Character, length: Int) -> Bool {
        var index = line.startIndex
        var spaces = 0
        while index < line.endIndex, line[index] == " ", spaces < 4 {
            spaces += 1
            index = line.index(after: index)
        }
        guard spaces <= 3, index < line.endIndex, line[index] == marker else {
            return false
        }

        var runLength = 0
        while index < line.endIndex, line[index] == marker {
            runLength += 1
            index = line.index(after: index)
        }
        guard runLength >= length else { return false }

        let tail = line[index...]
        return tail.allSatisfy { $0 == " " || $0 == "\t" }
    }
}
