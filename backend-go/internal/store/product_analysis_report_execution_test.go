package store

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

type productAnalysisReportTestDB struct {
	row pgx.Row
}

func (*productAnalysisReportTestDB) Query(
	context.Context,
	string,
	...any,
) (Rows, error) {
	return &productAnalysisReportTestRows{}, nil
}

func (db *productAnalysisReportTestDB) QueryRow(
	context.Context,
	string,
	...any,
) pgx.Row {
	return db.row
}

func (*productAnalysisReportTestDB) Ping(context.Context) error {
	return nil
}

type productAnalysisReportTestRows struct{}

func (*productAnalysisReportTestRows) Next() bool { return false }
func (*productAnalysisReportTestRows) Scan(...any) error {
	return nil
}
func (*productAnalysisReportTestRows) Err() error { return nil }
func (*productAnalysisReportTestRows) Close()     {}

type productAnalysisReportTestRow struct {
	values []any
}

func (row productAnalysisReportTestRow) Scan(dest ...any) error {
	if len(dest) != len(row.values) {
		return errors.New("scan destination count mismatch")
	}
	for index, target := range dest {
		switch typed := target.(type) {
		case *int64:
			*typed = row.values[index].(int64)
		case *string:
			*typed = row.values[index].(string)
		case **string:
			*typed = nil
		default:
			return fmt.Errorf("unsupported scan destination %T", target)
		}
	}
	return nil
}

func TestRunProductAnalysisFilesRejectsProjectMetadataMismatch(t *testing.T) {
	db := &productAnalysisReportTestDB{
		row: productAnalysisReportTestRow{values: []any{
			int64(7),
			"Different Project",
			(*string)(nil),
			(*string)(nil),
		}},
	}
	_, err := RunProductAnalysisFiles(
		context.Background(),
		db,
		ProductAnalysisFilesInput{
			ProjectID:       7,
			ProjectName:     "Project A",
			Country:         "US",
			ReportStartDate: "2026-10-26",
			ReportEndDate:   "2026-11-01",
			UploadRoot:      t.TempDir(),
		},
	)
	if err == nil || !strings.Contains(err.Error(), "metadata does not match") {
		t.Fatalf("RunProductAnalysisFiles() error = %v", err)
	}
}

func TestRunProductAnalysisFilesRejectsPathOutsideUploadRoot(t *testing.T) {
	uploadRoot := t.TempDir()
	validPaths := map[string]string{
		"business_report": filepath.Join(uploadRoot, "business.csv"),
		"payment_report":  filepath.Join(uploadRoot, "payment.csv"),
		"ad_report":       filepath.Join(uploadRoot, "ad.xlsx"),
	}
	for _, path := range validPaths {
		if err := os.WriteFile(path, []byte("fixture"), 0o600); err != nil {
			t.Fatalf("write fixture %s: %v", path, err)
		}
	}
	outside := filepath.Join(t.TempDir(), "inventory.csv")
	if err := os.WriteFile(outside, []byte("outside"), 0o600); err != nil {
		t.Fatalf("write outside fixture: %v", err)
	}
	validPaths["inventory_report"] = outside

	db := &productAnalysisReportTestDB{
		row: productAnalysisReportTestRow{values: []any{
			int64(7),
			"Project A",
			(*string)(nil),
			(*string)(nil),
		}},
	}
	_, err := RunProductAnalysisFiles(
		context.Background(),
		db,
		ProductAnalysisFilesInput{
			ProjectID:       7,
			ProjectName:     "Project A",
			Country:         "US",
			ReportStartDate: "2026-10-26",
			ReportEndDate:   "2026-11-01",
			UploadRoot:      uploadRoot,
			ReportPaths:     validPaths,
		},
	)
	if err == nil ||
		!strings.Contains(err.Error(), "inventory_report file is unavailable") {
		t.Fatalf("RunProductAnalysisFiles() error = %v, want upload-root rejection", err)
	}
}

func TestRunProductAnalysisFilesRejectsSymlinkReport(t *testing.T) {
	uploadRoot := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside.csv")
	if err := os.WriteFile(outside, []byte("outside"), 0o600); err != nil {
		t.Fatalf("write outside fixture: %v", err)
	}
	symlinkPath := filepath.Join(uploadRoot, "business.csv")
	if err := os.Symlink(outside, symlinkPath); err != nil {
		t.Fatalf("create symlink: %v", err)
	}
	for _, name := range []string{"payment.csv", "ad.xlsx"} {
		if err := os.WriteFile(filepath.Join(uploadRoot, name), []byte("fixture"), 0o600); err != nil {
			t.Fatalf("write fixture %s: %v", name, err)
		}
	}

	db := &productAnalysisReportTestDB{
		row: productAnalysisReportTestRow{values: []any{
			int64(7),
			"Project A",
			(*string)(nil),
			(*string)(nil),
		}},
	}
	_, err := RunProductAnalysisFiles(
		context.Background(),
		db,
		ProductAnalysisFilesInput{
			ProjectID:       7,
			ProjectName:     "Project A",
			Country:         "US",
			ReportStartDate: "2026-10-26",
			ReportEndDate:   "2026-11-01",
			UploadRoot:      uploadRoot,
			ReportPaths: map[string]string{
				"business_report": symlinkPath,
				"payment_report":  filepath.Join(uploadRoot, "payment.csv"),
				"ad_report":       filepath.Join(uploadRoot, "ad.xlsx"),
			},
		},
	)
	if err == nil ||
		!strings.Contains(err.Error(), "business_report file is unavailable") {
		t.Fatalf("RunProductAnalysisFiles() error = %v, want symlink rejection", err)
	}
}
