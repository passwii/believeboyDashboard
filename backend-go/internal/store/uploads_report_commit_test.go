package store

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
)

var commitConflictSummaryHeaders = []string{
	"Date", "FNSKU", "ASIN", "MSKU", "Title", "Disposition",
	"Starting Warehouse Balance", "In Transit Between Warehouses",
	"Receipts", "Customer Shipments", "Customer Returns", "Vendor Returns",
	"Warehouse Transfer In/Out", "Found", "Lost", "Damaged", "Disposed",
	"Other Events", "Ending Warehouse Balance", "Unknown Events",
	"Location", "Store",
}

// TestCommitReportConflictProjectOverride guards the report-upload contract
// where a conflict recognition must accept an explicitly selected candidate
// project. Before the fix, any explicit project_name was rejected unless the
// freshly recognized match was "matched", so the frontend conflict dropdown
// could never submit.
func TestCommitReportConflictProjectOverride(t *testing.T) {
	databaseURL := os.Getenv("GO_API_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set GO_API_TEST_DATABASE_URL to a BLF_test connection")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	pool, err := OpenPool(ctx, databaseURL)
	if err != nil {
		t.Fatalf("OpenPool() error = %v", err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("test database unavailable: %v", err)
	}

	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	shortSuffix := suffix[len(suffix)-10:]
	sharedSKU := "CF-SKU-" + shortSuffix
	projectAID, projectAName := createCommitFixtureProject(t, ctx, pool, "a", suffix, "operator-a-"+shortSuffix)
	projectBID, projectBName := createCommitFixtureProject(t, ctx, pool, "b", suffix, "operator-b-"+shortSuffix)
	projectCID, projectCName := createCommitFixtureProject(t, ctx, pool, "c", suffix, "operator-a-"+shortSuffix)
	insertCommitFixtureProduct(t, ctx, pool, projectAID, projectAName, sharedSKU, "B0CONFLICTA")
	insertCommitFixtureProduct(t, ctx, pool, projectBID, projectBName, sharedSKU, "B0CONFLICTB")
	insertCommitFixtureProduct(t, ctx, pool, projectBID, projectBName, "B-ONLY-"+shortSuffix, "B0ONLYB")

	uploadStore := NewUploadStore(NewPGXDB(pool), t.TempDir(), 50<<20)
	conflictCSV := buildCommitLedgerCSV(t, sharedSKU)
	matchedCSV := buildCommitLedgerCSV(t, "B-ONLY-"+shortSuffix)
	unmatchedCSV := buildCommitLedgerCSV(t, "UNKNOWN-"+shortSuffix)
	filename := "库存分类账 2026-08一览视图.csv"

	t.Run("conflict candidate selection persists", func(t *testing.T) {
		saved, err := uploadStore.SaveReportTemp(filename, []byte(conflictCSV))
		if err != nil {
			t.Fatalf("SaveReportTemp() error = %v", err)
		}
		recognized, err := uploadStore.RecognizeReport(ctx, saved, "US", "", true)
		if err != nil {
			t.Fatalf("RecognizeReport() error = %v", err)
		}
		if recognized.ProjectMatch.Status != "conflict" ||
			len(recognized.ProjectMatch.CandidateProjects) != 2 {
			t.Fatalf("project match = %#v, want conflict with two candidates", recognized.ProjectMatch)
		}

		response, err := uploadStore.CommitReport(ctx, uploads.CommitRequest{
			TempFileID:       saved.TempFileID,
			ReportType:       "inventory_ledger_summary",
			OriginalFilename: &filename,
			ProjectName:      &projectAName,
			Country:          "US",
		}, "", true)
		if err != nil {
			t.Fatalf("CommitReport() error = %v", err)
		}
		if response.Status != "persisted" || response.ProjectName == nil ||
			*response.ProjectName != projectAName {
			t.Fatalf("commit response = %#v, want persisted for %q", response, projectAName)
		}
		if response.RowsIngested == nil || *response.RowsIngested != 1 {
			t.Fatalf("rows ingested = %#v, want 1", response.RowsIngested)
		}
		if got := commitFixtureLedgerRows(t, ctx, pool, projectAID); got != 1 {
			t.Fatalf("project A ledger rows = %d, want 1", got)
		}
		if got := commitFixtureLedgerRows(t, ctx, pool, projectBID); got != 0 {
			t.Fatalf("project B ledger rows = %d, want 0", got)
		}
	})

	t.Run("conflict non candidate project stays rejected", func(t *testing.T) {
		_, err := commitFixtureCSV(t, ctx, uploadStore, filename, conflictCSV, uploads.CommitRequest{
			ReportType:  "inventory_ledger_summary",
			ProjectName: &projectCName,
			Country:     "US",
		}, "operator-a-"+shortSuffix, true)
		var apiErr *uploads.APIError
		if !errors.As(err, &apiErr) || apiErr.Status != http.StatusUnprocessableEntity {
			t.Fatalf("non-candidate error = %v, want 422", err)
		}
		if got := commitFixtureLedgerRows(t, ctx, pool, projectCID); got != 0 {
			t.Fatalf("project C ledger rows after rejected commit = %d, want 0", got)
		}
	})

	t.Run("conflict unauthorized candidate stays forbidden", func(t *testing.T) {
		_, err := commitFixtureCSV(t, ctx, uploadStore, filename, conflictCSV, uploads.CommitRequest{
			ReportType:  "inventory_ledger_summary",
			ProjectName: &projectAName,
			Country:     "US",
		}, "outsider-"+suffix, false)
		var apiErr *uploads.APIError
		if !errors.As(err, &apiErr) || apiErr.Status != http.StatusForbidden {
			t.Fatalf("unauthorized candidate error = %v, want 403", err)
		}
	})

	t.Run("matched explicit project still works", func(t *testing.T) {
		response, err := commitFixtureCSV(t, ctx, uploadStore, filename, matchedCSV, uploads.CommitRequest{
			ReportType:  "inventory_ledger_summary",
			ProjectName: &projectBName,
			Country:     "US",
		}, "", true)
		if err != nil {
			t.Fatalf("CommitReport() error = %v", err)
		}
		if response.Status != "persisted" || response.ProjectName == nil ||
			*response.ProjectName != projectBName {
			t.Fatalf("commit response = %#v, want persisted for %q", response, projectBName)
		}
		if got := commitFixtureLedgerRows(t, ctx, pool, projectBID); got != 1 {
			t.Fatalf("project B ledger rows = %d, want 1", got)
		}
	})

	t.Run("matched project cannot be overridden by another project", func(t *testing.T) {
		_, err := commitFixtureCSV(t, ctx, uploadStore, filename, matchedCSV, uploads.CommitRequest{
			ReportType:  "inventory_ledger_summary",
			ProjectName: &projectAName,
			Country:     "US",
		}, "", true)
		var apiErr *uploads.APIError
		if !errors.As(err, &apiErr) || apiErr.Status != http.StatusUnprocessableEntity {
			t.Fatalf("matched override error = %v, want 422", err)
		}
	})

	t.Run("unmatched stays rejected", func(t *testing.T) {
		for _, name := range []*string{&projectAName, nil} {
			_, err := commitFixtureCSV(t, ctx, uploadStore, filename, unmatchedCSV, uploads.CommitRequest{
				ReportType:  "inventory_ledger_summary",
				ProjectName: name,
				Country:     "US",
			}, "", true)
			var apiErr *uploads.APIError
			if !errors.As(err, &apiErr) || apiErr.Status != http.StatusUnprocessableEntity {
				t.Fatalf("unmatched error (project=%v) = %v, want 422", name != nil, err)
			}
		}
	})
}

func createCommitFixtureProject(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	label string,
	suffix string,
	operator string,
) (int64, string) {
	t.Helper()
	projectName := "commit-conflict-" + label + "-" + suffix
	var projectID int64
	if err := pool.QueryRow(
		ctx,
		`INSERT INTO public.projects (
		   project_name, sort_order, project_operator, country, is_active
		 ) VALUES ($1, 999999, $2, 'US', true)
		 RETURNING id`,
		projectName,
		operator,
	).Scan(&projectID); err != nil {
		t.Fatalf("insert project %s: %v", label, err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if _, err := pool.Exec(
			cleanupCtx,
			`DELETE FROM public.product_costs WHERE project_id = $1`,
			projectID,
		); err != nil {
			t.Errorf("cleanup product_costs for project %d: %v", projectID, err)
		}
		if _, err := pool.Exec(
			cleanupCtx,
			`DELETE FROM public.projects WHERE id = $1`,
			projectID,
		); err != nil {
			t.Errorf("cleanup project %d: %v", projectID, err)
		}
	})
	return projectID, projectName
}

func insertCommitFixtureProduct(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	projectID int64,
	projectName string,
	sku string,
	asin string,
) {
	t.Helper()
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO public.product_costs (
		   project_id, project_name, sku, asin, country, fob_unit_cost, is_active
		 ) VALUES ($1, $2, $3, $4, 'US', 10, true)`,
		projectID,
		projectName,
		sku,
		asin,
	); err != nil {
		t.Fatalf("insert product %s/%s: %v", projectName, sku, err)
	}
}

func buildCommitLedgerCSV(t *testing.T, sku string) string {
	t.Helper()
	var buffer bytes.Buffer
	writer := csv.NewWriter(&buffer)
	if err := writer.Write(commitConflictSummaryHeaders); err != nil {
		t.Fatalf("write CSV headers: %v", err)
	}
	row := []string{
		"08/2026", "X00ABC", "B0001", sku, "Conflict fixture", "SELLABLE",
		"100", "0", "0", "5", "0", "0", "0", "0", "0", "0", "0", "0",
		"95", "0", "LAX1", "Bel-Bel",
	}
	if len(row) != len(commitConflictSummaryHeaders) {
		t.Fatalf("CSV row has %d cells, want %d", len(row), len(commitConflictSummaryHeaders))
	}
	if err := writer.Write(row); err != nil {
		t.Fatalf("write CSV row: %v", err)
	}
	writer.Flush()
	if err := writer.Error(); err != nil {
		t.Fatalf("flush CSV: %v", err)
	}
	return buffer.String()
}

func commitFixtureCSV(
	t *testing.T,
	ctx context.Context,
	uploadStore *UploadStore,
	filename string,
	content string,
	payload uploads.CommitRequest,
	operator string,
	isAdmin bool,
) (uploads.CommitResponse, error) {
	t.Helper()
	saved, err := uploadStore.SaveReportTemp(filename, []byte(content))
	if err != nil {
		t.Fatalf("SaveReportTemp() error = %v", err)
	}
	payload.TempFileID = saved.TempFileID
	if payload.OriginalFilename == nil {
		payload.OriginalFilename = &filename
	}
	return uploadStore.CommitReport(ctx, payload, operator, isAdmin)
}

func commitFixtureLedgerRows(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	projectID int64,
) int64 {
	t.Helper()
	var count int64
	if err := pool.QueryRow(
		ctx,
		`SELECT count(*) FROM public.inventory_ledger_summary WHERE project_id = $1`,
		projectID,
	).Scan(&count); err != nil {
		t.Fatalf("count ledger rows for project %d: %v", projectID, err)
	}
	return count
}
