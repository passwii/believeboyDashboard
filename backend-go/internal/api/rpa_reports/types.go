package rpa_reports

import "context"

type ReportTypeStatus struct {
	ReportType       string  `json:"report_type"`
	HasData          bool    `json:"has_data"`
	IsUploaded       bool    `json:"is_uploaded"`
	LatestDate       *string `json:"latest_date"`
	OriginalFilename *string `json:"original_filename"`
	StatusSource     *string `json:"status_source"`
}

type ProjectReportStatus struct {
	ProjectID   int64              `json:"project_id"`
	ProjectName string             `json:"project_name"`
	Country     string             `json:"country"`
	Statuses    []ReportTypeStatus `json:"statuses"`
}

type RpaReportStatusResponse struct {
	Country string                `json:"country"`
	Items   []ProjectReportStatus `json:"items"`
}

type Store interface {
	GetReportStatusForDate(ctx context.Context, reportDate, country, operator string, isAdmin bool) (*RpaReportStatusResponse, error)
}
