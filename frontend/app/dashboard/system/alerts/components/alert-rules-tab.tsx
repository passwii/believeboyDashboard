'use client'

import { useCallback, useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useNotifications } from '@/components/notifications'
import {
  deleteAlertRule,
  fetchAlertRules,
  updateAlertRule,
  type AlertRuleItem,
} from '@/lib/alerts-api'
import { AlertRuleDialog } from './alert-rule-dialog'
import {
  TermBody,
  TermCell,
  TermHead,
  TermRow,
  TermTHead,
  TermTable,
} from '@/components/terminal/term-table'
import { TermPanel } from '@/components/terminal/term-panel'
import { TERM_BUTTON, type TermTone } from '@/components/terminal/term-controls'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'

interface ProjectOption {
  id: number
  name: string
}

const SEVERITY_TONE: Record<string, TermTone> = {
  critical: 'neg',
  warning: 'warn',
  info: 'info',
}

export function AlertRulesTab({
  projects,
  onRefreshReady,
}: {
  projects: ProjectOption[]
  onRefreshReady?: (refresh: () => Promise<void>) => void
}) {
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

  useEffect(() => {
    onRefreshReady?.(load)
  }, [load, onRefreshReady])

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
    <div className="flex min-w-0 flex-col gap-2">
      {/* BLF-838：工具行右对齐终端控件 */}
      <div className="flex justify-end">
        <Button onClick={() => { setEditing(null); setDialogOpen(true) }} className={TERM_BUTTON}>
          <Plus className="h-3.5 w-3.5" /> 新建规则
        </Button>
      </div>

      <TermPanel bodyClassName="p-0 overflow-x-auto">
        <TermTable>
          <TermTHead>
            <TermRow>
              <TermHead>名称</TermHead>
              <TermHead>项目</TermHead>
              <TermHead>指标</TermHead>
              <TermHead>条件</TermHead>
              <TermHead numeric>阈值</TermHead>
              <TermHead>级别</TermHead>
              <TermHead className="text-center">启用</TermHead>
              <TermHead numeric>操作</TermHead>
            </TermRow>
          </TermTHead>
          <TermBody>
            {loading ? (
              <TermRow><TermCell colSpan={8} className="py-8 text-center text-term-faint">加载中…</TermCell></TermRow>
            ) : rules.length === 0 ? (
              <TermRow><TermCell colSpan={8} className="py-8 text-center text-term-faint">暂无规则，点击右上角新建</TermCell></TermRow>
            ) : (
              rules.map((r) => (
                <TermRow key={r.id}>
                  <TermCell className="max-w-[14rem] whitespace-normal font-sans">{r.name}</TermCell>
                  <TermCell>{projectName(r.project_id)}</TermCell>
                  <TermCell>{r.metric}</TermCell>
                  <TermCell className="text-term-muted">{r.condition}</TermCell>
                  <TermCell numeric tone={r.severity === 'critical' ? 'neg' : r.severity === 'warning' ? 'warn' : 'muted'}>{r.threshold}%</TermCell>
                  <TermCell>
                    <span className={`font-mono text-[11px] ${
                      r.severity === 'critical' ? 'text-term-neg' : r.severity === 'warning' ? 'text-term-warn' : 'text-term-text'
                    }`}>
                      {SEVERITY_TONE[r.severity] ? r.severity : r.severity}
                    </span>
                  </TermCell>
                  <TermCell className="text-center">
                    <Switch checked={r.is_active} onCheckedChange={() => toggleActive(r)} />
                  </TermCell>
                  <TermCell numeric>
                    <Button size="sm" variant="outline" className={`${TERM_BUTTON} px-1.5`} onClick={() => { setEditing(r); setDialogOpen(true) }}>编辑</Button>
                    <Button size="sm" variant="ghost" className={`${TERM_BUTTON} border-transparent bg-transparent px-1.5 text-term-neg hover:text-term-neg`} onClick={() => onDelete(r)}>删除</Button>
                  </TermCell>
                </TermRow>
              ))
            )}
          </TermBody>
        </TermTable>
      </TermPanel>

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
