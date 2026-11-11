package vat_invoices

import (
	"context"
	"errors"
)

var (
	ErrVatEntityNotFound  = errors.New("vat entity not found")
	ErrVatInvoiceNotFound = errors.New("vat invoice not found")
	ErrProjectNotFound    = errors.New("project not found")
	ErrVatNotEnabled      = errors.New("VAT feature is not enabled for this project")
	ErrInvoiceNoPdf       = errors.New("invoice has no pdf yet")
	ErrProjectForbidden   = errors.New("无权限访问该项目")
)

type VatEntityBase struct {
	Country     string `json:"country"`
	CompanyName string `json:"company_name"`
	VatID       string `json:"vat_id"`
	AddressLine string `json:"address_line"`
	PostalCode  string `json:"postal_code"`
	City        string `json:"city"`
	Email       string `json:"email"`
	IsDefault   bool   `json:"is_default"`
}

type VatEntityCreate struct {
	VatEntityBase
	ProjectID int64 `json:"project_id"`
}

type VatEntityUpdate struct {
	CompanyName *string `json:"company_name,omitempty"`
	VatID       *string `json:"vat_id,omitempty"`
	AddressLine *string `json:"address_line,omitempty"`
	PostalCode  *string `json:"postal_code,omitempty"`
	City        *string `json:"city,omitempty"`
	Email       *string `json:"email,omitempty"`
	IsDefault   *bool   `json:"is_default,omitempty"`
}

type VatEntityResponse struct {
	VatEntityBase
	ID        int64  `json:"id"`
	ProjectID int64  `json:"project_id"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

type VatInvoiceLineIn struct {
	Description      string  `json:"description"`
	ASIN             string  `json:"asin"`
	Qty              int     `json:"qty"`
	UnitPriceInclVat float64 `json:"unit_price_incl_vat"`
	VatRate          float64 `json:"vat_rate"`
}

type VatInvoiceLineResponse struct {
	Description      string `json:"description"`
	ASIN             string `json:"asin"`
	Qty              int    `json:"qty"`
	UnitPriceInclVat string `json:"unit_price_incl_vat"`
	VatRate          string `json:"vat_rate"`
	ID               int64  `json:"id"`
	LineNo           int    `json:"line_no"`
	LineExcl         string `json:"line_excl"`
	LineVat          string `json:"line_vat"`
	LineIncl         string `json:"line_incl"`
}

type VatBuyerIn struct {
	Name        string `json:"name"`
	AddressLine string `json:"address_line"`
	PostalCode  string `json:"postal_code"`
	City        string `json:"city"`
	Country     string `json:"country"`
}

type VatInvoiceCreate struct {
	ProjectID       int64              `json:"project_id"`
	SellerEntityID  *int64             `json:"seller_entity_id,omitempty"`
	Currency        string             `json:"currency"`
	OrderID         string             `json:"order_id"`
	InvoiceDate     string             `json:"invoice_date"`
	Buyer           VatBuyerIn         `json:"buyer"`
	ShippingInclVat float64            `json:"shipping_incl_vat"`
	Lines           []VatInvoiceLineIn `json:"lines"`
	Status          string             `json:"status"`
}

type VatInvoiceListItem struct {
	ID           int64  `json:"id"`
	InvoiceNo    string `json:"invoice_no"`
	ProjectID    int64  `json:"project_id"`
	ProjectName  string `json:"project_name"`
	Currency     string `json:"currency"`
	OrderID      string `json:"order_id"`
	BuyerName    string `json:"buyer_name"`
	InvoiceDate  string `json:"invoice_date"`
	SubtotalExcl string `json:"subtotal_excl"`
	TotalVat     string `json:"total_vat"`
	TotalIncl    string `json:"total_incl"`
	Status       string `json:"status"`
	HasPdf       bool   `json:"has_pdf"`
	CreatedAt    string `json:"created_at"`
	UpdatedAt    string `json:"updated_at"`
}

type VatInvoiceResponse struct {
	ID              int64                    `json:"id"`
	InvoiceNo       string                   `json:"invoice_no"`
	ProjectID       int64                    `json:"project_id"`
	SellerEntityID  *int64                   `json:"seller_entity_id"`
	SellerSnapshot  map[string]any           `json:"seller_snapshot"`
	Buyer           map[string]any           `json:"buyer"`
	Currency        string                   `json:"currency"`
	OrderID         string                   `json:"order_id"`
	InvoiceDate     string                   `json:"invoice_date"`
	ShippingInclVat string                   `json:"shipping_incl_vat"`
	SubtotalExcl    string                   `json:"subtotal_excl"`
	TotalVat        string                   `json:"total_vat"`
	TotalIncl       string                   `json:"total_incl"`
	SummaryByRate   []any                    `json:"summary_by_rate"`
	R2Key           *string                  `json:"r2_key"`
	R2URL           *string                  `json:"r2_url"`
	Status          string                   `json:"status"`
	VoidReason      *string                  `json:"void_reason"`
	CreatedBy       *string                  `json:"created_by"`
	CreatedAt       string                   `json:"created_at"`
	UpdatedAt       string                   `json:"updated_at"`
	Lines           []VatInvoiceLineResponse `json:"lines"`
}

type VatInvoicePdfUploadRequest struct {
	PdfBase64 string `json:"pdf_base64"`
	Filename  string `json:"filename"`
}

type VatInvoicePdfUploadResponse struct {
	ID        int64  `json:"id"`
	InvoiceNo string `json:"invoice_no"`
	R2Key     string `json:"r2_key"`
	R2URL     string `json:"r2_url"`
	Status    string `json:"status"`
}

type VatInvoiceVoidRequest struct {
	Reason string `json:"reason"`
}

type VatInvoiceFilter struct {
	ProjectID *int64
	Status    *string
	Q         *string
	DateFrom  *string
	DateTo    *string
	Limit     int
	Offset    int
	Operator  string
	IsAdmin   bool
}

type Store interface {
	VerifyProjectAccess(ctx context.Context, projectID int64, operator string, isAdmin bool) error
	EnsureVatEnabled(ctx context.Context, projectID int64) error
	ListEntities(ctx context.Context, projectID int64) ([]VatEntityResponse, error)
	UpsertEntity(ctx context.Context, payload VatEntityCreate) (*VatEntityResponse, error)
	UpdateEntity(ctx context.Context, entityID int64, payload VatEntityUpdate) (*VatEntityResponse, error)
	DeleteEntity(ctx context.Context, entityID int64) error
	GetEntity(ctx context.Context, entityID int64) (*VatEntityResponse, error)

	ListInvoices(ctx context.Context, filter VatInvoiceFilter) ([]VatInvoiceListItem, error)
	GetInvoice(ctx context.Context, invoiceID int64) (*VatInvoiceResponse, error)
	CreateInvoice(ctx context.Context, payload VatInvoiceCreate, createdBy string) (*VatInvoiceResponse, error)
	AttachInvoicePdf(ctx context.Context, invoiceID int64, filename string, pdfBytes []byte) (*VatInvoicePdfUploadResponse, error)
	VoidInvoice(ctx context.Context, invoiceID int64, reason string) (*VatInvoiceResponse, error)
}
