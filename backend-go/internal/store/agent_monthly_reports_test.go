package store

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAgentMonthlyMonthAndCountryValidation(t *testing.T) {
	for _, value := range []string{"2026-01", "2026-10", "2026-12"} {
		if got, err := normalizeAgentMonthlyMonth(value); err != nil || got != value {
			t.Fatalf("normalizeAgentMonthlyMonth(%q) = %q, %v", value, got, err)
		}
	}
	for _, value := range []string{"", "2026-1", "2026-13", "202601", "2026-1x"} {
		if _, err := normalizeAgentMonthlyMonth(value); !errors.Is(err, ErrAgentMonthlyInvalidInput) {
			t.Fatalf("normalizeAgentMonthlyMonth(%q) error = %v", value, err)
		}
	}

	cases := map[string]string{
		"us":             "US",
		"USA":            "US",
		"美国站":            "US",
		"de":             "DE",
		"Germany":        "DE",
		"gb":             "UK",
		"United Kingdom": "UK",
	}
	for input, want := range cases {
		got, err := normalizeAgentMonthlyCountry(input)
		if err != nil || got != want {
			t.Fatalf("normalizeAgentMonthlyCountry(%q) = %q, %v; want %q", input, got, err, want)
		}
	}
	if _, err := normalizeAgentMonthlyCountry("FR"); !errors.Is(err, ErrAgentMonthlyInvalidInput) {
		t.Fatalf("unsupported country error = %v", err)
	}
}

func TestAgentMonthlyAccountingRowsLayout(t *testing.T) {
	pt3 := map[string]float64{
		"income_total":     100,
		"expense_total":    80,
		"income_vat_total": 7,
	}
	rows := buildAgentMonthlyAccountingRows(pt3, "DE")
	if len(rows) != 22 {
		t.Fatalf("row count = %d, want 22", len(rows))
	}
	if rows[len(rows)-2].Kind != "spacer" || rows[len(rows)-1].Kind != "total" {
		t.Fatalf("tail kinds = %q, %q", rows[len(rows)-2].Kind, rows[len(rows)-1].Kind)
	}
	if rows[len(rows)-1].IncomeAmountLocal != 100 ||
		rows[len(rows)-1].ExpenseAmountLocal != 80 {
		t.Fatalf("total row = %#v", rows[len(rows)-1])
	}
	if rows[len(rows)-1].CurrencyCode == nil || *rows[len(rows)-1].CurrencyCode != "EUR" {
		t.Fatalf("currency = %#v", rows[len(rows)-1].CurrencyCode)
	}
}

func TestAgentMonthlyCSVValidation(t *testing.T) {
	if err := validateAgentMonthlyCSVData([]byte("type,quantity,total\nOrder,1,10\n")); err != nil {
		t.Fatalf("valid CSV error = %v", err)
	}
	for _, payload := range [][]byte{
		nil,
		[]byte("type,quantity,total\n"),
		[]byte("\x00\x01"),
	} {
		if err := validateAgentMonthlyCSVData(payload); !errors.Is(err, ErrAgentMonthlyInvalidInput) {
			t.Fatalf("invalid CSV %q error = %v", payload, err)
		}
	}
}

func TestAgentMonthlyUploadValidationHelpers(t *testing.T) {
	if !agentMonthlyContentTypeAllowed(agentMonthlyCSVKind, "text/csv") ||
		!agentMonthlyContentTypeAllowed(agentMonthlyPDFKind, "application/pdf") {
		t.Fatal("expected CSV/PDF content types were rejected")
	}
	if agentMonthlyContentTypeAllowed(agentMonthlyCSVKind, "image/png") ||
		agentMonthlyContentTypeAllowed(agentMonthlyPDFKind, "text/html") {
		t.Fatal("unexpected content type was accepted")
	}
	if got := safeUploadFilename("../../unsafe.csv", "upload.bin"); got != "unsafe.csv" {
		t.Fatalf("safeUploadFilename = %q", got)
	}

	directory := t.TempDir()
	csvPath := filepath.Join(directory, "valid.csv")
	if err := os.WriteFile(
		csvPath,
		[]byte("type,quantity,total\nOrder,1,10\n"),
		0o600,
	); err != nil {
		t.Fatalf("write CSV fixture: %v", err)
	}
	validation, err := validateAgentMonthlyUploadedFile(csvPath, agentMonthlyCSVKind)
	if err != nil {
		t.Fatalf("valid CSV validation error = %v", err)
	}
	if validation["rows"] != 1 {
		t.Fatalf("CSV row count = %#v", validation["rows"])
	}

	pdfPath := filepath.Join(directory, "valid.pdf")
	if err := os.WriteFile(pdfPath, []byte("%PDF-fixture"), 0o600); err != nil {
		t.Fatalf("write PDF fixture: %v", err)
	}
	if _, err := validateAgentMonthlyUploadedFile(pdfPath, agentMonthlyPDFKind); err != nil {
		t.Fatalf("valid PDF validation error = %v", err)
	}
	if err := os.WriteFile(pdfPath, []byte("not-a-pdf"), 0o600); err != nil {
		t.Fatalf("rewrite PDF fixture: %v", err)
	}
	if _, err := validateAgentMonthlyUploadedFile(
		pdfPath,
		agentMonthlyPDFKind,
	); !errors.Is(err, ErrAgentMonthlyInvalidInput) {
		t.Fatalf("invalid PDF error = %v", err)
	}

	source := filepath.Join(directory, "source.bin")
	if err := os.WriteFile(source, []byte("0123456789"), 0o600); err != nil {
		t.Fatalf("write size fixture: %v", err)
	}
	if _, _, err := copyAgentMonthlyFile(
		source,
		filepath.Join(directory, "copy.bin"),
		5,
	); !errors.Is(err, ErrAgentMonthlyInvalidInput) {
		t.Fatalf("oversize copy error = %v", err)
	}
}

func TestAgentMonthlyReconciliationErrorMapping(t *testing.T) {
	for _, err := range []error{
		errors.New("worksheet 报表核算 not found"),
		errors.New("failed to extract PDF data: invalid xref"),
		errors.New("invalid value in Excel cell C4"),
		errors.New("zip: not a valid zip file"),
	} {
		if mapped := mapAgentMonthlyManualReconcileError(err); !errors.Is(
			mapped,
			ErrAgentMonthlyInvalidInput,
		) {
			t.Fatalf("manual mapping for %q = %v", err, mapped)
		}
	}
	if mapped := mapAgentMonthlyManualReconcileError(errors.New("database connection failed")); mapped == ErrAgentMonthlyInvalidInput {
		t.Fatalf("unexpected manual invalid-input mapping for internal error: %v", mapped)
	}
	for _, err := range []error{
		errors.New("Report 42 does not have a summary PDF uploaded to R2"),
		errors.New("failed to extract PDF data: invalid xref"),
		errors.New("failed to extract reconciliation metrics from PDF"),
	} {
		if mapped := mapAgentMonthlyReconcileError(err); !errors.Is(
			mapped,
			ErrAgentMonthlyNotReady,
		) {
			t.Fatalf("auto mapping for %q = %v", err, mapped)
		}
	}
}

func TestAgentMonthlyDirectoryRejectsSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	link := filepath.Join(root, "link")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := ensureAgentMonthlyDir(root, "link", "nested"); !errors.Is(err, ErrAgentMonthlyInvalidInput) {
		t.Fatalf("symlink escape error = %v", err)
	}
}

func TestAgentMonthlyFileResolutionRejectsOutsidePaths(t *testing.T) {
	root := t.TempDir()
	outsideDirectory := t.TempDir()
	outsideFile := filepath.Join(outsideDirectory, "outside.xlsx")
	if err := os.WriteFile(outsideFile, []byte("PK\x03\x04outside"), 0o600); err != nil {
		t.Fatalf("write outside file: %v", err)
	}
	if got := existingRegularFile(&outsideFile, root); got != "" {
		t.Fatalf("absolute outside path resolved to %q", got)
	}
	traversal := filepath.Join("..", "outside.xlsx")
	if got := existingRegularFile(&traversal, root); got != "" {
		t.Fatalf("traversal path resolved to %q", got)
	}

	link := filepath.Join(root, "escape.xlsx")
	if err := os.Symlink(outsideFile, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if got := existingRegularFile(&link, root); got != "" {
		t.Fatalf("symlink escape resolved to %q", got)
	}

	validFile := filepath.Join(root, "valid.xlsx")
	if err := os.WriteFile(validFile, []byte("PK\x03\x04valid"), 0o600); err != nil {
		t.Fatalf("write valid file: %v", err)
	}
	if got := existingRegularFile(&validFile, root); got == "" {
		t.Fatal("valid file under root did not resolve")
	}
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatalf("resolve root: %v", err)
	}
	resolvedValid, err := filepath.EvalSymlinks(validFile)
	if err != nil {
		t.Fatalf("resolve valid workbook: %v", err)
	}
	if !pathWithinRoot(resolvedRoot, resolvedValid) {
		t.Fatalf(
			"resolved valid workbook %q is outside root %q",
			resolvedValid,
			resolvedRoot,
		)
	}
	content, err := os.ReadFile(resolvedValid)
	if err != nil {
		t.Fatalf("read valid workbook: %v", err)
	}
	if len(content) < 4 || string(content[:4]) != "PK\x03\x04" {
		t.Fatalf("valid workbook magic = %q", content[:min(4, len(content))])
	}
	if _, err := validateAgentMonthlyWorkbook(outsideFile, resolvedRoot); !errors.Is(err, ErrAgentMonthlyNotReady) {
		t.Fatalf("outside workbook error = %v", err)
	}
	validWorkbook, err := validateAgentMonthlyWorkbook(validFile, resolvedRoot)
	if err != nil {
		t.Fatalf("valid workbook error = %v", err)
	}
	if validWorkbook == "" {
		t.Fatal("valid workbook path is empty")
	}
}

func TestAgentMonthlyBuildPayloadKeepsSavings(t *testing.T) {
	source := map[string]string{"income_total": "12.3400"}
	copied := copyStringMap(source)
	copied["income_total"] = "13.0000"
	if source["income_total"] != "12.3400" {
		t.Fatalf("source map mutated: %#v", source)
	}
}

func TestAgentMonthlyProjectFolderIsBoundedAndSafe(t *testing.T) {
	got := safeMonthlyAgentProjectFolder(`  ../A/B\C:*?"<>|  `)
	if got == "" || strings.ContainsAny(got, `/\:*?"<>|`) {
		t.Fatalf("unsafe project folder = %q", got)
	}
	long := strings.Repeat("测", 120)
	got = safeMonthlyAgentProjectFolder(long)
	if len([]rune(got)) > 80 {
		t.Fatalf("project folder length = %d", len([]rune(got)))
	}
}
