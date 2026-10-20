import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import CrossBorderComplianceClient from './cross-border-compliance-client'
import {
  CUSTOMS_FIELDS,
  FIRST_ORDER_MATERIAL_GROUPS,
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

/** 取「首单核查材料清单」所在的 TermPanel 区域。 */
function materialsRegion() {
  const progress = screen.getByTestId('material-progress')
  const panel = progress.closest('section')
  if (!panel) throw new Error('未找到首单材料区域')
  return panel
}

describe('CrossBorderComplianceClient', () => {
  it('区块 1：标题、副标题、来源提示与限制性提示均可见', () => {
    render(<CrossBorderComplianceClient />)

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
