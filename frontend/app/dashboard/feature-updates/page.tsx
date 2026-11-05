'use client'

import {
  Bot,
  Calendar,
  Download,
  Globe,
  Layers3,
  RefreshCw,
  Settings2,
  Sidebar,
  Sparkles,
  Wand2,
  Zap,
} from 'lucide-react'

import { WarmBadge } from '@/components/dashboard-v2/warm-ledger/controls'

import styles from './feature-updates-warm.module.css'

const V7_FEATURES = [
  {
    icon: <RefreshCw aria-hidden="true" />,
    area: 'AI',
    title: '洞察重试机制上线',
    detail:
      '当洞察生成失败或卡住时，可通过新增的 `/retry` 接口一键重置并重新生成，无需手动删除重建，大幅提升 AI 洞察的使用效率。',
    tag: '智能重试',
  },
  {
    icon: <Zap aria-hidden="true" />,
    area: 'AI',
    title: '实时流式预览',
    detail:
      '在洞察详情弹窗内通过 SSE 实时展示生成进度与流式内容，无需刷新页面即可追踪 AI 洞察的生成状态，体验更流畅。',
    tag: '实时响应',
  },
  {
    icon: <Download aria-hidden="true" />,
    area: 'AI',
    title: '洞察内容 PNG 导出',
    detail:
      '支持将洞察详情页一键导出为高清 PNG 图片，方便在团队内分享讨论或归档保存，突破纯文本分享的局限。',
    tag: '多格式导出',
  },
  {
    icon: <Globe aria-hidden="true" />,
    area: 'AI',
    title: '国家级别时区感知',
    detail:
      '日期范围计算改为根据国家时区格式化（US/EU），确保 AI 洞察分析的数据边界与目标市场一致，洞察结论更准确。',
    tag: '时区适配',
  },
  {
    icon: <Settings2 aria-hidden="true" />,
    area: 'Data',
    title: 'SKU 成本按国家汇总修复',
    detail:
      '修复 SKU 成本页面在切换国家时 summaryBySku 仍混合多国数据的 Bug，同步头程成本接口也改为按国家过滤，数据更精准。',
    tag: '数据治理',
  },
  {
    icon: <Calendar aria-hidden="true" />,
    area: 'Export',
    title: '店铺核算整数格式优化',
    detail:
      '修复店铺核算 Excel 导出中整数被错误显示为小数的格式问题，整数使用 #,##0，保留小数使用 #,##0.####，导出结果更规范。',
    tag: '导出规范',
  },
  {
    icon: <Sidebar aria-hidden="true" />,
    area: 'UI',
    title: '侧边栏布局重构',
    detail:
      '重构侧边栏组件结构与间距，Quick Access Bar 区域独立，快捷入口与导航组视觉节奏更清晰，交互体验全面升级。',
    tag: '界面优化',
  },
]

const V7_TAGS = ['AI 洞察增强', '实时流式预览', '洞察重试', 'PNG 导出', '国家时区感知', 'SKU 汇总修复']

const V7_SUMMARY = [
  { value: '4', label: 'AI 功能' },
  { value: '2', label: '数据修复' },
  { value: '1', label: '界面重构' },
  { value: '7', label: '亮点总数' },
]

export default function FeatureUpdatesPage() {
  return (
    <div className={styles.page} data-warm-page="feature-updates">
      <header className={styles.header}>
        <h1 className={styles.pageTitle}>V7 版本正式发布</h1>
        <WarmBadge tone="accent" className={styles.headerBadge}>
          <Sparkles aria-hidden="true" />
          最新版本
        </WarmBadge>
      </header>

      <section className={styles.introPanel} aria-labelledby="v7-intro-title">
        <div className={styles.introHeading}>
          <h2 id="v7-intro-title" className={styles.introTitle}>
            V7
          </h2>
          <span className={styles.introArea}>AI 洞悉</span>
        </div>
        <p className={styles.introCopy}>
          AI 驱动的智能洞察阶段正式开启。通过深度整合 AI 能力，让数据转化为可执行的运营洞见。
          本版本持续完善洞察重试机制、实时生成流式预览、图片导出与国家级时区感知，并修复 SKU
          成本汇总与店铺核算导出的边界问题。
        </p>
        <div className={styles.tagList}>
          {V7_TAGS.map((tag) => (
            <WarmBadge key={tag} tone="neutral">
              {tag}
            </WarmBadge>
          ))}
        </div>
      </section>

      <div className={styles.featureGrid}>
        {V7_FEATURES.map((feature) => (
          <article key={feature.title} className={styles.featureCard}>
            <div className={styles.featureHeading}>
              <span className={styles.featureIcon}>{feature.icon}</span>
              <div className={styles.featureCopy}>
                <div className={styles.featureMeta}>
                  <span>{feature.area}</span>
                  <WarmBadge tone="neutral">{feature.tag}</WarmBadge>
                </div>
                <h2 className={styles.featureTitle}>{feature.title}</h2>
              </div>
            </div>
            <p className={styles.featureDetail}>{feature.detail}</p>
          </article>
        ))}
      </div>

      <section className={styles.summaryPanel} aria-labelledby="v7-summary-title">
        <div className={styles.summaryHeading}>
          <Wand2 aria-hidden="true" />
          <h2 id="v7-summary-title" className={styles.summaryTitle}>
            V7 阶段总结
          </h2>
          <span className={styles.summaryCopy}>本阶段共完成 7 项核心能力升级</span>
        </div>
        <div className={styles.summaryGrid}>
          {V7_SUMMARY.map((item) => (
            <div key={item.label} className={styles.summaryMetric}>
              <span className={styles.metricValue}>{item.value}</span>
              <span className={styles.metricLabel}>{item.label}</span>
            </div>
          ))}
        </div>
      </section>

      <div className={styles.comingSoon}>
        <Layers3 aria-hidden="true" />
        <span>更多能力正在持续建设中，敬请期待</span>
        <Bot aria-hidden="true" />
      </div>
    </div>
  )
}
