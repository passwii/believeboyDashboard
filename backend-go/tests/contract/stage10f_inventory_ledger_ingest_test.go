package contract

import (
	"bytes"
	"context"
	"encoding/csv"
	"errors"
	"fmt"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/uploads"
	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
)

var stage10FSummaryHeaders = []string{
	"Date", "FNSKU", "ASIN", "MSKU", "Title", "Disposition",
	"Starting Warehouse Balance", "In Transit Between Warehouses",
	"Receipts", "Customer Shipments", "Customer Returns", "Vendor Returns",
	"Warehouse Transfer In/Out", "Found", "Lost", "Damaged", "Disposed",
	"Other Events", "Ending Warehouse Balance", "Unknown Events",
	"Location", "Store",
}

var stage10FDetailHeaders = []string{
	"Date", "FNSKU", "ASIN", "MSKU", "Title", "Event Type",
	"Reference ID", "Quantity", "Fulfillment Center", "Disposition",
	"Reason", "Country", "Reconciled Quantity", "Unreconciled Quantity",
	"Date and Time", "Store",
}

func TestStage10FInventoryLedgerSummaryNativeIngest(t *testing.T) {
	databaseURL := stage10FDatabaseURL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	pool, err := store.OpenPool(ctx, databaseURL)
	if err != nil {
		t.Fatalf("OpenPool() error = %v", err)
	}
	t.Cleanup(pool.Close)

	projectID, projectName, sku := stage10FCreateProject(t, ctx, pool)
	uploadStore := store.NewUploadStore(store.NewPGXDB(pool), t.TempDir(), 50<<20)

	summaryCSV := stage10FBuildCSV(t, stage10FSummaryHeaders, [][]string{
		{
			"08/2026", "X00ABC", "B0001", sku, "Month summary",
			"SELLABLE", "100", "0", "0", "5", "0", "0", "0", "0", "0",
			"0", "0", "0", "95", "0", "LAX1", "Bel-Bel",
		},
		{
			"08/15/2026", "X00DEF", "B0002", sku, "Day summary",
			"CUSTOMER_DAMAGED", "20", "0", "2", "1", "0", "0", "0", "0",
			"0", "0", "0", "0", "21", "0", "PHX3", "Bel-Bel",
		},
	})

	response := stage10FCommit(t, ctx, uploadStore, projectName, uploads.CommitRequest{
		ReportType:       "inventory_ledger_summary",
		OriginalFilename: stage10FStringPtr("库存分类账 2026-08一览视图.csv"),
		ProjectName:      stage10FStringPtr(projectName),
		Country:          "US",
	}, summaryCSV)
	if response.Status != "persisted" || response.RowsIngested == nil ||
		*response.RowsIngested != 2 {
		t.Fatalf("summary response = %#v", response)
	}
	if response.PersistedSourceID == nil || *response.PersistedSourceID == 0 {
		t.Fatalf("summary source id = %#v", response.PersistedSourceID)
	}
	if response.PersistedTable == nil || *response.PersistedTable != "inventory_ledger_summary" {
		t.Fatalf("summary persisted table = %#v", response.PersistedTable)
	}
	if response.Message != "库存分类账汇总视图已入库（2 行）" {
		t.Fatalf("summary message = %q", response.Message)
	}

	if got := stage10FCount(t, ctx, pool, "inventory_ledger_summary", projectID); got != 2 {
		t.Fatalf("summary row count = %d, want 2", got)
	}
	if got := stage10FCount(t, ctx, pool, "inventory_ledger_detail", projectID); got != 0 {
		t.Fatalf("detail row count = %d, want 0", got)
	}
	if got := stage10FCount(t, ctx, pool, "inventory_ledger_ingest_batch", projectID); got != 1 {
		t.Fatalf("batch count = %d, want 1", got)
	}
	if got := stage10FCount(t, ctx, pool, "analysis_source_files", projectID); got != 1 {
		t.Fatalf("source count = %d, want 1", got)
	}
	if got := stage10FCount(t, ctx, pool, "report_upload_statuses", projectID); got != 0 {
		t.Fatalf("report_upload_statuses count = %d, want 0", got)
	}
	if got := stage10FCount(t, ctx, pool, "report_upload_logs", projectID); got != 0 {
		t.Fatalf("report_upload_logs count = %d, want 0", got)
	}
	statuses, err := uploadStore.ListReportStatus(ctx, nil, "stage10f-operator", "US", true)
	if err != nil {
		t.Fatalf("ListReportStatus() error = %v", err)
	}
	for _, item := range statuses.Items {
		if item.ProjectID != projectID {
			continue
		}
		if cell, visible := item.Statuses["inventory_report"]; visible &&
			cell.Status != "missing" {
			t.Fatalf("ledger source leaked into inventory_report status: %#v", cell)
		}
	}

	var fileKind, status string
	var rowsParsed, writtenSummary, writtenDetail int64
	err = pool.QueryRow(
		ctx,
		`SELECT file_kind, status, rows_parsed, rows_written_summary,
		        rows_written_detail
		 FROM public.inventory_ledger_ingest_batch
		 WHERE project_id = $1`,
		projectID,
	).Scan(&fileKind, &status, &rowsParsed, &writtenSummary, &writtenDetail)
	if err != nil {
		t.Fatalf("query summary batch: %v", err)
	}
	if fileKind != "summary" || status != "success" || rowsParsed != 2 ||
		writtenSummary != 2 || writtenDetail != 0 {
		t.Fatalf(
			"summary batch = kind:%s status:%s parsed:%d summary:%d detail:%d",
			fileKind, status, rowsParsed, writtenSummary, writtenDetail,
		)
	}

	var reportMonth, businessDate time.Time
	var startingBalance, endingBalance int
	err = pool.QueryRow(
		ctx,
		`SELECT report_month, "date", starting_balance, ending_balance
		 FROM public.inventory_ledger_summary
		 WHERE project_id = $1 AND msku = $2 AND location = 'LAX1'`,
		projectID,
		sku,
	).Scan(&reportMonth, &businessDate, &startingBalance, &endingBalance)
	if err != nil {
		t.Fatalf("query summary row: %v", err)
	}
	if reportMonth.Format("2006-01-02") != "2026-08-01" ||
		businessDate.Format("2006-01-02") != "2026-08-01" ||
		startingBalance != 100 || endingBalance != 95 {
		t.Fatalf(
			"summary mapping = month:%s date:%s start:%d end:%d",
			reportMonth.Format("2006-01-02"),
			businessDate.Format("2006-01-02"),
			startingBalance,
			endingBalance,
		)
	}
}

func TestStage10FInventoryLedgerSummaryIdempotencyAndOverwrite(t *testing.T) {
	databaseURL := stage10FDatabaseURL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	pool, err := store.OpenPool(ctx, databaseURL)
	if err != nil {
		t.Fatalf("OpenPool() error = %v", err)
	}
	t.Cleanup(pool.Close)

	projectID, projectName, sku := stage10FCreateProject(t, ctx, pool)
	uploadStore := store.NewUploadStore(store.NewPGXDB(pool), t.TempDir(), 50<<20)
	filename := "库存分类账 2026-08一览视图.csv"
	firstCSV := stage10FBuildCSV(t, stage10FSummaryHeaders, [][]string{{
		"08/01/2026", "X00ABC", "B0001", sku, "First", "SELLABLE",
		"100", "0", "0", "5", "0", "0", "0", "0", "0", "0", "0", "0",
		"95", "0", "LAX1", "Bel-Bel",
	}})
	first := stage10FCommit(t, ctx, uploadStore, projectName, uploads.CommitRequest{
		ReportType:       "inventory_ledger_summary",
		OriginalFilename: stage10FStringPtr(filename),
		ProjectName:      stage10FStringPtr(projectName),
		Country:          "US",
	}, firstCSV)
	if first.RowsIngested == nil || *first.RowsIngested != 1 {
		t.Fatalf("first response = %#v", first)
	}

	duplicate := stage10FCommit(t, ctx, uploadStore, projectName, uploads.CommitRequest{
		ReportType:       "inventory_ledger_summary",
		OriginalFilename: stage10FStringPtr(filename),
		ProjectName:      stage10FStringPtr(projectName),
		Country:          "US",
	}, firstCSV)
	if duplicate.RowsIngested == nil || *duplicate.RowsIngested != 0 {
		t.Fatalf("duplicate response = %#v", duplicate)
	}
	if len(duplicate.DuplicateWarnings) == 0 {
		t.Fatal("identical re-upload did not return SHA-256 duplicate warning")
	}

	rewriteCSV := stage10FBuildCSV(t, stage10FSummaryHeaders, [][]string{{
		"08/01/2026", "X00ABC", "B0001", sku, "Rewrite", "SELLABLE",
		"100", "0", "0", "5", "0", "0", "0", "0", "0", "0", "0", "0",
		"90", "0", "LAX1", "Bel-Bel",
	}})
	rewrite := stage10FCommit(t, ctx, uploadStore, projectName, uploads.CommitRequest{
		ReportType:       "inventory_ledger_summary",
		OriginalFilename: stage10FStringPtr(filename),
		ProjectName:      stage10FStringPtr(projectName),
		Country:          "US",
	}, rewriteCSV)
	if rewrite.RowsIngested == nil || *rewrite.RowsIngested != 1 {
		t.Fatalf("rewrite response = %#v", rewrite)
	}

	if got := stage10FCount(t, ctx, pool, "inventory_ledger_summary", projectID); got != 1 {
		t.Fatalf("summary row count after rewrite = %d, want 1", got)
	}
	var endingBalance int
	if err := pool.QueryRow(
		ctx,
		`SELECT ending_balance FROM public.inventory_ledger_summary
		 WHERE project_id = $1 AND msku = $2 AND "date" = '2026-08-01'`,
		projectID,
		sku,
	).Scan(&endingBalance); err != nil {
		t.Fatalf("query rewritten summary: %v", err)
	}
	if endingBalance != 90 {
		t.Fatalf("ending balance after rewrite = %d, want 90", endingBalance)
	}
	if got := stage10FCount(t, ctx, pool, "inventory_ledger_ingest_batch", projectID); got != 2 {
		t.Fatalf("batch count after rewrite = %d, want 2", got)
	}
	if got := stage10FCount(t, ctx, pool, "analysis_source_files", projectID); got != 2 {
		t.Fatalf("source count after rewrite = %d, want 2", got)
	}
	if got := stage10FCurrentSourceCount(t, ctx, pool, projectID); got != 1 {
		t.Fatalf("current source count after rewrite = %d, want 1", got)
	}
}

func TestStage10FInventoryLedgerDetailNativeIngest(t *testing.T) {
	databaseURL := stage10FDatabaseURL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	pool, err := store.OpenPool(ctx, databaseURL)
	if err != nil {
		t.Fatalf("OpenPool() error = %v", err)
	}
	t.Cleanup(pool.Close)

	projectID, projectName, sku := stage10FCreateProject(t, ctx, pool)
	uploadStore := store.NewUploadStore(store.NewPGXDB(pool), t.TempDir(), 50<<20)
	filename := "库存分类账-2026-07详细视图.csv"
	detailCSV := stage10FBuildCSV(t, stage10FDetailHeaders, [][]string{
		{
			"07/10/2026", "X00ABC", "B0001", sku, "Detail", "Shipments",
			"REF-1", "-1", "LAX1", "SELLABLE", "", "US", "", "",
			"2026-07-10T00:00:00-0700", "",
		},
		{
			"07/10/2026", "X00ABC", "B0001", sku, "Detail", "Shipments",
			"REF-1", "-1", "LAX1", "SELLABLE", "", "US", "", "",
			"2026-07-10T00:00:00-0700", "",
		},
		{
			"07/10/2026", "X00ABC", "B0001", sku, "Detail", "CustomerReturns",
			"REF-2", "1", "LAX1", "SELLABLE", "", "US", "1", "0",
			"2026-07-10T09:30:00-0700", "",
		},
	})
	response := stage10FCommit(t, ctx, uploadStore, projectName, uploads.CommitRequest{
		ReportType:       "inventory_ledger_detail",
		OriginalFilename: stage10FStringPtr(filename),
		ProjectName:      stage10FStringPtr(projectName),
		Country:          "US",
	}, detailCSV)
	if response.RowsIngested == nil || *response.RowsIngested != 3 {
		t.Fatalf("detail response = %#v", response)
	}
	if response.PersistedTable == nil || *response.PersistedTable != "inventory_ledger_detail" {
		t.Fatalf("detail persisted table = %#v", response.PersistedTable)
	}
	if response.Message != "库存分类账明细视图已入库（3 行）" {
		t.Fatalf("detail message = %q", response.Message)
	}
	if got := stage10FCount(t, ctx, pool, "inventory_ledger_detail", projectID); got != 3 {
		t.Fatalf("detail row count = %d, want 3", got)
	}
	if got := stage10FCount(t, ctx, pool, "inventory_ledger_summary", projectID); got != 0 {
		t.Fatalf("summary row count = %d, want 0", got)
	}

	var reportMonth, eventDate, eventTime time.Time
	var quantity int
	var country string
	if err := pool.QueryRow(
		ctx,
		`SELECT report_month, "date", date_and_time, quantity, country
		 FROM public.inventory_ledger_detail
		 WHERE project_id = $1 AND reference_id = 'REF-1'
		 ORDER BY id
		 LIMIT 1`,
		projectID,
	).Scan(&reportMonth, &eventDate, &eventTime, &quantity, &country); err != nil {
		t.Fatalf("query detail row: %v", err)
	}
	if reportMonth.Format("2006-01-02") != "2026-07-01" ||
		eventDate.Format("2006-01-02") != "2026-07-10" ||
		quantity != -1 || country != "US" {
		t.Fatalf(
			"detail mapping = month:%s date:%s qty:%d country:%s",
			reportMonth.Format("2006-01-02"),
			eventDate.Format("2006-01-02"),
			quantity,
			country,
		)
	}
	if eventTime.IsZero() {
		t.Fatal("date_and_time was not persisted")
	}

	duplicate := stage10FCommit(t, ctx, uploadStore, projectName, uploads.CommitRequest{
		ReportType:       "inventory_ledger_detail",
		OriginalFilename: stage10FStringPtr(filename),
		ProjectName:      stage10FStringPtr(projectName),
		Country:          "US",
	}, detailCSV)
	if duplicate.RowsIngested == nil || *duplicate.RowsIngested != 0 {
		t.Fatalf("duplicate detail response = %#v", duplicate)
	}
	if got := stage10FCount(t, ctx, pool, "inventory_ledger_detail", projectID); got != 3 {
		t.Fatalf("detail row count after duplicate = %d, want 3", got)
	}
	if got := stage10FCount(t, ctx, pool, "inventory_ledger_ingest_batch", projectID); got != 1 {
		t.Fatalf("batch count after duplicate = %d, want 1", got)
	}
}

func TestStage10FInventoryLedgerLargeFileStreaming(t *testing.T) {
	databaseURL := stage10FDatabaseURL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	pool, err := store.OpenPool(ctx, databaseURL)
	if err != nil {
		t.Fatalf("OpenPool() error = %v", err)
	}
	t.Cleanup(pool.Close)

	projectID, projectName, sku := stage10FCreateProject(t, ctx, pool)
	uploadStore := store.NewUploadStore(store.NewPGXDB(pool), t.TempDir(), 50<<20)
	rows := make([][]string, 0, 5000)
	for index := 0; index < 5000; index++ {
		rowSKU := sku
		location := "LAX1"
		if index > 0 {
			rowSKU = fmt.Sprintf("BULK-%05d", index)
			if index%2 == 0 {
				location = "PHX3"
			}
		}
		rows = append(rows, []string{
			"08/01/2026", "X00ABC", "B0001", rowSKU, "Bulk", "SELLABLE",
			"100", "0", "0", "5", "0", "0", "0", "0", "0", "0", "0", "0",
			"95", "0", location, "Bel-Bel",
		})
	}
	summaryCSV := stage10FBuildCSV(t, stage10FSummaryHeaders, rows)
	started := time.Now()
	response := stage10FCommit(t, ctx, uploadStore, projectName, uploads.CommitRequest{
		ReportType:       "inventory_ledger_summary",
		OriginalFilename: stage10FStringPtr("库存分类账 2026-08一览视图.csv"),
		ProjectName:      stage10FStringPtr(projectName),
		Country:          "US",
	}, summaryCSV)
	if response.RowsIngested == nil || *response.RowsIngested != 5000 {
		t.Fatalf("large response = %#v", response)
	}
	elapsed := time.Since(started)
	if elapsed > 10*time.Second {
		t.Fatalf("5000-row ledger ingest took %s, want <= 10s", elapsed)
	}
	if got := stage10FCount(t, ctx, pool, "inventory_ledger_summary", projectID); got != 5000 {
		t.Fatalf("large summary row count = %d, want 5000", got)
	}
	var sourceRows int
	if err := pool.QueryRow(
		ctx,
		`SELECT row_count_total FROM public.analysis_source_files
		 WHERE project_id = $1 AND is_current IS TRUE`,
		projectID,
	).Scan(&sourceRows); err != nil {
		t.Fatalf("query large source row: %v", err)
	}
	if sourceRows != 5000 {
		t.Fatalf("large source row_count_total = %d, want 5000", sourceRows)
	}
}

func TestStage10FInventoryLedgerInvalidRowFailsClosed(t *testing.T) {
	databaseURL := stage10FDatabaseURL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	pool, err := store.OpenPool(ctx, databaseURL)
	if err != nil {
		t.Fatalf("OpenPool() error = %v", err)
	}
	t.Cleanup(pool.Close)

	projectID, projectName, sku := stage10FCreateProject(t, ctx, pool)
	uploadStore := store.NewUploadStore(store.NewPGXDB(pool), t.TempDir(), 50<<20)
	badCSV := stage10FBuildCSV(t, stage10FDetailHeaders, [][]string{
		{
			"07/10/2026", "X00ABC", "B0001", sku, "Detail", "Shipments",
			"REF-1", "-1", "LAX1", "SELLABLE", "", "US", "", "",
			"2026-07-10T00:00:00-0700", "",
		},
		{
			"07/10/2026", "X00ABC", "B0001", sku, "Detail", "Shipments",
			"REF-BAD", "not-an-integer", "LAX1", "SELLABLE", "", "US", "", "",
			"2026-07-10T00:00:00-0700", "",
		},
	})
	_, err = stage10FCommitMaybe(t, ctx, uploadStore, projectName, uploads.CommitRequest{
		ReportType:       "inventory_ledger_detail",
		OriginalFilename: stage10FStringPtr("库存分类账-2026-07详细视图.csv"),
		ProjectName:      stage10FStringPtr(projectName),
		Country:          "US",
	}, badCSV)
	var apiErr *uploads.APIError
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusUnprocessableEntity {
		t.Fatalf("invalid row error = %v, want typed 422", err)
	}
	for _, table := range []string{
		"inventory_ledger_detail",
		"inventory_ledger_summary",
		"inventory_ledger_ingest_batch",
		"analysis_source_files",
	} {
		if got := stage10FCount(t, ctx, pool, table, projectID); got != 0 {
			t.Fatalf("%s count after invalid row = %d, want 0", table, got)
		}
	}

	mismatchCSV := stage10FBuildCSV(t, stage10FDetailHeaders, [][]string{{
		"07/10/2026", "X00ABC", "B0001", sku, "Detail", "Shipments",
		"REF-1", "-1", "LAX1", "SELLABLE", "", "US", "", "",
		"2026-07-10T00:00:00-0700", "",
	}})
	_, err = stage10FCommitMaybe(t, ctx, uploadStore, projectName, uploads.CommitRequest{
		ReportType:       "inventory_ledger_summary",
		OriginalFilename: stage10FStringPtr("库存分类账-2026-07详细视图.csv"),
		ProjectName:      stage10FStringPtr(projectName),
		Country:          "US",
	}, mismatchCSV)
	if !errors.As(err, &apiErr) || apiErr.Status >= 500 {
		t.Fatalf("typed mismatch error = %v, want structured 4xx", err)
	}
	if got := stage10FCount(t, ctx, pool, "analysis_source_files", projectID); got != 0 {
		t.Fatalf("source count after typed mismatch = %d, want 0", got)
	}

	missingDateCSV := stage10FBuildCSV(t, stage10FSummaryHeaders, [][]string{{
		"", "X00ABC", "B0001", sku, "Missing date", "SELLABLE",
		"100", "0", "0", "5", "0", "0", "0", "0", "0", "0", "0", "0",
		"95", "0", "LAX1", "Bel-Bel",
	}})
	_, err = stage10FCommitMaybe(t, ctx, uploadStore, projectName, uploads.CommitRequest{
		ReportType:       "inventory_ledger_summary",
		OriginalFilename: stage10FStringPtr("99539020752.csv"),
		ProjectName:      stage10FStringPtr(projectName),
		Country:          "US",
	}, missingDateCSV)
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusUnprocessableEntity {
		t.Fatalf("missing date error = %v, want typed 422", err)
	}
	if got := stage10FCount(t, ctx, pool, "inventory_ledger_ingest_batch", projectID); got != 0 {
		t.Fatalf("batch count after missing date = %d, want 0", got)
	}
}

func TestStage10FInventoryLedgerRejectsInaccessibleProject(t *testing.T) {
	databaseURL := stage10FDatabaseURL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	pool, err := store.OpenPool(ctx, databaseURL)
	if err != nil {
		t.Fatalf("OpenPool() error = %v", err)
	}
	t.Cleanup(pool.Close)

	projectID, projectName, sku := stage10FCreateProject(t, ctx, pool)
	uploadStore := store.NewUploadStore(store.NewPGXDB(pool), t.TempDir(), 50<<20)
	summaryCSV := stage10FBuildCSV(t, stage10FSummaryHeaders, [][]string{{
		"08/01/2026", "X00ABC", "B0001", sku, "Permission", "SELLABLE",
		"100", "0", "0", "5", "0", "0", "0", "0", "0", "0", "0", "0",
		"95", "0", "LAX1", "Bel-Bel",
	}})
	saved, err := uploadStore.SaveReportTemp("库存分类账 2026-08一览视图.csv", []byte(summaryCSV))
	if err != nil {
		t.Fatalf("SaveReportTemp() error = %v", err)
	}
	_, err = uploadStore.CommitReport(ctx, uploads.CommitRequest{
		TempFileID:       saved.TempFileID,
		ReportType:       "inventory_ledger_summary",
		OriginalFilename: stage10FStringPtr("库存分类账 2026-08一览视图.csv"),
		ProjectName:      stage10FStringPtr(projectName),
		Country:          "US",
	}, "intruder", false)
	var apiErr *uploads.APIError
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusForbidden {
		t.Fatalf("permission error = %v, want 403", err)
	}
	for _, table := range []string{
		"inventory_ledger_summary",
		"inventory_ledger_ingest_batch",
		"analysis_source_files",
	} {
		if got := stage10FCount(t, ctx, pool, table, projectID); got != 0 {
			t.Fatalf("%s count after forbidden commit = %d, want 0", table, got)
		}
	}
}

func TestStage10FInventoryLedgerTransactionRollback(t *testing.T) {
	databaseURL := stage10FDatabaseURL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	pool, err := store.OpenPool(ctx, databaseURL)
	if err != nil {
		t.Fatalf("OpenPool() error = %v", err)
	}
	t.Cleanup(pool.Close)

	projectID, projectName, sku := stage10FCreateProject(t, ctx, pool)
	uploadStore := store.NewUploadStore(store.NewPGXDB(pool), t.TempDir(), 50<<20)
	collidingCSV := stage10FBuildCSV(t, stage10FSummaryHeaders, [][]string{
		{
			"08/01/2026", "X00ABC", "B0001", sku, "First", "SELLABLE",
			"100", "0", "0", "5", "0", "0", "0", "0", "0", "0", "0", "0",
			"95", "0", "LAX1", "Bel-Bel",
		},
		{
			"08/01/2026", "X00ABC", "B0001", sku, "Second", "SELLABLE",
			"100", "0", "0", "5", "0", "0", "0", "0", "0", "0", "0", "0",
			"90", "0", "LAX1", "Bel-Bel",
		},
	})
	_, err = stage10FCommitMaybe(t, ctx, uploadStore, projectName, uploads.CommitRequest{
		ReportType:       "inventory_ledger_summary",
		OriginalFilename: stage10FStringPtr("库存分类账 2026-08一览视图.csv"),
		ProjectName:      stage10FStringPtr(projectName),
		Country:          "US",
	}, collidingCSV)
	var apiErr *uploads.APIError
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusUnprocessableEntity {
		t.Fatalf("duplicate natural-key error = %v, want typed 422", err)
	}
	for _, table := range []string{
		"inventory_ledger_summary",
		"inventory_ledger_detail",
		"inventory_ledger_ingest_batch",
		"analysis_source_files",
	} {
		if got := stage10FCount(t, ctx, pool, table, projectID); got != 0 {
			t.Fatalf("%s count after transaction rollback = %d, want 0", table, got)
		}
	}
}

func TestStage10FInventoryLedgerDryRunSkipsWrites(t *testing.T) {
	databaseURL := stage10FDatabaseURL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	pool, err := store.OpenPool(ctx, databaseURL)
	if err != nil {
		t.Fatalf("OpenPool() error = %v", err)
	}
	t.Cleanup(pool.Close)

	projectID, projectName, sku := stage10FCreateProject(t, ctx, pool)
	uploadStore := store.NewUploadStore(store.NewPGXDB(pool), t.TempDir(), 50<<20)
	summaryCSV := stage10FBuildCSV(t, stage10FSummaryHeaders, [][]string{{
		"08/01/2026", "X00ABC", "B0001", sku, "Dry run", "SELLABLE",
		"100", "0", "0", "5", "0", "0", "0", "0", "0", "0", "0", "0",
		"95", "0", "LAX1", "Bel-Bel",
	}})
	response := stage10FCommit(t, ctx, uploadStore, projectName, uploads.CommitRequest{
		ReportType:       "inventory_ledger_summary",
		OriginalFilename: stage10FStringPtr("库存分类账 2026-08一览视图.csv"),
		ProjectName:      stage10FStringPtr(projectName),
		Country:          "US",
		DryRun:           true,
	}, summaryCSV)
	if response.Status != "skipped" {
		t.Fatalf("dry-run response = %#v", response)
	}
	for _, table := range []string{
		"inventory_ledger_summary",
		"inventory_ledger_ingest_batch",
		"analysis_source_files",
	} {
		if got := stage10FCount(t, ctx, pool, table, projectID); got != 0 {
			t.Fatalf("%s count after dry-run = %d, want 0", table, got)
		}
	}
}

func stage10FDatabaseURL(t *testing.T) string {
	t.Helper()
	databaseURL := os.Getenv("GO_API_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set GO_API_TEST_DATABASE_URL to a BLF_test connection")
	}
	return databaseURL
}

func stage10FCreateProject(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
) (int64, string, string) {
	t.Helper()
	projectName := fmt.Sprintf("stage10f-ledger-%d", time.Now().UnixNano())
	sku := fmt.Sprintf("STAGE10F-%d", time.Now().UnixNano())
	var projectID int64
	if err := pool.QueryRow(
		ctx,
		`INSERT INTO public.projects (
		   project_name, sort_order, project_operator, country, is_active
		 ) VALUES ($1, 999999, 'stage10f-operator', 'US', true)
		 RETURNING id`,
		projectName,
	).Scan(&projectID); err != nil {
		t.Fatalf("insert project: %v", err)
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO public.product_costs (
		   project_id, project_name, sku, asin, country,
		   fob_unit_cost, first_leg_cost_rmb,
		   package_length_cm, package_width_cm, package_height_cm, weight_kg,
		   is_active
		 ) VALUES ($1, $2, $3, 'B0001', 'US', 10, 2, 10, 8, 5, 0.5, true)`,
		projectID,
		projectName,
		sku,
	); err != nil {
		t.Fatalf("insert product master: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM public.product_costs WHERE project_id = $1`, projectID)
		_, _ = pool.Exec(cleanupCtx, `DELETE FROM public.projects WHERE id = $1`, projectID)
	})
	return projectID, projectName, sku
}

func stage10FBuildCSV(t *testing.T, headers []string, rows [][]string) string {
	t.Helper()
	var buffer bytes.Buffer
	writer := csv.NewWriter(&buffer)
	if err := writer.Write(headers); err != nil {
		t.Fatalf("write CSV headers: %v", err)
	}
	for _, row := range rows {
		if len(row) != len(headers) {
			t.Fatalf("CSV row has %d cells, want %d", len(row), len(headers))
		}
		if err := writer.Write(row); err != nil {
			t.Fatalf("write CSV row: %v", err)
		}
	}
	writer.Flush()
	if err := writer.Error(); err != nil {
		t.Fatalf("flush CSV: %v", err)
	}
	return buffer.String()
}

func stage10FCommit(
	t *testing.T,
	ctx context.Context,
	uploadStore *store.UploadStore,
	projectName string,
	payload uploads.CommitRequest,
	csvContent string,
) uploads.CommitResponse {
	t.Helper()
	response, err := stage10FCommitMaybe(t, ctx, uploadStore, projectName, payload, csvContent)
	if err != nil {
		t.Fatalf("CommitReport() error = %v", err)
	}
	return response
}

func stage10FCommitMaybe(
	t *testing.T,
	ctx context.Context,
	uploadStore *store.UploadStore,
	projectName string,
	payload uploads.CommitRequest,
	csvContent string,
) (uploads.CommitResponse, error) {
	t.Helper()
	filename := projectName + ".csv"
	if payload.OriginalFilename != nil {
		filename = *payload.OriginalFilename
	}
	saved, err := uploadStore.SaveReportTemp(filename, []byte(csvContent))
	if err != nil {
		t.Fatalf("SaveReportTemp() error = %v", err)
	}
	payload.TempFileID = saved.TempFileID
	if payload.OriginalFilename == nil {
		payload.OriginalFilename = stage10FStringPtr(filename)
	}
	return uploadStore.CommitReport(ctx, payload, "stage10f-operator", true)
}

func stage10FStringPtr(value string) *string {
	return &value
}

func stage10FCount(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	table string,
	projectID int64,
) int64 {
	t.Helper()
	var query string
	switch table {
	case "inventory_ledger_summary":
		query = `SELECT count(*) FROM public.inventory_ledger_summary WHERE project_id = $1`
	case "inventory_ledger_detail":
		query = `SELECT count(*) FROM public.inventory_ledger_detail WHERE project_id = $1`
	case "inventory_ledger_ingest_batch":
		query = `SELECT count(*) FROM public.inventory_ledger_ingest_batch WHERE project_id = $1`
	case "analysis_source_files":
		query = `SELECT count(*) FROM public.analysis_source_files WHERE project_id = $1`
	case "report_upload_statuses":
		query = `SELECT count(*) FROM public.report_upload_statuses WHERE project_id = $1`
	case "report_upload_logs":
		query = `SELECT count(*) FROM public.report_upload_logs WHERE project_id = $1`
	default:
		t.Fatalf("unsupported count table %q", table)
	}
	var count int64
	if err := pool.QueryRow(ctx, query, projectID).Scan(&count); err != nil {
		t.Fatalf("count %s: %v", table, err)
	}
	return count
}

func stage10FCurrentSourceCount(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	projectID int64,
) int64 {
	t.Helper()
	var count int64
	if err := pool.QueryRow(
		ctx,
		`SELECT count(*) FROM public.analysis_source_files
		 WHERE project_id = $1 AND is_current IS TRUE`,
		projectID,
	).Scan(&count); err != nil {
		t.Fatalf("count current ledger sources: %v", err)
	}
	return count
}
