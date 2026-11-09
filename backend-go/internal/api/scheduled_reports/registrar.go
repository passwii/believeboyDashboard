package scheduled_reports

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

type Registrar struct {
	handler *Handler
}

func NewRegistrar(store Store, enqueuer Enqueuer, mailer Mailer, auditor audit.Service) *Registrar {
	return NewRegistrarWithRunner(store, enqueuer, NewQueueRunner(enqueuer), mailer, auditor)
}

func NewRegistrarWithRunner(
	store Store,
	enqueuer Enqueuer,
	runner Runner,
	mailer Mailer,
	auditor audit.Service,
) *Registrar {
	return &Registrar{handler: NewHandler(store, enqueuer, runner, mailer, auditor)}
}

func (*Registrar) ModuleName() string { return "scheduled_reports" }

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	handler := registrar.handler

	router.With(requireAPIKey).Get("/api/v1/scheduled-reports/subscriptions", handler.ListSubscriptions)
	router.With(requireAPIKey).Post("/api/v1/scheduled-reports/subscriptions", handler.CreateSubscription)
	router.With(requireAPIKey).Put("/api/v1/scheduled-reports/subscriptions/{subscription_id}", handler.UpdateSubscription)
	router.With(requireAPIKey).Delete("/api/v1/scheduled-reports/subscriptions/{subscription_id}", handler.DeleteSubscription)
	router.With(requireAPIKey).Get("/api/v1/scheduled-reports/delivery-logs", handler.ListDeliveryLogs)
	router.With(requireAPIKey).Post("/api/v1/scheduled-reports/test-email", handler.SendTestEmail)
	router.With(requireAPIKey).Get("/api/v1/scheduled-reports/ledger", handler.GetLedger)
	router.With(requireAPIKey).Post("/api/v1/scheduled-reports/ledger/{ledger_key}/resend", handler.ResendLedgerEntry)
	router.With(requireAPIKey).Post("/api/v1/scheduled-reports/ledger/{ledger_key}/ai-summary/regenerate", handler.RegenerateAISummary)
	router.With(requireAPIKey).Post("/api/v1/scheduled-reports/trigger", handler.TriggerReportDispatch)
}
