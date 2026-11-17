package store

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"
)

func TestReportUploadLogDateUsesAsiaShanghai(t *testing.T) {
	// 2026-11-16 17:30 UTC is already 2026-11-17 in Asia/Shanghai.
	now := time.Date(2026, 11, 16, 17, 30, 0, 0, time.UTC)
	got := reportUploadLogDate(now)
	want := time.Date(2026, 11, 17, 0, 0, 0, 0, time.UTC)
	if !got.Equal(want) {
		t.Fatalf("reportUploadLogDate() = %s, want %s", got, want)
	}
}

// TestGetReportStatusForDateShowsUploadDayBackfill guards the RPA status grid
// regression where a report uploaded on a given day was only visible on its
// business dates. The fallback now also matches analysis_source_files.created_at,
// so a file written on the selected day turns the cell green even when its
// period does not cover that day.
func TestGetReportStatusForDateShowsUploadDayBackfill(t *testing.T) {
	databaseURL := os.Getenv("GO_API_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set GO_API_TEST_DATABASE_URL to a BLF_test connection for integration coverage")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := OpenPool(ctx, databaseURL)
	if err != nil {
		t.Fatalf("OpenPool() error = %v", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("test database unavailable: %v", err)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("Begin() error = %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	projectName := fmt.Sprintf("rpa-upload-day-%d", time.Now().UnixNano())
	var projectID int64
	if err := tx.QueryRow(
		ctx,
		`INSERT INTO public.projects (project_name, sort_order, is_active, country)
		 VALUES ($1, 0, true, 'US') RETURNING id`,
		projectName,
	).Scan(&projectID); err != nil {
		t.Fatalf("insert project fixture error = %v", err)
	}

	uploadDay := time.Date(2026, 11, 17, 0, 0, 0, 0, time.UTC)
	periodStart := time.Date(2026, 11, 10, 0, 0, 0, 0, time.UTC)
	periodEnd := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	// 12:00 UTC is the same calendar date in UTC and Asia/Shanghai, so the
	// created_at::date fallback is deterministic regardless of the DB timezone.
	createdAt := time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)
	if _, err := tx.Exec(
		ctx,
		`INSERT INTO public.analysis_source_files (
		   project_id, report_type, country, report_date, period_start_date,
		   period_end_date, snapshot_at, version, is_current, upload_file_id,
		   upload_file_path, original_filename, stored_filename, logical_filename,
		   storage_key, ingestion_status, row_count_total, row_count_included,
		   created_at
		 ) VALUES (
		   $1, 'business_report', 'US', $2, $3,
		   $4, NULL, 1, true, 'fixture-file-id',
		   '/fixture/file.csv', 'fixture.csv', 'fixture.csv', 'fixture.csv',
		   'fixture', 'success', 5, 5,
		   $5
		 )`,
		projectID, periodEnd, periodStart, periodEnd, createdAt,
	); err != nil {
		t.Fatalf("insert analysis source fixture error = %v", err)
	}

	store := NewRpaReportsStore(NewTxDB(tx))
	response, err := store.GetReportStatusForDate(
		ctx, uploadDay.Format("2006-01-02"), "US", "", true,
	)
	if err != nil {
		t.Fatalf("GetReportStatusForDate() error = %v", err)
	}

	var statuses []struct {
		reportType string
		uploaded   bool
		source     *string
	}
	for _, item := range response.Items {
		if item.ProjectID != projectID {
			continue
		}
		for _, status := range item.Statuses {
			statuses = append(statuses, struct {
				reportType string
				uploaded   bool
				source     *string
			}{status.ReportType, status.IsUploaded, status.StatusSource})
		}
	}
	if len(statuses) == 0 {
		t.Fatalf("project %d missing from status response (%d items)", projectID, len(response.Items))
	}

	for _, status := range statuses {
		if status.reportType == "business_report" {
			if !status.uploaded {
				t.Fatalf("business_report is_uploaded = false, want true for upload day %s", uploadDay.Format("2006-01-02"))
			}
			if status.source == nil || *status.source != "business_date_backfill" {
				t.Fatalf("business_report status_source = %v, want business_date_backfill", status.source)
			}
			return
		}
	}
	t.Fatalf("business_report status not found in project %d", projectID)
}
