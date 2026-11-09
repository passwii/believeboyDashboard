package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/agent_credentials"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

func TestAgentCredentialUploadStoreValidatesCSVAndXLSXWithoutLeakingPaths(t *testing.T) {
	root := t.TempDir()
	store := NewAgentCredentialUploadStore(nil, root, 1<<20)

	csvData := []byte(
		"开始日期,结束日期,广告活动名称,预算,定位类型,竞价策略\n" +
			"2026-11-01,2026-11-02,活动A,10,手动,动态竞价\n",
	)
	csvResponse, err := store.Validate(context.Background(), agent_credentials.AgentUploadValidateRequest{
		Filename:   "campaign.csv",
		ReportType: "ad_campaign_report",
		Country:    "US",
		Data:       csvData,
	})
	if err != nil {
		t.Fatalf("Validate(CSV) error = %v", err)
	}
	if csvResponse.Status != "valid" || csvResponse.ReportType != "ad_campaign_report" ||
		csvResponse.TempFileID == "" || csvResponse.ColumnMatchRatio != 1 {
		t.Fatalf("Validate(CSV) = %#v", csvResponse)
	}
	if _, err := store.reports.ResolveUploadTempPath(csvResponse.TempFileID); err != nil {
		t.Fatalf("CSV temp file not registered safely: %v", err)
	}

	xlsxData, err := buildSimpleXLSXSheet("搜索词", [][]string{
		{"开始日期", "结束日期", "投放", "匹配类型", "客户搜索词"},
		{"2026-11-01", "2026-11-02", "关键词", "精确", "running shoes"},
	})
	if err != nil {
		t.Fatalf("buildSimpleXLSXSheet() error = %v", err)
	}
	xlsxResponse, err := store.Validate(context.Background(), agent_credentials.AgentUploadValidateRequest{
		Filename:   "search-terms.xlsx",
		ReportType: "ad_search_term_report",
		Country:    "US",
		Data:       xlsxData,
	})
	if err != nil {
		t.Fatalf("Validate(XLSX) error = %v", err)
	}
	if xlsxResponse.Status != "valid" || xlsxResponse.ReportType != "ad_search_term_report" ||
		xlsxResponse.TempFileID == "" {
		t.Fatalf("Validate(XLSX) = %#v", xlsxResponse)
	}
	if strings.Contains(xlsxResponse.OriginalFilename, root) ||
		strings.Contains(xlsxResponse.TempFileID, root) {
		t.Fatal("validation response leaked a server path")
	}
}

func TestAgentCredentialUploadStoreKeepsInvalidFileTempForRetry(t *testing.T) {
	root := t.TempDir()
	store := NewAgentCredentialUploadStore(nil, root, 1<<20)
	response, err := store.Validate(context.Background(), agent_credentials.AgentUploadValidateRequest{
		Filename:   "unknown.csv",
		ReportType: "sales_report",
		Country:    "US",
		Data:       []byte("alpha,beta\n1,2\n"),
	})
	if err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
	if response.Status != "invalid" || response.ReportType != "unknown" ||
		len(response.Warnings) == 0 {
		t.Fatalf("Validate() = %#v", response)
	}
	path, err := store.reports.ResolveUploadTempPath(response.TempFileID)
	if err != nil {
		t.Fatalf("invalid upload temp was removed too early: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("invalid upload temp stat error = %v", err)
	}
	if filepath.IsAbs(response.TempFileID) {
		t.Fatalf("temp_file_id must be opaque, got %q", response.TempFileID)
	}
}

func TestAgentCredentialStoreCreateHashesSecretAndAuditsInTransaction(t *testing.T) {
	createdAt := time.Date(2026, 11, 8, 8, 0, 0, 0, time.UTC)
	db := &fakeWriteDB{fakeDB: &fakeDB{rowsQueue: []pgx.Row{
		fakeRow{values: []any{false}},
		fakeRow{values: []any{
			int64(42),
			"bbx_12345678",
			"库存助理",
			"read",
			"7",
			"inventory,sales",
			"inventory-simon-v1",
			nil,
			false,
			nil,
			createdAt,
			nil,
			nil,
		}},
	}}}
	auditor := audit.NewMockService()
	store := NewAgentCredentialStore(db, auditor)
	record, plaintext, err := store.CreateAgentKey(
		context.Background(),
		agent_credentials.AgentKeyCreateInput{
			Label:         "库存助理",
			AgentID:       "inventory-simon-v1",
			ProjectScope:  "7",
			BusinessScope: "inventory,sales",
		},
		agent_credentials.Actor{AgentID: "agent-provisioner", Name: "签发员"},
		audit.Entry{
			Action:     "api_key.create",
			TargetType: "agent_api_key",
			AfterJSON:  map[string]any{"via": "agent_provisioning"},
		},
	)
	if err != nil {
		t.Fatalf("CreateAgentKey() error = %v", err)
	}
	if record == nil || record.ID != 42 || !strings.HasPrefix(plaintext, "bbx_") {
		t.Fatalf("CreateAgentKey() = (%#v, %q)", record, plaintext)
	}
	if len(db.queryRowCalls) != 2 {
		t.Fatalf("QueryRow calls = %d, want exists + insert", len(db.queryRowCalls))
	}
	digest := sha256.Sum256([]byte(plaintext))
	if got := db.queryRowCalls[1].args[0]; got != hex.EncodeToString(digest[:]) {
		t.Fatalf("stored key_hash = %#v, want SHA-256", got)
	}
	for _, argument := range db.queryRowCalls[1].args {
		if argument == plaintext {
			t.Fatal("plaintext credential was passed to the database")
		}
	}
	if len(auditor.Entries) != 1 ||
		auditor.Entries[0].TargetID == nil ||
		*auditor.Entries[0].TargetID != "42" {
		t.Fatalf("audit entries = %#v, want target 42", auditor.Entries)
	}
}

func TestAgentCredentialStoreRollsBackWhenAuditFails(t *testing.T) {
	db := &fakeWriteDB{fakeDB: &fakeDB{rowsQueue: []pgx.Row{
		fakeRow{values: []any{false}},
		fakeRow{values: []any{
			int64(42),
			"bbx_12345678",
			"库存助理",
			"read",
			"7",
			"inventory",
			"inventory-simon-v1",
			nil,
			false,
			nil,
			time.Now().UTC(),
			nil,
			nil,
		}},
	}}}
	store := NewAgentCredentialStore(db, failingAuditService{})
	_, _, err := store.CreateAgentKey(
		context.Background(),
		agent_credentials.AgentKeyCreateInput{
			Label: "库存助理", AgentID: "inventory-simon-v1",
			ProjectScope: "7", BusinessScope: "inventory",
		},
		agent_credentials.Actor{AgentID: "agent-provisioner"},
		audit.Entry{Action: "api_key.create", TargetType: "agent_api_key"},
	)
	if err == nil || !strings.Contains(err.Error(), "audit unavailable") {
		t.Fatalf("CreateAgentKey() error = %v, want transaction audit failure", err)
	}
	if len(db.execCalls) != 1 {
		t.Fatalf("Exec calls = %d, want advisory lock before rollback", len(db.execCalls))
	}
}

func TestAgentCredentialStoreUpdateOnlyOverwritesExplicitFields(t *testing.T) {
	createdAt := time.Date(2026, 11, 8, 8, 0, 0, 0, time.UTC)
	db := &fakeWriteDB{fakeDB: &fakeDB{rowsQueue: []pgx.Row{
		fakeRow{values: []any{
			int64(42),
			"bbx_12345678",
			"库存助理",
			"read",
			"7",
			"inventory",
			"inventory-simon-v1",
			nil,
			false,
			nil,
			createdAt,
			nil,
			nil,
		}},
		fakeRow{values: []any{
			int64(42),
			"bbx_12345678",
			"改名后",
			"read",
			"7",
			"inventory,sales",
			"inventory-simon-v1",
			nil,
			false,
			nil,
			createdAt,
			nil,
			nil,
		}},
	}}}
	store := NewAgentCredentialStore(db, audit.NewMockService())
	label := "改名后"
	scope := "inventory,sales"
	record, err := store.UpdateAgentKey(
		context.Background(),
		42,
		agent_credentials.AgentKeyUpdateInput{Label: &label, BusinessScope: &scope},
		agent_credentials.Actor{AgentID: "agent-provisioner"},
		audit.Entry{Action: "api_key.update", TargetType: "agent_api_key"},
	)
	if err != nil {
		t.Fatalf("UpdateAgentKey() error = %v", err)
	}
	if record == nil || record.Label != "改名后" ||
		record.ProjectScope != "7" || record.BusinessScope != "inventory,sales" {
		t.Fatalf("UpdateAgentKey() = %#v", record)
	}
	if len(db.queryRowCalls) != 2 {
		t.Fatalf("QueryRow calls = %d, want select-for-update + update", len(db.queryRowCalls))
	}
	updateArgs := db.queryRowCalls[1].args
	if updateArgs[2] != "7" || updateArgs[3] != "inventory,sales" {
		t.Fatalf("update args = %#v, want untouched project scope and patched business scope", updateArgs)
	}
}

type failingAuditService struct{}

func (failingAuditService) LogAction(context.Context, audit.Entry) error {
	return errors.New("audit unavailable")
}

func (failingAuditService) LogActionTx(context.Context, pgx.Tx, audit.Entry) error {
	return errors.New("audit unavailable")
}

func (failingAuditService) LogView(context.Context, string, string, *string, any, *http.Request) error {
	return nil
}
