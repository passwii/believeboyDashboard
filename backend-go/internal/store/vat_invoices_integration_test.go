package store

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/vat_invoices"
)

// TestVATInvoiceStoreListInvoicesIntegration is the regression gate for the
// 2026-11-11 bug where the buyer-name JSON lookup used double quotes
// (->> "name"), which PostgreSQL parses as an identifier and every
// GET /api/v1/vat-invoices request returned 500.
func TestVATInvoiceStoreListInvoicesIntegration(t *testing.T) {
	databaseURL := os.Getenv("GO_API_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set GO_API_TEST_DATABASE_URL to a BLF_test connection for integration coverage")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	pool, err := OpenPool(ctx, databaseURL)
	if err != nil {
		t.Fatalf("OpenPool() error = %v", err)
	}
	defer pool.Close()
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("test database unavailable: %v", err)
	}

	invoiceStore := NewVatInvoiceStore(NewPGXDB(pool))
	items, err := invoiceStore.ListInvoices(ctx, vat_invoices.VatInvoiceFilter{})
	if err != nil {
		t.Fatalf("ListInvoices() error = %v", err)
	}
	t.Logf("vat invoices listed: %d", len(items))
}
