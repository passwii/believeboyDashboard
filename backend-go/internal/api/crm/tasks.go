package crm

import (
	"context"
	"net/http"
	"strings"

	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

func (handler *Handler) ListTasks(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	scope, err := validateScope(r.URL.Query().Get("scope"), "mine", "all")
	if err != nil {
		WriteError(w, err)
		return
	}
	scope = ResolveScope(scope, identity.IsAdmin)
	ownerID := optionalString(r.URL.Query().Get("owner_id"))
	if ownerID != nil && !identity.IsAdmin {
		httpapi.WriteDetail(w, http.StatusForbidden, "owner_id 筛选仅管理员可用")
		return
	}
	page, pageSize, err := parsePage(r, 20, maxTaskPageSize)
	if err != nil {
		WriteError(w, err)
		return
	}
	customerID, err := parseOptionalIntQuery(r, "customer_id")
	if err != nil {
		WriteError(w, err)
		return
	}
	leadID, err := parseOptionalIntQuery(r, "lead_id")
	if err != nil {
		WriteError(w, err)
		return
	}
	sortBy := r.URL.Query().Get("sort_by")
	if sortBy == "" {
		sortBy = "due_date"
	}
	sortOrder := r.URL.Query().Get("sort_order")
	if sortOrder == "" {
		sortOrder = "asc"
	}
	result, err := handler.store.ListTasks(r.Context(), TaskListFilter{
		Scope:      scope,
		Type:       optionalString(r.URL.Query().Get("type")),
		Status:     optionalString(r.URL.Query().Get("status")),
		Priority:   optionalString(r.URL.Query().Get("priority")),
		OwnerID:    ownerID,
		CustomerID: customerID,
		LeadID:     leadID,
		SortBy:     sortBy,
		SortOrder:  sortOrder,
		Page:       page,
		PageSize:   pageSize,
	}, identity.UserID, identity.IsAdmin)
	if err != nil {
		WriteError(w, err)
		return
	}
	result.Items = ensureSlice(result.Items)
	writeJSON(w, http.StatusOK, result)
}

func (handler *Handler) CreateTask(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	var input TaskCreateInput
	if err := decodeJSON(r, &input, false); err != nil {
		WriteError(w, err)
		return
	}
	if err := validateLength(input.Title, 1, 200, "title"); err != nil {
		WriteError(w, err)
		return
	}
	if input.Priority == "" {
		input.Priority = "medium"
	}
	if !validTaskPriority(input.Priority) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "invalid priority")
		return
	}
	if input.Type == "" {
		input.Type = "custom"
	}
	if !validTaskType(input.Type) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "invalid type")
		return
	}
	if input.CustomerID != nil && input.LeadID != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "任务只能关联客户或线索之一（二选一）")
		return
	}
	item, err := handler.store.CreateTask(r.Context(), input, identity.UserID, identity.IsAdmin)
	if err != nil {
		WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

func (handler *Handler) GetTask(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	taskID, err := parsePathID(r, "task_id")
	if err != nil {
		WriteError(w, err)
		return
	}
	item, err := handler.store.GetTask(r.Context(), taskID)
	if err != nil {
		WriteError(w, err)
		return
	}
	if item == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Task not found")
		return
	}
	if err := RequireOwnerOrAdmin(item.OwnerID, identity); err != nil {
		WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (handler *Handler) UpdateTask(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	taskID, err := parsePathID(r, "task_id")
	if err != nil {
		WriteError(w, err)
		return
	}
	existing, err := handler.store.GetTask(r.Context(), taskID)
	if err != nil {
		WriteError(w, err)
		return
	}
	if existing == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Task not found")
		return
	}
	if err := RequireOwnerOrAdmin(existing.OwnerID, identity); err != nil {
		WriteError(w, err)
		return
	}
	var input TaskUpdateInput
	if err := decodeJSON(r, &input, false); err != nil {
		WriteError(w, err)
		return
	}
	if input.Title.Set && input.Title.Value != nil {
		trimmed := strings.TrimSpace(*input.Title.Value)
		input.Title.Value = &trimmed
		if err := validateLength(trimmed, 1, 200, "title"); err != nil {
			WriteError(w, err)
			return
		}
	}
	if input.Priority.Set && input.Priority.Value != nil && !validTaskPriority(*input.Priority.Value) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "invalid priority")
		return
	}
	if input.Type.Set && input.Type.Value != nil && !validTaskType(*input.Type.Value) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "invalid type")
		return
	}
	if input.OwnerID.Set && !identity.IsAdmin {
		httpapi.WriteDetail(w, http.StatusForbidden, "仅管理员可修改负责人")
		return
	}
	customerID := existing.CustomerID
	leadID := existing.LeadID
	if input.CustomerID.Set {
		customerID = input.CustomerID.Value
	}
	if input.LeadID.Set {
		leadID = input.LeadID.Value
	}
	if customerID != nil && leadID != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "任务只能关联客户或线索之一（二选一）")
		return
	}
	item, err := handler.store.UpdateTask(r.Context(), taskID, input, identity.UserID, identity.IsAdmin)
	if err != nil {
		WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (handler *Handler) SetTaskStatus(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	taskID, err := parsePathID(r, "task_id")
	if err != nil {
		WriteError(w, err)
		return
	}
	existing, err := handler.store.GetTask(r.Context(), taskID)
	if err != nil {
		WriteError(w, err)
		return
	}
	if existing == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Task not found")
		return
	}
	if err := RequireOwnerOrAdmin(existing.OwnerID, identity); err != nil {
		WriteError(w, err)
		return
	}
	var input TaskStatusInput
	if err := decodeJSON(r, &input, false); err != nil {
		WriteError(w, err)
		return
	}
	if input.Status != "pending" && input.Status != "in_progress" && input.Status != "done" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "invalid status")
		return
	}
	item, err := handler.store.SetTaskStatus(r.Context(), taskID, input.Status, identity.UserID)
	if err != nil {
		WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (handler *Handler) CompleteTask(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	taskID, err := parsePathID(r, "task_id")
	if err != nil {
		WriteError(w, err)
		return
	}
	existing, err := handler.store.GetTask(r.Context(), taskID)
	if err != nil {
		WriteError(w, err)
		return
	}
	if existing == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Task not found")
		return
	}
	if err := RequireOwnerOrAdmin(existing.OwnerID, identity); err != nil {
		WriteError(w, err)
		return
	}
	var input *TaskCompleteInput
	if r.Body != nil && r.ContentLength != 0 {
		input = &TaskCompleteInput{}
		if err := decodeJSON(r, input, false); err != nil {
			WriteError(w, err)
			return
		}
		if input.Note != nil && len([]rune(*input.Note)) > 1000 {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "note is too long")
			return
		}
	}
	item, err := handler.store.CompleteTask(r.Context(), taskID, input, identity.UserID)
	if err != nil {
		WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (handler *Handler) CancelTask(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	taskID, err := parsePathID(r, "task_id")
	if err != nil {
		WriteError(w, err)
		return
	}
	existing, err := handler.store.GetTask(r.Context(), taskID)
	if err != nil {
		WriteError(w, err)
		return
	}
	if existing == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "Task not found")
		return
	}
	if err := RequireOwnerOrAdmin(existing.OwnerID, identity); err != nil {
		WriteError(w, err)
		return
	}
	item, err := handler.store.CancelTask(r.Context(), taskID, identity.UserID)
	if err != nil {
		WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (handler *Handler) StreamTaskReminders(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	runSSE(r.Context(), w, "task_reminder", handler.taskReminderTick, func(ctx context.Context) ([]any, error) {
		items, err := handler.store.ListTaskReminders(ctx, optionalString(identity.UserID))
		if err != nil {
			return nil, err
		}
		result := make([]any, 0, len(items))
		for _, item := range items {
			result = append(result, item)
		}
		return result, nil
	})
}

func (handler *Handler) StreamFollowUpReminders(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	runSSE(r.Context(), w, "follow_up_reminder", handler.followUpReminderTick, func(ctx context.Context) ([]any, error) {
		items, err := handler.store.ListFollowUpReminders(ctx, identity.UserID, handler.followUpReminderDays)
		if err != nil {
			return nil, err
		}
		result := make([]any, 0, len(items))
		for _, item := range items {
			result = append(result, item)
		}
		return result, nil
	})
}

func validTaskPriority(value string) bool {
	switch value {
	case "low", "medium", "high", "urgent":
		return true
	default:
		return false
	}
}

func validTaskType(value string) bool {
	switch value {
	case "follow_up", "call", "visit", "custom":
		return true
	default:
		return false
	}
}
