package crm_intent

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestNormalizePhone(t *testing.T) {
	cases := []struct {
		raw      string
		expected string
		wantErr  bool
	}{
		{"138-0000-0001", "13800000001", false},
		{" 8613800000001 ", "13800000001", false},
		{"+86 138 0000 0001", "13800000001", false},
		{"12345", "", true},
		{"", "", true},
	}
	for _, test := range cases {
		normalized, err := NormalizePhone(test.raw)
		if test.wantErr {
			if err == nil {
				t.Fatalf("NormalizePhone(%q) expected error", test.raw)
			}
			continue
		}
		if err != nil {
			t.Fatalf("NormalizePhone(%q) error: %v", test.raw, err)
		}
		if normalized != test.expected {
			t.Fatalf("NormalizePhone(%q) = %q, want %q", test.raw, normalized, test.expected)
		}
	}
}

func TestNormalizeNameKey(t *testing.T) {
	if got := NormalizeNameKey("  示例   企业（宁波） "); got != "示例 企业（宁波）" {
		t.Fatalf("NormalizeNameKey = %q", got)
	}
}

func TestNormalizeCompanyInputRejectsContractViolations(t *testing.T) {
	capital := 300.0
	name := "示例企业"
	valid := CompanyInput{
		Name: &name, RegisteredCapitalWan: &capital,
		Phones: []string{"13800000001"}, Sources: []string{"https://a.example.com", "ftp://bad"},
	}
	normalized, err := NormalizeCompanyInput(&valid, true)
	if err != nil {
		t.Fatalf("valid input error: %v", err)
	}
	if len(normalized.Sources) != 1 || normalized.Sources[0] != "https://a.example.com" {
		t.Fatalf("sources = %+v", normalized.Sources)
	}
	invalidScore := CompanyInput{Name: &name, IntentScore: intPointer(101)}
	if _, err := NormalizeCompanyInput(&invalidScore, true); err == nil {
		t.Fatalf("intent_score 101 should fail")
	}
	invalidLevel := CompanyInput{Name: &name, IntentLevel: stringPointer("Z")}
	if _, err := NormalizeCompanyInput(&invalidLevel, true); err == nil {
		t.Fatalf("intent_level Z should fail")
	}
	missingName := CompanyInput{}
	if _, err := NormalizeCompanyInput(&missingName, true); err == nil {
		t.Fatalf("missing name should fail")
	}
}

func TestBuildCompaniesCSVColumns(t *testing.T) {
	company := Company{
		ID: 1, Name: "示例企业", IntentLevel: "A", IntentLevelLabel: "强意向",
		Trademarks: []string{"商标A"}, Sources: []string{}, Phones: []Phone{
			{PhoneNormalized: "13800000001"},
		},
		Followup:  Followup{State: "quoted", StateLabel: "已报价"},
		CreatedAt: "2026-11-10T00:00:00Z",
	}
	content := BuildCompaniesCSV([]Company{company})
	if !strings.HasPrefix(content, "\ufeff") {
		t.Fatalf("CSV missing BOM")
	}
	lines := strings.Split(strings.TrimPrefix(content, "\ufeff"), "\n")
	if len(lines) < 2 {
		t.Fatalf("CSV lines = %d", len(lines))
	}
	header := strings.Split(strings.TrimSuffix(lines[0], "\r"), ",")
	if len(header) != 28 {
		t.Fatalf("CSV header columns = %d, want 28: %v", len(header), header)
	}
	if header[0] != "企业名称" || header[27] != "是否转客户" {
		t.Fatalf("CSV header = %v", header)
	}
}

func TestParseImportFileJSONAndCSV(t *testing.T) {
	jsonPayload := []byte(`{"companies":[{"name":"企业甲","phones":["13800000001"],
			"channel":"展会","channels":["展会","官网"],"channel_source":"展会.csv"},
		{"name":"企业乙","registered_capital_wan":"300万人民币"}],
		"pool":[{"name":"池甲","channel":"展会"}]}`)
	companies, pool, rejected, err := ParseImportFile(jsonPayload, "batch.json")
	if err != nil {
		t.Fatalf("json import error: %v", err)
	}
	if len(companies) != 1 || len(pool) != 1 || len(rejected) != 1 {
		t.Fatalf("json import = %d companies %d pool %d rejected", len(companies), len(pool), len(rejected))
	}
	if !strings.Contains(rejected[0].Reason, "registered_capital_wan") {
		t.Fatalf("rejected reason = %q", rejected[0].Reason)
	}

	csvPayload := []byte("name,phones,intent_level,registered_capital_wan,channel,channels,channel_source\n" +
		"企业甲,13800000001;13900000002,A,300,展会,展会;官网,展会-2026-11-10.csv\n" +
		"企业乙,12345,B,300,,,\n")
	companies, _, rejected, err = ParseImportFile(csvPayload, "batch.csv")
	if err != nil {
		t.Fatalf("csv import error: %v", err)
	}
	if len(companies) != 1 || len(rejected) != 1 {
		t.Fatalf("csv import = %d companies %d rejected", len(companies), len(rejected))
	}
	if len(companies[0].Phones) != 2 {
		t.Fatalf("csv phones = %+v", companies[0].Phones)
	}
	if companies[0].Channel == nil || *companies[0].Channel != "展会" {
		t.Fatalf("csv channel = %v", companies[0].Channel)
	}
	if len(companies[0].Channels) != 2 {
		t.Fatalf("csv channels = %+v", companies[0].Channels)
	}
	if companies[0].ChannelSource == nil {
		t.Fatalf("csv channel_source missing")
	}
	if _, _, _, err := ParseImportFile([]byte("x"), "batch.txt"); err == nil {
		t.Fatalf("unsupported extension should fail")
	}
}

func TestDecodeStrictObject(t *testing.T) {
	var input CompanyInput
	if err := decodeStrictObject([]byte(`{"name":"x"}`), companyImportFields, companyBannedFields, &input); err != nil {
		t.Fatalf("allowed field rejected: %v", err)
	}
	err := decodeStrictObject([]byte(`{"name":"x","owner_id":"u"}`), companyImportFields, companyBannedFields, &input)
	if err == nil || !strings.Contains(err.Error(), "owner_id") {
		t.Fatalf("banned field error = %v", err)
	}
	err = decodeStrictObject([]byte(`{"name":"x","whatever":1}`), companyImportFields, companyBannedFields, &input)
	if err == nil || !strings.Contains(err.Error(), "whatever") {
		t.Fatalf("unknown field error = %v", err)
	}
}

func TestExportOptionalFieldsJSONShape(t *testing.T) {
	company := Company{
		ID: 1, Name: "示例", Trademarks: []string{}, Sources: []string{},
		Phones: []Phone{},
		Followup: Followup{
			CompanyID: 1, State: "none", StateLabel: "未联系",
			ValidPhones: []string{},
		},
		CreatedAt: "2026-11-10T00:00:00Z", UpdatedAt: "2026-11-10T00:00:00Z",
	}
	payload, err := json.Marshal(company)
	if err != nil {
		t.Fatalf("marshal company: %v", err)
	}
	text := string(payload)
	for _, field := range []string{`"intent_level_label"`, `"human_touched"`,
		`"followup"`, `"phones"`, `"channels"`,
		`"channel_source"`, `"shared_phones"`} {
		if field == `"shared_phones"` {
			if strings.Contains(text, field) {
				t.Fatalf("shared_phones should be omitted when empty: %s", text)
			}
			continue
		}
		if !strings.Contains(text, field) {
			t.Fatalf("company JSON missing %s: %s", field, text)
		}
	}
}

func TestValidationLimits(t *testing.T) {
	name := "示例企业"
	longExternalID := strings.Repeat("a", 129)
	if _, err := NormalizeCompanyInput(&CompanyInput{
		Name: &name, ExternalID: &longExternalID,
	}, true); err == nil || !strings.Contains(err.Error(), "external_id") {
		t.Fatalf("external_id >128 should fail, got %v", err)
	}
	longPhoneRaw := "138" + strings.Repeat(" ", 50) + "00000001"
	if _, err := NormalizeCompanyInput(&CompanyInput{
		Name: &name, Phones: []string{longPhoneRaw},
	}, true); err == nil || !strings.Contains(err.Error(), "50") {
		t.Fatalf("phone_raw >50 should fail, got %v", err)
	}
	tooBig := 1000000000000.0
	if _, err := NormalizeCompanyInput(&CompanyInput{
		Name: &name, RegisteredCapitalWan: &tooBig,
	}, true); err == nil || !strings.Contains(err.Error(), "registered_capital_wan") {
		t.Fatalf("registered_capital_wan overflow should fail, got %v", err)
	}
	if _, err := NormalizePoolInput(&PoolInput{
		Name: &name, ExternalID: &longExternalID,
	}); err == nil {
		t.Fatalf("pool external_id >128 should fail")
	}
}

func TestCSVFormulaInjectionGuard(t *testing.T) {
	cases := map[string]string{
		"=cmd|'/c calc'!A0": "'=cmd|'/c calc'!A0",
		"+1+1":              "'+1+1",
		"-2+3":              "'-2+3",
		"@SUM(A1)":          "'@SUM(A1)",
		"正常文本":              "正常文本",
		"":                  "",
	}
	for input, expected := range cases {
		if got := csvSafeCell(input); got != expected {
			t.Fatalf("csvSafeCell(%q) = %q, want %q", input, got, expected)
		}
	}
	company := Company{
		ID: 1, Name: "=HYPERLINK(\"x\")", IntentLevel: "A", IntentLevelLabel: "强意向",
		Trademarks: []string{}, Sources: []string{}, Phones: []Phone{},
		Followup:  Followup{State: "none", StateLabel: "未联系"},
		CreatedAt: "2026-11-10T00:00:00Z",
	}
	content := BuildCompaniesCSV([]Company{company})
	if !strings.Contains(content, "'=HYPERLINK") {
		t.Fatalf("CSV cell should be escaped: %q", content)
	}
}

func intPointer(value int) *int          { return &value }
func stringPointer(value string) *string { return &value }
