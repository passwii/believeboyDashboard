import { ArrowUpRight, Building2, Globe2, ShoppingBag, Tag } from 'lucide-react'

import { TermPanel } from '@/components/terminal/term-panel'
import { TermKpiTile } from '@/components/terminal/term-controls'

type Platform = {
  name: string
  href: string
  region: string
  category: string
  group: 'platform' | 'forum'
}

const platforms: Platform[] = [
  {
    name: 'Amazon',
    href: 'https://www.amazon.com',
    region: 'Global',
    category: 'Marketplace',
    group: 'platform',
  },
  {
    name: 'Walmart',
    href: 'https://www.walmart.com',
    region: 'United States',
    category: 'Marketplace',
    group: 'platform',
  },
  {
    name: 'AMZ123',
    href: 'https://www.amz123.com',
    region: 'China',
    category: 'Media & Tools',
    group: 'forum',
  },
  {
    name: 'SHEIN',
    href: 'https://us.shein.com',
    region: 'Global',
    category: 'Fashion',
    group: 'platform',
  },
  {
    name: 'TEMU',
    href: 'https://www.temu.com',
    region: 'Global',
    category: 'Marketplace',
    group: 'platform',
  },
  {
    name: 'Etsy',
    href: 'https://www.etsy.com',
    region: 'Global',
    category: 'Niche',
    group: 'platform',
  },
  {
    name: 'TikTok Shop',
    href: 'https://www.tiktok.com/shop',
    region: 'Global',
    category: 'Social Commerce',
    group: 'platform',
  },
]

const platformItems = platforms.filter((item) => item.group === 'platform')
const forumItems = platforms.filter((item) => item.group === 'forum')

const stats = [
  { label: '平台总数', value: `${platformItems.length}`, icon: Globe2 },
  { label: '资讯论坛', value: `${forumItems.length}`, icon: ShoppingBag },
  { label: '平台类型', value: '平台/资讯', icon: Tag },
]

type PlatformGridProps = {
  items: Platform[]
}

function PlatformGrid({ items }: PlatformGridProps) {
  return (
    <div className="grid grid-cols-2 gap-px bg-term-border p-px sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-6">
      {items.map((platform) => (
        <a
          key={platform.name}
          href={platform.href}
          target="_blank"
          rel="noreferrer"
          className="group flex h-full min-h-[132px] flex-col gap-2 border-0 bg-term-panel p-3 transition-colors hover:bg-term-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-term-border-strong"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold text-term-text">{platform.name}</h3>
              <p className="mt-1 inline-flex items-center gap-1 border border-term-border bg-term-raised px-1.5 py-0.5 font-mono text-[11px] leading-4 text-term-muted">
                <Building2 className="h-3 w-3 shrink-0" />
                {platform.region}
              </p>
            </div>
            <span className="flex h-7 w-7 shrink-0 items-center justify-center border border-term-border bg-term-bg text-term-muted transition-colors group-hover:border-term-border-strong group-hover:text-term-text">
              <ArrowUpRight className="h-3.5 w-3.5" />
            </span>
          </div>

          <p className="flex-1 text-xs leading-5 text-term-muted">{platform.category}</p>

          <div className="flex items-center justify-between border-t border-term-border pt-2">
            <span className="border border-term-border bg-term-raised px-2 py-0.5 font-mono text-[11px] leading-4 text-term-muted">
              {platform.category}
            </span>
            <span className="font-mono text-[11px] leading-4 text-term-faint group-hover:text-term-muted">
              点击直达
            </span>
          </div>
        </a>
      ))}
    </div>
  )
}

export default function SiteNavigationPage() {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <TermPanel
        title="站点导航"
        bodyClassName="p-3"
      >
        <div className="flex flex-col gap-3">
          <p className="text-xs leading-5 text-term-muted">
            聚合主流跨境电商平台与运营入口，做成可视化书签卡片，方便团队一键直达高频站点。
          </p>
          <div className="grid w-full max-w-sm grid-cols-3 gap-2">
            {stats.map((item) => (
              <TermKpiTile key={item.label} label={item.label} value={item.value} />
            ))}
          </div>
        </div>
      </TermPanel>

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="font-mono text-xs font-semibold uppercase tracking-wider text-term-muted">
            平台 · 核心运营入口
          </h2>
          <span className="font-mono text-[11px] text-term-faint">{platformItems.length} 项</span>
        </div>
        <PlatformGrid items={platformItems} />
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="font-mono text-xs font-semibold uppercase tracking-wider text-term-muted">
            资讯论坛 · 行业信息与工具导航
          </h2>
          <span className="font-mono text-[11px] text-term-faint">{forumItems.length} 项</span>
        </div>
        <PlatformGrid items={forumItems} />
      </section>
    </div>
  )
}
