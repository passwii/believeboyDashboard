'use client'

import { FormEvent, useCallback, useEffect, useState } from 'react'
import { MoreHorizontal, RefreshCw, Shield, Store } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

import { cn } from '@/lib/utils'
import { useNotifications } from '@/components/notifications'
import { UNNAMED_DISPLAY_NAME } from '@/lib/auth/display-name'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import {
  WarmButton,
  WarmIconButton,
} from '@/components/dashboard-v2/warm-ledger/controls'
import styles from './account-management-warm.module.css'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './account-warm-dialog'

type UserRoleType = 'admin' | 'operator' | 'businessdev'

const ROLE_TYPE_OPTIONS: { value: UserRoleType; label: string; icon: React.ReactNode }[] = [
  { value: 'admin', label: '管理员', icon: <Shield className="h-3 w-3" /> },
  { value: 'operator', label: '运营', icon: <Shield className="h-3 w-3" /> },
  { value: 'businessdev', label: '招商', icon: <Store className="h-3 w-3" /> },
]

function RoleTypeBadge({ roleType }: { roleType: UserRoleType }) {
  const option = ROLE_TYPE_OPTIONS.find((o) => o.value === roleType)
  if (!option) return null
  return (
    <span className={styles.roleBadge} data-role-type={roleType}>
      {option.icon}
      {option.label}
    </span>
  )
}

type UserItem = {
  id: string
  name: string
  email: string
  fullName: string | null
  isActive: boolean
  roleType: UserRoleType
  createdAt: string
  updatedAt: string
}

function fmtTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { hour12: false })
}

function isYaweiAccount(item: Pick<UserItem, 'name' | 'email'>) {
  const name = item.name.trim().toLowerCase()
  const email = item.email.trim().toLowerCase()
  return name === 'yawei' || email.startsWith('yawei@')
}

function getAccountDisplayName(item: Pick<UserItem, 'name' | 'email'>) {
  return isYaweiAccount(item) ? 'Yawei' : item.name
}

const NEXT_ROLE_TYPE: Record<Exclude<UserRoleType, 'admin'>, Exclude<UserRoleType, 'admin'>> = {
  operator: 'businessdev',
  businessdev: 'operator',
}

export default function AccountManagementPage() {
  const { notify } = useNotifications()
  const [items, setItems] = useState<UserItem[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)

  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createFullName, setCreateFullName] = useState('')
  const [createEmail, setCreateEmail] = useState('')
  const [createPassword, setCreatePassword] = useState('')
  const [createRoleType, setCreateRoleType] = useState<UserRoleType>('admin')
  const [creating, setCreating] = useState(false)

  const [resetOpen, setResetOpen] = useState(false)
  const [resetPassword, setResetPassword] = useState('')
  const [resetUser, setResetUser] = useState<UserItem | null>(null)
  const [resetting, setResetting] = useState(false)

  const [editOpen, setEditOpen] = useState(false)
  const [editUser, setEditUser] = useState<UserItem | null>(null)
  const [editFullName, setEditFullName] = useState('')
  const [editRoleType, setEditRoleType] = useState<UserRoleType>('operator')
  const [editBusy, setEditBusy] = useState(false)

  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteUser, setDeleteUser] = useState<UserItem | null>(null)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch('/api/admin/users', { cache: 'no-store' })
      const data = (await response.json()) as { items?: UserItem[]; message?: string }
      if (!response.ok) {
        throw new Error(data.message || '加载失败')
      }
      setItems(data.items || [])
    } catch (err) {
      notify({
        type: 'error',
        title: '加载失败',
        message: err instanceof Error ? err.message : '加载失败',
      })
    } finally {
      setLoading(false)
    }
  }, [notify])

  useEffect(() => {
    void load()
  }, [load])

  useHeaderRefresh(load, { loading })

  const updateOne = async (id: string, patch: Partial<Pick<UserItem, 'isActive' | 'roleType'>>) => {
    const target = items.find((item) => item.id === id)
    if (target && isYaweiAccount(target) && patch.isActive === false) {
      notify({ type: 'error', title: 'Yawei 账号不允许停用' })
      return
    }

    setBusyId(id)
    try {
      const response = await fetch(`/api/admin/users/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const data = (await response.json()) as { item?: UserItem; message?: string }
      if (!response.ok || !data.item) {
        throw new Error(data.message || '更新失败')
      }
      setItems((prev) => prev.map((item) => (item.id === id ? data.item! : item)))
      notify({ type: 'success', title: '更新成功' })
    } catch (err) {
      notify({
        type: 'error',
        title: '更新失败',
        message: err instanceof Error ? err.message : '更新失败',
      })
    } finally {
      setBusyId(null)
    }
  }

  const onCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    // 姓名是全局唯一显示名，后端会 strip 后落库；只靠 HTML `required` 挡不住
    // `'   '`（非空但不含内容），所以这里显式 trim 再判空，并把 trim 后的值发出去。
    const fullName = createFullName.trim()
    if (!fullName) {
      notify({ type: 'error', title: '请填写姓名' })
      return
    }
    setCreating(true)
    try {
      const response = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: createName,
          fullName,
          email: createEmail,
          password: createPassword,
          roleType: createRoleType,
        }),
      })
      const data = (await response.json()) as { item?: UserItem; message?: string }
      if (!response.ok || !data.item) {
        throw new Error(data.message || '创建失败')
      }
      setItems((prev) => [data.item!, ...prev])
      setCreateOpen(false)
      setCreateName('')
      setCreateFullName('')
      setCreateEmail('')
      setCreatePassword('')
      setCreateRoleType('operator')
      notify({ type: 'success', title: '用户创建成功' })
    } catch (err) {
      notify({
        type: 'error',
        title: '创建失败',
        message: err instanceof Error ? err.message : '创建失败',
      })
    } finally {
      setCreating(false)
    }
  }

  const onResetPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!resetUser) return
    setResetting(true)
    try {
      const response = await fetch(`/api/admin/users/${resetUser.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: resetPassword }),
      })
      const data = (await response.json()) as { item?: UserItem; message?: string }
      if (!response.ok || !data.item) {
        throw new Error(data.message || '重置失败')
      }
      setItems((prev) => prev.map((item) => (item.id === resetUser.id ? data.item! : item)))
      setResetOpen(false)
      setResetPassword('')
      setResetUser(null)
      notify({ type: 'success', title: '密码已重置' })
    } catch (err) {
      notify({
        type: 'error',
        title: '重置失败',
        message: err instanceof Error ? err.message : '重置失败',
      })
    } finally {
      setResetting(false)
    }
  }

  const onEditOpen = (user: UserItem) => {
    setEditUser(user)
    // BLF-1441：姓名（full_name）是唯一显示名；运营名（operator_name_zh）已随
    // 后端 #778 删除，编辑弹窗不再有这一栏。
    setEditFullName(user.fullName ?? '')
    setEditRoleType(user.roleType)
    setEditOpen(true)
  }

  const onEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!editUser) return
    setEditBusy(true)
    try {
      const response = await fetch(`/api/admin/users/${editUser.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // 姓名（full_name）是全局显示名唯一来源（BLF-1441）；运营名已删除。
          fullName: editFullName.trim(),
          // 路由层读的是 camelCase `roleType`（旧代码发 role_type 被静默丢弃，
          // 改角色属性实际不生效）。
          roleType: editRoleType,
        }),
      })
      const data = (await response.json()) as { item?: UserItem; message?: string }
      if (!response.ok || !data.item) {
        throw new Error(data.message || '更新失败')
      }
      setItems((prev) => prev.map((item) => (item.id === editUser.id ? data.item! : item)))
      setEditOpen(false)
      notify({ type: 'success', title: '账号已更新' })
    } catch (err) {
      notify({
        type: 'error',
        title: '更新失败',
        message: err instanceof Error ? err.message : '更新失败',
      })
    } finally {
      setEditBusy(false)
    }
  }

  const onDeleteOpen = (user: UserItem) => {
    setDeleteUser(user)
    setDeleteOpen(true)
  }

  const onDelete = async () => {
    if (!deleteUser) return
    setDeleting(true)
    try {
      const response = await fetch(`/api/admin/users/${deleteUser.id}`, { method: 'DELETE' })
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { message?: string }
        throw new Error(data.message || '删除失败')
      }
      setItems((prev) => prev.filter((item) => item.id !== deleteUser.id))
      setDeleteOpen(false)
      notify({ type: 'success', title: '账号已删除' })
    } catch (err) {
      notify({
        type: 'error',
        title: '删除失败',
        message: err instanceof Error ? err.message : '删除失败',
      })
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className={styles.page} data-warm-account-management="true">
      <section className={styles.panel} aria-labelledby="account-management-title">
        <header className={styles.panelHeader}>
          <h1 id="account-management-title" className={styles.panelTitle}>
            账号管理
          </h1>
          <div className={styles.panelActions}>
            <WarmButton
              variant="secondary"
              onClick={() => void load()}
              loading={loading}
              loadingLabel="正在刷新账号列表"
            >
              {loading ? null : <RefreshCw className={styles.actionIcon} aria-hidden />}
              {loading ? '刷新中...' : '刷新'}
            </WarmButton>
            <WarmButton variant="primary" onClick={() => setCreateOpen(true)}>
              新增账号
            </WarmButton>
          </div>
        </header>

        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>名称</th>
                <th>姓名</th>
                <th>邮箱</th>
                <th>角色属性</th>
                <th>状态</th>
                <th>更新时间</th>
                <th className={styles.operationsColumn}>操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className={styles.emptyCell}>
                    加载中...
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={7} className={styles.emptyCell}>
                    暂无账号
                  </td>
                </tr>
              ) : (
                items.map((item) => {
                  const isProtected = isYaweiAccount(item)
                  return (
                    <tr key={item.id}>
                      <td className={styles.primaryCell}>{getAccountDisplayName(item)}</td>
                      <td>
                        {item.fullName?.trim() ? (
                          item.fullName
                        ) : (
                          <span className={styles.faintText}>{UNNAMED_DISPLAY_NAME}</span>
                        )}
                      </td>
                      <td className={styles.monoCell}>{item.email}</td>
                      <td>
                        <RoleTypeBadge roleType={item.roleType} />
                      </td>
                      <td>
                        <span
                          className={cn(
                            styles.status,
                            item.isActive ? styles.statusActive : styles.statusInactive
                          )}
                          data-account-status={item.isActive ? 'active' : 'inactive'}
                        >
                          {item.isActive ? '启用' : '停用'}
                        </span>
                      </td>
                      <td className={styles.timeCell}>{fmtTime(item.updatedAt)}</td>
                      <td>
                        <div className={styles.rowActions}>
                          <WarmButton
                            variant={item.isActive ? 'secondary' : 'primary'}
                            className={styles.rowAction}
                            disabled={busyId === item.id || (isProtected && item.isActive)}
                            onClick={() =>
                              void updateOne(item.id, { isActive: !item.isActive })
                            }
                          >
                            {item.isActive ? '停用' : '启用'}
                          </WarmButton>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <WarmIconButton
                                aria-label="更多操作"
                                disabled={busyId === item.id}
                              >
                                <MoreHorizontal className={styles.moreIcon} aria-hidden />
                              </WarmIconButton>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className={styles.menuContent}>
                              <DropdownMenuItem
                                className={styles.menuItem}
                                onClick={() => onEditOpen(item)}
                              >
                                改角色属性 / 编辑
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className={styles.menuItem}
                                onClick={() => {
                                  setResetUser(item)
                                  setResetOpen(true)
                                }}
                              >
                                重置密码
                              </DropdownMenuItem>
                              <DropdownMenuSeparator className={styles.menuSeparator} />
                              <DropdownMenuItem
                                disabled={isProtected}
                                className={cn(styles.menuItem, styles.menuDanger)}
                                onClick={() => onDeleteOpen(item)}
                              >
                                删除账号
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent
          aria-describedby="create-account-dialog-description"
        >
          <span id="create-account-dialog-description" className="sr-only">
            创建新用户并指定角色属性和权限级别
          </span>
          <DialogHeader>
            <DialogTitle>新增账号</DialogTitle>
            <DialogDescription className={styles.dialogDescription}>
              创建新用户并指定角色属性和权限级别。
            </DialogDescription>
          </DialogHeader>
          <form className={styles.form} onSubmit={onCreate}>
            <div className={styles.field}>
              <label htmlFor="create-name" className={styles.label}>名称</label>
              <input
                id="create-name"
                className={styles.input}
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                required
              />
            </div>
            <div className={styles.field}>
              <label htmlFor="create-full-name" className={styles.label}>姓名</label>
              <input
                id="create-full-name"
                className={styles.input}
                value={createFullName}
                onChange={(e) => setCreateFullName(e.target.value)}
                placeholder="全局显示名，日志 / 负责人 / 创建人都用它"
                required
              />
              <p className={styles.helpText}>
                必填：这是全局唯一的显示名。留空的话该账号在各处显示「{UNNAMED_DISPLAY_NAME}」，
                且依赖 X-Operator 的接口（告警偏好 / 订单等）会因缺名字而失败。
              </p>
            </div>
            <div className={styles.field}>
              <label htmlFor="create-email" className={styles.label}>邮箱</label>
              <input
                id="create-email"
                className={styles.input}
                type="email"
                value={createEmail}
                onChange={(e) => setCreateEmail(e.target.value)}
                required
              />
            </div>
            <div className={styles.field}>
              <label htmlFor="create-password" className={styles.label}>初始密码</label>
              <input
                id="create-password"
                className={styles.input}
                type="password"
                value={createPassword}
                onChange={(e) => setCreatePassword(e.target.value)}
                minLength={8}
                required
              />
            </div>
            <div className={styles.field}>
              <label htmlFor="create-role-type" className={styles.label}>角色属性</label>
              <select
                id="create-role-type"
                className={styles.selectTrigger}
                value={createRoleType}
                onChange={(event) =>
                  setCreateRoleType(event.target.value as UserRoleType)
                }
              >
                {ROLE_TYPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <p className={styles.helpText}>
                {createRoleType === 'admin'
                  ? '管理员拥有系统全局权限。'
                  : '选择用户的业务角色属性。'}
              </p>
            </div>
            <DialogFooter className={styles.dialogFooter}>
              <WarmButton
                type="button"
                onClick={() => setCreateOpen(false)}
                disabled={creating}
              >
                取消
              </WarmButton>
              <WarmButton
                type="submit"
                variant="primary"
                disabled={creating}
                loading={creating}
                loadingLabel="正在创建账号"
              >
                {creating ? '创建中...' : '创建账号'}
              </WarmButton>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent
          aria-describedby="reset-password-dialog-description"
        >
          <span id="reset-password-dialog-description" className="sr-only">
            为账号设置新密码
          </span>
          <DialogHeader>
            <DialogTitle>重置密码</DialogTitle>
            <DialogDescription className={styles.dialogDescription}>
              为账号 {resetUser?.email || '-'} 设置新密码（至少 8 位）。
            </DialogDescription>
          </DialogHeader>
          <form className={styles.form} onSubmit={onResetPassword}>
            <div className={styles.field}>
              <label htmlFor="reset-password" className={styles.label}>新密码</label>
              <input
                id="reset-password"
                className={styles.input}
                type="password"
                value={resetPassword}
                onChange={(e) => setResetPassword(e.target.value)}
                minLength={8}
                required
              />
            </div>
            <DialogFooter className={styles.dialogFooter}>
              <WarmButton
                type="button"
                onClick={() => setResetOpen(false)}
                disabled={resetting}
              >
                取消
              </WarmButton>
              <WarmButton
                type="submit"
                variant="primary"
                disabled={resetting}
                loading={resetting}
                loadingLabel="正在重置密码"
              >
                {resetting ? '提交中...' : '确认重置'}
              </WarmButton>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent
          aria-describedby="edit-account-dialog-description"
        >
          <span id="edit-account-dialog-description" className="sr-only">
            修改姓名和角色属性
          </span>
          <DialogHeader>
            <DialogTitle>编辑账号</DialogTitle>
            <DialogDescription className={styles.dialogDescription}>
              修改姓名和角色属性。
            </DialogDescription>
          </DialogHeader>
          <form className={styles.form} onSubmit={onEdit}>
            <div className={styles.field}>
              <label htmlFor="edit-full-name" className={styles.label}>姓名</label>
              <input
                id="edit-full-name"
                className={styles.input}
                value={editFullName}
                onChange={(e) => setEditFullName(e.target.value)}
                placeholder="全局显示名，日志 / 负责人 / 创建人都用它"
              />
              <p className={styles.helpText}>
                全局唯一的显示名。留空时各处显示「{UNNAMED_DISPLAY_NAME}」，不会回落登录名。
              </p>
            </div>
            <div className={styles.field}>
              <label htmlFor="edit-role-type" className={styles.label}>角色属性</label>
              <select
                id="edit-role-type"
                className={styles.selectTrigger}
                value={editRoleType}
                onChange={(event) =>
                  setEditRoleType(event.target.value as UserRoleType)
                }
              >
                {ROLE_TYPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <DialogFooter className={styles.dialogFooter}>
              <WarmButton
                type="button"
                onClick={() => setEditOpen(false)}
                disabled={editBusy}
              >
                取消
              </WarmButton>
              <WarmButton
                type="submit"
                variant="primary"
                disabled={editBusy}
                loading={editBusy}
                loadingLabel="正在保存账号"
              >
                {editBusy ? '保存中...' : '保存'}
              </WarmButton>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent
          aria-describedby="delete-account-dialog-description"
        >
          <span id="delete-account-dialog-description" className="sr-only">
            确认删除账号操作
          </span>
          <DialogHeader>
            <DialogTitle>删除账号</DialogTitle>
            <DialogDescription className={styles.dialogDescription}>
              确定要删除账号 <strong>{deleteUser?.email}</strong> 吗？此操作不可恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className={styles.dialogFooter}>
            <WarmButton
              type="button"
              onClick={() => setDeleteOpen(false)}
              disabled={deleting}
            >
              取消
            </WarmButton>
            <WarmButton
              type="button"
              variant="secondary"
              className={styles.dangerButton}
              onClick={() => void onDelete()}
              disabled={deleting}
              loading={deleting}
              loadingLabel="正在删除账号"
            >
              {deleting ? '删除中...' : '确认删除'}
            </WarmButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
