'use client'

import { useEffect } from 'react'

export interface AutoSelectProjectOption {
  id: number | null
  name: string
}

/**
 * 项目下拉「默认选中第一个真实项目」的全局逻辑。
 *
 * 与 daily-analysis 既有的手写 effect 对齐的行为:
 *  - projects 未加载完（空数组）→ 不动。
 *  - URL / 状态已显式选了 "all"（全部项目）→ 保留,不覆盖（避免破坏只能全部项目的页面）。
 *  - 已选了列表中存在的真实项目 → 保留。
 *  - 其余（空 / 失效 / 越权）→ 回退到第一个 id !== null 的真实项目。
 *
 * 这样进入页面时项目下拉会自动落到第一个真实项目,内容立即加载,
 * 而 all / 空白意图（详情页、工具页、Dashboard 首页代表项目）不受影响。
 */
export function useAutoSelectFirstProject(
  projects: AutoSelectProjectOption[],
  projectId: string,
  setProjectId: (value: string) => void,
) {
  useEffect(() => {
    if (projects.length === 0) return

    const isAll = projectId === 'all'
    const existsInList =
      !!projectId &&
      !isAll &&
      projects.some((p) => p.id !== null && String(p.id) === projectId)

    if (!projectId || (!isAll && !existsInList)) {
      const first = projects.find((p) => p.id !== null)
      if (first?.id != null) setProjectId(String(first.id))
    }
  }, [projectId, projects, setProjectId])
}
