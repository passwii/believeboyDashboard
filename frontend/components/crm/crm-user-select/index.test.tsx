import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CrmUserSelect } from './index'
import type { User } from '@/lib/crm/types/user'

const users: User[] = [
  { id: 'u1', name: '小王', email: 'a@b.com', roleType: 'businessdev', isActive: true },
  { id: 'u2', name: '小李', email: 'c@d.com', roleType: 'operator', isActive: true },
]

describe('CrmUserSelect', () => {
  it('默认显示占位符', () => {
    render(<CrmUserSelect users={users} onChange={vi.fn()} />)
    expect(screen.getByText('选择负责人')).toBeTruthy()
  })

  it('选中用户后显示其名', () => {
    render(<CrmUserSelect users={users} value="u1" onChange={vi.fn()} />)
    expect(screen.getByText('小王')).toBeTruthy()
  })

  it('allowClear 时提供清空项', () => {
    render(<CrmUserSelect users={users} allowClear onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('combobox'))
    expect(screen.getByText('（清空 / 移入公海）')).toBeTruthy()
  })
})
