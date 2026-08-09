'use client'

import { useCallback, useEffect, useState } from 'react'
import { Pencil, Plus, RefreshCcw, ShieldAlert, Trash2, Workflow } from 'lucide-react'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import { useNotifications } from '@/components/notifications'
import { useConfirm } from '@/hooks/use-confirm'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { CrmRuleEditor } from './crm-rule-editor'
import { describeRule } from './crm-rule-editor/rule-editor-utils'
import type { Rule, RuleInput } from '@/lib/crm/types'

/**
 * 规则引擎设置面板（P9-7，BLF-545，admin 设置页）。
 *
 * 「当 X 发生，做 Y」可视化编辑器：规则列表 + 启停 + 编辑/删除。
 * 可见性：sidebar 不做角色墙（roles 已移除），权限由后端 require_admin 兜底——
 * 非管理员调用 listRules 返回 403 → 展示「无权限」而非报错（沿用 audit 页范式）。
 */
export function CrmRulesPanel() {
  const client = useCrmClient()
  const { notify } = useNotifications()
  const { confirm } = useConfirm()

  const [rules, setRules] = useState<Rule[]>([])
  const [loading, setLoading] = useState(true)
  const [forbidden, setForbidden] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<Rule | undefined>(undefined)

  const load = useCallback(async () => {
    setLoading(true)
    setForbidden(false)
    try {
      const list = await client.listRules()
      setRules(list)
    } catch {
      // 后端 require_admin 对非管理员返回 403 → 展示「无权限」
      setForbidden(true)
    } finally {
      setLoading(false)
    }
  }, [client])

  useEffect(() => {
    void load()
  }, [load])

  function openCreate() {
    setEditing(undefined)
    setEditorOpen(true)
  }

  function openEdit(rule: Rule) {
    setEditing(rule)
    setEditorOpen(true)
  }

  async function handleSave(input: RuleInput) {
    try {
      if (editing) {
        const updated = await client.updateRule(editing.id, input)
        setRules((prev) => prev.map((r) => (r.id === updated.id ? updated : r)))
        notify({ type: 'success', title: '规则已更新' })
      } else {
        const created = await client.createRule(input)
        setRules((prev) => [created, ...prev])
        notify({ type: 'success', title: '规则已创建' })
      }
      setEditorOpen(false)
    } catch {
      notify({ type: 'error', title: '保存失败', message: '请稍后重试' })
    }
  }

  async function handleToggle(rule: Rule, enabled: boolean) {
    try {
      const updated = await client.updateRule(rule.id, { enabled })
      setRules((prev) => prev.map((r) => (r.id === updated.id ? updated : r)))
      notify({ type: 'success', title: enabled ? '规则已启用' : '规则已停用' })
    } catch {
      notify({ type: 'error', title: '操作失败', message: '请稍后重试' })
    }
  }

  async function handleDelete(rule: Rule) {
    const ok = await confirm({
      title: '删除规则',
      description: `确定删除「${rule.name}」？删除后每日扫描将不再执行该规则。`,
      confirmText: '删除',
      variant: 'destructive',
    })
    if (!ok) return
    try {
      await client.deleteRule(rule.id)
      setRules((prev) => prev.filter((r) => r.id !== rule.id))
      notify({ type: 'success', title: '规则已删除' })
    } catch {
      notify({ type: 'error', title: '删除失败', message: '请稍后重试' })
    }
  }

  return (
    <div className="space-y-4">
      {/* 页头 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <Workflow className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            规则引擎
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            可视化配置「当 X 发生，做 Y」自动化规则（每日 09:05 自动扫描执行，仅管理员可见）
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
            aria-label="刷新规则列表"
          >
            <RefreshCcw className={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
            刷新
          </Button>
          <Button type="button" size="sm" onClick={openCreate} disabled={forbidden}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            新建规则
          </Button>
        </div>
      </div>

      {/* 无权限（403）：非管理员访问时的兜底展示 */}
      {forbidden ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-6 py-12 text-center">
          <ShieldAlert className="h-8 w-8 text-amber-600 dark:text-amber-400" aria-hidden="true" />
          <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
            无权限管理规则引擎（仅管理员）
          </p>
        </div>
      ) : (
        <>
          {loading ? (
            <div className="space-y-2">
              {[0, 1].map((i) => (
                <div
                  key={i}
                  className="h-24 animate-pulse rounded-lg border bg-muted/40"
                  aria-hidden="true"
                />
              ))}
            </div>
          ) : rules.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center">
              <Workflow className="h-8 w-8 text-muted-foreground/60" aria-hidden="true" />
              <p className="text-sm text-muted-foreground">还没有规则，点击「新建规则」开始配置</p>
            </div>
          ) : (
            <ul className="space-y-3">
              {rules.map((rule) => (
                <li
                  key={rule.id}
                  className="rounded-lg border bg-card p-4 transition-colors hover:border-border/80"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-medium leading-tight">{rule.name}</h3>
                        <Badge
                          variant={rule.enabled ? 'default' : 'secondary'}
                          className="text-xs"
                        >
                          {rule.enabled ? '启用中' : '已停用'}
                        </Badge>
                      </div>
                      <p className="mt-1.5 text-sm text-muted-foreground">
                        {describeRule(rule)}
                      </p>
                      {rule.description && (
                        <p className="mt-1 text-xs text-muted-foreground/80">{rule.description}</p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Switch
                        checked={rule.enabled}
                        onCheckedChange={(v) => void handleToggle(rule, v)}
                        aria-label={`${rule.enabled ? '停用' : '启用'}规则 ${rule.name}`}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => openEdit(rule)}
                        aria-label={`编辑规则 ${rule.name}`}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        onClick={() => void handleDelete(rule)}
                        aria-label={`删除规则 ${rule.name}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <CrmRuleEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        rule={editing}
        onSubmit={handleSave}
      />
    </div>
  )
}
