package insight_runs

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

func RunURLs(runID string) (detail, stream, cancel, retry string) {
	base := "/api/v1/insight/runs/" + runID
	return base, base + "/stream", base + "/cancel", base + "/retry"
}

func ToRunResponse(run *Run, replayed bool) RunResponse {
	detailURL, streamURL, cancelURL, retryURL := RunURLs(run.RunID)
	return RunResponse{
		SchemaVersion: 1,
		RunID:         run.RunID,
		Attempt:       run.Attempt,
		RoleID:        run.RoleID,
		RoleVersion:   run.RoleVersion,
		ProjectID:     run.ProjectID,
		Country:       run.Country,
		Status:        run.Status,
		OutputFormat:  "markdown",
		DetailURL:     detailURL,
		StreamURL:     streamURL,
		CancelURL:     cancelURL,
		RetryURL:      retryURL,
		Replayed:      replayed,
		CreatedAt:     asUTC(run.CreatedAt),
		UpdatedAt:     asUTC(run.UpdatedAt),
	}
}

func ToActionResponse(run *Run, replayed bool) ActionResponse {
	detailURL, streamURL, _, _ := RunURLs(run.RunID)
	return ActionResponse{
		SchemaVersion: 1,
		RunID:         run.RunID,
		Attempt:       run.Attempt,
		Status:        run.Status,
		DetailURL:     detailURL,
		StreamURL:     streamURL,
		Replayed:      replayed,
	}
}

func ToRunDetail(run *Run) RunDetail {
	outputs := parseOutputs(run.OutputsJSON)
	var usage *Usage
	if len(run.UsageJSON) > 0 {
		var parsed Usage
		if json.Unmarshal(run.UsageJSON, &parsed) == nil {
			usage = &parsed
		}
	}
	var runErr *Error
	if len(run.ErrorJSON) > 0 {
		var parsed Error
		if json.Unmarshal(run.ErrorJSON, &parsed) == nil {
			runErr = &parsed
		}
	}
	return RunDetail{
		SchemaVersion:   1,
		RunID:           run.RunID,
		Attempt:         run.Attempt,
		RoleID:          run.RoleID,
		RoleVersion:     run.RoleVersion,
		ProjectID:       run.ProjectID,
		Country:         run.Country,
		Status:          run.Status,
		Stage:           run.Stage,
		ProgressPercent: run.ProgressPercent,
		OutputFormat:    "markdown",
		Title:           nil,
		Outputs:         outputs,
		Usage:           usage,
		Error:           runErr,
		Resume: ResumeInfo{
			CurrentAttempt:   run.Attempt,
			HistoryAvailable: false,
		},
		CreatedAt:   asUTC(run.CreatedAt),
		StartedAt:   utcPointer(run.StartedAt),
		CompletedAt: utcPointer(run.CompletedAt),
		UpdatedAt:   asUTC(run.UpdatedAt),
	}
}

func parseOutputs(raw []byte) map[string]Output {
	outputs := make(map[string]Output)
	if len(raw) == 0 {
		return outputs
	}
	_ = json.Unmarshal(raw, &outputs)
	if outputs == nil {
		outputs = make(map[string]Output)
	}
	return outputs
}

func asUTC(value time.Time) time.Time {
	if value.IsZero() {
		return time.Now().UTC()
	}
	return value.UTC()
}

func utcPointer(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	utc := value.UTC()
	return &utc
}

func firstMarkdownTitle(content string) string {
	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(line), "#"))
		if trimmed != "" {
			runes := []rune(trimmed)
			if len(runes) > 255 {
				runes = runes[:255]
			}
			return string(runes)
		}
	}
	return ""
}

func ValidateRunID(runID string) error {
	if len(runID) != 36 {
		return fmt.Errorf("invalid run_id")
	}
	for i, char := range runID {
		switch i {
		case 8, 13, 18, 23:
			if char != '-' {
				return fmt.Errorf("invalid run_id")
			}
		default:
			if !((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F')) {
				return fmt.Errorf("invalid run_id")
			}
		}
	}
	return nil
}
