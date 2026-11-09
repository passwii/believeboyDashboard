package crm

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

type Handler struct {
	store                Store
	storage              ProposalStorage
	auditor              audit.Service
	taskReminderTick     time.Duration
	followUpReminderTick time.Duration
	followUpReminderDays int
}

type Registrar struct {
	handler *Handler
}

func NewHandler(store Store, storage ProposalStorage, auditor audit.Service) *Handler {
	return NewHandlerWithOptions(store, storage, auditor, RegistrarOptions{})
}

func NewRegistrar(store Store, storage ProposalStorage, auditor audit.Service) *Registrar {
	return &Registrar{handler: NewHandler(store, storage, auditor)}
}

type RegistrarOptions struct {
	TaskReminderTick     time.Duration
	FollowUpReminderTick time.Duration
	FollowUpReminderDays int
}

func NewHandlerWithOptions(
	store Store,
	storage ProposalStorage,
	auditor audit.Service,
	options RegistrarOptions,
) *Handler {
	if options.TaskReminderTick <= 0 {
		options.TaskReminderTick = time.Minute
	}
	if options.FollowUpReminderTick <= 0 {
		options.FollowUpReminderTick = time.Minute
	}
	if options.FollowUpReminderDays <= 0 {
		options.FollowUpReminderDays = 7
	}
	return &Handler{
		store: store, storage: storage, auditor: auditor,
		taskReminderTick:     options.TaskReminderTick,
		followUpReminderTick: options.FollowUpReminderTick,
		followUpReminderDays: options.FollowUpReminderDays,
	}
}

func NewRegistrarWithOptions(
	store Store,
	storage ProposalStorage,
	auditor audit.Service,
	options RegistrarOptions,
) *Registrar {
	return &Registrar{handler: NewHandlerWithOptions(store, storage, auditor, options)}
}

func (*Registrar) ModuleName() string { return "crm" }

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	handler := registrar.handler
	router.With(requireAPIKey).Get("/api/v1/crm/customers", handler.ListCustomers)
	router.With(requireAPIKey).Get("/api/v1/crm/customers/export", handler.ExportCustomers)
	router.With(requireAPIKey).Post("/api/v1/crm/customers", handler.CreateCustomer)
	router.With(requireAPIKey).Post("/api/v1/crm/customers/import-sea", handler.ImportCustomersToSea)
	router.With(requireAPIKey).Get("/api/v1/crm/customers/{customer_id}", handler.GetCustomer)
	router.With(requireAPIKey).Patch("/api/v1/crm/customers/{customer_id}", handler.UpdateCustomer)
	router.With(requireAPIKey).Patch("/api/v1/crm/customers/{customer_id}/value-scores", handler.UpdateCustomerValueScores)
	router.With(requireAPIKey).Delete("/api/v1/crm/customers/{customer_id}", handler.DeleteCustomer)
	router.With(requireAPIKey).Post("/api/v1/crm/customers/batch-transfer", handler.BatchTransferCustomers)
	router.With(requireAPIKey).Post("/api/v1/crm/customers/batch-move-sea", handler.BatchMoveCustomersToSea)
	router.With(requireAPIKey).Post("/api/v1/crm/customers/{customer_id}/claim", handler.ClaimCustomer)
	router.With(requireAPIKey).Get("/api/v1/crm/customers/{customer_id}/contacts", handler.ListContacts)
	router.With(requireAPIKey).Post("/api/v1/crm/customers/{customer_id}/contacts", handler.CreateContact)
	router.With(requireAPIKey).Patch("/api/v1/crm/contacts/{contact_id}", handler.UpdateContact)
	router.With(requireAPIKey).Delete("/api/v1/crm/contacts/{contact_id}", handler.DeleteContact)
	router.With(requireAPIKey).Get("/api/v1/crm/users", handler.ListCRMUsers)
	router.With(requireAPIKey).Get("/api/v1/crm/users/{user_id}", handler.GetCRMUser)
	router.With(requireAPIKey).Get("/api/v1/crm/leads", handler.ListLeads)
	router.With(requireAPIKey).Get("/api/v1/crm/leads/export", handler.ExportLeads)
	router.With(requireAPIKey).Post("/api/v1/crm/leads", handler.CreateLead)
	router.With(requireAPIKey).Get("/api/v1/crm/leads/{lead_id}", handler.GetLead)
	router.With(requireAPIKey).Patch("/api/v1/crm/leads/{lead_id}", handler.UpdateLead)
	router.With(requireAPIKey).Post("/api/v1/crm/leads/batch-transfer", handler.BatchTransferLeads)
	router.With(requireAPIKey).Post("/api/v1/crm/leads/batch-move-pool", handler.BatchMoveLeadsToPool)
	router.With(requireAPIKey).Post("/api/v1/crm/leads/{lead_id}/claim", handler.ClaimLead)
	router.With(requireAPIKey).Post("/api/v1/crm/leads/{lead_id}/convert", handler.ConvertLead)
	router.With(requireAPIKey).Get("/api/v1/crm/follows", handler.ListFollows)
	router.With(requireAPIKey).Post("/api/v1/crm/follows", handler.CreateFollow)
	router.With(requireAPIKey).Get("/api/v1/crm/follow-ups", handler.ListFollowUps)
	router.With(requireAPIKey).Get("/api/v1/crm/audit-logs", handler.ListAuditLogs)
	router.With(requireAPIKey).Get("/api/v1/crm/dashboard/stats", handler.GetDashboardStats)
	router.With(requireAPIKey).Get("/api/v1/crm/dashboard/funnel", handler.GetFunnelMetrics)
	router.With(requireAPIKey).Get("/api/v1/crm/dashboard/funnel/stage/{stage}", handler.GetFunnelStageDetail)
	router.With(requireAPIKey).Get("/api/v1/crm/dashboard/performance", handler.GetPerformanceBoard)
	router.With(requireAPIKey).Get("/api/v1/crm/dashboard/lifecycle", handler.GetLifecycleBoard)
	router.With(requireAPIKey).Get("/api/v1/crm/tasks", handler.ListTasks)
	router.With(requireAPIKey).Get("/api/v1/crm/tasks/reminders/stream", handler.StreamTaskReminders)
	router.With(requireAPIKey).Get("/api/v1/crm/follow-ups/reminders/stream", handler.StreamFollowUpReminders)
	router.With(requireAPIKey).Post("/api/v1/crm/tasks", handler.CreateTask)
	router.With(requireAPIKey).Get("/api/v1/crm/tasks/{task_id}", handler.GetTask)
	router.With(requireAPIKey).Patch("/api/v1/crm/tasks/{task_id}", handler.UpdateTask)
	router.With(requireAPIKey).Post("/api/v1/crm/tasks/{task_id}/status", handler.SetTaskStatus)
	router.With(requireAPIKey).Post("/api/v1/crm/tasks/{task_id}/complete", handler.CompleteTask)
	router.With(requireAPIKey).Post("/api/v1/crm/tasks/{task_id}/cancel", handler.CancelTask)
	router.With(requireAPIKey).Get("/api/v1/crm/rules", handler.ListRules)
	router.With(requireAPIKey).Post("/api/v1/crm/rules", handler.CreateRule)
	router.With(requireAPIKey).Patch("/api/v1/crm/rules/{rule_id}", handler.UpdateRule)
	router.With(requireAPIKey).Delete("/api/v1/crm/rules/{rule_id}", handler.DeleteRule)
	router.With(requireAPIKey).Get("/api/v1/crm/settings/workflow", handler.GetWorkflowSettings)
	router.With(requireAPIKey).Put("/api/v1/crm/settings/workflow", handler.UpdateWorkflowSettings)
	router.With(requireAPIKey).Get("/api/v1/crm/categories", handler.ListCategories)
	router.With(requireAPIKey).Post("/api/v1/crm/categories", handler.CreateCategory)
	router.With(requireAPIKey).Patch("/api/v1/crm/categories/{category_id}", handler.UpdateCategory)
	router.With(requireAPIKey).Delete("/api/v1/crm/categories/{category_id}", handler.DeleteCategory)
	router.With(requireAPIKey).Put("/api/v1/crm/customers/{customer_id}/categories", handler.SetCustomerCategories)
	router.With(requireAPIKey).Get("/api/v1/crm/saved-views", handler.ListSavedViews)
	router.With(requireAPIKey).Post("/api/v1/crm/saved-views", handler.CreateSavedView)
	router.With(requireAPIKey).Patch("/api/v1/crm/saved-views/{view_id}", handler.UpdateSavedView)
	router.With(requireAPIKey).Delete("/api/v1/crm/saved-views/{view_id}", handler.DeleteSavedView)

	router.With(requireAPIKey).Get("/api/v1/crm/proposals", handler.ListProposals)
	router.With(requireAPIKey).Get("/api/v1/crm/proposals/{proposal_id}", handler.GetProposal)
	router.With(requireAPIKey).Post("/api/v1/crm/proposals/uploads/init", handler.InitProposalChunkUpload)
	router.With(requireAPIKey).Post("/api/v1/crm/proposals/{proposal_id}/versions/uploads/init", handler.InitProposalVersionChunkUpload)
	router.With(requireAPIKey).Post("/api/v1/crm/proposals/uploads/{upload_id}/chunks/{index}", handler.UploadProposalChunk)
	router.With(requireAPIKey).Post("/api/v1/crm/proposals/uploads/{upload_id}/finalize", handler.FinalizeProposalChunkUpload)
	router.With(requireAPIKey).Post("/api/v1/crm/proposals", handler.CreateProposal)
	router.With(requireAPIKey).Post("/api/v1/crm/proposals/{proposal_id}/versions", handler.AddProposalVersion)
	router.With(requireAPIKey).Patch("/api/v1/crm/proposals/{proposal_id}", handler.UpdateProposal)
	router.With(requireAPIKey).Delete("/api/v1/crm/proposals/{proposal_id}", handler.DeleteProposal)
	router.With(requireAPIKey).Get("/api/v1/crm/proposals/{proposal_id}/versions/{version_no}/content", handler.GetProposalVersionContent)
	router.With(requireAPIKey).Get("/api/v1/crm/proposals/{proposal_id}/versions/{version_no}/download", handler.DownloadProposalVersion)
}
