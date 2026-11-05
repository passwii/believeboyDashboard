import { ArrowUpRight, Building2, Globe2, ShoppingBag, Tag } from 'lucide-react'

import styles from './site-navigation-warm.module.css'

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

function PlatformGrid({ items }: { items: Platform[] }) {
  return (
    <div className={styles.grid}>
      {items.map((platform) => (
        <a
          key={platform.name}
          href={platform.href}
          target="_blank"
          rel="noreferrer"
          className={styles.card}
        >
          <div className={styles.cardTop}>
            <div className={styles.cardCopy}>
              <h3 className={styles.cardTitle}>{platform.name}</h3>
              <p className={styles.meta}>
                <Building2 aria-hidden />
                {platform.region}
              </p>
            </div>
            <span className={styles.openMark}>
              <ArrowUpRight aria-hidden />
            </span>
          </div>
          <p className={styles.category}>{platform.category}</p>
          <div className={styles.cardFooter}>
            <span>{platform.category}</span>
            <span>点击直达</span>
          </div>
        </a>
      ))}
    </div>
  )
}

export default function SiteNavigationPage() {
  return (
    <main
      className={styles.page}
      data-testid="site-navigation-warm-page"
      data-warm-surface="warm-ledger"
    >
      <section className={styles.hero}>
        <div>
          <h2 className={styles.heroTitle}>站点导航</h2>
          <p className={styles.heroCopy}>
            聚合主流跨境电商平台与运营入口，做成可视化书签卡片，方便团队一键直达高频站点。
          </p>
        </div>
        <div className={styles.stats}>
          {stats.map((item) => {
            const Icon = item.icon
            return (
              <div key={item.label} className={styles.stat}>
                <span className={styles.statLabel}>
                  <Icon aria-hidden />
                  {item.label}
                </span>
                <span className={styles.statValue}>{item.value}</span>
              </div>
            )
          })}
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2>平台 · 核心运营入口</h2>
          <span>{platformItems.length} 项</span>
        </div>
        <PlatformGrid items={platformItems} />
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2>资讯论坛 · 行业信息与工具导航</h2>
          <span>{forumItems.length} 项</span>
        </div>
        <PlatformGrid items={forumItems} />
      </section>
    </main>
  )
}
