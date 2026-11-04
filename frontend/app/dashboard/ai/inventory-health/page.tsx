'use client'

/**
 * 库存健康 AI 分析 — 单项目单站点快照口径
 * 路径: /dashboard/ai/inventory-health
 *
 * 口径与广告不同：库存是**单日快照**（`report_date` 可缺省 = 最新快照），
 * 没有日期区间，也没有广告那样的历史列表（canonical 侧暂无 list 端点）。
 *
 * 页面只做容器：口径表单 + 共享 `InsightStreamPanel`。run 的提交、订阅、
 * 重连、恢复、取消、重试全在 `useInventoryInsight` → `useInsightDomainRun`
 * → `useInsightStream`，本页不创建 EventSource、不解析 SSE。
 */

import { useCallback, useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { Bot, Calendar, Database, RotateCcw, Sparkles } from 'lucide-react'

import {
  WarmButton,
  WarmSelect,
} from '@/components/dashboard-v2/warm-ledger/controls'
import { InsightStreamPanel } from '@/components/insight'
import { SingleDatePicker, COUNTRY_TIMEZONE_MAP } from '@/components/ui/date-picker'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import { useNotifications } from '@/components/notifications'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import {
  INVENTORY_LATEST_SNAPSHOT_HINT,
  inventoryScopeLabel,
  useInventoryInsight,
  type InventoryRunScope,
} from '@/components/dashboard/ai-inventory-health'
import styles from './inventory-health-warm.module.css'

const COUNTRY_OPTIONS = [
  { value: 'US', label: '美国站 (US)' },
  { value: 'DE', label: '德国站 (DE)' },
  { value: 'UK', label: '英国站 (UK)' },
]

type Project = {
  id: number
  name: string
  brand_name?: string | null
}

export default function InventoryHealthPage() {
  const { data: session } = useSession()
  const { notify } = useNotifications()

  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState<number | null>(null)
  const [country, setCountry] = useState('US')
  const [reportDate, setReportDate] = useState<Date | null>(null)
  /** 已提交的口径快照：非 null 即表示开了一次分析，之后改动表单不影响在跑的 run */
  const [submitted, setSubmitted] = useState<InventoryRunScope | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchManagedProjectsCached<Project[]>(session, false)
      .then((items) => {
        if (cancelled) return
        const list = Array.isArray(items) ? items : []
        setProjects(list)
        if (list.length > 0) setProjectId(list[0].id)
      })
      .catch((err) => {
        notify({ type: 'error', title: '项目列表加载失败', message: String(err) })
      })
    return () => {
      cancelled = true
    }
  }, [session, notify])

  const draftScope: InventoryRunScope = { projectId, country, reportDate }
  const activeScope = submitted ?? draftScope
  const { panel } = useInventoryInsight({ open: submitted !== null, scope: activeScope })

  const handleGenerate = useCallback(() => {
    if (!projectId) return
    setSubmitted({ projectId, country, reportDate })
  }, [projectId, country, reportDate])

  const refreshProjects = useCallback(async () => {
    const list = await fetchManagedProjectsCached<Project[]>(session, false, { force: true })
    const nextProjects = Array.isArray(list) ? list : []
    setProjects(nextProjects)
    if (!nextProjects.some((project) => project.id === projectId)) {
      setProjectId(nextProjects[0]?.id ?? null)
    }
  }, [projectId, session])
  useHeaderRefresh(refreshProjects)

  const activeLabel = inventoryScopeLabel(activeScope)
  const started = submitted !== null

  return (
    <div className={styles.page} data-warm-inventory-health>
      <section className={styles.panel}>
        <div className={styles.panelBody}>
          <div className={styles.filters}>
            <WarmSelect
              id="inventory-project"
              label="项目"
              value={projectId ? String(projectId) : ''}
              options={projects.map((project) => ({
                value: String(project.id),
                label: project.brand_name
                  ? `${project.name} · ${project.brand_name}`
                  : project.name,
              }))}
              onChange={(value) => setProjectId(Number(value))}
              placeholder={projects.length === 0 ? '暂无可用项目' : '选择项目'}
              disabled={projects.length === 0}
            />

            <WarmSelect
              id="inventory-country"
              label="国家"
              value={country}
              options={COUNTRY_OPTIONS}
              onChange={setCountry}
            />

            <div className={styles.field}>
              <span className={styles.fieldLabel}>
                <Calendar aria-hidden />
                口径日期
                <span className={styles.fieldHint}>{INVENTORY_LATEST_SNAPSHOT_HINT}</span>
              </span>
              <SingleDatePicker
                value={reportDate ?? undefined}
                onChange={(date) => setReportDate(date ?? null)}
                clearable
                placeholder="最新库存快照"
                timezone={COUNTRY_TIMEZONE_MAP[country]}
                className={styles.dateTrigger}
                popoverClassName={styles.datePopover}
              />
            </div>

            <div className={styles.generateAction}>
              <WarmButton
                type="button"
                variant={started ? 'secondary' : 'primary'}
                onClick={handleGenerate}
                disabled={!projectId}
              >
                {started ? <RotateCcw aria-hidden /> : <Sparkles aria-hidden />}
                {started ? '重新分析' : '立即生成'}
              </WarmButton>
            </div>
          </div>
        </div>
      </section>

      {started ? (
        <section className={styles.panel}>
          <div className={styles.outputPanel}>
            <InsightStreamPanel
              appearance="warm"
              status={panel.state.status}
              statusLabel={panel.state.label}
              progress={panel.state.progress}
              error={panel.error}
              backgroundMessage={panel.backgroundMessage}
              content={panel.content}
              contentState={panel.contentState}
              isStreaming={panel.state.isStreaming}
              digest={panel.digest}
              onRetry={panel.onRetry}
              onCancel={panel.onCancel}
              exportFileName={`库存健康-${activeLabel.replace(/[\\/:*?"<>|]/g, '-')}.md`}
              className={styles.streamFlush}
              contentClassName={styles.streamScroller}
              slots={{
                header: (
                  <div className={styles.outputHeaderContent}>
                    <h2 className={styles.outputTitle}>{panel.title ?? '库存健康分析'}</h2>
                    <p className={styles.outputMeta}>{activeLabel}</p>
                  </div>
                ),
                meta: (
                  <p className={styles.note}>
                    正文「数据局限」段落给出快照新鲜度与缺失维度；表单未指定口径日期时按最新快照分析。
                  </p>
                ),
              }}
              emptyState={
                panel.state.status === 'failed' ? (
                  <div className={styles.emptyState} data-tone="negative">
                    <Bot aria-hidden />
                    <span>本轮库存健康分析未产出内容</span>
                  </div>
                ) : (
                  <div className={styles.emptyState}>
                    <Bot className="animate-pulse" aria-hidden />
                    <span>{panel.state.label}，内容会实时出现在这里</span>
                  </div>
                )
              }
            />
          </div>
        </section>
      ) : (
        <section className={styles.panel}>
          <div className={styles.emptyState}>
            <Database aria-hidden />
            <p className={styles.note}>
              选择项目与站点后点击「立即生成」，分析结果会实时出现在这里
            </p>
          </div>
        </section>
      )}
    </div>
  )
}
