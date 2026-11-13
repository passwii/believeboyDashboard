package autoreport

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
)

// Result is the outcome of processing one file.
type Result struct {
	Status      string // ok | skipped | failed
	ReportType  string
	ReportLabel string
	Reason      string
	Archived    string
	AdReport    bool
}

// Processor recognizes and persists one file through the gateway.
type Processor struct {
	Config Config
	Client *Client
}

// Process handles a single file. A returned error means the file can be retried;
// a skipped result is terminal (the file stays in place for a human).
func (p *Processor) Process(ctx context.Context, file File) (Result, error) {
	adRecognition, adErr := p.Client.RecognizeAd(ctx, file.Path, file.Country)
	if adErr != nil {
		if _, clientError := clientGatewayError(adErr); !clientError {
			return Result{}, adErr
		}
	} else if recognized(adRecognition) {
		return p.commitAd(ctx, file, adRecognition)
	}

	reportRecognition, reportErr := p.Client.RecognizeReport(ctx, file.Path, file.Country)
	if reportErr != nil {
		if _, clientError := clientGatewayError(reportErr); clientError {
			return Result{Status: "skipped", Reason: gatewayReason(reportErr)}, nil
		}
		return Result{}, reportErr
	}
	if !recognized(reportRecognition) {
		reason := strings.TrimSpace(reportRecognition.Reason)
		if reason == "" {
			reason = "未匹配任何报表类型"
		}
		return Result{Status: "skipped", Reason: reason}, nil
	}
	return p.commitReport(ctx, file, reportRecognition)
}

func (p *Processor) commitAd(ctx context.Context, file File, recognition *Recognition) (Result, error) {
	if mismatch, reason := projectMismatch(file, recognition); mismatch {
		return Result{Status: "skipped", ReportType: recognition.ReportType, ReportLabel: recognition.ReportLabel, Reason: reason}, nil
	}
	original := filepath.Base(file.Path)
	project := file.ProjectName
	request := AdCommitRequest{
		TempFileID:       recognition.TempFileID,
		ReportType:       recognition.ReportType,
		OriginalFilename: &original,
		ProjectName:      &project,
		Country:          countryOrDefault(file.Country, recognition.Country),
		ReportDate:       recognition.DetectedDate,
		ReportStartDate:  recognition.DetectedStartDate,
		ReportEndDate:    recognition.DetectedEndDate,
		DryRun:           p.Config.DryRun,
	}
	result, err := p.Client.CommitAd(ctx, request)
	if err != nil {
		return Result{}, err
	}
	return p.finish(file, recognition, result, true)
}

func (p *Processor) commitReport(ctx context.Context, file File, recognition *Recognition) (Result, error) {
	if mismatch, reason := projectMismatch(file, recognition); mismatch {
		return Result{Status: "skipped", ReportType: recognition.ReportType, Reason: reason}, nil
	}
	original := filepath.Base(file.Path)
	project := file.ProjectName
	request := ReportCommitRequest{
		TempFileID:       recognition.TempFileID,
		ReportType:       recognition.ReportType,
		OriginalFilename: &original,
		ProjectName:      &project,
		Country:          countryOrDefault(file.Country, recognition.Country),
		ReportDate:       recognition.DetectedDate,
		ReportStartDate:  recognition.DetectedStartDate,
		ReportEndDate:    recognition.DetectedEndDate,
		DryRun:           p.Config.DryRun,
	}
	result, err := p.Client.CommitReport(ctx, request)
	if err != nil {
		return Result{}, err
	}
	return p.finish(file, recognition, result, false)
}

func (p *Processor) finish(file File, recognition *Recognition, commit *CommitResult, adReport bool) (Result, error) {
	result := Result{
		Status:      "ok",
		ReportType:  recognition.ReportType,
		ReportLabel: recognition.ReportLabel,
		AdReport:    adReport,
	}
	if p.Config.DryRun {
		result.Reason = "[dry-run] 未入库、未移动文件"
		return result, nil
	}
	archived, err := MoveToArchive(p.Config, file, adReport)
	if err != nil {
		// The data is already committed; report the move failure so the file can
		// be retried (the commit is versioned, so a repeat is not destructive).
		return Result{}, fmt.Errorf("文件移动失败（已入库）: %w", err)
	}
	result.Archived = archived
	if commit != nil {
		result.Reason = strings.TrimSpace(commit.Message)
		if len(commit.Warnings) > 0 {
			if result.Reason != "" {
				result.Reason += "; "
			}
			result.Reason += strings.Join(commit.Warnings, "; ")
		}
	}
	return result, nil
}

func recognized(recognition *Recognition) bool {
	if recognition == nil {
		return false
	}
	if recognition.TempFileID == "" || recognition.ReportType == "" {
		return false
	}
	status := strings.ToLower(strings.TrimSpace(recognition.Status))
	return status == "recognized" || status == "ok" || status == "matched"
}

func projectMismatch(file File, recognition *Recognition) (bool, string) {
	if recognition.ProjectMatch.Status != "matched" || recognition.ProjectMatch.ProjectName == nil {
		return false, ""
	}
	matched := *recognition.ProjectMatch.ProjectName
	if matched != file.ProjectName {
		return true, fmt.Sprintf("文件匹配项目 %q 与目录项目 %q 不一致", matched, file.ProjectName)
	}
	return false, ""
}

func countryOrDefault(candidates ...string) string {
	for _, candidate := range candidates {
		if trimmed := strings.ToUpper(strings.TrimSpace(candidate)); trimmed != "" {
			return trimmed
		}
	}
	return DefaultCountry
}

func clientGatewayError(err error) (*GatewayError, bool) {
	var gatewayErr *GatewayError
	if errors.As(err, &gatewayErr) && gatewayErr.Status >= 400 && gatewayErr.Status < 500 {
		return gatewayErr, true
	}
	return nil, false
}

func gatewayReason(err error) string {
	if gatewayErr, ok := clientGatewayError(err); ok {
		return fmt.Sprintf("网关拒绝识别请求（%d）: %s", gatewayErr.Status, gatewayErr.Detail)
	}
	return err.Error()
}
