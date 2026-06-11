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
    if (offset > cursor) {
      tokens.push({ text: unescapeMarkdownText(value.slice(cursor, offset)) })
    }

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

function splitTableCells(line: string): string[] {
  const trimmed = line.trim()
  if (!trimmed) return []

  const core = trimmed.startsWith('|') && trimmed.endsWith('|') ? trimmed.slice(1, -1) : trimmed
  const cells: string[] = []
  let current = ''

  for (let index = 0; index < core.length; index += 1) {
    const char = core[index]
    const nextChar = core[index + 1]

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

export function parseMarkdown(markdown: string): BlockNode[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const blocks: BlockNode[] = []

  for (let index = 0; index < lines.length; ) {
    const line = lines[index]

    if (line.trim() === '') {
      index += 1
      continue
    }

    if (isTableLine(line) && isTableSeparator(lines[index + 1] ?? '')) {
      const dataRows: InlineToken[][][] = []
      let cursor = index + 2

      while (cursor < lines.length && isTableLine(lines[cursor])) {
        dataRows.push(splitTableCells(lines[cursor]).map(parseInline))
        cursor += 1
      }

      const allRows = [splitTableCells(line).map(parseInline), ...dataRows]
      const columnCount = allRows.reduce((max, row) => Math.max(max, row.length), 0)

      blocks.push({ type: 'table', rows: allRows, columnCount })
      index = cursor
      continue
    }

    const fence = line.match(/^(\s{0,3})(`{3,}|~{3,})\s*[\w-]*\s*$/)
    if (fence) {
      const fenceChar = fence[2][0]
      const fenceLength = fence[2].length
      const closePattern = new RegExp(`^\\s{0,3}${fenceChar}{${fenceLength},}\\s*$`)
      const codeLines: string[] = []
      let cursor = index + 1

      while (cursor < lines.length && !closePattern.test(lines[cursor])) {
        codeLines.push(lines[cursor])
        cursor += 1
      }

      blocks.push({ type: 'code', text: codeLines.join('\n') })
      index = Math.min(cursor + 1, lines.length)
      continue
    }

    if (/^\s*>/.test(line)) {
      const quoteLines: string[] = []
      let cursor = index

      while (cursor < lines.length && /^\s*>/.test(lines[cursor])) {
        quoteLines.push(lines[cursor].replace(/^\s*>\s?/, ''))
        cursor += 1
      }

      blocks.push({ type: 'quote', children: parseInline(quoteLines.join('\n')) })
      index = cursor
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (heading) {
      const level = Math.min(heading[1].length, 3) as 1 | 2 | 3
      blocks.push({ type: 'heading', level, children: parseInline(heading[2].trim()) })
      index += 1
      continue
    }

    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ type: 'hr' })
      index += 1
      continue
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: InlineToken[][] = []
      let cursor = index

      while (cursor < lines.length && /^\s*[-*+]\s+/.test(lines[cursor])) {
        items.push(parseInline(lines[cursor].replace(/^\s*[-*+]\s+(?:\[[ xX]\]\s+)?/, '')))
        cursor += 1
      }

      blocks.push({ type: 'bulletList', items })
      index = cursor
      continue
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: InlineToken[][] = []
      let cursor = index

      while (cursor < lines.length && /^\s*\d+\.\s+/.test(lines[cursor])) {
        items.push(parseInline(lines[cursor].replace(/^\s*\d+\.\s+(?:\[[ xX]\]\s+)?/, '')))
        cursor += 1
      }

      blocks.push({ type: 'orderedList', items })
      index = cursor
      continue
    }

    const paragraphLines: string[] = []
    let cursor = index

    while (
      cursor < lines.length &&
      lines[cursor].trim() !== '' &&
      !/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(lines[cursor])
    ) {
      paragraphLines.push(lines[cursor])
      cursor += 1
    }

    blocks.push({ type: 'paragraph', children: parseInline(paragraphLines.join('\n')) })
    index = cursor
  }

  return blocks
}