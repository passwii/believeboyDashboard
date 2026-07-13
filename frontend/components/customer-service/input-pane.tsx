'use client'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { ScenarioPreset } from '@/lib/server/ai-chat'

export function InputPane({
  scenario,
  freeText,
  setFreeText,
  guidedFields,
  setGuidedFields,
  language,
  setLanguage,
  length,
  setLength,
  onGenerate,
  isGenerating,
  canGenerate,
}: {
  scenario: ScenarioPreset | null
  freeText: string
  setFreeText: (v: string) => void
  guidedFields: Record<string, string>
  setGuidedFields: (v: Record<string, string>) => void
  language: 'zh' | 'en'
  setLanguage: (v: 'zh' | 'en') => void
  length: 'brief' | 'standard' | 'detailed'
  setLength: (v: 'brief' | 'standard' | 'detailed') => void
  onGenerate: () => void
  isGenerating: boolean
  canGenerate: boolean
}) {
  if (!scenario) return null
  return (
    <div className="flex min-h-0 flex-col gap-3 overflow-y-auto rounded-lg border border-border bg-[hsl(var(--surface-panel))] p-4">
      {scenario.showFreeTextArea && (
        <Textarea
          value={freeText}
          onChange={(e) => setFreeText(e.target.value)}
          placeholder="粘贴你的原始草稿 / 数据 / 零散想法…"
          className="min-h-40 flex-1 resize-none"
        />
      )}
      {scenario.inputSchema.map((f) => (
        <div key={f.key} className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">{f.label}</label>
          {f.type === 'textarea' ? (
            <Textarea
              value={guidedFields[f.key] ?? ''}
              onChange={(e) => setGuidedFields({ ...guidedFields, [f.key]: e.target.value })}
              placeholder={f.placeholder}
              className="min-h-16 resize-none"
            />
          ) : (
            <Input
              value={guidedFields[f.key] ?? ''}
              onChange={(e) => setGuidedFields({ ...guidedFields, [f.key]: e.target.value })}
              placeholder={f.placeholder}
            />
          )}
        </div>
      ))}
      <div className="mt-1 flex flex-wrap items-center gap-3">
        <div className="flex overflow-hidden rounded-md border border-border">
          <button
            type="button"
            onClick={() => setLanguage('zh')}
            className={[
              'px-3 py-1 text-sm',
              language === 'zh' ? 'bg-primary/10 text-primary' : 'text-muted-foreground',
            ].join(' ')}
          >
            中文
          </button>
          <button
            type="button"
            onClick={() => setLanguage('en')}
            className={[
              'px-3 py-1 text-sm',
              language === 'en' ? 'bg-primary/10 text-primary' : 'text-muted-foreground',
            ].join(' ')}
          >
            English
          </button>
        </div>
        <Select
          value={length}
          onValueChange={(v) => setLength(v as 'brief' | 'standard' | 'detailed')}
        >
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="brief">简报</SelectItem>
            <SelectItem value="standard">标准</SelectItem>
            <SelectItem value="detailed">详细</SelectItem>
          </SelectContent>
        </Select>
        <Button className="ml-auto" onClick={onGenerate} disabled={!canGenerate || isGenerating}>
          {isGenerating ? '生成中…' : '生成'}
        </Button>
      </div>
    </div>
  )
}
