export const metadata = {
  title: '公开页面 | believeboy Dashboard',
}

export default function PublicPageLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[hsl(var(--surface-low))]">
      <header className="border-b border-border/60 bg-background px-6 py-3">
        <div className="mx-auto flex max-w-5xl items-center justify-between">
          <span className="text-sm font-semibold text-foreground">believeboy Dashboard</span>
          <span className="text-xs text-muted-foreground">公开页面</span>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl px-4 py-6">{children}</main>
      <footer className="border-t border-border/60 px-6 py-4 text-center text-xs text-muted-foreground">
        由 believeboy Dashboard 生成
      </footer>
    </div>
  )
}
