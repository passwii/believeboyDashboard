package store

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/vat_invoices"
)

type fakeVatInvoiceBlob struct {
	putKey         string
	putData        []byte
	putContentType string
	putURL         string
	putErr         error
	deletedKeys    []string
	deleteErr      error
}

func (f *fakeVatInvoiceBlob) Put(
	_ context.Context,
	key string,
	data []byte,
	contentType string,
) (string, error) {
	f.putKey = key
	f.putData = append([]byte(nil), data...)
	f.putContentType = contentType
	if f.putErr != nil {
		return "", f.putErr
	}
	return f.putURL, nil
}

func (f *fakeVatInvoiceBlob) Delete(_ context.Context, key string) error {
	f.deletedKeys = append(f.deletedKeys, key)
	return f.deleteErr
}

func TestVatInvoiceTotalsCalculation(t *testing.T) {
	lines := []vat_invoices.VatInvoiceLineIn{
		{Description: "Product 1", ASIN: "B001", Qty: 2, UnitPriceInclVat: 11.90, VatRate: 19.0},
		{Description: "Book 1", ASIN: "B002", Qty: 1, UnitPriceInclVat: 7.49, VatRate: 7.0},
	}
	shipping := 5.95

	subExcl, totalVat, totalIncl, summary := computeInvoiceTotals(lines, shipping)

	// totalIncl should equal (2*11.90) + 7.49 + 5.95 = 23.80 + 7.49 + 5.95 = 37.24
	if totalIncl != 37.24 {
		t.Fatalf("expected totalIncl 37.24, got %v", totalIncl)
	}
	if len(summary) != 2 {
		t.Fatalf("expected 2 summary rows, got %d", len(summary))
	}
	if round2(subExcl+totalVat) != totalIncl {
		t.Fatalf("subExcl (%v) + totalVat (%v) != totalIncl (%v)", subExcl, totalVat, totalIncl)
	}
}

func TestVatInvoiceStoreEnsureVatEnabled(t *testing.T) {
	ctx := context.Background()

	// 1. VAT enabled true
	foundDB := &fakeDB{row: fakeRow{values: []any{true}}}
	store := NewVatInvoiceStore(&fakeWriteDB{fakeDB: foundDB})
	if err := store.EnsureVatEnabled(ctx, 1); err != nil {
		t.Fatalf("expected enabled, got %v", err)
	}

	// 2. VAT enabled false
	disabledDB := &fakeDB{row: fakeRow{values: []any{false}}}
	store = NewVatInvoiceStore(&fakeWriteDB{fakeDB: disabledDB})
	if err := store.EnsureVatEnabled(ctx, 1); !errors.Is(err, vat_invoices.ErrVatNotEnabled) {
		t.Fatalf("expected ErrVatNotEnabled, got %v", err)
	}

	// 3. Project not found
	missingDB := &fakeDB{row: fakeRow{err: pgx.ErrNoRows}}
	store = NewVatInvoiceStore(&fakeWriteDB{fakeDB: missingDB})
	if err := store.EnsureVatEnabled(ctx, 999); !errors.Is(err, vat_invoices.ErrProjectNotFound) {
		t.Fatalf("expected ErrProjectNotFound, got %v", err)
	}
}

func TestVatInvoiceStoreGetEntityAndInvoice(t *testing.T) {
	ctx := context.Background()
	now := time.Now()

	// 1. Get Entity
	entityDB := &fakeDB{row: fakeRow{values: []any{
		int64(1), int64(10), "DE", "Seller GmbH", "DE123456789",
		"Musterstr. 1", "10115", "Berlin", "info@example.com", true,
		now, now,
	}}}
	store := NewVatInvoiceStore(&fakeWriteDB{fakeDB: entityDB})
	ent, err := store.GetEntity(ctx, 1)
	if err != nil {
		t.Fatalf("expected entity, got %v", err)
	}
	if ent.CompanyName != "Seller GmbH" || ent.Country != "DE" {
		t.Fatalf("unexpected entity: %+v", ent)
	}

	// 2. Get Invoice not found
	missingDB := &fakeDB{row: fakeRow{err: pgx.ErrNoRows}}
	store = NewVatInvoiceStore(&fakeWriteDB{fakeDB: missingDB})
	if _, err := store.GetInvoice(ctx, 999); !errors.Is(err, vat_invoices.ErrVatInvoiceNotFound) {
		t.Fatalf("expected ErrVatInvoiceNotFound, got %v", err)
	}
}

func TestVatInvoiceStatusValuesAreQuotedLiterals(t *testing.T) {
	for _, fragment := range []string{"status = 'draft'", "then 'issued'", "status = 'voided'"} {
		found := strings.Contains(vatAttachInvoicePDFSQL, fragment) || strings.Contains(vatVoidInvoiceSQL, fragment)
		if !found {
			t.Fatalf("status literal %q missing", fragment)
		}
	}
	for _, invalid := range []string{"status = draft", "then issued", "status = voided"} {
		if strings.Contains(vatAttachInvoicePDFSQL, invalid) || strings.Contains(vatVoidInvoiceSQL, invalid) {
			t.Fatalf("bare status identifier in SQL: %q", invalid)
		}
	}
	if !validVATInvoiceStatus("draft") || !validVATInvoiceStatus("issued") || !validVATInvoiceStatus("voided") {
		t.Fatal("expected VAT statuses to be valid")
	}
	if validVATInvoiceStatus("posted") {
		t.Fatal("unexpected VAT status accepted")
	}
}

func TestVatInvoiceRejectsInvalidPDFAndStatus(t *testing.T) {
	store := NewVatInvoiceStore(&fakeWriteDB{fakeDB: &fakeDB{}})
	if _, err := store.AttachInvoicePdf(context.Background(), 1, "../../invoice.txt", []byte("%PDF-1.4")); err == nil {
		t.Fatal("expected non-pdf extension to be rejected")
	}
	if _, err := store.AttachInvoicePdf(context.Background(), 1, "invoice.pdf", []byte("not-a-pdf")); err == nil {
		t.Fatal("expected invalid PDF magic to be rejected")
	}
	if _, err := store.AttachInvoicePdf(context.Background(), 1, "invoice.pdf", nil); err == nil {
		t.Fatal("expected empty PDF to be rejected")
	}
	if _, err := store.ListInvoices(context.Background(), vat_invoices.VatInvoiceFilter{Status: categoryTestStringPtr("posted")}); err == nil {
		t.Fatal("expected invalid status filter to be rejected")
	}
}

func TestVatInvoiceAttachPDFSanitizesFilename(t *testing.T) {
	db := &fakeDB{row: fakeRow{values: []any{"INV-DE123-2026-000001", "issued"}}}
	blobs := &fakeVatInvoiceBlob{putURL: "https://cdn.example.com/vat-invoices/7_invoice.pdf"}
	store := NewVatInvoiceStore(&fakeWriteDB{fakeDB: db}).WithBlobStore(blobs)
	resp, err := store.AttachInvoicePdf(context.Background(), 7, "../../invoice.pdf", []byte("%PDF-1.4\n%%EOF"))
	if err != nil {
		t.Fatalf("attach PDF: %v", err)
	}
	if !strings.Contains(resp.R2Key, "vat-invoices/7_invoice.pdf") || strings.Contains(resp.R2Key, "..") {
		t.Fatalf("unsafe R2 key: %q", resp.R2Key)
	}
}

func TestVatInvoiceAttachPDFUploadsBeforeWritingDatabase(t *testing.T) {
	ctx := context.Background()
	pdfBytes := []byte("%PDF-1.4\ninvoice bytes\n%%EOF")
	db := &fakeDB{row: fakeRow{values: []any{"INV-DE123-2026-000001", "issued"}}}
	blobs := &fakeVatInvoiceBlob{
		putURL: "https://objects.example.com/vat-invoices/7_invoice.pdf",
	}
	store := NewVatInvoiceStore(&fakeWriteDB{fakeDB: db}).WithBlobStore(blobs)

	resp, err := store.AttachInvoicePdf(ctx, 7, "invoice.pdf", pdfBytes)
	if err != nil {
		t.Fatalf("attach PDF: %v", err)
	}
	if blobs.putKey != "vat-invoices/7_invoice.pdf" {
		t.Fatalf("Put key = %q, want vat-invoices/7_invoice.pdf", blobs.putKey)
	}
	if blobs.putContentType != "application/pdf" {
		t.Fatalf("Put content type = %q, want application/pdf", blobs.putContentType)
	}
	if string(blobs.putData) != string(pdfBytes) {
		t.Fatalf("Put body = %q, want the uploaded PDF bytes", blobs.putData)
	}
	if resp.R2URL != blobs.putURL {
		t.Fatalf("response URL = %q, want Put return value %q", resp.R2URL, blobs.putURL)
	}
	if resp.R2Key != blobs.putKey {
		t.Fatalf("response key = %q, want %q", resp.R2Key, blobs.putKey)
	}
	if len(db.queryRowCalls) != 1 {
		t.Fatalf("database writes = %d, want 1", len(db.queryRowCalls))
	}
	args := db.queryRowCalls[0].args
	if len(args) != 3 || args[0] != blobs.putKey || args[1] != blobs.putURL {
		t.Fatalf("database args = %#v, want key and Put URL", args)
	}
}

func TestVatInvoiceAttachPDFPutFailureSkipsDatabaseWrite(t *testing.T) {
	db := &fakeDB{row: fakeRow{values: []any{"INV-DE123-2026-000001", "issued"}}}
	blobs := &fakeVatInvoiceBlob{putErr: errors.New("r2 unavailable")}
	store := NewVatInvoiceStore(&fakeWriteDB{fakeDB: db}).WithBlobStore(blobs)

	_, err := store.AttachInvoicePdf(context.Background(), 7, "invoice.pdf", []byte("%PDF-1.4\n%%EOF"))
	if !errors.Is(err, vat_invoices.ErrBlobUploadFailed) {
		t.Fatalf("error = %v, want ErrBlobUploadFailed", err)
	}
	if len(db.queryRowCalls) != 0 {
		t.Fatalf("database writes = %d, want 0 after Put failure", len(db.queryRowCalls))
	}
}

func TestVatInvoiceAttachPDFDatabaseFailureDeletesUploadedObject(t *testing.T) {
	db := &fakeDB{row: fakeRow{err: errors.New("database down")}}
	blobs := &fakeVatInvoiceBlob{putURL: "https://objects.example.com/vat-invoices/7_invoice.pdf"}
	store := NewVatInvoiceStore(&fakeWriteDB{fakeDB: db}).WithBlobStore(blobs)

	_, err := store.AttachInvoicePdf(context.Background(), 7, "invoice.pdf", []byte("%PDF-1.4\n%%EOF"))
	if err == nil {
		t.Fatal("expected database error")
	}
	if len(blobs.deletedKeys) != 1 || blobs.deletedKeys[0] != "vat-invoices/7_invoice.pdf" {
		t.Fatalf("deleted keys = %#v, want the uploaded object", blobs.deletedKeys)
	}
}

func TestVatInvoiceAttachPDFRequiresBlobStore(t *testing.T) {
	db := &fakeDB{row: fakeRow{values: []any{"INV-DE123-2026-000001", "issued"}}}
	store := NewVatInvoiceStore(&fakeWriteDB{fakeDB: db})

	_, err := store.AttachInvoicePdf(context.Background(), 7, "invoice.pdf", []byte("%PDF-1.4\n%%EOF"))
	if !errors.Is(err, vat_invoices.ErrBlobNotConfigured) {
		t.Fatalf("error = %v, want ErrBlobNotConfigured", err)
	}
	if len(db.queryRowCalls) != 0 {
		t.Fatalf("database writes = %d, want 0 when blob store is missing", len(db.queryRowCalls))
	}
}

func TestVatInvoiceSQLPreparesAgainstPostgres(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect test database: %v", err)
	}
	defer conn.Close(ctx)
	if _, err := conn.Prepare(ctx, "vat_attach_pdf", vatAttachInvoicePDFSQL); err != nil {
		t.Fatalf("prepare attach PDF SQL: %v", err)
	}
	if _, err := conn.Prepare(ctx, "vat_void_invoice", vatVoidInvoiceSQL); err != nil {
		t.Fatalf("prepare void SQL: %v", err)
	}
}
