'use client'

import { useCallback, useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useNotifications } from '@/components/notifications'
import {
  deleteAlertRule,
  fetchAlertRules,
  updateAlertRule,
  type AlertRuleItem,
} from '@/lib/alerts-api'
import { AlertRuleDialog } from './alert-rule-dialog'

interface ProjectOption {
  id: number
  name: string
}

export function AlertRulesTab({ projects }: { projects: ProjectOption[] }) {
  const { notify } = useNotifications()
  const [rules, setRules] = useState<AlertRuleItem[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<AlertRuleItem | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setRules(await fetchAlertRules())
    } catch (err) {
      notify({ type: 'error', title: '加载规则失败', message: String(err) })
    } finally {
      setLoading(false)
    }
  }, [notify])

  useEffect(() => {
    void load()
  }, [load])

  const toggleActive = async (rule: AlertRuleItem) => {
    try {
      await updateAlertRule(rule.id, { is_active: !rule.is_active })
      void load()
    } catch (err) {
      notify({ type: 'error', title: '切换失败', message: String(err) })
    }
  }

  const onDelete = async (rule: AlertRuleItem) => {
    if (!confirm(`确认删除规则「${rule.name}」？`)) return
    try {
      await deleteAlertRule(rule.id)
      notify({ type: 'success', title: '规则已删除' })
      void load()
    } catch (err) {
      notify({ type: 'error', title: '删除失败', message: String(err) })
    }
  }

  const projectName = (id: number) => projects.find((p) => p.id === id)?.name ?? `#${id}`

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => { setEditing(null); setDialogOpen(true) }}>
          <Plus className="mr-1 h-4 w-4" /> 新建规则
        </Button>
      </div>

      <div className="dashboard-surface rounded-xl">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>项目</TableHead>
              <TableHead>指标</TableHead>
              <TableHead>条件</TableHead>
              <TableHead className="text-right">阈值</TableHead>
              <TableHead>级别</TableHead>
              <TableHead className="text-center">启用</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={8} className="py-8 text-center text-muted-foreground">加载中…</TableCell></TableRow>
            ) : rules.length === 0 ? (
              <TableRow><TableCell colSpan={8} className="py-8 text-center text-muted-foreground">暂无规则，点击右上角新建</TableCell></TableRow>
            ) : (
              rules.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell>{projectName(r.project_id)}</TableCell>
                  <TableCell>{r.metric}</TableCell>
                  <TableCell>{r.condition}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.threshold}%</TableCell>
                  <TableCell>{r.severity}</TableCell>
                  <TableCell className="text-center">
                    <Switch checked={r.is_active} onCheckedChange={() => toggleActive(r)} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="outline" onClick={() => { setEditing(r); setDialogOpen(true) }}>编辑</Button>
                    <Button size="sm" variant="ghost" className="ml-1 text-red-600" onClick={() => onDelete(r)}>删除</Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <AlertRuleDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        rule={editing}
        projects={projects}
        onSaved={load}
      />
    </div>
  )
}
