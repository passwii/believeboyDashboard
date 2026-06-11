import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'

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

  for (const char of text) {
    const test = current + char
    const width = font.widthOfTextAtSize(test, fontSize)
    if (width > maxWidth && current.length > 0) {
      lines.push(current)
      current = char
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

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]

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

      if (index < parts.length - 1) {
        cursorX = x
        cursorY -= lineHeight
      }
    }
  }

  for (const segment of segments) {
    ctx.page.drawText(segment.text, {
      x: cursorX - segment.width,
      y: cursorY,
      size: fontSize,
      font: segment.font,
      color: COLOR_TEXT,
    })
  }

  return cursorY - lineHeight
}

export async function markdownToPdfBytes(markdown: string): Promise<Uint8Array> {
  if (!markdown.trim()) {
    throw new Error('Markdown 内容为空，无法生成 PDF')
  }

  const ast = parseMarkdown(markdown)
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  pdf.setTitle('Markdown 转 PDF')
  pdf.setCreator('BelieveBoy Dashboard')

  const fontBytes = await fetch('/fonts/NotoSansSC-Regular.otf').then((response) => response.arrayBuffer())
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
      block.items.forEach((item, itemIndex) => {
        const prefix = block.type === 'bulletList' ? '• ' : `${itemIndex + 1}. `
        const prefixWidth = ctx.font.widthOfTextAtSize(prefix, 12)

        ctx.page.drawText(prefix, {
          x: MARGIN_X,
          y: ctx.y,
          size: 12,
          font: ctx.font,
          color: COLOR_TEXT,
        })

        ctx.y = drawInline(
          ctx,
          item,
          MARGIN_X + prefixWidth + 4,
          ctx.y,
          CONTENT_WIDTH - prefixWidth - 4,
          12,
        )
        ctx.y -= 2
      })
      ctx.y -= 4
    } else if (block.type === 'code') {
      const padding = 8
      const codeLines = block.text.split('\n')
      const maxLineWidth = Math.max(...codeLines.map((line) => ctx.fontMono.widthOfTextAtSize(line, 11)))
      const boxWidth = Math.min(CONTENT_WIDTH, maxLineWidth + padding * 2)
      const boxHeight = codeLines.length * 11 * LINE_HEIGHT_RATIO + padding * 2

      ctx.y -= boxHeight

      ctx.page.drawRectangle({
        x: MARGIN_X,
        y: ctx.y,
        width: boxWidth,
        height: boxHeight,
        color: COLOR_CODE_BG,
      })

      let lineY = ctx.y + boxHeight - padding - 11
      for (const line of codeLines) {
        ctx.page.drawText(line, {
          x: MARGIN_X + padding,
          y: lineY,
          size: 11,
          font: ctx.fontMono,
          color: COLOR_TEXT,
        })
        lineY -= 11 * LINE_HEIGHT_RATIO
      }
      ctx.y -= 8
    } else if (block.type === 'quote') {
      const barWidth = 3
      const padding = 10

      ctx.y = drawInline(
        ctx,
        block.children,
        MARGIN_X + barWidth + padding,
        ctx.y,
        CONTENT_WIDTH - barWidth - padding,
        12,
      )
      ctx.page.drawRectangle({
        x: MARGIN_X,
        y: ctx.y + 8,
        width: barWidth,
        height: 14,
        color: COLOR_QUOTE_BAR,
      })
      ctx.y -= 4
    } else if (block.type === 'hr') {
      ctx.y -= 6
      ctx.page.drawLine({
        start: { x: MARGIN_X, y: ctx.y },
        end: { x: PAGE_WIDTH - MARGIN_X, y: ctx.y },
        thickness: 0.6,
        color: COLOR_RULE,
      })
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
          const flat = tokens.map((token) => token.text).join('')
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
          ctx.page.drawRectangle({
            x: MARGIN_X,
            y: bottomY,
            width: CONTENT_WIDTH,
            height: rowHeight,
            color: COLOR_TABLE_HEAD,
          })
        }

        for (let c = 0; c < columnCount; c += 1) {
          const cellLeft = MARGIN_X + c * columnWidth
          ctx.page.drawRectangle({
            x: cellLeft,
            y: bottomY,
            width: columnWidth,
            height: rowHeight,
            borderColor: COLOR_TABLE_BORDER,
            borderWidth: 0.5,
          })

          const lines = cellLines[r][c]
          let textY = topY - padding - 11
          for (const line of lines) {
            ctx.page.drawText(line, {
              x: cellLeft + padding,
              y: textY,
              size: 11,
              font: ctx.font,
              color: COLOR_TEXT,
            })
            textY -= 11 * LINE_HEIGHT_RATIO
          }
        }
        topY = bottomY
      }
      ctx.y = topY - 8
    }
  }

  const totalHeight = 1000 - MARGIN_TOP - ctx.y + MARGIN_BOTTOM
  ctx.page.setSize(PAGE_WIDTH, totalHeight)
  ctx.page.setMediaBox(0, 0, PAGE_WIDTH, totalHeight)

  return pdf.save()
}

export async function markdownToPdf(markdown: string): Promise<Blob> {
  const bytes = await markdownToPdfBytes(markdown)
  return new Blob([bytes], { type: 'application/pdf' })
}