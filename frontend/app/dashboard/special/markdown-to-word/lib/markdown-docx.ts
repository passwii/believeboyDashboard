import {
  AlignmentType,
  Document,
  HeadingLevel,
  LevelFormat,
  LevelSuffix,
  Packer,
  Paragraph,
  TextRun,
} from 'docx'

type InlineToken = {
  text: string
  bold?: boolean
  italics?: boolean
  strike?: boolean
  font?: string
}

const INLINE_PATTERN = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|~~[^~]+~~|`[^`]+`)/g

function parseInlineMarkdown(value: string): InlineToken[] {
  const tokens: InlineToken[] = []
  let cursor = 0

  value.replace(INLINE_PATTERN, (match, _full, offset: number) => {
    if (offset > cursor) {
      tokens.push({ text: value.slice(cursor, offset) })
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
    tokens.push({ text: value.slice(cursor) })
  }

  return tokens.filter((token) => token.text.length > 0)
}

function createTextRuns(value: string): TextRun[] {
  const tokens = parseInlineMarkdown(value)

  if (tokens.length === 0) {
    return [new TextRun({ text: value })]
  }

  return tokens.map(({ text, bold, italics, strike, font }) => new TextRun({ text, bold, italics, strike, font }))
}

function createMarkdownParagraph(line: string): Paragraph {
  const headingMatch = line.match(/^(#{1,6})\s+(.+)$/)
  if (headingMatch) {
    const level = Math.min(headingMatch[1].length, 3)

    return new Paragraph({
      children: createTextRuns(headingMatch[2].trim()),
      heading: level === 1 ? HeadingLevel.HEADING_1 : level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
      spacing: { after: 160 },
    })
  }

  if (/^[-*+]\s+/.test(line)) {
    return new Paragraph({
      children: createTextRuns(line.replace(/^[-*+]\s+/, '')),
      bullet: { level: 0 },
      spacing: { after: 80 },
    })
  }

  if (/^\d+\.\s+/.test(line)) {
    return new Paragraph({
      children: createTextRuns(line.replace(/^\d+\.\s+/, '')),
      numbering: { reference: 'default-numbering', level: 0 },
      spacing: { after: 80 },
    })
  }

  if (line.trim() === '') {
    return new Paragraph({
      text: '',
      spacing: { after: 80 },
    })
  }

  return new Paragraph({
    children: createTextRuns(line),
    alignment: AlignmentType.LEFT,
    spacing: { after: 80 },
  })
}

export function markdownToDocxParagraphs(markdown: string): Paragraph[] {
  const normalized = markdown.replace(/\r\n/g, '\n').trim()
  if (!normalized) return []

  return normalized.split('\n').map(createMarkdownParagraph)
}

export async function createMarkdownDocxBlob(markdown: string): Promise<Blob> {
  if (!markdown.trim()) {
    throw new Error('Markdown 内容为空，无法生成 Word 文件')
  }

  const document = new Document({
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
        children: markdownToDocxParagraphs(markdown),
      },
    ],
  })

  return Packer.toBlob(document)
}
