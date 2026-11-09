package tasks

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/csv"
	"encoding/xml"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/queue"
	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
	"github.com/passwii/believeboyDashboard/backend-go/internal/testutil"
)

var monthlyReportUSHeader = []string{
	"date/time",
	"settlement id",
	"type",
	"order id",
	"sku",
	"description",
	"quantity",
	"marketplace",
	"account type",
	"fulfillment",
	"order city",
	"order state",
	"order postal",
	"tax collection model",
	"product sales",
	"product sales tax",
	"shipping credits",
	"shipping credits tax",
	"gift wrap credits",
	"giftwrap credits tax",
	"Regulatory Fee",
	"Tax On Regulatory Fee",
	"promotional rebates",
	"promotional rebates tax",
	"marketplace withheld tax",
	"selling fees",
	"fba fees",
	"other transaction fees",
	"other",
	"total",
}

var monthlyReportDEHeader = []string{
	"Datum/Uhrzeit",
	"Abrechnungsnummer",
	"Typ",
	"Bestellnummer",
	"SKU",
	"Beschreibung",
	"Menge",
	"Marketplace",
	"Versand",
	"Umsaetze",
	"Produktumsatzsteuer",
	"Gutschrift fuer versandkosten",
	"Steuer auf Versandgutschrift",
	"Gutschrift fuer geschenkverpackung",
	"Steuer auf geschenkverpackungsgutschriften",
	"Rabatte aus werbeaktionen",
	"Steuer auf aktionsrabatte",
	"Einbehaltene Steuer auf Marketplace",
	"Verkaufsgebuehren",
	"Gebuehren zu versand durch amazon",
	"Andere transaktionsgebuehren",
	"Andere",
	"Gesamt",
}

func TestMonthlyReportGeneratorUSClassificationAndValidXLSX(t *testing.T) {
	uploadRoot := t.TempDir()
	resultRoot := t.TempDir()
	fileID := "us-2026-10.csv"
	writeMonthlyReportFixture(t, uploadRoot, "Test Project", fileID, monthlyReportUSHeader,
		monthlyReportValues(monthlyReportUSHeader, map[string]string{
			"date/time":        "Oct 1, 2026 12:00:00 PM UTC",
			"settlement id":    "S-1",
			"type":             "Order",
			"order id":         "ORDER-1",
			"sku":              "SKU-1",
			"quantity":         "2",
			"marketplace":      "amazon.com",
			"fulfillment":      "Amazon",
			"product sales":    "100.00",
			"shipping credits": "2.00",
			"selling fees":     "-15.00",
			"fba fees":         "-5.00",
			"total":            "82.00",
		}),
		monthlyReportValues(monthlyReportUSHeader, map[string]string{
			"date/time":     "Oct 2, 2026 12:00:00 PM UTC",
			"settlement id": "S-1",
			"type":          "FBA Transaction Fees",
			"description":   "FBA Inventory Storage Fee",
			"quantity":      "0",
			"marketplace":   "amazon.com",
			"total":         "-3.00",
		}),
		monthlyReportValues(monthlyReportUSHeader, map[string]string{
			"date/time":     "Oct 3, 2026 12:00:00 PM UTC",
			"settlement id": "S-1",
			"type":          "Service Fee",
			"description":   "Cost of Advertising",
			"quantity":      "0",
			"marketplace":   "amazon.com",
			"total":         "-10.00",
		}),
	)

	generator := NewFileMonthlyReportGenerator(uploadRoot, resultRoot)
	result, err := generator.Generate(context.Background(), MonthlyReportGenerationInput{
		JobID:             42,
		ProjectID:         7,
		ProjectName:       "Test Project",
		Country:           "US",
		ReportMonth:       "2026-10",
		TransactionFileID: fileID,
	})
	if err != nil {
		t.Fatalf("Generate() error = %v", err)
	}
	if len(result.Transactions) != 3 {
		t.Fatalf("transactions = %d, want 3", len(result.Transactions))
	}
	if result.SettlementID != "S-1" {
		t.Fatalf("settlement id = %q", result.SettlementID)
	}
	assertMonthlyAmount(t, result.PT3, "income_fba_product_sales", "100.00")
	assertMonthlyAmount(t, result.PT3, "income_shipping_credits", "2.00")
	assertMonthlyAmount(t, result.PT3, "income_total", "102.00")
	assertMonthlyAmount(t, result.PT3, "expense_fba_transaction_fees", "-5.00")
	assertMonthlyAmount(t, result.PT3, "expense_fba_inventory_and_inbound_services_fees", "-3.00")
	assertMonthlyAmount(t, result.PT3, "expense_cost_of_advertising", "-10.00")
	assertMonthlyAmount(t, result.PT3, "expense_total", "-33.00")
	assertMonthlyAmount(t, result.PT4, "amazon_pay_back", "69.00")

	output := result.ResultPath
	if !filepath.IsAbs(output) {
		t.Fatalf("result path = %q, want absolute", output)
	}
	if !pathWithin(resultRoot, output) {
		t.Fatalf("result path %q escaped result root %q", output, resultRoot)
	}
	if filepath.Base(output) != "Test Project_Monthly_Report_2026-10.xlsx" {
		t.Fatalf("result filename = %q", filepath.Base(output))
	}
	assertValidMonthlyWorkbook(t, output)
}

func TestMonthlyReportGeneratorDEClassificationAndVAT(t *testing.T) {
	uploadRoot := t.TempDir()
	resultRoot := t.TempDir()
	fileID := "de-2026-10.csv"
	writeMonthlyReportFixture(t, uploadRoot, "弥森", fileID, monthlyReportDEHeader,
		monthlyReportValues(monthlyReportDEHeader, map[string]string{
			"Datum/Uhrzeit":                       "01.10.2026 12:00:00",
			"Abrechnungsnummer":                   "S-DE-1",
			"Typ":                                 "Bestellung",
			"Bestellnummer":                       "ORDER-DE-1",
			"SKU":                                 "SKU-DE-1",
			"Menge":                               "1",
			"Marketplace":                         "amazon.de",
			"Versand":                             "Amazon",
			"Umsaetze":                            "100,00",
			"Einbehaltene Steuer auf Marketplace": "-19,00",
			"Verkaufsgebuehren":                   "-15,00",
			"Gebuehren zu versand durch amazon":   "-5,00",
			"Gesamt":                              "80,00",
		}),
	)

	generator := NewFileMonthlyReportGenerator(uploadRoot, resultRoot)
	result, err := generator.Generate(context.Background(), MonthlyReportGenerationInput{
		JobID:             43,
		ProjectID:         10,
		ProjectName:       "弥森",
		Country:           "DE",
		ReportMonth:       "2026-10",
		TransactionFileID: fileID,
	})
	if err != nil {
		t.Fatalf("Generate() error = %v", err)
	}
	assertMonthlyAmount(t, result.PT3, "income_vat_total", "-19.00")
	assertMonthlyAmount(t, result.PT3, "income_sales_with_tax", "119.00")
	assertMonthlyAmount(t, result.PT3, "income_total", "119.00")
	assertMonthlyAmount(t, result.PT4, "expense_vat_total", "-19.00")
	assertMonthlyAmount(t, result.PT4, "amazon_pay_back", "80.00")
	if result.Transactions[0].TransactionType != "Order" {
		t.Fatalf("normalized DE type = %q", result.Transactions[0].TransactionType)
	}
	if result.Transactions[0].Description != "" {
		t.Fatalf("normalized DE description = %q", result.Transactions[0].Description)
	}
}

func TestMonthlyReportGeneratorSkipsBlankRows(t *testing.T) {
	uploadRoot := t.TempDir()
	resultRoot := t.TempDir()
	fileID := "blank-lines.csv"
	writeMonthlyReportFixture(t, uploadRoot, "Blank Rows", fileID, monthlyReportUSHeader,
		monthlyReportValues(monthlyReportUSHeader, map[string]string{
			"date/time":     "Oct 1, 2026 12:00:00 PM UTC",
			"settlement id": "S-1",
			"type":          "Order",
			"sku":           "SKU-1",
			"quantity":      "1",
			"marketplace":   "amazon.com",
			"product sales": "10.00",
			"total":         "10.00",
		}),
		nil,
		[]string{},
	)

	generator := NewFileMonthlyReportGenerator(uploadRoot, resultRoot)
	result, err := generator.Generate(context.Background(), MonthlyReportGenerationInput{
		JobID:             44,
		ProjectID:         8,
		ProjectName:       "Blank Rows",
		Country:           "US",
		ReportMonth:       "2026-10",
		TransactionFileID: fileID,
	})
	if err != nil {
		t.Fatalf("Generate() error = %v", err)
	}
	if len(result.Transactions) != 1 {
		t.Fatalf("transactions = %d, want 1", len(result.Transactions))
	}
}

func TestMonthlyReportGeneratorRejectsMissingAndMismatchedInput(t *testing.T) {
	uploadRoot := t.TempDir()
	resultRoot := t.TempDir()
	generator := NewFileMonthlyReportGenerator(uploadRoot, resultRoot)
	base := MonthlyReportGenerationInput{
		JobID:             45,
		ProjectID:         7,
		ProjectName:       "Test Project",
		Country:           "US",
		ReportMonth:       "2026-10",
		TransactionFileID: "missing.csv",
	}
	if _, err := generator.Generate(context.Background(), base); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("missing file error = %v", err)
	}

	fileID := "wrong-values.csv"
	writeMonthlyReportFixture(t, uploadRoot, "Test Project", fileID, monthlyReportUSHeader,
		monthlyReportValues(monthlyReportUSHeader, map[string]string{
			"date/time":     "Nov 1, 2026 12:00:00 PM UTC",
			"settlement id": "S-1",
			"type":          "Order",
			"sku":           "SKU-1",
			"quantity":      "1",
			"marketplace":   "amazon.com",
			"product sales": "10.00",
			"total":         "10.00",
		}),
	)

	base.TransactionFileID = fileID
	if _, err := generator.Generate(context.Background(), base); err == nil || !strings.Contains(strings.ToLower(err.Error()), "month") {
		t.Fatalf("wrong month error = %v", err)
	}

	wrongCountry := base
	wrongCountry.Country = "DE"
	wrongCountry.ReportMonth = "2026-11"
	if _, err := generator.Generate(context.Background(), wrongCountry); err == nil || !strings.Contains(strings.ToLower(err.Error()), "country") {
		t.Fatalf("wrong country error = %v", err)
	}
}

func TestMonthlyReportGeneratorEnforcesPathExtensionSizeAndSymlinkRules(t *testing.T) {
	testutil.RequireSymlink(t)
	uploadRoot := t.TempDir()
	resultRoot := t.TempDir()
	generator := NewFileMonthlyReportGenerator(uploadRoot, resultRoot)
	base := MonthlyReportGenerationInput{
		JobID:             46,
		ProjectID:         7,
		ProjectName:       "Test Project",
		Country:           "US",
		ReportMonth:       "2026-10",
		TransactionFileID: "../outside.csv",
	}
	if _, err := generator.Generate(context.Background(), base); err == nil {
		t.Fatal("path traversal file id was accepted")
	}

	textFileID := "notes.txt"
	textDir := filepath.Join(uploadRoot, safeMonthlyProjectFolder("Test Project"), "payment-report")
	if err := os.MkdirAll(textDir, 0o700); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(textDir, textFileID), []byte("not csv"), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	base.TransactionFileID = textFileID
	if _, err := generator.Generate(context.Background(), base); err == nil || !strings.Contains(strings.ToLower(err.Error()), "extension") {
		t.Fatalf("extension error = %v", err)
	}

	linkFileID := "linked.csv"
	linkPath := filepath.Join(textDir, linkFileID)
	outsidePath := filepath.Join(t.TempDir(), "outside.csv")
	if err := os.WriteFile(outsidePath, []byte("x"), 0o600); err != nil {
		t.Fatalf("WriteFile() outside error = %v", err)
	}
	if err := os.Symlink(outsidePath, linkPath); err != nil {
		t.Fatalf("Symlink() error = %v", err)
	}
	base.TransactionFileID = linkFileID
	if _, err := generator.Generate(context.Background(), base); err == nil || !strings.Contains(strings.ToLower(err.Error()), "symlink") {
		t.Fatalf("symlink error = %v", err)
	}

	largeFileID := "large.csv"
	largePath := filepath.Join(textDir, largeFileID)
	if err := os.WriteFile(largePath, bytes.Repeat([]byte("a"), 256), 0o600); err != nil {
		t.Fatalf("WriteFile() large error = %v", err)
	}
	limited := NewFileMonthlyReportGeneratorWithLimit(uploadRoot, resultRoot, 128)
	base.TransactionFileID = largeFileID
	if _, err := limited.Generate(context.Background(), base); err == nil || !strings.Contains(strings.ToLower(err.Error()), "size") {
		t.Fatalf("size error = %v", err)
	}
}

func TestMonthlyReportJobAlreadyDoneDoesNotRegenerate(t *testing.T) {
	payload := []byte(`{"job_type":"monthly_report","params":{"report_id":5}}`)
	db := &remediationDB{queryRowResponses: []pgx.Row{
		remediationRow{values: []any{int64(42), "monthly_report", "success", payload, (*string)(nil)}},
	}}
	generator := &recordingMonthlyReportGenerator{}
	finalizer := &recordingMonthlyReportFinalizer{}
	handler := NewTaskHandlerWithDB(db, HandlerConfig{
		MonthlyReportGenerator: generator,
		MonthlyReportFinalizer: finalizer,
	})
	task := remediationTask(t, queue.TypeRunJob, RunJobPayload{JobID: 42})
	if err := handler.HandleRunJob(context.Background(), task); err != nil {
		t.Fatalf("HandleRunJob() error = %v", err)
	}
	if generator.calls != 0 || finalizer.calls != 0 {
		t.Fatalf("already-done job regenerated: generator=%d finalizer=%d", generator.calls, finalizer.calls)
	}
}

type recordingMonthlyReportGenerator struct {
	calls int
}

func (generator *recordingMonthlyReportGenerator) Generate(
	context.Context,
	MonthlyReportGenerationInput,
) (*store.MonthlyReportComputedResult, error) {
	generator.calls++
	return nil, errors.New("unexpected generation")
}

type recordingMonthlyReportFinalizer struct {
	calls int
}

func (finalizer *recordingMonthlyReportFinalizer) Finalize(
	context.Context,
	int64,
	int64,
	store.MonthlyReportComputedResult,
) error {
	finalizer.calls++
	return nil
}

func writeMonthlyReportFixture(
	t *testing.T,
	uploadRoot string,
	projectName string,
	fileID string,
	header []string,
	rows ...[]string,
) {
	t.Helper()
	path := filepath.Join(uploadRoot, safeMonthlyProjectFolder(projectName), "payment-report", fileID)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	file, err := os.Create(path)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	defer file.Close()
	if _, err := file.WriteString("\"Includes Amazon Marketplace transactions\"\n"); err != nil {
		t.Fatalf("WriteString() error = %v", err)
	}
	writer := csv.NewWriter(file)
	if err := writer.Write(header); err != nil {
		t.Fatalf("write header: %v", err)
	}
	for _, row := range rows {
		if row == nil {
			continue
		}
		if err := writer.Write(row); err != nil {
			t.Fatalf("write row: %v", err)
		}
	}
	writer.Flush()
	if err := writer.Error(); err != nil {
		t.Fatalf("csv writer error = %v", err)
	}
}

func monthlyReportValues(header []string, values map[string]string) []string {
	row := make([]string, len(header))
	for index, key := range header {
		row[index] = values[key]
		if row[index] == "" && monthlyPaymentNumericColumns[key] {
			row[index] = "0"
		}
	}
	return row
}

func assertMonthlyAmount(t *testing.T, values map[string]string, key, want string) {
	t.Helper()
	if got := values[key]; got != want {
		t.Fatalf("%s = %q, want %q", key, got, want)
	}
}

func assertValidMonthlyWorkbook(t *testing.T, path string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	if !bytes.HasPrefix(data, []byte("PK\x03\x04")) {
		t.Fatalf("workbook magic = %x", data[:min(4, len(data))])
	}
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("zip.NewReader() error = %v", err)
	}
	entries := make(map[string]*zip.File, len(archive.File))
	for _, entry := range archive.File {
		entries[entry.Name] = entry
	}
	for _, name := range []string{
		"[Content_Types].xml",
		"xl/workbook.xml",
		"xl/styles.xml",
		"xl/worksheets/sheet1.xml",
		"xl/worksheets/sheet2.xml",
	} {
		if entries[name] == nil {
			t.Fatalf("xlsx missing %s", name)
		}
	}
	workbookXML := readZipEntry(t, entries["xl/workbook.xml"])
	for name, entry := range entries {
		if !strings.HasSuffix(name, ".xml") && !strings.HasSuffix(name, ".rels") {
			continue
		}
		decoder := xml.NewDecoder(strings.NewReader(readZipEntry(t, entry)))
		for {
			_, err := decoder.Token()
			if err == io.EOF {
				break
			}
			if err != nil {
				t.Fatalf("invalid XML in %s: %v", name, err)
			}
		}
	}
	for _, sheet := range []string{"总览草稿", "报表核算", "交易一览", "销售SKU明细"} {
		if !strings.Contains(workbookXML, sheet) {
			t.Fatalf("workbook missing sheet %q:\n%s", sheet, workbookXML)
		}
	}
	if count := strings.Count(workbookXML, "<sheet "); count < 17 {
		t.Fatalf("workbook sheets = %d, want >= 17", count)
	}
	overview := readZipEntry(t, entries["xl/worksheets/sheet1.xml"])
	if !strings.Contains(overview, "销售额") || !strings.Contains(overview, "69.00") {
		t.Fatalf("overview sheet missing totals:\n%s", overview)
	}
}

func readZipEntry(t *testing.T, entry *zip.File) string {
	t.Helper()
	reader, err := entry.Open()
	if err != nil {
		t.Fatalf("open zip entry %s: %v", entry.Name, err)
	}
	defer reader.Close()
	var buffer bytes.Buffer
	if _, err := buffer.ReadFrom(reader); err != nil {
		t.Fatalf("read zip entry %s: %v", entry.Name, err)
	}
	return buffer.String()
}

func pathWithin(root, candidate string) bool {
	absoluteRoot, err := filepath.Abs(root)
	if err != nil {
		return false
	}
	if resolved, resolveErr := filepath.EvalSymlinks(absoluteRoot); resolveErr == nil {
		absoluteRoot = resolved
	}
	absoluteCandidate, err := filepath.Abs(candidate)
	if err != nil {
		return false
	}
	if resolved, resolveErr := filepath.EvalSymlinks(absoluteCandidate); resolveErr == nil {
		absoluteCandidate = resolved
	}
	relative, err := filepath.Rel(absoluteRoot, absoluteCandidate)
	if err != nil || filepath.IsAbs(relative) {
		return false
	}
	return relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}
