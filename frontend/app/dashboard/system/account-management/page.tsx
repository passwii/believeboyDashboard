'use client'

import { FormEvent, useCallback, useEffect, useState } from 'react'
import { Loader2, MoreHorizontal, RefreshCw, Shield, Store } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EmptyTableState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useNotifications } from '@/components/notifications'
import { UNNAMED_DISPLAY_NAME } from '@/lib/auth/display-name'
import { TermPageShell, TERM_BUTTON } from '@/components/terminal/term-controls'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import { TermPanel } from '@/components/terminal/term-panel'

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
    <span className="inline-flex items-center gap-1 font-mono text-xs text-term-muted">
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
  operatorNameZh?: string | null
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
  const [editOperatorNameZh, setEditOperatorNameZh] = useState('')
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
    // BLF-1441：两个字段各自回填各自的列，不再拿姓名回填运营名
    // （旧实现回填 fullName、保存却写 operator_name_zh，等于悄悄改鉴权键）。
    setEditFullName(user.fullName ?? '')
    setEditOperatorNameZh(user.operatorNameZh ?? '')
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
          // 姓名（full_name）是全局显示名唯一来源；运营名（operator_name_zh）
          // 是项目运营匹配 / 鉴权键，两者必须分开提交（BLF-1441）。
          fullName: editFullName.trim(),
          operator_name_zh: editOperatorNameZh.trim() || null,
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
    // BLF-838：页面标题由 Top Header 面包屑承载；面板走 TermPanel 终端规格
    <TermPageShell>
      <TermPanel
        title="账号管理"
        actions={
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="sm" className={TERM_BUTTON} onClick={() => void load()} disabled={loading}>
              {loading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              刷新
            </Button>
            <Button size="sm" className="h-8 rounded-none font-mono text-xs" onClick={() => setCreateOpen(true)}>
              新增账号
            </Button>
          </div>
        }
        bodyClassName="p-0"
      >
        {/* 桌面端：完整表格 */}
        <div className="hidden md:block">
          <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>名称</TableHead>
                    <TableHead>姓名</TableHead>
                    <TableHead>运营名</TableHead>
                    <TableHead>邮箱</TableHead>
                    <TableHead>角色属性</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>更新时间</TableHead>
                    <TableHead className="w-[140px]">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading ? (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center text-muted-foreground">
                        加载中...
                      </TableCell>
                    </TableRow>
                  ) : items.length === 0 ? (
                    <EmptyTableState colSpan={8} message="暂无账号" />
                  ) : (
                    items.map((item) => {
                      const isProtected = isYaweiAccount(item)
                      return (
                        <TableRow key={item.id}>
                          <TableCell className="font-medium">{getAccountDisplayName(item)}</TableCell>
                          <TableCell>
                            {item.fullName?.trim() ? (
                              item.fullName
                            ) : (
                              <span className="text-term-faint">{UNNAMED_DISPLAY_NAME}</span>
                            )}
                          </TableCell>
                          <TableCell className="text-term-muted">
                            {item.operatorNameZh?.trim() || '-'}
                          </TableCell>
                          <TableCell className="font-mono text-xs">{item.email}</TableCell>
                          <TableCell>
                            <RoleTypeBadge roleType={item.roleType} />
                          </TableCell>
                          <TableCell>
                            <span
                              className={cn(
                                'font-mono text-xs',
                                item.isActive ? 'text-term-pos' : 'text-term-neg'
                              )}
                            >
                              {item.isActive ? '启用' : '停用'}
                            </span>
                          </TableCell>
                          <TableCell className="font-mono text-xs tabular-nums text-term-muted">{fmtTime(item.updatedAt)}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Button
                                variant={item.isActive ? 'outline' : 'default'}
                                size="sm"
                                disabled={busyId === item.id || (isProtected && item.isActive)}
                                onClick={() =>
                                  void updateOne(item.id, { isActive: !item.isActive })
                                }
                              >
                                {item.isActive ? '停用' : '启用'}
                              </Button>
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="outline" size="sm" disabled={busyId === item.id}>
                                    <MoreHorizontal className="h-4 w-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem onClick={() => onEditOpen(item)}>
                                    改角色属性 / 编辑
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    onClick={() => {
                                      setResetUser(item)
                                      setResetOpen(true)
                                    }}
                                  >
                                    重置密码
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    disabled={isProtected}
                                    className="text-destructive focus:text-destructive"
                                    onClick={() => onDeleteOpen(item)}
                                  >
                                    删除账号
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                          </TableCell>
                        </TableRow>
                      )
                    })
                  )}
                </TableBody>
              </Table>
            </div>

            {/* 手机端：卡片列表 */}
            <div className="md:hidden space-y-3 p-4">
              {loading ? (
                <div className="text-center text-sm text-muted-foreground py-8">加载中...</div>
              ) : items.length === 0 ? (
                <div className="text-center text-sm text-muted-foreground py-8">暂无账号</div>
              ) : (
                items.map((item) => {
                  const isProtected = isYaweiAccount(item)
                  return (
                    <div key={item.id} className="space-y-3 border border-term-border bg-term-panel p-4">
                      {/* 头部 */}
                      <div className="flex items-start justify-between gap-2 border-b border-term-border pb-3">
                        <div>
                          <div className="font-semibold">{getAccountDisplayName(item)}</div>
                          <div className="text-xs text-muted-foreground">
                            {item.fullName?.trim() ? (
                              item.fullName
                            ) : (
                              <span className="text-term-faint">{UNNAMED_DISPLAY_NAME}</span>
                            )}
                          </div>
                          <div className="text-xs text-term-faint">
                            运营名：{item.operatorNameZh?.trim() || '-'}
                          </div>
                        </div>
                        <RoleTypeBadge roleType={item.roleType} />
                      </div>

                      {/* 信息 */}
                      <div className="space-y-2 text-sm">
                        <div>
                          <span className="text-xs text-muted-foreground">邮箱</span>
                          <div className="text-sm">{item.email}</div>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-muted-foreground">状态</span>
                          <span
                            className={cn(
                              'font-mono text-sm font-medium tabular-nums',
                              item.isActive ? 'text-term-pos' : 'text-term-neg'
                            )}
                          >
                            {item.isActive ? '启用' : '停用'}
                          </span>
                        </div>
                        <div className="font-mono text-xs text-term-faint">
                          更新: {fmtTime(item.updatedAt)}
                        </div>
                      </div>

                      {/* 操作按钮 */}
                      <div className="flex gap-2 pt-2 border-t border-term-border">
                        <Button
                          variant={item.isActive ? 'outline' : 'default'}
                          size="sm"
                          className="h-9 min-h-[44px] flex-1"
                          disabled={busyId === item.id || (isProtected && item.isActive)}
                          onClick={() => void updateOne(item.id, { isActive: !item.isActive })}
                        >
                          {item.isActive ? '停用' : '启用'}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-9 min-h-[44px] flex-1"
                          disabled={busyId === item.id}
                          onClick={() => onEditOpen(item)}
                        >
                          编辑
                        </Button>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
      </TermPanel>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent
          aria-describedby="create-account-dialog-description"
          className="dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]"
        >
          <span id="create-account-dialog-description" className="sr-only">
            创建新用户并指定角色属性和权限级别
          </span>
          <DialogHeader>
            <DialogTitle>新增账号</DialogTitle>
            <DialogDescription>创建新用户并指定角色属性和权限级别。</DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={onCreate}>
            <div className="space-y-2">
              <Label htmlFor="create-name">名称</Label>
              <Input
                id="create-name"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-full-name">姓名</Label>
              <Input
                id="create-full-name"
                value={createFullName}
                onChange={(e) => setCreateFullName(e.target.value)}
                placeholder="全局显示名，日志 / 负责人 / 创建人都用它"
                required
              />
              <p className="text-xs text-muted-foreground">
                必填：这是全局唯一的显示名。留空的话该账号在各处显示「{UNNAMED_DISPLAY_NAME}」，
                且依赖 X-Operator 的接口（告警偏好 / 订单等）会因缺名字而失败。
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-email">邮箱</Label>
              <Input
                id="create-email"
                type="email"
                value={createEmail}
                onChange={(e) => setCreateEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-password">初始密码</Label>
              <Input
                id="create-password"
                type="password"
                value={createPassword}
                onChange={(e) => setCreatePassword(e.target.value)}
                minLength={8}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-role-type">角色属性</Label>
              <Select
                value={createRoleType}
                onValueChange={(v) => setCreateRoleType(v as UserRoleType)}
              >
                <SelectTrigger id="create-role-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_TYPE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      <span className="inline-flex items-center gap-1.5">
                        {opt.icon}
                        {opt.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {createRoleType === 'admin'
                  ? '管理员拥有系统全局权限。'
                  : '选择用户的业务角色属性。'}
              </p>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setCreateOpen(false)}
                disabled={creating}
              >
                取消
              </Button>
              <Button type="submit" disabled={creating}>
                {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {creating ? '创建中...' : '创建账号'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent
          aria-describedby="reset-password-dialog-description"
          className="dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]"
        >
          <span id="reset-password-dialog-description" className="sr-only">
            为账号设置新密码
          </span>
          <DialogHeader>
            <DialogTitle>重置密码</DialogTitle>
            <DialogDescription>
              为账号 {resetUser?.email || '-'} 设置新密码（至少 8 位）。
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={onResetPassword}>
            <div className="space-y-2">
              <Label htmlFor="reset-password">新密码</Label>
              <Input
                id="reset-password"
                type="password"
                value={resetPassword}
                onChange={(e) => setResetPassword(e.target.value)}
                minLength={8}
                required
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setResetOpen(false)}
                disabled={resetting}
              >
                取消
              </Button>
              <Button type="submit" disabled={resetting}>
                {resetting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {resetting ? '提交中...' : '确认重置'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent
          aria-describedby="edit-account-dialog-description"
          className="dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]"
        >
          <span id="edit-account-dialog-description" className="sr-only">
            修改姓名、运营名和角色属性
          </span>
          <DialogHeader>
            <DialogTitle>编辑账号</DialogTitle>
            <DialogDescription>修改姓名、运营名和角色属性。</DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={onEdit}>
            <div className="space-y-2">
              <Label htmlFor="edit-full-name">姓名</Label>
              <Input
                id="edit-full-name"
                value={editFullName}
                onChange={(e) => setEditFullName(e.target.value)}
                placeholder="全局显示名，日志 / 负责人 / 创建人都用它"
              />
              <p className="text-xs text-muted-foreground">
                全局唯一的显示名。留空时各处显示「{UNNAMED_DISPLAY_NAME}」，不会回落登录名。
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-operator-name-zh">运营名</Label>
              <Input
                id="edit-operator-name-zh"
                value={editOperatorNameZh}
                onChange={(e) => setEditOperatorNameZh(e.target.value)}
                placeholder="用于匹配项目运营 / 助理运营"
              />
              <p className="text-xs text-muted-foreground">
                ⚠ 这是项目权限的匹配键（对应项目里的运营 / 助理运营），不是显示名；
                改错会影响该账号能看到的项目。
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-role-type">角色属性</Label>
              <Select
                value={editRoleType}
                onValueChange={(v) => setEditRoleType(v as UserRoleType)}
              >
                <SelectTrigger id="edit-role-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_TYPE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      <span className="inline-flex items-center gap-1.5">
                        {opt.icon}
                        {opt.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditOpen(false)}
                disabled={editBusy}
              >
                取消
              </Button>
              <Button type="submit" disabled={editBusy}>
                {editBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {editBusy ? '保存中...' : '保存'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent
          aria-describedby="delete-account-dialog-description"
          className="dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]"
        >
          <span id="delete-account-dialog-description" className="sr-only">
            确认删除账号操作
          </span>
          <DialogHeader>
            <DialogTitle>删除账号</DialogTitle>
            <DialogDescription>
              确定要删除账号 <strong>{deleteUser?.email}</strong> 吗？此操作不可恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteOpen(false)}
              disabled={deleting}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void onDelete()}
              disabled={deleting}
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {deleting ? '删除中...' : '确认删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TermPageShell>
  )
}
