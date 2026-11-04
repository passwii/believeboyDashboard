'use client'

import { useCallback, useEffect, useState } from 'react'
import * as SwitchPrimitive from '@radix-ui/react-switch'
import { Pencil, Plus, RefreshCcw, Workflow, Trash2 } from 'lucide-react'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import { useNotifications } from '@/components/notifications'
import { useConfirm } from '@/hooks/use-confirm'
import {
  WarmButton,
  WarmIconButton,
} from '@/components/dashboard-v2/warm-ledger/controls'
import {
  WarmCrmSection,
  WarmCrmState,
  WarmCrmStatusPill,
} from '@/components/dashboard-v2/warm-ledger/crm'
import { CrmRuleEditor } from './crm-rule-editor'
import { describeRule } from './crm-rule-editor/rule-editor-utils'
import type { Rule, RuleInput } from '@/lib/crm/types'

import styles from './crm-rules-panel.module.css'

/**
 * 规则引擎设置面板（P9-7，BLF-545，admin 设置页）。
 *
 * 可见性与写行为保持原状：列表 403 展示无权限，创建、启停、编辑、删除继续调用既有 client。
 */
export function CrmRulesPanel({
  onRefreshReady,
}: {
  onRefreshReady?: (refresh: () => Promise<void>) => void
}) {
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
      setRules(await client.listRules())
    } catch {
      setForbidden(true)
    } finally {
      setLoading(false)
    }
  }, [client])

  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    onRefreshReady?.(load)
  }, [load, onRefreshReady])

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
        setRules((current) =>
          current.map((rule) => (rule.id === updated.id ? updated : rule))
        )
        notify({ type: 'success', title: '规则已更新' })
      } else {
        const created = await client.createRule(input)
        setRules((current) => [created, ...current])
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
      setRules((current) =>
        current.map((item) => (item.id === updated.id ? updated : item))
      )
      notify({ type: 'success', title: enabled ? '规则已启用' : '规则已停用' })
    } catch {
      notify({ type: 'error', title: '操作失败', message: '请稍后重试' })
    }
  }

  async function handleDelete(rule: Rule) {
    const confirmed = await confirm({
      title: '删除规则',
      description: `确定删除「${rule.name}」？删除后每日扫描将不再执行该规则。`,
      confirmText: '删除',
      variant: 'destructive',
    })
    if (!confirmed) return
    try {
      await client.deleteRule(rule.id)
      setRules((current) => current.filter((item) => item.id !== rule.id))
      notify({ type: 'success', title: '规则已删除' })
    } catch {
      notify({ type: 'error', title: '删除失败', message: '请稍后重试' })
    }
  }

  return (
    <WarmCrmSection
      title="规则引擎"
      actions={
        <>
          <WarmButton
            variant="quiet"
            onClick={() => void load()}
            disabled={loading}
            aria-label="刷新规则列表"
          >
            <RefreshCcw aria-hidden="true" />
            刷新
          </WarmButton>
          <WarmButton onClick={openCreate} disabled={forbidden}>
            <Plus aria-hidden="true" />
            新建规则
          </WarmButton>
        </>
      }
    >
      <p className={styles.description}>
        可视化配置「当 X 发生，做 Y」自动化规则（每日 09:05 自动扫描执行）
      </p>

      {forbidden ? (
        <WarmCrmState kind="empty" title="无权限管理规则引擎（仅管理员）" />
      ) : loading ? (
        <WarmCrmState kind="loading" title="加载中" />
      ) : rules.length === 0 ? (
        <WarmCrmState kind="empty" title="还没有规则，点击「新建规则」开始配置" />
      ) : (
        <ul className={styles.ruleList}>
          {rules.map((rule) => (
            <li key={rule.id} className={styles.ruleItem}>
              <div className={styles.ruleCopy}>
                <div className={styles.ruleHeading}>
                  <h3>{rule.name}</h3>
                  <WarmCrmStatusPill tone={rule.enabled ? 'positive' : 'neutral'}>
                    {rule.enabled ? '启用中' : '已停用'}
                  </WarmCrmStatusPill>
                </div>
                <p className={styles.ruleSummary}>{describeRule(rule)}</p>
                {rule.description ? (
                  <p className={styles.ruleDescription}>{rule.description}</p>
                ) : null}
              </div>
              <div className={styles.ruleActions}>
                <SwitchPrimitive.Root
                  checked={rule.enabled}
                  onCheckedChange={(enabled) => void handleToggle(rule, enabled)}
                  aria-label={`${rule.enabled ? '停用' : '启用'}规则 ${rule.name}`}
                  className={styles.switch}
                >
                  <SwitchPrimitive.Thumb className={styles.switchThumb} />
                </SwitchPrimitive.Root>
                <WarmIconButton
                  aria-label={`编辑规则 ${rule.name}`}
                  onClick={() => openEdit(rule)}
                >
                  <Pencil aria-hidden="true" />
                </WarmIconButton>
                <WarmIconButton
                  aria-label={`删除规则 ${rule.name}`}
                  className={styles.dangerAction}
                  onClick={() => void handleDelete(rule)}
                >
                  <Trash2 aria-hidden="true" />
                </WarmIconButton>
              </div>
            </li>
          ))}
        </ul>
      )}

      <CrmRuleEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        rule={editing}
        onSubmit={handleSave}
      />
    </WarmCrmSection>
  )
}
