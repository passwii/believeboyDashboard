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

type InlineToken = {
  text: string
  bold?: boolean
  italics?: boolean
  strike?: boolean
  font?: string
  link?: string
}

type DocxBlock = Paragraph | Table

type InlineOptions = {
  bold?: boolean
  italics?: boolean
  strike?: boolean
  font?: string
}

const INLINE_PATTERN =
  /(!?\[[^\]]+\]\([^)\s]+(?:\s+"[^"]*")?\)|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|~~[^~]+~~|`[^`]+`)/g

const TABLE_BORDER = {
  top: { style: BorderStyle.SINGLE, color: 'CBD5E1', size: 4 },
  bottom: { style: BorderStyle.SINGLE, color: 'CBD5E1', size: 4 },
  left: { style: BorderStyle.SINGLE, color: 'CBD5E1', size: 4 },
  right: { style: BorderStyle.SINGLE, color: 'CBD5E1', size: 4 },
  insideHorizontal: { style: BorderStyle.SINGLE, color: 'CBD5E1', size: 4 },
  insideVertical: { style: BorderStyle.SINGLE, color: 'CBD5E1', size: 4 },
}

const CELL_MARGIN = {
  top: 80,
  bottom: 80,
  left: 120,
  right: 120,
}

const TABLE_WIDTH = {
  size: 100,
  type: WidthType.PERCENTAGE,
}

function unescapeMarkdownText(value: string): string {
  return value.replace(/\\([\\`*_{}\[\]()#+.!|-])/g, '$1')
}

function parseInlineMarkdown(value: string): InlineToken[] {
  const tokens: InlineToken[] = []
  let cursor = 0

  value.replace(INLINE_PATTERN, (match, _full, offset: number) => {
    if (offset > cursor) {
      tokens.push({ text: unescapeMarkdownText(value.slice(cursor, offset)) })
    }

    const imageLinkMatch = match.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/)
    if (imageLinkMatch) {
      const altText = imageLinkMatch[1].trim() || '图片'
      tokens.push({ text: `[图片：${altText}]` })
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
    if (match.startsWith('**') || match.startsWith('__')) {
      tokens.push({ text: body, bold: true })
    } else if (match.startsWith('*')) {
      tokens.push({ text: body, italics: true })
    } else if (match.startsWith('~~')) {
      tokens.push({ text: body, strike: true })
    } else if (match.startsWith('`')) {
      tokens.push({ text: body, font: 'Courier New' })
    }

    cursor = offset + match.length
    return match
  })

  if (cursor < value.length) {
    tokens.push({ text: unescapeMarkdownText(value.slice(cursor)) })
  }

  return tokens.filter((token) => token.text.length > 0)
}

function createTextRuns(value: string, options?: InlineOptions): (TextRun | ExternalHyperlink)[] {
  const tokens = parseInlineMarkdown(value)

  if (tokens.length === 0) {
    return [new TextRun({ text: unescapeMarkdownText(value), ...options })]
  }

  return tokens.map(({ text, bold, italics, strike, font, link }) => {
    if (link) {
      return new ExternalHyperlink({
        link,
        children: [
          new TextRun({
            text,
            color: '0563C1',
            underline: { type: UnderlineType.SINGLE, color: '0563C1' },
          }),
        ],
      })
    }

    return new TextRun({
      text,
      bold: bold || options?.bold,
      italics: italics || options?.italics,
      strike,
      font,
    })
  })
}

function createEmptyParagraph(): Paragraph {
  return new Paragraph({
    text: '',
    spacing: { after: 80 },
  })
}

function createMarkdownParagraph(line: string): Paragraph {
  const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
  if (headingMatch) {
    const level = Math.min(headingMatch[1].length, 3)

    return new Paragraph({
      children: createTextRuns(headingMatch[2].trim()),
      heading: level === 1 ? HeadingLevel.HEADING_1 : level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
      spacing: { after: 160 },
    })
  }

  if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
    return new Paragraph({
      children: [new TextRun({ text: ' ', color: 'FFFFFF' })],
      border: {
        bottom: { style: BorderStyle.SINGLE, color: 'CBD5E1', size: 8 },
      },
      spacing: { after: 160 },
    })
  }

  const bulletMatch = line.match(/^\s*[-*+]\s+(?:\[[ xX]\]\s+)?(.+)$/)
  if (bulletMatch) {
    return new Paragraph({
      children: createTextRuns(bulletMatch[1]),
      bullet: { level: 0 },
      spacing: { after: 80 },
    })
  }

  const orderedMatch = line.match(/^\s*\d+\.\s+(?:\[[ xX]\]\s+)?(.+)$/)
  if (orderedMatch) {
    return new Paragraph({
      children: createTextRuns(orderedMatch[1]),
      numbering: { reference: 'default-numbering', level: 0 },
      spacing: { after: 80 },
    })
  }

  if (line.trim() === '') {
    return createEmptyParagraph()
  }

  return new Paragraph({
    children: createTextRuns(line),
    alignment: AlignmentType.LEFT,
    spacing: { after: 80 },
  })
}

function splitTableCells(line: string): string[] {
  const trimmed = line.trim()
  if (!trimmed) return []

  const withoutOuterPipes = trimmed.startsWith('|') && trimmed.endsWith('|') ? trimmed.slice(1, -1) : trimmed
  const cells: string[] = []
  let current = ''

  for (let index = 0; index < withoutOuterPipes.length; index += 1) {
    const char = withoutOuterPipes[index]
    const nextChar = withoutOuterPipes[index + 1]

    if (char === '\\' && nextChar === '|') {
      current += '|'
      index += 1
      continue
    }

    if (char === '|') {
      cells.push(current.trim())
      current = ''
      continue
    }

    current += char
  }

  cells.push(current.trim())
  return cells
}

function isTableLine(line: string): boolean {
  return line.includes('|') && splitTableCells(line).length > 1
}

function isTableSeparator(line: string): boolean {
  const cells = splitTableCells(line)
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))
}

function createDocxTable(rows: string[][]): Table {
  const columnCount = Math.max(...rows.map((row) => row.length), 1)

  return new Table({
    rows: rows.map((row, rowIndex) => {
      const cells = Array.from({ length: columnCount }, (_value, columnIndex) => {
        const cellText = row[columnIndex] ?? ''

        return new TableCell({
          children: [
            new Paragraph({
              children: createTextRuns(cellText, rowIndex === 0 ? { bold: true } : undefined),
              spacing: { after: 0 },
            }),
          ],
          shading: rowIndex === 0 ? { fill: 'F3F4F6', type: ShadingType.CLEAR } : undefined,
          verticalAlign: VerticalAlignTable.TOP,
          margins: CELL_MARGIN,
        })
      })

      return new TableRow({ children: cells })
    }),
    width: TABLE_WIDTH,
    layout: TableLayoutType.AUTOFIT,
    borders: TABLE_BORDER,
    margins: CELL_MARGIN,
  })
}

function parseTableBlock(lines: string[], startIndex: number): { block: Table; nextIndex: number } | null {
  if (!isTableLine(lines[startIndex]) || !isTableSeparator(lines[startIndex + 1])) {
    return null
  }

  const rows: string[][] = []
  let index = startIndex

  while (index < lines.length && isTableLine(lines[index])) {
    if (index === startIndex + 1 && isTableSeparator(lines[index])) {
      index += 1
      continue
    }

    rows.push(splitTableCells(lines[index]))
    index += 1
  }

  return { block: createDocxTable(rows), nextIndex: index }
}

function parseCodeFenceBlock(lines: string[], startIndex: number): { block: Paragraph; nextIndex: number } | null {
  const fenceMatch = lines[startIndex].match(/^(\s{0,3})(`{3,}|~{3,})\s*[\w-]*\s*$/)
  if (!fenceMatch) return null

  const fenceChar = fenceMatch[2][0]
  const fenceLength = fenceMatch[2].length
  const closePattern = new RegExp(`^\\s{0,3}${fenceChar}{${fenceLength},}\\s*$`)
  const codeLines: string[] = []
  let index = startIndex + 1

  while (index < lines.length && !closePattern.test(lines[index])) {
    codeLines.push(lines[index])
    index += 1
  }

  return {
    block: new Paragraph({
      children: [new TextRun({ text: codeLines.join('\n'), font: 'Courier New' })],
      spacing: { after: 120 },
      shading: { fill: 'F8FAFC', type: ShadingType.CLEAR },
    }),
    nextIndex: Math.min(index + 1, lines.length),
  }
}

function parseBlockquoteBlock(lines: string[], startIndex: number): { block: Paragraph; nextIndex: number } | null {
  if (!/^\s*>/.test(lines[startIndex])) return null

  const quoteLines: string[] = []
  let index = startIndex

  while (index < lines.length && /^\s*>/.test(lines[index])) {
    quoteLines.push(lines[index].replace(/^\s*>\s?/, ''))
    index += 1
  }

  return {
    block: new Paragraph({
      children: createTextRuns(quoteLines.join('\n')),
      border: {
        left: { style: BorderStyle.SINGLE, color: '2563EB', size: 8, space: 8 },
      },
      shading: { fill: 'F8FAFC', type: ShadingType.CLEAR },
      spacing: { after: 120 },
    }),
    nextIndex: index,
  }
}

export function markdownToDocxChildren(markdown: string): DocxBlock[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const blocks: DocxBlock[] = []

  for (let index = 0; index < lines.length; ) {
    const tableBlock = parseTableBlock(lines, index)
    if (tableBlock) {
      blocks.push(tableBlock.block)
      index = tableBlock.nextIndex
      continue
    }

    const codeFenceBlock = parseCodeFenceBlock(lines, index)
    if (codeFenceBlock) {
      blocks.push(codeFenceBlock.block)
      index = codeFenceBlock.nextIndex
      continue
    }

    const blockquoteBlock = parseBlockquoteBlock(lines, index)
    if (blockquoteBlock) {
      blocks.push(blockquoteBlock.block)
      index = blockquoteBlock.nextIndex
      continue
    }

    blocks.push(createMarkdownParagraph(lines[index]))
    index += 1
  }

  return blocks
}

export function createMarkdownDocument(markdown: string): Document {
  return new Document({
    title: 'Markdown 转 Word',
    creator: 'BelieveBoy Dashboard',
    numbering: {
      config: [
        {
          reference: 'default-numbering',
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: '%1.',
              alignment: AlignmentType.LEFT,
              start: 1,
              suffix: LevelSuffix.TAB,
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: 1440,
              right: 1440,
              bottom: 1440,
              left: 1440,
            },
          },
        },
        children: markdownToDocxChildren(markdown),
      },
    ],
  })
}

export async function createMarkdownDocxBlob(markdown: string): Promise<Blob> {
  if (!markdown.trim()) {
    throw new Error('Markdown 内容为空，无法生成 Word 文件')
  }

  return Packer.toBlob(createMarkdownDocument(markdown))
}
