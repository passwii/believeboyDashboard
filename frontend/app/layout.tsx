import type { Metadata } from 'next'
import { Manrope, Space_Grotesk } from 'next/font/google'
import './globals.css'
import { GlobalLoadingProvider } from '@/components/global-loading-provider'
import { GlobalLoadingOverlay } from '@/components/global-loading-overlay'
import { ThemeProvider } from '@/components/theme-provider'
import { AuthSessionProvider } from '@/components/auth/session-provider'

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
    <html lang="en" suppressHydrationWarning>
      <body className={`${manrope.variable} ${spaceGrotesk.variable} min-h-screen antialiased`}>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <AuthSessionProvider>
            <GlobalLoadingProvider>
              {children}
              <GlobalLoadingOverlay />
            </GlobalLoadingProvider>
          </AuthSessionProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
