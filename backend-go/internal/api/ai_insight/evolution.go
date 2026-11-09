package ai_insight

import "fmt"

type dimensionObservation struct {
	RunID  string
	Signal string
}

func EvolveDimensions(runs []AdAgentRun) AdAgentEvolutionReport {
	report := AdAgentEvolutionReport{
		Suggestions:     []DimensionSuggestion{},
		DimensionHealth: make(map[string]DimensionHealth),
	}
	if len(runs) == 0 {
		return report
	}
	history := make(map[string][]dimensionObservation)
	skipCounts := make(map[string]int)
	for _, run := range runs {
		for _, dimension := range run.DimensionsAnalyzed {
			id, _ := dimension["dimension_id"].(string)
			if id == "" {
				continue
			}
			signal, _ := dimension["signal_strength"].(string)
			if signal == "" {
				signal = "unknown"
			}
			history[id] = append(history[id], dimensionObservation{RunID: run.RunID, Signal: signal})
		}
		for _, skipped := range run.DimensionsSkipped {
			id, _ := skipped["dimension_id"].(string)
			if id != "" {
				skipCounts[id]++
			}
		}
	}
	for dimensionID, entries := range history {
		counts := make(map[string]int)
		for _, entry := range entries {
			counts[entry.Signal]++
		}
		count := len(entries)
		health := DimensionHealth{
			RunCount:           count,
			SignalDistribution: counts,
			EmptyRatio:         ratio(counts["empty"], count),
			StrongRatio:        ratio(counts["strong"], count),
		}
		report.DimensionHealth[dimensionID] = health
		recentFive := lastSignals(entries, 5)
		if len(recentFive) == 5 && allSignals(recentFive, "empty") {
			report.Suggestions = append(report.Suggestions, DimensionSuggestion{
				DimensionID: dimensionID,
				Action:      "lower_priority",
				Reason:      fmt.Sprintf("近 %d 次分析均无数据，建议降低优先级", len(recentFive)),
			})
		}
		recentThree := lastSignals(entries, 3)
		if len(recentThree) == 3 && allSignals(recentThree, "strong") {
			report.Suggestions = append(report.Suggestions, DimensionSuggestion{
				DimensionID: dimensionID,
				Action:      "raise_priority",
				Reason:      fmt.Sprintf("近 %d 次分析信号稳定强，建议提升优先级", len(recentThree)),
			})
		}
	}
	for dimensionID, count := range skipCounts {
		if count >= 5 {
			report.Suggestions = append(report.Suggestions, DimensionSuggestion{
				DimensionID: dimensionID,
				Action:      "review_config",
				Reason:      fmt.Sprintf("已被跳过 %d 次，建议检查数据源配置或降低阈值", count),
			})
		}
	}
	if report.DimensionHealth == nil {
		report.DimensionHealth = map[string]DimensionHealth{}
	}
	return report
}

func lastSignals(entries []dimensionObservation, limit int) []string {
	if limit <= 0 || len(entries) == 0 {
		return nil
	}
	start := len(entries) - limit
	if start < 0 {
		start = 0
	}
	result := make([]string, 0, len(entries)-start)
	for _, entry := range entries[start:] {
		result = append(result, entry.Signal)
	}
	return result
}

func allSignals(values []string, expected string) bool {
	if len(values) == 0 {
		return false
	}
	for _, value := range values {
		if value != expected {
			return false
		}
	}
	return true
}

func ratio(count, total int) float64 {
	if total <= 0 {
		return 0
	}
	value := float64(count) / float64(total)
	return float64(int(value*100+0.5)) / 100
}
