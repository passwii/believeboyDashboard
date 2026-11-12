package livecontract

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestBuildCasesIsStable(t *testing.T) {
	fixtures := Fixtures{
		ProjectID:          "11",
		ExchangeRateID:     "22",
		NotificationUserID: "33",
		NotificationID:     "44",
		ProfileUserID:      "uuid-55",
		AlertRuleID:        "66",
		AlertEventID:       "77",
	}
	first := BuildCases(fixtures)
	second := BuildCases(fixtures)
	if len(first) != 15 {
		t.Fatalf("cases = %d, want 15", len(first))
	}
	for index := range first {
		if first[index].Name != second[index].Name ||
			first[index].Route != second[index].Route ||
			first[index].RequestPath != second[index].RequestPath ||
			first[index].HeaderRole != second[index].HeaderRole ||
			len(first[index].MaskedKeys) != len(second[index].MaskedKeys) {
			t.Fatalf("case %d is not deterministic", index)
		}
	}
	if routes := DistinctRoutes(first); len(routes) != 14 {
		t.Fatalf("distinct routes = %d, want 14", len(routes))
	}
}

func TestApplyTokensOnlyReplacesWholeScalars(t *testing.T) {
	fixtures := Fixtures{NotificationID: "12", ProfileUserID: "abc-uuid"}
	body := []byte(`{"id":"abc-uuid","created_at":"2026-10-21T12:47:33Z","count":12,"nested":{"id":12}}`)
	tokenized := ApplyTokens(body, fixtures)
	var decoded map[string]any
	if err := json.Unmarshal(tokenized, &decoded); err != nil {
		t.Fatalf("decode tokenized body: %v (%s)", err, tokenized)
	}
	if decoded["id"] != TokenProfileUserID {
		t.Errorf("profile id = %v, want %s", decoded["id"], TokenProfileUserID)
	}
	if decoded["created_at"] != "2026-10-21T12:47:33Z" {
		t.Errorf("timestamp was rewritten: %v", decoded["created_at"])
	}
	if decoded["count"] != TokenNotificationID {
		t.Errorf("count = %v, want %s", decoded["count"], TokenNotificationID)
	}
	nested, ok := decoded["nested"].(map[string]any)
	if !ok || nested["id"] != TokenNotificationID {
		t.Errorf("nested id = %v, want %s", decoded["nested"], TokenNotificationID)
	}
}

func TestApplyTokensValueKeepsUnrelatedValues(t *testing.T) {
	fixtures := Fixtures{ProjectID: "13429"}
	value := map[string]any{
		"project_id": "13429",
		"label":      "13429",
		"number":     json.Number("13429"),
		"other":      json.Number("1"),
	}
	tokenized, ok := ApplyTokensValue(value, fixtures).(map[string]any)
	if !ok {
		t.Fatal("expected a map")
	}
	if tokenized["project_id"] != TokenProjectID || tokenized["number"] != TokenProjectID {
		t.Fatalf("tokenized = %#v", tokenized)
	}
	if tokenized["other"] != json.Number("1") {
		t.Fatalf("other = %v", tokenized["other"])
	}
}

func TestGoldenFileValidate(t *testing.T) {
	if err := (GoldenFile{}).Validate(); err == nil {
		t.Fatal("empty golden file must be rejected")
	}
	bad := GoldenFile{Cases: []GoldenCase{{Name: "x", Status: 500}}}
	if err := bad.Validate(); err == nil {
		t.Fatal("5xx recording must be rejected")
	}
	good := GoldenFile{Cases: []GoldenCase{{Name: "x", Status: 200}}}
	if err := good.Validate(); err != nil {
		t.Fatalf("validate: %v", err)
	}
}

func TestCommittedGoldenFileIsValid(t *testing.T) {
	path := filepath.Join("..", "..", "tests", "contract", "testdata", "week1_live_golden.json")
	payload, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read committed golden: %v", err)
	}
	var golden GoldenFile
	if err := json.Unmarshal(payload, &golden); err != nil {
		t.Fatalf("decode committed golden: %v", err)
	}
	if err := golden.Validate(); err != nil {
		t.Fatalf("committed golden is invalid: %v", err)
	}
	if len(golden.Cases) != 15 {
		t.Fatalf("golden cases = %d, want 15", len(golden.Cases))
	}
}

func TestLoadEnvFileAndDisposableGuard(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".env.test")
	contents := "# comment\nAPI_KEY='key with spaces'\nDATABASE_URL=postgresql+psycopg://u:p@h:5432/BLF_TEST\n"
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	values, err := LoadEnvFile(path)
	if err != nil {
		t.Fatalf("LoadEnvFile: %v", err)
	}
	if values["API_KEY"] != "key with spaces" {
		t.Errorf("API_KEY = %q", values["API_KEY"])
	}
	if err := RequireDisposableDatabase(values["DATABASE_URL"]); err != nil {
		t.Errorf("BLF_TEST rejected: %v", err)
	}
	if err := RequireDisposableDatabase("postgresql://u:p@h:5432/BLF"); err == nil {
		t.Error("production BLF database must be rejected")
	}
}
