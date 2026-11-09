package store

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ad_upload"
)

const validAdCampaignCSV = "开始日期,结束日期,广告活动名称,预算,定位类型,竞价策略\n" +
	"2026-10-10,2026-10-10,Camp1,10.0,AUTO,Dynamic\n"

type captureAdUploadDB struct {
	*fakeWriteDB
	tx *fakeTx
}

func (db *captureAdUploadDB) Begin(context.Context) (pgx.Tx, error) {
	db.tx = &fakeTx{fakeWriteDB: db.fakeWriteDB}
	return db.tx, nil
}

func newAdUploadTestStore(t *testing.T, db FullDB) *AdUploadStore {
	t.Helper()
	return &AdUploadStore{db: db, tempRoot: t.TempDir()}
}

func createAdUploadTempFile(t *testing.T, store *AdUploadStore, extension, data string) string {
	t.Helper()
	tempID, err := generateTempID()
	if err != nil {
		t.Fatalf("generateTempID() error = %v", err)
	}
	if _, err := store.writeAdUploadTempFile(tempID, extension, []byte(data)); err != nil {
		t.Fatalf("writeAdUploadTempFile() error = %v", err)
	}
	return tempID + extension
}

func stringPtr(value string) *string {
	return &value
}

func TestAdUploadRecognizeCSV(t *testing.T) {
	ctx := context.Background()
	db := &fakeDB{
		rows: &fakeRows{
			batches: [][]any{
				{int64(1), "Project Alpha", 0},
			},
		},
	}
	store := newAdUploadTestStore(t, &fakeWriteDB{fakeDB: db})

	resp, err := store.Recognize(ctx, "test_report.csv", []byte(validAdCampaignCSV), "US", "admin", true)
	if err != nil {
		t.Fatalf("Recognize() err = %v", err)
	}
	if resp.ReportType != "ad_campaign_report" {
		t.Errorf("expected ad_campaign_report, got %s", resp.ReportType)
	}
	if resp.Status != "recognized" {
		t.Errorf("expected status recognized, got %s", resp.Status)
	}
	if !adTempFileNamePattern.MatchString(resp.TempFileID) {
		t.Errorf("TempFileID = %q, want random id with a cleaned extension", resp.TempFileID)
	}
	if resp.DetectedStartDate == nil || *resp.DetectedStartDate != "2026-10-10" {
		t.Errorf("expected start date 2026-10-10, got %v", resp.DetectedStartDate)
	}
	if resp.ProjectMatch.Status != "matched" || resp.ProjectMatch.ProjectName == nil || *resp.ProjectMatch.ProjectName != "Project Alpha" {
		t.Errorf("unexpected project match: %#v", resp.ProjectMatch)
	}
	if _, _, err := store.readAdUploadTempFile(resp.TempFileID); err != nil {
		t.Errorf("recognized temp file is not readable: %v", err)
	}
}

func TestAdUploadRecognizeXLSX(t *testing.T) {
	ctx := context.Background()
	xlsxData, err := buildSimpleXLSXSheet("广告位", [][]string{
		{"开始日期", "结束日期", "广告活动名称", "放置"},
		{"2026-10-10", "2026-10-10", "Camp1", "Top of search"},
	})
	if err != nil {
		t.Fatalf("buildSimpleXLSXSheet() error = %v", err)
	}
	db := &fakeDB{
		rows: &fakeRows{batches: [][]any{{int64(1), "Project Alpha", 0}}},
	}
	store := newAdUploadTestStore(t, &fakeWriteDB{fakeDB: db})

	resp, err := store.Recognize(ctx, "test_report.xlsx", xlsxData, "US", "admin", true)
	if err != nil {
		t.Fatalf("Recognize() err = %v", err)
	}
	if resp.ReportType != "ad_placement_report" || resp.RowCountPreview == nil || *resp.RowCountPreview != 1 {
		t.Fatalf("unexpected xlsx recognition: %#v", resp)
	}
}

func TestAdUploadRecognizeRejectsPathTraversalFilename(t *testing.T) {
	store := newAdUploadTestStore(t, &fakeWriteDB{fakeDB: &fakeDB{}})
	_, err := store.Recognize(context.Background(), "../../evil.csv", []byte(validAdCampaignCSV), "US", "admin", true)
	if err == nil || !strings.Contains(err.Error(), "invalid filename path") {
		t.Fatalf("Recognize() error = %v, want path traversal rejection", err)
	}
}

func TestAdUploadTempPathRejectsTraversalAndSymlink(t *testing.T) {
	store := newAdUploadTestStore(t, &fakeWriteDB{fakeDB: &fakeDB{}})
	validID := strings.Repeat("a", 32)
	if _, err := store.writeAdUploadTempFile(validID, ".csv", []byte("a,b\n1,2\n")); err != nil {
		t.Fatalf("write safe temp file: %v", err)
	}
	if _, _, err := store.readAdUploadTempFile(validID + ".csv"); err != nil {
		t.Fatalf("read safe temp file: %v", err)
	}

	for _, tempID := range []string{"../escape.csv", filepath.Join(store.tempRoot, "absolute.csv"), validID + ".txt"} {
		if _, _, err := store.readAdUploadTempFile(tempID); err == nil {
			t.Fatalf("readAdUploadTempFile(%q) succeeded, want rejection", tempID)
		}
	}

	linkID := strings.Repeat("b", 32) + ".csv"
	linkPath := filepath.Join(store.tempRoot, linkID)
	outsidePath := filepath.Join(t.TempDir(), "outside.csv")
	if err := os.WriteFile(outsidePath, []byte("outside"), 0600); err != nil {
		t.Fatalf("write outside file: %v", err)
	}
	if err := os.Symlink(outsidePath, linkPath); err != nil {
		t.Fatalf("create symlink: %v", err)
	}
	if _, _, err := store.readAdUploadTempFile(linkID); err == nil || !strings.Contains(err.Error(), "regular file") {
		t.Fatalf("readAdUploadTempFile(symlink) error = %v, want symlink rejection", err)
	}
}

func TestAdUploadTempDirectoryErrorsAreReturned(t *testing.T) {
	root := t.TempDir()
	blocked := filepath.Join(root, "blocked")
	if err := os.WriteFile(blocked, []byte("not a directory"), 0600); err != nil {
		t.Fatalf("write blocked path: %v", err)
	}
	db := &fakeDB{
		rows: &fakeRows{batches: [][]any{{int64(1), "Project Alpha", 0}}},
	}
	store := &AdUploadStore{db: &fakeWriteDB{fakeDB: db}, tempRoot: blocked}
	if _, err := store.Recognize(context.Background(), "report.csv", []byte(validAdCampaignCSV), "US", "admin", true); err == nil {
		t.Fatal("Recognize() succeeded with a non-directory temp root")
	}
}

func TestAdUploadCommitDryRunDoesNotWrite(t *testing.T) {
	ctx := context.Background()
	op := "alice"
	as := "bob"
	db := &fakeDB{
		rowsQueue: []pgx.Row{fakeRow{values: []any{int64(1), &op, &as}}},
	}
	writeDB := &fakeWriteDB{fakeDB: db}
	store := newAdUploadTestStore(t, writeDB)
	tempID := createAdUploadTempFile(t, store, ".csv", validAdCampaignCSV)

	start := "2026-10-10"
	req := ad_upload.AdUploadCommitRequest{
		TempFileID:       tempID,
		ReportType:       "ad_campaign_report",
		OriginalFilename: stringPtr("report.csv"),
		ProjectName:      &op,
		Country:          "US",
		ReportStartDate:  &start,
		ReportEndDate:    &start,
		DryRun:           true,
	}

	resp, err := store.Commit(ctx, req, "alice", false)
	if err != nil {
		t.Fatalf("Commit(dry_run) err = %v", err)
	}
	if resp.IngestionStatus != "skipped" || resp.Version != 0 || resp.IsCurrent {
		t.Errorf("unexpected dry run response: %#v", resp)
	}
	if len(writeDB.execCalls) != 0 {
		t.Fatalf("dry_run wrote %d Exec calls, want 0", len(writeDB.execCalls))
	}
	if len(db.queryRowCalls) != 1 {
		t.Fatalf("dry_run QueryRow calls = %d, want only project lookup", len(db.queryRowCalls))
	}
}

func TestAdUploadCommitWritesDetailsInTransaction(t *testing.T) {
	ctx := context.Background()
	op := "alice"
	as := "bob"
	db := &fakeDB{
		rowsQueue: []pgx.Row{
			fakeRow{values: []any{int64(1), &op, &as}},
			fakeRow{values: []any{int64(0)}},
			fakeRow{values: []any{int64(42)}},
		},
	}
	captured := &captureAdUploadDB{fakeWriteDB: &fakeWriteDB{fakeDB: db}}
	store := newAdUploadTestStore(t, captured)
	tempID := createAdUploadTempFile(t, store, ".csv", validAdCampaignCSV)

	start := "2026-10-10"
	req := ad_upload.AdUploadCommitRequest{
		TempFileID:       tempID,
		ReportType:       "ad_campaign_report",
		OriginalFilename: stringPtr("report.csv"),
		ProjectName:      &op,
		Country:          "US",
		ReportStartDate:  &start,
		ReportEndDate:    &start,
	}

	resp, err := store.Commit(ctx, req, "alice", false)
	if err != nil {
		t.Fatalf("Commit() err = %v", err)
	}
	if resp.ID != 42 || resp.Version != 1 || resp.IngestionStatus != "success" {
		t.Fatalf("unexpected commit response: %#v", resp)
	}
	if captured.tx == nil || !captured.tx.committed {
		t.Fatalf("transaction not committed: tx=%#v", captured.tx)
	}

	var detailInserted, uploadLogInserted bool
	for _, call := range captured.execCalls {
		if strings.Contains(call.sql, "ad_upload_campaign_rows") {
			detailInserted = true
		}
		if strings.Contains(call.sql, "report_upload_logs") {
			uploadLogInserted = true
		}
	}
	if !detailInserted || !uploadLogInserted {
		t.Fatalf("expected detail and upload log inserts, got calls: %#v", captured.execCalls)
	}

	var successInsert bool
	for _, call := range db.queryRowCalls {
		if strings.Contains(call.sql, "insert into ad_upload_files") && strings.Contains(call.sql, "'success'") {
			successInsert = true
		}
	}
	if !successInsert {
		t.Fatal("ad_upload_files insert did not persist ingestion_status 'success'")
	}
}

func TestAdUploadCommitRollsBackOnWriteFailure(t *testing.T) {
	ctx := context.Background()
	op := "alice"
	as := "bob"
	db := &fakeDB{
		rowsQueue: []pgx.Row{
			fakeRow{values: []any{int64(1), &op, &as}},
			fakeRow{values: []any{int64(0)}},
			fakeRow{values: []any{int64(42)}},
		},
	}
	writeDB := &fakeWriteDB{fakeDB: db, execErr: errors.New("write failed")}
	captured := &captureAdUploadDB{fakeWriteDB: writeDB}
	store := newAdUploadTestStore(t, captured)
	tempID := createAdUploadTempFile(t, store, ".csv", validAdCampaignCSV)
	start := "2026-10-10"
	req := ad_upload.AdUploadCommitRequest{
		TempFileID:       tempID,
		ReportType:       "ad_campaign_report",
		OriginalFilename: stringPtr("report.csv"),
		ProjectName:      &op,
		Country:          "US",
		ReportStartDate:  &start,
		ReportEndDate:    &start,
	}

	if _, err := store.Commit(ctx, req, "alice", false); err == nil {
		t.Fatal("Commit() succeeded despite Exec failure")
	}
	if captured.tx == nil || !captured.tx.rolledBack || captured.tx.committed {
		t.Fatalf("transaction not rolled back: tx=%#v", captured.tx)
	}
}

func TestAdUploadRecognizeUnrecognized(t *testing.T) {
	store := newAdUploadTestStore(t, &fakeWriteDB{fakeDB: &fakeDB{}})
	_, err := store.Recognize(context.Background(), "bad.csv", []byte("col_a,col_b,col_c\n1,2,3\n"), "US", "admin", true)
	if err == nil {
		t.Fatal("expected error for unrecognized headers")
	}
}

func TestAdUploadListStatusEmpty(t *testing.T) {
	db := &fakeDB{}
	store := newAdUploadTestStore(t, &fakeWriteDB{fakeDB: db})
	filter := ad_upload.AdUploadStatusFilter{
		Country: "US",
		IsAdmin: true,
		Limit:   50,
	}
	resp, err := store.ListStatus(context.Background(), filter)
	if err != nil {
		t.Fatalf("ListStatus error: %v", err)
	}
	if resp.Country != "US" || len(resp.Items) != 0 {
		t.Fatalf("unexpected ListStatus resp: %#v", resp)
	}
}

func TestAdUploadStoreIntegration(t *testing.T) {
	databaseURL := os.Getenv("GO_API_TEST_DATABASE_URL")
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

	projectName := fmt.Sprintf("stage4-ad-upload-integration-%d", time.Now().UnixNano())
	var projectID int64
	if err := pool.QueryRow(ctx, `
		insert into public.projects (project_name, sort_order, project_operator, commission_rate)
		values ($1, 9999, 'alice', 0.15)
		returning id
	`, projectName).Scan(&projectID); err != nil {
		t.Fatalf("insert project: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `delete from public.projects where id = $1`, projectID)
	})

	store := &AdUploadStore{db: NewPGXDB(pool), tempRoot: t.TempDir()}
	today := time.Now().UTC().Format("2006-01-02")
	successCSV := "开始日期,结束日期,广告活动名称,预算,定位类型,竞价策略\n" +
		today + "," + today + ",Camp-Integration,10.0,AUTO,Dynamic\n"
	tempID := createAdUploadTempFile(t, store, ".csv", successCSV)
	req := ad_upload.AdUploadCommitRequest{
		TempFileID:       tempID,
		ReportType:       "ad_campaign_report",
		OriginalFilename: stringPtr("integration.csv"),
		ProjectName:      &projectName,
		Country:          "US",
		ReportStartDate:  &today,
		ReportEndDate:    &today,
	}
	resp, err := store.Commit(ctx, req, "alice", false)
	if err != nil {
		t.Fatalf("Commit() error = %v", err)
	}
	if resp.IngestionStatus != "success" || resp.Version != 1 {
		t.Fatalf("unexpected commit response: %#v", resp)
	}

	var ingestionStatus, extension string
	var rowCount int
	if err := pool.QueryRow(ctx, `
		select ingestion_status, file_extension, row_count_preview
		from public.ad_upload_files
		where project_id = $1 and report_type = 'ad_campaign_report'
		  and period_start_date = $2::date and is_current = true
	`, projectID, today).Scan(&ingestionStatus, &extension, &rowCount); err != nil {
		t.Fatalf("query ad_upload_files: %v", err)
	}
	if ingestionStatus != "success" || extension != ".csv" || rowCount != 1 {
		t.Fatalf("unexpected persisted header: %s %s %d", ingestionStatus, extension, rowCount)
	}

	var campaignName string
	if err := pool.QueryRow(ctx, `
		select campaign_name
		from public.ad_upload_campaign_rows
		where source_file_id = $1
	`, resp.ID).Scan(&campaignName); err != nil {
		t.Fatalf("query campaign detail: %v", err)
	}
	if campaignName != "Camp-Integration" {
		t.Fatalf("campaign_name = %q", campaignName)
	}

	var logCount int
	if err := pool.QueryRow(ctx, `
		select count(*)
		from public.report_upload_logs
		where project_id = $1 and report_type = 'ad_campaign_report' and upload_date = $2::date
	`, projectID, today).Scan(&logCount); err != nil {
		t.Fatalf("query report_upload_logs: %v", err)
	}
	if logCount != 1 {
		t.Fatalf("report_upload_logs count = %d, want 1", logCount)
	}

	rollbackDate := time.Now().UTC().AddDate(0, 0, 1).Format("2006-01-02")
	tooLongName := strings.Repeat("x", 300)
	rollbackCSV := "开始日期,结束日期,广告活动名称,预算,定位类型,竞价策略\n" +
		rollbackDate + "," + rollbackDate + "," + tooLongName + ",10.0,AUTO,Dynamic\n"
	rollbackTempID := createAdUploadTempFile(t, store, ".csv", rollbackCSV)
	rollbackReq := req
	rollbackReq.TempFileID = rollbackTempID
	rollbackReq.ReportStartDate = &rollbackDate
	rollbackReq.ReportEndDate = &rollbackDate
	if _, err := store.Commit(ctx, rollbackReq, "alice", false); err == nil {
		t.Fatal("Commit() succeeded for an overlong detail value")
	}

	var rolledBackFiles, rolledBackLogs int
	if err := pool.QueryRow(ctx, `
		select
			(select count(*) from public.ad_upload_files
			 where project_id = $1 and period_start_date = $2::date),
			(select count(*) from public.report_upload_logs
			 where project_id = $1 and upload_date = $2::date)
	`, projectID, rollbackDate).Scan(&rolledBackFiles, &rolledBackLogs); err != nil {
		t.Fatalf("query rollback state: %v", err)
	}
	if rolledBackFiles != 0 || rolledBackLogs != 0 {
		t.Fatalf("rollback left files=%d logs=%d", rolledBackFiles, rolledBackLogs)
	}
}

func TestAdUploadStoreIntegrationAllDetailTables(t *testing.T) {
	databaseURL := os.Getenv("GO_API_TEST_DATABASE_URL")
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

	projectName := fmt.Sprintf("stage4-ad-upload-all-tables-%d", time.Now().UnixNano())
	var projectID int64
	if err := pool.QueryRow(ctx, `
		insert into public.projects (project_name, sort_order, project_operator, commission_rate)
		values ($1, 9999, 'alice', 0.15)
		returning id
	`, projectName).Scan(&projectID); err != nil {
		t.Fatalf("insert project: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `delete from public.projects where id = $1`, projectID)
	})

	today := time.Now().UTC().Format("2006-01-02")
	tests := []struct {
		reportType string
		extension  string
		headers    []string
		row        []string
	}{
		{
			reportType: "ad_search_term_share_report", extension: ".csv",
			headers: []string{"开始日期", "结束日期", "客户搜索词", "搜索词展示量排名", "搜索词展示量份额"},
			row:     []string{today, today, "term", "1", "10%"},
		},
		{
			reportType: "ad_budget_report", extension: ".csv",
			headers: []string{"开始日期", "结束日期", "广告活动名称", "建议预算", "预算范围内的平均时间"},
			row:     []string{today, today, "campaign", "10", "50%"},
		},
		{
			reportType: "ad_campaign_report", extension: ".csv",
			headers: []string{"开始日期", "结束日期", "广告活动名称", "预算", "定位类型", "竞价策略"},
			row:     []string{today, today, "campaign", "10", "AUTO", "Dynamic"},
		},
		{
			reportType: "ad_purchased_product_report", extension: ".xlsx",
			headers: []string{"开始日期", "结束日期", "广告SKU", "广告ASIN", "已购买的ASIN"},
			row:     []string{today, today, "sku-1", "asin-1", "asin-2"},
		},
		{
			reportType: "ad_promoted_product_report", extension: ".xlsx",
			headers: []string{"开始日期", "结束日期", "广告SKU", "广告ASIN", "广告活动名称", "广告组名称"},
			row:     []string{today, today, "sku-1", "asin-1", "campaign", "group"},
		},
		{
			reportType: "ad_invalid_traffic_report", extension: ".xlsx",
			headers: []string{"开始日期", "结束日期", "广告活动名称", "总展示量", "无效展示量", "无效点击"},
			row:     []string{today, today, "campaign", "10", "1", "1"},
		},
		{
			reportType: "ad_placement_report", extension: ".xlsx",
			headers: []string{"开始日期", "结束日期", "广告活动名称", "放置"},
			row:     []string{today, today, "campaign", "Top of search"},
		},
		{
			reportType: "ad_target_report", extension: ".xlsx",
			headers: []string{"开始日期", "结束日期", "投放", "匹配类型", "搜索结果首页首位展示量份额"},
			row:     []string{today, today, "target", "EXACT", "10%"},
		},
		{
			reportType: "ad_search_term_report", extension: ".xlsx",
			headers: []string{"开始日期", "结束日期", "投放", "匹配类型", "客户搜索词"},
			row:     []string{today, today, "target", "EXACT", "term"},
		},
		{
			reportType: "ad_time_trend_report", extension: ".xlsx",
			headers: []string{"开始日期", "结束日期", "国家/地区", "货币", "点击量", "单次点击成本 (CPC)", "花费"},
			row:     []string{today, today, "US", "USD", "5", "1.20", "6.00"},
		},
	}

	store := &AdUploadStore{db: NewPGXDB(pool), tempRoot: t.TempDir()}
	for _, test := range tests {
		t.Run(test.reportType, func(t *testing.T) {
			var data []byte
			if test.extension == ".csv" {
				data = []byte(strings.Join(test.headers, ",") + "\n" + strings.Join(test.row, ",") + "\n")
			} else {
				generated, err := buildSimpleXLSXSheet(test.reportType, [][]string{test.headers, test.row})
				if err != nil {
					t.Fatalf("build xlsx: %v", err)
				}
				data = generated
			}
			tempID := createAdUploadTempFile(t, store, test.extension, string(data))
			req := ad_upload.AdUploadCommitRequest{
				TempFileID:       tempID,
				ReportType:       test.reportType,
				OriginalFilename: stringPtr("report" + test.extension),
				ProjectName:      &projectName,
				Country:          "US",
				ReportStartDate:  &today,
				ReportEndDate:    &today,
			}
			resp, err := store.Commit(ctx, req, "alice", false)
			if err != nil {
				t.Fatalf("Commit() error = %v", err)
			}
			var detailCount int
			if err := pool.QueryRow(ctx,
				fmt.Sprintf("select count(*) from public.%s where source_file_id = $1", adDetailTable(test.reportType)),
				resp.ID,
			).Scan(&detailCount); err != nil {
				t.Fatalf("query %s: %v", adDetailTable(test.reportType), err)
			}
			if detailCount != 1 {
				t.Fatalf("%s rows = %d, want 1", adDetailTable(test.reportType), detailCount)
			}
		})
	}
}
