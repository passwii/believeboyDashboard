import { CredentialsSignin } from 'next-auth'

export class NetworkAuthError extends CredentialsSignin {
  code = 'network_error'

  constructor() {
    super('网络连接失败，请检查网络后重试')
  }
}
