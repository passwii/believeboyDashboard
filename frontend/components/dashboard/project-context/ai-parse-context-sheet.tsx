'use client'

import { useEffect, useState } from 'react'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import {
  WarmButton,
  WarmIconButton,
} from '@/components/dashboard-v2/warm-ledger/controls'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { useNotifications } from '@/components/notifications'
import { Plus, Trash2 } from 'lucide-react'
import styles from './project-context-warm.module.css'

const API_BASE = '/api/backend'

type ParsedKeyValue = Record<string, string>

interface AiParseContextSheetProps {
  open: boolean
  projectId: number
  projectName: string
  onClose: () => void
  onParsed: (context: ParsedKeyValue) => void
}

export function AiParseContextSheet({
  open,
  projectId,
  projectName,
  onClose,
  onParsed,
}: AiParseContextSheetProps) {
  const { notify } = useNotifications()
  const [description, setDescription] = useState('')
  const [parsing, setParsing] = useState(false)
  const [parsedItems, setParsedItems] = useState<ParsedKeyValue | null>(null)
  const [editingItems, setEditingItems] = useState<ParsedKeyValue>({})
  const [isEditing, setIsEditing] = useState(false)

  useEffect(() => {
    if (open) {
      setDescription('')
      setParsedItems(null)
      setEditingItems({})
      setParsing(false)
      setIsEditing(false)
    }
  }, [open])

  const handleParse = async () => {
    if (!description.trim()) {
      notify({ type: 'warning', title: '请输入项目背景描述' })
      return
    }

    setParsing(true)
    setParsedItems(null)
    setEditingItems({})
    setIsEditing(false)

    try {
      const response = await fetch(`${API_BASE}/api/v1/projects/${projectId}/context/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: description.trim() }),
      })

      if (!response.ok) {
        const errText = await response.text()
        throw new Error(errText || 'AI 解析失败')
      }

      const data = await response.json()
      setParsedItems(data.result)
      setEditingItems(data.result || {})
      setIsEditing(true)

      if (!data.result || Object.keys(data.result).length === 0) {
        notify({ type: 'warning', title: '解析结果为空', message: '请检查输入描述是否正确' })
      } else {
        const count = Object.keys(data.result).length
        notify({ type: 'success', title: '解析成功', message: `已识别 ${count} 个维度` })
      }
    } catch (err) {
      notify({
        type: 'error',
        title: 'AI 解析失败',
        message: err instanceof Error ? err.message : '未知错误',
      })
    } finally {
      setParsing(false)
    }
  }

  const handleSave = () => {
    if (Object.keys(editingItems).length === 0) {
      notify({ type: 'warning', title: '请至少保留一个维度' })
      return
    }
    onParsed(editingItems)
    onClose()
  }

  const handleKeyChange = (oldKey: string, newKey: string) => {
    const value = editingItems[oldKey]
    const newItems = { ...editingItems }
    delete newItems[oldKey]
    newItems[newKey] = value
    setEditingItems(newItems)
  }

  const handleValueChange = (key: string, value: string) => {
    setEditingItems({ ...editingItems, [key]: value })
  }

  const handleDelete = (key: string) => {
    const newItems = { ...editingItems }
    delete newItems[key]
    setEditingItems(newItems)
  }

  const handleAdd = () => {
    const count = Object.keys(editingItems).length + 1
    setEditingItems({ ...editingItems, [`新维度${count}`]: '' })
  }

  const hasAnyContent = editingItems && Object.keys(editingItems).length > 0

  return (
    <Sheet
      open={open}
      onOpenChange={(openState) => {
        if (!openState) onClose()
      }}
    >
      <SheetContent
        className={`${styles.surface} ${styles.sheetSurface} ${styles.aiSheet} flex flex-col`}
      >
        <SheetHeader>
          <SheetTitle className={styles.surfaceTitle}>AI 辅助填充项目背景</SheetTitle>
          <div className={styles.surfaceDescription}>项目：{projectName}</div>
        </SheetHeader>

        <div className={styles.aiContent}>
          <div className={styles.formField}>
            <label htmlFor="ai-context-description" className={styles.sectionLabel}>
              项目背景描述
            </label>
            <Textarea
              id="ai-context-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={`请输入项目的背景信息，AI 将自动解析为结构化的维度信息。

例如：
"深圳华强北供应商，月产能 5000 件，旺季可扩到 8000。交货周期 15 天，淡季 10 天。对接人王经理响应快。

旺季是 11-12 月礼品季，3-4 月开学季，需要提前 2 个月备货。淡季 6-8 月可以考虑清库存。

去年增长率 30%，主要是新品上线带动。新品开发周期 3 周。

目前库存周转率偏低，风险是交期延误。"

支持任意格式的输入，AI 会自动分类整理成 Key-Value 形式。`}
              className={`${styles.textarea} ${styles.aiTextarea}`}
              disabled={parsing}
            />
            <div className={styles.aiActionRow}>
              <p className={styles.hint}>
                AI 会自动识别并生成维度名称和对应描述
              </p>
              <WarmButton
                variant="primary"
                onClick={handleParse}
                disabled={parsing || !description.trim()}
                loading={parsing}
                loadingLabel="正在解析项目背景"
              >
                {parsing ? 'AI 解析中...' : 'AI 解析'}
              </WarmButton>
            </div>
          </div>

          {isEditing ? (
            <div className={styles.parsedList}>
              <div className={styles.resultHeader}>
                <span className={styles.sectionLabel}>解析结果（可编辑）</span>
                <div className={styles.editorToolbarActions}>
                  <span className={styles.resultCount}>
                    {Object.keys(editingItems).length} 个维度
                  </span>
                  <WarmButton
                    variant="secondary"
                    onClick={handleAdd}
                    className={styles.editorActionButton}
                  >
                    <Plus aria-hidden="true" />
                    添加维度
                  </WarmButton>
                </div>
              </div>

              {Object.entries(editingItems).map(([key, value], index) => (
                <div key={`${key}-${index}`} className={styles.parsedRow}>
                  <div className={styles.parsedKeyRow}>
                    <Input
                      aria-label={`解析维度 ${index + 1} 名称`}
                      value={key}
                      onChange={(e) => handleKeyChange(key, e.target.value)}
                      className={styles.input}
                      placeholder="维度名称"
                    />
                    <WarmIconButton
                      aria-label={`删除解析维度 ${key}`}
                      onClick={() => handleDelete(key)}
                      className={`${styles.compactIconButton} ${styles.compactIconButtonDanger}`}
                    >
                      <Trash2 aria-hidden="true" />
                    </WarmIconButton>
                  </div>
                  <Textarea
                    aria-label={`解析维度 ${index + 1} 描述`}
                    value={value}
                    onChange={(e) => handleValueChange(key, e.target.value)}
                    className={`${styles.textarea} ${styles.dimensionTextarea}`}
                    placeholder="输入维度描述..."
                  />
                </div>
              ))}

              {Object.keys(editingItems).length === 0 ? (
                <div className={styles.parsedEmpty}>暂无维度，请添加或重新解析</div>
              ) : null}
            </div>
          ) : null}

          {isEditing ? (
            <div className={styles.aiFooter}>
              <WarmButton
                variant="quiet"
                onClick={() => {
                  setDescription('')
                  setParsedItems(null)
                  setEditingItems({})
                  setIsEditing(false)
                }}
              >
                重新输入
              </WarmButton>
              <div className={styles.aiFooterActions}>
                <WarmButton variant="secondary" onClick={onClose}>
                  取消
                </WarmButton>
                <WarmButton variant="primary" onClick={handleSave} disabled={!hasAnyContent}>
                  填充到表单
                </WarmButton>
              </div>
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}
