package digital_employees

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type Handler struct {
	store           Store
	now             func() time.Time
	secretGenerator func() (string, error)
}

type Option func(*Handler)

func WithNow(now func() time.Time) Option {
	return func(handler *Handler) {
		if now != nil {
			handler.now = now
		}
	}
}

func WithSecretGenerator(generator func() (string, error)) Option {
	return func(handler *Handler) {
		if generator != nil {
			handler.secretGenerator = generator
		}
	}
}

func NewHandler(store Store, options ...Option) *Handler {
	handler := &Handler{
		store:           store,
		now:             time.Now,
		secretGenerator: NewAPISecret,
	}
	for _, option := range options {
		option(handler)
	}
	return handler
}

func (h *Handler) ListEmployees(w http.ResponseWriter, r *http.Request) {
	status := FilterEmployeeStatus(r.URL.Query().Get("status"))
	employeeType := FilterEmployeeType(r.URL.Query().Get("employee_type"))
	items, err := h.store.ListEmployees(r.Context(), status, employeeType)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if items == nil {
		items = []DigitalEmployee{}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, DigitalEmployeeListResponse{
		Items: items,
		Total: len(items),
	})
}

func (h *Handler) GetEmployee(w http.ResponseWriter, r *http.Request) {
	employeeID, ok := parsePathID(w, r, "employee_id")
	if !ok {
		return
	}
	item, err := h.store.GetEmployee(r.Context(), employeeID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if item == nil {
		writeStoreError(w, ErrEmployeeNotFound)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, item)
}

type digitalEmployeeCreateRequest struct {
	Name         *string `json:"name"`
	AvatarURL    *string `json:"avatar_url"`
	EmployeeType *string `json:"employee_type"`
	Description  *string `json:"description"`
}

func (h *Handler) CreateEmployee(w http.ResponseWriter, r *http.Request) {
	var body digitalEmployeeCreateRequest
	if err := decodeJSON(r, &body, false); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	name, ok := validateName(w, body.Name)
	if !ok {
		return
	}
	if body.EmployeeType == nil || !ValidEmployeeType(*body.EmployeeType) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, invalidEmployeeTypeDetail())
		return
	}
	secret, err := h.secretGenerator()
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	item, err := h.store.CreateEmployee(r.Context(), DigitalEmployeeCreate{
		Name:         name,
		AvatarURL:    body.AvatarURL,
		EmployeeType: *body.EmployeeType,
		Description:  body.Description,
	}, secret)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if item == nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, item)
}

type statusUpdateRequest struct {
	Status *string `json:"status"`
}

func (h *Handler) UpdateStatus(w http.ResponseWriter, r *http.Request) {
	employeeID, ok := parsePathID(w, r, "employee_id")
	if !ok {
		return
	}
	var body statusUpdateRequest
	if err := decodeJSON(r, &body, false); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	if body.Status == nil || !ValidEmployeeStatus(*body.Status) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, invalidEmployeeStatusDetail())
		return
	}
	item, err := h.store.UpdateEmployeeStatus(r.Context(), employeeID, *body.Status)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if item == nil {
		writeStoreError(w, ErrEmployeeNotFound)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, item)
}

func (h *Handler) DeleteEmployee(w http.ResponseWriter, r *http.Request) {
	employeeID, ok := parsePathID(w, r, "employee_id")
	if !ok {
		return
	}
	if err := h.store.DeleteEmployee(r.Context(), employeeID); err != nil {
		writeStoreError(w, err)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (h *Handler) ListTasks(w http.ResponseWriter, r *http.Request) {
	employeeID, ok := parsePathID(w, r, "employee_id")
	if !ok {
		return
	}
	page, ok := parseBoundedQuery(w, r, "page", 1, 1, 0)
	if !ok {
		return
	}
	pageSize, ok := parseBoundedQuery(w, r, "page_size", 20, 1, 100)
	if !ok {
		return
	}
	items, total, err := h.store.ListTasks(r.Context(), employeeID, page, pageSize)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if items == nil {
		items = []DigitalEmployeeTask{}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, DigitalEmployeeTaskListResponse{
		Items: items,
		Total: total,
	})
}

func (h *Handler) GetTask(w http.ResponseWriter, r *http.Request) {
	employeeID, ok := parsePathID(w, r, "employee_id")
	if !ok {
		return
	}
	taskID, ok := parsePathID(w, r, "task_id")
	if !ok {
		return
	}
	item, err := h.store.GetTask(r.Context(), employeeID, taskID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if item == nil {
		writeStoreError(w, ErrTaskNotFound)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, item)
}

func (h *Handler) ListLogs(w http.ResponseWriter, r *http.Request) {
	employeeID, ok := parsePathID(w, r, "employee_id")
	if !ok {
		return
	}
	taskID, ok := parsePathID(w, r, "task_id")
	if !ok {
		return
	}
	limit, ok := parseBoundedQuery(w, r, "limit", 100, 1, 500)
	if !ok {
		return
	}
	var cursor *int64
	if raw := strings.TrimSpace(r.URL.Query().Get("cursor")); raw != "" {
		value, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "cursor must be an integer")
			return
		}
		cursor = &value
	}
	items, hasMore, nextCursor, err := h.store.ListLogs(
		r.Context(),
		employeeID,
		taskID,
		cursor,
		limit,
	)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if items == nil {
		items = []DigitalEmployeeLog{}
	}
	response := DigitalEmployeeLogListResponse{
		Items:   items,
		HasMore: hasMore,
	}
	if nextCursor != nil {
		cursorText := strconv.FormatInt(*nextCursor, 10)
		response.Cursor = &cursorText
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, response)
}

func (h *Handler) ListRecentLogs(w http.ResponseWriter, r *http.Request) {
	employeeID, ok := parsePathID(w, r, "employee_id")
	if !ok {
		return
	}
	limit, ok := parseBoundedQuery(w, r, "limit", 20, 1, 100)
	if !ok {
		return
	}
	items, err := h.store.ListEmployeeLogs(r.Context(), employeeID, limit)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if items == nil {
		items = []DigitalEmployeeLog{}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, DigitalEmployeeRecentLogsResponse{Items: items})
}

type registerRequest struct {
	Name                          *string            `json:"name"`
	EmployeeType                  *string            `json:"employee_type"`
	Description                   *string            `json:"description"`
	IsSilentAlertThresholdMinutes optionalPresentInt `json:"is_silent_alert_threshold_minutes"`
}

type optionalPresentInt struct {
	Value   int
	Present bool
}

func (value *optionalPresentInt) UnmarshalJSON(payload []byte) error {
	value.Present = true
	if string(payload) == "null" {
		return errors.New("is_silent_alert_threshold_minutes cannot be null")
	}
	return json.Unmarshal(payload, &value.Value)
}

func (h *Handler) Register(w http.ResponseWriter, r *http.Request) {
	var body registerRequest
	if err := decodeJSON(r, &body, false); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	name, ok := validateName(w, body.Name)
	if !ok {
		return
	}
	if body.EmployeeType == nil || !ValidEmployeeType(*body.EmployeeType) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, invalidEmployeeTypeDetail())
		return
	}
	threshold := 30
	if body.IsSilentAlertThresholdMinutes.Present {
		threshold = body.IsSilentAlertThresholdMinutes.Value
	}
	secret, err := h.secretGenerator()
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	employeeID, apiSecret, err := h.store.RegisterEmployee(r.Context(), RegisterInput{
		Name:                          name,
		EmployeeType:                  *body.EmployeeType,
		Description:                   body.Description,
		IsSilentAlertThresholdMinutes: threshold,
	}, secret)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, RegisterResponse{
		ID:        employeeID,
		APISecret: apiSecret,
	})
}

type heartbeatRequest struct {
	TaskID          *string        `json:"task_id"`
	TaskName        *string        `json:"task_name"`
	TaskType        *string        `json:"task_type"`
	Status          *string        `json:"status"`
	ProgressPercent *int           `json:"progress_percent"`
	CurrentStep     *string        `json:"current_step"`
	Message         *string        `json:"message"`
	MetadataJSON    map[string]any `json:"metadata_json"`
}

func (h *Handler) Heartbeat(w http.ResponseWriter, r *http.Request) {
	employeeID, ok := parsePathID(w, r, "employee_id")
	if !ok {
		return
	}
	var body heartbeatRequest
	if err := decodeJSON(r, &body, true); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid request body")
		return
	}
	if body.Status != nil && !ValidTaskStatus(*body.Status) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, invalidTaskStatusDetail())
		return
	}
	if body.ProgressPercent != nil && (*body.ProgressPercent < 0 || *body.ProgressPercent > 100) {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "progress_percent must be between 0 and 100")
		return
	}
	if body.TaskName != nil && utf8.RuneCountInString(*body.TaskName) > 256 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "task_name must contain at most 256 characters")
		return
	}
	if body.TaskType != nil && utf8.RuneCountInString(*body.TaskType) > 64 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "task_type must contain at most 64 characters")
		return
	}

	var apiSecret *string
	if raw, ok := r.URL.Query()["api_secret"]; ok && len(raw) > 0 {
		value := raw[0]
		apiSecret = &value
	}
	now := h.now().UTC()
	acknowledgedAt, err := h.store.Heartbeat(r.Context(), HeartbeatInput{
		EmployeeID:      employeeID,
		APISecret:       apiSecret,
		TaskID:          body.TaskID,
		TaskName:        body.TaskName,
		TaskType:        body.TaskType,
		Status:          body.Status,
		ProgressPercent: body.ProgressPercent,
		CurrentStep:     body.CurrentStep,
		Message:         body.Message,
		MetadataJSON:    body.MetadataJSON,
	}, now)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, HeartbeatResponse{
		OK:             true,
		AcknowledgedAt: httpapi.Timestamp(acknowledgedAt),
	})
}

func validateName(w http.ResponseWriter, value *string) (string, bool) {
	if value == nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "name is required")
		return "", false
	}
	if utf8.RuneCountInString(*value) > 128 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "name must contain at most 128 characters")
		return "", false
	}
	return *value, true
}

func parsePathID(w http.ResponseWriter, r *http.Request, key string) (int64, bool) {
	raw := chi.URLParam(r, key)
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, key+" must be an integer")
		return 0, false
	}
	return value, true
}

func parseBoundedQuery(
	w http.ResponseWriter,
	r *http.Request,
	key string,
	fallback, minimum, maximum int,
) (int, bool) {
	values, present := r.URL.Query()[key]
	if !present {
		return fallback, true
	}
	raw := ""
	if len(values) > 0 {
		raw = strings.TrimSpace(values[0])
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, key+" must be an integer")
		return 0, false
	}
	if value < minimum {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, key+" must be greater than or equal to "+strconv.Itoa(minimum))
		return 0, false
	}
	if maximum > 0 && value > maximum {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, key+" must be less than or equal to "+strconv.Itoa(maximum))
		return 0, false
	}
	return value, true
}

func decodeJSON(r *http.Request, target any, optional bool) error {
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(target); err != nil {
		if optional && errors.Is(err, io.EOF) {
			return nil
		}
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("multiple JSON values")
		}
		return err
	}
	return nil
}

func writeStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrEmployeeNotFound):
		httpapi.WriteDetail(w, http.StatusNotFound, "Employee not found")
	case errors.Is(err, ErrTaskNotFound):
		httpapi.WriteDetail(w, http.StatusNotFound, "Task not found")
	case errors.Is(err, ErrInvalidAPISecret):
		httpapi.WriteDetail(w, http.StatusUnauthorized, "Invalid api_secret")
	case errors.Is(err, ErrInvalidStatus):
		httpapi.WriteDetail(w, http.StatusBadRequest, "Only SUSPENDED or IDLE allowed")
	default:
		httpapi.WriteInternalServerError(w)
	}
}

func invalidEmployeeTypeDetail() string {
	return "employee_type must be one of: auto_report_upload, scheduled_job, rpa_bot, ai_agent, monitoring, database, custom"
}

func invalidEmployeeStatusDetail() string {
	return "status must be one of: idle, running, succeeded, failed, suspended"
}

func invalidTaskStatusDetail() string {
	return "status must be one of: pending, running, succeeded, failed, cancelled"
}
