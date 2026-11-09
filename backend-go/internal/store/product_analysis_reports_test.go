package store

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/product_analysis_reports"
)

func productAnalysisTestTimestamp() time.Time {
	return time.Date(2026, 11, 8, 1, 2, 3, 0, time.UTC)
}

func productAnalysisStringPointer(value string) *string {
	return &value
}

func TestProductAnalysisReportStoreCreateTaskPersistsJobPayload(t *testing.T) {
	now := productAnalysisTestTimestamp()
	db := &fakeWriteDB{fakeDB: &fakeDB{
		rowsQueue: []pgx.Row{
			fakeRow{values: []any{
				int64(7),
				productAnalysisStringPointer("alice"),
				productAnalysisStringPointer("bob"),
			}},
			fakeRow{values: []any{
				int64(42),
				"pending",
				now,
				now,
			}},
		},
	}}
	store := NewProductAnalysisReportStoreWithUploadRoot(db, "/tmp/product-analysis-uploads")
	inventoryID := "inventory.txt"

	task, err := store.CreateTask(context.Background(), product_analysis_reports.CreateInput{
		ProjectName:           "Project A",
		ReportStartDate:       "2026-10-01",
		ReportEndDate:         "2026-10-31",
		BusinessReportFileID:  "business.csv",
		PaymentReportFileID:   "payment.csv",
		AdReportFileID:        "ads.xlsx",
		InventoryReportFileID: &inventoryID,
		Country:               "US",
		Operator:              "alice",
	})
	if err != nil {
		t.Fatalf("CreateTask() error = %v", err)
	}
	if task.ID != 42 || task.Status != "pending" ||
		task.CreatedAt != "2026-11-08T01:02:03Z" {
		t.Fatalf("task = %#v", task)
	}
	if len(db.queryRowCalls) != 2 {
		t.Fatalf("query row calls = %#v", db.queryRowCalls)
	}
	projectQuery := strings.ToLower(db.queryRowCalls[0].sql)
	if !strings.Contains(projectQuery, "from public.projects") ||
		!strings.Contains(projectQuery, "project_operator") {
		t.Fatalf("project query = %s", db.queryRowCalls[0].sql)
	}
	insert := db.queryRowCalls[1]
	insertSQL := strings.ToLower(insert.sql)
	if !strings.Contains(insertSQL, "insert into public.jobs") ||
		!strings.Contains(insertSQL, "returning id") {
		t.Fatalf("job insert = %s", insert.sql)
	}
	if len(insert.args) != 3 ||
		insert.args[0] != product_analysis_reports.JobType {
		t.Fatalf("job insert args = %#v", insert.args)
	}
	payloadBytes, ok := insert.args[1].([]byte)
	if !ok {
		t.Fatalf("payload type = %T", insert.args[1])
	}
	var payload struct {
		JobType string `json:"job_type"`
		FileID  string `json:"file_id"`
		Params  struct {
			ProjectID         int64             `json:"project_id"`
			ProjectName       string            `json:"project_name"`
			ReportStartDate   string            `json:"report_start_date"`
			ReportEndDate     string            `json:"report_end_date"`
			Country           string            `json:"country"`
			FileIDs           map[string]string `json:"file_ids"`
			ResolvedFilePaths map[string]string `json:"resolved_file_paths"`
			Operator          string            `json:"operator"`
		} `json:"params"`
	}
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if payload.JobType != product_analysis_reports.JobType ||
		payload.FileID != "business.csv" ||
		payload.Params.ProjectID != 7 ||
		payload.Params.ProjectName != "Project A" ||
		payload.Params.Country != "US" ||
		payload.Params.Operator != "alice" {
		t.Fatalf("payload = %#v", payload)
	}
	if payload.Params.FileIDs["inventory_report"] != "inventory.txt" ||
		payload.Params.FileIDs["ad_report"] != "ads.xlsx" {
		t.Fatalf("file ids = %#v", payload.Params.FileIDs)
	}
	// The upload root is resolved with filepath.Abs, so the expected paths must be
	// built the same way instead of being pinned to POSIX separators and "/tmp".
	uploadRoot, err := filepath.Abs("/tmp/product-analysis-uploads")
	if err != nil {
		t.Fatalf("resolve upload root: %v", err)
	}
	projectPrefix := filepath.Join(uploadRoot, "Project-A") + string(filepath.Separator)
	for reportType, path := range payload.Params.ResolvedFilePaths {
		if !strings.HasPrefix(path, projectPrefix) {
			t.Fatalf("%s path = %q", reportType, path)
		}
		if strings.Contains(path, "..") {
			t.Fatalf("%s path contains traversal: %q", reportType, path)
		}
	}
	wantAdReport := filepath.Join(uploadRoot, "Project-A", "ad-product-report", "ads.xlsx")
	if payload.Params.ResolvedFilePaths["ad_report"] != wantAdReport {
		t.Fatalf(
			"ad path = %q, want %q",
			payload.Params.ResolvedFilePaths["ad_report"],
			wantAdReport,
		)
	}
}

func TestProductAnalysisReportStoreCreateTaskRejectsProjectAccess(t *testing.T) {
	db := &fakeWriteDB{fakeDB: &fakeDB{
		rowsQueue: []pgx.Row{
			fakeRow{values: []any{
				int64(7),
				productAnalysisStringPointer("bob"),
				(*string)(nil),
			}},
		},
	}}
	store := NewProductAnalysisReportStoreWithUploadRoot(db, "/tmp/uploads")
	_, err := store.CreateTask(context.Background(), product_analysis_reports.CreateInput{
		ProjectName:          "Project A",
		ReportStartDate:      "2026-10-01",
		ReportEndDate:        "2026-10-31",
		BusinessReportFileID: "business.csv",
		PaymentReportFileID:  "payment.csv",
		AdReportFileID:       "ads.xlsx",
		Country:              "US",
		Operator:             "alice",
	})
	if !errors.Is(err, product_analysis_reports.ErrProjectForbidden) {
		t.Fatalf("CreateTask() error = %v, want ErrProjectForbidden", err)
	}
	if len(db.queryRowCalls) != 1 {
		t.Fatalf("query row calls = %d, want no insert", len(db.queryRowCalls))
	}
}

func TestProductAnalysisReportStoreCreateTaskProjectNotFound(t *testing.T) {
	db := &fakeWriteDB{fakeDB: &fakeDB{
		row: fakeRow{err: pgx.ErrNoRows},
	}}
	store := NewProductAnalysisReportStoreWithUploadRoot(db, "/tmp/uploads")
	_, err := store.CreateTask(context.Background(), product_analysis_reports.CreateInput{
		ProjectName:          "Missing",
		BusinessReportFileID: "business.csv",
		PaymentReportFileID:  "payment.csv",
		AdReportFileID:       "ads.xlsx",
		Operator:             "alice",
	})
	if !errors.Is(err, product_analysis_reports.ErrProjectNotFound) {
		t.Fatalf("CreateTask() error = %v, want ErrProjectNotFound", err)
	}
}

func TestProductAnalysisReportStoreGetTaskMapsRunProgress(t *testing.T) {
	now := productAnalysisTestTimestamp()
	errorMessage := "parser warning"
	resultPath := "project-a/product-analysis/42/result.xlsx"
	logExcerpt := `{"stage":"processing","progress":65,"message":"处理中：写入 PT1","persistence_status":"running","persistence_message":"pt1 persistence"}`
	db := &fakeWriteDB{fakeDB: &fakeDB{
		rowsQueue: []pgx.Row{
			fakeRow{values: []any{
				int64(42),
				"running",
				now,
				now,
				"Project A",
				int64(7),
				int64(7),
				productAnalysisStringPointer("alice"),
				productAnalysisStringPointer("bob"),
				logExcerpt,
				&errorMessage,
				&resultPath,
			}},
		},
	}}
	store := NewProductAnalysisReportStoreWithUploadRoot(db, "/tmp/uploads")

	task, err := store.GetTask(context.Background(), 42, "alice", false)
	if err != nil {
		t.Fatalf("GetTask() error = %v", err)
	}
	if task.Stage != "processing" ||
		task.Progress != 65 ||
		task.Message == nil ||
		*task.Message != "处理中：写入 PT1" ||
		task.PersistenceStatus != "running" ||
		task.PersistenceMessage == nil ||
		*task.PersistenceMessage != "pt1 persistence" ||
		task.ErrorMessage == nil ||
		*task.ErrorMessage != errorMessage ||
		task.ResultPath == nil ||
		*task.ResultPath != resultPath {
		t.Fatalf("task = %#v", task)
	}
	query := db.queryRowCalls[0]
	for _, fragment := range []string{
		"from public.jobs j",
		"left join public.projects p",
		"from public.job_runs",
		"j.job_type = 'product_analysis'",
	} {
		if !strings.Contains(strings.ToLower(query.sql), fragment) {
			t.Fatalf("GetTask() SQL missing %q:\n%s", fragment, query.sql)
		}
	}
}

func TestProductAnalysisReportStoreGetTaskEnforcesProjectScope(t *testing.T) {
	now := productAnalysisTestTimestamp()
	db := &fakeWriteDB{fakeDB: &fakeDB{
		rowsQueue: []pgx.Row{
			fakeRow{values: []any{
				int64(42),
				"pending",
				now,
				now,
				"Project A",
				int64(7),
				int64(7),
				productAnalysisStringPointer("bob"),
				(*string)(nil),
				"",
				(*string)(nil),
				(*string)(nil),
			}},
		},
	}}
	store := NewProductAnalysisReportStoreWithUploadRoot(db, "/tmp/uploads")
	_, err := store.GetTask(context.Background(), 42, "alice", false)
	if !errors.Is(err, product_analysis_reports.ErrProjectForbidden) {
		t.Fatalf("GetTask() error = %v, want ErrProjectForbidden", err)
	}
}

func TestProductAnalysisReportStoreGetTaskNotFound(t *testing.T) {
	db := &fakeWriteDB{fakeDB: &fakeDB{
		row: fakeRow{err: pgx.ErrNoRows},
	}}
	store := NewProductAnalysisReportStoreWithUploadRoot(db, "/tmp/uploads")
	_, err := store.GetTask(context.Background(), 42, "alice", true)
	if !errors.Is(err, product_analysis_reports.ErrTaskNotFound) {
		t.Fatalf("GetTask() error = %v, want ErrTaskNotFound", err)
	}
}

func TestProductAnalysisReportStoreMarkTaskFailedWritesTaskAndRun(t *testing.T) {
	db := &fakeWriteDB{
		fakeDB:  &fakeDB{},
		execTag: pgconn.NewCommandTag("UPDATE 1"),
	}
	store := NewProductAnalysisReportStoreWithUploadRoot(db, "/tmp/uploads")
	if err := store.MarkTaskFailed(context.Background(), 42, "queue unavailable"); err != nil {
		t.Fatalf("MarkTaskFailed() error = %v", err)
	}
	if len(db.execCalls) != 2 {
		t.Fatalf("exec calls = %#v", db.execCalls)
	}
	if !strings.Contains(db.execCalls[0].sql, "status = 'failed'") ||
		!strings.Contains(db.execCalls[0].sql, "job_type = 'product_analysis'") {
		t.Fatalf("failed update = %s", db.execCalls[0].sql)
	}
	if !strings.Contains(strings.ToLower(db.execCalls[1].sql), "insert into public.job_runs") ||
		!strings.Contains(strings.ToLower(db.execCalls[1].sql), "error_message") {
		t.Fatalf("failed run insert = %s", db.execCalls[1].sql)
	}
	if len(db.execCalls[1].args) != 4 ||
		db.execCalls[1].args[0] != int64(42) ||
		db.execCalls[1].args[3] != "queue unavailable" {
		t.Fatalf("failed run args = %#v", db.execCalls[1].args)
	}
	if logValue, ok := db.execCalls[1].args[2].(string); !ok ||
		!strings.Contains(logValue, `"stage":"failed"`) ||
		!strings.Contains(logValue, `"progress":100`) {
		t.Fatalf("failure log = %#v", db.execCalls[1].args[2])
	}
}

func TestResolveProductAnalysisUploadPathRejectsUnsafeFileIDs(t *testing.T) {
	for _, fileID := range []string{
		"",
		"../secret.csv",
		"../../secret.csv",
		"/tmp/secret.csv",
		"nested/../secret.csv",
		"business.csv\r\nInjected: true",
	} {
		if _, err := ResolveProductAnalysisUploadPath(
			"/tmp/uploads",
			"Project A",
			"business_report",
			fileID,
		); !errors.Is(err, product_analysis_reports.ErrInvalidStoredPath) {
			t.Fatalf(
				"ResolveProductAnalysisUploadPath(%q) error = %v, want ErrInvalidStoredPath",
				fileID,
				err,
			)
		}
	}
}

func TestResolveProductAnalysisUploadPathRequiresRootAndStaysContained(t *testing.T) {
	if _, err := ResolveProductAnalysisUploadPath(
		" ",
		"Project A",
		"business_report",
		"business.csv",
	); !errors.Is(err, product_analysis_reports.ErrStorageNotConfigured) {
		t.Fatalf("empty root error = %v", err)
	}

	path, err := ResolveProductAnalysisUploadPath(
		"/tmp/uploads",
		"Project A",
		"business_report",
		"nested/business.csv",
	)
	if err != nil {
		t.Fatalf("ResolveProductAnalysisUploadPath() error = %v", err)
	}
	uploadsRoot, err := filepath.Abs("/tmp/uploads")
	if err != nil {
		t.Fatalf("resolve uploads root: %v", err)
	}
	wantPath := filepath.Join(
		uploadsRoot,
		"Project-A",
		"business-report",
		"nested",
		"business.csv",
	)
	if path != wantPath {
		t.Fatalf("path = %q, want %q", path, wantPath)
	}
}
