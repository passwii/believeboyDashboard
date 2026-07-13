'use client'

import Link from 'next/link'

type AdAnalysisDrillLinkItem = {
  href: string | null
  label: string
}

const DRILL_LINK_ORDER: Record<string, number> = {
  活动: 1,
  预算: 2,
  SKU: 3,
  搜索词: 4,
  投放: 5,
  广告位: 6,
  流量: 7,
  关联购买: 8,
  趋势: 9,
  聚焦: 10,
}

export function AdAnalysisDrillLinks({ links }: { links: AdAnalysisDrillLinkItem[] }) {
  const filteredLinks = links
    .filter((item) => Boolean(item.href))
    .sort((left, right) => {
      const leftOrder = DRILL_LINK_ORDER[left.label] ?? 999
      const rightOrder = DRILL_LINK_ORDER[right.label] ?? 999
      return leftOrder - rightOrder || left.label.localeCompare(right.label, 'zh-CN')
    })

  if (filteredLinks.length === 0) return null

  return (
    <div className="flex flex-wrap gap-2 text-sm">
      {filteredLinks.map((item) => (
        <Link
          key={`${item.label}-${item.href}`}
          href={item.href!}
          className="text-primary underline-offset-4 hover:underline"
        >
          {item.label}
        </Link>
      ))}
    </div>
  )
}
