package crm

import (
	"bytes"
	"net/http/httptest"
	"testing"
)

func TestCRMCustomerCSVImportRoundTrip(t *testing.T) {
	csv := "\ufeffname,short_name,industry,customer_type,rating,status,source,contact_name,contact_phone,contact_email,employee_count,annual_revenue\n" +
		"客户 A,简称,家居,工厂,A,active,referral,张总,13800001111,zhang@example.com,12,1000.5\n"
	rows, err := parseCustomerImportFile([]byte(csv), "customers.csv")
	if err != nil {
		t.Fatalf("parseCustomerImportFile() error = %v", err)
	}
	if len(rows) != 1 || rows[0].Name != "客户 A" || rows[0].EmployeeCount == nil ||
		*rows[0].EmployeeCount != 12 || rows[0].AnnualRevenue == nil ||
		*rows[0].AnnualRevenue != 1000.5 {
		t.Fatalf("rows = %#v", rows)
	}
}

func TestCRMCustomerXLSXImportRoundTrip(t *testing.T) {
	rows := [][]string{
		{"name", "short_name", "industry", "rating", "employee_count", "annual_revenue", "contact_name"},
		{"客户 A", "简称", "家居", "A", "12", "1000.5", "张总"},
	}
	data, err := buildXLSX(rows)
	if err != nil {
		t.Fatalf("buildXLSX() error = %v", err)
	}
	if !bytes.HasPrefix(data, []byte("PK")) {
		t.Fatalf("XLSX bytes do not look like a zip workbook")
	}
	parsed, err := parseCustomerImportFile(data, "customers.xlsx")
	if err != nil {
		t.Fatalf("parseCustomerImportFile(xlsx) error = %v", err)
	}
	if len(parsed) != 1 || parsed[0].Name != "客户 A" ||
		parsed[0].EmployeeCount == nil || *parsed[0].EmployeeCount != 12 ||
		parsed[0].AnnualRevenue == nil || *parsed[0].AnnualRevenue != 1000.5 {
		t.Fatalf("parsed = %#v", parsed)
	}
}

func TestCRMErrorWriterUsesFastAPIDetailShape(t *testing.T) {
	recorder := httptest.NewRecorder()
	WriteError(recorder, NewAPIError(403, "Not the record owner"))
	if recorder.Code != 403 {
		t.Fatalf("status = %d", recorder.Code)
	}
	if got := recorder.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("Content-Type = %q", got)
	}
	if got := recorder.Body.String(); got != `{"detail":"Not the record owner"}` {
		t.Fatalf("body = %q", got)
	}
}
