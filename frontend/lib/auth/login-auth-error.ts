import { CredentialsSignin } from 'next-auth'

import type { LoginPageErrorCode } from '@/lib/auth/login-error-code'

/**
 * 把「后端可以说明白的失败原因」带到登录页（BLF-1383）。
 *
 * Auth.js 只透传 `CredentialsSignin.code` 到客户端（放进跳转 URL 的 `code` 参数），
 * 因此这里只携带固定枚举，不携带 message / request_id / 账号是否存在之类的信息。
 * 需要展示 `request_id` 时走 `login-error-hint` 的短 TTL cookie。
 */
export class LoginFailureError extends CredentialsSignin {
  constructor(readonly loginCode: LoginPageErrorCode) {
    super()
    this.code = loginCode
  }
}
