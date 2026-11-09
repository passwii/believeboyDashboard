package insight_observation

import (
	"fmt"
	"math"
	"sort"
	"strconv"
)

const (
	SourceInsightRun     = "insight_run"
	SourceLegacyFallback = "legacy_fallback"
	CanonicalCapability  = "insight"
)

type bucketSamples struct {
	durations   []int
	firstDeltas []int
	tokens      []int
	runIDs      []string
	runTokens   []int
}

func AggregateRows(rows []ObservationRow, costMultiplier float64) []CapabilityMetrics {
	buckets := make(map[string]*CapabilityMetrics)
	samples := make(map[string]*bucketSamples)
	for _, row := range rows {
		capability := row.Capability
		if capability == "" {
			capability = CanonicalCapability
		}
		bucket := buckets[capability]
		if bucket == nil {
			bucket = &CapabilityMetrics{
				Capability:    capability,
				ErrorCounts:   map[string]int{},
				CostAnomalies: []string{},
			}
			buckets[capability] = bucket
			samples[capability] = &bucketSamples{}
		}
		if row.Source == SourceLegacyFallback {
			bucket.FallbackEvents++
			continue
		}
		bucket.Runs++
		switch ptrString(row.Status) {
		case "completed":
			bucket.Completed++
		case "failed":
			bucket.Failed++
		case "cancelled":
			bucket.Cancelled++
		}
		if row.ErrorCode != nil && *row.ErrorCode != "" {
			bucket.ErrorCounts[*row.ErrorCode]++
		}
		if row.CancelRequested {
			bucket.CancelRequested++
			if row.CancelSucceeded != nil && *row.CancelSucceeded {
				bucket.CancelSucceeded++
			}
		}
		if row.Retries != nil && *row.Retries > 0 {
			bucket.RetriedRuns++
		}
		bucket.StreamOpens += row.StreamOpens
		bucket.StreamReconnects += row.StreamReconnects
		if row.ReconnectCompleted {
			bucket.ReconnectCompleted++
		}
		bucket.StreamFrames += row.StreamFrames
		if row.StreamBytes != nil {
			bucket.StreamBytes += *row.StreamBytes
		}
		if row.StreamXLen != nil {
			bucket.MaxStreamXLen = maxPtr(bucket.MaxStreamXLen, *row.StreamXLen)
		}
		if row.StreamMemoryBytes != nil {
			bucket.MaxStreamMemoryBytes = maxPtr(bucket.MaxStreamMemoryBytes, *row.StreamMemoryBytes)
		}
		tokens := ptrInt(row.TotalTokens)
		bucket.TotalTokens += tokens
		if row.DurationMS != nil {
			samples[capability].durations = append(samples[capability].durations, *row.DurationMS)
		}
		if row.FirstDeltaMS != nil {
			samples[capability].firstDeltas = append(samples[capability].firstDeltas, *row.FirstDeltaMS)
		}
		samples[capability].tokens = append(samples[capability].tokens, tokens)
		runID := ptrString(row.RunID)
		samples[capability].runIDs = append(samples[capability].runIDs, runID)
		samples[capability].runTokens = append(samples[capability].runTokens, tokens)
	}
	for name, bucket := range buckets {
		sample := samples[name]
		total := bucket.Runs + bucket.FallbackEvents
		if total > 0 {
			bucket.FallbackRatio = round4(float64(bucket.FallbackEvents) / float64(total))
		}
		if bucket.Runs > 0 {
			bucket.ErrorRate = round4(float64(bucket.Failed) / float64(bucket.Runs))
		}
		if bucket.StreamOpens > 0 {
			bucket.ReconnectRate = round4(float64(bucket.StreamReconnects) / float64(bucket.StreamOpens))
		}
		if bucket.CancelRequested > 0 {
			rate := round4(float64(bucket.CancelSucceeded) / float64(bucket.CancelRequested))
			bucket.CancelSuccessRate = &rate
		}
		if len(sample.durations) > 0 {
			bucket.AvgDurationMS = intPtr(intAverage(sample.durations))
			bucket.P95DurationMS = intPtr(percentile(sample.durations, 0.95))
			bucket.MaxDurationMS = intPtr(maxInt(sample.durations))
		}
		if len(sample.firstDeltas) > 0 {
			bucket.AvgFirstDeltaMS = intPtr(intAverage(sample.firstDeltas))
			bucket.P95FirstDeltaMS = intPtr(percentile(sample.firstDeltas, 0.95))
			bucket.MaxFirstDeltaMS = intPtr(maxInt(sample.firstDeltas))
		}
		if costMultiplier > 0 && len(sample.tokens) >= 3 {
			median := medianInt(sample.tokens)
			if median > 0 {
				limit := float64(median) * costMultiplier
				for index, value := range sample.runTokens {
					if float64(value) > limit {
						bucket.CostAnomalies = append(bucket.CostAnomalies, sample.runIDs[index])
					}
				}
			}
		}
	}
	names := make([]string, 0, len(buckets))
	for name := range buckets {
		names = append(names, name)
	}
	sort.Strings(names)
	result := make([]CapabilityMetrics, 0, len(names))
	for _, name := range names {
		result = append(result, *buckets[name])
	}
	return result
}

func EvaluateGate(buckets []CapabilityMetrics, thresholds Thresholds) ([]GateFinding, []string) {
	findings := make([]GateFinding, 0)
	reasons := make([]string, 0)
	for _, bucket := range buckets {
		if bucket.Runs == 0 && bucket.FallbackEvents == 0 {
			continue
		}
		if thresholds.DurationMS > 0 && ptrInt(bucket.MaxDurationMS) > thresholds.DurationMS {
			findings = append(findings, GateFinding{
				Code: "duration_exceeded", Severity: "blocking", Capability: bucket.Capability,
				Metric: "max_duration_ms", Observed: ptrInt(bucket.MaxDurationMS), Threshold: thresholds.DurationMS,
				Detail: "存在单次执行超过执行器 soft_time_limit 预算",
			})
		}
		if thresholds.FirstDeltaMS > 0 && ptrInt(bucket.MaxFirstDeltaMS) > thresholds.FirstDeltaMS {
			findings = append(findings, GateFinding{
				Code: "first_delta_exceeded", Severity: "blocking", Capability: bucket.Capability,
				Metric: "max_first_delta_ms", Observed: ptrInt(bucket.MaxFirstDeltaMS), Threshold: thresholds.FirstDeltaMS,
				Detail: "首字时延超过 provider 调用预算",
			})
		}
		if thresholds.StreamFrames > 0 && ptrInt(bucket.MaxStreamXLen) >= thresholds.StreamFrames {
			findings = append(findings, GateFinding{
				Code: "stream_retention_exhausted", Severity: "warning", Capability: bucket.Capability,
				Metric: "max_stream_xlen", Observed: ptrInt(bucket.MaxStreamXLen), Threshold: thresholds.StreamFrames,
				Detail: "Stream 已达 maxlen，续传将退化到快照重建",
			})
		}
		if thresholds.FallbackRatio > 0 && bucket.FallbackRatio > thresholds.FallbackRatio {
			findings = append(findings, GateFinding{
				Code: "fallback_observed", Severity: "blocking", Capability: bucket.Capability,
				Metric: "fallback_ratio", Observed: bucket.FallbackRatio, Threshold: thresholds.FallbackRatio,
				Detail: "存在降级事件落在该桶",
			})
		}
		if bucket.CancelRequested > 0 && bucket.CancelSuccessRate != nil && *bucket.CancelSuccessRate != 1 {
			findings = append(findings, GateFinding{
				Code: "cancel_not_landed", Severity: "blocking", Capability: bucket.Capability,
				Metric: "cancel_success_rate", Observed: *bucket.CancelSuccessRate, Threshold: 1.0,
				Detail: "存在取消请求未落地（请求时已终态）",
			})
		}
		if len(bucket.CostAnomalies) > 0 {
			findings = append(findings, GateFinding{
				Code: "cost_anomaly", Severity: "blocking", Capability: bucket.Capability,
				Metric: "total_tokens", Observed: len(bucket.CostAnomalies),
				Threshold: ">" + formatFloat(thresholds.CostAnomalyMultiplier) + "x median",
				Detail:    "异常 run: " + joinLimited(bucket.CostAnomalies, 5),
			})
		}
		if bucket.Failed > 0 {
			findings = append(findings, GateFinding{
				Code: "failures_observed", Severity: "info", Capability: bucket.Capability,
				Metric: "failed", Observed: bucket.Failed, Threshold: nil,
				Detail: "错误分布",
			})
		}
		if bucket.RetriedRuns > 0 {
			findings = append(findings, GateFinding{
				Code: "retries_observed", Severity: "info", Capability: bucket.Capability,
				Metric: "retried_runs", Observed: bucket.RetriedRuns, Threshold: nil,
				Detail: "重试率供观察，不作为门禁",
			})
		}
	}
	foundCanonical := false
	for _, bucket := range buckets {
		if bucket.Capability == CanonicalCapability && bucket.Runs > 0 {
			foundCanonical = true
		}
	}
	if !foundCanonical {
		reasons = append(reasons, "insufficient_data:insight.runs=0")
	}
	for _, finding := range findings {
		if finding.Capability == CanonicalCapability && finding.Severity == "blocking" {
			reasons = append(reasons, finding.Code+":"+finding.Metric+"="+toString(finding.Observed))
		}
	}
	return findings, reasons
}

func round4(value float64) float64 {
	return math.Round(value*10000) / 10000
}

func ptrInt(value *int) int {
	if value == nil {
		return 0
	}
	return *value
}

func ptrString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func intPtr(value int) *int { return &value }

func maxPtr(current *int, value int) *int {
	if current == nil || value > *current {
		result := value
		return &result
	}
	return current
}

func intAverage(values []int) int {
	if len(values) == 0 {
		return 0
	}
	total := 0
	for _, value := range values {
		total += value
	}
	return total / len(values)
}

func percentile(values []int, pct float64) int {
	if len(values) == 0 {
		return 0
	}
	ordered := append([]int(nil), values...)
	sort.Ints(ordered)
	if len(ordered) == 1 {
		return ordered[0]
	}
	index := int(math.Round(pct * float64(len(ordered)-1)))
	if index < 0 {
		index = 0
	}
	if index >= len(ordered) {
		index = len(ordered) - 1
	}
	return ordered[index]
}

func maxInt(values []int) int {
	result := values[0]
	for _, value := range values[1:] {
		if value > result {
			result = value
		}
	}
	return result
}

func medianInt(values []int) int {
	if len(values) == 0 {
		return 0
	}
	ordered := append([]int(nil), values...)
	sort.Ints(ordered)
	mid := len(ordered) / 2
	if len(ordered)%2 == 1 {
		return ordered[mid]
	}
	return (ordered[mid-1] + ordered[mid]) / 2
}

func formatFloat(value float64) string {
	if value == math.Trunc(value) {
		return strconv.FormatInt(int64(value), 10)
	}
	return strconv.FormatFloat(value, 'f', -1, 64)
}

func joinLimited(values []string, limit int) string {
	if limit > len(values) {
		limit = len(values)
	}
	result := ""
	for index := 0; index < limit; index++ {
		if index > 0 {
			result += ","
		}
		result += values[index]
	}
	return result
}

func toString(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case int:
		return strconv.Itoa(typed)
	case float64:
		return formatFloat(typed)
	default:
		return fmt.Sprint(value)
	}
}
