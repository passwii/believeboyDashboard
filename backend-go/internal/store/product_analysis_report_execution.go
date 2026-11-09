package store

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/product_analysis"
)

// ProductAnalysisFilesInput describes the asynchronous report payload used by
// the job worker. Paths are server-generated upload paths and are validated
// again against UploadRoot before any file is opened.
type ProductAnalysisFilesInput struct {
	ProjectID       int64
	ProjectName     string
	Country         string
	ReportStartDate string
	ReportEndDate   string
	UploadRoot      string
	ReportPaths     map[string]string
}

// RunProductAnalysisFiles executes the same production calculation used by
// product-analysis previews, but with resolved upload paths supplied by a job.
// It never writes PT1 rows; the asynchronous report task only needs the
// computed workbook payload.
func RunProductAnalysisFiles(
	ctx context.Context,
	db DB,
	input ProductAnalysisFilesInput,
) (*product_analysis.RunResponse, error) {
	if db == nil {
		return nil, productAnalysisServiceUnavailable("product analysis database")
	}
	if input.ProjectID <= 0 {
		return nil, productAnalysisBadRequest("project_id must be positive")
	}
	expectedName := strings.TrimSpace(input.ProjectName)
	if expectedName == "" {
		return nil, productAnalysisBadRequest("project_name is required")
	}
	startDate, endDate, err := productAnalysisEngineDates(
		input.ReportStartDate,
		input.ReportEndDate,
	)
	if err != nil {
		return nil, err
	}
	project, err := productAnalysisEngineLoadProject(
		ctx,
		db,
		input.ProjectID,
		product_analysis.Principal{IsAdmin: true},
	)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(project.Name) != expectedName {
		return nil, productAnalysisBadRequest(
			"product analysis project metadata does not match the job payload",
		)
	}
	country := productAnalysisNormalizeCountry(input.Country, "US")
	uploadRoot := strings.TrimSpace(input.UploadRoot)
	if uploadRoot == "" {
		return nil, productAnalysisServiceUnavailable("product analysis upload root")
	}

	allowedPaths := map[string]bool{
		"business_report":  true,
		"payment_report":   true,
		"ad_report":        true,
		"inventory_report": true,
	}
	resolved := make(map[string]string, 4)
	for reportType, rawPath := range input.ReportPaths {
		reportType = strings.TrimSpace(reportType)
		if !allowedPaths[reportType] {
			return nil, productAnalysisBadRequest(
				fmt.Sprintf("unsupported product analysis report type %q", reportType),
			)
		}
		if strings.TrimSpace(rawPath) == "" {
			continue
		}
		resolvedPath, resolveErr := productAnalysisResolveContainedSourceFile(
			uploadRoot,
			rawPath,
		)
		if resolveErr != nil {
			return nil, productAnalysisBadRequest(
				fmt.Sprintf("%s file is unavailable: %v", reportType, resolveErr),
			)
		}
		resolved[reportType] = resolvedPath
	}
	for _, reportType := range []string{
		"business_report",
		"payment_report",
		"ad_report",
	} {
		if resolved[reportType] == "" {
			return nil, productAnalysisBadRequest(
				fmt.Sprintf("%s file path is required", reportType),
			)
		}
	}

	response, err := productAnalysisPreviewFromFiles(
		ctx,
		db,
		project,
		country,
		startDate,
		endDate,
		resolved["business_report"],
		resolved["payment_report"],
		resolved["ad_report"],
	)
	if err != nil {
		var statusErr *product_analysis.StatusError
		if errors.As(err, &statusErr) {
			return nil, err
		}
		return nil, fmt.Errorf("calculate product analysis report: %w", err)
	}
	return response, nil
}
