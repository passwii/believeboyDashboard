package store

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/monthly_reports"
)

func TestMonthlyReportStoreListMapsRowsAndFilters(t *testing.T) {
	projectID := int64(7)
	year := 2026
	month := 10
	status := monthly_reports.MonthlyReportStatusCompleted
	now := time.Date(2026, 11, 1, 2, 3, 4, 123456000, time.UTC)

	db := &fakeWriteDB{fakeDB: &fakeDB{
		row: fakeRow{values: []any{
			*monthlyReportTestStringPointer("alice"),
			*monthlyReportTestStringPointer("bob"),
		}},
		rows: &fakeRows{batches: [][]any{monthlyReportListRowValues(now)}},
	}}
	store := NewMonthlyReportStore(db)

	items, err := store.List(context.Background(), monthly_reports.MonthlyReportListFilter{
		ProjectID: &projectID,
		Year:      &year,
		Month:     &month,
		Status:    &status,
		Operator:  "alice",
		IsAdmin:   false,
	})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("List() items = %d, want 1", len(items))
	}
	item := items[0]
	if item.ID != 42 || item.ProjectName != "Project A" || item.Status != monthly_reports.MonthlyReportStatusCompleted {
		t.Fatalf("unexpected item: %#v", item)
	}
	if item.CreatedAt != "2026-11-01T02:03:04.123456Z" {
		t.Fatalf("created_at = %q", item.CreatedAt)
	}
	reportCall := db.queryCalls[len(db.queryCalls)-1]
	for _, fragment := range []string{
		"from public.monthly_reports r",
		"join public.projects p",
		"r.project_id = $1",
		"substring(r.report_month from 1 for 4) = $2",
		"substring(r.report_month from 6 for 2) = lpad($3, 2, '0')",
		"r.status::text = $4",
	} {
		if !strings.Contains(reportCall.sql, fragment) {
			t.Fatalf("list SQL missing %q:\n%s", fragment, reportCall.sql)
		}
	}
	if len(reportCall.args) != 4 ||
		reportCall.args[0] != int64(7) ||
		reportCall.args[1] != "2026" ||
		reportCall.args[2] != "10" ||
		reportCall.args[3] != "success" {
		t.Fatalf("list args = %#v", reportCall.args)
	}
}

func TestMonthlyReportStoreListScopesNonAdminOperators(t *testing.T) {
	db := &fakeWriteDB{fakeDB: &fakeDB{
		rowsQueueQuery: []Rows{
			&fakeRows{batches: [][]any{{int64(7)}}},
			&fakeRows{batches: [][]any{monthlyReportListRowValues(time.Now())}},
		},
	}}
	store := NewMonthlyReportStore(db)

	items, err := store.List(context.Background(), monthly_reports.MonthlyReportListFilter{
		Operator: "alice",
	})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("List() items = %d, want 1", len(items))
	}
	if len(db.queryCalls) < 2 {
		t.Fatalf("query calls = %d, want project scope query and report query", len(db.queryCalls))
	}
	if !strings.Contains(db.queryCalls[0].sql, "from public.projects") {
		t.Fatalf("scope query = %s", db.queryCalls[0].sql)
	}
	if !strings.Contains(db.queryCalls[len(db.queryCalls)-1].sql, "r.project_id = any($1)") {
		t.Fatalf("list SQL missing accessible project scope:\n%s", db.queryCalls[len(db.queryCalls)-1].sql)
	}
}

func TestMonthlyReportStoreListAppliesCurrentCountryMonthAndPagination(t *testing.T) {
	projectID := int64(7)
	country := "US"
	reportMonth := "2026-10"
	limit := 25
	db := &fakeWriteDB{fakeDB: &fakeDB{
		rowsQueue: []pgx.Row{
			fakeRow{values: []any{
				monthlyReportTestStringPointer("alice"),
				monthlyReportTestStringPointer("bob"),
			}},
		},
		rows: &fakeRows{batches: [][]any{monthlyReportListRowValues(time.Now())}},
	}}
	store := NewMonthlyReportStore(db)
	_, err := store.List(context.Background(), monthly_reports.MonthlyReportListFilter{
		ProjectID:   &projectID,
		Country:     &country,
		ReportMonth: &reportMonth,
		Operator:    "alice",
		Limit:       &limit,
		Offset:      50,
	})
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	call := db.queryCalls[len(db.queryCalls)-1]
	for _, fragment := range []string{
		"r.is_current = true",
		"r.country = $2",
		"r.report_month = $3",
		"limit $4",
		"offset $5",
	} {
		if !strings.Contains(call.sql, fragment) {
			t.Fatalf("list SQL missing %q:\n%s", fragment, call.sql)
		}
	}
	if len(call.args) != 5 ||
		call.args[1] != "US" ||
		call.args[2] != "2026-10" ||
		call.args[3] != 25 ||
		call.args[4] != 50 {
		t.Fatalf("pagination args = %#v", call.args)
	}
}

func TestMonthlyReportStoreGetReportMapsDetail(t *testing.T) {
	now := time.Date(2026, 11, 1, 2, 3, 4, 123456000, time.UTC)
	reportRow := monthlyReportDetailRowValues(now)
	pt3JSON := `{"income_total":1000.25,"expense_total":-200.5,"expense_fba_transaction_fees":120,"expense_refund_administration_fees":10}`
	pt4JSON := `{"income_total":1000.25,"expense_total":-200.5,"amazon_pay_back":799.75,"credit_card_deduction_usd":0}`
	exchangeRate := 7.2

	db := &fakeWriteDB{fakeDB: &fakeDB{
		rowsQueue: []pgx.Row{
			fakeRow{values: reportRow},
			fakeRow{values: []any{pt3JSON}},
			fakeRow{values: []any{pt4JSON}},
			fakeRow{values: []any{400.0, 50.0}},
			fakeRow{values: []any{exchangeRate}},
		},
	}}
	store := NewMonthlyReportStore(db)

	detail, err := store.GetReport(context.Background(), 42)
	if err != nil {
		t.Fatalf("GetReport() error = %v", err)
	}
	if detail.Report.ID != 42 || detail.Project.ID != 7 || detail.Year != 2026 || detail.Month != 10 {
		t.Fatalf("unexpected detail: %#v", detail)
	}
	if detail.PT3["income_total"] != 1000.25 || detail.PT4["amazon_pay_back"] != 799.75 {
		t.Fatalf("pt maps = %#v / %#v", detail.PT3, detail.PT4)
	}
	if detail.PurchaseCost.TotalCostRMB != 450 {
		t.Fatalf("purchase cost = %#v", detail.PurchaseCost)
	}
	if detail.Profit.NetProfitRMB == 0 {
		t.Fatalf("profit = %#v", detail.Profit)
	}
	if len(detail.PlatformFees) == 0 || len(detail.RefundFees) == 0 {
		t.Fatalf("fee breakdown missing: %#v / %#v", detail.PlatformFees, detail.RefundFees)
	}
	if !strings.Contains(db.queryRowCalls[0].sql, "public.monthly_report_pt3_calculation") &&
		!strings.Contains(db.queryRowCalls[1].sql, "public.monthly_report_pt3_calculation") {
		t.Fatalf("PT3 query uses wrong table: %#v", db.queryRowCalls)
	}
}

func TestMonthlyReportStoreGetReportNotFound(t *testing.T) {
	db := &fakeWriteDB{fakeDB: &fakeDB{row: fakeRow{err: pgx.ErrNoRows}}}
	store := NewMonthlyReportStore(db)
	_, err := store.GetReport(context.Background(), 999)
	if !errors.Is(err, monthly_reports.ErrReportNotFound) {
		t.Fatalf("GetReport() error = %v, want ErrReportNotFound", err)
	}
}

func TestMonthlyReportStoreGenerateUsesTransactionAndNextVersion(t *testing.T) {
	now := time.Date(2026, 11, 1, 2, 3, 4, 123456000, time.UTC)
	projectID := int64(7)
	baseDB := &fakeWriteDB{fakeDB: &fakeDB{
		rowsQueue: []pgx.Row{
			fakeRow{values: []any{int64(7), "Project A", monthlyReportTestStringPointer("alice"), monthlyReportTestStringPointer("bob")}},
			fakeRow{values: []any{1}},
			fakeRow{values: []any{int64(3)}},
			fakeRow{values: []any{true}},
			fakeRow{values: monthlyReportListRowValues(now)},
			fakeRow{values: []any{int64(99)}},
		}},
	}
	db := &monthlyReportRecordingDB{fakeWriteDB: baseDB}
	store := NewMonthlyReportStore(db)

	report, err := store.Generate(context.Background(), monthly_reports.MonthlyReportGenerateInput{
		ProjectID:           &projectID,
		Country:             "US",
		ReportMonth:         "2026-10",
		TransactionFileID:   monthlyReportTestStringPointer("file-1"),
		TransactionFilePath: monthlyReportTestStringPointer("/tmp/client.csv"),
		SummaryPDFFilePath:  monthlyReportTestStringPointer("/tmp/client.pdf"),
		Async:               true,
		Operator:            "alice",
	})
	if err != nil {
		t.Fatalf("Generate() error = %v", err)
	}
	if report.ID != 42 || report.Version != 1 || report.JobID != 99 {
		t.Fatalf("unexpected report: %#v", report)
	}
	if len(db.queryRowCalls) < 6 {
		t.Fatalf("query row calls = %d, want project/version/current/report/job", len(db.queryRowCalls))
	}
	if !strings.Contains(db.queryRowCalls[1].sql, "pg_advisory_xact_lock") {
		t.Fatalf("transaction advisory lock missing: %s", db.queryRowCalls[1].sql)
	}
	if !strings.Contains(db.queryRowCalls[4].sql, "insert into public.monthly_reports") {
		t.Fatalf("insert SQL missing:\n%s", db.queryRowCalls[len(db.queryRowCalls)-1].sql)
	}
	if !strings.Contains(db.queryRowCalls[5].sql, "insert into public.jobs") {
		t.Fatalf("job insert SQL missing:\n%s", db.queryRowCalls[5].sql)
	}
	reportInsert := db.queryRowCalls[4]
	for _, arg := range reportInsert.args {
		if value, ok := arg.(string); ok && value == "/tmp/client.csv" {
			t.Fatalf("client path was persisted: %#v", reportInsert.args)
		}
	}
	if reportInsert.args[6] != "file-1" || reportInsert.args[7] != "" {
		t.Fatalf("transaction file args = %#v", reportInsert.args)
	}
	jobInsert := db.queryRowCalls[5]
	if len(jobInsert.args) != 3 || jobInsert.args[0] != monthlyReportJobType {
		t.Fatalf("job insert args = %#v", jobInsert.args)
	}
	payloadJSON, ok := jobInsert.args[1].(string)
	if !ok {
		t.Fatalf("job payload type = %T", jobInsert.args[1])
	}
	var payload monthlyReportJobPayload
	if err := json.Unmarshal([]byte(payloadJSON), &payload); err != nil {
		t.Fatalf("decode job payload: %v", err)
	}
	if payload.JobType != "monthly_report" ||
		payload.FileID != "file-1" ||
		payload.Params.ReportID != 42 ||
		payload.Params.ProjectID != 7 ||
		payload.Params.TransactionFileID != "file-1" {
		t.Fatalf("job payload = %#v", payload)
	}
	if operator, ok := jobInsert.args[2].(*string); !ok || operator == nil || *operator != "alice" {
		t.Fatalf("job operator = %#v", jobInsert.args[2])
	}
	if db.tx == nil || !db.tx.committed {
		t.Fatal("Generate() did not commit its transaction")
	}
}

func TestMonthlyReportStoreGenerateImmediateUsesRunningStatus(t *testing.T) {
	now := time.Now()
	projectID := int64(7)
	db := &fakeWriteDB{fakeDB: &fakeDB{
		rowsQueue: []pgx.Row{
			fakeRow{values: []any{int64(7), "Project A", monthlyReportTestStringPointer("alice"), nil}},
			fakeRow{values: []any{1}},
			fakeRow{values: []any{int64(0)}},
			fakeRow{values: []any{false}},
			fakeRow{values: monthlyReportListRowValues(now)},
			fakeRow{values: []any{int64(100)}},
		}},
	}
	store := NewMonthlyReportStore(db)
	_, err := store.Generate(context.Background(), monthly_reports.MonthlyReportGenerateInput{
		ProjectID:         &projectID,
		Country:           "US",
		ReportMonth:       "2026-10",
		TransactionFileID: monthlyReportTestStringPointer("file-2"),
		Async:             false,
		Operator:          "alice",
	})
	if err != nil {
		t.Fatalf("Generate(immediate) error = %v", err)
	}
	insertCall := db.queryRowCalls[4]
	if !strings.Contains(insertCall.sql, "insert into public.monthly_reports") {
		t.Fatalf("report insert not found: %#v", db.queryRowCalls)
	}
	if len(insertCall.args) == 0 || insertCall.args[len(insertCall.args)-1] != "running" {
		t.Fatalf("immediate insert args = %#v, want running status", insertCall.args)
	}
}

func TestMonthlyReportStoreGenerateRequiresTransactionFileID(t *testing.T) {
	store := NewMonthlyReportStore(&fakeWriteDB{fakeDB: &fakeDB{}})
	projectID := int64(7)
	_, err := store.Generate(context.Background(), monthly_reports.MonthlyReportGenerateInput{
		ProjectID:   &projectID,
		Country:     "US",
		ReportMonth: "2026-10",
		Operator:    "alice",
	})
	if !errors.Is(err, monthly_reports.ErrTransactionFileRequired) {
		t.Fatalf("Generate() error = %v, want ErrTransactionFileRequired", err)
	}
}

func TestMonthlyReportStoreGenerateRollsBackWhenJobInsertFails(t *testing.T) {
	now := time.Now()
	projectID := int64(7)
	baseDB := &fakeWriteDB{fakeDB: &fakeDB{
		rowsQueue: []pgx.Row{
			fakeRow{values: []any{int64(7), "Project A", monthlyReportTestStringPointer("alice"), nil}},
			fakeRow{values: []any{1}},
			fakeRow{values: []any{int64(0)}},
			fakeRow{values: []any{false}},
			fakeRow{values: monthlyReportListRowValues(now)},
			fakeRow{err: errors.New("job insert failed")},
		},
	}}
	db := &monthlyReportRecordingDB{fakeWriteDB: baseDB}
	store := NewMonthlyReportStore(db)
	_, err := store.Generate(context.Background(), monthly_reports.MonthlyReportGenerateInput{
		ProjectID:         &projectID,
		Country:           "US",
		ReportMonth:       "2026-10",
		TransactionFileID: monthlyReportTestStringPointer("file-1"),
		Async:             true,
		Operator:          "alice",
	})
	if err == nil || !strings.Contains(err.Error(), "job insert failed") {
		t.Fatalf("Generate() error = %v", err)
	}
	if db.tx == nil || db.tx.committed || !db.tx.rolledBack {
		t.Fatalf("transaction state = %#v", db.tx)
	}
	if len(db.queryRowCalls) != 6 ||
		!strings.Contains(db.queryRowCalls[4].sql, "insert into public.monthly_reports") ||
		!strings.Contains(db.queryRowCalls[5].sql, "insert into public.jobs") {
		t.Fatalf("atomic insert calls = %#v", db.queryRowCalls)
	}
}

func TestMonthlyReportStoreMarkGenerationFailedUpdatesBothRows(t *testing.T) {
	db := &monthlyReportRecordingDB{
		fakeWriteDB: &fakeWriteDB{fakeDB: &fakeDB{}},
	}
	store := NewMonthlyReportStore(db)
	if err := store.MarkGenerationFailed(
		context.Background(),
		42,
		99,
		"queue unavailable",
	); err != nil {
		t.Fatalf("MarkGenerationFailed() error = %v", err)
	}
	if db.tx == nil || !db.tx.committed {
		t.Fatalf("failure transaction state = %#v", db.tx)
	}
	if len(db.execCalls) != 2 {
		t.Fatalf("exec calls = %d, want 2", len(db.execCalls))
	}
	if !strings.Contains(db.execCalls[0].sql, "update public.monthly_reports") ||
		!strings.Contains(db.execCalls[1].sql, "update public.jobs") {
		t.Fatalf("failure update SQL = %#v", db.execCalls)
	}
}

func TestMonthlyReportStorePromoteCompletedReport(t *testing.T) {
	db := &monthlyReportRecordingDB{
		fakeWriteDB: &fakeWriteDB{fakeDB: &fakeDB{
			rowsQueue: []pgx.Row{
				fakeRow{values: []any{int64(7), "US", "2026-10"}},
				fakeRow{values: []any{1}},
				fakeRow{values: []any{"success", true}},
			},
		}},
	}
	store := NewMonthlyReportStore(db)
	if err := store.PromoteCompletedReport(context.Background(), 42); err != nil {
		t.Fatalf("PromoteCompletedReport() error = %v", err)
	}
	if db.tx == nil || !db.tx.committed {
		t.Fatal("PromoteCompletedReport() did not commit")
	}
	if len(db.execCalls) != 2 {
		t.Fatalf("promotion exec calls = %d, want 2", len(db.execCalls))
	}
	if !strings.Contains(db.execCalls[0].sql, "is_current = false") ||
		!strings.Contains(db.execCalls[1].sql, "is_current = true") {
		t.Fatalf("promotion SQL = %#v", db.execCalls)
	}
}

func TestMonthlyReportStorePromoteRejectsIncompleteReport(t *testing.T) {
	db := &monthlyReportRecordingDB{
		fakeWriteDB: &fakeWriteDB{fakeDB: &fakeDB{
			rowsQueue: []pgx.Row{
				fakeRow{values: []any{int64(7), "US", "2026-10"}},
				fakeRow{values: []any{1}},
				fakeRow{values: []any{"running", true}},
			},
		}},
	}
	store := NewMonthlyReportStore(db)
	err := store.PromoteCompletedReport(context.Background(), 42)
	if !errors.Is(err, monthly_reports.ErrReportNotReady) {
		t.Fatalf("PromoteCompletedReport() error = %v, want ErrReportNotReady", err)
	}
	if db.tx == nil || db.tx.committed {
		t.Fatal("incomplete promotion must not commit")
	}
}

func TestMonthlyReportStoreFinalizeCompletedReport(t *testing.T) {
	resultRoot := t.TempDir()
	resultPath := filepath.Join(resultRoot, "42", "report.xlsx")
	if err := os.MkdirAll(filepath.Dir(resultPath), 0o700); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	if err := os.WriteFile(resultPath, []byte{'P', 'K', 0x03, 0x04}, 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	db := &monthlyReportRecordingDB{
		fakeWriteDB: &fakeWriteDB{
			fakeDB: &fakeDB{
				rowsQueue: []pgx.Row{
					fakeRow{values: []any{int64(7), "Project A", "US", "2026-10", "running", nil}},
					fakeRow{values: []any{1}},
					fakeRow{values: []any{int64(7), "US", "2026-10"}},
					fakeRow{values: []any{1}},
					fakeRow{values: []any{"success", true}},
				},
			},
			execTag: pgconn.NewCommandTag("UPDATE 1"),
		},
	}
	store := NewMonthlyReportStoreWithRoots(db, resultRoot, t.TempDir())
	computed := MonthlyReportComputedResult{
		ResultPath: resultPath,
		Transactions: []MonthlyReportComputedTransaction{
			{
				SourceRowNo:     1,
				TransactionDate: time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC),
				SettlementID:    "S-1",
				TransactionType: "Order",
				ProductSales:    "10.00",
				Total:           "10.00",
				RawRowJSON:      []byte(`{"type":"Order"}`),
			},
		},
		PT3: map[string]string{
			"income_total":  "10.00",
			"expense_total": "0.00",
		},
		PT4: map[string]string{
			"income_total":    "10.00",
			"amazon_pay_back": "10.00",
		},
		SettlementID: "S-1",
	}
	if err := store.FinalizeCompletedReport(
		context.Background(),
		42,
		99,
		computed,
	); err != nil {
		t.Fatalf("FinalizeCompletedReport() error = %v", err)
	}
	if db.tx == nil || !db.tx.committed {
		t.Fatal("FinalizeCompletedReport() did not commit")
	}
	if len(db.execCalls) != 10 {
		t.Fatalf("finalize exec calls = %d, want 10", len(db.execCalls))
	}
	for _, fragment := range []string{
		"delete from public.monthly_report_transactions",
		"delete from public.monthly_report_pt3_calculation",
		"delete from public.monthly_report_pt4_calculation",
		"insert into public.monthly_report_transactions",
		"insert into public.monthly_report_pt3_calculation",
		"insert into public.monthly_report_pt4_calculation",
		"jsonb_populate_record",
		"income_vat_total",
		"status = 'success'",
		"is_current = false",
		"is_current = true",
		"public.jobs",
	} {
		found := false
		for _, call := range db.execCalls {
			if strings.Contains(call.sql, fragment) {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("finalize SQL missing %q: %#v", fragment, db.execCalls)
		}
	}
	if !strings.Contains(db.execCalls[6].sql, "status = 'success'") {
		t.Fatalf("finalize SQL = %#v", db.execCalls)
	}
}

func TestMonthlyReportStoreFinalizeRollsBackOnChildWriteError(t *testing.T) {
	resultRoot := t.TempDir()
	resultPath := filepath.Join(resultRoot, "42", "report.xlsx")
	if err := os.MkdirAll(filepath.Dir(resultPath), 0o700); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	if err := os.WriteFile(resultPath, []byte{'P', 'K', 0x03, 0x04}, 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	db := &monthlyReportRecordingDB{
		fakeWriteDB: &fakeWriteDB{
			fakeDB: &fakeDB{
				rowsQueue: []pgx.Row{
					fakeRow{values: []any{int64(7), "Project A", "US", "2026-10", "running", nil}},
					fakeRow{values: []any{1}},
				},
			},
			execErr: errors.New("child write failed"),
		},
	}
	store := NewMonthlyReportStoreWithRoots(db, resultRoot, t.TempDir())
	err := store.FinalizeCompletedReport(
		context.Background(),
		42,
		99,
		MonthlyReportComputedResult{
			ResultPath: resultPath,
			PT3:        map[string]string{"income_total": "0.00"},
			PT4:        map[string]string{"income_total": "0.00"},
		},
	)
	if err == nil || !strings.Contains(err.Error(), "child write failed") {
		t.Fatalf("FinalizeCompletedReport() error = %v", err)
	}
	if db.tx == nil || db.tx.committed || !db.tx.rolledBack {
		t.Fatalf("transaction state committed=%v rolled_back=%v", db.tx != nil && db.tx.committed, db.tx != nil && db.tx.rolledBack)
	}
}

func TestMonthlyReportStoreConfirmRejectsIncompleteReport(t *testing.T) {
	db := &fakeWriteDB{fakeDB: &fakeDB{
		rowsQueue: []pgx.Row{
			fakeRow{values: []any{"running"}},
		},
	}}
	store := NewMonthlyReportStore(db)
	err := store.RunInTx(context.Background(), func(
		ctx context.Context,
		_ pgx.Tx,
		txStore monthly_reports.Store,
	) error {
		_, err := txStore.ConfirmReport(ctx, 42)
		return err
	})
	if !errors.Is(err, monthly_reports.ErrReportNotReady) {
		t.Fatalf("ConfirmReport() error = %v, want ErrReportNotReady", err)
	}
}

func TestMonthlyReportStoreConfirmSuccess(t *testing.T) {
	now := time.Now()
	db := &fakeWriteDB{fakeDB: &fakeDB{
		rowsQueue: []pgx.Row{
			fakeRow{values: []any{"success"}},
			fakeRow{values: []any{false}},
			fakeRow{values: monthlyReportListRowValues(now)},
		},
	}}
	store := NewMonthlyReportStore(db)
	var confirmed *monthly_reports.MonthlyReport
	err := store.RunInTx(context.Background(), func(
		ctx context.Context,
		_ pgx.Tx,
		txStore monthly_reports.Store,
	) error {
		var confirmErr error
		confirmed, confirmErr = txStore.ConfirmReport(ctx, 42)
		return confirmErr
	})
	if err != nil {
		t.Fatalf("ConfirmReport() error = %v", err)
	}
	if confirmed == nil || confirmed.Status != monthly_reports.MonthlyReportStatusCompleted {
		t.Fatalf("confirmed report = %#v", confirmed)
	}
	if len(db.queryRowCalls) < 3 ||
		!strings.Contains(db.queryRowCalls[2].sql, "update public.monthly_reports") {
		t.Fatalf("confirm update SQL missing: %#v", db.queryRowCalls)
	}
}

func TestMonthlyReportStoreGetStatusMapsProgressAndError(t *testing.T) {
	now := time.Date(2026, 11, 1, 2, 3, 4, 123456000, time.UTC)
	errorMessage := "calculation failed"
	db := &fakeWriteDB{fakeDB: &fakeDB{
		row: fakeRow{values: []any{"running", &errorMessage, now, now}},
	}}
	store := NewMonthlyReportStore(db)
	status, err := store.GetStatus(context.Background(), 42)
	if err != nil {
		t.Fatalf("GetStatus() error = %v", err)
	}
	if status.Status != monthly_reports.MonthlyReportStatusCalculating ||
		status.Progress != 50 ||
		status.Stage != "processing" {
		t.Fatalf("status payload = %#v", status)
	}
	if status.ErrorMessage == nil || *status.ErrorMessage != errorMessage {
		t.Fatalf("error_message = %#v", status.ErrorMessage)
	}
	if status.UpdatedAt != "2026-11-01T02:03:04.123456Z" {
		t.Fatalf("updated_at = %q", status.UpdatedAt)
	}
}

func TestMonthlyReportStoreDeleteRejectsConfirmedReport(t *testing.T) {
	db := &fakeWriteDB{fakeDB: &fakeDB{
		rowsQueue: []pgx.Row{
			fakeRow{values: monthlyReportListRowValues(time.Now())},
			fakeRow{values: []any{true}},
		},
	}}
	store := NewMonthlyReportStore(db)
	err := store.RunInTx(context.Background(), func(
		ctx context.Context,
		_ pgx.Tx,
		txStore monthly_reports.Store,
	) error {
		_, err := txStore.DeleteDraft(ctx, 42)
		return err
	})
	if !errors.Is(err, monthly_reports.ErrReportFinalized) {
		t.Fatalf("DeleteDraft() error = %v, want ErrReportFinalized", err)
	}
}

func TestMonthlyReportStoreDeleteDraftUsesTxAndDelete(t *testing.T) {
	now := time.Now()
	baseDB := &fakeWriteDB{
		fakeDB: &fakeDB{
			rowsQueue: []pgx.Row{
				fakeRow{values: monthlyReportListRowValues(now)},
				fakeRow{values: []any{false}},
			},
		},
		execTag: pgconn.NewCommandTag("DELETE 1"),
	}
	db := &monthlyReportRecordingDB{fakeWriteDB: baseDB}
	store := NewMonthlyReportStore(db)
	var deleted *monthly_reports.MonthlyReport
	err := store.RunInTx(context.Background(), func(
		ctx context.Context,
		_ pgx.Tx,
		txStore monthly_reports.Store,
	) error {
		var deleteErr error
		deleted, deleteErr = txStore.DeleteDraft(ctx, 42)
		return deleteErr
	})
	if err != nil {
		t.Fatalf("DeleteDraft() error = %v", err)
	}
	if deleted == nil || deleted.ID != 42 {
		t.Fatalf("deleted report = %#v", deleted)
	}
	if db.tx == nil || !db.tx.committed {
		t.Fatal("DeleteDraft() did not commit its transaction")
	}
	lastExec := db.execCalls[len(db.execCalls)-1]
	if !strings.Contains(lastExec.sql, "delete from public.monthly_reports") {
		t.Fatalf("delete SQL missing:\n%s", lastExec.sql)
	}
}

func TestMonthlyReportStoreExportExcelFallsBackToCSV(t *testing.T) {
	now := time.Now()
	pt3JSON := `{"income_total":1000,"expense_total":-200,"expense_fba_transaction_fees":120}`
	pt4JSON := `{"income_total":1000,"expense_total":-200,"amazon_pay_back":800,"credit_card_deduction_usd":0}`
	exchangeRate := 7.2
	db := &fakeWriteDB{fakeDB: &fakeDB{
		rowsQueue: []pgx.Row{
			fakeRow{values: monthlyReportDetailRowValues(now)},
			fakeRow{values: []any{pt3JSON}},
			fakeRow{values: []any{pt4JSON}},
			fakeRow{values: []any{400.0, 50.0}},
			fakeRow{values: []any{exchangeRate}},
		},
	}}
	store := NewMonthlyReportStore(db)
	export, err := store.ExportReport(
		context.Background(),
		42,
		monthly_reports.MonthlyReportExportFormatExcel,
	)
	if err != nil {
		t.Fatalf("ExportReport() error = %v", err)
	}
	if export.Filename != "Project_A_Monthly_Report_2026-10.csv" {
		t.Fatalf("filename = %q", export.Filename)
	}
	if export.ContentType != "text/csv; charset=utf-8" {
		t.Fatalf("content type = %q", export.ContentType)
	}
	if !strings.Contains(string(export.Content), "report_id,project_id,project_name") ||
		!strings.Contains(string(export.Content), "expense_fba_transaction_fees,120.00") {
		t.Fatalf("CSV content =\n%s", export.Content)
	}
}

func TestMonthlyReportStoreExportRejectsPathsOutsideControlledRoot(t *testing.T) {
	now := time.Now()
	root := t.TempDir()
	t.Setenv("UPLOAD_ROOT", root)

	outsidePath := filepath.Join(t.TempDir(), "escape.pdf")
	if err := os.WriteFile(outsidePath, []byte("%PDF-1.4"), 0o600); err != nil {
		t.Fatalf("write outside fixture: %v", err)
	}
	prefixOutsideRoot := root + "_other"
	if err := os.MkdirAll(prefixOutsideRoot, 0o700); err != nil {
		t.Fatalf("create prefix outside root: %v", err)
	}
	prefixPath := filepath.Join(prefixOutsideRoot, "escape.pdf")
	if err := os.WriteFile(prefixPath, []byte("%PDF-1.4"), 0o600); err != nil {
		t.Fatalf("write prefix outside fixture: %v", err)
	}
	for name, path := range map[string]string{
		"dot-dot":             filepath.Join(root, "..", "escape.pdf"),
		"absolute-outside":    outsidePath,
		"prefix-outside-root": prefixPath,
	} {
		t.Run(name, func(t *testing.T) {
			values := monthlyReportDetailRowValues(now)
			values[23] = nil
			values[22] = &path
			db := &fakeWriteDB{fakeDB: &fakeDB{
				rowsQueue: []pgx.Row{
					fakeRow{values: values},
					fakeRow{values: []any{`{}`}},
					fakeRow{values: []any{`{}`}},
					fakeRow{values: []any{0.0, 0.0}},
					fakeRow{err: pgx.ErrNoRows},
				},
			}}
			store := NewMonthlyReportStore(db)
			_, err := store.ExportReport(
				context.Background(),
				42,
				monthly_reports.MonthlyReportExportFormatPDF,
			)
			if !errors.Is(err, monthly_reports.ErrExportNotFound) {
				t.Fatalf("escaped PDF path error = %v, want ErrExportNotFound", err)
			}
		})
	}
}

func TestMonthlyReportStoreExportServesFileInsideControlledRoot(t *testing.T) {
	now := time.Now()
	root := t.TempDir()
	t.Setenv("UPLOAD_ROOT", root)
	path := filepath.Join(root, "summary.pdf")
	if err := os.WriteFile(path, []byte("%PDF-1.4"), 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	values := monthlyReportDetailRowValues(now)
	values[23] = nil
	values[22] = &path
	db := &fakeWriteDB{fakeDB: &fakeDB{
		rowsQueue: []pgx.Row{
			fakeRow{values: values},
			fakeRow{values: []any{`{}`}},
			fakeRow{values: []any{`{}`}},
			fakeRow{values: []any{0.0, 0.0}},
			fakeRow{err: pgx.ErrNoRows},
		},
	}}
	store := NewMonthlyReportStore(db)
	export, err := store.ExportReport(
		context.Background(),
		42,
		monthly_reports.MonthlyReportExportFormatPDF,
	)
	if err != nil {
		t.Fatalf("ExportReport() error = %v", err)
	}
	resolvedPath, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatalf("resolve fixture path: %v", err)
	}
	if export.Path != resolvedPath || export.ContentType != "application/pdf" {
		t.Fatalf("export = %#v", export)
	}
}

func TestMonthlyReportStoreExportRejectsUnsafeRedirects(t *testing.T) {
	now := time.Now()
	for _, redirectURL := range []string{
		"http://r2.example/summary.pdf",
		"https://user:pass@r2.example/summary.pdf",
		"javascript:alert(1)",
	} {
		t.Run(redirectURL, func(t *testing.T) {
			values := monthlyReportDetailRowValues(now)
			values[22] = nil
			values[23] = &redirectURL
			db := &fakeWriteDB{fakeDB: &fakeDB{
				rowsQueue: []pgx.Row{
					fakeRow{values: values},
					fakeRow{values: []any{`{}`}},
					fakeRow{values: []any{`{}`}},
					fakeRow{values: []any{0.0, 0.0}},
					fakeRow{err: pgx.ErrNoRows},
				},
			}}
			store := NewMonthlyReportStore(db)
			_, err := store.ExportReport(
				context.Background(),
				42,
				monthly_reports.MonthlyReportExportFormatPDF,
			)
			if !errors.Is(err, monthly_reports.ErrExportNotFound) {
				t.Fatalf("unsafe redirect error = %v, want ErrExportNotFound", err)
			}
		})
	}
}

func TestMonthlyReportStoreCSVEscapesFormulaText(t *testing.T) {
	detail := &monthly_reports.MonthlyReportDetail{
		Report: monthly_reports.MonthlyReport{
			ID:          42,
			ProjectID:   7,
			ProjectName: "=SUM(A1:A2)",
			Country:     "US",
			ReportMonth: "2026-10",
			Status:      monthly_reports.MonthlyReportStatusCompleted,
		},
		PT3: map[string]float64{
			"@malicious": 120,
		},
	}
	content, err := renderMonthlyReportCSV(detail)
	if err != nil {
		t.Fatalf("renderMonthlyReportCSV() error = %v", err)
	}
	reader := csv.NewReader(strings.NewReader(string(content)))
	reader.FieldsPerRecord = -1
	records, err := reader.ReadAll()
	if err != nil {
		t.Fatalf("parse CSV: %v", err)
	}
	if records[1][2] != "'=SUM(A1:A2)" {
		t.Fatalf("escaped project name = %q", records[1][2])
	}
	if len(records) < 3 || records[2][0] != "'@malicious" {
		t.Fatalf("escaped PT3 key row = %#v", records)
	}
	for input, want := range map[string]string{
		"=1+1":  "'=1+1",
		"+SUM":  "'+SUM",
		"-2":    "'-2",
		"@cmd":  "'@cmd",
		"\tcmd": "'\tcmd",
		"\rcmd": "'\rcmd",
		"safe":  "safe",
	} {
		if got := csvSafeText(input); got != want {
			t.Fatalf("csvSafeText(%q) = %q, want %q", input, got, want)
		}
	}
}

func monthlyReportListRowValues(now time.Time) []any {
	return []any{
		int64(42),
		int64(7),
		"Project A",
		"US",
		"2026-10",
		int64(1),
		true,
		nil,
		"success",
		monthlyReportTestStringPointer("SET-1"),
		int64(12),
		int64(8),
		int64(2),
		int64(1),
		int64(1),
		int64(3),
		monthlyReportTestStringPointer("/tmp/report.xlsx"),
		nil,
		int64(1),
		now,
		now,
		now,
		monthlyReportTestStringPointer("/tmp/summary.pdf"),
		monthlyReportTestStringPointer("https://r2.example/summary.pdf"),
	}
}

func monthlyReportDetailRowValues(now time.Time) []any {
	values := monthlyReportListRowValues(now)
	return append(values, monthlyReportTestStringPointer("alice"), monthlyReportTestStringPointer("bob"))
}

func monthlyReportTestStringPointer(value string) *string {
	return &value
}

func TestMonthlyReportStoreGetFinancialSeriesAggregatesPostgresRows(t *testing.T) {
	db := &fakeWriteDB{fakeDB: &fakeDB{
		rowsQueue: []pgx.Row{
			fakeRow{values: []any{"Project A"}},
		},
		rowsQueueQuery: []Rows{
			&fakeRows{batches: [][]any{
				{
					int64(42), "2026-10",
					1000.0, -20.0, 5.0, 10.0,
					-80.0, -120.0, -15.0, -30.0, -50.0, -5.0,
					995.0, -300.0, 695.0,
					-12.0, -12.0, 25.0, true,
				},
				{
					int64(41), "2026-08",
					500.0, 0.0, 0.0, 0.0,
					-40.0, -30.0, 0.0, -10.0, -5.0, 0.0,
					500.0, -85.0, 415.0,
					0.0, 0.0, 0.0, true,
				},
			}},
			&fakeRows{batches: [][]any{
				{int64(42), 400.0, 50.0},
			}},
		},
	}}
	store := NewMonthlyReportStore(db)
	response, err := store.GetFinancialSeries(context.Background(), monthly_reports.MonthlyFinancialSeriesFilter{
		ProjectID:   7,
		Country:     "US",
		StartMonth:  "2026-08",
		EndMonth:    "2026-10",
		FillMissing: true,
	})
	if err != nil {
		t.Fatalf("GetFinancialSeries() error = %v", err)
	}
	if response.ProjectName != "Project A" ||
		response.StartMonth != "2026-08" ||
		response.EndMonth != "2026-10" {
		t.Fatalf("response metadata = %#v", response)
	}
	if len(response.Rows) != 3 {
		t.Fatalf("rows = %d, want 3", len(response.Rows))
	}
	october := response.Rows[2]
	if october.ReportMonth != "2026-10" ||
		october.FOBCostRMB != 400 ||
		october.FirstLegCostRMB != 50 ||
		october.CreditCardDeductionUSD != 25 ||
		october.IncomeSalesWithTax != october.IncomeSales ||
		!october.HasSourceReport {
		t.Fatalf("October row = %#v", october)
	}
	if response.Rows[1].ReportMonth != "2026-09" || response.Rows[1].HasSourceReport {
		t.Fatalf("missing month row = %#v", response.Rows[1])
	}
	if response.Trend.IncomeTotalSum != 1495 ||
		response.Trend.ExpenseTotalSum != -385 ||
		response.Trend.AmazonPayBackSum != 1110 ||
		response.Trend.NetAmountSum != 1110 {
		t.Fatalf("trend = %#v", response.Trend)
	}
	if len(db.queryCalls) != 2 ||
		!strings.Contains(db.queryCalls[0].sql, "monthly_report_pt4_calculation") ||
		!strings.Contains(db.queryCalls[0].sql, "to_jsonb(pt3)") ||
		!strings.Contains(db.queryCalls[0].sql, "marketplace_withheld_tax") ||
		!strings.Contains(db.queryCalls[1].sql, "public.product_costs") {
		t.Fatalf("aggregate SQL = %#v", db.queryCalls)
	}
}

func TestMonthlyReportStoreAccountingDetailBuildsStructuredRows(t *testing.T) {
	db := &fakeWriteDB{fakeDB: &fakeDB{
		rowsQueue: []pgx.Row{
			fakeRow{values: []any{
				int64(42), int64(7), "Project A", "2026-10", "US",
			}},
			fakeRow{values: []any{`{
				"income_product_sales_non_fba": 1000,
				"income_total": 1200,
				"expense_fba_transaction_fees": -120,
				"expense_total": -300
			}`}},
		},
	}}
	store := NewMonthlyReportStore(db)
	detail, err := store.GetAccountingDetail(context.Background(), monthly_reports.MonthlyFinancialAccountingFilter{
		ProjectID:   7,
		Country:     "US",
		ReportMonth: "2026-10",
	})
	if err != nil {
		t.Fatalf("GetAccountingDetail() error = %v", err)
	}
	if detail.ProjectName != "Project A" || detail.ReportMonth != "2026-10" {
		t.Fatalf("detail = %#v", detail)
	}
	if len(detail.Rows) != 22 {
		t.Fatalf("rows = %d, want 22", len(detail.Rows))
	}
	total := detail.Rows[len(detail.Rows)-1]
	if total.Kind != "total" ||
		total.IncomeEN != "Total_Income" ||
		total.ExpenseEN != "Total_Expense" ||
		total.IncomeAmountUSD != 1200 ||
		total.ExpenseAmountUSD != -300 {
		t.Fatalf("total row = %#v", total)
	}
	if detail.Rows[len(detail.Rows)-2].Kind != "spacer" {
		t.Fatalf("spacer row = %#v", detail.Rows[len(detail.Rows)-2])
	}
	if !strings.Contains(db.queryRowCalls[1].sql, "monthly_report_pt3_calculation") {
		t.Fatalf("PT3 query = %s", db.queryRowCalls[1].sql)
	}
}

func TestMonthlyReportAccountingDetailDerivesMissingVATColumnFromTransactions(t *testing.T) {
	db := &fakeWriteDB{fakeDB: &fakeDB{
		rowsQueue: []pgx.Row{
			fakeRow{values: []any{
				int64(42), int64(7), "Project DE", "2026-10", "DE",
			}},
			fakeRow{values: []any{`{
				"income_product_sales_non_fba": 100,
				"income_total": 119,
				"expense_total": -20
			}`}},
			fakeRow{values: []any{-19.0}},
		},
	}}
	store := NewMonthlyReportStore(db)
	detail, err := store.GetAccountingDetail(context.Background(), monthly_reports.MonthlyFinancialAccountingFilter{
		ProjectID:   7,
		Country:     "DE",
		ReportMonth: "2026-10",
	})
	if err != nil {
		t.Fatalf("GetAccountingDetail() error = %v", err)
	}
	var vatAmount float64
	for _, row := range detail.Rows {
		if row.IncomeEN == "Product sales tax (gross)" {
			vatAmount = row.IncomeAmountUSD
			break
		}
	}
	if vatAmount != -19 {
		t.Fatalf("VAT row amount = %v, want -19", vatAmount)
	}
	if len(db.queryRowCalls) != 3 ||
		!strings.Contains(db.queryRowCalls[2].sql, "marketplace_withheld_tax") {
		t.Fatalf("VAT fallback query = %#v", db.queryRowCalls)
	}
}

func TestMonthlyReportAccountingDetailExportIsRealXLSX(t *testing.T) {
	currency := "USD"
	content, err := renderMonthlyAccountingDetailXLSX(
		&monthly_reports.MonthlyFinancialAccountingDetailResponse{
			ProjectID:   7,
			ProjectName: "Project A",
			ReportMonth: "2026-10",
			Rows: []monthly_reports.MonthlyFinancialAccountingLine{{
				IncomeEN:         "Total_Income",
				IncomeZH:         "合计销售额",
				IncomeAmountUSD:  1200,
				ExpenseEN:        "Total_Expense",
				ExpenseZH:        "合计费用",
				ExpenseAmountUSD: -300,
				CurrencyCode:     &currency,
				Kind:             "total",
			}},
		},
	)
	if err != nil {
		t.Fatalf("renderMonthlyAccountingDetailXLSX() error = %v", err)
	}
	if !bytes.HasPrefix(content, []byte("PK\x03\x04")) {
		t.Fatalf("xlsx magic = %q", content[:4])
	}
	reader, err := zip.NewReader(bytes.NewReader(content), int64(len(content)))
	if err != nil {
		t.Fatalf("open xlsx zip: %v", err)
	}
	files := make(map[string][]byte, len(reader.File))
	for _, file := range reader.File {
		stream, err := file.Open()
		if err != nil {
			t.Fatalf("open xlsx entry %s: %v", file.Name, err)
		}
		payload, err := io.ReadAll(stream)
		_ = stream.Close()
		if err != nil {
			t.Fatalf("read xlsx entry %s: %v", file.Name, err)
		}
		files[file.Name] = payload
	}
	if len(files["xl/workbook.xml"]) == 0 ||
		!bytes.Contains(files["xl/workbook.xml"], []byte("报表核算")) ||
		!bytes.Contains(files["xl/worksheets/sheet1.xml"], []byte("Total_Income")) {
		t.Fatalf("xlsx entries = %#v", files)
	}
}

func TestMonthlyReportStoreTaskResultRejectsOutsideAndSymlinkPaths(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside.xlsx")
	if err := os.WriteFile(outside, []byte("PK\x03\x04outside"), 0o600); err != nil {
		t.Fatalf("write outside result: %v", err)
	}
	link := filepath.Join(root, "linked.xlsx")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatalf("create result symlink: %v", err)
	}

	for name, path := range map[string]string{
		"outside": outside,
		"symlink": link,
	} {
		t.Run(name, func(t *testing.T) {
			payload, err := json.Marshal(monthlyReportJobPayload{
				JobType: monthlyReportJobType,
				FileID:  "file-1",
				Params: monthlyReportJobParams{
					ReportID:          42,
					ProjectID:         7,
					ProjectName:       "Project A",
					Country:           "US",
					ReportMonth:       "2026-10",
					TransactionFileID: "file-1",
				},
			})
			if err != nil {
				t.Fatalf("marshal job payload: %v", err)
			}
			now := time.Now().UTC()
			db := &fakeWriteDB{fakeDB: &fakeDB{
				rowsQueue: []pgx.Row{
					fakeRow{values: []any{
						int64(99), "success", payload, now, now,
						nil, nil, path, now, now,
					}},
					fakeRow{values: []any{
						int64(42), int64(7), "success", path, nil,
					}},
				},
			}}
			store := NewMonthlyReportStoreWithRoots(db, root, root)
			_, err = store.GetTaskResult(context.Background(), 99)
			if !errors.Is(err, monthly_reports.ErrExportNotFound) {
				t.Fatalf("GetTaskResult() error = %v, want ErrExportNotFound", err)
			}
		})
	}
}

func TestMonthlyReportStoreTaskReadsJobsRunsAndReportState(t *testing.T) {
	root := t.TempDir()
	resultPath := filepath.Join(root, "result.xlsx")
	if err := os.WriteFile(resultPath, []byte("PK\x03\x04result"), 0o600); err != nil {
		t.Fatalf("write result: %v", err)
	}
	payload, err := json.Marshal(monthlyReportJobPayload{
		JobType: monthlyReportJobType,
		FileID:  "file-1",
		Params: monthlyReportJobParams{
			ReportID:          42,
			ProjectID:         7,
			ProjectName:       "Project A",
			Country:           "US",
			ReportMonth:       "2026-10",
			TransactionFileID: "file-1",
		},
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	started := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	finished := started.Add(2 * time.Minute)
	logExcerpt := `{"stage":"completed","progress":100,"message":"处理完成：报表已生成，可下载"}`
	db := &fakeWriteDB{fakeDB: &fakeDB{
		rowsQueue: []pgx.Row{
			fakeRow{values: []any{
				int64(99), "success", payload, started, finished,
				logExcerpt, nil, resultPath, started, finished,
			}},
			fakeRow{values: []any{
				int64(42), int64(7), "success", resultPath, nil,
			}},
		},
	}}
	store := NewMonthlyReportStoreWithRoots(db, root, root)
	task, err := store.GetTask(context.Background(), 99)
	if err != nil {
		t.Fatalf("GetTask() error = %v", err)
	}
	if task.TaskID != 99 ||
		task.Status != "success" ||
		task.Stage != "completed" ||
		task.Progress != 100 ||
		task.PersistenceStatus != "success" ||
		task.ProjectID != 7 {
		t.Fatalf("task = %#v", task)
	}
	if task.Message == nil || !strings.Contains(*task.Message, "可下载") {
		t.Fatalf("task message = %#v", task.Message)
	}
	resolvedPath, err := filepath.EvalSymlinks(resultPath)
	if err != nil {
		t.Fatalf("resolve result path: %v", err)
	}
	if task.ResultFilePath == nil || *task.ResultFilePath != resolvedPath {
		t.Fatalf("task result path = %#v, want %s", task.ResultFilePath, resolvedPath)
	}
	if len(db.queryRowCalls) != 2 ||
		!strings.Contains(db.queryRowCalls[0].sql, "public.jobs") ||
		!strings.Contains(db.queryRowCalls[0].sql, "public.job_runs") ||
		!strings.Contains(db.queryRowCalls[1].sql, "public.monthly_reports") {
		t.Fatalf("task SQL = %#v", db.queryRowCalls)
	}

	newTaskDB := func() *fakeWriteDB {
		return &fakeWriteDB{fakeDB: &fakeDB{
			rowsQueue: []pgx.Row{
				fakeRow{values: []any{
					int64(99), "success", payload, started, finished,
					logExcerpt, nil, resultPath, started, finished,
				}},
				fakeRow{values: []any{
					int64(42), int64(7), "success", resultPath, nil,
				}},
			},
		}}
	}
	pathCheckStore := NewMonthlyReportStoreWithRoots(newTaskDB(), root, root)
	pathCheckTask, err := pathCheckStore.GetTask(context.Background(), 99)
	if err != nil {
		t.Fatalf("GetTask() before result error = %v", err)
	}
	if pathCheckTask.ResultFilePath == nil || *pathCheckTask.ResultFilePath != resolvedPath {
		t.Fatalf("task result path before download = %#v, want %s", pathCheckTask.ResultFilePath, resolvedPath)
	}
	resultStore := NewMonthlyReportStoreWithRoots(newTaskDB(), root, root)
	file, err := resultStore.GetTaskResult(context.Background(), 99)
	if err != nil {
		t.Fatalf("GetTaskResult() error = %v", err)
	}
	if file.Path != resolvedPath ||
		file.Filename != "result.xlsx" ||
		file.ProjectID != 7 ||
		file.ContentType != "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" {
		t.Fatalf("task result file = %#v", file)
	}
}

func TestMonthlyFinancialCalculationsRebuildPT3AndPT4(t *testing.T) {
	transactions := []monthlyFinancialTransaction{
		{
			TransactionType:    "Order",
			Fulfillment:        "Amazon",
			ProductSales:       100,
			ShippingCredits:    10,
			GiftWrapCredits:    5,
			PromotionalRebates: -2,
			SellingFees:        -15,
			FBAFees:            -20,
			Total:              83,
		},
		{
			TransactionType: "bestellung",
			Fulfillment:     "Seller",
			ProductSales:    50,
			SellingFees:     -5,
			Total:           45,
		},
		{
			TransactionType: "Refund",
			Fulfillment:     "Amazon",
			ProductSales:    -10,
			SellingFees:     -1,
			FBAFees:         -3,
			Total:           -14,
		},
		{
			TransactionType: "Service Fee",
			Description:     "Werbekosten",
			Total:           -7,
		},
		{
			TransactionType: "Adjustment",
			Description:     "FBA Inventory Reimbursement - Customer Return",
			Total:           4,
		},
		{
			TransactionType: "Debt",
			Total:           2,
		},
	}
	pt3, pt4 := computeMonthlyFinancialCalculations(
		classifyMonthlyFinancialTransactions(transactions),
		"US",
	)
	if pt3["income_product_sales_non_fba"] != "50.00" ||
		pt3["income_fba_product_sales"] != "100.00" ||
		pt3["income_total"] != "157.00" ||
		pt3["expense_total"] != "-51.00" ||
		pt3["expense_cost_of_advertising"] != "-7.00" {
		t.Fatalf("PT3 = %#v", pt3)
	}
	if pt4["income_sales"] != "163.00" ||
		pt4["income_refund"] != "-10.00" ||
		pt4["income_total"] != "157.00" ||
		pt4["expense_total"] != "-51.00" ||
		pt4["amazon_pay_back"] != "106.00" ||
		pt4["credit_card_deduction_usd"] != "2.00" {
		t.Fatalf("PT4 = %#v", pt4)
	}
}

func TestMonthlyFinancialRangeDefaultsAndRejectsReverseRange(t *testing.T) {
	now := time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC)
	start, end, err := monthlyFinancialRange(
		[]string{"2026-08", "2026-10"},
		"",
		"2026-10",
		now,
	)
	if err != nil {
		t.Fatalf("monthlyFinancialRange() error = %v", err)
	}
	if start.Format("2006-01") != "2026-08" || end.Format("2006-01") != "2026-10" {
		t.Fatalf("range = %s..%s", start, end)
	}
	_, _, err = monthlyFinancialRange(
		nil,
		"2026-10",
		"2026-09",
		now,
	)
	if !errors.Is(err, monthly_reports.ErrInvalidFinancialRange) {
		t.Fatalf("reverse range error = %v, want ErrInvalidFinancialRange", err)
	}
}

type monthlyReportRecordingDB struct {
	*fakeWriteDB
	tx *fakeTx
}

func (db *monthlyReportRecordingDB) Begin(context.Context) (pgx.Tx, error) {
	db.tx = &fakeTx{fakeWriteDB: db.fakeWriteDB}
	return db.tx, nil
}
