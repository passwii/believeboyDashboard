package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/uploads"
)

// TestInsertSalesRowsBindsProjectParameter guards against a regression where
// the INSERT used p.id for project_id while still passing an unused argument
// at position $3. PostgreSQL cannot infer a type for an unreferenced
// parameter and fails with SQLSTATE 42P18 ("could not determine data type of
// parameter $3"), which surfaced as HTTP 500 on /api/v1/report-upload/commit
// for every sales report.
func TestInsertSalesRowsBindsProjectParameter(t *testing.T) {
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
	db := txDB{tx: tx}

	var projectID int64
	var projectName string
	err = tx.QueryRow(
		ctx,
		`SELECT id, project_name FROM public.projects ORDER BY id LIMIT 1`,
	).Scan(&projectID, &projectName)
	if err == pgx.ErrNoRows {
		t.Skip("no project fixture in test database")
	}
	if err != nil {
		t.Fatalf("select project fixture error = %v", err)
	}

	localPath := filepath.Join(t.TempDir(), "sales-report.tsv")
	if err := os.WriteFile(localPath, []byte("amazon-order-id\tpurchase-date\n"), 0o600); err != nil {
		t.Fatalf("write fixture error = %v", err)
	}
	info, err := os.Stat(localPath)
	if err != nil {
		t.Fatalf("stat fixture error = %v", err)
	}

	idSuffix := newSalesFixtureSuffix(t)
	date := time.Date(2026, 11, 12, 0, 0, 0, 0, time.UTC)
	uploadAt := date.Add(12 * time.Hour)
	sourceID, err := insertAnalysisSource(ctx, db, analysisSourceInput{
		ProjectID:        projectID,
		ReportType:       "sales_report",
		Country:          "US",
		ReportDate:       &date,
		PeriodStart:      &date,
		PeriodEnd:        &date,
		RowCountTotal:    1,
		RowCountIncluded: 1,
		File: uploads.PreparedReportFile{
			FileID:           "itest-" + idSuffix,
			FilePath:         "sales-report.tsv",
			Filename:         "sales-report.tsv",
			OriginalFilename: "sales-report.tsv",
			Size:             info.Size(),
			LocalPath:        localPath,
		},
	})
	if err != nil {
		t.Fatalf("insertAnalysisSource() error = %v", err)
	}

	sku := "ITEST-SKU-" + idSuffix
	asin := "ITESTASIN1"
	currency := "USD"
	row := salesRow{
		Country:         "US",
		AmazonOrderID:   "ITEST-" + idSuffix,
		PurchaseAtUTC:   uploadAt,
		PurchaseAtLocal: uploadAt,
		PurchaseDate:    "2026-11-12",
		OrderStatus:     "Shipped",
		SKU:             &sku,
		ASIN:            &asin,
		Quantity:        1,
		ItemPrice:       9.99,
		Currency:        &currency,
		IsCountedSales:  true,
		Raw:             map[string]any{"fixture": true},
	}
	if err := insertSalesRows(ctx, db, sourceID, projectID, []salesRow{row}); err != nil {
		t.Fatalf("insertSalesRows(project %q) error = %v", projectName, err)
	}

	var stored int
	if err := tx.QueryRow(
		ctx,
		`SELECT count(*) FROM public.analysis_sales_order_rows
		  WHERE source_file_id = $1 AND amazon_order_id = $2`,
		sourceID,
		row.AmazonOrderID,
	).Scan(&stored); err != nil {
		t.Fatalf("count fixture rows error = %v", err)
	}
	if stored != 1 {
		t.Errorf("stored rows = %d, want 1", stored)
	}
}

func newSalesFixtureSuffix(t *testing.T) string {
	t.Helper()
	buf := make([]byte, 6)
	if _, err := rand.Read(buf); err != nil {
		t.Fatalf("rand.Read() error = %v", err)
	}
	return hex.EncodeToString(buf)
}
