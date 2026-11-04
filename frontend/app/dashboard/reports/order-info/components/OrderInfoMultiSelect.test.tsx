import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { OrderInfoMultiSelect } from './OrderInfoMultiSelect'

const options = [
  { value: 'alpha', label: 'Alpha' },
  { value: 'beta', label: 'Beta' },
]

describe('OrderInfoMultiSelect', () => {
  it.each([
    ['Enter', '{Enter}'],
    ['Space', ' '],
    ['ArrowDown', '{ArrowDown}'],
  ])('opens from the focused trigger with %s and focuses the search input', async (_keyName, key) => {
    const user = userEvent.setup()
    const onOpen = vi.fn()

    render(
      <OrderInfoMultiSelect
        options={options}
        selected={[]}
        onChange={vi.fn()}
        onOpen={onOpen}
      />
    )

    const trigger = screen.getByRole('combobox')
    trigger.focus()
    expect(trigger).toHaveFocus()

    await user.keyboard(key)

    const search = await screen.findByPlaceholderText('搜索...')
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(search).toHaveFocus()
    expect(onOpen).toHaveBeenCalledTimes(1)

    await user.keyboard('Beta')
    expect(search).toHaveValue('Beta')
    expect(await screen.findByRole('option', { name: 'Beta' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Alpha' })).not.toBeInTheDocument()
  })

  it.each([
    ['Enter', '{Enter}'],
    ['Space', ' '],
  ])('keeps nested chip remove behavior and does not open on %s', async (_keyName, key) => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const onOpen = vi.fn()

    render(
      <OrderInfoMultiSelect
        options={options}
        selected={['alpha', 'beta']}
        onChange={onChange}
        onOpen={onOpen}
      />
    )

    const trigger = screen.getByRole('combobox')
    const removeAlpha = screen.getByRole('button', { name: '移除 Alpha' })
    removeAlpha.focus()

    await user.keyboard(key)

    expect(onChange).toHaveBeenCalledWith(['beta'])
    expect(onOpen).not.toHaveBeenCalled()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByPlaceholderText('搜索...')).not.toBeInTheDocument()
  })
})
