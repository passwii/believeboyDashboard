'use client'

import { useState, useRef, useEffect } from 'react'
import { ChevronDown, Pencil, Plus, Trash2, Check } from 'lucide-react'

import {
  WarmButton,
  WarmIconButton,
} from '@/components/dashboard-v2/warm-ledger/controls'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import styles from './project-context-warm.module.css'

type DimensionItem = {
  key: string
  value: string
}

type DynamicContextCardProps = {
  value: Record<string, string>
  onChange: (value: Record<string, string>) => void
  onAiImport?: () => void
  collapsed?: boolean
  onCollapsedChange?: (collapsed: boolean) => void
  readOnly?: boolean
}

export function DynamicContextCard({
  value,
  onChange,
  onAiImport,
  collapsed: controlledCollapsed,
  onCollapsedChange,
  readOnly = false,
}: DynamicContextCardProps) {
  const [internalCollapsed, setInternalCollapsed] = useState(false)
  const collapsed = controlledCollapsed ?? internalCollapsed
  const setCollapsed = onCollapsedChange ?? setInternalCollapsed

  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [editingKeyValue, setEditingKeyValue] = useState('')
  const [newKeyMode, setNewKeyMode] = useState(false)
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')
  const keyInputRef = useRef<HTMLInputElement>(null)

  const dimensions: DimensionItem[] = Object.entries(value).map(([key, val]) => ({
    key,
    value: val,
  }))

  useEffect(() => {
    if (editingKey && keyInputRef.current) {
      keyInputRef.current.focus()
    }
  }, [editingKey])

  const handleStartEditKey = (key: string) => {
    setEditingKey(key)
    setEditingKeyValue(key)
  }

  const handleConfirmEditKey = () => {
    if (editingKey && editingKeyValue.trim() && editingKeyValue !== editingKey) {
      const newValue: Record<string, string> = {}
      for (const [k, v] of Object.entries(value)) {
        if (k === editingKey) {
          newValue[editingKeyValue] = v
        } else {
          newValue[k] = v
        }
      }
      onChange(newValue)
    }
    setEditingKey(null)
    setEditingKeyValue('')
  }

  const handleCancelEditKey = () => {
    setEditingKey(null)
    setEditingKeyValue('')
  }

  const handleValueChange = (key: string, newVal: string) => {
    onChange({ ...value, [key]: newVal })
  }

  const handleDelete = (key: string) => {
    const newValue: Record<string, string> = {}
    for (const [k, v] of Object.entries(value)) {
      if (k !== key) {
        newValue[k] = v
      }
    }
    onChange(newValue)
  }

  const handleAdd = () => {
    if (!newKey.trim()) return
    onChange({ ...value, [newKey]: newValue })
    setNewKey('')
    setNewValue('')
    setNewKeyMode(false)
  }

  const handleCancelAdd = () => {
    setNewKey('')
    setNewValue('')
    setNewKeyMode(false)
  }


  return (
    <div className={styles.editor}>
      <button
        type="button"
        className={styles.editorHeader}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className={styles.editorHeading}>
          <span className={styles.editorTitle}>维度信息</span>
          <span className={styles.editorCount}>({dimensions.length} 个)</span>
        </span>
        <span className={styles.editorHeading}>
          {!collapsed && dimensions.length > 0 ? (
            <span className={styles.editorSummary}>
              {dimensions
                .slice(0, 3)
                .map((item) => item.key)
                .join('、')}
              {dimensions.length > 3 ? ` 等 ${dimensions.length} 个` : ''}
            </span>
          ) : null}
          <ChevronDown
            className={`${styles.editorChevron} ${
              collapsed ? styles.editorChevronCollapsed : ''
            }`}
            aria-hidden="true"
          />
        </span>
      </button>

      {!collapsed ? (
        <div>
          {!readOnly ? (
            <div className={styles.editorToolbar}>
              <span className={styles.editorCount}>{dimensions.length} 个维度</span>
              <div className={styles.editorToolbarActions}>
                {onAiImport ? (
                  <WarmButton
                    variant="secondary"
                    onClick={onAiImport}
                    className={styles.editorActionButton}
                  >
                    AI 辅助
                  </WarmButton>
                ) : null}
                <WarmButton
                  variant="secondary"
                  onClick={() => setNewKeyMode(true)}
                  className={styles.editorActionButton}
                >
                  <Plus aria-hidden="true" />
                  添加维度
                </WarmButton>
              </div>
            </div>
          ) : null}

          <div className={styles.dimensionList}>
            {dimensions.map(({ key, value: dimensionValue }) => (
              <div key={key} className={styles.dimensionRow}>
                <div className={styles.dimensionKey}>
                  {editingKey === key && !readOnly ? (
                    <>
                      <Input
                        ref={keyInputRef}
                        aria-label="维度名称"
                        value={editingKeyValue}
                        onChange={(event) => setEditingKeyValue(event.target.value)}
                        onBlur={handleConfirmEditKey}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') handleConfirmEditKey()
                          if (event.key === 'Escape') handleCancelEditKey()
                        }}
                        className={styles.input}
                      />
                      <WarmIconButton
                        aria-label="确认维度名称"
                        onClick={handleConfirmEditKey}
                        className={styles.compactIconButton}
                      >
                        <Check aria-hidden="true" />
                      </WarmIconButton>
                    </>
                  ) : (
                    <>
                      <span className={styles.dimensionKeyText}>{key}</span>
                      {!readOnly ? (
                        <WarmIconButton
                          aria-label={`编辑维度 ${key}`}
                          onClick={() => handleStartEditKey(key)}
                          className={styles.compactIconButton}
                        >
                          <Pencil aria-hidden="true" />
                        </WarmIconButton>
                      ) : null}
                    </>
                  )}
                </div>

                <div className={styles.dimensionValue}>
                  {!readOnly ? (
                    <Textarea
                      aria-label={`${key} 描述`}
                      value={dimensionValue}
                      onChange={(event) => handleValueChange(key, event.target.value)}
                      placeholder="输入维度描述..."
                      rows={2}
                      className={`${styles.textarea} ${styles.dimensionTextarea}`}
                    />
                  ) : (
                    <p className={styles.dimensionReadOnly}>
                      {dimensionValue || (
                        <span className={styles.dimensionReadOnlyEmpty}>未填写</span>
                      )}
                    </p>
                  )}
                </div>

                {!readOnly && editingKey !== key ? (
                  <WarmIconButton
                    aria-label={`删除维度 ${key}`}
                    onClick={() => handleDelete(key)}
                    className={`${styles.compactIconButton} ${styles.compactIconButtonDanger}`}
                  >
                    <Trash2 aria-hidden="true" />
                  </WarmIconButton>
                ) : null}
              </div>
            ))}

            {newKeyMode ? (
              <div className={`${styles.dimensionRow} ${styles.newRow}`}>
                <div className={styles.dimensionKey}>
                  <Input
                    aria-label="新维度名称"
                    value={newKey}
                    onChange={(event) => setNewKey(event.target.value)}
                    placeholder="维度名称"
                    className={styles.input}
                    autoFocus
                  />
                </div>
                <div className={styles.dimensionValue}>
                  <Textarea
                    aria-label="新维度描述"
                    value={newValue}
                    onChange={(event) => setNewValue(event.target.value)}
                    placeholder="输入维度描述..."
                    rows={2}
                    className={`${styles.textarea} ${styles.dimensionTextarea}`}
                  />
                </div>
                <div className={styles.newRowActions}>
                  <WarmButton
                    variant="quiet"
                    onClick={handleCancelAdd}
                    className={styles.editorActionButton}
                  >
                    取消
                  </WarmButton>
                  <WarmButton
                    variant="primary"
                    onClick={handleAdd}
                    disabled={!newKey.trim()}
                    className={styles.editorActionButton}
                  >
                    添加
                  </WarmButton>
                </div>
              </div>
            ) : null}
          </div>

          {dimensions.length === 0 && !newKeyMode ? (
            <div className={styles.editorEmpty}>
              <p>暂无维度信息</p>
              {!readOnly ? (
                <p className={styles.editorEmptyHint}>点击「添加维度」或「AI 辅助」开始</p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
