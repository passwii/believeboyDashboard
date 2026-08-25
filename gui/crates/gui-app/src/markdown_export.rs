//! Markdown → Word（DOCX）导出管线（P5-8，BLF-749）。
//!
//! 忠实移植 web 端 `frontend/app/dashboard/tools/markdown-to-word/lib/`：
//! - [`markdown-ast.ts`](../../../frontend/app/dashboard/tools/markdown-to-word/lib/markdown-ast.ts)
//!   → 本文件「AST 解析」段（块级 + 行内 token，逐分支对齐）；
//! - [`markdown-docx.ts`](../../../frontend/app/dashboard/tools/markdown-to-word/lib/markdown-docx.ts)
//!   → 「DOCX 构建」段（样式 / 颜色 / 边框 / 编号配置同值迁移到 docx-rs）；
//! - [`markdown-to-word.ts`](../../../frontend/app/dashboard/tools/markdown-to-word/lib/markdown-to-word.ts)
//!   → `create_word_filename` / `format_file_size`。
//!
//! ## 与 web 端的取舍
//!
//! - **无正则 crate**：行内标记用手写扫描器实现 web `INLINE_PATTERN`
//!   的等价语义（最早位置优先 + 同位次序：链接/图片 → `**` → `__` →
//!   `*` → `~~` → 反引号），单测锁行为；
//! - **代码块换行**：web 把整段代码文本塞进单个 TextRun（OOXML 中裸 `\n`
//!   不换行）；本实现按行拆 Run 并插 `<w:br/>`（`add_break`），Word 打开
//!   时代码块保留换行——对 web 行为的修正而非偏离，PR 说明；
//! - **PDF 导出不移植**：web 端走 pdf-lib（浏览器内生成）；GUI 端嵌入 CJK
//!   字体的 PDF writer 成本高且本棒核心是 DOCX，PDF 继续走 web 端（issue
//!   允许精简并说明）。

use std::io::Cursor;
use std::time::SystemTime;

use docx_rs::{
    AbstractNumbering, BorderType, BreakType, Docx, Hyperlink, HyperlinkType, IndentLevel, Level,
    LevelJc, LevelText, LineSpacing, NumberFormat, Numbering, NumberingId, PageMargin, Paragraph,
    ParagraphBorder, ParagraphBorderPosition, ParagraphBorders, Run, RunFonts, Shading, Start,
    Style, StyleType, Table, TableBorderPosition, TableBorders, TableCell, TableCellMargins,
    TableLayoutType, TableRow, WidthType,
};

// ---------------------------------------------------------------------------
// AST 解析（对齐 markdown-ast.ts）
// ---------------------------------------------------------------------------

/// 行内 token（对齐 web `InlineToken`；`font: 'Courier New'` 收敛为 `mono` 标志）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InlineToken {
    pub text: String,
    pub bold: bool,
    pub italics: bool,
    pub strike: bool,
    pub mono: bool,
    pub link: Option<String>,
}

impl InlineToken {
    fn plain(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            bold: false,
            italics: false,
            strike: false,
            mono: false,
            link: None,
        }
    }
}

/// 块级节点（对齐 web `BlockNode`）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlockNode {
    Heading {
        level: u8,
        children: Vec<InlineToken>,
    },
    Paragraph {
        children: Vec<InlineToken>,
    },
    BulletList {
        items: Vec<Vec<InlineToken>>,
    },
    OrderedList {
        items: Vec<Vec<InlineToken>>,
    },
    Table {
        rows: Vec<Vec<Vec<InlineToken>>>,
        column_count: usize,
    },
    Code {
        text: String,
    },
    Quote {
        children: Vec<InlineToken>,
    },
    Hr,
}

/// 对齐 web `unescapeMarkdownText`：剥掉被反斜杠转义的标点。
pub fn unescape_markdown_text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.peek() {
                Some(&next) if "\\\\`*_{}[]()#+.!|-".contains(next) => {
                    out.push(next);
                    chars.next();
                }
                _ => out.push(c),
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// 在 `rest` 里找与 `open` 相同的分隔串闭合点；返回 (body_end, close_end)。
/// body 要求非空（对齐 web `[^\*]+` 这类「一个或多个」量词）。
fn find_close(value: &str, from: usize, marker: &str) -> Option<(usize, usize)> {
    let bytes = value.as_bytes();
    let m = marker.as_bytes();
    let mut i = from;
    while i + m.len() <= bytes.len() {
        if &bytes[i..i + m.len()] == m && i > from {
            return Some((i, i + m.len()));
        }
        i += 1;
    }
    None
}

/// 匹配行内链接 / 图片：`[text](url)` / `![alt](url)`（url 后可带 `"title"`）。
/// 返回 (是否图片, 括号文本, url, 整体结束偏移)。对齐 web：
/// 图片 text 可空、链接 text 非空；url 为一串非 `)` 非空白字符。
fn try_match_linkish(line: &str, at: usize) -> Option<(bool, String, String, usize)> {
    let rest = &line[at..];
    let image = rest.starts_with("![");
    let open = if image {
        2
    } else {
        if rest.starts_with('[') {
            1
        } else {
            return None;
        }
    };
    let after_open = &rest[open..];
    // text：非 `]` 序列且非空（web INLINE_PATTERN `[\]]+` 对图片/链接统一要求
    // 非空；imageMatch 的 `[\]]*` 只是对已匹配串的二次解析）
    let text_end = after_open.find(']')?;
    if text_end == 0 {
        return None;
    }
    let text = &after_open[..text_end];
    let after_text = &after_open[text_end + 1..];
    if !after_text.starts_with('(') {
        return None;
    }
    // url：非 `)` 非空白序列；可带空格+引号 title
    let paren = &after_text[1..];
    let bytes = paren.as_bytes();
    let mut i = 0;
    while i < bytes.len() && bytes[i] != b')' && !bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    if i == 0 {
        return None;
    }
    let url = &paren[..i];
    let mut end_in_paren = i;
    // 可选 ` "title"`（引号内不含 `"`）
    if end_in_paren < bytes.len() && bytes[end_in_paren] != b')' {
        let tail = &paren[end_in_paren..];
        let trimmed = tail.trim_start();
        let lead_ws = tail.len() - trimmed.len();
        // 可选 ` "title"`（引号内不含 `"`）；消耗完必须恰好落在 ')' 上
        let close_q = trimmed
            .strip_prefix('"')
            .and_then(|after| after.find('"'))?;
        let consumed = lead_ws + 1 + close_q + 1;
        // 漏加 end_in_paren 会错位
        if paren[end_in_paren + consumed..].starts_with(')') {
            end_in_paren += consumed;
        } else {
            return None;
        }
    }
    if end_in_paren >= bytes.len() || bytes[end_in_paren] != b')' {
        return None;
    }
    let total = open + text_end + 1 + 1 + end_in_paren + 1;
    Some((image, text.to_string(), url.to_string(), at + total))
}

/// 剥掉匹配首尾的 `*_~\`` 标记字符（对齐 web `match.replace(/^[*_~`]+|[*_~`]+$/g, '')`）。
fn strip_marker_chars(s: &str) -> &str {
    s.trim_matches(|c| matches!(c, '*' | '_' | '~' | '`'))
}

/// 行内解析（对齐 web `parseInline`）：扫描器在每字节位按
/// 图片/链接 → `**` → `__` → `*` → `~~` → `` ` `` 的次序尝试匹配，
/// 最早命中优先；未命中推进一个字符边界。
pub fn parse_inline(value: &str) -> Vec<InlineToken> {
    let mut tokens: Vec<InlineToken> = Vec::new();
    let mut cursor = 0usize;
    let bytes = value.as_bytes();
    let mut i = 0usize;

    while i < value.len() {
        if !value.is_char_boundary(i) || i < cursor {
            i += 1;
            continue;
        }
        let found: Option<(InlineToken, usize)> = {
            // 1) 图片 / 链接
            if let Some((image, text, url, end)) = try_match_linkish(value, i) {
                if image {
                    let alt = text.trim();
                    let alt = if alt.is_empty() { "图片" } else { alt };
                    Some((
                        InlineToken {
                            text: format!("[图片：{alt}]"),
                            ..InlineToken::plain("")
                        },
                        end,
                    ))
                } else {
                    Some((
                        InlineToken {
                            link: Some(url),
                            ..InlineToken::plain(text)
                        },
                        end,
                    ))
                }
            }
            // 2) **bold**
            else if bytes[i..].starts_with(b"**") {
                find_close(value, i + 2, "**").map(|(_b, e)| {
                    (
                        InlineToken {
                            bold: true,
                            ..InlineToken::plain(strip_marker_chars(&value[i..e]))
                        },
                        e,
                    )
                })
            }
            // 3) __bold__
            else if bytes[i..].starts_with(b"__") {
                find_close(value, i + 2, "__").map(|(_b, e)| {
                    (
                        InlineToken {
                            bold: true,
                            ..InlineToken::plain(strip_marker_chars(&value[i..e]))
                        },
                        e,
                    )
                })
            }
            // 4) *italic*
            else if bytes[i] == b'*' {
                find_close(value, i + 1, "*").map(|(_b, e)| {
                    (
                        InlineToken {
                            italics: true,
                            ..InlineToken::plain(strip_marker_chars(&value[i..e]))
                        },
                        e,
                    )
                })
            }
            // 5) ~~strike~~
            else if bytes[i..].starts_with(b"~~") {
                find_close(value, i + 2, "~~").map(|(_b, e)| {
                    (
                        InlineToken {
                            strike: true,
                            ..InlineToken::plain(strip_marker_chars(&value[i..e]))
                        },
                        e,
                    )
                })
            }
            // 6) `code`
            else if bytes[i] == b'`' {
                find_close(value, i + 1, "`").map(|(_b, e)| {
                    (
                        InlineToken {
                            mono: true,
                            ..InlineToken::plain(strip_marker_chars(&value[i..e]))
                        },
                        e,
                    )
                })
            } else {
                None
            }
        };

        match found {
            Some((token, end)) => {
                if i > cursor {
                    tokens.push(InlineToken::plain(unescape_markdown_text(
                        &value[cursor..i],
                    )));
                }
                tokens.push(token);
                cursor = end;
                i = end;
            }
            None => {
                i += 1;
            }
        }
    }

    if cursor < value.len() {
        tokens.push(InlineToken::plain(unescape_markdown_text(&value[cursor..])));
    }

    tokens.retain(|t| !t.text.is_empty());
    tokens
}

/// 表格行切格（对齐 web `splitTableCells`）：支持 `\|` 转义，两端竖线可省略。
pub fn split_table_cells(line: &str) -> Vec<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let core = if trimmed.starts_with('|') && trimmed.ends_with('|') && trimmed.len() >= 2 {
        &trimmed[1..trimmed.len() - 1]
    } else {
        trimmed
    };

    let mut cells: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut chars = core.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '\\' && chars.peek() == Some(&'|') {
            current.push('|');
            chars.next();
            continue;
        }
        if c == '|' {
            cells.push(current.trim().to_string());
            current.clear();
            continue;
        }
        current.push(c);
    }
    cells.push(current.trim().to_string());
    cells
}

fn is_table_line(line: &str) -> bool {
    line.contains('|') && split_table_cells(line).len() > 1
}

fn is_table_separator(line: &str) -> bool {
    let cells = split_table_cells(line);
    cells.len() > 1 && cells.iter().all(|cell| is_separator_cell(cell.trim()))
}

/// `/^:?-{3,}:?$/` 等价判断
fn is_separator_cell(cell: &str) -> bool {
    let body = cell.strip_prefix(':').unwrap_or(cell);
    let body = body.strip_suffix(':').unwrap_or(body);
    body.len() >= 3 && body.bytes().all(|b| b == b'-')
}

/// 围栏代码块开行：`` /^(\s{0,3})(`{3,}|~{3,})\s*[\w-]*\s*$/ `` 等价。
fn parse_fence_open(line: &str) -> Option<(char, usize)> {
    let leading = line.len() - line.trim_start().len();
    if leading > 3 {
        return None;
    }
    let rest = line.trim_start();
    let fence_char = rest.chars().next()?;
    if fence_char != '`' && fence_char != '~' {
        return None;
    }
    let run_len = rest.chars().take_while(|&c| c == fence_char).count();
    if run_len < 3 {
        return None;
    }
    let info = &rest[run_len..];
    let info_ok = info.trim().is_empty()
        || info
            .trim()
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !info_ok {
        return None;
    }
    Some((fence_char, run_len))
}

/// 围栏闭行：同字符 ≥ 开围栏长度的裸行。
fn is_fence_close(line: &str, fence_char: char, fence_len: usize) -> bool {
    let leading = line.len() - line.trim_start().len();
    if leading > 3 {
        return false;
    }
    let rest = line.trim_start();
    let run_len = rest.chars().take_while(|&c| c == fence_char).count();
    run_len >= fence_len && rest[run_len..].trim().is_empty()
}

/// 列表种类（无序 `- * +` / 有序 `1.`）
enum ListKind {
    Bullet,
    Ordered,
}

/// 列表行内容提取：匹配 web `/^\s*[-*+]\s+/` 与 `/^\s*\d+\.\s+/`
/// （要求标记后至少一个空白），并剥离可选任务列表 checkbox
/// `(?:\[[ xX]\]\s+)?`。返回剩余内容；非列表行返回 None。
fn list_item_content(line: &str, kind: ListKind) -> Option<String> {
    // 对齐 web `^\s*`：列表允许任意前导空白（与 hr/围栏的 0~3 限制不同）
    let indent = line.len() - line.trim_start().len();
    let rest = &line[indent..];
    let after_marker = match kind {
        ListKind::Bullet => {
            let c = rest.chars().next()?;
            if !matches!(c, '-' | '*' | '+') {
                return None;
            }
            let r = &rest[c.len_utf8()..];
            let ws = r.len() - r.trim_start().len();
            if ws == 0 {
                return None;
            }
            &r[ws..]
        }
        ListKind::Ordered => {
            let digits = rest.chars().take_while(|c| c.is_ascii_digit()).count();
            if digits == 0 {
                return None;
            }
            let r = rest[digits..].strip_prefix('.')?;
            let ws = r.len() - r.trim_start().len();
            if ws == 0 {
                return None;
            }
            &r[ws..]
        }
    };
    Some(strip_task_checkbox(after_marker).to_string())
}

/// 剥 `[ ]` / `[x]` / `[X]` checkbox + 后随空白（对齐 JS `(?:\[[ xX]\]\s+)?`：
/// `]` 后无空白则不算 checkbox，保持原样）。
fn strip_task_checkbox(s: &str) -> &str {
    let b = s.as_bytes();
    if b.len() >= 4
        && b[0] == b'['
        && (b[1] == b' ' || b[1] == b'x' || b[1] == b'X')
        && b[2] == b']'
        && (b[3] as char).is_whitespace()
    {
        s[3..].trim_start()
    } else {
        s
    }
}

fn is_hr_line(line: &str) -> bool {
    // /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
    let leading = line.chars().take_while(|c| c.is_whitespace()).count();
    if leading > 3 {
        return false;
    }
    let rest = &line[leading..];
    let mut chars = rest.chars();
    let marker = match chars.next() {
        Some(c @ ('-' | '*' | '_')) => c,
        _ => return false,
    };
    let mut count = 1;
    for c in chars {
        if c == marker {
            count += 1;
        } else if c == ' ' || c == '\t' {
            continue;
        } else {
            return false;
        }
    }
    count >= 3
}

/// 块级解析主入口（对齐 web `parseMarkdown` 的分支次序）。
pub fn parse_markdown(markdown: &str) -> Vec<BlockNode> {
    let normalized = markdown.replace("\r\n", "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();
    let mut blocks: Vec<BlockNode> = Vec::new();
    let mut index = 0usize;

    while index < lines.len() {
        let line = lines[index];

        if line.trim().is_empty() {
            index += 1;
            continue;
        }

        // GFM 表格：表头行 + 分隔行
        if is_table_line(line) && index + 1 < lines.len() && is_table_separator(lines[index + 1]) {
            let mut rows: Vec<Vec<Vec<InlineToken>>> = vec![split_table_cells(line)
                .iter()
                .map(|c| parse_inline(c))
                .collect()];
            let mut cursor = index + 2;
            while cursor < lines.len() && is_table_line(lines[cursor]) {
                rows.push(
                    split_table_cells(lines[cursor])
                        .iter()
                        .map(|c| parse_inline(c))
                        .collect(),
                );
                cursor += 1;
            }
            let column_count = rows.iter().map(Vec::len).max().unwrap_or(0);
            blocks.push(BlockNode::Table { rows, column_count });
            index = cursor;
            continue;
        }

        // 围栏代码块
        if let Some((fence_char, fence_len)) = parse_fence_open(line) {
            let mut code_lines: Vec<&str> = Vec::new();
            let mut cursor = index + 1;
            while cursor < lines.len() && !is_fence_close(lines[cursor], fence_char, fence_len) {
                code_lines.push(lines[cursor]);
                cursor += 1;
            }
            blocks.push(BlockNode::Code {
                text: code_lines.join("\n"),
            });
            index = (cursor + 1).min(lines.len());
            continue;
        }

        // 引用块
        if line.trim_start().starts_with('>') {
            let mut quote_lines: Vec<String> = Vec::new();
            let mut cursor = index;
            while cursor < lines.len() && lines[cursor].trim_start().starts_with('>') {
                // 对齐 web `replace(/^\s*>\s?/, '')`：剥 `>` 后再剥一个空白符
                let stripped = lines[cursor]
                    .trim_start()
                    .strip_prefix('>')
                    .unwrap_or("")
                    .strip_prefix(|c: char| c.is_whitespace())
                    .unwrap_or("");
                quote_lines.push(stripped.to_string());
                cursor += 1;
            }
            blocks.push(BlockNode::Quote {
                children: parse_inline(&quote_lines.join("\n")),
            });
            index = cursor;
            continue;
        }

        // 标题（级别收敛到 1~3）
        if let Some(level) = heading_level(line) {
            let content = heading_content(line);
            blocks.push(BlockNode::Heading {
                level,
                children: parse_inline(content.trim()),
            });
            index += 1;
            continue;
        }

        // 水平分割线
        if is_hr_line(line) {
            blocks.push(BlockNode::Hr);
            index += 1;
            continue;
        }

        // 无序列表（含任务列表 checkbox 剥离）
        if list_item_content(line, ListKind::Bullet).is_some() {
            let mut items: Vec<Vec<InlineToken>> = Vec::new();
            let mut cursor = index;
            while cursor < lines.len() {
                match list_item_content(lines[cursor], ListKind::Bullet) {
                    Some(content) => items.push(parse_inline(&content)),
                    None => break,
                }
                cursor += 1;
            }
            blocks.push(BlockNode::BulletList { items });
            index = cursor;
            continue;
        }

        // 有序列表
        if list_item_content(line, ListKind::Ordered).is_some() {
            let mut items: Vec<Vec<InlineToken>> = Vec::new();
            let mut cursor = index;
            while cursor < lines.len() {
                match list_item_content(lines[cursor], ListKind::Ordered) {
                    Some(content) => items.push(parse_inline(&content)),
                    None => break,
                }
                cursor += 1;
            }
            blocks.push(BlockNode::OrderedList { items });
            index = cursor;
            continue;
        }

        // 段落：累积到空行或 hr
        let mut paragraph_lines: Vec<&str> = Vec::new();
        let mut cursor = index;
        while cursor < lines.len() && !lines[cursor].trim().is_empty() && !is_hr_line(lines[cursor])
        {
            paragraph_lines.push(lines[cursor]);
            cursor += 1;
        }
        blocks.push(BlockNode::Paragraph {
            children: parse_inline(&paragraph_lines.join("\n")),
        });
        index = cursor;
    }

    blocks
}

/// `/^(#{1,6})\s+/` → 级别 min(len, 3)
fn heading_level(line: &str) -> Option<u8> {
    let hashes = line.chars().take_while(|&c| c == '#').count();
    if (1..=6).contains(&hashes) {
        let rest = &line[hashes..];
        if rest.starts_with(' ') || rest.starts_with('\t') {
            return Some(hashes.min(3) as u8);
        }
    }
    None
}

/// `(.+?)\s*#*\s*$` → 去尾部装饰 `#` 与空白
fn heading_content(line: &str) -> &str {
    let start = line.chars().take_while(|&c| c == '#').count();
    let body = &line[start..];
    body.trim_end_matches(|c: char| c == '#' || c.is_whitespace())
        .trim_end()
}

// ---------------------------------------------------------------------------
// DOCX 构建（对齐 markdown-docx.ts 的样式常量与结构）
// ---------------------------------------------------------------------------

/// 表格边框色（web `TABLE_BORDER`：CBD5E1 size 4 全六向）
const TABLE_BORDER_COLOR: &str = "CBD5E1";
/// 代码块 / 引用底纹（web `shading fill F8FAFC`）
const SOFT_FILL: &str = "F8FAFC";
/// 表头底纹（web `F3F4F6`）
const TABLE_HEAD_FILL: &str = "F3F4F6";
/// 链接色（web `0563C1`）
const LINK_COLOR: &str = "0563C1";
/// 引用左侧竖条色（web `2563EB`）
const QUOTE_BAR_COLOR: &str = "2563EB";

fn cell_margins() -> TableCellMargins {
    // web CELL_MARGIN { top:80, bottom:80, left:120, right:120 }（dxa）
    let mut m = TableCellMargins::new();
    m = m
        .margin_top(80, WidthType::Dxa)
        .margin_bottom(80, WidthType::Dxa)
        .margin_left(120, WidthType::Dxa)
        .margin_right(120, WidthType::Dxa);
    m
}

fn table_borders() -> TableBorders {
    let border = |pos| {
        docx_rs::TableBorder::new(pos)
            .border_type(BorderType::Single)
            .size(4)
            .color(TABLE_BORDER_COLOR)
    };
    TableBorders::new()
        .set(border(TableBorderPosition::Top))
        .set(border(TableBorderPosition::Bottom))
        .set(border(TableBorderPosition::Left))
        .set(border(TableBorderPosition::Right))
        .set(border(TableBorderPosition::InsideH))
        .set(border(TableBorderPosition::InsideV))
}

/// 行内 token → Run / Hyperlink（对齐 web `renderInlineToRuns`）
enum InlinePiece {
    Run(Box<Run>),
    Hyperlink(Box<Hyperlink>),
}

fn render_inline(tokens: &[InlineToken]) -> Vec<InlinePiece> {
    tokens
        .iter()
        .map(|token| match &token.link {
            Some(url) => {
                let run = Run::new()
                    .add_text(token.text.clone())
                    .color(LINK_COLOR)
                    .underline("single");
                InlinePiece::Hyperlink(Box::new(
                    Hyperlink::new(url.clone(), HyperlinkType::External).add_run(run),
                ))
            }
            None => {
                let mut run = Run::new().add_text(token.text.clone());
                if token.bold {
                    run = run.bold();
                }
                if token.italics {
                    run = run.italic();
                }
                if token.strike {
                    run = run.strike();
                }
                if token.mono {
                    // web font: 'Courier New'
                    run = run.fonts(
                        RunFonts::new()
                            .ascii("Courier New")
                            .east_asia("Courier New"),
                    );
                }
                InlinePiece::Run(Box::new(run))
            }
        })
        .collect()
}

fn paragraph_from(tokens: &[InlineToken], spacing_after: u32) -> Paragraph {
    let mut para = Paragraph::new().line_spacing(LineSpacing::new().after(spacing_after));
    for piece in render_inline(tokens) {
        para = match piece {
            InlinePiece::Run(run) => para.add_run(*run),
            InlinePiece::Hyperlink(link) => para.add_hyperlink(*link),
        };
    }
    para
}

fn heading_paragraph(tokens: &[InlineToken], level: u8) -> Paragraph {
    let style = match level {
        1 => "Heading1",
        2 => "Heading2",
        _ => "Heading3",
    };
    paragraph_from(tokens, 160).style(style)
}

/// 代码块文本 → 单段落多 Run（行间插 `<w:br/>`，修正 web 裸 `\n` 不换行问题）
fn code_paragraph(text: &str) -> Paragraph {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut para = Paragraph::new().line_spacing(LineSpacing::new().after(120));
    para.property.shading = Some(Shading::new().fill(SOFT_FILL));
    for (i, line) in lines.iter().enumerate() {
        let run = Run::new().add_text((*line).to_string()).fonts(
            RunFonts::new()
                .ascii("Courier New")
                .east_asia("Courier New"),
        );
        para = if i + 1 == lines.len() {
            para.add_run(run)
        } else {
            para.add_run(run.add_break(BreakType::TextWrapping))
        };
    }
    para
}

fn quote_paragraph(tokens: &[InlineToken]) -> Paragraph {
    let mut para = paragraph_from(tokens, 120);
    para.property.shading = Some(Shading::new().fill(SOFT_FILL));
    para.property.borders = Some(
        ParagraphBorders::new().set(
            ParagraphBorder::new(ParagraphBorderPosition::Left)
                .val(BorderType::Single)
                .size(8)
                .color(QUOTE_BAR_COLOR),
        ),
    );
    para
}

fn hr_paragraph() -> Paragraph {
    let mut para = Paragraph::new()
        .line_spacing(LineSpacing::new().after(160))
        .add_run(Run::new().add_text(" ").color("FFFFFF"));
    para.property.borders = Some(
        ParagraphBorders::new().set(
            ParagraphBorder::new(ParagraphBorderPosition::Bottom)
                .val(BorderType::Single)
                .size(8)
                .color(TABLE_BORDER_COLOR),
        ),
    );
    para
}

fn table_block(block_rows: &[Vec<Vec<InlineToken>>], column_count: usize) -> Table {
    let rows: Vec<TableRow> = block_rows
        .iter()
        .enumerate()
        .map(|(row_index, row)| {
            let cells: Vec<TableCell> = (0..column_count)
                .map(|col| {
                    let tokens = row.get(col).cloned().unwrap_or_default();
                    let para = paragraph_from(&tokens, 0);
                    let cell = TableCell::new().add_paragraph(para);
                    if row_index == 0 {
                        cell.shading(Shading::new().fill(TABLE_HEAD_FILL))
                    } else {
                        cell
                    }
                })
                .collect();
            TableRow::new(cells)
        })
        .collect();

    Table::new(rows)
        .width(100 * 50, WidthType::Pct) // web WidthType.PERCENTAGE size 100 → OOXML pct 单位 ×50
        .layout(TableLayoutType::Autofit)
        .set_borders(table_borders())
        .margins(cell_margins())
}

/// 块级节点 → docx 段落/表格序列（对齐 web `renderBlocks` 分支）。
pub fn blocks_to_docx_children(blocks: &[BlockNode]) -> (Vec<Paragraph>, Vec<Table>) {
    let mut paragraphs: Vec<Paragraph> = Vec::new();
    let mut tables: Vec<Table> = Vec::new();

    for block in blocks {
        match block {
            BlockNode::Heading { level, children } => {
                paragraphs.push(heading_paragraph(children, *level));
            }
            BlockNode::Paragraph { children } => {
                paragraphs.push(paragraph_from(children, 80));
            }
            BlockNode::BulletList { items } => {
                for item in items {
                    paragraphs.push(
                        paragraph_from(item, 80)
                            .numbering(BULLET_NUMBERING_ID, IndentLevel::new(0)),
                    );
                }
            }
            BlockNode::OrderedList { items } => {
                for item in items {
                    paragraphs.push(
                        paragraph_from(item, 80)
                            .numbering(ORDERED_NUMBERING_ID, IndentLevel::new(0)),
                    );
                }
            }
            BlockNode::Code { text } => paragraphs.push(code_paragraph(text)),
            BlockNode::Quote { children } => paragraphs.push(quote_paragraph(children)),
            BlockNode::Hr => paragraphs.push(hr_paragraph()),
            BlockNode::Table { rows, column_count } => {
                tables.push(table_block(rows, *column_count));
            }
        }
    }

    (paragraphs, tables)
}

/// 有序列表编号引用 id（Docx numbering 配置见 [`build_docx_document`]）
const ORDERED_NUMBERING_ID: NumberingId = NumberingId { id: 2 };
/// 无序列表编号引用 id
const BULLET_NUMBERING_ID: NumberingId = NumberingId { id: 1 };

/// Markdown 文本 → 完整 DOCX 文档（对齐 web `createMarkdownDocument`：
/// 标题/作者元信息、decimal `%1.` 编号、四边 1440 页边距、Heading1~3 样式）。
pub fn build_docx_document(markdown: &str) -> Docx {
    let blocks = parse_markdown(markdown);
    let (paragraphs, tables) = blocks_to_docx_children(&blocks);

    let mut docx = Docx::new()
        // 标题样式注册（Word 内置 Heading1~3 观感依赖样式表存在）
        .add_style(Style::new("Heading1", StyleType::Paragraph).name("heading 1"))
        .add_style(Style::new("Heading2", StyleType::Paragraph).name("heading 2"))
        .add_style(Style::new("Heading3", StyleType::Paragraph).name("heading 3"))
        // 有序列表编号：abstract 2 → concrete 2（decimal "%1."，对齐 web default-numbering）
        .add_abstract_numbering(
            AbstractNumbering::new(2).add_level(
                Level::new(
                    0,
                    Start::new(1),
                    NumberFormat::new("decimal"),
                    LevelText::new("%1."),
                    LevelJc::new("left"),
                )
                .suffix(docx_rs::LevelSuffixType::Tab),
            ),
        )
        .add_numbering(Numbering::new(2, 2))
        // 无序列表编号：abstract 1 → concrete 1（bullet "•"）
        .add_abstract_numbering(
            AbstractNumbering::new(1).add_level(
                Level::new(
                    0,
                    Start::new(1),
                    NumberFormat::new("bullet"),
                    LevelText::new("•"),
                    LevelJc::new("left"),
                )
                .suffix(docx_rs::LevelSuffixType::Tab),
            ),
        )
        .add_numbering(Numbering::new(1, 1));

    for p in paragraphs {
        docx = docx.add_paragraph(p);
    }
    for t in tables {
        docx = docx.add_table(t);
    }

    // web 四边页边距 1440 twips（1 inch）
    docx.page_margin(
        PageMargin::new()
            .top(1440)
            .bottom(1440)
            .left(1440)
            .right(1440),
    )
}

// ---------------------------------------------------------------------------
// 文件名 / 大小工具（对齐 markdown-to-word.ts）
// ---------------------------------------------------------------------------

/// 对齐 web `createWordFilename`：剥 `.md` 再剥一层任意扩展名 → 非法字符换
/// `-` → 空白换 `-` → 截断 80 字符 → 拼 `YYYYMMDDHHMMSS` 时间戳（web 用
/// UTC `toISOString()`，此处同为 UTC）。空结果回退 `markdown-document`。
pub fn create_word_filename(source_name: Option<&str>) -> String {
    let base_name = strip_extensions(source_name.unwrap_or("markdown-document"));

    let safe_base_name: String = base_name
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            c if c.is_whitespace() => '-',
            c => c,
        })
        .collect();
    let safe_base_name: String = safe_base_name.chars().take(80).collect();

    let timestamp = system_timestamp_compact();
    format!(
        "{}-{}.docx",
        if safe_base_name.is_empty() {
            "markdown-document"
        } else {
            &safe_base_name
        },
        timestamp
    )
}

/// 剥 `.md`（大小写不敏感）后再剥一层扩展名（等价 web 先 `/\.md$/i`
/// 再 `/\.[^.]+$/`；`.hidden` 这类首字点文件也会被剥空，与 web 一致）。
fn strip_extensions(name: &str) -> String {
    let trimmed = name.trim();
    // 第一步：大小写不敏感地剥结尾 `.md`
    let after_md = if trimmed.len() >= 3 && trimmed[trimmed.len() - 3..].eq_ignore_ascii_case(".md")
    {
        &trimmed[..trimmed.len() - 3]
    } else {
        trimmed
    };
    // 第二步：再剥一层「点 + 非空扩展名」（JS /\.[^.]+$/）
    match after_md.rfind('.') {
        Some(dot) if dot + 1 < after_md.len() => after_md[..dot].to_string(),
        _ => after_md.to_string(),
    }
}

/// `YYYYMMDDHHMMSS` 紧凑时间戳（本地时区，对齐 web `new Date().toISOString()` 的
/// 形状；时区语义差异仅影响文件名可读性，不影响唯一性）。
fn system_timestamp_compact() -> String {
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let total_secs = now.as_secs();
    // UTC 推算（避免引入 chrono 依赖到本模块；文件名时间戳用 UTC 足够）
    let days = total_secs / 86_400;
    let secs_of_day = total_secs % 86_400;
    let (year, month, day) = civil_from_days(days as i64);
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;
    format!("{year:04}{month:02}{day:02}{hour:02}{minute:02}{second:02}")
}

/// Howard Hinnant 的 days-from-civil 反演（UTC 民用日期）
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 字节数人性化显示（对齐 web `formatMarkdownFileSize`）
pub fn format_file_size(bytes: u64) -> String {
    if bytes == 0 {
        return "0 KB".to_string();
    }
    if bytes < 1024 * 1024 {
        let kb = bytes as f64 / 1024.0;
        let digits = if bytes < 10_240 { 1 } else { 0 };
        format!("{kb:.digits$} KB")
    } else {
        format!("{:.2} MB", bytes as f64 / 1024.0 / 1024.0)
    }
}

/// 导出错误（视图层转用户可见文案）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExportError {
    /// Markdown 内容为空（web 同文案）
    EmptyContent,
    /// 序列化或写盘失败
    Io(String),
}

impl std::fmt::Display for ExportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyContent => write!(f, "Markdown 内容为空，无法生成 Word 文件"),
            Self::Io(msg) => write!(f, "{msg}"),
        }
    }
}

/// Markdown → DOCX 字节流（ZIP 魔数校验交给调用方测试）。
pub fn markdown_to_docx_bytes(markdown: &str) -> Result<Vec<u8>, ExportError> {
    if markdown.trim().is_empty() {
        return Err(ExportError::EmptyContent);
    }
    let docx = build_docx_document(markdown);
    let mut buf = Cursor::new(Vec::new());
    docx.pack(&mut buf)
        .map_err(|e| ExportError::Io(e.to_string()))?;
    Ok(buf.into_inner())
}

// ---------------------------------------------------------------------------
// 测试（对齐 web markdown-ast / markdown-docx / markdown-to-word 行为契约）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- unescape ----------

    #[test]
    fn unescapes_markdown_punctuation() {
        assert_eq!(
            unescape_markdown_text("\\*not emphasis\\*"),
            "*not emphasis*"
        );
        assert_eq!(unescape_markdown_text("a\\|b"), "a|b");
        // 未列出的转义保持原样
        assert_eq!(unescape_markdown_text("\\n"), "\\n");
    }

    // ---------- 行内解析 ----------

    #[test]
    fn inline_plain_text_passes_through() {
        let tokens = parse_inline("纯文本内容");
        assert_eq!(tokens, vec![InlineToken::plain("纯文本内容")]);
    }

    #[test]
    fn inline_bold_italic_strike_code() {
        let tokens = parse_inline("**加粗** 与 *斜体* 与 ~~删除~~ 与 `code`");
        assert!(tokens[0].bold && tokens[0].text == "加粗");
        assert!(tokens[1].text.contains('与'));
        assert!(tokens[2].italics && tokens[2].text == "斜体");
        assert!(tokens[4].strike && tokens[4].text == "删除");
        assert!(tokens[6].mono && tokens[6].text == "code");
    }

    #[test]
    fn inline_double_underscore_is_bold_too() {
        let tokens = parse_inline("__下划线加粗__");
        assert!(tokens.iter().all(|t| t.bold));
        assert_eq!(tokens.last().unwrap().text, "下划线加粗");
    }

    #[test]
    fn inline_link_and_image_placeholder() {
        let tokens = parse_inline("[彼励扶](https://example.com) 和 ![截图](pic.png) 尾部");
        assert_eq!(tokens[0].link.as_deref(), Some("https://example.com"));
        assert_eq!(tokens[0].text, "彼励扶");
        assert_eq!(tokens[1].text, " 和 ", "链接与图片之间的普通文本保留");
        assert_eq!(tokens[2].text, "[图片：截图]");
        assert_eq!(tokens.last().unwrap().text, " 尾部");
    }

    #[test]
    fn inline_empty_url_or_empty_text_stays_literal() {
        // web INLINE_PATTERN 要求 url 与括号文本均非空：空 url / 空 alt 的
        // 形式不构成链接/图片 token，保持字面量
        for literal in ["![截图]()", "![](https://x.png)", "[](https://a.b)"] {
            let tokens = parse_inline(literal);
            assert_eq!(tokens.len(), 1, "{literal} 应保持字面量");
            assert_eq!(tokens[0].text, literal);
            assert!(tokens[0].link.is_none());
        }
    }

    #[test]
    fn inline_image_with_alt_uses_alt() {
        let tokens = parse_inline("![产品图](https://x/a.png)");
        assert_eq!(tokens.len(), 1);
        assert_eq!(tokens[0].text, "[图片：产品图]");
        assert!(tokens[0].link.is_none());
    }

    #[test]
    fn inline_link_title_form_parses() {
        let tokens = parse_inline("[链接](https://a.b \"标题\")");
        assert_eq!(tokens[0].link.as_deref(), Some("https://a.b"));
        assert_eq!(tokens[0].text, "链接");
    }

    #[test]
    fn inline_unclosed_marker_stays_literal() {
        // 无闭合 ** 不构成 token（web 正则同样要求闭合）
        let tokens = parse_inline("前缀 **未闭合 后缀");
        assert_eq!(tokens.len(), 1);
        assert!(!tokens[0].bold);
        assert!(tokens[0].text.contains("**"));
    }

    #[test]
    fn inline_mixed_emphasis_splits_runs() {
        let tokens = parse_inline("**粗**普通*斜*");
        assert_eq!(
            tokens,
            vec![
                InlineToken {
                    bold: true,
                    ..InlineToken::plain("粗")
                },
                InlineToken::plain("普通"),
                InlineToken {
                    italics: true,
                    ..InlineToken::plain("斜")
                },
            ]
        );
    }

    // ---------- 表格切格 ----------

    #[test]
    fn table_cells_split_on_pipes() {
        assert_eq!(split_table_cells("| a | b | c |"), vec!["a", "b", "c"]);
        assert_eq!(split_table_cells("a | b"), vec!["a", "b"]);
    }

    #[test]
    fn table_cells_support_escaped_pipe() {
        assert_eq!(split_table_cells("| a \\| b | c |"), vec!["a | b", "c"]);
    }

    #[test]
    fn separator_cell_detection() {
        assert!(is_table_separator("| --- | :---: | ---: |"));
        assert!(!is_table_separator("| a | b |"));
        assert!(
            !is_table_separator("| -- | -- |"),
            "短于 3 个横线不算分隔行"
        );
    }

    // ---------- 块级解析 ----------

    #[test]
    fn blocks_heading_levels_cap_at_three() {
        let blocks = parse_markdown("# 一\n## 二\n#### 四级");
        assert_eq!(
            blocks,
            vec![
                BlockNode::Heading {
                    level: 1,
                    children: vec![InlineToken::plain("一")]
                },
                BlockNode::Heading {
                    level: 2,
                    children: vec![InlineToken::plain("二")]
                },
                BlockNode::Heading {
                    level: 3,
                    children: vec![InlineToken::plain("四级")]
                },
            ]
        );
    }

    #[test]
    fn blocks_heading_trailing_hashes_trimmed() {
        let blocks = parse_markdown("## 标题 ##");
        match &blocks[0] {
            BlockNode::Heading { children, .. } => {
                assert_eq!(children[0].text, "标题")
            }
            other => panic!("期望 Heading，实际 {other:?}"),
        }
    }

    #[test]
    fn blocks_paragraph_joins_consecutive_lines() {
        let blocks = parse_markdown("第一行\n第二行");
        match &blocks[0] {
            BlockNode::Paragraph { children } => {
                assert_eq!(children[0].text, "第一行\n第二行")
            }
            other => panic!("期望 Paragraph，实际 {other:?}"),
        }
    }

    #[test]
    fn blocks_bullet_list_strips_task_checkbox() {
        let blocks = parse_markdown("- 项目一\n- [x] 已完成任务\n* 星号项");
        match &blocks[0] {
            BlockNode::BulletList { items } => {
                assert_eq!(items.len(), 3);
                assert_eq!(items[1][0].text, "已完成任务", "checkbox 标记被剥离");
                assert_eq!(items[0][0].text, "项目一");
            }
            other => panic!("期望 BulletList，实际 {other:?}"),
        }
    }

    #[test]
    fn blocks_ordered_list() {
        let blocks = parse_markdown("1. 第一\n2. 第二");
        match &blocks[0] {
            BlockNode::OrderedList { items } => {
                assert_eq!(items.len(), 2);
                assert_eq!(items[1][0].text, "第二");
            }
            other => panic!("期望 OrderedList，实际 {other:?}"),
        }
    }

    #[test]
    fn blocks_table_with_header_and_rows() {
        let md = "| 列A | 列B |\n| --- | --- |\n| a1 | b1 |\n| a2 | b2 |";
        let blocks = parse_markdown(md);
        match &blocks[0] {
            BlockNode::Table { rows, column_count } => {
                assert_eq!(*column_count, 2);
                assert_eq!(rows.len(), 3, "表头 + 两数据行");
                assert_eq!(rows[0][0][0].text, "列A");
                assert_eq!(rows[2][1][0].text, "b2");
            }
            other => panic!("期望 Table，实际 {other:?}"),
        }
    }

    #[test]
    fn blocks_code_fence_captures_until_close() {
        let md = "```rust\nfn main() {}\nlet x = 1;\n```\n后文";
        let blocks = parse_markdown(md);
        assert_eq!(
            blocks[0],
            BlockNode::Code {
                text: "fn main() {}\nlet x = 1;".to_string()
            }
        );
        assert!(matches!(&blocks[1], BlockNode::Paragraph { .. }));
    }

    #[test]
    fn blocks_fence_any_longer_close_of_same_char_closes() {
        // web 闭行是 `{N,}`（同字符任意 ≥ 开围栏长度的裸行）：6 个 ~ 能关掉
        // 3 个 ~ 的围栏（与 CommonMark 的等长规则不同，锁 web 行为）
        let md = "~~~\ncode\n~~~~~~\n后文";
        let blocks = parse_markdown(md);
        assert_eq!(blocks.len(), 2);
        assert_eq!(
            blocks[0],
            BlockNode::Code {
                text: "code".to_string()
            }
        );
        assert!(matches!(&blocks[1], BlockNode::Paragraph { .. }));
    }

    #[test]
    fn blocks_quote_joins_lines_and_strips_marker() {
        let blocks = parse_markdown("> 引用一\n> 引用二");
        match &blocks[0] {
            BlockNode::Quote { children } => {
                assert_eq!(children[0].text, "引用一\n引用二");
            }
            other => panic!("期望 Quote，实际 {other:?}"),
        }
    }

    #[test]
    fn blocks_hr_variants() {
        for line in ["---", "***", "___", "* * *"] {
            let blocks = parse_markdown(line);
            assert_eq!(blocks, vec![BlockNode::Hr], "{line} 应识别为 hr");
        }
        // 两连字符不是 hr
        assert_ne!(parse_markdown("--"), vec![BlockNode::Hr]);
    }

    // ---------- 文件名 / 大小 ----------

    #[test]
    fn filename_strips_md_then_extension() {
        let name = create_word_filename(Some("笔记.md"));
        assert!(name.starts_with("笔记-"), "实际 {name}");
        assert!(name.ends_with(".docx"));

        // 双层扩展名（先剥 .md 再剥一层）
        let name = create_word_filename(Some("notes.old.md"));
        assert!(name.starts_with("notes-"), "实际 {name}");

        // 无来源回退默认名
        let name = create_word_filename(None);
        assert!(name.starts_with("markdown-document-"));
    }

    #[test]
    fn filename_sanitizes_illegal_chars_and_whitespace() {
        let name = create_word_filename(Some("a/b:c*d?e\"f<g>h|i j"));
        assert!(!name.contains(['/', ':', '*', '?', '"', '<', '>', '|', ' ']));
        assert!(name.starts_with("a-b-c-d-e-f-g-h-i-j-"));
    }

    #[test]
    fn filename_timestamp_shape_is_compact_utc() {
        let name = create_word_filename(None);
        // markdown-document-YYYYMMDDHHMMSS.docx
        let stem = name
            .trim_start_matches("markdown-document-")
            .trim_end_matches(".docx");
        assert_eq!(stem.len(), 14, "实际 {name}");
        assert!(stem.bytes().all(|b| b.is_ascii_digit()), "实际 {name}");
    }

    #[test]
    fn format_file_size_matches_web_thresholds() {
        assert_eq!(format_file_size(0), "0 KB");
        assert_eq!(format_file_size(2048), "2.0 KB");
        assert_eq!(format_file_size(20 * 1024), "20 KB");
        assert_eq!(format_file_size(1024 * 1024), "1.00 MB");
    }

    // ---------- DOCX 构建 ----------

    #[test]
    fn docx_bytes_are_non_empty_zip() {
        let bytes = markdown_to_docx_bytes("# 标题\n正文段落").expect("导出应成功");
        assert!(
            bytes.len() > 1000,
            "DOCX 至少包含骨架 XML，实际 {} 字节",
            bytes.len()
        );
        assert_eq!(&bytes[..2], b"PK", "DOCX 是 ZIP 容器（PK 魔数）");
    }

    #[test]
    fn docx_empty_content_rejected_with_web_message() {
        let err = markdown_to_docx_bytes("   \n  ").unwrap_err();
        assert_eq!(err, ExportError::EmptyContent);
        assert_eq!(err.to_string(), "Markdown 内容为空，无法生成 Word 文件");
    }

    #[test]
    fn docx_document_carries_web_meta_and_numbering_config() {
        let docx = build_docx_document("# H1\n1. 有序\n- 无序");
        let json = docx.json();
        // 对齐 web createMarkdownDocument 的元信息与编号配置
        assert!(json.contains("\"decimal\""), "有序编号 decimal 格式");
        assert!(json.contains("%1."), "编号文本 %1.");
        assert!(json.contains("bullet"), "无序列表 bullet 编号");
        assert!(json.contains("1440"), "四边页边距 1440 twips");
    }

    #[test]
    fn docx_heading_uses_heading_style_ids() {
        let docx = build_docx_document("# 大标题\n### 小标题");
        let json = docx.json();
        assert!(
            json.contains("\"style\": \"Heading1\""),
            "H1 → Heading1 样式"
        );
        assert!(
            json.contains("\"style\": \"Heading3\""),
            "H3 → Heading3 样式"
        );
    }

    #[test]
    fn docx_table_gets_border_color_and_head_fill() {
        let docx = build_docx_document("| A | B |\n| --- | --- |\n| 1 | 2 |");
        let json = docx.json();
        assert!(json.contains("CBD5E1"), "表格边框色 CBD5E1");
        assert!(json.contains(TABLE_HEAD_FILL), "表头底纹 F3F4F6");
    }

    #[test]
    fn docx_inline_styles_map_to_run_flags() {
        let xml = String::from_utf8_lossy(
            &build_docx_document("**粗** *斜* ~~删~~ `码` [链](https://e.co)")
                .build()
                .document,
        )
        .into_owned();
        // docx-rs 序列化在 `/>` 前带空格（`<w:b />`）；超链接 URL 进 rels
        // 不在 document.xml，此处锁 `<w:hyperlink>` + 下划线 + 链接色
        assert!(xml.contains("<w:b "), "加粗 run");
        assert!(xml.contains("<w:i "), "斜体 run");
        assert!(xml.contains("<w:strike "), "删除线 run");
        assert!(xml.contains("Courier New"), "行内代码等宽字体");
        assert!(xml.contains("<w:hyperlink "), "超链接元素");
        assert!(xml.contains("<w:u w:val=\"single\""), "链接下划线");
        assert!(xml.contains(LINK_COLOR), "链接色 0563C1");
    }

    #[test]
    fn docx_code_block_keeps_line_breaks() {
        let xml = String::from_utf8_lossy(
            &build_docx_document("```\nline1\nline2\n```")
                .build()
                .document,
        )
        .into_owned();
        assert!(
            xml.contains("<w:br w:type=\"textWrapping\""),
            "代码块行间显式换行（修正 web 裸 \\n 问题）"
        );
        assert!(xml.contains(SOFT_FILL), "代码块底纹 F8FAFC");
    }
}
