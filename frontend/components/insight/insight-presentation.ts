/**
 * Shared presentation switch for Insight surfaces.
 *
 * Legacy remains the default so non-Warm consumers keep the existing Terminal
 * classes. Warm only changes the visual boundary; run and transport behavior
 * stay owned by each adapter.
 */
export type InsightAppearance = 'legacy' | 'warm'
