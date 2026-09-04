# Markdown 转 PDF 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在已有的 “Markdown 转 Word” 页面新增 “下载 PDF” 按钮，使用矢量文字渲染，支持中文，不分页。

**架构：** 把 Markdown 解析抽出共享 AST，`markdown-docx.ts` 与新 `markdown-pdf.ts` 都基于该 AST。新增 `pdf-lib` 依赖，前端运行时加载本地中文字体（思源黑体 Regular），手动布局每一块并按内容总高度设置单一 PDF 页面尺寸。

**技术栈：** `pdf-lib`、内嵌 `Noto Sans SC` OTF 字体、共享 AST（块级 + 内联 token）。

---

## 文件结构

- 新增：`frontend/app/dashboard/special/markdown-to-word/lib/markdown-ast.ts`
  - 类型定义（块、内联 token）和共享 `parseMarkdown` 解析函数。
- 修改：`frontend/app/dashboard/special/markdown-to-word/lib/markdown-docx.ts`
  - 改为基于 AST 渲染 DOCX（保持现有行为不变）。
- 新增：`frontend/app/dashboard/special/markdown-to-word/lib/markdown-pdf.ts`
  - 基于 AST 渲染单页矢量 PDF，包含 `markdownToPdf(markdown): Promise<Blob>`。
- 新增：`frontend/public/fonts/NotoSansSC-Regular.otf`
  - 思源黑体 Regular（运行时通过 `fetch` 加载）。
- 修改：`frontend/app/dashboard/special/markdown-to-word/markdown-to-word-client.tsx`
  - 新增 “下载 PDF” 按钮、loading、错误提示，复用现有统计。
- 一次性临时测试：`frontend/lib/__tests__/markdown-pdf.test.ts`（结束后删除）

---

## 任务 1：添加 pdf-lib 依赖

**文件：**
- 修改：`frontend/package.json`
- 修改：`frontend/pnpm-lock.yaml`

- [ ] **步骤 1：安装依赖**

```bash
cd frontend && pnpm add pdf-lib
```

预期：成功，`pdf-lib` 加入 `dependencies`。

- [ ] **步骤 2：提交**

```bash
git add frontend/package.json frontend/pnpm-lock.yaml
git commit -m "chore: 添加 pdf-lib 依赖用于 Markdown 转 PDF"
```

---

## 任务 2：准备中文字体文件

**文件：**
- 新增：`frontend/public/fonts/NotoSansSC-Regular.otf`

- [ ] **步骤 1：下载思源黑体**

```bash
mkdir -p frontend/public/fonts
curl -L -o frontend/public/fonts/NotoSansSC-Regular.otf \
  "https://github.com/notofonts/noto-cjk/raw/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf"
ls -lh frontend/public/fonts/NotoSansSC-Regular.otf
```

预期：文件存在，大小约 10–20 MB。

> 如网络受限，可手动将 OTF 字体放入该路径。

- [ ] **步骤 2：提交字体文件**

```bash
git add frontend/public/fonts/NotoSansSC-Regular.otf
git commit -m "chore: 引入 Noto Sans SC 中文字体供 PDF 生成使用"
```

---

## 任务 3：抽取共享 Markdown AST

**文件：**
- 新增：`frontend/app/dashboard/special/markdown-to-word/lib/markdown-ast.ts`

- [ ] **步骤 1：写入 AST 模块**

```ts
export type InlineToken = {
  text: string
  bold?: boolean
  italics?: boolean
  strike?: boolean
  font?: string
  link?: string
}

export type BlockNode =
  | { type: 'heading'; level: 1 | 2 | 3; children: InlineToken[] }
  | { type: 'paragraph'; children: InlineToken[] }
  | { type: 'bulletList'; items: InlineToken[][] }
  | { type: 'orderedList'; items: InlineToken[][] }
  | { type: 'table'; rows: InlineToken[][][]; columnCount: number }
  | { type: 'code'; text: string }
  | { type: 'quote'; children: InlineToken[] }
  | { type: 'hr' }

const INLINE_PATTERN =
  /(!?\[[^\]]+\]\([^)\s]+(?:\s+"[^"]*")?\)|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|~~[^~]+~~|`[^`]+`)/g

export function unescapeMarkdownText(value: string): string {
  return value.replace(/\\([\\`*_{}\[\]()#+.!|-])/g, '$1')
}

export function parseInline(value: string): InlineToken[] {
  const tokens: InlineToken[] = []
  let cursor = 0
  value.replace(INLINE_PATTERN, (match, _full, offset: number) => {
    if (offset > cursor) tokens.push({ text: unescapeMarkdownText(value.slice(cursor, offset)) })
    const imageMatch = match.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/)
    if (imageMatch) {
      const alt = imageMatch[1].trim() || '图片'
      tokens.push({ text: `[图片：${alt}]` })
      cursor = offset + match.length
      return match
    }
    const linkMatch = match.match(/^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/)
    if (linkMatch) {
      tokens.push({ text: linkMatch[1], link: linkMatch[2] })
      cursor = offset + match.length
      return match
    }
    const body = match.replace(/^[*_~`]+|[*_~`]+$/g, '')
    if (match.startsWith('**') || match.startsWith('__')) tokens.push({ text: body, bold: true })
    else if (match.startsWith('*')) tokens.push({ text: body, italics: true })
    else if (match.startsWith('~~')) tokens.push({ text: body, strike: true })
    else if (match.startsWith('`')) tokens.push({ text: body, font: 'Courier New' })
    cursor = offset + match.length
    return match
  })
  if (cursor < value.length) tokens.push({ text: unescapeMarkdownText(value.slice(cursor)) })
  return tokens.filter((t) => t.text.length > 0)
}

function splitTableCells(line: string): string[] {
  const trimmed = line.trim()
  if (!trimmed) return []
  const core = trimmed.startsWith('|') && trimmed.endsWith('|') ? trimmed.slice(1, -1) : trimmed
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < core.length; i += 1) {
    if (core[i] === '\\' && core[i + 1] === '|') { cur += '|'; i += 1; continue }
    if (core[i] === '|') { cells.push(cur.trim()); cur = ''; continue }
    cur += core[i]
  }
  cells.push(cur.trim())
  return cells
}

function isTableLine(line: string) {
  return line.includes('|') && splitTableCells(line).length > 1
}
function isTableSeparator(line: string) {
  const cells = splitTableCells(line)
  return cells.length > 1 && cells.every((c) => /^:?-{3,}:?$/.test(c.trim()))
}

export function parseMarkdown(markdown: string): BlockNode[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const blocks: BlockNode[] = []

  for (let i = 0; i < lines.length; ) {
    const line = lines[i]

    if (line.trim() === '') { i += 1; continue }

    // Table
    if (isTableLine(line) && isTableSeparator(lines[i + 1] ?? '')) {
      const rows: InlineToken[][][] = []
      let j = i + 2
      while (j < lines.length && isTableLine(lines[j])) {
        rows.push(splitTableCells(lines[j]).map(parseInline))
        j += 1
      }
      const rowsWithHeader = [splitTableCells(line).map(parseInline), ...rows]
      const columnCount = rowsWithHeader.reduce((m, r) => Math.max(m, r.length), 0)
      blocks.push({ type: 'table', rows: rowsWithHeader, columnCount })
      i = j
      continue
    }

    // Code fence
    const fence = line.match(/^(\s{0,3})(`{3,}|~{3,})\s*[\w-]*\s*$/)
    if (fence) {
      const ch = fence[2][0]
      const len = fence[2].length
      const close = new RegExp(`^\\s{0,3}${ch}{${len},}\\s*$`)
      const codeLines: string[] = []
      let j = i + 1
      while (j < lines.length && !close.test(lines[j])) { codeLines.push(lines[j]); j += 1 }
      blocks.push({ type: 'code', text: codeLines.join('\n') })
      i = Math.min(j + 1, lines.length)
      continue
    }

    // Quote
    if (/^\s*>/.test(line)) {
      const quoteLines: string[] = []
      let j = i
      while (j < lines.length && /^\s*>/.test(lines[j])) {
        quoteLines.push(lines[j].replace(/^\s*>\s?/, ''))
        j += 1
      }
      blocks.push({ type: 'quote', children: parseInline(quoteLines.join('\n')) })
      i = j
      continue
    }

    // Heading
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (heading) {
      const level = Math.min(heading[1].length, 3) as 1 | 2 | 3
      blocks.push({ type: 'heading', level, children: parseInline(heading[2].trim()) })
      i += 1
      continue
    }

    // Horizontal rule
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ type: 'hr' })
      i += 1
      continue
    }

    // Bullet list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: InlineToken[][] = []
      let j = i
      while (j < lines.length && /^\s*[-*+]\s+/.test(lines[j])) {
        items.push(parseInline(lines[j].replace(/^\s*[-*+]\s+(?:\[[ xX]\]\s+)?/, '')))
        j += 1
      }
      blocks.push({ type: 'bulletList', items })
      i = j
      continue
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: InlineToken[][] = []
      let j = i
      while (j < lines.length && /^\s*\d+\.\s+/.test(lines[j])) {
        items.push(parseInline(lines[j].replace(/^\s*\d+\.\s+(?:\[[ xX]\]\s+)?/, '')))
        j += 1
      }
      blocks.push({ type: 'orderedList', items })
      i = j
      continue
    }

    // Paragraph
    const paragraphLines: string[] = []
    let j = i
    while (j < lines.length && lines[j].trim() !== '' && !/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(lines[j])) {
      paragraphLines.push(lines[j])
      j += 1
    }
    blocks.push({ type: 'paragraph', children: parseInline(paragraphLines.join('\n')) })
    i = j
  }

  return blocks
}
```

- [ ] **步骤 2：提交**

```bash
git add frontend/app/dashboard/special/markdown-to-word/lib/markdown-ast.ts
git commit -m "refactor: 抽取共享 Markdown AST 供 DOCX 与 PDF 共用"
```

---

## 任务 4：让 markdown-docx.ts 使用 AST

**文件：**
- 修改：`frontend/app/dashboard/special/markdown-to-word/lib/markdown-docx.ts`

- [ ] **步骤 1：重写为基于 AST 的渲染**

将 `markdown-docx.ts` 顶部改为：

```ts
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  LevelSuffix,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  UnderlineType,
  VerticalAlignTable,
  WidthType,
} from 'docx'
import type { BlockNode, InlineToken } from './markdown-ast'
import { parseInline, parseMarkdown, unescapeMarkdownText } from './markdown-ast'
```

删除原 `parseInlineMarkdown`、`createMarkdownParagraph`、`markdownToDocxParagraphs` 及所有块级正则函数。保留 `TABLE_BORDER`、`CELL_MARGIN`、`TABLE_WIDTH` 常量。

新增 `renderInlineToRuns(tokens: InlineToken[]): (TextRun | ExternalHyperlink)[]`：

```ts
function renderInlineToRuns(tokens: InlineToken[]) {
  return tokens.map((t) => {
    if (t.link) {
      return new ExternalHyperlink({
        link: t.link,
        children: [
          new TextRun({ text: t.text, color: '0563C1', underline: { type: UnderlineType.SINGLE, color: '0563C1' } }),
        ],
      })
    }
    return new TextRun({ text: t.text, bold: t.bold, italics: t.italics, strike: t.strike, font: t.font })
  })
}
```

新增 `renderBlocks(blocks: BlockNode[]): (Paragraph | Table)[]`：

```ts
function renderBlocks(blocks: BlockNode[]): (Paragraph | Table)[] {
  const result: (Paragraph | Table)[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'heading':
        result.push(new Paragraph({
          children: renderInlineToRuns(block.children),
          heading: block.level === 1 ? HeadingLevel.HEADING_1 : block.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
          spacing: { after: 160 },
        }))
        break
      case 'paragraph':
        result.push(new Paragraph({ children: renderInlineToRuns(block.children), spacing: { after: 80 } }))
        break
      case 'bulletList':
        for (const item of block.items) {
          result.push(new Paragraph({ children: renderInlineToRuns(item), bullet: { level: 0 }, spacing: { after: 80 } }))
        }
        break
      case 'orderedList':
        for (const item of block.items) {
          result.push(new Paragraph({ children: renderInlineToRuns(item), numbering: { reference: 'default-numbering', level: 0 }, spacing: { after: 80 } }))
        }
        break
      case 'code':
        result.push(new Paragraph({
          children: [new TextRun({ text: block.text, font: 'Courier New' })],
          spacing: { after: 120 },
          shading: { fill: 'F8FAFC', type: ShadingType.CLEAR },
        }))
        break
      case 'quote':
        result.push(new Paragraph({
          children: renderInlineToRuns(block.children),
          border: { left: { style: BorderStyle.SINGLE, color: '2563EB', size: 8, space: 8 } },
          shading: { fill: 'F8FAFC', type: ShadingType.CLEAR },
          spacing: { after: 120 },
        }))
        break
      case 'hr':
        result.push(new Paragraph({
          children: [new TextRun({ text: ' ', color: 'FFFFFF' })],
          border: { bottom: { style: BorderStyle.SINGLE, color: 'CBD5E1', size: 8 } },
          spacing: { after: 160 },
        }))
        break
      case 'table': {
        const rows = block.rows.map((row, rowIndex) => {
          const cells = Array.from({ length: block.columnCount }, (_, col) => new TableCell({
            children: [new Paragraph({ children: renderInlineToRuns(row[col] ?? []), spacing: { after: 0 } })],
            shading: rowIndex === 0 ? { fill: 'F3F4F6', type: ShadingType.CLEAR } : undefined,
            margins: CELL_MARGIN,
          }))
          return new TableRow({ children: cells })
        })
        result.push(new Table({ rows, width: TABLE_WIDTH, layout: TableLayoutType.AUTOFIT, borders: TABLE_BORDER, margins: CELL_MARGIN }))
        break
      }
    }
  }
  return result
}
```

最终：

```ts
export function markdownToDocxChildren(markdown: string): (Paragraph | Table)[] {
  return renderBlocks(parseMarkdown(markdown))
}

export function createMarkdownDocument(markdown: string): Document { /* 同前，但 children: markdownToDocxChildren(markdown) */ }

export async function createMarkdownDocxBlob(markdown: string): Promise<Blob> {
  if (!markdown.trim()) throw new Error('Markdown 内容为空，无法生成 Word 文件')
  return Packer.toBlob(createMarkdownDocument(markdown))
}
```

- [ ] **步骤 2：运行回归测试**

临时创建 `frontend/lib/__tests__/markdown-docx.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { Packer } from 'docx'
import JSZip from 'jszip'
import { createMarkdownDocument } from '@/app/dashboard/special/markdown-to-word/lib/markdown-docx'

async function readXml(md: string) {
  const buf = await Packer.toBuffer(createMarkdownDocument(md))
  const zip = await JSZip.loadAsync(buf)
  return zip.file('word/document.xml')!.async('text')
}

describe('docx regression', () => {
  it('converts tables', async () => {
    const xml = await readXml('| 商品 | 销售额 |\n|---|---:|\n| A | 100 |')
    expect(xml).toContain('<w:tbl>')
    expect(xml).not.toContain('商品 | 销售额')
  })
  it('converts links', async () => {
    const xml = await readXml('访问 [BelieveBoy](https://believeboy.com) 后台')
    expect(xml).toContain('BelieveBoy')
    expect(xml).not.toContain('[BelieveBoy]')
  })
})
```

```bash
cd frontend && pnpm exec vitest run lib/__tests__/markdown-docx.test.ts --config vitest.config.ts
rm frontend/lib/__tests__/markdown-docx.test.ts && rmdir frontend/lib/__tests__ 2>/dev/null || true
```

预期：两测试通过。

- [ ] **步骤 3：lint + build**

```bash
cd frontend && pnpm lint && pnpm build
```

预期：0 errors，构建成功。

- [ ] **步骤 4：提交**

```bash
git add frontend/app/dashboard/special/markdown-to-word/lib/markdown-docx.ts
git commit -m "refactor: 基于共享 AST 重写 DOCX 渲染"
```

---

## 任务 5：实现 Markdown 转 PDF

**文件：**
- 新增：`frontend/app/dashboard/special/markdown-to-word/lib/markdown-pdf.ts`

- [ ] **步骤 1：写入 PDF 生成模块**

```ts
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib'
import type { BlockNode, InlineToken } from './markdown-ast'
import { parseMarkdown } from './markdown-ast'

const PAGE_WIDTH = 595.28
const MARGIN_X = 56
const MARGIN_TOP = 56
const MARGIN_BOTTOM = 56
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2
const LINE_HEIGHT_RATIO = 1.45
const COLOR_TEXT = rgb(0.12, 0.16, 0.22)
const COLOR_RULE = rgb(0.78, 0.82, 0.88)
const COLOR_TABLE_BORDER = rgb(0.72, 0.76, 0.82)
const COLOR_TABLE_HEAD = rgb(0.94, 0.95, 0.97)
const COLOR_QUOTE_BAR = rgb(0.15, 0.39, 0.92)
const COLOR_CODE_BG = rgb(0.96, 0.97, 0.99)

type RenderContext = {
  page: PDFPage
  font: PDFFont
  fontMono: PDFFont
  y: number
}

function wrapLine(text: string, font: PDFFont, fontSize: number, maxWidth: number): string[] {
  if (!text) return ['']
  if (maxWidth <= 0) return [text]
  const lines: string[] = []
  let current = ''
  for (const ch of text) {
    const test = current + ch
    const width = font.widthOfTextAtSize(test, fontSize)
    if (width > maxWidth && current.length > 0) {
      lines.push(current)
      current = ch
    } else {
      current = test
    }
  }
  if (current.length > 0) lines.push(current)
  return lines
}

function drawInline(
  ctx: RenderContext,
  tokens: InlineToken[],
  x: number,
  y: number,
  maxWidth: number,
  fontSize: number,
): number {
  let cursorX = x
  let cursorY = y
  const lineHeight = fontSize * LINE_HEIGHT_RATIO
  type Segment = { text: string; font: PDFFont; width: number }
  const segments: Segment[] = []

  for (const token of tokens) {
    const isMono = token.font === 'Courier New'
    const font = isMono ? ctx.fontMono : ctx.font
    const text = token.text
    if (!text) continue
    const parts = text.split('\n')
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i]
      if (part) {
        for (const wrapped of wrapLine(part, font, fontSize, maxWidth - (cursorX - x))) {
          const width = font.widthOfTextAtSize(wrapped, fontSize)
          if (cursorX + width > x + maxWidth) {
            cursorX = x
            cursorY -= lineHeight
          }
          segments.push({ text: wrapped, font, width })
          cursorX += width
        }
      }
      if (i < parts.length - 1) {
        cursorX = x
        cursorY -= lineHeight
      }
    }
  }

  for (const seg of segments) {
    ctx.page.drawText(seg.text, {
      x: cursorX - seg.width,
      y: cursorY,
      size: fontSize,
      font: seg.font,
      color: COLOR_TEXT,
    })
  }

  return cursorY - lineHeight
}

export async function markdownToPdf(markdown: string): Promise<Blob> {
  if (!markdown.trim()) throw new Error('Markdown 内容为空，无法生成 PDF')

  const ast = parseMarkdown(markdown)
  const pdf = await PDFDocument.create()
  pdf.setTitle('Markdown 转 PDF')
  pdf.setCreator('BelieveBoy Dashboard')

  const fontBytes = await fetch('/fonts/NotoSansSC-Regular.otf').then((r) => r.arrayBuffer())
  const font = await pdf.embedFont(fontBytes, { subset: false })
  const fontMono = await pdf.embedFont(StandardFonts.Courier)

  const page = pdf.addPage([PAGE_WIDTH, 1000])
  const ctx: RenderContext = {
    page,
    font,
    fontMono,
    y: 1000 - MARGIN_TOP,
  }

  for (const block of ast) {
    if (block.type === 'heading') {
      const size = block.level === 1 ? 22 : block.level === 2 ? 18 : 15
      ctx.y = drawInline(ctx, block.children, MARGIN_X, ctx.y, CONTENT_WIDTH, size)
      ctx.y -= 6
    } else if (block.type === 'paragraph') {
      ctx.y = drawInline(ctx, block.children, MARGIN_X, ctx.y, CONTENT_WIDTH, 12)
      ctx.y -= 4
    } else if (block.type === 'bulletList' || block.type === 'orderedList') {
      block.items.forEach((item, idx) => {
        const prefix = block.type === 'bulletList' ? '• ' : `${idx + 1}. `
        const prefixWidth = ctx.font.widthOfTextAtSize(prefix, 12)
        ctx.page.drawText(prefix, { x: MARGIN_X, y: ctx.y, size: 12, font: ctx.font, color: COLOR_TEXT })
        ctx.y = drawInline(ctx, item, MARGIN_X + prefixWidth + 4, ctx.y, CONTENT_WIDTH - prefixWidth - 4, 12)
        ctx.y -= 2
      })
      ctx.y -= 4
    } else if (block.type === 'code') {
      const padding = 8
      const codeLines = block.text.split('\n')
      const maxLineWidth = Math.max(...codeLines.map((l) => ctx.fontMono.widthOfTextAtSize(l, 11)))
      const boxWidth = Math.min(CONTENT_WIDTH, maxLineWidth + padding * 2)
      const boxHeight = codeLines.length * 11 * LINE_HEIGHT_RATIO + padding * 2
      ctx.y -= boxHeight
      ctx.page.drawRectangle({ x: MARGIN_X, y: ctx.y, width: boxWidth, height: boxHeight, color: COLOR_CODE_BG })
      let lineY = ctx.y + boxHeight - padding - 11
      for (const line of codeLines) {
        ctx.page.drawText(line, { x: MARGIN_X + padding, y: lineY, size: 11, font: ctx.fontMono, color: COLOR_TEXT })
        lineY -= 11 * LINE_HEIGHT_RATIO
      }
      ctx.y -= 8
    } else if (block.type === 'quote') {
      const barWidth = 3
      const padding = 10
      ctx.y = drawInline(ctx, block.children, MARGIN_X + barWidth + padding, ctx.y, CONTENT_WIDTH - barWidth - padding, 12)
      ctx.page.drawRectangle({ x: MARGIN_X, y: ctx.y + 8, width: barWidth, height: 14, color: COLOR_QUOTE_BAR })
      ctx.y -= 4
    } else if (block.type === 'hr') {
      ctx.y -= 6
      ctx.page.drawLine({ start: { x: MARGIN_X, y: ctx.y }, end: { x: PAGE_WIDTH - MARGIN_X, y: ctx.y }, thickness: 0.6, color: COLOR_RULE })
      ctx.y -= 6
    } else if (block.type === 'table') {
      const padding = 6
      const columnCount = block.columnCount
      const columnWidth = CONTENT_WIDTH / columnCount
      const rowHeights: number[] = []
      const cellLines: string[][][] = []
      for (const row of block.rows) {
        const lineSets: string[][] = []
        let maxLines = 0
        for (let c = 0; c < columnCount; c += 1) {
          const tokens = row[c] ?? []
          const flat = tokens.map((t) => t.text).join('')
          const lines = wrapLine(flat, ctx.font, 11, columnWidth - padding * 2)
          lineSets.push(lines)
          maxLines = Math.max(maxLines, lines.length)
        }
        cellLines.push(lineSets)
        rowHeights.push(maxLines * 11 * LINE_HEIGHT_RATIO + padding * 2)
      }
      let topY = ctx.y
      for (let r = 0; r < block.rows.length; r += 1) {
        const rowHeight = rowHeights[r]
        const bottomY = topY - rowHeight
        if (r === 0) {
          ctx.page.drawRectangle({ x: MARGIN_X, y: bottomY, width: CONTENT_WIDTH, height: rowHeight, color: COLOR_TABLE_HEAD })
        }
        for (let c = 0; c < columnCount; c += 1) {
          const cellLeft = MARGIN_X + c * columnWidth
          ctx.page.drawRectangle({ x: cellLeft, y: bottomY, width: columnWidth, height: rowHeight, borderColor: COLOR_TABLE_BORDER, borderWidth: 0.5 })
          const lines = cellLines[r][c]
          let textY = topY - padding - 11
          for (const line of lines) {
            ctx.page.drawText(line, { x: cellLeft + padding, y: textY, size: 11, font: ctx.font, color: COLOR_TEXT })
            textY -= 11 * LINE_HEIGHT_RATIO
          }
        }
        topY = bottomY
      }
      ctx.y = topY - 8
    }
  }

  const totalHeight = (1000 - MARGIN_TOP) - ctx.y + MARGIN_BOTTOM
  ctx.page.setSize(PAGE_WIDTH, totalHeight)
  ctx.page.setMediaBox(0, 0, PAGE_WIDTH, totalHeight)

  const pdfBytes = await pdf.save()
  return new Blob([pdfBytes], { type: 'application/pdf' })
}
```

- [ ] **步骤 2：编写失败测试**

```ts
// frontend/lib/__tests__/markdown-pdf.test.ts
import { describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { markdownToPdf } from '@/app/dashboard/special/markdown-to-word/lib/markdown-pdf'

describe('markdown PDF generation', () => {
  it('produces a single-page PDF with embedded font', async () => {
    const blob = await markdownToPdf('# 标题\n\n| 商品 | 销售额 |\n|---|---:|\n| A | 100 |\n\n参考 [BelieveBoy](https://believeboy.com)')
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const pdf = await PDFDocument.load(bytes)
    expect(pdf.getPageCount()).toBe(1)
    const page = pdf.getPage(0)
    const { width, height } = page.getSize()
    expect(width).toBeCloseTo(595.28, 1)
    expect(height).toBeGreaterThan(200)
  })
})
```

```bash
cd frontend && pnpm exec vitest run lib/__tests__/markdown-pdf.test.ts --config vitest.config.ts
```

预期：失败（导出函数不存在或字体未到位）。

- [ ] **步骤 3：实现并验证通过**

代码完成后再次运行：

```bash
cd frontend && pnpm exec vitest run lib/__tests__/markdown-pdf.test.ts --config vitest.config.ts
```

预期：通过。

- [ ] **步骤 4：清理临时测试**

```bash
rm frontend/lib/__tests__/markdown-pdf.test.ts && rmdir frontend/lib/__tests__ 2>/dev/null || true
```

- [ ] **步骤 5：提交**

```bash
git add frontend/app/dashboard/special/markdown-to-word/lib/markdown-pdf.ts
git commit -m "feat: 新增 Markdown 转 PDF（矢量文字、单页、无翻页）"
```

---

## 任务 6：UI 接入 “下载 PDF”

**文件：**
- 修改：`frontend/app/dashboard/special/markdown-to-word/markdown-to-word-client.tsx`
- 修改：`frontend/app/dashboard/special/markdown-to-word/lib/markdown-to-word.ts`

- [ ] **步骤 1：扩展辅助函数**

在 `markdown-to-word.ts` 末尾添加：

```ts
export async function downloadMarkdownAsPdf(markdown: string, filename: string): Promise<void> {
  const { markdownToPdf } = await import('./markdown-pdf')
  const blob = await markdownToPdf(markdown)
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.URL.revokeObjectURL(url)
}

export function createPdfFilename(sourceName?: string): string {
  return createWordFilename(sourceName).replace(/\.docx$/i, '.pdf')
}
```

- [ ] **步骤 2：添加按钮与状态**

在 `markdown-to-word-client.tsx`：

- 引入 `FileDown` 图标及 `createPdfFilename`、`downloadMarkdownAsPdf`。
- 新增状态 `const [isDownloadingPdf, setIsDownloadingPdf] = useState(false)`。
- 在预览卡片头部，“下载 Word”按钮旁新增 “下载 PDF” 按钮，loading 文案 “生成中”，使用 `FileDown` 图标。
- `handleDownloadPdf`：

```ts
const handleDownloadPdf = useCallback(async () => {
  if (isEmpty) {
    notify({ type: 'error', title: '无法生成 PDF', message: '请先填写 Markdown 内容' })
    return
  }
  setIsDownloadingPdf(true)
  try {
    const filename = createPdfFilename(sourceFileName ?? undefined)
    await downloadMarkdownAsPdf(markdown, filename)
    notify({ type: 'success', title: 'PDF 文件已生成', message: filename })
  } catch (error) {
    notify({ type: 'error', title: 'PDF 生成失败', message: error instanceof Error ? error.message : '请稍后重试' })
  } finally {
    setIsDownloadingPdf(false)
  }
}, [isEmpty, markdown, notify, sourceFileName])
```

- [ ] **步骤 3：lint + build**

```bash
cd frontend && pnpm lint && pnpm build
```

预期：0 errors，构建通过。

- [ ] **步骤 4：提交**

```bash
git add frontend/app/dashboard/special/markdown-to-word/markdown-to-word-client.tsx frontend/app/dashboard/special/markdown-to-word/lib/markdown-to-word.ts
git commit -m "feat: 在 Markdown 转 Word 页面新增下载 PDF 按钮"
```

---

## 任务 7：部署

- [ ] **步骤 1：提交所有变更并推送**

```bash
git push origin main
```

- [ ] **步骤 2：触发部署 hook**

```bash
.git/hooks/post-push "refs/heads/main" "git@github.com:passwii/believeboyDashboard.git"
```

预期：VPS 部署成功，API 健康检查通过。