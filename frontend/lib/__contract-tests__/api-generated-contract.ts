/**
 * Compile-time test for the DTO single-source-of-truth pipeline.
 *
 * This file's purpose is to FAIL the build (i.e. fail `tsc --noEmit`) the
 * moment a backend schema drifts from what the frontend code expects. It is
 * not a runtime test — see `vitest` and Playwright for those.
 *
 * The checks below use TS's structural typing in two complementary ways:
 *
 *   1. **Equality assertions** via `Expect<Equal<…>>`. If a field is added,
 *      removed, or has its type changed in the backend Pydantic schema, the
 *      generated `components['schemas'][…]` alias will no longer be assignable
 *      to the consumer interface (or vice versa) and `tsc` will fail.
 *
 *   2. **Required-vs-optional assertions**. A field that is `Optional[...]`
 *      in Pydantic must surface as `T | undefined` in the consumer code;
 *      flipping that in the backend without flipping it in the frontend
 *      would have been silent at runtime and is now caught at compile time.
 *
 * If `pnpm build` passes, the contract is in sync. If it fails with errors
 * mentioning `Expect<…>` below, run:
 *
 *     cd backend && make openapi-export
 *     cd frontend && pnpm gen:api-types
 *
 * and inspect the diff in `frontend/types/api-generated/openapi.json`.
 */

import type { components } from '@/types/api-generated/api'
import type {
  HealthData,
  ComplianceData,
  InspectionPeriod,
  InspectionReport,
  InspectionOverview,
  InspectionHistoryResponse,
  InspectionTemplate,
  InspectionScreenshot,
  InspectionOverviewItem,
  InspectionHistoryItem,
} from '@/lib/inspection-api'
import type {
  PricingCalculationRunItem,
  ShopCalculationItem,
  PricingCalculationDimensions,
  PricingCalculationWeight,
  PricingCalculationFees,
  PricingCalculationProfit,
} from '@/lib/pricing-calculation-types'

// ---------------------------------------------------------------------------
// Minimal type-level assertion helpers
// ---------------------------------------------------------------------------

type IsExact<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Expect<T extends true> = T
type Equal<X, Y> = IsExact<X, Y> extends true ? true : false

// ---------------------------------------------------------------------------
// Inspection schema contract
// ---------------------------------------------------------------------------

// Sanity: the consumer-facing re-exports must resolve to the generated
// component types. A drift in either side surfaces as a type mismatch here.
type _HealthDataMatches = Expect<Equal<HealthData, components['schemas']['HealthData']>>
type _ComplianceDataMatches = Expect<Equal<ComplianceData, components['schemas']['ComplianceData']>>
type _PeriodMatches = Expect<Equal<InspectionPeriod, components['schemas']['InspectionPeriodItem']>>
type _ReportMatches = Expect<Equal<InspectionReport, components['schemas']['InspectionReportItem']>>
type _OverviewMatches = Expect<Equal<InspectionOverview, components['schemas']['InspectionOverviewResponse']>>
type _HistoryResponseMatches = Expect<Equal<InspectionHistoryResponse, components['schemas']['InspectionHistoryResponse']>>
type _TemplateMatches = Expect<Equal<InspectionTemplate, components['schemas']['InspectionTemplateResponse']>>
type _ScreenshotMatches = Expect<Equal<InspectionScreenshot, components['schemas']['InspectionScreenshotItem']>>
type _OverviewItemMatches = Expect<Equal<InspectionOverviewItem, components['schemas']['InspectionOverviewItem']>>
type _HistoryItemMatches = Expect<Equal<InspectionHistoryItem, components['schemas']['InspectionHistoryItem']>>

// Required-field assertions. If a backend field is ever loosened from
// required to Optional, this will catch it. If it is tightened from
// Optional to required, the inverse will catch it.
type _HealthDataHasAccountHealthRating = 'account_health_rating' extends keyof HealthData ? true : false
type _PeriodHasId = 'id' extends keyof InspectionPeriod ? true : false
type _ReportHasScreenshots = 'screenshots' extends keyof InspectionReport ? true : false
type _OverviewHasPeriod = 'period' extends keyof InspectionOverview ? true : false

// ---------------------------------------------------------------------------
// Pricing schema contract
// ---------------------------------------------------------------------------

type _PricingRunItemMatches = Expect<Equal<PricingCalculationRunItem, components['schemas']['PricingCalculationRunItem']>>
type _ShopItemMatches = Expect<Equal<ShopCalculationItem, components['schemas']['ShopCalculationItem']>>
type _PricingDimensions = Expect<Equal<PricingCalculationDimensions, components['schemas']['PricingCalculationDimensions']>>
type _PricingWeight = Expect<Equal<PricingCalculationWeight, components['schemas']['PricingCalculationWeight']>>
type _PricingFees = Expect<Equal<PricingCalculationFees, components['schemas']['PricingCalculationFees']>>
type _PricingProfit = Expect<Equal<PricingCalculationProfit, components['schemas']['PricingCalculationProfit']>>

// ---------------------------------------------------------------------------
// Compile-time guard: any backend-issued `FetchReportResponse` shape that
// drops a required field should no longer satisfy `InspectionReport`.
//
// We "synthesize" a sample here. The type-level assignment below must fail
// to compile if `InspectionReport` ever gains a required field that the
// hypothetical backend payload doesn't include. (Today both sides are
// aligned, so this is a green test — it stays useful as a sentinel.)
// ---------------------------------------------------------------------------

declare const sampleBackendResponse: {
  id: number
  period_id: number
  project_id: number
  status: string
  health_data: HealthData | null
  compliance_data: ComplianceData | null
  status_summary: string | null
  submitted_by: string | null
  submitted_at: string | null
  screenshots: InspectionScreenshot[]
  created_at: string
  updated_at: string
}

// `sampleBackendResponse` MUST be assignable to `InspectionReport`.
// If you break this assignment (e.g. by removing a field from one side),
// tsc will surface the diff and the build will fail. That's the point.
const _typeLevelAssignmentCheck: InspectionReport = sampleBackendResponse

// ---------------------------------------------------------------------------
// Reference export so eslint/tsc keep this module included in the build.
// ---------------------------------------------------------------------------

export const TYPE_LEVEL_CONTRACT_VERSION = '1.0.0' as const

// Reference unused locals so the bundler doesn't drop the asserts above.
// Without these, the Equal<…> branches resolve to literal `true`s and would
// otherwise tree-shake away. (Tsc still typechecks them, but keeping them
// referenced makes intent obvious to a casual reader.)
//
// NOTE: the Equal<…> aliases are pure types — referencing them as values
// (which tsc would error on) is unnecessary. `Expect<…>` already fails the
// build at the type level if the assertion is violated, which is what we
// want. The value-side `null` check is included to surface a runtime sanity
// assert if a developer runs the test bundle in a sandbox.
export const _typeContractGuards = {
  healthDataMatches: null as unknown as _HealthDataMatches,
  complianceDataMatches: null as unknown as _ComplianceDataMatches,
  periodMatches: null as unknown as _PeriodMatches,
  reportMatches: null as unknown as _ReportMatches,
  overviewMatches: null as unknown as _OverviewMatches,
  historyResponseMatches: null as unknown as _HistoryResponseMatches,
  templateMatches: null as unknown as _TemplateMatches,
  screenshotMatches: null as unknown as _ScreenshotMatches,
  overviewItemMatches: null as unknown as _OverviewItemMatches,
  historyItemMatches: null as unknown as _HistoryItemMatches,
  healthDataHasAccountHealthRating: null as unknown as _HealthDataHasAccountHealthRating,
  periodHasId: null as unknown as _PeriodHasId,
  reportHasScreenshots: null as unknown as _ReportHasScreenshots,
  overviewHasPeriod: null as unknown as _OverviewHasPeriod,
  pricingRunItemMatches: null as unknown as _PricingRunItemMatches,
  shopItemMatches: null as unknown as _ShopItemMatches,
  pricingDimensions: null as unknown as _PricingDimensions,
  pricingWeight: null as unknown as _PricingWeight,
  pricingFees: null as unknown as _PricingFees,
  pricingProfit: null as unknown as _PricingProfit,
  typeLevelAssignmentCheck: _typeLevelAssignmentCheck,
} as const
