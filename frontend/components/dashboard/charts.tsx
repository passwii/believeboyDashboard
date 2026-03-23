'use client'

import * as React from 'react'
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const chartData = [
  { date: '2024-04-01', visitors: 400, pageViews: 800 },
  { date: '2024-04-02', visitors: 300, pageViews: 600 },
  { date: '2024-04-03', visitors: 200, pageViews: 400 },
  { date: '2024-04-04', visitors: 278, pageViews: 556 },
  { date: '2024-04-05', visitors: 189, pageViews: 378 },
  { date: '2024-04-06', visitors: 239, pageViews: 478 },
  { date: '2024-04-07', visitors: 349, pageViews: 698 },
  { date: '2024-04-08', visitors: 400, pageViews: 800 },
  { date: '2024-04-09', visitors: 430, pageViews: 860 },
  { date: '2024-04-10', visitors: 460, pageViews: 920 },
  { date: '2024-04-11', visitors: 380, pageViews: 760 },
  { date: '2024-04-12', visitors: 320, pageViews: 640 },
  { date: '2024-04-13', visitors: 280, pageViews: 560 },
  { date: '2024-04-14', visitors: 350, pageViews: 700 },
  { date: '2024-04-15', visitors: 420, pageViews: 840 },
  { date: '2024-04-16', visitors: 480, pageViews: 960 },
  { date: '2024-04-17', visitors: 510, pageViews: 1020 },
  { date: '2024-04-18', visitors: 490, pageViews: 980 },
  { date: '2024-04-19', visitors: 450, pageViews: 900 },
  { date: '2024-04-20', visitors: 520, pageViews: 1040 },
  { date: '2024-04-21', visitors: 580, pageViews: 1160 },
  { date: '2024-04-22', visitors: 620, pageViews: 1240 },
  { date: '2024-04-23', visitors: 590, pageViews: 1180 },
  { date: '2024-04-24', visitors: 550, pageViews: 1100 },
  { date: '2024-04-25', visitors: 600, pageViews: 1200 },
  { date: '2024-04-26', visitors: 650, pageViews: 1300 },
  { date: '2024-04-27', visitors: 700, pageViews: 1400 },
  { date: '2024-04-28', visitors: 680, pageViews: 1360 },
  { date: '2024-04-29', visitors: 720, pageViews: 1440 },
  { date: '2024-04-30', visitors: 750, pageViews: 1500 },
]

const chartConfig = {
  visitors: {
    label: 'Visitors',
    color: 'hsl(var(--primary))',
  },
  pageViews: {
    label: 'Page Views',
    color: 'hsl(var(--chart-2))',
  },
} satisfies ChartConfig

export function VisitorsChart() {
  const [timeRange, setTimeRange] = React.useState('30d')

  const filteredData = React.useMemo(() => {
    const daysToShow = timeRange === '7d' ? 7 : timeRange === '30d' ? 30 : 90
    return chartData.slice(-daysToShow)
  }, [timeRange])

  return (
    <Card className="col-span-1 lg:col-span-4 hover-lift animate-enter">
      <CardHeader className="relative z-10 flex flex-col gap-4 space-y-0 pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="grid flex-1 gap-1 text-center sm:text-left">
          <p className="dashboard-kicker">Sales Trajectory</p>
          <CardTitle className="text-lg sm:text-[1.25rem]">Daily Sales vs Last Period</CardTitle>
          <CardDescription className="text-xs sm:text-sm md:text-[15px]">
            把当前周期与对照周期放进同一条叙事曲线里，快速识别增长和异常回撤。
          </CardDescription>
        </div>
        <Select value={timeRange} onValueChange={setTimeRange}>
          <SelectTrigger
            className="h-10 w-full min-w-touch rounded-2xl border-0 bg-[hsl(var(--surface-low))] text-sm shadow-none sm:w-[170px]"
            aria-label="Select a time range"
          >
            <SelectValue placeholder="Last 30 days" />
          </SelectTrigger>
          <SelectContent className="rounded-xl">
            <SelectItem value="7d" className="rounded-lg">
              Last 7 days
            </SelectItem>
            <SelectItem value="30d" className="rounded-lg">
              Last 30 days
            </SelectItem>
            <SelectItem value="90d" className="rounded-lg">
              Last 3 months
            </SelectItem>
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent className="relative z-10 px-2 pt-2 sm:px-6 sm:pt-2">
        <div className="mb-5 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <div className="inline-flex items-center gap-2 rounded-full bg-primary/8 px-3 py-1.5 text-primary">
            <span className="h-2 w-2 rounded-full bg-primary" />
            Current: $1,240,492
          </div>
          <div className="inline-flex items-center gap-2 rounded-full bg-[hsl(var(--surface-low))] px-3 py-1.5">
            <span className="h-2 w-2 rounded-full bg-[hsl(var(--surface-outline))]" />
            Previous: $1,082,100
          </div>
          <div className="inline-flex items-center gap-2 rounded-full bg-secondary/10 px-3 py-1.5 font-semibold text-secondary">
            +14.6% Growth
          </div>
        </div>
        <ChartContainer
          config={chartConfig}
          className="aspect-auto h-[260px] w-full rounded-[1.4rem] bg-[hsl(var(--surface-low))] px-2 py-4 sm:h-[320px] sm:px-4"
        >
          <AreaChart accessibilityLayer data={filteredData}>
            <defs>
              <linearGradient id="fillVisitors" x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="5%"
                  stopColor="var(--color-visitors)"
                  stopOpacity={0.8}
                />
                <stop
                  offset="95%"
                  stopColor="var(--color-visitors)"
                  stopOpacity={0.1}
                />
              </linearGradient>
              <linearGradient id="fillPageViews" x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="5%"
                  stopColor="var(--color-pageViews)"
                  stopOpacity={0.8}
                />
                <stop
                  offset="95%"
                  stopColor="var(--color-pageViews)"
                  stopOpacity={0.1}
                />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="hsl(var(--border) / 0.22)" />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={32}
              tickFormatter={(value) => {
                const date = new Date(value)
                return date.toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                })
              }}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(value) => `${value}`}
            />
            <ChartTooltip
              cursor={false}
              content={
                <ChartTooltipContent
                  labelFormatter={(value) => {
                    return new Date(value).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                    })
                  }}
                  indicator="dot"
                />
              }
            />
            <Area
              dataKey="pageViews"
              type="natural"
              fill="url(#fillPageViews)"
              stroke="var(--color-pageViews)"
              strokeDasharray="5 5"
              strokeWidth={2}
            />
            <Area
              dataKey="visitors"
              type="natural"
              fill="url(#fillVisitors)"
              stroke="var(--color-visitors)"
              strokeWidth={3}
            />
            <ChartLegend content={<ChartLegendContent />} />
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}
