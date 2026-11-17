package store

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/uploads"
)

// TestInsertAnalysisSourceInventorySupersedesLegacyCurrentRow guards the
// switch from the legacy Python writer to the Go writer. Legacy inventory rows
// carry period_start_date/period_end_date (start = end), while the Go writer
// leaves both NULL. Because uq_analysis_sources_inventory_current is keyed on
// (project_id, report_type, country) only, a period-filtered supersede misses
// the legacy current row and the next inventory commit fails with SQLSTATE
// 23505 on that index.
func TestInsertAnalysisSourceInventorySupersedesLegacyCurrentRow(t *testing.T) {
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

	// Prefer a project without inventory history so version assertions are
	// deterministic; fall back to any project.
	var projectID int64
	err = pool.QueryRow(
		ctx,
		`SELECT p.id
		 FROM public.projects p
		 WHERE coalesce(p.is_active, true)
		   AND NOT EXISTS (
		     SELECT 1 FROM public.analysis_source_files a
		     WHERE a.project_id = p.id AND a.report_type = 'inventory_report'
		   )
		 ORDER BY p.id
		 LIMIT 1`,
	).Scan(&projectID)
	if err == pgx.ErrNoRows {
		err = pool.QueryRow(
			ctx,
			`SELECT id FROM public.projects WHERE coalesce(is_active, true) ORDER BY id LIMIT 1`,
		).Scan(&projectID)
	}
	if err == pgx.ErrNoRows {
		t.Skip("no project fixture in test database")
	}
	if err != nil {
		t.Fatalf("select project fixture error = %v", err)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("Begin() error = %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	db := txDB{tx: tx}

	legacyPeriod := dateOnly(time.Date(2026, 11, 14, 0, 0, 0, 0, time.UTC))
	const legacyVersion = 999999
	var legacyID int64
	err = tx.QueryRow(
		ctx,
		`INSERT INTO public.analysis_source_files (
		   project_id, report_type, country, period_start_date, period_end_date,
		   snapshot_at, version, is_current, upload_file_id, upload_file_path,
		   original_filename, stored_filename, logical_filename, storage_key,
		   ingestion_status, row_count_total, row_count_included
		 ) VALUES (
		   $1, 'inventory_report', 'US', $2, $2,
		   now(), $3, true, 'legacy-file-id', '/legacy/file.tsv',
		   'legacy.tsv', 'legacy.tsv', 'legacy.tsv', 'legacy.tsv',
		   'success', 1, 1
		 ) RETURNING id`,
		projectID, legacyPeriod, legacyVersion,
	).Scan(&legacyID)
	if err != nil {
		t.Fatalf("insert legacy inventory row error = %v", err)
	}

	localPath := filepath.Join(t.TempDir(), "FBA-inventory.tsv")
	if err := os.WriteFile(localPath, []byte("snapshot-date\tsku\tasin\n2026-11-15\tSKU-1\tB0TEST\n"), 0o600); err != nil {
		t.Fatalf("write fixture error = %v", err)
	}
	info, err := os.Stat(localPath)
	if err != nil {
		t.Fatalf("stat fixture error = %v", err)
	}
	reportDate := dateOnly(time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC))
	snapshotAt := time.Now().UTC()
	sourceID, err := insertAnalysisSource(ctx, db, analysisSourceInput{
		ProjectID:  projectID,
		ReportType: "inventory_report",
		Country:    "US",
		ReportDate: &reportDate,
		SnapshotAt: &snapshotAt,
		File: uploads.PreparedReportFile{
			FileID:           "go-file-id",
			FilePath:         "/go/file.tsv",
			Filename:         "go.tsv",
			OriginalFilename: "FBA-inventory.tsv",
			Size:             info.Size(),
			LocalPath:        localPath,
		},
		RowCountTotal:    1,
		RowCountIncluded: 1,
	})
	if err != nil {
		t.Fatalf("insertAnalysisSource() error = %v", err)
	}

	var legacyIsCurrent bool
	if err := tx.QueryRow(
		ctx,
		`SELECT is_current FROM public.analysis_source_files WHERE id = $1`,
		legacyID,
	).Scan(&legacyIsCurrent); err != nil {
		t.Fatalf("read legacy row error = %v", err)
	}
	if legacyIsCurrent {
		t.Fatalf("legacy inventory row %d is still current after Go insert", legacyID)
	}

	var currentCount int
	if err := tx.QueryRow(
		ctx,
		`SELECT count(*) FROM public.analysis_source_files
		 WHERE project_id = $1 AND report_type = 'inventory_report' AND country = 'US'
		   AND is_current IS TRUE`,
		projectID,
	).Scan(&currentCount); err != nil {
		t.Fatalf("count current rows error = %v", err)
	}
	if currentCount != 1 {
		t.Fatalf("current inventory rows = %d, want 1", currentCount)
	}

	var version int
	var periodStart, periodEnd *time.Time
	if err := tx.QueryRow(
		ctx,
		`SELECT version, period_start_date, period_end_date
		 FROM public.analysis_source_files WHERE id = $1`,
		sourceID,
	).Scan(&version, &periodStart, &periodEnd); err != nil {
		t.Fatalf("read inserted row error = %v", err)
	}
	if version != legacyVersion+1 {
		t.Fatalf("new version = %d, want %d", version, legacyVersion+1)
	}
}
