import { describe, expect, it } from 'vitest'

import { deriveRole, type ProjectItem } from './profile-projects-tab-shared'
import { projectOwnerNames } from './profile-projects-tab'

/**
 * BLF-1441 ·「我的项目」的匹配键。
 *
 * 后端 `list_project_operator_options` 与 `X-Operator` 都只发 `full_name`，
 * `projects.project_operator` 里的文本也就是它。所以前端匹配键必须同样只取
 * `full_name`——混进运营名 / 登录名会造出「页面显示有项目、点进去 403」的错位。
 */

function project(overrides: Partial<ProjectItem> = {}): ProjectItem {
  return {
    id: 1,
    name: '店铺甲',
    brand_name: null,
    store_address: null,
    project_operator: '纪亚伟',
    assistant_operator: null,
    commission_basis: null,
    commission_rate: null,
    is_active: true,
    project_tier: null,
    ...overrides,
  }
}

describe('projectOwnerNames', () => {
  it('用 full_name 作为唯一匹配键', () => {
    expect(projectOwnerNames('纪亚伟')).toEqual(['纪亚伟'])
  })

  it('去掉首尾空白', () => {
    expect(projectOwnerNames('  纪亚伟 ')).toEqual(['纪亚伟'])
  })

  it('没有姓名时为空列表（不回落登录名）', () => {
    expect(projectOwnerNames(null)).toEqual([])
    expect(projectOwnerNames(undefined)).toEqual([])
    expect(projectOwnerNames('   ')).toEqual([])
  })
})

describe('deriveRole 与 full_name 匹配', () => {
  it('主运营匹配成功', () => {
    expect(deriveRole(project(), projectOwnerNames('纪亚伟'))).toBe('主运营')
  })

  it('助理运营匹配成功', () => {
    expect(
      deriveRole(project({ project_operator: '桑喜刚', assistant_operator: '纪亚伟' }), projectOwnerNames('纪亚伟'))
    ).toBe('助理运营')
  })

  it('多个运营名用顿号分隔也能匹配', () => {
    expect(
      deriveRole(project({ project_operator: '纪亚伟、桑喜刚' }), projectOwnerNames('桑喜刚'))
    ).toBe('主运营')
  })

  it('没有姓名时一个项目都匹配不上（列表为空而不是错配）', () => {
    expect(deriveRole(project(), projectOwnerNames(null))).toBeNull()
  })

  it('姓名与项目运营名不一致时不匹配（权限按文本，不按账号）', () => {
    expect(deriveRole(project(), projectOwnerNames('Yawei'))).toBeNull()
  })
})
