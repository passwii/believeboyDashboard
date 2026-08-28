import { cn } from '@/lib/utils'

// Terminal 收口（BLF-872）：零圆角；shimmer 底色走 term 令牌（见 globals.css u-skeleton-shimmer）
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('u-skeleton-shimmer rounded-none', className)} {...props} />
}

export { Skeleton }
