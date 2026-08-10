import { describe, it, expect } from 'vitest'
import { STICKY_TOP_GROUP_ROW, STICKY_TOP_ROW } from './table'

describe('Table 粘性表头暗黑顶部内高光（BLF-574）', () => {
  it('STICKY_TOP_ROW 暗黑叠加顶部内高光（与卡片玻璃边一致），light 保留底边框阴影', () => {
    expect(STICKY_TOP_ROW).toContain('shadow-[inset_0_-1px_0_0_hsl(var(--border)/0.6)]')
    expect(STICKY_TOP_ROW).toContain('dark:shadow-[inset_0_1px_0_hsl(220_30%_100%/0.05),inset_0_-1px_0_0_hsl(var(--border)/0.6)]')
  })

  it('STICKY_TOP_GROUP_ROW 暗黑带顶部内高光', () => {
    expect(STICKY_TOP_GROUP_ROW).toContain('dark:shadow-[inset_0_1px_0_hsl(220_30%_100%/0.06)]')
  })
})
