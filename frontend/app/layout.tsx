import type { Metadata } from 'next'
import { Analytics } from '@vercel/analytics/next'
import { SpeedInsights } from '@vercel/speed-insights/next'
import { JetBrains_Mono, Manrope, Space_Grotesk } from 'next/font/google'
import './globals.css'
import { GlobalLoadingProvider } from '@/components/global-loading-provider'
import { GlobalLoadingOverlay } from '@/components/global-loading-overlay'
import { NotificationWrapper } from '@/components/system/notification-wrapper'
import { ThemeProvider } from '@/components/theme-provider'
import { AuthSessionProvider } from '@/components/auth/session-provider'
import { SkipLink } from '@/components/ui/skip-link'

const manrope = Manrope({
  subsets: ['latin'],
  variable: '--font-sans',
  weight: ['400', '500', '600', '700'],
  display: 'swap',
})

const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-display',
  weight: ['500', '700'],
  display: 'swap',
  adjustFontFallback: false,
})

/* Terminal 等宽数字字体（BLF-809）：金额/订单号/时间戳一律 font-mono */
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  weight: ['400', '500', '600'],
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
        </ThemeProvider>
      </body>
    </html>
  )
}
