'use client'

import { FormEvent, useCallback, useEffect, useState } from 'react'
import { Factory, Loader2, RefreshCw, Shield, Store } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DataCard, DataCardContent, DataCardHeader } from '@/components/ui/data-card'
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useNotifications } from '@/components/notifications'

type UserRoleType = 'admin' | 'operator' | 'businessdev' | 'factory'

const ROLE_TYPE_OPTIONS: { value: UserRoleType; label: string; icon: React.ReactNode }[] = [
  { value: 'admin', label: '管理员', icon: <Shield className="h-3 w-3" /> },
  { value: 'operator', label: '运营', icon: <Shield className="h-3 w-3" /> },
  { value: 'businessdev', label: '招商', icon: <Store className="h-3 w-3" /> },
  { value: 'factory', label: '工厂', icon: <Factory className="h-3 w-3" /> },
]

function RoleTypeBadge({ roleType }: { roleType: UserRoleType }) {
  const option = ROLE_TYPE_OPTIONS.find((o) => o.value === roleType)
  if (!option) return null
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-foreground">
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
  businessdev: 'factory',
  factory: 'operator',
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
  const [editOperatorNameZh, setEditOperatorNameZh] = useState('')
  const [editBusy, setEditBusy] = useState(false)

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
      notify({ type: 'error', title: '加载失败', message: err instanceof Error ? err.message : '加载失败' })
    } finally {
      setLoading(false)
    }
  }, [notify])

  useEffect(() => {
    void load()
  }, [load])

  const updateOne = async (
    id: string,
    patch: Partial<Pick<UserItem, 'isActive' | 'roleType'>>,
  ) => {
    const target = items.find((item) => item.id === id)
    if (
      target &&
      isYaweiAccount(target) &&
      patch.isActive === false
    ) {
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
      notify({ type: 'error', title: '更新失败', message: err instanceof Error ? err.message : '更新失败' })
    } finally {
      setBusyId(null)
    }
  }

  const onCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setCreating(true)
    try {
      const response = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: createName,
          fullName: createFullName,
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
      notify({ type: 'error', title: '创建失败', message: err instanceof Error ? err.message : '创建失败' })
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
      notify({ type: 'error', title: '重置失败', message: err instanceof Error ? err.message : '重置失败' })
    } finally {
      setResetting(false)
    }
  }

  const onEditOpen = (user: UserItem) => {
    setEditUser(user)
    setEditOperatorNameZh(user.operatorNameZh ?? '')
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
        body: JSON.stringify({ operator_name_zh: editOperatorNameZh || null }),
      })
      const data = (await response.json()) as { item?: UserItem; message?: string }
      if (!response.ok || !data.item) {
        throw new Error(data.message || '更新失败')
      }
      setItems((prev) => prev.map((item) => (item.id === editUser.id ? data.item! : item)))
      setEditOpen(false)
      notify({ type: 'success', title: '运营姓名已更新' })
    } catch (err) {
      notify({ type: 'error', title: '更新失败', message: err instanceof Error ? err.message : '更新失败' })
    } finally {
      setEditBusy(false)
    }
  }

  return (
    <div className="w-full space-y-6">
      <DataCard>
        <DataCardHeader
          badge={
            <Badge
              variant="outline"
              className="w-fit rounded-md border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300"
            >
              系统管理
            </Badge>
          }
          title="账号管理"
          description="管理员可维护用户角色属性（管理员/运营/招商/工厂）及账号启停状态。"
          action={
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => void load()} disabled={loading}>
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                刷新
              </Button>
              <Button onClick={() => setCreateOpen(true)}>新增账号</Button>
            </div>
          }
        />
        <DataCardContent className="!p-0 space-y-0">
          <div className="border-t border-border/70 dark:border-border/80 dark:bg-[hsl(var(--surface-soft))]">
            <Table noWrapperRounded>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>姓名</TableHead>
                  <TableHead>邮箱</TableHead>
                  <TableHead>角色属性</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>更新时间</TableHead>
                  <TableHead className="w-[300px]">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-muted-foreground">
                      加载中...
                    </TableCell>
                  </TableRow>
                ) : items.length === 0 ? (
                  <EmptyTableState colSpan={7} message="暂无账号" />
                ) : (
                  items.map((item) => {
                    const isProtected = isYaweiAccount(item)
                    return (
                      <TableRow key={item.id}>
                        <TableCell>{getAccountDisplayName(item)}</TableCell>
                        <TableCell>{item.fullName || item.operatorNameZh || '-'}</TableCell>
                        <TableCell>{item.email}</TableCell>
                        <TableCell>
                          <RoleTypeBadge roleType={item.roleType} />
                        </TableCell>
                        <TableCell>
                          <span
                            className={
                              item.isActive
                                ? 'text-emerald-700 dark:text-emerald-300'
                                : 'text-red-600 dark:text-red-400'
                            }
                          >
                            {item.isActive ? '启用' : '停用'}
                          </span>
                        </TableCell>
                        <TableCell>{fmtTime(item.updatedAt)}</TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busyId === item.id || (isProtected && item.isActive)}
                              onClick={() => void updateOne(item.id, { isActive: !item.isActive })}
                            >
                              {item.isActive ? '停用' : '启用'}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={item.roleType === 'admin' || busyId === item.id}
                              onClick={() => void updateOne(item.id, { roleType: NEXT_ROLE_TYPE[item.roleType as 'operator' | 'businessdev' | 'factory'] })}
                            >
                              改角色属性
                            </Button>
                            <Button
                              size="sm"
                              disabled={busyId === item.id}
                              onClick={() => {
                                setResetUser(item)
                                setResetOpen(true)
                              }}
                            >
                              重置密码
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busyId === item.id}
                              onClick={() => onEditOpen(item)}
                            >
                              编辑
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </DataCardContent>
      </DataCard>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]">
          <DialogHeader>
            <DialogTitle>新增账号</DialogTitle>
            <DialogDescription>创建新用户并指定角色属性和权限级别。</DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={onCreate}>
            <div className="space-y-2">
              <Label htmlFor="create-name">名称</Label>
              <Input id="create-name" value={createName} onChange={(e) => setCreateName(e.target.value)} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-full-name">姓名</Label>
              <Input
                id="create-full-name"
                value={createFullName}
                onChange={(e) => setCreateFullName(e.target.value)}
                placeholder="可选，后续可手动维护"
              />
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
                {createRoleType === 'factory'
                  ? '工厂角色仅可访问新建产品报价页面。'
                  : createRoleType === 'admin'
                  ? '管理员拥有系统全局权限。'
                  : '选择用户的业务角色属性。'}
              </p>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
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
        <DialogContent className="dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]">
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
              <Button type="button" variant="outline" onClick={() => setResetOpen(false)} disabled={resetting}>
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
        <DialogContent className="dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]">
          <DialogHeader>
            <DialogTitle>编辑账号</DialogTitle>
            <DialogDescription>修改运营姓名，用于权限控制和操作记录。</DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={onEdit}>
            <div className="space-y-2">
              <Label htmlFor="edit-operator-name-zh">运营姓名</Label>
              <Input
                id="edit-operator-name-zh"
                value={editOperatorNameZh}
                onChange={(e) => setEditOperatorNameZh(e.target.value)}
                placeholder="工厂用户必须填写，用于权限控制"
              />
              <p className="text-xs text-muted-foreground">
                工厂账号请务必填写，与调研分析权限控制相关
              </p>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditOpen(false)} disabled={editBusy}>
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
    </div>
  )
}
