'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useSession } from 'next-auth/react'
import { Copy, ExternalLink, Pencil, Phone, UserPlus } from 'lucide-react'

import { useConfirm } from '@/hooks/use-confirm'
import {
  WarmCrmRecordDrawer,
  WarmCrmState,
  WarmCrmStatusPill,
} from '@/components/dashboard-v2/warm-ledger/crm'
import { WarmButton, WarmSegmentedControl } from '@/components/dashboard-v2/warm-ledger/controls'
import { useNotifications } from '@/components/notifications'
import {
  INTENT_NOTE_DEBOUNCE_MS,
  INTENT_PHONE_SOURCE_LABELS,
  INTENT_STATE_LABELS,
  INTENT_STATE_ORDER,
  type IntentCompanyDetail,
  type IntentFollowup,
  type IntentFollowupInput,
  type IntentPhone,
  type IntentProfileInput,
  type IntentScope,
  type IntentState,
} from '@/lib/crm/intent/types'
import {
  dueInfo,
  formatCapitalWan,
  formatDate,
  formatDateTime,
  fromDateTimeLocalValue,
  intentSummaryText,
  isHttpUrl,
  splitProducts,
  toDateTimeLocalValue,
} from '@/lib/crm/intent/format'
import {
  apiErrorMessage,
  intentConflictFollowup,
  isIntentVersionConflict,
} from '@/lib/crm/intent/http-client'
import { useIntentClient } from '@/lib/crm/intent/provider'
import { cn } from '@/lib/utils'

import { IntentDetailSection, IntentField, IntentLevelBadge, IntentStatePill } from './intent-display'
import { IntentProfileForm } from './intent-profile-form'
import { SharedPhonesDialog } from './shared-phones-dialog'

import styles from '../intent-warm.module.css'

type SaveIndicator =
  | { kind: 'idle' }
  | { kind: 'editing' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: number }
  | { kind: 'conflict' }
  | { kind: 'error' }

function saveIndicatorText(indicator: SaveIndicator): string {
  switch (indicator.kind) {
    case 'editing':
      return '编辑中…'
    case 'saving':
      return '保存中…'
    case 'saved':
      return `已保存 ${new Date(indicator.at).toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })}`
    case 'conflict':
      return '记录已被其他人更新，已刷新'
    case 'error':
      return '保存失败，已回滚'
    default:
      return ''
  }
}

function mergeFollowupPatch(
  current: IntentFollowupInput | null,
  next: IntentFollowupInput
): IntentFollowupInput {
  return { ...(current ?? {}), ...next }
}

function applyPatchToFollowup(followup: IntentFollowup, patch: IntentFollowupInput): IntentFollowup {
  return {
    ...followup,
    ...(patch.state !== undefined
      ? { state: patch.state, stateLabel: INTENT_STATE_LABELS[patch.state] }
      : {}),
    ...(patch.note !== undefined ? { note: patch.note } : {}),
    ...(patch.lastContactAt !== undefined ? { lastContactAt: patch.lastContactAt } : {}),
    ...(patch.nextContactAt !== undefined ? { nextContactAt: patch.nextContactAt } : {}),
  }
}

type IntentRecordDrawerProps = {
  open: boolean
  companyId: number | null
  /** 当前 URL scope：详情请求透传到 /companies/{id}?scope=（sea 待领取记录可读，P0-1）。 */
  scope: IntentScope
  onClose: () => void
  onFollowupChanged: (companyId: number, followup: IntentFollowup) => void
  onRefreshRequested: () => void
  onStatsChanged: () => void
  onSelectCompany: (companyId: number) => void
  onSelectPoolPhone: (phoneNormalized: string) => void
}

/**
 * 企业详情抽屉：关键信息 / 手机号 / 意向判断 / 主营产品 / 平台适配 / 来源 / 疑点 / 跟进。
 *
 * 写路径：乐观更新 + 队列串行（避免 version 竞争），409 冲突覆盖服务端 current 并刷新；
 * 备注 900ms debounce + 关闭 / visibilitychange / beforeunload flush。
 */
export function IntentRecordDrawer({
  open,
  companyId,
  scope,
  onClose,
  onFollowupChanged,
  onRefreshRequested,
  onStatsChanged,
  onSelectCompany,
  onSelectPoolPhone,
}: IntentRecordDrawerProps) {
  const client = useIntentClient()
  const { notify } = useNotifications()
  const { confirm } = useConfirm()
  const { data: session } = useSession()

  const [detail, setDetail] = useState<IntentCompanyDetail | null>(null)
  const detailRef = useRef<IntentCompanyDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [retrySeq, setRetrySeq] = useState(0)
  const [saveIndicator, setSaveIndicator] = useState<SaveIndicator>({ kind: 'idle' })
  const [noteValue, setNoteValue] = useState('')
  const noteRef = useRef('')
  const lastSavedNoteRef = useRef('')
  const noteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingPatchRef = useRef<IntentFollowupInput | null>(null)
  const inFlightRef = useRef(false)
  const [addingPhone, setAddingPhone] = useState(false)
  const [phoneInput, setPhoneInput] = useState('')
  const [pendingPhoneId, setPendingPhoneId] = useState<number | null>(null)
  const [claiming, setClaiming] = useState(false)
  const [converting, setConverting] = useState(false)
  const [sharedOpen, setSharedOpen] = useState(false)
  const [profileEditing, setProfileEditing] = useState(false)
  const [savingProfile, setSavingProfile] = useState(false)

  const currentUserId = (session?.user as { id?: string } | undefined)?.id ?? null
  const isAdmin = (session?.user as { roleType?: string } | undefined)?.roleType === 'admin'

  const updateDetail = useCallback(
    (updater: (current: IntentCompanyDetail) => IntentCompanyDetail) => {
      setDetail((current) => {
        if (!current) return current
        const next = updater(current)
        detailRef.current = next
        return next
      })
    },
    []
  )

  const loadDetail = useCallback(
    async (signal?: AbortSignal) => {
      if (companyId === null) return
      setLoading(true)
      setError(null)
      try {
        const next = await client.getCompany(companyId, { signal, scope })
        setDetail(next)
        detailRef.current = next
        const note = next.followup.note
        noteRef.current = note
        lastSavedNoteRef.current = note
        setNoteValue(note)
        setSaveIndicator({ kind: 'idle' })
      } catch (reason) {
        if ((reason as Error | null)?.name === 'AbortError') return
        setError(apiErrorMessage(reason, '加载企业详情失败'))
      } finally {
        setLoading(false)
      }
    },
    [client, companyId, scope]
  )

  useEffect(() => {
    if (!open || companyId === null) return
    const controller = new AbortController()
    setDetail(null)
    detailRef.current = null
    setProfileEditing(false)
    void loadDetail(controller.signal)
    return () => controller.abort()
  }, [open, companyId, retrySeq, loadDetail])

  const reload = useCallback(() => {
    setRetrySeq((value) => value + 1)
  }, [])

  const performSave = useCallback(
    async (patch: IntentFollowupInput, options?: { quiet?: boolean }) => {
      const current = detailRef.current
      if (!current) return
      updateDetail((value) => ({
        ...value,
        followup: applyPatchToFollowup(value.followup, patch),
      }))
      setSaveIndicator({ kind: 'saving' })
      try {
        const updated = await client.updateFollowup(
          current.id,
          patch,
          current.followup.version
        )
        updateDetail((value) => ({ ...value, followup: updated }))
        onFollowupChanged(current.id, updated)
        setSaveIndicator({ kind: 'saved', at: Date.now() })
        if (!options?.quiet) {
          notify({
            type: 'success',
            title: '跟进已更新',
            message: `${current.name} · ${updated.stateLabel}`,
          })
          onStatsChanged()
        }
      } catch (reason) {
        if (isIntentVersionConflict(reason)) {
          const serverFollowup = intentConflictFollowup(reason)
          if (serverFollowup) {
            updateDetail((value) => ({ ...value, followup: serverFollowup }))
            onFollowupChanged(current.id, serverFollowup)
            noteRef.current = serverFollowup.note
            lastSavedNoteRef.current = serverFollowup.note
            setNoteValue(serverFollowup.note)
          }
          setSaveIndicator({ kind: 'conflict' })
          notify({
            type: 'warning',
            title: '记录已被其他人更新',
            message: '已刷新为最新记录，请确认后再修改',
          })
          onRefreshRequested()
        } else {
          setSaveIndicator({ kind: 'error' })
          notify({
            type: 'error',
            title: '保存失败',
            message: apiErrorMessage(reason, '跟进保存失败'),
          })
          reload()
        }
      }
    },
    [
      client,
      notify,
      onFollowupChanged,
      onRefreshRequested,
      onStatsChanged,
      reload,
      updateDetail,
    ]
  )

  const saveFollowup = useCallback(
    async (patch: IntentFollowupInput, options?: { quiet?: boolean }) => {
      pendingPatchRef.current = mergeFollowupPatch(pendingPatchRef.current, patch)
      if (inFlightRef.current) return
      inFlightRef.current = true
      try {
        while (pendingPatchRef.current) {
          const batch = pendingPatchRef.current
          pendingPatchRef.current = null
          await performSave(batch, options)
        }
      } finally {
        inFlightRef.current = false
      }
    },
    [performSave]
  )

  const flushNote = useCallback(
    (options?: { keepalive?: boolean }) => {
      if (noteTimerRef.current) {
        clearTimeout(noteTimerRef.current)
        noteTimerRef.current = null
      }
      const current = detailRef.current
      if (!current) return
      if (noteRef.current === lastSavedNoteRef.current) return
      const note = noteRef.current
      lastSavedNoteRef.current = note
      const patch: IntentFollowupInput = {
        note,
        lastContactAt: new Date().toISOString(),
      }
      if (options?.keepalive) {
        void client
          .updateFollowup(current.id, patch, current.followup.version, { keepalive: true })
          .then((updated) => {
            onFollowupChanged(current.id, updated)
          })
          .catch(() => {
            // 关页路径 best-effort：失败不再打扰用户
          })
        return
      }
      void saveFollowup(patch, { quiet: true })
    },
    [client, onFollowupChanged, saveFollowup]
  )

  const handleClose = useCallback(() => {
    flushNote()
    setSharedOpen(false)
    setProfileEditing(false)
    onClose()
  }, [flushNote, onClose])

  useEffect(() => {
    if (!open) return
    const handleBeforeUnload = () => flushNote({ keepalive: true })
    const handleVisibility = () => {
      if (document.hidden) flushNote({ keepalive: true })
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [open, flushNote])

  const handleNoteChange = (value: string) => {
    setNoteValue(value)
    noteRef.current = value
    setSaveIndicator({ kind: 'editing' })
    if (noteTimerRef.current) clearTimeout(noteTimerRef.current)
    noteTimerRef.current = setTimeout(() => {
      noteTimerRef.current = null
      flushNote()
    }, INTENT_NOTE_DEBOUNCE_MS)
  }

  const canWrite = Boolean(
    detail && (!detail.owner || isAdmin || (currentUserId !== null && detail.owner.id === currentUserId))
  )
  const converted = Boolean(detail && detail.convertedCustomerId !== null)
  const readOnly = !canWrite || converted

  const handleStateChange = (nextState: IntentState) => {
    if (!detail || readOnly) return
    const lastContactAt = new Date().toISOString()
    void saveFollowup({ state: nextState, lastContactAt })
  }

  const handleNextContactChange = (value: string) => {
    if (!detail || readOnly) return
    void saveFollowup({ nextContactAt: fromDateTimeLocalValue(value) })
  }

  const handleClearNextContact = () => {
    if (!detail || readOnly) return
    void saveFollowup({ nextContactAt: null })
  }

  const handleTogglePhoneValid = async (phone: IntentPhone) => {
    if (!detail || readOnly || pendingPhoneId !== null) return
    const nextValid = !phone.isValid
    const previous = detail.phones
    updateDetail((value) => ({
      ...value,
      phones: value.phones.map((item) =>
        item.id === phone.id ? { ...item, isValid: nextValid } : item
      ),
    }))
    setPendingPhoneId(phone.id)
    try {
      // BE 返回更新后的整条 Company（含 phones 与 shared_phones）→ 直接替换详情。
      const updated = await client.setPhoneValid(detail.id, phone.id, nextValid)
      updateDetail(() => updated)
    } catch (reason) {
      updateDetail((value) => ({ ...value, phones: previous }))
      notify({
        type: 'error',
        title: '号码标记失败',
        message: apiErrorMessage(reason, '有效号码保存失败'),
      })
    } finally {
      setPendingPhoneId(null)
    }
  }

  const handleAddPhone = async () => {
    if (!detail || readOnly) return
    const raw = phoneInput.trim()
    if (!/^[\d+\-\s()]{5,24}$/.test(raw)) {
      notify({ type: 'warning', title: '号码格式不正确', message: '只接受数字、+、-、空格与括号，5–24 位' })
      return
    }
    setAddingPhone(true)
    try {
      const updated = await client.addPhone(detail.id, raw)
      updateDetail(() => updated)
      setPhoneInput('')
      notify({ type: 'success', title: '号码已补录', message: raw })
    } catch (reason) {
      notify({
        type: 'error',
        title: '补录失败',
        message: apiErrorMessage(reason, '号码补录失败'),
      })
    } finally {
      setAddingPhone(false)
    }
  }

  const handleClaim = async () => {
    if (!detail || claiming) return
    setClaiming(true)
    try {
      // BE 返回更新后的整条 Company（owner/human_touched 已落库）。
      const updated = await client.claimCompany(detail.id)
      updateDetail(() => updated)
      notify({ type: 'success', title: '已领取', message: detail.name })
      onRefreshRequested()
    } catch (reason) {
      notify({
        type: 'error',
        title: '领取失败',
        message: apiErrorMessage(reason, '领取失败'),
      })
    } finally {
      setClaiming(false)
    }
  }

  const handleProfileSubmit = async (input: IntentProfileInput) => {
    if (!detail || savingProfile) return
    setSavingProfile(true)
    try {
      // BE 返回更新后的整条 Company（含 followup/phones/shared_phones）。
      const updated = await client.updateProfile(detail.id, input)
      updateDetail(() => updated)
      setProfileEditing(false)
      notify({ type: 'success', title: '资料已保存', message: detail.name })
      onRefreshRequested()
    } catch (reason) {
      notify({
        type: 'error',
        title: '资料保存失败',
        message: apiErrorMessage(reason, '资料保存失败'),
      })
    } finally {
      setSavingProfile(false)
    }
  }

  const handleConvert = async () => {
    if (!detail || converting) return
    const ok = await confirm({
      title: '转为客户',
      description: `将「${detail.name}」写入客户表（来源=客户雷达），并建立主要联系人。此操作不可重复。`,
      confirmText: '转为客户',
    })
    if (!ok) return
    setConverting(true)
    try {
      const result = await client.convertCompany(detail.id)
      if (result.company) {
        updateDetail(() => result.company as IntentCompanyDetail)
      } else {
        updateDetail((value) => ({
          ...value,
          convertedCustomerId: result.customerId,
          convertedAt: new Date().toISOString(),
        }))
      }
      notify({
        type: 'success',
        title: '已转为客户',
        message: `${detail.name} · 客户 #${result.customerId}`,
      })
      onStatsChanged()
      onRefreshRequested()
    } catch (reason) {
      notify({
        type: 'error',
        title: '转为客户失败',
        message: apiErrorMessage(reason, '转为客户失败'),
      })
    } finally {
      setConverting(false)
    }
  }

  const handleCopySummary = async () => {
    if (!detail) return
    try {
      await navigator.clipboard.writeText(intentSummaryText(detail))
      notify({ type: 'success', title: '摘要已复制' })
    } catch {
      notify({ type: 'error', title: '复制失败', message: '浏览器未授予剪贴板权限' })
    }
  }

  const title = detail ? detail.name : loading ? '加载中…' : '企业详情'
  const headerActions = detail ? (
    <>
      <IntentStatePill label={detail.followup.stateLabel} state={detail.followup.state} />
      {detail.owner ? (
        <span className={styles.ownerChip}>负责人 {detail.owner.name || detail.owner.id}</span>
      ) : canWrite ? (
        <WarmButton loading={claiming} onClick={() => void handleClaim()}>
          <UserPlus aria-hidden="true" /> 领取
        </WarmButton>
      ) : null}
      {canWrite && !profileEditing ? (
        <WarmButton onClick={() => setProfileEditing(true)}>
          <Pencil aria-hidden="true" /> 编辑资料
        </WarmButton>
      ) : null}
    </>
  ) : null

  const footer = detail ? (
    <div className={styles.drawerFooterRow}>
      <span className={styles.saveIndicator} role="status">
        {saveIndicatorText(saveIndicator)}
      </span>
      <div className={styles.drawerFooterActions}>
        <WarmButton onClick={() => void handleCopySummary()}>
          <Copy aria-hidden="true" /> 复制摘要
        </WarmButton>
        {converted ? (
          <WarmCrmStatusPill tone="positive">已转客户</WarmCrmStatusPill>
        ) : canWrite ? (
          <WarmButton
            loading={converting}
            variant="primary"
            onClick={() => void handleConvert()}
          >
            转为客户
          </WarmButton>
        ) : null}
        <WarmButton onClick={handleClose}>关闭</WarmButton>
      </div>
    </div>
  ) : null

  return (
    <>
      <WarmCrmRecordDrawer
        actions={headerActions}
        footer={footer}
        open={open}
        title={title}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) handleClose()
        }}
      >
        {loading && !detail ? (
          <WarmCrmState kind="loading" title="正在加载企业详情…" />
        ) : error && !detail ? (
          <WarmCrmState
            action={<WarmButton onClick={reload}>重试</WarmButton>}
            detail={error}
            kind="error"
            title="企业详情加载失败"
          />
        ) : detail ? (
          profileEditing ? (
            <IntentProfileForm
              detail={detail}
              submitting={savingProfile}
              onCancel={() => setProfileEditing(false)}
              onSubmit={handleProfileSubmit}
            />
          ) : (
            <DetailBody
              canWrite={canWrite}
              converted={converted}
              detail={detail}
              noteValue={noteValue}
              onAddPhone={() => void handleAddPhone()}
              onClearNextContact={handleClearNextContact}
              onNoteChange={handleNoteChange}
              onNextContactChange={handleNextContactChange}
              onOpenShared={() => setSharedOpen(true)}
              onStateChange={handleStateChange}
              onTogglePhoneValid={(phone) => void handleTogglePhoneValid(phone)}
              onPhoneInputChange={setPhoneInput}
              phoneInput={phoneInput}
              addingPhone={addingPhone}
              pendingPhoneId={pendingPhoneId}
              readOnly={readOnly}
              saveText={saveIndicatorText(saveIndicator)}
            />
          )
        ) : null}
      </WarmCrmRecordDrawer>

      {detail ? (
        <SharedPhonesDialog
          groups={detail.sharedPhones}
          open={sharedOpen}
          onOpenChange={setSharedOpen}
          onSelectCompany={(id) => {
            setSharedOpen(false)
            onSelectCompany(id)
          }}
          onSelectPoolPhone={(phone) => {
            setSharedOpen(false)
            onSelectPoolPhone(phone)
          }}
        />
      ) : null}
    </>
  )
}

type DetailBodyProps = {
  detail: IntentCompanyDetail
  readOnly: boolean
  canWrite: boolean
  converted: boolean
  noteValue: string
  phoneInput: string
  addingPhone: boolean
  pendingPhoneId: number | null
  saveText: string
  onNoteChange: (value: string) => void
  onStateChange: (state: IntentState) => void
  onNextContactChange: (value: string) => void
  onClearNextContact: () => void
  onTogglePhoneValid: (phone: IntentPhone) => void
  onAddPhone: () => void
  onPhoneInputChange: (value: string) => void
  onOpenShared: () => void
}

function DetailBody({
  detail,
  readOnly,
  canWrite,
  converted,
  noteValue,
  phoneInput,
  addingPhone,
  pendingPhoneId,
  saveText,
  onNoteChange,
  onStateChange,
  onNextContactChange,
  onClearNextContact,
  onTogglePhoneValid,
  onAddPhone,
  onPhoneInputChange,
  onOpenShared,
}: DetailBodyProps) {
  const products = splitProducts(detail.products)
  const due = dueInfo(detail.followup.nextContactAt)
  const sources = detail.sources.filter(isHttpUrl)
  const hasShared = detail.sharedPhones.length > 0
  const sharedCount = detail.sharedPhones.reduce(
    (count, group) => count + group.companies.length + group.pool.length,
    0
  )

  return (
    <>
      <p className={styles.drawerSubline}>
        {[detail.province, detail.city].filter(Boolean).join(' · ') || '地区待补'} · 筛于{' '}
        {formatDate(detail.screenedAt)} · 批次 {detail.batchDate ?? '待补'}
      </p>

      <IntentDetailSection title="关键信息">
        <div className={styles.fieldGrid}>
          <IntentField label="统一社会信用代码" mono>
            {detail.creditCode ?? '待补'}
          </IntentField>
          <IntentField label="法人">{detail.legalPerson ?? '待补'}</IntentField>
          <IntentField label="省份 / 城市">
            {[detail.province, detail.city].filter(Boolean).join(' / ') || '待补'}
          </IntentField>
          <IntentField label="成立年份" mono>
            {detail.foundedYear ?? '待补'}
          </IntentField>
          <IntentField label="注册资本" mono>
            {formatCapitalWan(detail.registeredCapitalWan) ?? '待补'}
          </IntentField>
          <IntentField label="产品类目">{detail.category ?? '待补'}</IntentField>
          <IntentField label="渠道">
            {detail.channels.length > 0 ? detail.channels.join(' / ') : '未标注'}
          </IntentField>
          <IntentField label="筛选日期" mono>
            {formatDate(detail.screenedAt)}
          </IntentField>
          <IntentField label="数据批次" mono>
            {detail.batchDate ?? '待补'}
          </IntentField>
          <IntentField label="商标">
            {detail.trademarks.length > 0
              ? detail.trademarks.join('、')
              : detail.trademarkCount > 0
                ? `${detail.trademarkCount} 件（明细待补）`
                : '待补'}
          </IntentField>
        </div>
        {detail.humanTouched ? (
          <p className={styles.drawerHint}>人工已编辑：AI 不再覆盖此记录。</p>
        ) : null}
      </IntentDetailSection>

      <IntentDetailSection title="手机号">
        {detail.phones.length > 0 ? (
          <ul className={styles.phoneList}>
            {detail.phones.map((phone) => {
              const shared = detail.sharedPhones.find(
                (group) => group.phoneNormalized === phone.normalized
              )
              const sharedCompanyCount = shared ? shared.companies.length + shared.pool.length : 0
              return (
                <li className={styles.phoneRow} key={phone.id}>
                  <a className={styles.phoneValue} href={`tel:${phone.normalized || phone.raw}`}>
                    <Phone aria-hidden="true" />
                    {phone.normalized || phone.raw}
                  </a>
                  <span className={styles.phoneSource}>
                    {INTENT_PHONE_SOURCE_LABELS[phone.source]}
                  </span>
                  {phone.isValid ? <span className={styles.phoneValid}>✓ 有效</span> : null}
                  {sharedCompanyCount > 0 ? (
                    <button
                      className={styles.phoneShared}
                      type="button"
                      onClick={onOpenShared}
                    >
                      共用 {sharedCompanyCount} 家
                    </button>
                  ) : null}
                  <WarmSegmentedControl
                    ariaLabel={`${phone.normalized} 是否有效`}
                    className={styles.phoneValidControl}
                    disabled={readOnly || pendingPhoneId === phone.id}
                    options={[
                      { value: 'invalid', label: '无效' },
                      { value: 'valid', label: '有效' },
                    ]}
                    value={phone.isValid ? 'valid' : 'invalid'}
                    onChange={(value) => {
                      if ((value === 'valid') !== phone.isValid) onTogglePhoneValid(phone)
                    }}
                  />
                </li>
              )
            })}
          </ul>
        ) : (
          <p className={styles.drawerHint}>还没有手机号，可在下方补录。</p>
        )}
        {hasShared ? (
          <WarmButton className={styles.sharedTrigger} onClick={onOpenShared}>
            查看号码共用记录（{sharedCount}）
          </WarmButton>
        ) : null}
        {!readOnly ? (
          <div className={styles.phoneAddRow}>
            <input
              aria-label="补录手机号"
              className={cn(styles.input, styles.phoneAddInput)}
              placeholder="企业名录里已有的号码"
              value={phoneInput}
              onChange={(event) => onPhoneInputChange(event.target.value)}
            />
            <WarmButton loading={addingPhone} onClick={onAddPhone}>
              保存号码
            </WarmButton>
          </div>
        ) : null}
        <p className={styles.drawerHint}>
          只填企业名录里已有的号码；公网抓取的个人手机号不要录入。
        </p>
      </IntentDetailSection>

      <IntentDetailSection title="意向判断">
        <div className={styles.intentRow}>
          <IntentLevelBadge level={detail.intentLevel} />
          <span className={styles.intentScore}>
            {detail.intentScore !== null ? `意向分 ${detail.intentScore}` : '意向分待补'}
          </span>
        </div>
        <p className={styles.drawerText}>{detail.intentBasis ?? '意向依据待补'}</p>
      </IntentDetailSection>

      <IntentDetailSection title="主营产品">
        {products.length > 0 ? (
          <div className={styles.chipRow}>
            {products.map((product) => (
              <span className={styles.chip} key={product}>
                {product}
              </span>
            ))}
          </div>
        ) : (
          <p className={styles.drawerHint}>主营产品待补</p>
        )}
      </IntentDetailSection>

      <IntentDetailSection title="平台适配">
        <div className={styles.fieldGrid}>
          <IntentField label="Amazon">{detail.amazonFit ?? '待核实'}</IntentField>
          <IntentField label="Walmart">{detail.walmartFit ?? '待核实'}</IntentField>
        </div>
      </IntentDetailSection>

      <IntentDetailSection title="来源">
        {sources.length > 0 ? (
          <ul className={styles.sourceList}>
            {sources.map((source) => (
              <li key={source}>
                <a
                  className={styles.sourceLink}
                  href={source}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {source}
                  <ExternalLink aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.drawerHint}>暂无来源</p>
        )}
      </IntentDetailSection>

      <IntentDetailSection title="疑点" tone={detail.risks ? 'negative' : undefined}>
        <p className={styles.drawerText}>
          {detail.risks ?? '—'}
        </p>
      </IntentDetailSection>

      <IntentDetailSection title="跟进">
        {converted ? (
          <div className={styles.convertedBox}>
            <WarmCrmStatusPill tone="positive">已转客户</WarmCrmStatusPill>
            <Link className={styles.convertedLink} href="/dashboard/crm/customers">
              在客户里查看
            </Link>
          </div>
        ) : null}

        <div className={styles.followGrid}>
          <div className={styles.followField}>
            <span className={styles.fieldLabel}>跟进状态</span>
            <select
              aria-label="跟进状态"
              className={styles.tableSelect}
              disabled={readOnly}
              value={detail.followup.state}
              onChange={(event) => onStateChange(event.target.value as IntentState)}
            >
              {INTENT_STATE_ORDER.map((state) => (
                <option key={state} value={state}>
                  {INTENT_STATE_LABELS[state]}
                </option>
              ))}
            </select>
          </div>
          <IntentField label="上次联系" mono>
            {formatDateTime(detail.followup.lastContactAt)}
          </IntentField>
          <div className={styles.followField}>
            <span className={styles.fieldLabel}>下次联系</span>
            <div className={styles.nextRow}>
              <input
                aria-label="下次联系时间"
                className={cn(styles.input, styles.nextInput)}
                disabled={readOnly}
                type="datetime-local"
                value={toDateTimeLocalValue(detail.followup.nextContactAt)}
                onChange={(event) => onNextContactChange(event.target.value)}
              />
              {detail.followup.nextContactAt && !readOnly ? (
                <WarmButton className={styles.clearButton} onClick={onClearNextContact}>
                  清除
                </WarmButton>
              ) : null}
            </div>
            {due ? (
              <span className={due.overdue ? styles.dueOverdue : styles.dueText}>{due.text}</span>
            ) : null}
          </div>
        </div>

        <div className={styles.followField}>
          <span className={styles.fieldLabel}>备注</span>
          <textarea
            aria-label="跟进备注"
            className={styles.textarea}
            disabled={readOnly}
            placeholder="记录沟通要点、报价、下一步…"
            rows={4}
            value={noteValue}
            onChange={(event) => onNoteChange(event.target.value)}
            onBlur={() => onNoteChange(noteValue)}
          />
        </div>

        <span className={styles.saveIndicator} role="status">
          {saveText}
        </span>
        {!canWrite ? (
          <p className={styles.drawerHint}>
            {detail.owner ? `由 ${detail.owner.name || detail.owner.id} 负责，仅可查看。` : '仅可查看。'}
          </p>
        ) : null}
      </IntentDetailSection>
    </>
  )
}

export default IntentRecordDrawer
