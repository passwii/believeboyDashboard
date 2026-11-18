package store

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

type monthlyReportExecRecorder struct {
	sql  string
	args []any
}

func (recorder *monthlyReportExecRecorder) Exec(
	_ context.Context,
	sql string,
	args ...any,
) (pgconn.CommandTag, error) {
	recorder.sql = sql
	recorder.args = args
	return pgconn.NewCommandTag("INSERT 0 1"), nil
}

func TestInsertMonthlyReportCalculationCastsJSONBParameters(t *testing.T) {
	recorder := &monthlyReportExecRecorder{}
	if err := insertMonthlyReportPT3(
		context.Background(),
		recorder,
		42,
		"Test Project",
		"2026-10",
		map[string]string{"income_total": "10.00"},
	); err != nil {
		t.Fatalf("insertMonthlyReportPT3() error = %v", err)
	}
	for _, fragment := range []string{
		"'report_id', $1::bigint",
		"'project_name', $2::text",
		"'report_month', $3::text",
		"'income_total', $19::numeric",
	} {
		if !strings.Contains(recorder.sql, fragment) {
			t.Fatalf("SQL missing parameter cast %q:\n%s", fragment, recorder.sql)
		}
	}
	if got, want := len(recorder.args), 3+len(monthlyReportPT3Columns); got != want {
		t.Fatalf("args = %d, want %d", got, want)
	}
}

func TestFinalizeCompletedMonthlyReportIntegration(t *testing.T) {
	databaseURL := strings.TrimSpace(os.Getenv("GO_API_TEST_DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("set GO_API_TEST_DATABASE_URL to a BLF_test connection")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := OpenPool(ctx, databaseURL)
	if err != nil {
		t.Fatalf("OpenPool() error = %v", err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("test database unavailable: %v", err)
	}

	projectName := fmt.Sprintf("monthly-report-finalize-integration-%d", time.Now().UnixNano())
	var projectID int64
	if err := pool.QueryRow(ctx, `
insert into public.projects (project_name, sort_order, project_operator, commission_rate)
values ($1, 9999, 'alice', 0.15)
returning id
`, projectName).Scan(&projectID); err != nil {
		t.Fatalf("insert project: %v", err)
	}
	var reportID, jobID int64
	if err := pool.QueryRow(ctx, `
insert into public.jobs (job_type, status, payload_json)
values ('monthly_report', 'running'::jobstatus, '{}'::json)
returning id
`).Scan(&jobID); err != nil {
		t.Fatalf("insert job: %v", err)
	}
	if err := pool.QueryRow(ctx, `
insert into public.monthly_reports (
project_id, project_name, report_month, transaction_file_id,
transaction_file_path, status
) values (
$1, $2, '2026-10', '', '', 'pending'::jobstatus
)
returning id
`, projectID, projectName).Scan(&reportID); err != nil {
		t.Fatalf("insert monthly report: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `delete from public.monthly_report_transactions where report_id = $1`, reportID)
		_, _ = pool.Exec(context.Background(), `delete from public.monthly_report_pt3_calculation where report_id = $1`, reportID)
		_, _ = pool.Exec(context.Background(), `delete from public.monthly_report_pt4_calculation where report_id = $1`, reportID)
		_, _ = pool.Exec(context.Background(), `delete from public.monthly_reports where id = $1`, reportID)
		_, _ = pool.Exec(context.Background(), `delete from public.jobs where id = $1`, jobID)
		_, _ = pool.Exec(context.Background(), `delete from public.projects where id = $1`, projectID)
	})

	resultRoot := t.TempDir()
	resultPath := filepath.Join(resultRoot, "report.xlsx")
	if err := os.WriteFile(resultPath, []byte{'P', 'K', 0x03, 0x04}, 0o600); err != nil {
		t.Fatalf("write workbook fixture: %v", err)
	}
	store := NewMonthlyReportStoreWithRoots(NewPGXDB(pool), resultRoot, resultRoot)
	computed := MonthlyReportComputedResult{
		ResultPath: resultPath,
		Transactions: []MonthlyReportComputedTransaction{{
			SourceRowNo:     1,
			TransactionDate: time.Date(2026, 10, 1, 8, 27, 54, 0, time.UTC),
			SettlementID:    "S-1",
			TransactionType: "Order",
			ProductSales:    "10.00",
			Total:           "10.00",
			RawRowJSON:      []byte(`{"type":"Order"}`),
		}},
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
	if err := store.FinalizeCompletedReport(ctx, reportID, jobID, computed); err != nil {
		t.Fatalf("FinalizeCompletedReport() error = %v", err)
	}

	var status string
	var totalTransactions int
	if err := pool.QueryRow(ctx, `
select status::text, total_transactions
from public.monthly_reports
where id = $1
`, reportID).Scan(&status, &totalTransactions); err != nil {
		t.Fatalf("query finalized report: %v", err)
	}
	if status != "success" || totalTransactions != 1 {
		t.Fatalf("finalized report status = %q, total_transactions = %d", status, totalTransactions)
	}
	for _, table := range []string{
		"monthly_report_transactions",
		"monthly_report_pt3_calculation",
		"monthly_report_pt4_calculation",
	} {
		var count int
		if err := pool.QueryRow(ctx, `select count(*) from public.`+table+` where report_id = $1`, reportID).Scan(&count); err != nil {
			t.Fatalf("query %s: %v", table, err)
		}
		if count != 1 {
			t.Fatalf("%s rows = %d, want 1", table, count)
		}
	}
}
