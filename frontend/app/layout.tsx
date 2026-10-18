import type { Metadata } from 'next'
import { Analytics } from '@vercel/analytics/next'
import { SpeedInsights } from '@vercel/speed-insights/next'
import localFont from 'next/font/local'
import './globals.css'
import { GlobalLoadingProvider } from '@/components/global-loading-provider'
import { GlobalLoadingOverlay } from '@/components/global-loading-overlay'
import { NotificationWrapper } from '@/components/system/notification-wrapper'
import { MotionConfigProvider } from '@/components/system/motion-config-provider'
import { ThemeProvider } from '@/components/theme-provider'
import { AuthSessionProvider } from '@/components/auth/session-provider'
import { SkipLink } from '@/components/ui/skip-link'

/* 字体改为**自托管**（frontend/app/fonts/*.woff2，latin 子集）。
 *
 * 为什么不用 next/font/google：Vercel 构建时 Google Fonts 对这三个字体会返回多个
 * @font-face（unicode-range 子集，实测 3~6 个），而 Turbopack 的字体管线要求
 * "next/font/google queries have exactly one entry"，多子集就直接 FAIL：
 *   Module not found: Can't resolve '@vercel/turbopack-next/internal/font/google/font'
 * 该失败是确定性的（重试仍挂），且与业务代码无关（main 分支同样挂）。
 * 自托管后构建期不再访问 fonts.googleapis.com / fonts.gstatic.com。
 *
 * 变量名（--font-sans / --font-display / --font-mono）与字重保持不变，
 * 因此 globals.css 与 tailwind.config 无需调整。 */
const manrope = localFont({
  src: [
    { path: './fonts/manrope-400.woff2', weight: '400', style: 'normal' },
    { path: './fonts/manrope-500.woff2', weight: '500', style: 'normal' },
    { path: './fonts/manrope-600.woff2', weight: '600', style: 'normal' },
    { path: './fonts/manrope-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-sans',
  display: 'swap',
})

const spaceGrotesk = localFont({
  src: [
    { path: './fonts/space-grotesk-500.woff2', weight: '500', style: 'normal' },
    { path: './fonts/space-grotesk-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-display',
  display: 'swap',
})

/* Terminal 等宽数字字体（BLF-809）：金额/订单号/时间戳一律 font-mono */
const jetbrainsMono = localFont({
  src: [
    { path: './fonts/jetbrains-mono-400.woff2', weight: '400', style: 'normal' },
    { path: './fonts/jetbrains-mono-500.woff2', weight: '500', style: 'normal' },
    { path: './fonts/jetbrains-mono-600.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-mono',
  display: 'swap',
})

export const metadata: Metadata = {
  description: 'A modern dashboard built with Next.js and shadcn/ui',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-scroll-behavior="smooth" suppressHydrationWarning>
      <body
        className={`${manrope.variable} ${spaceGrotesk.variable} ${jetbrainsMono.variable} min-h-screen antialiased`}
      >
        <SkipLink href="#main-content">Skip to main content</SkipLink>
        <SkipLink href="#main-navigation">Skip to navigation</SkipLink>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
        >
          {/* BLF-1361：全局 framer-motion reduced-motion 退化。必须在 NotificationWrapper
           * 外层——toast 容器是 ssr:false 懒挂载 + createPortal，context 穿过 portal 生效。 */}
          <MotionConfigProvider>
            <AuthSessionProvider>
              <GlobalLoadingProvider>
                <NotificationWrapper>
                  {children}
                  <GlobalLoadingOverlay />
                  <Analytics />
                  <SpeedInsights />
                </NotificationWrapper>
              </GlobalLoadingProvider>
            </AuthSessionProvider>
          </MotionConfigProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
