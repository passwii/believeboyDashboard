import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * BLF-1017 验收 §2：共享 hook / renderer 里不允许出现域分支。
 *
 * 广告分析与库存健康只提供「口径入参 + 输出槽名」和文案，流状态机
 * （`use-insight-stream.ts`）与渲染器（`components/insight/*`）必须对域无感知；
 * 一旦有人在共享层里加 `if (domain === 'ad_analysis')`，两个域就会各长出一条
 * 私有分支，本次迁移的「不保留第二套流状态机」立刻失效。
 *
 * 这里的断言是**分层契约**（哪些模块可以知道域），不是行为细节：域相关的知识
 * 只允许出现在 `domain-runs.ts`（域提交端点）与 `lib/insight/index.ts`（统一出口）
 * 这两个"域边界"文件里，其余机制文件必须干净。
 */
const FRONTEND_ROOT = path.resolve(import.meta.dirname, '../..')

/** 共享机制层：流状态机 + 传输 + 渲染器。全部必须对域无感知。 */
const SHARED_MECHANISM_FILES = [
  'hooks/use-insight-stream.ts',
  'components/insight/insight-markdown.tsx',
  'components/insight/insight-presentation.ts',
  'components/insight/insight-status.tsx',
  'components/insight/insight-stream-panel.tsx',
  'lib/insight/client.ts',
  'lib/insight/sse.ts',
  'lib/insight/protocol.ts',
  'lib/insight/stream-blocks.ts',
  'lib/insight/reveal-queue.ts',
]

/** 域 ∈ {"广告分析", "库存健康"} 的任一残留形态。 */
const DOMAIN_BRANCH_TOKENS: Record<string, RegExp> = {
  '广告分析域标识': /ad[-_]analysis/i,
  '库存健康域标识': /inventory[-_]health/i,
  '域输出槽常量': /\bAD_OUTPUT_SLOT\b|\bINVENTORY_OUTPUT_SLOT\b/,
  // `components/dashboard-v2/warm-ledger` is the shared A1 design system, not a
  // domain page. Only its shared controls are allowed in the Insight mechanism layer.
  '域页面依赖': /@\/components\/dashboard\/|(?:^|\/)components\/dashboard\/|@\/app\//m,
  '域专用 Warm 别名模块':
    /@\/components\/dashboard-v2\/warm-ledger\/(?!controls(?:[\/"'`]|\s|$))/,
  '域专用 Warm 相对模块':
    /(?:^|["'`])\.{1,2}\/[^"'`]*dashboard-v2\/warm-ledger\/(?!controls(?:[\/"'`]|\s|$))/m,
  'Warm 路径穿越':
    /(?:^|["'`])[^"'`]*dashboard-v2\/warm-ledger\/[^"'`]*\/\.\.\//m,
}

function readSharedFile(relativePath: string): string {
  return readFileSync(path.join(FRONTEND_ROOT, relativePath), 'utf8')
}

describe('共享 Insight 层的域纯度', () => {
  it.each(SHARED_MECHANISM_FILES)('%s 不含任何域分支', (relativePath) => {
    const source = readSharedFile(relativePath)
    const found = Object.entries(DOMAIN_BRANCH_TOKENS)
      .filter(([, pattern]) => pattern.test(source))
      .map(([label]) => label)
    expect(found).toEqual([])
  })

  it('允许通用 Warm 设计系统，但仍然拦截域页面依赖', () => {
    const pagePattern = DOMAIN_BRANCH_TOKENS['域页面依赖']
    const warmAliasPattern = DOMAIN_BRANCH_TOKENS['域专用 Warm 别名模块']
    const warmRelativePattern = DOMAIN_BRANCH_TOKENS['域专用 Warm 相对模块']
    const warmTraversalPattern = DOMAIN_BRANCH_TOKENS['Warm 路径穿越']

    expect(pagePattern.test("@/components/dashboard/ai-ad-analysis")).toBe(true)
    expect(pagePattern.test("@/app/dashboard/ai/ad-analysis/page")).toBe(true)
    expect(warmAliasPattern.test("@/components/dashboard-v2/warm-ledger/controls")).toBe(false)
    expect(
      warmAliasPattern.test("@/components/dashboard-v2/warm-ledger/crm/warm-crm-page")
    ).toBe(true)
    expect(
      warmRelativePattern.test(
        "import('../../components/dashboard-v2/warm-ledger/crm/warm-crm-page')"
      )
    ).toBe(true)
    expect(
      warmRelativePattern.test(
        "import('../dashboard-v2/warm-ledger/crm/warm-crm-page')"
      )
    ).toBe(true)
    expect(
      warmRelativePattern.test("import('../dashboard-v2/warm-ledger/controls')")
    ).toBe(false)
    expect(
      warmTraversalPattern.test(
        "import('@/components/dashboard-v2/warm-ledger/controls/../crm/record-drawer')"
      )
    ).toBe(true)
    expect(
      warmTraversalPattern.test("@/components/dashboard-v2/warm-ledger/controls")
    ).toBe(false)
  })

  it('渲染器只做展示：不持有传输层（EventSource / fetch）', () => {
    const rendererFiles = SHARED_MECHANISM_FILES.filter((file) =>
      file.startsWith('components/insight/')
    )
    expect(rendererFiles.length).toBeGreaterThan(0)
    for (const file of rendererFiles) {
      const source = readSharedFile(file)
      expect(source).not.toMatch(/new EventSource/)
      expect(source).not.toMatch(/\bfetch\(/)
    }
  })

  it('唯一的域知识出口是域提交模块与统一出口', () => {
    // 反向断言：域知识确实只在这两个地方——写错了位置（例如塞进 sse.ts）
    // 会被上一条用例抓住，这里确保"域边界"文件本身仍存在且确实承担该职责。
    expect(readSharedFile('lib/insight/domain-runs.ts')).toMatch(/ad[-_]analysis/i)
    expect(readSharedFile('lib/insight/index.ts')).toMatch(/AD_ANALYSIS_RUN_PATH/)
  })
})
