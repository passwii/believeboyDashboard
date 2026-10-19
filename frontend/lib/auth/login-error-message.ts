import type { ResolvedLoginPageErrorCode } from '@/lib/auth/login-error-code'
import { formatRequestId, type LoginErrorHint } from '@/lib/auth/login-error-hint'

/**
 * 登录失败文案（BLF-1383）。
 *
 * 纯函数：输入页面 code + 排查线索（短 TTL cookie 里带回来的 request_id /
 * retry_after_seconds），输出可直接渲染的一行文案。文案不参与任何分支判断，
 * 判断一律看 code。
 */

export type LoginErrorMessageInput = {
  code: ResolvedLoginPageErrorCode
  hint?: LoginErrorHint | null
  /** 限流倒计时剩余秒数（页面每秒刷新）；为空时退化成静态文案。 */
  rateLimitRemainingSeconds?: number | null
}

const NETWORK_MESSAGE = '无法连接到服务器，请检查后端服务是否启动。'

function diagnosticSuffix(hint: LoginErrorHint | null | undefined, { withCode }: { withCode: boolean }): string {
  if (!hint) return ''
  const parts: string[] = []
  if (withCode && hint.backendCode) parts.push(`错误码 ${hint.backendCode}`)
  const requestId = formatRequestId(hint.requestId)
  if (requestId) parts.push(`请求 ID ${requestId}`)
  return parts.length ? `（${parts.join(' · ')}）` : ''
}

export function buildLoginErrorMessage({
  code,
  hint,
  rateLimitRemainingSeconds,
}: LoginErrorMessageInput): string {
  switch (code) {
    case 'invalid_credentials':
      return '邮箱或密码错误，请检查大小写与键盘输入法后重试。'
    case 'account_disabled':
      // 停用时把请求 ID 一并给出，便于管理员在日志 / 审计里定位是哪次登录被拦。
      return `账号已停用，请联系管理员。${diagnosticSuffix(hint, { withCode: false })}`
    case 'rate_limited': {
      const remaining = rateLimitRemainingSeconds
      if (typeof remaining === 'number' && remaining > 0) {
        return `登录失败次数过多，请 ${remaining} 秒后重试。`
      }
      return '登录失败次数过多，请稍后重试。'
    }
    case 'internal_error':
      return `登录服务内部错误，请稍后重试。${diagnosticSuffix(hint, { withCode: true })}`
    case 'invalid_client_id':
      return `客户端标识格式非法，请检查设备配置后重试。${diagnosticSuffix(hint, { withCode: true })}`
    case 'network_error':
      return NETWORK_MESSAGE
    case 'generic_credentials':
      return '邮箱或密码错误，或账号已停用。'
    default:
      // 未知 code（例如后端新增了前端还没适配的失败原因）：不归因为密码错误。
      return `登录未成功，请稍后重试；若持续出现，请联系管理员。${diagnosticSuffix(hint, { withCode: true })}`
  }
}
