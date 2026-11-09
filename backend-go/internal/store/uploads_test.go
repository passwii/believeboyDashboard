package store

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

func TestUploadStorePathHelpersRejectEscapeAndAllowSafeTemp(t *testing.T) {
	root := t.TempDir()
	store := NewUploadStore(nil, root, 1024)
	saved, err := store.SaveReportTemp("report.csv", []byte("sku,col\nA,1\n"))
	if err != nil {
		t.Fatal(err)
	}
	resolved, err := store.ResolveUploadTempPath(saved.TempFileID)
	if err != nil {
		t.Fatalf("safe temp resolve error = %v", err)
	}
	resolvedRoot, err := resolveRootForContainment(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := relativeInside(resolvedRoot, resolved); err != nil {
		t.Fatalf("resolved path escaped root: %v", err)
	}
	for _, value := range []string{"../report.csv", "/etc/passwd", `..\report.csv`} {
		if _, err := store.ResolveUploadTempPath(value); err == nil {
			t.Fatalf("ResolveUploadTempPath(%q) accepted traversal input", value)
		}
	}
	outside := filepath.Join(t.TempDir(), "outside.csv")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	linkPath := filepath.Join(root, reportTempDirectory, "escape.csv")
	if err := os.Symlink(outside, linkPath); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if _, err := store.ResolveUploadTempPath("escape.csv"); err == nil {
		t.Fatal("symlink outside upload root was accepted")
	}
}

func TestUploadStorePrepareUsesSanitizedControlledProjectPath(t *testing.T) {
	root := t.TempDir()
	store := NewUploadStore(nil, root, 1024)
	prepared, err := store.PrepareGenericUpload(
		`../../evil.csv`,
		`北美/../project`,
		`business_report`,
	)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(prepared.ObjectKey, "../") {
		t.Fatalf("object key = %q", prepared.ObjectKey)
	}
	if !strings.HasPrefix(prepared.ObjectKey, "北美-..-project/business-report/") {
		t.Fatalf("object key = %q", prepared.ObjectKey)
	}
	if _, err := relativeInside(root, prepared.LocalPath); err != nil {
		t.Fatalf("prepared local path escaped root: %v", err)
	}
}

func TestUploadStoreRecognizesCSVAndScansProjectMatchSQL(t *testing.T) {
	root := t.TempDir()
	data := []byte("（子）ASIN,页面浏览量 - 总计,已订购商品数量,会话数 - 总计,已订购商品销售额\nB001,10,2,3,USD 20.00\n")
	db := &fakeDB{rowsQueueQuery: []Rows{
		&fakeRows{batches: [][]any{{int64(7), "北美", 1}}},
		&fakeRows{batches: [][]any{{"北美", "B001"}}},
	}}
	store := NewUploadStore(&fakeWriteDB{fakeDB: db}, root, 1024)
	saved, err := store.SaveReportTemp("business.csv", data)
	if err != nil {
		t.Fatal(err)
	}
	response, err := store.RecognizeReport(context.Background(), saved, "US", "运营甲", false)
	if err != nil {
		t.Fatal(err)
	}
	if response.Status != "recognized" || response.ReportType != "business_report" ||
		response.ProjectMatch.Status != "matched" {
		t.Fatalf("response = %#v", response)
	}
	if len(db.queryCalls) != 2 || !strings.Contains(db.queryCalls[1].sql, "upper(s.asin) = ANY($1)") {
		t.Fatalf("query calls = %#v", db.queryCalls)
	}
}

func TestUploadStoreStatusScansSourceAndFileOnlyRows(t *testing.T) {
	now := time.Date(2026, 11, 8, 8, 0, 0, 0, time.UTC)
	day := time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC)
	db := &fakeDB{rowsQueueQuery: []Rows{
		&fakeRows{batches: [][]any{{int64(7), "北美", 1}}},
		&fakeRows{batches: [][]any{{"北美"}}},
		&uploadStatusRows{values: []any{
			int64(1), int64(7), "sales_report", pgtype.Date{},
			pgtype.Date{Time: day, Valid: true}, pgtype.Date{Time: day, Valid: true},
			now, (*string)(nil),
		}},
		&uploadStatusRows{values: []any{
			int64(7), "ad_search_term_report", pgtype.Date{Time: day, Valid: true},
			now, (*string)(nil),
		}},
	}}
	store := NewUploadStore(&fakeWriteDB{fakeDB: db}, t.TempDir(), 1024)
	response, err := store.ListReportStatus(context.Background(), nil, "运营甲", "US", false)
	if err != nil {
		t.Fatal(err)
	}
	if len(response.Items) != 1 {
		t.Fatalf("items = %#v", response.Items)
	}
	if response.Items[0].Statuses["sales_report"].Status != "available" ||
		response.Items[0].Statuses["ad_search_term_report"].Status != "saved_only" {
		t.Fatalf("statuses = %#v", response.Items[0].Statuses)
	}
}

type uploadStatusRows struct {
	values []any
	done   bool
}

func (rows *uploadStatusRows) Next() bool {
	if rows.done {
		return false
	}
	rows.done = true
	return true
}

func (rows *uploadStatusRows) Scan(dest ...any) error {
	if len(dest) != len(rows.values) {
		return errors.New("upload status scan destination count mismatch")
	}
	for index, value := range rows.values {
		switch target := dest[index].(type) {
		case *int64:
			*target = value.(int64)
		case *string:
			text, _ := value.(string)
			*target = text
		case **string:
			if value == nil {
				*target = nil
			} else if typed, ok := value.(*string); ok {
				*target = typed
			} else {
				text := value.(string)
				*target = &text
			}
		case *pgtype.Date:
			*target = value.(pgtype.Date)
		case *pgtype.Timestamptz:
			if value == nil {
				*target = pgtype.Timestamptz{}
			} else {
				*target = pgtype.Timestamptz{Time: value.(time.Time), Valid: true}
			}
		default:
			return errors.New("unsupported upload status scan destination")
		}
	}
	return nil
}

func (*uploadStatusRows) Err() error { return nil }
func (*uploadStatusRows) Close()     {}
