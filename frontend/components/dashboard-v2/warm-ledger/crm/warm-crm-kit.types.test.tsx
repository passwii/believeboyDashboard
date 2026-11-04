import type { ComponentProps, ReactNode } from 'react'
import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  WarmCrmPage,
  WarmCrmRecordDrawer,
  WarmCrmSection,
  WarmCrmState,
  WarmCrmStatusPill,
  WarmCrmTableFrame,
  WarmCrmTableScroller,
  WarmCrmToolbar,
  type WarmCrmRecordDrawerProps,
  type WarmCrmStateKind,
  type WarmCrmStatusTone,
} from './index'

describe('Warm CRM kit public types', () => {
  it('keeps the public API presentational and composable', () => {
    expectTypeOf<ComponentProps<typeof WarmCrmPage>>().toHaveProperty('children')
    expectTypeOf<ComponentProps<typeof WarmCrmSection>>().toHaveProperty('title')
    expectTypeOf<ComponentProps<typeof WarmCrmSection>>().toHaveProperty('actions')
    expectTypeOf<ComponentProps<typeof WarmCrmToolbar>>().toHaveProperty('ariaLabel')
    expectTypeOf<ComponentProps<typeof WarmCrmTableFrame>>().toHaveProperty('footer')
    expectTypeOf<ComponentProps<typeof WarmCrmTableScroller>>().toHaveProperty('ariaLabel')
    expectTypeOf<ComponentProps<typeof WarmCrmStatusPill>>().toHaveProperty('tone')

    expectTypeOf<WarmCrmRecordDrawerProps['title']>().toEqualTypeOf<ReactNode>()
    expectTypeOf<WarmCrmRecordDrawerProps['children']>().toEqualTypeOf<ReactNode>()
    expectTypeOf<WarmCrmStateKind>().toEqualTypeOf<'loading' | 'empty' | 'error'>()
    expectTypeOf<WarmCrmStatusTone>().toEqualTypeOf<
      'neutral' | 'accent' | 'positive' | 'negative'
    >()
  })

  it('requires accessible names while rejecting transport props', () => {
    const tableProps = {
      ariaLabel: '客户表格',
      children: <table />,
    } satisfies ComponentProps<typeof WarmCrmTableScroller>

    const drawerProps = {
      open: true,
      onOpenChange: () => {},
      title: '青山贸易',
      children: <p>客户详情</p>,
    } satisfies ComponentProps<typeof WarmCrmRecordDrawer>

    expectTypeOf(tableProps).not.toHaveProperty('fetchPage')
    expectTypeOf(drawerProps).not.toHaveProperty('customerId')

    // @ts-expect-error The table region must expose an accessible name.
    const missingTableName: ComponentProps<typeof WarmCrmTableScroller> = { children: <table /> }
    // @ts-expect-error The drawer title is an accessibility contract, not optional metadata.
    const missingDrawerTitle: ComponentProps<typeof WarmCrmRecordDrawer> = {
      open: true,
      onOpenChange: () => {},
      children: <p>客户详情</p>,
    }

    expect(missingTableName).toBeDefined()
    expect(missingDrawerTitle).toBeDefined()
  })

  it('accepts only caller-supplied state copy and actions', () => {
    const stateProps = {
      kind: 'error',
      title: '客户加载失败',
      detail: '请稍后重试',
      action: <button type="button">重试</button>,
    } satisfies ComponentProps<typeof WarmCrmState>

    expectTypeOf(stateProps).not.toHaveProperty('onRetry')

    // @ts-expect-error State copy belongs to the page, not a hidden default.
    const missingTitle: ComponentProps<typeof WarmCrmState> = { kind: 'empty' }
    expect(missingTitle).toBeDefined()
  })
})
