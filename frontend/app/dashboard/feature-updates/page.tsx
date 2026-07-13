'use client'

import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import {
  Bot,
  Calendar,
  ChevronRight,
  Download,
  Globe,
  Layers3,
  RefreshCw,
  Settings2,
  Sidebar,
  Sparkles,
  Zap,
  Wand2,
} from 'lucide-react'

const V7_FEATURES = [
  {
    icon: <RefreshCw className="h-5 w-5" />,
    area: 'AI',
    title: '洞察重试机制上线',
    detail:
      '当洞察生成失败或卡住时，可通过新增的 `/retry` 接口一键重置并重新生成，无需手动删除重建，大幅提升 AI 洞察的使用效率。',
    tag: '智能重试',
  },
  {
    icon: <Zap className="h-5 w-5" />,
    area: 'AI',
    title: '实时流式预览',
    detail:
      '在洞察详情弹窗内通过 SSE 实时展示生成进度与流式内容，无需刷新页面即可追踪 AI 洞察的生成状态，体验更流畅。',
    tag: '实时响应',
  },
  {
    icon: <Download className="h-5 w-5" />,
    area: 'AI',
    title: '洞察内容 PNG 导出',
    detail:
      '支持将洞察详情页一键导出为高清 PNG 图片，方便在团队内分享讨论或归档保存，突破纯文本分享的局限。',
    tag: '多格式导出',
  },
  {
    icon: <Globe className="h-5 w-5" />,
    area: 'AI',
    title: '国家级别时区感知',
    detail:
      '日期范围计算改为根据国家时区格式化（US/EU），确保 AI 洞察分析的数据边界与目标市场一致，洞察结论更准确。',
    tag: '时区适配',
  },
  {
    icon: <Settings2 className="h-5 w-5" />,
    area: 'Data',
    title: 'SKU 成本按国家汇总修复',
    detail:
      '修复 SKU 成本页面在切换国家时 summaryBySku 仍混合多国数据的 Bug，同步头程成本接口也改为按国家过滤，数据更精准。',
    tag: '数据治理',
  },
  {
    icon: <Calendar className="h-5 w-5" />,
    area: 'Export',
    title: '店铺核算整数格式优化',
    detail:
      '修复店铺核算 Excel 导出中整数被错误显示为小数的格式问题，整数使用 #,##0，保留小数使用 #,##0.####，导出结果更规范。',
    tag: '导出规范',
  },
  {
    icon: <Sidebar className="h-5 w-5" />,
    area: 'UI',
    title: '侧边栏布局重构',
    detail:
      '重构侧边栏组件结构与间距，Quick Access Bar 区域独立，快捷入口与导航组视觉节奏更清晰，交互体验全面升级。',
    tag: '界面优化',
  },
]

export default function FeatureUpdatesPage() {
  return (
    <div className="space-y-8">
      {/* Hero Section */}
      <div className="relative overflow-hidden rounded-3xl border border-border/70 bg-gradient-to-br from-violet-500/8 via-sky-500/5 to-transparent dark:border-border/80 dark:from-violet-500/12 dark:via-sky-500/8">
        <div className="absolute -right-20 -top-20 h-64 w-64 rounded-full bg-gradient-to-br from-violet-500/20 to-sky-500/10 blur-3xl" />
        <div className="relative z-10 space-y-5 p-7 md:p-8">
          <div className="flex flex-wrap items-center gap-3">
            <Badge
              variant="outline"
              className="border-primary/30 bg-primary/10 px-3 py-1 text-[0.72rem] font-medium uppercase tracking-wider text-primary"
            >
              <Sparkles className="mr-1.5 h-3 w-3" />
              最新版本
            </Badge>
            <span className="font-mono text-2xl font-bold tracking-tight">V7</span>
            <span className="text-lg text-muted-foreground">AI 洞悉</span>
          </div>
          <div className="space-y-3">
            <h1 className="text-3xl font-bold tracking-tight md:text-4xl">V7 版本正式发布</h1>
            <p className="max-w-3xl text-base leading-7 text-muted-foreground md:text-[0.95rem]">
              AI 驱动的智能洞察阶段正式开启。通过深度整合 AI 能力，让数据转化为可执行的运营洞见。
              本版本持续完善洞察重试机制、实时生成流式预览、图片导出与国家级时区感知， 并修复 SKU
              成本汇总与店铺核算导出的边界问题。
            </p>
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            {[
              'AI 洞察增强',
              '实时流式预览',
              '洞察重试',
              'PNG 导出',
              '国家时区感知',
              'SKU 汇总修复',
            ].map((tag) => (
              <Badge
                key={tag}
                variant="secondary"
                className="rounded-full border border-border/70 bg-background/80 px-3 py-1 text-[0.72rem]"
              >
                {tag}
              </Badge>
            ))}
          </div>
        </div>
      </div>

      {/* Features Grid */}
      <div className="grid gap-5 lg:grid-cols-2">
        {V7_FEATURES.map((feature, index) => (
          <Card
            key={feature.title}
            className={cn(
              'group relative overflow-hidden transition-all duration-300 hover:border-primary/30 hover:shadow-lg hover:shadow-primary/5 dark:hover:border-primary/40 dark:hover:shadow-primary/10',
              index === 0 && 'lg:col-span-2'
            )}
          >
            <div className="absolute inset-0 bg-gradient-to-br from-violet-500/[0.03] via-transparent to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
            <CardContent className="relative z-10 space-y-4 p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-4">
                  <div className="rounded-2xl border border-primary/15 bg-primary/10 p-3 text-primary transition-transform duration-300 group-hover:scale-110 dark:border-primary/25 dark:bg-primary/15">
                    {feature.icon}
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-[0.68rem] uppercase tracking-[0.14em] text-muted-foreground">
                        {feature.area}
                      </span>
                      <Badge
                        variant="secondary"
                        className="rounded-full border-primary/20 bg-primary/8 px-2 py-0 text-[0.65rem] text-primary"
                      >
                        {feature.tag}
                      </Badge>
                    </div>
                    <h3 className="text-lg font-semibold tracking-tight">{feature.title}</h3>
                  </div>
                </div>
                <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground/50 transition-transform duration-300 group-hover:translate-x-1 group-hover:text-primary" />
              </div>
              <p className="text-sm leading-6 text-muted-foreground">{feature.detail}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Summary Card */}
      <Card className="overflow-hidden border-border/70 dark:border-border/80">
        <CardContent className="space-y-5 p-6 md:p-7">
          <div className="flex items-center gap-3">
            <div className="rounded-2xl border border-primary/15 bg-primary/10 p-2.5 text-primary">
              <Wand2 className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-lg font-semibold tracking-tight">V7 阶段总结</h3>
              <p className="text-sm text-muted-foreground">本阶段共完成 7 项核心能力升级</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <div className="rounded-2xl border border-border/70 bg-background/80 p-4 text-center dark:border-border/90 dark:bg-[hsl(var(--surface-soft)/0.6)]">
              <div className="text-2xl font-bold text-primary">4</div>
              <div className="text-[0.72rem] uppercase tracking-[0.1em] text-muted-foreground">
                AI 功能
              </div>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/80 p-4 text-center dark:border-border/90 dark:bg-[hsl(var(--surface-soft)/0.6)]">
              <div className="text-2xl font-bold text-primary">2</div>
              <div className="text-[0.72rem] uppercase tracking-[0.1em] text-muted-foreground">
                数据修复
              </div>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/80 p-4 text-center dark:border-border/90 dark:bg-[hsl(var(--surface-soft)/0.6)]">
              <div className="text-2xl font-bold text-primary">1</div>
              <div className="text-[0.72rem] uppercase tracking-[0.1em] text-muted-foreground">
                界面重构
              </div>
            </div>
            <div className="rounded-2xl border border-border/70 bg-background/80 p-4 text-center dark:border-border/90 dark:bg-[hsl(var(--surface-soft)/0.6)]">
              <div className="text-2xl font-bold text-primary">7</div>
              <div className="text-[0.72rem] uppercase tracking-[0.1em] text-muted-foreground">
                亮点总数
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Coming Soon Hint */}
      <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
        <Layers3 className="h-4 w-4" />
        <span>更多能力正在持续建设中，敬请期待</span>
        <Bot className="h-4 w-4" />
      </div>
    </div>
  )
}
