import type { Metadata } from 'next'
import { Analytics } from '@vercel/analytics/next'
import { SpeedInsights } from '@vercel/speed-insights/next'
import { Manrope, Space_Grotesk } from 'next/font/google'
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
})

const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-display',
})

export const metadata: Metadata = {
  title: 'BelieveBoy Dashboard',
  description: 'A modern dashboard built with Next.js and shadcn/ui',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" data-scroll-behavior="smooth" suppressHydrationWarning>
      <body className={`${manrope.variable} ${spaceGrotesk.variable} min-h-screen antialiased`}>
        <SkipLink href="#main-content">Skip to main content</SkipLink>
        <SkipLink href="#main-navigation">Skip to navigation</SkipLink>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
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
