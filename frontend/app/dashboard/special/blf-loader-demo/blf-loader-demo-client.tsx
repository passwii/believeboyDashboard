'use client'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { BLFLoader } from '@/components/ui/loader-2'

/**
 * BLF 自定义 loader demo 页。
 *
 * 这是 BEL-146 验收入口：用户访问本页面可以看到 B/L/F 三段动画。
 * 本页面**不替换** GlobalLoadingOverlay 等全局 loading 组件，
 * 只是把 loader-2 组件挂在这里跑一下。
 */
export default function BLFLoaderDemoClient() {
  return (
    <div className="space-y-5">
      <Card className="dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]">
        <CardHeader>
          <CardTitle>BLF Loading 动画 demo</CardTitle>
          <CardDescription>
            BEL-146 自定义 loader — 三段动画时长一致、循环同步。
            切换右上角主题按钮可验证 dark mode 下 <code>--blf-clr</code> /
            <code> --blf-bkg</code> 自适应。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex min-h-[160px] items-center justify-center rounded-lg border border-dashed border-border/70 bg-muted/10 py-10">
            <BLFLoader />
          </div>
        </CardContent>
      </Card>

      <Card className="dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]">
        <CardHeader>
          <CardTitle>说明</CardTitle>
          <CardDescription>实现细节</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>三个字母均使用 SVG 描边 + stroke-dasharray / stroke-dashoffset 推进，节奏由 keyframes 驱动。</li>
            <li>三段动画时长统一 3s、linear、infinite，循环接缝无跳变。</li>
            <li>
              关键帧百分比：<code>0% / 25% / 50% / 75% / 100%</code>，B/L/F 的 dot
              translate 在每个阶段对齐 path 关键拐点。
            </li>
            <li>
              颜色变量：<code>--blf-clr</code>（描边 + dot）、<code>--blf-bkg</code>（占位背景），
              在 :root / .dark 下分别给出浅深两套值。
            </li>
            <li>
              已对 <code>prefers-reduced-motion</code> 做兼容：关掉 animation，path
              dashoffset 归零、dot 无 transform。
            </li>
            <li>
              全局 loading 组件（<code>GlobalLoadingOverlay</code>）未做任何改动，本页仅作
              demo。
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}