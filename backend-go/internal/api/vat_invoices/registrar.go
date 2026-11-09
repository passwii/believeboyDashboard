package vat_invoices

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

type Registrar struct {
	handler *Handler
}

func NewRegistrar(store Store, auditor audit.Service) *Registrar {
	return &Registrar{handler: NewHandler(store, auditor)}
}

func (*Registrar) ModuleName() string { return "vat_invoices" }

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	handler := registrar.handler

	// VAT Entities
	router.With(requireAPIKey).Get("/api/v1/vat-entities", handler.ListEntities)
	router.With(requireAPIKey).Post("/api/v1/vat-entities", handler.CreateEntity)
	router.With(requireAPIKey).Patch("/api/v1/vat-entities/{entity_id}", handler.UpdateEntity)
	router.With(requireAPIKey).Delete("/api/v1/vat-entities/{entity_id}", handler.DeleteEntity)

	// VAT Invoices
	router.With(requireAPIKey).Get("/api/v1/vat-invoices", handler.ListInvoices)
	router.With(requireAPIKey).Post("/api/v1/vat-invoices", handler.CreateInvoice)
	router.With(requireAPIKey).Get("/api/v1/vat-invoices/{invoice_id}/pdf", handler.GetInvoicePdf)
	router.With(requireAPIKey).Post("/api/v1/vat-invoices/{invoice_id}/pdf", handler.UploadInvoicePdf)
	router.With(requireAPIKey).Post("/api/v1/vat-invoices/{invoice_id}/void", handler.VoidInvoice)
	router.With(requireAPIKey).Get("/api/v1/vat-invoices/{invoice_id}", handler.GetInvoice)
}
