package workflows

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

type Registrar struct {
	handler *Handler
}

func NewRegistrar(store Store, projectReader ProjectReader) *Registrar {
	return NewRegistrarWithOptions(store, projectReader)
}

func NewRegistrarWithOptions(
	store Store,
	projectReader ProjectReader,
	options ...Option,
) *Registrar {
	return &Registrar{handler: NewHandler(store, projectReader, options...)}
}

func (*Registrar) ModuleName() string { return "workflows" }

func (registrar *Registrar) RegisterRoutes(
	router chi.Router,
	requireAPIKey func(http.Handler) http.Handler,
) {
	handler := registrar.handler
	router.With(requireAPIKey).Get("/api/v1/projects/{project_id}/workflows", handler.ListProjectWorkflows)
	router.With(requireAPIKey).Post("/api/v1/projects/{project_id}/workflows", handler.CreateWorkflow)
	router.With(requireAPIKey).Get("/api/v1/projects/{project_id}/workflows/documents/{document_key}", handler.DownloadProjectDocument)
	router.With(requireAPIKey).Get("/api/v1/project-workflows/summary", handler.DashboardSummary)
	router.With(requireAPIKey).Get("/api/v1/project-workflows/templates", handler.ListTemplates)
	router.With(requireAPIKey).Patch("/api/v1/project-workflows/{workflow_id}", handler.UpdateWorkflowDefinition)

	router.With(requireAPIKey).Patch("/api/v1/project-workflow-tasks/{task_id}", handler.UpdateTaskStatus)
	router.With(requireAPIKey).Patch("/api/v1/project-workflow-tasks/{task_id}/definition", handler.UpdateProjectTaskDefinition)
	router.With(requireAPIKey).Delete("/api/v1/project-workflow-tasks/{task_id}", handler.DeleteProjectTask)
	router.With(requireAPIKey).Post("/api/v1/projects/{project_id}/workflows/{workflow_id}/tasks", handler.CreateProjectTask)
	router.With(requireAPIKey).Put("/api/v1/projects/{project_id}/workflows/{workflow_id}/tasks/order", handler.ReorderProjectTasks)

	router.With(requireAPIKey).Post("/api/v1/projects/{project_id}/workflow-tasks/{task_id}/contents", handler.CreateProjectContent)
	router.With(requireAPIKey).Patch("/api/v1/project-workflow-task-contents/{content_id}", handler.UpdateProjectContent)
	router.With(requireAPIKey).Delete("/api/v1/project-workflow-task-contents/{content_id}", handler.DeleteProjectContent)
	router.With(requireAPIKey).Post("/api/v1/projects/{project_id}/workflow-tasks/{task_id}/attachments", handler.UploadProjectAttachment)
	router.With(requireAPIKey).Get("/api/v1/projects/{project_id}/workflow-task-attachments/{attachment_id}/download", handler.DownloadProjectAttachment)
	router.With(requireAPIKey).Delete("/api/v1/projects/{project_id}/workflow-task-attachments/{attachment_id}", handler.DeleteProjectAttachment)

	router.With(requireAPIKey).Get("/api/v1/project-workflows/admin/templates", handler.ListAdminTemplates)
	router.With(requireAPIKey).Post("/api/v1/project-workflows/admin/templates", handler.CreateAdminTemplate)
	router.With(requireAPIKey).Get("/api/v1/project-workflows/admin/templates/{template_id}", handler.GetAdminTemplate)
	router.With(requireAPIKey).Patch("/api/v1/project-workflows/admin/templates/{template_id}", handler.UpdateAdminTemplate)
	router.With(requireAPIKey).Delete("/api/v1/project-workflows/admin/templates/{template_id}", handler.DeleteAdminTemplate)
	router.With(requireAPIKey).Post("/api/v1/project-workflows/admin/templates/{template_id}/copy", handler.CopyAdminTemplate)
	router.With(requireAPIKey).Post("/api/v1/project-workflows/admin/templates/{template_id}/tasks", handler.CreateAdminTemplateTask)
	router.With(requireAPIKey).Put("/api/v1/project-workflows/admin/templates/{template_id}/tasks/order", handler.ReorderAdminTemplateTasks)
	router.With(requireAPIKey).Patch("/api/v1/project-workflows/admin/template-tasks/{task_id}", handler.UpdateAdminTemplateTask)
	router.With(requireAPIKey).Delete("/api/v1/project-workflows/admin/template-tasks/{task_id}", handler.DeleteAdminTemplateTask)
	router.With(requireAPIKey).Post("/api/v1/project-workflows/admin/template-tasks/{task_id}/contents", handler.CreateAdminTemplateContent)
	router.With(requireAPIKey).Patch("/api/v1/project-workflows/admin/template-task-contents/{content_id}", handler.UpdateAdminTemplateContent)
	router.With(requireAPIKey).Delete("/api/v1/project-workflows/admin/template-task-contents/{content_id}", handler.DeleteAdminTemplateContent)
	router.With(requireAPIKey).Post("/api/v1/project-workflows/admin/template-tasks/{task_id}/attachments", handler.UploadAdminTemplateAttachment)
	router.With(requireAPIKey).Delete("/api/v1/project-workflows/admin/template-task-attachments/{attachment_id}", handler.DeleteAdminTemplateAttachment)
}
