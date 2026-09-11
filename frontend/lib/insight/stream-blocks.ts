/**
 * 流式 Markdown 安全切分（BLF-1013）。
 *
 * 流式草稿随时可能停在半句话上，若整段交给 react-markdown，未闭合的
 * fence/表格/列表会把后续内容误解析（最典型：``` 未闭合 → 后面整篇被当成代码块）。
 * 因此把草稿切成两段：
 *
 * - `stable`：已闭合的 Markdown 前缀，可以安全交给 Markdown 渲染器（其中所有
 *   代码围栏都在 `stable` 内部闭合，所以「图表 code block 仅在闭合后挂载」天然成立）。
 * - `tail`：仍在输入中的尾部片段（未闭合围栏、未换行的表格行 / 列表项 / 行内标记），
 *   以纯文本呈现，不参与 Markdown 解析。
 *
 * 该函数是纯函数：同样的草稿必然得到同样的切分，便于测试与渲染确定性。
 */
export type InsightStreamBlocks = {
  stable: string
  tail: string
}

type OpenFence = {
  marker: string
  length: number
  start: number
}

const FENCE_OPEN_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/
const FENCE_CLOSE_PATTERN = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

function closesFence(line: string, fence: OpenFence): boolean {
  const match = FENCE_CLOSE_PATTERN.exec(line)
  if (!match) return false
  const marker = match[1]
  return marker[0] === fence.marker && marker.length >= fence.length
}

export function splitStreamingMarkdown(content: string): InsightStreamBlocks {
  if (content === '') return { stable: '', tail: '' }

  let openFence: OpenFence | null = null
  let lineStart = 0

  while (lineStart < content.length) {
    const newlineIndex = content.indexOf('\n', lineStart)
    const lineEnd = newlineIndex === -1 ? content.length : newlineIndex
    const line = content.slice(lineStart, lineEnd)

    if (openFence) {
      if (closesFence(line, openFence)) openFence = null
    } else {
      const match = FENCE_OPEN_PATTERN.exec(line)
      if (match) openFence = { marker: match[1][0], length: match[1].length, start: lineStart }
    }

    if (newlineIndex === -1) break
    lineStart = newlineIndex + 1
  }

  // 未闭合围栏会吞掉其后全部内容：整段围栏留在 tail，绝不让后续块被解析成代码。
  if (openFence) {
    return { stable: content.slice(0, openFence.start), tail: content.slice(openFence.start) }
  }

  // 末行尚未换行 → 仍在输入中（半行表格 / 列表项 / 行内标记），保留为纯文本。
  const lastNewline = content.lastIndexOf('\n')
  if (lastNewline === -1) return { stable: '', tail: content }
  return { stable: content.slice(0, lastNewline + 1), tail: content.slice(lastNewline + 1) }
}
