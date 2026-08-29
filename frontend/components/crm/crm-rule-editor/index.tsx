'use client'

import { useEffect, useMemo } from 'react'
import { useForm, type Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { ArrowRight, Bot } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  DEFAULT_FORM_VALUES,
  ENTITY_LABELS,
  parseRuleToForm,
  toRuleInput,
  type RuleFormValues,
} from './rule-editor-utils'
import type { Rule, RuleInput } from '@/lib/crm/types'

const ruleSchema = z.object({
  name: z.string().trim().min(1, '请输入规则名称').max(200, '规则名称最多 200 字'),
  description: z.string().max(500, '描述最多 500 字'),
  entityType: z.enum(['customer', 'lead']),
  days: z.coerce
    .number({ error: '请输入天数' })
    .int('天数需为整数')
    .min(1, '天数至少为 1')
    .max(365, '天数最多 365'),
  onlyNeverFollowed: z.boolean(),
  enabled: z.boolean(),
})

export interface CrmRuleEditorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 编辑时传入规则；新建缺省 */
  rule?: Rule
  onSubmit: (input: RuleInput) => void | Promise<void>
}

/**
 * 「当 X 发生，做 Y」规则编辑器（P9-7，BLF-545）。
 *
 * MVP 仅支持：当【客户/线索】创建超过 N 天 且 从未跟进 → 提醒负责人。
 * 句子式分段编辑：条件块（当）+ 动作块（做），实时预览。
 * 编辑 MVP 之外的规则（unsupported）时提示只读、禁保存，避免静默改坏。
 */
export function CrmRuleEditor({ open, onOpenChange, rule, onSubmit }: CrmRuleEditorProps) {
  const initial = useMemo(() => {
    if (!rule) return { values: DEFAULT_FORM_VALUES, unsupported: false }
    return parseRuleToForm(rule)
  }, [rule])

  const form = useForm<RuleFormValues>({
    resolver: zodResolver(ruleSchema) as Resolver<RuleFormValues>,
    defaultValues: initial.values,
  })

  // 打开/切换目标规则时重置表单（复用同一个 dialog 实例）
  useEffect(() => {
    if (open) {
      form.reset(initial.values)
    }
  }, [open, initial, form])

  const watched = form.watch()
  const preview = useMemo(() => {
    const entity = ENTITY_LABELS[watched.entityType]
    const parts = [`${entity}创建超过 ${watched.days || '—'} 天`]
    if (watched.onlyNeverFollowed) parts.push('从未跟进')
    return `当${parts.join(' 且 ')} → 提醒负责人`
  }, [watched.entityType, watched.days, watched.onlyNeverFollowed])

  async function handleSubmit(values: RuleFormValues) {
    await onSubmit(toRuleInput(values))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{rule ? '编辑规则' : '新建规则'}</DialogTitle>
          <DialogDescription>
            可视化配置「当 X 发生，做 Y」。MVP 支持：实体创建超过 N 天无跟进 → 提醒负责人。
          </DialogDescription>
        </DialogHeader>

        {initial.unsupported ? (
          <div className="rounded-lg border border-term-warn/30 bg-term-warn/10 px-4 py-3 text-sm text-term-warn">
            该规则包含暂不支持编辑的条件/动作组合（MVP 仅支持「创建超过 N 天 且 从未跟进 →
            提醒负责人」）。如需调整，请删除后按 MVP 结构重建。
          </div>
        ) : (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
              {/* 规则名称 */}
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>规则名称 *</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="如：客户 7 天无跟进提醒" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* 当（条件块） */}
              <div className="rounded-lg border bg-muted/30 p-3">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  当
                </p>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <FormField
                    control={form.control}
                    name="entityType"
                    render={({ field }) => (
                      <FormItem className="space-y-0">
                        <FormControl>
                          <Select onValueChange={field.onChange} value={field.value}>
                            <SelectTrigger className="h-8 w-20">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {Object.entries(ENTITY_LABELS).map(([v, l]) => (
                                <SelectItem key={v} value={v}>
                                  {l}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </FormControl>
                      </FormItem>
                    )}
                  />
                  <span className="text-muted-foreground">创建超过</span>
                  <FormField
                    control={form.control}
                    name="days"
                    render={({ field }) => (
                      <FormItem className="space-y-0">
                        <FormControl>
                          <Input
                            {...field}
                            type="number"
                            min={1}
                            max={365}
                            className="h-8 w-16 text-center"
                            aria-label="创建超过天数"
                          />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                  <span className="text-muted-foreground">天</span>
                  <FormField
                    control={form.control}
                    name="onlyNeverFollowed"
                    render={({ field }) => (
                      <FormItem className="flex items-center gap-1.5 space-y-0 pl-1">
                        <FormControl>
                          <Checkbox
                            checked={field.value}
                            onCheckedChange={(v) => field.onChange(v === true)}
                            aria-label="且从未跟进"
                          />
                        </FormControl>
                        <FormLabel className="text-sm font-normal">且从未跟进</FormLabel>
                      </FormItem>
                    )}
                  />
                </div>
                {form.formState.errors.days && (
                  <p className="mt-1.5 text-xs text-destructive">{form.formState.errors.days.message}</p>
                )}
              </div>

              {/* 做（动作块） */}
              <div className="rounded-lg border bg-muted/30 p-3">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  做
                </p>
                <div className="flex items-center gap-2 text-sm">
                  <Bot className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  <span className="font-medium">提醒负责人</span>
                  <span className="text-xs text-muted-foreground">（站内提醒，每日 09:05 自动扫描）</span>
                </div>
              </div>

              {/* 启用 */}
              <FormField
                control={form.control}
                name="enabled"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between space-y-0">
                    <div>
                      <FormLabel className="text-sm font-medium">启用规则</FormLabel>
                      <FormDescription className="text-xs">
                        关闭后规则暂停执行，不删除配置
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        aria-label="启用规则"
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              {/* 实时预览 */}
              <div className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2.5 text-sm">
                <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                <p className="text-muted-foreground">
                  <span className="font-medium text-foreground">{watched.name || '规则预览'}</span>
                  <br />
                  {preview}
                </p>
              </div>

              <DialogFooter className="gap-2 sm:gap-0">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  className="sm:mr-auto"
                >
                  取消
                </Button>
                <Button type="submit" disabled={form.formState.isSubmitting}>
                  {form.formState.isSubmitting ? '保存中…' : '保存'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        )}
      </DialogContent>
    </Dialog>
  )
}
