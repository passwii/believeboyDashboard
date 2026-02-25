'use client'

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, RefreshCw, Shield } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

type UserItem = {
  id: string
  name: string
  email: string
  isAdmin: boolean
  isActive: boolean
  createdAt: string
  updatedAt: string
}

function fmtTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { hour12: false })
}

export default function AccountManagementPage() {
  const [items, setItems] = useState<UserItem[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createEmail, setCreateEmail] = useState('')
  const [createPassword, setCreatePassword] = useState('')
  const [createIsAdmin, setCreateIsAdmin] = useState(false)
  const [creating, setCreating] = useState(false)

  const [resetOpen, setResetOpen] = useState(false)
  const [resetPassword, setResetPassword] = useState('')
  const [resetUser, setResetUser] = useState<UserItem | null>(null)
  const [resetting, setResetting] = useState(false)

  const adminCount = useMemo(() => items.filter((item) => item.isAdmin).length, [items])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/admin/users', { cache: 'no-store' })
      const data = (await response.json()) as { items?: UserItem[]; message?: string }
      if (!response.ok) {
        throw new Error(data.message || '加载失败')
      }
      setItems(data.items || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const updateOne = async (id: string, patch: Partial<Pick<UserItem, 'isAdmin' | 'isActive'>>) => {
    setBusyId(id)
    setError(null)
    setSuccess(null)
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
      setSuccess('更新成功')
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新失败')
    } finally {
      setBusyId(null)
    }
  }

  const onCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setCreating(true)
    setError(null)
    setSuccess(null)
    try {
      const response = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: createName,
          email: createEmail,
          password: createPassword,
          isAdmin: createIsAdmin,
        }),
      })
      const data = (await response.json()) as { item?: UserItem; message?: string }
      if (!response.ok || !data.item) {
        throw new Error(data.message || '创建失败')
      }
      setItems((prev) => [data.item!, ...prev])
      setCreateOpen(false)
      setCreateName('')
      setCreateEmail('')
      setCreatePassword('')
      setCreateIsAdmin(false)
      setSuccess('用户创建成功')
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败')
    } finally {
      setCreating(false)
    }
  }

  const onResetPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!resetUser) return
    setResetting(true)
    setError(null)
    setSuccess(null)
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
      setSuccess('密码已重置')
    } catch (err) {
      setError(err instanceof Error ? err.message : '重置失败')
    } finally {
      setResetting(false)
    }
  }

  return (
    <div className="mx-auto max-w-[1320px] space-y-6">
      <Card className="border-border/80 shadow-[0_20px_40px_-22px_rgba(15,23,42,0.22)]">
        <CardHeader className="space-y-3">
          <Badge variant="outline" className="w-fit rounded-md border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300">
            系统管理
          </Badge>
          <CardTitle>账号管理</CardTitle>
          <CardDescription>管理员可手动维护普通用户/管理员权限，以及账号启停和密码重置。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-muted-foreground">共 {items.length} 个账号，其中管理员 {adminCount} 个。</div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => void load()} disabled={loading}>
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                刷新
              </Button>
              <Button onClick={() => setCreateOpen(true)}>新增账号</Button>
            </div>
          </div>

          {error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
          ) : null}
          {success ? (
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
              {success}
            </div>
          ) : null}

          <div className="rounded-lg border border-border/70">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>邮箱</TableHead>
                  <TableHead>角色</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>更新时间</TableHead>
                  <TableHead className="w-[300px]">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground">
                      加载中...
                    </TableCell>
                  </TableRow>
                ) : items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground">
                      暂无账号
                    </TableCell>
                  </TableRow>
                ) : (
                  items.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>{item.name}</TableCell>
                      <TableCell>{item.email}</TableCell>
                      <TableCell>
                        {item.isAdmin ? (
                          <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
                            <Shield className="h-3.5 w-3.5" />
                            管理员
                          </span>
                        ) : (
                          '普通用户'
                        )}
                      </TableCell>
                      <TableCell>{item.isActive ? '启用' : '停用'}</TableCell>
                      <TableCell>{fmtTime(item.updatedAt)}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busyId === item.id}
                            onClick={() => void updateOne(item.id, { isAdmin: !item.isAdmin })}
                          >
                            {item.isAdmin ? '取消管理员' : '设为管理员'}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busyId === item.id}
                            onClick={() => void updateOne(item.id, { isActive: !item.isActive })}
                          >
                            {item.isActive ? '停用' : '启用'}
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
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新增账号</DialogTitle>
            <DialogDescription>创建新用户并指定是否管理员。</DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={onCreate}>
            <div className="space-y-2">
              <Label htmlFor="create-name">名称</Label>
              <Input id="create-name" value={createName} onChange={(e) => setCreateName(e.target.value)} required />
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
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={createIsAdmin}
                onChange={(e) => setCreateIsAdmin(e.target.checked)}
              />
              设为管理员
            </label>
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
        <DialogContent>
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
    </div>
  )
}
