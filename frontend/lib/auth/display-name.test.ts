import { describe, expect, it } from 'vitest'

import {
  UNNAMED_DISPLAY_NAME,
  formatDisplayName,
  pickSessionDisplayName,
} from './display-name'

/**
 * BLF-1441 三条规则的前端落点。
 *
 * 口径（业务方定死）：全局 person 显示名只取 `user_accounts.full_name`；
 * 运营名（operator_name_zh）已随后端 #778 删除，会话与类型里不再有这一层。
 * 这里把「账号存在 / 没填姓名 / 键缺失」三种情况分开锁住，
 * 尤其是**不能**把登录名当显示名兜底又装回去。
 */
describe('pickSessionDisplayName', () => {
  it('账号存在：取 full_name，即使登录名不同', () => {
    expect(
      pickSessionDisplayName({
        fullName: '纪亚伟',
        name: 'Yawei',
      })
    ).toBe('纪亚伟')
  })

  it('full_name 与登录名同时存在：取 full_name', () => {
    expect(pickSessionDisplayName({ fullName: '纪亚伟', name: 'Yawei' })).toBe('纪亚伟')
  })

  it('full_name 为空串 / 只有空白：视为没名字，不回落登录名', () => {
    expect(pickSessionDisplayName({ fullName: '   ', name: 'Yawei' })).toBeNull()
    expect(pickSessionDisplayName({ fullName: '', name: 'Yawei' })).toBeNull()
  })

  it('full_name 为 null（后端明确没填）：同样不回落', () => {
    expect(pickSessionDisplayName({ fullName: null, name: 'Yawei' })).toBeNull()
  })

  it('账号不存在 / 未登录：没有会话就没有名字', () => {
    expect(pickSessionDisplayName(null)).toBeNull()
    expect(pickSessionDisplayName(undefined)).toBeNull()
    expect(pickSessionDisplayName({})).toBeNull()
  })

  it('去掉首尾空白', () => {
    expect(pickSessionDisplayName({ fullName: '  纪亚伟  ' })).toBe('纪亚伟')
  })

  it('过渡期：键缺失（#776 之前签发的 JWT / 旧后端）才回落登录名', () => {
    // 不这样处理的话，升级瞬间所有在线用户的名字变「未命名」、X-Operator 消失，
    // 告警 / 订单等强校验接口会 401，最长持续一个 8 小时会话窗口。
    // 运营名已删（#778），过渡兜底链只剩登录名。
    expect(pickSessionDisplayName({ name: 'Yawei' })).toBe('Yawei')
    expect(pickSessionDisplayName({ name: null })).toBeNull()
    expect(pickSessionDisplayName({ name: '  ' })).toBeNull()
  })

  it('过渡期的兜底也不会返回空串', () => {
    expect(pickSessionDisplayName({ name: '' })).toBeNull()
    expect(pickSessionDisplayName({})).toBeNull()
  })
})

describe('formatDisplayName', () => {
  it('有名字用名字', () => {
    expect(formatDisplayName('纪亚伟')).toBe('纪亚伟')
  })

  it('没有名字显示「未命名」，不是登录名也不是空白', () => {
    expect(formatDisplayName(null)).toBe(UNNAMED_DISPLAY_NAME)
    expect(formatDisplayName(undefined)).toBe(UNNAMED_DISPLAY_NAME)
    expect(formatDisplayName('   ')).toBe(UNNAMED_DISPLAY_NAME)
  })
})
