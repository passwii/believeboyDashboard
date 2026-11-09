package ai_insight

import "testing"

func TestEvolveDimensionsUsesRealSignalHistory(t *testing.T) {
	runs := make([]AdAgentRun, 0, 5)
	for index := 0; index < 5; index++ {
		runs = append(runs, AdAgentRun{
			RunID: "run",
			DimensionsAnalyzed: []map[string]any{
				{"dimension_id": "weak", "signal_strength": "empty"},
				{"dimension_id": "strong", "signal_strength": "strong"},
			},
			DimensionsSkipped: []map[string]any{{"dimension_id": "skipped"}},
		})
	}
	report := EvolveDimensions(runs)
	if len(report.Suggestions) == 0 {
		t.Fatalf("expected suggestions")
	}
	foundLower, foundRaise, foundReview := false, false, false
	for _, suggestion := range report.Suggestions {
		switch suggestion.Action {
		case "lower_priority":
			foundLower = true
		case "raise_priority":
			foundRaise = true
		case "review_config":
			foundReview = true
		}
	}
	if !foundLower || !foundRaise || !foundReview {
		t.Fatalf("suggestions=%#v", report.Suggestions)
	}
	if report.DimensionHealth["weak"].EmptyRatio != 1 || report.DimensionHealth["strong"].StrongRatio != 1 {
		t.Fatalf("health=%#v", report.DimensionHealth)
	}
}
