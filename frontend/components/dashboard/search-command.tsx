'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import {
  BarChart3,
  BookOpen,
  Bot,
  Calculator,
  ChevronRight,
  Coins,
  Database,
  FileBarChart,
  FileSearch,
  History,
  LayoutDashboard,
  Package,
  Repeat,
  Settings,
  ShieldUser,
  ShoppingCart,
  Store,
  TrendingUp,
  Upload,
  Users,
} from 'lucide-react'

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'

type SearchItem = {
  title: string
  url: string
  icon: React.ReactNode
  category: string
}

const navItems: SearchItem[] = [
  // 运营导航
  { title: '站点导航', url: '/dashboard/operations/site-navigation', icon: <LayoutDashboard className='h-4 w-4' />, category: '运营导航' },
  { title: '店铺导航', url: '/dashboard/operations/store-navigation', icon: <Store className='h-4 w-4' />, category: '运营导航' },
  // AI 面板
  { title: 'AI 聊天', url: '/dashboard/ai-panel/chat', icon: <Bot className='h-4 w-4' />, category: 'AI 面板' },
  { title: 'AI 洞察', url: '/dashboard/ai-insights', icon: <TrendingUp className='h-4 w-4' />, category: 'AI 面板' },
  // 运营核算
  { title: '财务月报', url: '/dashboard/data-reporting/monthly-report', icon: <FileBarChart className='h-4 w-4' />, category: '运营核算' },
  { title: '产品分析', url: '/dashboard/data-reporting/product-analysis', icon: <Calculator className='h-4 w-4' />, category: '运营核算' },
  { title: '新品核算', url: '/dashboard/data-reporting/pricing-calculation/new-product', icon: <Coins className='h-4 w-4' />, category: '运营核算' },
  { title: '店铺测算', url: '/dashboard/data-reporting/pricing-calculation/shop-calculation', icon: <Store className='h-4 w-4' />, category: '运营核算' },
  // 数据分析
  { title: '销售数据', url: '/dashboard/data-analysis/daily-analysis', icon: <TrendingUp className='h-4 w-4' />, category: '数据分析' },
  { title: '广告分析', url: '/dashboard/data-analysis/ad-analysis/overview', icon: <BarChart3 className='h-4 w-4' />, category: '数据分析' },
  { title: '月度财务分析', url: '/dashboard/data-analysis/financial-data', icon: <FileBarChart className='h-4 w-4' />, category: '数据分析' },
  { title: '按周产品分析', url: '/dashboard/data-analysis/weekly-product-analysis', icon: <BarChart3 className='h-4 w-4' />, category: '数据分析' },
  { title: '库存分析', url: '/dashboard/data-analysis/inventory-analysis', icon: <Package className='h-4 w-4' />, category: '数据分析' },
  { title: '补货分析', url: '/dashboard/data-analysis/inventory-replenishment', icon: <Repeat className='h-4 w-4' />, category: '数据分析' },
  { title: '退货分析', url: '/dashboard/data-analysis/return-analysis', icon: <History className='h-4 w-4' />, category: '数据分析' },
  { title: '项目目标', url: '/dashboard/data-analysis/project-goals', icon: <TrendingUp className='h-4 w-4' />, category: '数据分析' },
  // 工具集
  { title: '调研分析', url: '/dashboard/tools/research-analysis', icon: <FileSearch className='h-4 w-4' />, category: '工具集' },
  // 数字员工
  { title: '数字员工', url: '/dashboard/digital-employees', icon: <Users className='h-4 w-4' />, category: '数字员工' },
  // 数据管理
  { title: '广告管理', url: '/dashboard/data-management/ad-upload', icon: <Upload className='h-4 w-4' />, category: '数据管理' },
  { title: '发货管理', url: '/dashboard/data-management/shipment-management', icon: <Package className='h-4 w-4' />, category: '数据管理' },
  { title: 'SKU 信息', url: '/dashboard/data-management/sku-info', icon: <Database className='h-4 w-4' />, category: '数据管理' },
  { title: '汇率信息', url: '/dashboard/data-management/exchange-rate', icon: <Coins className='h-4 w-4' />, category: '数据管理' },
  { title: '报表自动化', url: '/dashboard/data-management/auto-upload', icon: <Upload className='h-4 w-4' />, category: '数据管理' },
  // 系统管理
  { title: '项目信息', url: '/dashboard/system-management/project-info', icon: <ShoppingCart className='h-4 w-4' />, category: '系统管理' },
  { title: '数据库状态', url: '/dashboard/system-management/data-management', icon: <Database className='h-4 w-4' />, category: '系统管理' },
  { title: '账号管理', url: '/dashboard/system-management/account-management', icon: <Settings className='h-4 w-4' />, category: '系统管理' },
  { title: '运营管理', url: '/dashboard/system-management/operator-management', icon: <ShieldUser className='h-4 w-4' />, category: '系统管理' },
  { title: '项目佣金', url: '/dashboard/system-management/commission-management', icon: <Coins className='h-4 w-4' />, category: '系统管理' },
  { title: '日志查看', url: '/dashboard/system-management/logs', icon: <History className='h-4 w-4' />, category: '系统管理' },
  // 工具入口
  { title: '更新日志', url: '/dashboard/changelog', icon: <BookOpen className='h-4 w-4' />, category: '支持入口' },
]

const CATEGORIES = ['运营导航', 'AI 面板', '运营核算', '数据分析', '工具集', '数字员工', '数据管理', '系统管理', '支持入口'] as const

export function SearchCommand() {
  const [open, setOpen] = React.useState(false)
  const router = useRouter()

  React.useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((open) => !open)
      }
    }

    document.addEventListener('keydown', down)
    return () => document.removeEventListener('keydown', down)
  }, [])

  const grouped = CATEGORIES.reduce<Record<string, SearchItem[]>>((acc, cat) => {
    const items = navItems.filter((item) => item.category === cat)
    if (items.length > 0) acc[cat] = items
    return acc
  }, {})

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder='搜索页面、工具与报表...' />
      <CommandList>
        <CommandEmpty>未找到相关结果</CommandEmpty>
        {Object.entries(grouped).map(([category, items]) => (
          <React.Fragment key={category}>
            <CommandGroup heading={category}>
              {items.map((item) => (
                <CommandItem
                  key={item.url}
                  value={item.title}
                  onSelect={() => {
                    router.push(item.url)
                    setOpen(false)
                  }}
                >
                  <span className='mr-2 text-muted-foreground'>{item.icon}</span>
                  <span className='flex-1'>{item.title}</span>
                  <ChevronRight className='h-3.5 w-3.5 text-muted-foreground/60' />
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </React.Fragment>
        ))}
      </CommandList>
    </CommandDialog>
  )
}
