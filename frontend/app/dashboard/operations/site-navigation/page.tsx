import {
  ArrowUpRight,
  Building2,
  Globe2,
  ShoppingBag,
  Store,
  Tag,
} from 'lucide-react'

type Platform = {
  name: string
  href: string
  description: string
  region: string
  category: string
  tone: string
  group: 'platform' | 'forum'
}

const platforms: Platform[] = [
  {
    name: 'Amazon',
    href: 'https://www.amazon.com',
    description: '全球头部电商平台，覆盖北美、欧洲与日本等核心市场。',
    region: 'Global',
    category: 'Marketplace',
    tone: 'from-[#ff9900]/25 via-[#ffb84d]/10 to-transparent',
    group: 'platform',
  },
  {
    name: 'Walmart',
    href: 'https://www.walmart.com',
    description: '美国本土流量平台，适合品牌拓展与稳定订单增长。',
    region: 'United States',
    category: 'Marketplace',
    tone: 'from-[#0071ce]/25 via-[#4aa2ef]/10 to-transparent',
    group: 'platform',
  },
  {
    name: 'AMZ123',
    href: 'https://www.amz123.com',
    description: '亚马逊卖家资讯与工具导航站，快速获取实操资源。',
    region: 'China',
    category: 'Media & Tools',
    tone: 'from-[#22c55e]/20 via-[#86efac]/10 to-transparent',
    group: 'forum',
  },
  {
    name: 'SHEIN',
    href: 'https://us.shein.com',
    description: '快时尚跨境平台，节奏快、爆款驱动明显。',
    region: 'Global',
    category: 'Fashion',
    tone: 'from-[#111827]/25 via-[#6b7280]/10 to-transparent',
    group: 'platform',
  },
  {
    name: 'TEMU',
    href: 'https://www.temu.com',
    description: '高增长平台，强调供应链效率与价格竞争力。',
    region: 'Global',
    category: 'Marketplace',
    tone: 'from-[#f43f5e]/25 via-[#fb7185]/10 to-transparent',
    group: 'platform',
  },
  {
    name: 'Etsy',
    href: 'https://www.etsy.com',
    description: '手工和设计类目优势明显，品牌故事型产品更易沉淀。',
    region: 'Global',
    category: 'Niche',
    tone: 'from-[#f97316]/20 via-[#fdba74]/10 to-transparent',
    group: 'platform',
  },
  {
    name: 'TikTok Shop',
    href: 'https://www.tiktok.com/shop',
    description: '内容电商增长引擎，适合短视频与直播带货联动。',
    region: 'Global',
    category: 'Social Commerce',
    tone: 'from-[#0f172a]/25 via-[#334155]/10 to-transparent',
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
    <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-6">
      {items.map((platform, index) => (
        <a
          key={platform.name}
          href={platform.href}
          target="_blank"
          rel="noreferrer"
          className="group relative flex h-full flex-col overflow-hidden rounded-2xl border border-border/70 bg-card p-4 shadow-sm transition-all duration-300 ease-out hover:-translate-y-1 hover:border-primary/35 hover:shadow-xl hover:shadow-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2"
          style={{ animationDelay: `${index * 40}ms` }}
        >
          <div className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${platform.tone}`} />
          <div className="absolute -right-8 -top-8 h-24 w-24 rounded-full bg-white/20 blur-2xl dark:bg-white/5" />
          <div className="relative z-10 flex h-full flex-col space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold tracking-tight">{platform.name}</h2>
                <p className="mt-1 inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/70 px-2 py-0.5 text-[11px] text-muted-foreground">
                  <Building2 className="h-3 w-3" />
                  {platform.region}
                </p>
              </div>
              <div className="rounded-lg border border-border/70 bg-background/75 p-2 text-muted-foreground transition-colors group-hover:text-primary">
                <ArrowUpRight className="h-4 w-4" />
              </div>
            </div>

            <p className="min-h-12 flex-1 text-sm leading-6 text-muted-foreground">{platform.description}</p>

            <div className="mt-auto flex items-center justify-between border-t border-border/70 pt-3">
              <span className="inline-flex items-center rounded-full border border-border/70 px-2.5 py-1 text-xs text-foreground/85">
                {platform.category}
              </span>
              <span className="text-xs font-medium text-primary/80">点击直达</span>
            </div>
          </div>
        </a>
      ))}
    </div>
  )
}

export default function SiteNavigationPage() {
  return (
    <div className="space-y-6 md:space-y-7">
      <section className="dashboard-surface animate-enter px-5 py-5 md:px-7 md:py-7">
        <div className="relative z-10 flex flex-wrap items-start justify-between gap-5">
          <div className="max-w-2xl space-y-3">
            <p className="inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/10 px-3 py-1 text-xs font-semibold tracking-[0.14em] text-primary/90">
              <Store className="h-3.5 w-3.5" />
              运营导航 · 站点导航
            </p>
            <p className="text-sm leading-6 text-muted-foreground md:text-base">
              聚合主流跨境电商平台与运营入口，做成可视化书签卡片，方便团队一键直达高频站点。
            </p>
          </div>
          <div className="grid w-full max-w-sm grid-cols-3 gap-2.5">
            {stats.map((item) => (
              <div key={item.label} className="rounded-xl border border-border/70 bg-background/80 p-3 text-center">
                <item.icon className="mx-auto mb-1 h-4 w-4 text-primary/85" />
                <p className="text-base font-semibold leading-tight">{item.value}</p>
                <p className="text-[11px] text-muted-foreground">{item.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-end justify-between gap-3">
          <h2 className="text-lg font-semibold tracking-tight md:text-xl">平台</h2>
          <p className="text-xs text-muted-foreground md:text-sm">核心运营入口</p>
        </div>
        <PlatformGrid items={platformItems} />
      </section>

      <section className="space-y-3">
        <div className="flex items-end justify-between gap-3">
          <h2 className="text-lg font-semibold tracking-tight md:text-xl">资讯论坛</h2>
          <p className="text-xs text-muted-foreground md:text-sm">行业信息与工具导航</p>
        </div>
        <PlatformGrid items={forumItems} />
      </section>
    </div>
  )
}
