import { AD_ANALYSIS_TABS } from '@/components/dashboard/ad-analysis/config'
import { AdAnalysisPageShell } from '@/components/dashboard/ad-analysis/page-shell'

export default function AdAnalysisBudgetPage() {
  return <AdAnalysisPageShell tab={AD_ANALYSIS_TABS[6]} />
}
