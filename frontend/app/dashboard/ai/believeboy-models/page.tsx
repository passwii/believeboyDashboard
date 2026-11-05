/**
 * Believeboy 模型选型方案 — 只读展示页。
 * 路径: /dashboard/ai/believeboy-models
 *
 * 数据源: /root/believeboyDashboard/frontend/docs/believeboy-models.md
 *   (从 /root/teamRock/BBCC-彼励扶基础设施/ 同步，原文保留 Ultra 待补全标记)
 *
 * 设计选择:
 *  - 用 server component 读 .md 文件，避免把它当模块 import 进客户端 bundle
 *    (团队后续直接改 .md 即可热更新，无需改代码)。
 *  - 渲染委托给客户端 BelieveboyModelsView，利用 react-markdown + remark-gfm
 *    这套已经被 special/markdown-to-word 验证过的依赖。
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { BelieveboyModelsView } from './believeboy-models-view'

export default async function BelieveboyModelsPage() {
  // Keep the path literal so Next's output tracing includes only this file,
  // not the whole repository, in the standalone runtime.
  const filePath = path.join(process.cwd(), 'docs', 'believeboy-models.md')
  const source = await readFile(filePath, 'utf-8')

  return <BelieveboyModelsView source={source} />
}
