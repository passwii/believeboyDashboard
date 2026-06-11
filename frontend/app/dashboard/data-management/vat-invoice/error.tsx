"use client"

import { useEffect } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { AlertTriangle, RefreshCw } from "lucide-react"

export default function VatInvoiceError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("[VAT Invoice] page error:", error)
  }, [error])

  return (
    <div className="space-y-4 px-1 py-1">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          VAT 发票生成器
        </h1>
      </div>
      <Card className="dashboard-surface">
        <CardContent className="flex flex-col items-center justify-center gap-4 py-12">
          <AlertTriangle className="h-10 w-10 text-amber-500" />
          <div className="text-center space-y-1">
            <p className="text-sm font-medium text-foreground">
              页面加载异常
            </p>
            <p className="text-sm text-muted-foreground">
              VAT 发票页面遇到问题，请尝试刷新页面。如果问题持续存在，请联系管理员。
            </p>
          </div>
          <Button onClick={reset} variant="outline" size="sm">
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            重新加载
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
