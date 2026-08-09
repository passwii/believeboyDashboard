/** P9 工作流自动化设置（BLF-540）：7 天无跟进提醒邮件阈值/开关。 */

export interface WorkflowSettings {
  /** 无跟进提醒阈值天数（1-365，默认 7）。 */
  staleDays: number
  /** 提醒邮件总开关。 */
  staleEmailEnabled: boolean
}

export type WorkflowSettingsInput = Partial<WorkflowSettings>
