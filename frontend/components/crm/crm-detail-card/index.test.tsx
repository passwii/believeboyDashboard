import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CrmDetailCard } from './index'
import { CUSTOMER_FIELD_DEFS } from '@/lib/crm/field-defs/customer'
import type { FieldDefinition } from '@/lib/crm/types/field'

describe('CrmDetailCard', () => {
  it('按 FIELD_DEFS 渲染 label 与值', () => {
    const data: Record<string, unknown> = {
      name: '测试客户',
      status: 'active',
      contactPhone: '13800000000',
      remark: '',
    }
    render(<CrmDetailCard fields={CUSTOMER_FIELD_DEFS} data={data} title="测试客户" />)
    // "测试客户" 同时出现在标题与 name 字段值 → 用 getAllByText
    expect(screen.getAllByText('测试客户').length).toBeGreaterThanOrEqual(2)
    // status select 渲染 label
    expect(screen.getByText('活跃')).toBeTruthy()
    // 空字段渲染占位符
    expect(screen.getAllByText('-').length).toBeGreaterThan(0)
  })

  it('自定义 fields 数组可切换实体（线索复用同一卡片）', () => {
    const leadFields: FieldDefinition[] = [
      { key: 'name', label: '联系人', type: 'text' },
      { key: 'company', label: '公司', type: 'text' },
    ]
    render(<CrmDetailCard fields={leadFields} data={{ name: '张三', company: '甲公司' }} />)
    expect(screen.getByText('联系人')).toBeTruthy()
    expect(screen.getByText('张三')).toBeTruthy()
    expect(screen.getByText('甲公司')).toBeTruthy()
  })
})
