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
  WidthType,
} from 'docx'

import type { BlockNode, InlineToken } from './markdown-ast'
import { parseMarkdown } from './markdown-ast'

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

function renderInlineToRuns(tokens: InlineToken[]): (TextRun | ExternalHyperlink)[] {
  return tokens.map((token) => {
    if (token.link) {
      return new ExternalHyperlink({
        link: token.link,
        children: [
          new TextRun({
            text: token.text,
            color: '0563C1',
            underline: { type: UnderlineType.SINGLE, color: '0563C1' },
          }),
        ],
      })
    }

    return new TextRun({
      text: token.text,
      bold: token.bold,
      italics: token.italics,
      strike: token.strike,
      font: token.font,
    })
  })
}

function renderBlocks(blocks: BlockNode[]): (Paragraph | Table)[] {
  const result: (Paragraph | Table)[] = []

  for (const block of blocks) {
    switch (block.type) {
      case 'heading': {
        const heading =
          block.level === 1
            ? HeadingLevel.HEADING_1
            : block.level === 2
              ? HeadingLevel.HEADING_2
              : HeadingLevel.HEADING_3
        result.push(
          new Paragraph({
            children: renderInlineToRuns(block.children),
            heading,
            spacing: { after: 160 },
          }),
        )
        break
      }
      case 'paragraph':
        result.push(
          new Paragraph({
            children: renderInlineToRuns(block.children),
            spacing: { after: 80 },
          }),
        )
        break
      case 'bulletList':
        for (const item of block.items) {
          result.push(
            new Paragraph({
              children: renderInlineToRuns(item),
              bullet: { level: 0 },
              spacing: { after: 80 },
            }),
          )
        }
        break
      case 'orderedList':
        for (const item of block.items) {
          result.push(
            new Paragraph({
              children: renderInlineToRuns(item),
              numbering: { reference: 'default-numbering', level: 0 },
              spacing: { after: 80 },
            }),
          )
        }
        break
      case 'code':
        result.push(
          new Paragraph({
            children: [new TextRun({ text: block.text, font: 'Courier New' })],
            spacing: { after: 120 },
            shading: { fill: 'F8FAFC', type: ShadingType.CLEAR },
          }),
        )
        break
      case 'quote':
        result.push(
          new Paragraph({
            children: renderInlineToRuns(block.children),
            border: {
              left: { style: BorderStyle.SINGLE, color: '2563EB', size: 8, space: 8 },
            },
            shading: { fill: 'F8FAFC', type: ShadingType.CLEAR },
            spacing: { after: 120 },
          }),
        )
        break
      case 'hr':
        result.push(
          new Paragraph({
            children: [new TextRun({ text: ' ', color: 'FFFFFF' })],
            border: {
              bottom: { style: BorderStyle.SINGLE, color: 'CBD5E1', size: 8 },
            },
            spacing: { after: 160 },
          }),
        )
        break
      case 'table': {
        const rows = block.rows.map((row, rowIndex) => {
          const cells = Array.from({ length: block.columnCount }, (_value, columnIndex) => {
            return new TableCell({
              children: [
                new Paragraph({
                  children: renderInlineToRuns(row[columnIndex] ?? []),
                  spacing: { after: 0 },
                }),
              ],
              shading:
                rowIndex === 0 ? { fill: 'F3F4F6', type: ShadingType.CLEAR } : undefined,
              margins: CELL_MARGIN,
            })
          })
          return new TableRow({ children: cells })
        })
        result.push(
          new Table({
            rows,
            width: TABLE_WIDTH,
            layout: TableLayoutType.AUTOFIT,
            borders: TABLE_BORDER,
            margins: CELL_MARGIN,
          }),
        )
        break
      }
    }
  }

  return result
}

export function markdownToDocxChildren(markdown: string): (Paragraph | Table)[] {
  return renderBlocks(parseMarkdown(markdown))
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