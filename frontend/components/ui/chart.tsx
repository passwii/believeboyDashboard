'use client'

// 原 shadcn 风格的 chart 容器。
// 项目里大部分页面（dashboard / data-analysis / financial-data / portfolio /
// ai-insights / ad-analysis）都引用这里的 ChartContainer / ChartTooltipContent。
// 与 `line-charts-6.tsx` 并存：后者是 Tailwind 4 上游版本的 Tailwind 3 适配版，
// 用于新的"单 line + 顶部 metric 切换"型卡片场景（如 demo.tsx）。
// 新代码优先用 line-charts-6，存量代码继续用本文件，逐步迁移。

import * as React from 'react'
import * as RechartsPrimitive from 'recharts'

import { cn } from '@/lib/utils'

// Format: { THEME_NAME: CSS_SELECTOR }
const THEMES = { light: '', dark: '.dark' } as const

export type ChartConfig = {
  [k in string]: {
    label?: React.ReactNode
    icon?: React.ComponentType
  } & (
    | { color?: string; theme?: never }
    | { color?: never; theme: Record<keyof typeof THEMES, string> }
  )
}

type ChartContextProps = {
  config: ChartConfig
}

const ChartContext = React.createContext<ChartContextProps | null>(null)

function useChart() {
  const context = React.useContext(ChartContext)

  if (!context) {
    throw new Error('useChart must be used within a <ChartContainer />')
  }

  return context
}

const ChartContainer = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<'div'> & {
    config: ChartConfig
    children: React.ReactNode
  }
>(({ id, className, children, config, ...props }, ref) => {
  const uniqueId = React.useId()
  const chartId = `chart-${id || uniqueId.replace(/:/g, '')}`
  const chartChild = React.Children.only(children) as React.ReactElement

  return (
    <ChartContext.Provider value={{ config }}>
      <div
        data-chart={chartId}
        ref={ref}
        className={cn(
          "flex aspect-video justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-[var(--term-muted)] [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-[var(--term-border)] [&_.recharts-curve.recharts-tooltip-cursor]:stroke-[var(--term-border-strong)] [&_.recharts-dot[stroke='#fff']]:stroke-transparent [&_.recharts-layer]:outline-none [&_.recharts-polar-grid_[stroke='#ccc']]:stroke-[var(--term-border)] [&_.recharts-radial-bar-background-sector]:fill-[var(--term-raised)] [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-[var(--term-hover)] [&_.recharts-reference-line_[stroke='#ccc']]:stroke-[var(--term-border)] [&_.recharts-sector[stroke='#fff']]:stroke-transparent [&_.recharts-sector]:outline-none [&_.recharts-surface]:outline-none dark:[&_.recharts-cartesian-axis-tick_text]:fill-[var(--term-muted)] dark:[&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-[var(--term-border)] dark:[&_.recharts-reference-line_[stroke='#ccc']]:stroke-[var(--term-border)]",
          className
        )}
        {...props}
      >
        <ChartStyle id={chartId} config={config} />
        <RechartsPrimitive.ResponsiveContainer>{chartChild}</RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  )
})
ChartContainer.displayName = 'Chart'

/**
 * 把 config 里声明的颜色规范成可被 SVG fill/stroke 属性直接消费的色值。
 *
 * 背景：`--chart-N` 在 globals.css 里是裸 HSL 三元组（如 `221 83% 53%`），
 * 设计给 `hsl(var(--chart-N))` 包一层用。但本文件注入的 `--color-<key>` 会被
 * `cards.tsx` 等直接放进 `fill="var(--color-<key>)"` —— SVG presentation
 * attribute 遇到裸三元组是非法颜色，浏览器回退纯黑（BLF-976）。
 * 因此这里统一保证注入值是完整色值：裸三元组包 hsl()，其余原样透传
 * （完整 hsl()/hex/var(--term-*) 等已是合法 CSS 色值）。
 */
function normalizeConfigColor(color: string): string {
  const trimmed = color.trim()
  // 裸 HSL 三元组：三个 0-360/0-100%/0-100% 数值段，无色值函数前缀
  if (/^-?\d+(\.\d+)?\s+[\d.]+%\s+[\d.]+%$/.test(trimmed)) {
    return `hsl(${trimmed})`
  }
  return trimmed
}

const ChartStyle = ({ id, config }: { id: string; config: ChartConfig }) => {
  const colorConfig = Object.entries(config).filter(([, config]) => config.theme || config.color)

  if (!colorConfig.length) {
    return null
  }

  return (
    <style
      dangerouslySetInnerHTML={{
        __html: Object.entries(THEMES)
          .map(
            ([theme, prefix]) => `
${prefix} [data-chart=${id}] {
${colorConfig
  .map(([key, itemConfig]) => {
    const color = itemConfig.theme?.[theme as keyof typeof itemConfig.theme] || itemConfig.color
    return color ? `  --color-${key}: ${normalizeConfigColor(color)};` : null
  })
  .join('\n')}
}
`
          )
          .join('\n'),
      }}
    />
  )
}

const ChartTooltip = RechartsPrimitive.Tooltip

const ChartTooltipContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<typeof RechartsPrimitive.Tooltip> &
    React.ComponentProps<'div'> & {
      hideLabel?: boolean
      hideIndicator?: boolean
      indicator?: 'line' | 'dot' | 'dashed'
      nameKey?: string
      labelKey?: string
    }
>(
  (
    {
      active,
      payload,
      className,
      indicator = 'dot',
      hideLabel = false,
      hideIndicator = false,
      label,
      labelFormatter,
      labelClassName,
      formatter,
      color,
      nameKey,
      labelKey,
    },
    ref
  ) => {
    const { config } = useChart()

    const tooltipLabel = React.useMemo(() => {
      if (hideLabel || !payload?.length) {
        return null
      }

      const [item] = payload
      const key = `${labelKey || item?.dataKey || item?.name || 'value'}`
      const itemConfig = getPayloadConfigFromPayload(config, item, key)
      const value =
        !labelKey && typeof label === 'string'
          ? config[label as keyof typeof config]?.label || label
          : itemConfig?.label

      if (labelFormatter) {
        return (
          <div className={cn('font-medium', labelClassName)}>{labelFormatter(value, payload)}</div>
        )
      }

      if (!value) {
        return null
      }

      return <div className={cn('font-medium', labelClassName)}>{value}</div>
    }, [label, labelFormatter, payload, hideLabel, labelClassName, config, labelKey])

    if (!active || !payload?.length) {
      return null
    }

    const nestLabel = payload.length === 1 && indicator !== 'dot'

    return (
      <div
        ref={ref}
        className={cn(
          'min-w-[8rem] grid items-start gap-1.5 rounded-none border border-term-border bg-term-panel px-2.5 py-1.5 font-mono text-xs leading-5 text-term-text shadow-none',
          className
        )}
      >
        {!nestLabel ? tooltipLabel : null}
        <div className="grid gap-1.5">
          {payload
            .filter((item) => item.type !== 'none')
            .map((item, index) => {
              const key = `${nameKey || item.name || item.dataKey || 'value'}`
              const itemConfig = getPayloadConfigFromPayload(config, item, key)
              const indicatorColor = color || item.payload.fill || item.color

              const itemValue = item.value !== undefined && item.value !== null ? item.value : null

              return (
                <div
                  key={`${item.dataKey ?? item.name ?? 'value'}-${index}`}
                  className={cn(
                    'flex w-full flex-wrap items-stretch gap-2 [&>svg]:h-2.5 [&>svg]:w-2.5 [&>svg]:text-muted-foreground',
                    indicator === 'dot' && 'items-center'
                  )}
                >
                  {formatter && item?.value !== undefined && item.name ? (
                    formatter(item.value, item.name, item, index, item.payload)
                  ) : (
                    <>
                      {itemConfig?.icon ? (
                        <itemConfig.icon />
                      ) : (
                        !hideIndicator && (
                          <div
                            className={cn(
                              'shrink-0 rounded-[2px] border-[--color-border] bg-[--color-bg]',
                              {
                                'h-2.5 w-2.5': indicator === 'dot',
                                'w-1': indicator === 'line',
                                'w-0 border-[1.5px] border-dashed bg-transparent':
                                  indicator === 'dashed',
                                'my-0.5': nestLabel && indicator === 'dashed',
                              }
                            )}
                            style={
                              {
                                '--color-bg': indicatorColor,
                                '--color-border': indicatorColor,
                              } as React.CSSProperties
                            }
                          />
                        )
                      )}
                      <div
                        className={cn(
                          'flex flex-1 justify-between leading-none',
                          nestLabel ? 'items-end' : 'items-center'
                        )}
                      >
                        <div className="grid gap-1.5">
                          {nestLabel ? tooltipLabel : null}
                          <span className="text-muted-foreground">
                            {itemConfig?.label || item.name}
                          </span>
                        </div>
                        {itemValue !== null && (
                          <span className="font-mono font-medium tabular-nums text-foreground">
                            {typeof itemValue === 'number'
                              ? itemValue.toLocaleString()
                              : String(itemValue)}
                          </span>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )
            })}
        </div>
      </div>
    )
  }
)
ChartTooltipContent.displayName = 'ChartTooltip'

const ChartLegend = RechartsPrimitive.Legend

const ChartLegendContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<'div'> &
    Pick<RechartsPrimitive.LegendProps, 'payload' | 'verticalAlign'> & {
      hideIcon?: boolean
      nameKey?: string
    }
>(({ className, hideIcon = false, payload, verticalAlign = 'bottom', nameKey }, ref) => {
  const { config } = useChart()

  if (!payload?.length) {
    return null
  }

  return (
    <div
      ref={ref}
      className={cn(
        'flex items-center justify-center gap-4',
        verticalAlign === 'top' ? 'pb-3' : 'pt-3',
        className
      )}
    >
      {payload
        .filter((item) => item.type !== 'none')
        .map((item) => {
          const key = `${nameKey || item.dataKey || 'value'}`
          const itemConfig = getPayloadConfigFromPayload(config, item, key)

          return (
            <div
              key={item.value}
              className={cn(
                'flex items-center gap-1.5 [&>svg]:h-3 [&>svg]:w-3 [&>svg]:text-muted-foreground'
              )}
            >
              {itemConfig?.icon && !hideIcon ? (
                <itemConfig.icon />
              ) : (
                <div
                  className="h-2 w-2 shrink-0 rounded-[2px]"
                  style={{
                    backgroundColor: item.color,
                  }}
                />
              )}
              {itemConfig?.label}
            </div>
          )
        })}
    </div>
  )
})
ChartLegendContent.displayName = 'ChartLegend'

// Helper to extract item config from a payload.
function getPayloadConfigFromPayload(config: ChartConfig, payload: unknown, key: string) {
  if (typeof payload !== 'object' || payload === null) {
    return undefined
  }

  const payloadPayload =
    'payload' in payload && typeof payload.payload === 'object' && payload.payload !== null
      ? payload.payload
      : undefined

  let configLabelKey: string = key

  if (key in payload && typeof payload[key as keyof typeof payload] === 'string') {
    configLabelKey = payload[key as keyof typeof payload] as string
  } else if (
    payloadPayload &&
    key in payloadPayload &&
    typeof payloadPayload[key as keyof typeof payloadPayload] === 'string'
  ) {
    configLabelKey = payloadPayload[key as keyof typeof payloadPayload] as string
  }

  return configLabelKey in config ? config[configLabelKey] : config[key as keyof typeof config]
}

export {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  ChartStyle,
}
