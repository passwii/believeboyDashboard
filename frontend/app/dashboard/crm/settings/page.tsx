import { CrmRulesPanel } from '@/components/crm/crm-rules-panel'

/**
 * CRM 设置页（P9-7，BLF-545）。
 *
 * 目前承载规则引擎（可视化「当 X 发生，做 Y」编辑器）；其余设置（自定义字段、
 * 阶段、来源等）随 V2 逐步开放。权限由后端 require_admin 兜底（见 CrmRulesPanel）。
 */
export default function SettingsPage() {
  return (
    <div className="p-4 md:p-6">
      <CrmRulesPanel />
    </div>
  )
}
