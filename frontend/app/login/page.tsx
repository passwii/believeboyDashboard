'use client'

import { FormEvent, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { signIn } from 'next-auth/react'
import { Loader2, ShieldCheck } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export default function LoginPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const callbackUrl = useMemo(() => searchParams.get('callbackUrl') || '/dashboard', [searchParams])

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitting(true)
    setError(null)

    const result = await signIn('credentials', {
      email,
      password,
      callbackUrl,
      redirect: false,
    })

    setSubmitting(false)

    if (!result || result.error) {
      setError('邮箱或密码错误，或账号已停用。')
      return
    }

    router.push(result.url || callbackUrl)
    router.refresh()
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_20%_10%,rgba(34,197,94,0.2),transparent_40%),radial-gradient(circle_at_80%_80%,rgba(14,165,233,0.18),transparent_40%),linear-gradient(180deg,hsl(var(--background))_0%,hsl(var(--background))_100%)] p-6">
      <Card className="w-full max-w-md border-border/70 shadow-[0_24px_80px_-28px_rgba(15,23,42,0.45)]">
        <CardHeader className="space-y-3">
          <div className="inline-flex w-fit items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
            <ShieldCheck className="h-3.5 w-3.5" />
            BelieveBoy Dashboard
          </div>
          <CardTitle>账号登录</CardTitle>
          <CardDescription>登录后才能访问仪表盘；管理员可进入系统管理。</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={onSubmit}>
            <div className="space-y-2">
              <Label htmlFor="email">邮箱</Label>
              <Input
                id="email"
                type="email"
                placeholder="name@believeboy.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">密码</Label>
              <Input
                id="password"
                type="password"
                placeholder="请输入密码"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </div>
            {error ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            ) : null}
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {submitting ? '登录中...' : '登录'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
