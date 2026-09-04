import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { renderField } from './render-field'
import type { FieldDefinition } from '@/lib/crm/types/field'

describe('renderField', () => {
  it('空值渲染占位符', () => {
    const field: FieldDefinition = { key: 'name', label: '客户名', type: 'text' }
    render(<div>{renderField(field, '')}</div>)
    expect(screen.getByText('-')).toBeTruthy()
  })

  it('select 渲染选项 label', () => {
    const field: FieldDefinition = {
      key: 'status',
      label: '状态',
      type: 'select',
      options: [{ value: 'active', label: '活跃' }],
    }
    render(<div>{renderField(field, 'active')}</div>)
    expect(screen.getByText('活跃')).toBeTruthy()
  })

  it('multiselect 渲染多个 label', () => {
    const field: FieldDefinition = {
      key: 'tag',
      label: '标签',
      type: 'multiselect',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    }
    render(<div>{renderField(field, ['a', 'b'])}</div>)
    expect(screen.getByText('A')).toBeTruthy()
    expect(screen.getByText('B')).toBeTruthy()
  })

  it('email / url / phone 渲染可点击链接', () => {
    const email: FieldDefinition = { key: 'e', label: '邮箱', type: 'email' }
    const { rerender } = render(<div>{renderField(email, 'a@b.com')}</div>)
    const link = screen.getByRole('link')
    expect(link.getAttribute('href')).toBe('mailto:a@b.com')

    const phone: FieldDefinition = { key: 'p', label: '电话', type: 'phone' }
    rerender(<div>{renderField(phone, '13800000000')}</div>)
    expect(screen.getByRole('link').getAttribute('href')).toBe('tel:13800000000')
  })

  it('textarea 保留换行', () => {
    const field: FieldDefinition = { key: 'remark', label: '备注', type: 'textarea' }
    const { container } = render(<div>{renderField(field, 'line1\nline2')}</div>)
    const p = container.querySelector('p')
    expect(p?.textContent).toContain('line1')
    expect(p?.textContent).toContain('line2')
  })
})
