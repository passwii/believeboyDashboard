import type { Metadata } from 'next'

import CrossBorderComplianceClient from './cross-border-compliance-client'

export const metadata: Metadata = {
  title: '跨境电商合规',
  description:
    '根据用户提供的课件整理：出口业务证据链、监管模式对照、企业准入办理、9810 首单核查材料自查与报关字段速查。',
}

export default function CrossBorderCompliancePage() {
  return <CrossBorderComplianceClient />
}
