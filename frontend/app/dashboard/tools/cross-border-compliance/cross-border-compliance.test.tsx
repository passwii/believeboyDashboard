import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import CrossBorderComplianceClient from './cross-border-compliance-client'
import * as complianceData from './compliance-data'
import {
  CUSTOMS_FIELDS,
  FIRST_ORDER_MATERIAL_GROUPS,
  MODE_COMPARISON_0110_9810,
  MODE_OMISSION_NOTE,
  MODE_SCENARIO_ROWS,
  REGULATORY_MODES,
  TOTAL_MATERIAL_COUNT,
} from './compliance-data'

// ── mocks ────────────────────────────────────────────────────────────────────

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

// ── helpers ──────────────────────────────────────────────────────────────────

/** 取「首单核查材料清单」所在的 Warm Tools 面板区域。 */
function materialsRegion() {
  const progress = screen.getByTestId('material-progress')
  const panel = progress.closest('section')
  if (!panel) throw new Error('未找到首单材料区域')
  return panel
}

describe('CrossBorderComplianceClient', () => {
  it('区块 1：标题、副标题、来源提示与限制性提示均可见', () => {
    const { container } = render(<CrossBorderComplianceClient />)

    expect(container.querySelector('[data-tools-page-frame="true"]')).toBeInTheDocument()
    expect(container.querySelectorAll('[data-tools-panel="true"]')).toHaveLength(5)
    expect(container.querySelector('[class*="term-"]')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '跨境电商合规' })).toBeInTheDocument()
    expect(screen.getByText('出口业务资料整理与自查参考')).toBeInTheDocument()
    // 来源标识（硬性验收项）
    expect(screen.getByText(/根据用户提供的课件整理/)).toBeInTheDocument()
    // 限制性提示（硬性验收项）
    expect(
      screen.getByText(/以属地主管海关、税务机关的现行要求为准/)
    ).toBeInTheDocument()
    expect(screen.getByText(/不构成法律、税务或报关意见/)).toBeInTheDocument()
  })

  it('区块 2：五步出口业务证据链按采购→销售→报关→物流→收汇呈现', () => {
    render(<CrossBorderComplianceClient />)

    const chain = document.getElementById('chain')
    expect(chain).not.toBeNull()
    if (!chain) return

    const headings = within(chain).getAllByRole('heading', { level: 3 })
    expect(headings.map((h) => h.textContent)).toEqual([
      '采购',
      '销售',
      '报关',
      '物流',
      '收汇',
    ])

    // 采购环节单证
    expect(within(chain).getByText(/采购付款银行记录/)).toBeInTheDocument()
    // 收汇环节单证
    expect(within(chain).getByText(/完整银行收汇记录/)).toBeInTheDocument()

    // 流程带可跳转至对应内容区
    const jumpLinks = within(chain).getAllByRole('link')
    expect(jumpLinks.map((l) => l.getAttribute('href'))).toEqual([
      '#materials',
      '#materials',
      '#fields',
      '#materials',
      '#materials',
    ])
  })

  it('区块 3：五种监管模式齐全，并标注「课件场景参考」', () => {
    render(<CrossBorderComplianceClient />)

    const modes = document.getElementById('modes')
    expect(modes).not.toBeNull()
    if (!modes) return

    const codes = within(modes)
      .getAllByTestId('mode-code')
      .map((el) => el.textContent)
    expect(codes).toEqual(REGULATORY_MODES.map((m) => m.code))
    expect(REGULATORY_MODES.map((m) => m.code)).toEqual([
      '0110',
      '9610',
      '9710',
      '9810',
      '1039',
    ])

    // 「课件场景参考」标注（硬性验收项）
    expect(screen.getAllByText(/课件场景参考/).length).toBeGreaterThan(0)
    // 不出现「推荐 / 更优 / 适用」类结论
    expect(screen.queryByText(/推荐使用/)).not.toBeInTheDocument()
    expect(screen.queryByText(/更优/)).not.toBeInTheDocument()

    // 课件「到底选0110还是9810?」场景对照表：5 行齐全
    for (const row of MODE_SCENARIO_ROWS) {
      expect(within(modes).getByText(row.business)).toBeInTheDocument()
      expect(within(modes).getByText(row.advice)).toBeInTheDocument()
    }
    expect(MODE_SCENARIO_ROWS).toHaveLength(5)

    // 课件「0110 与 9810 核心区别」六维度对照
    for (const row of MODE_COMPARISON_0110_9810) {
      expect(within(modes).getByText(row.dimension)).toBeInTheDocument()
    }
    expect(MODE_COMPARISON_0110_9810).toHaveLength(6)
  })

  it('转录省略：被遮挡 / 截断的课件原文不得以残句或悬空标点呈现', () => {
    render(<CrossBorderComplianceClient />)

    // 9710 横幅：课件原文中段被前景人头遮挡、句子不成立 → 整条不转录，只留省略标注。
    const mode9710 = REGULATORY_MODES.find((m) => m.code === '9710')
    expect(mode9710?.core).toBe('')
    expect(mode9710?.coreOmitted).toBe(complianceData.CORE_OMITTED_LABEL)
    // 不得出现遮挡拼接痕迹 / 省略号占位 / 断句残句
    expect(mode9710?.core).not.toMatch(/……|\.\.\.|境外企业。|为了存储/)

    // 9810「收汇要求」：课件原文以逗号结束 → 去掉悬空逗号并显式标注截断。
    const settleRow = MODE_COMPARISON_0110_9810.find(
      (r) => r.dimension === '收汇要求'
    )
    expect(settleRow?.overseasWarehouse).toBe(
      `支持"轧差结算"${complianceData.TRUNCATION_MARK}`
    )
    expect(settleRow?.overseasWarehouse).not.toMatch(/[，,]\s*$/)

    // 报关字段「商品编号」：课件原文以分号结束 → 同样去掉悬空分号并显式标注截断。
    const hsField = CUSTOMS_FIELDS.find((f) => f.name === '商品编号')
    expect(hsField?.hint).toBe(
      `出口商品的海关编码，出口商品对应的 HS 编码（有出口过的产品可以填之前归类税号，以便参考）${complianceData.TRUNCATION_MARK}`
    )
    expect(hsField?.hint).not.toMatch(/[；;]\s*$/)

    // 页面显式说明省略口径，不留空壳、不伪装成完整原句
    expect(screen.getByText(MODE_OMISSION_NOTE)).toBeInTheDocument()
    expect(
      screen.queryByText(/9710 出口模式出口的货物必须是真实的销售/)
    ).not.toBeInTheDocument()
    // 9710 卡片显式写出「课件此句中段被遮挡，未转录」
    expect(
      screen.getAllByText(complianceData.CORE_OMITTED_LABEL).length
    ).toBeGreaterThan(0)
  })

  it('退税措辞：全页统一用「离境预退税」，不出现「离境即退税」变体', () => {
    // 用户 2026-10-20 在 BLF-1380 拍板：课件里「离境即退税」与「离境预退税」两种写法
    // 统一保留后者。本页不把任何一个读起来像即时结论的变体交给读者。
    const collect = (value: unknown, acc: string[] = []): string[] => {
      if (typeof value === 'string') {
        acc.push(value)
      } else if (Array.isArray(value)) {
        for (const item of value) collect(item, acc)
      } else if (value && typeof value === 'object') {
        for (const item of Object.values(value as Record<string, unknown>)) {
          collect(item, acc)
        }
      }
      return acc
    }

    const strings = collect(complianceData)
    expect(strings.filter((s) => s.includes('离境即退税'))).toEqual([])
    // 9810 卡片与 0110/9810 对照表两处均使用拍板后的措辞
    const mode9810 = REGULATORY_MODES.find((m) => m.code === '9810')
    expect(mode9810?.feature).toContain('离境预退税')
    const refundRow = MODE_COMPARISON_0110_9810.find(
      (r) => r.dimension === '出口退税政策'
    )
    expect(refundRow?.overseasWarehouse).toContain('离境预退税')
  })

  it('防回归：转录数据中不得有以悬空标点 / 省略号收尾的条目', () => {
    // 递归收集 compliance-data.ts 导出的所有字符串（页面只 map 本文件，不内联文案）。
    const collect = (value: unknown, acc: string[] = []): string[] => {
      if (typeof value === 'string') {
        acc.push(value)
      } else if (Array.isArray(value)) {
        for (const item of value) collect(item, acc)
      } else if (value && typeof value === 'object') {
        for (const item of Object.values(value as Record<string, unknown>)) {
          collect(item, acc)
        }
      }
      return acc
    }

    const strings = collect(complianceData)
    expect(strings.length).toBeGreaterThan(0)

    const offenders = strings.filter(
      (s) =>
        /[，,；;、：:]$/.test(s.trim()) || /……|\.\.\./.test(s) || /[（(]$/.test(s.trim())
    )
    expect(offenders).toEqual([])
  })

  it('区块 4：企业准入办理六项事项按课件顺序呈现', () => {
    render(<CrossBorderComplianceClient />)

    const admission = document.getElementById('admission')
    expect(admission).not.toBeNull()
    if (!admission) return

    const headings = within(admission).getAllByRole('heading', { level: 3 })
    expect(headings.map((h) => h.textContent)).toEqual([
      '经营范围确认或变更',
      '海关资质备案',
      '办理电子口岸',
      'DXPID',
      '银行（外币账户）',
      '税务局（出口退（免）税备案）',
    ])
  })

  it('区块 5：9810 必备条件与五个材料分组均渲染', () => {
    render(<CrossBorderComplianceClient />)

    const materials = document.getElementById('materials')
    expect(materials).not.toBeNull()
    if (!materials) return

    expect(
      within(materials).getByText('9810 出口退税的必备条件')
    ).toBeInTheDocument()
    expect(
      within(materials).getByText('必须具备一般纳税人资格，同时完成退（免）税备案。')
    ).toBeInTheDocument()

    // 五个材料分组
    for (const group of FIRST_ORDER_MATERIAL_GROUPS) {
      expect(within(materials).getByText(group.name)).toBeInTheDocument()
    }
    expect(FIRST_ORDER_MATERIAL_GROUPS.map((g) => g.name)).toEqual([
      '企业与场地',
      '采购',
      '销售与收汇',
      '出口履约',
      '其他核查材料',
    ])

    // 每组都渲染出条目 checkbox
    const checkboxes = within(materials).getAllByRole('checkbox')
    expect(checkboxes).toHaveLength(TOTAL_MATERIAL_COUNT)
  })

  it('区块 6：报关字段速查逐条渲染', () => {
    render(<CrossBorderComplianceClient />)

    const fields = document.getElementById('fields')
    expect(fields).not.toBeNull()
    if (!fields) return

    for (const field of CUSTOMS_FIELDS) {
      expect(within(fields).getByText(field.name)).toBeInTheDocument()
    }
    expect(CUSTOMS_FIELDS.map((f) => f.name)).toEqual(
      expect.arrayContaining([
        '境内发货人',
        '境外收货人',
        '生产销售单位',
        '合同协议号',
        '商品编号',
        '商品名称',
        '境内货源地',
        '贸易国',
        '运抵国',
        '成交方式',
        '数量及单位',
        '币制',
      ])
    )
  })

  it('自查交互：勾选后进度文本即时更新，「重置」恢复 0/N', async () => {
    const user = userEvent.setup()
    render(<CrossBorderComplianceClient />)

    const progress = screen.getByTestId('material-progress')
    expect(progress).toHaveTextContent(`已核对 0/${TOTAL_MATERIAL_COUNT}`)
    expect(progress).toHaveTextContent('完成 0%')

    const first = screen.getByRole('checkbox', {
      name: FIRST_ORDER_MATERIAL_GROUPS[0].items[0],
    })
    await user.click(first)

    expect(screen.getByTestId('material-progress')).toHaveTextContent(
      `已核对 1/${TOTAL_MATERIAL_COUNT}`
    )
    expect(screen.getByTestId('material-progress')).toHaveTextContent(
      `完成 ${Math.round((1 / TOTAL_MATERIAL_COUNT) * 100)}%`
    )
    expect(first).toBeChecked()

    // 取消勾选 → 回到 0
    await user.click(first)
    expect(screen.getByTestId('material-progress')).toHaveTextContent(
      `已核对 0/${TOTAL_MATERIAL_COUNT}`
    )

    // 勾选两项后点「重置」→ 恢复空状态
    await user.click(
      screen.getByRole('checkbox', {
        name: FIRST_ORDER_MATERIAL_GROUPS[1].items[0],
      })
    )
    await user.click(
      screen.getByRole('checkbox', {
        name: FIRST_ORDER_MATERIAL_GROUPS[2].items[0],
      })
    )
    expect(screen.getByTestId('material-progress')).toHaveTextContent(
      `已核对 2/${TOTAL_MATERIAL_COUNT}`
    )

    await user.click(screen.getByRole('button', { name: '重置' }))

    expect(screen.getByTestId('material-progress')).toHaveTextContent(
      `已核对 0/${TOTAL_MATERIAL_COUNT}`
    )
    expect(screen.getByTestId('material-progress')).toHaveTextContent('完成 0%')
    expect(
      screen.getByRole('checkbox', {
        name: FIRST_ORDER_MATERIAL_GROUPS[1].items[0],
      })
    ).not.toBeChecked()
  })

  it('纯本地：渲染与勾选过程中零 fetch 调用', async () => {
    const user = userEvent.setup()
    render(<CrossBorderComplianceClient />)

    await user.click(
      screen.getByRole('checkbox', {
        name: FIRST_ORDER_MATERIAL_GROUPS[0].items[0],
      })
    )
    await user.click(screen.getByRole('button', { name: '重置' }))

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('页内锚点：五个区块都有稳定 id 可跳转', () => {
    render(<CrossBorderComplianceClient />)

    for (const id of ['chain', 'modes', 'admission', 'materials', 'fields']) {
      expect(document.getElementById(id)).not.toBeNull()
    }

    const nav = screen.getByRole('navigation', { name: '页内导航' })
    const links = within(nav).getAllByRole('link')
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '#chain',
      '#modes',
      '#admission',
      '#materials',
      '#fields',
    ])
  })

  it('材料区域标明这是课件所列清单、且勾选状态只在本页会话', () => {
    render(<CrossBorderComplianceClient />)

    const region = materialsRegion()
    expect(within(region).getByText(/仅为课件所列材料/)).toBeInTheDocument()
    expect(within(region).getByText(/不承诺保留/)).toBeInTheDocument()
  })
})
