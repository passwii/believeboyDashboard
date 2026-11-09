package workflows

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"
)

const (
	KindStoreLaunch        = "store_launch"
	KindProductDevelopment = "product_development"

	StatusNotStarted       = "not_started"
	StatusInProgress       = "in_progress"
	StatusWaitingOnPartner = "waiting_on_partner"
	StatusCompleted        = "completed"

	DocumentKeyAmazonRegistrationForm = "amazon_registration_form"
	DocumentKeyWorldFirstRegistration = "worldfirst_registration_guide"

	MaxDurationDays = 3650
)

var (
	ValidKinds = map[string]bool{
		KindStoreLaunch:        true,
		KindProductDevelopment: true,
	}
	ValidStatuses = map[string]bool{
		StatusNotStarted:       true,
		StatusInProgress:       true,
		StatusWaitingOnPartner: true,
		StatusCompleted:        true,
	}
	ValidDocumentKeys = map[string]bool{
		DocumentKeyAmazonRegistrationForm: true,
		DocumentKeyWorldFirstRegistration: true,
	}
)

type TemplateOption struct {
	Key   string `json:"key"`
	Kind  string `json:"kind"`
	Title string `json:"title"`
}

type TemplatesResponse struct {
	Templates []TemplateOption `json:"templates"`
}

type Content struct {
	ID        int64   `json:"id"`
	Title     *string `json:"title"`
	Body      string  `json:"body"`
	SortOrder int     `json:"sort_order"`
}

type Attachment struct {
	ID          int64   `json:"id"`
	Filename    string  `json:"filename"`
	ContentType string  `json:"content_type"`
	FileSize    int64   `json:"file_size"`
	Uploader    *string `json:"uploader"`
	CreatedAt   string  `json:"created_at"`
	Origin      *string `json:"origin"`
}

type Task struct {
	ID            int64        `json:"id"`
	WorkflowID    int64        `json:"workflow_id"`
	Title         string       `json:"title"`
	Description   *string      `json:"description"`
	SortOrder     int          `json:"sort_order"`
	Status        string       `json:"status"`
	AttachmentKey *string      `json:"attachment_key"`
	DurationDays  *int         `json:"duration_days"`
	StartDate     *string      `json:"start_date"`
	EndDate       *string      `json:"end_date"`
	SpanDays      *int         `json:"span_days"`
	Contents      []Content    `json:"contents"`
	Attachments   []Attachment `json:"attachments"`
}

type Workflow struct {
	ID                 int64   `json:"id"`
	ProjectID          int64   `json:"project_id"`
	Kind               string  `json:"kind"`
	Title              string  `json:"title"`
	TemplateKey        string  `json:"template_key"`
	Status             string  `json:"status"`
	TaskCount          int     `json:"task_count"`
	CompletedTaskCount int     `json:"completed_task_count"`
	StartDate          *string `json:"start_date"`
	ScheduleStart      *string `json:"schedule_start"`
	ScheduleEnd        *string `json:"schedule_end"`
	ScheduleDays       *int    `json:"schedule_days"`
	Tasks              []Task  `json:"tasks"`
}

type WorkflowListResponse struct {
	ProjectID int64      `json:"project_id"`
	Workflows []Workflow `json:"workflows"`
}

type WorkflowSummary struct {
	ID                 int64   `json:"id"`
	Kind               string  `json:"kind"`
	Title              string  `json:"title"`
	TemplateKey        string  `json:"template_key"`
	Status             string  `json:"status"`
	CompletedTaskCount int     `json:"completed_task_count"`
	TaskCount          int     `json:"task_count"`
	StartDate          *string `json:"start_date"`
	ScheduleStart      *string `json:"schedule_start"`
	ScheduleEnd        *string `json:"schedule_end"`
	ScheduleDays       *int    `json:"schedule_days"`
}

type ProjectSchedule struct {
	ScheduleStart *string `json:"schedule_start"`
	ScheduleEnd   *string `json:"schedule_end"`
	ScheduleDays  *int    `json:"schedule_days"`
}

type ProjectSummary struct {
	ProjectID     int64             `json:"project_id"`
	Workflows     []WorkflowSummary `json:"workflows"`
	ScheduleStart *string           `json:"schedule_start"`
	ScheduleEnd   *string           `json:"schedule_end"`
	ScheduleDays  *int              `json:"schedule_days"`
}

type SummaryResponse struct {
	Projects []ProjectSummary `json:"projects"`
}

type TemplateListItem struct {
	ID          int64   `json:"id"`
	Key         string  `json:"key"`
	Kind        string  `json:"kind"`
	Title       string  `json:"title"`
	Description *string `json:"description"`
	SortOrder   int     `json:"sort_order"`
	TaskCount   int     `json:"task_count"`
}

type TemplateTask struct {
	ID            int64        `json:"id"`
	TemplateID    int64        `json:"template_id"`
	Title         string       `json:"title"`
	Description   *string      `json:"description"`
	SortOrder     int          `json:"sort_order"`
	AttachmentKey *string      `json:"attachment_key"`
	DurationDays  *int         `json:"duration_days"`
	Contents      []Content    `json:"contents"`
	Attachments   []Attachment `json:"attachments"`
}

type TemplateDetail struct {
	TemplateListItem
	Tasks []TemplateTask `json:"tasks"`
}

type TemplateListResponse struct {
	Templates []TemplateListItem `json:"templates"`
}

// NullableString distinguishes an omitted field from an explicit JSON null.
type NullableString struct {
	Value   *string
	Present bool
}

func (value *NullableString) UnmarshalJSON(data []byte) error {
	value.Present = true
	if string(data) == "null" {
		value.Value = nil
		return nil
	}
	var text string
	if err := json.Unmarshal(data, &text); err != nil {
		return err
	}
	value.Value = &text
	return nil
}

// NullableInt distinguishes an omitted field from an explicit JSON null.
type NullableInt struct {
	Value   *int
	Present bool
}

func (value *NullableInt) UnmarshalJSON(data []byte) error {
	value.Present = true
	if string(data) == "null" {
		value.Value = nil
		return nil
	}
	var number int
	if err := json.Unmarshal(data, &number); err != nil {
		return err
	}
	value.Value = &number
	return nil
}

// NullableDate preserves the PATCH distinction between omitted, null, and a date.
type NullableDate struct {
	Value   *string
	Present bool
}

func (value *NullableDate) UnmarshalJSON(data []byte) error {
	value.Present = true
	if string(data) == "null" {
		value.Value = nil
		return nil
	}
	var text string
	if err := json.Unmarshal(data, &text); err != nil {
		return err
	}
	value.Value = &text
	return nil
}

type WorkflowCreateRequest struct {
	Kind        string  `json:"kind"`
	TemplateKey string  `json:"template_key"`
	Title       *string `json:"title"`
	StartDate   *string `json:"start_date"`
}

type WorkflowDefinitionUpdateRequest struct {
	Title     *string      `json:"title"`
	StartDate NullableDate `json:"start_date"`
}

type TaskStatusUpdateRequest struct {
	Status string `json:"status"`
}

type TaskCreateRequest struct {
	Title         string  `json:"title"`
	Description   *string `json:"description"`
	AttachmentKey *string `json:"attachment_key"`
	DurationDays  *int    `json:"duration_days"`
	SortOrder     *int    `json:"sort_order"`
}

type TaskDefinitionUpdateRequest struct {
	Title         *string        `json:"title"`
	Description   NullableString `json:"description"`
	AttachmentKey NullableString `json:"attachment_key"`
	DurationDays  NullableInt    `json:"duration_days"`
	StartDate     NullableDate   `json:"start_date"`
	EndDate       NullableDate   `json:"end_date"`
}

type TaskOrderRequest struct {
	TaskIDs []int64 `json:"task_ids"`
}

type ContentCreateRequest struct {
	Body      string  `json:"body"`
	Title     *string `json:"title"`
	SortOrder *int    `json:"sort_order"`
}

type ContentUpdateRequest struct {
	Body  *string        `json:"body"`
	Title NullableString `json:"title"`
}

type TemplateCreateRequest struct {
	Kind        string  `json:"kind"`
	Title       string  `json:"title"`
	Description *string `json:"description"`
	Key         *string `json:"key"`
	SortOrder   *int    `json:"sort_order"`
}

type TemplateUpdateRequest struct {
	Title       *string        `json:"title"`
	Description NullableString `json:"description"`
	SortOrder   *int           `json:"sort_order"`
}

type TemplateCopyRequest struct {
	Title *string `json:"title"`
	Key   *string `json:"key"`
}

type TemplateTaskCreateRequest struct {
	Title         string  `json:"title"`
	Description   *string `json:"description"`
	AttachmentKey *string `json:"attachment_key"`
	DurationDays  *int    `json:"duration_days"`
	SortOrder     *int    `json:"sort_order"`
}

type TemplateTaskUpdateRequest struct {
	Title         *string        `json:"title"`
	Description   NullableString `json:"description"`
	AttachmentKey NullableString `json:"attachment_key"`
	DurationDays  NullableInt    `json:"duration_days"`
}

type TemplateContentCreateRequest struct {
	Body      string  `json:"body"`
	Title     *string `json:"title"`
	SortOrder *int    `json:"sort_order"`
}

type TemplateContentUpdateRequest struct {
	Body  *string        `json:"body"`
	Title NullableString `json:"title"`
}

type AttachmentUpload struct {
	R2Key       string
	Filename    string
	ContentType string
	FileSize    int64
	Uploader    *string
	Origin      string
}

type AttachmentDownload struct {
	ID          int64
	ProjectID   int64
	TaskID      int64
	R2Key       string
	Filename    string
	ContentType string
	FileSize    int64
}

type WorkflowMutation struct {
	Workflow   *Workflow
	DeleteKeys []string
}

type TemplateMutation struct {
	Template   *TemplateDetail
	DeleteKeys []string
}

type Store interface {
	ListProjectWorkflows(context.Context, int64) ([]Workflow, error)
	ListWorkflowSummaries(context.Context, []int64) (map[int64][]WorkflowSummary, error)
	ListProjectSchedules(context.Context, []int64) (map[int64]ProjectSchedule, error)
	ListWorkflowTemplates(context.Context) ([]TemplateOption, error)

	GetWorkflow(context.Context, int64) (*Workflow, error)
	GetTaskProject(context.Context, int64) (int64, error)
	GetContentProject(context.Context, int64) (int64, error)
	GetAttachmentForDownload(context.Context, int64, int64) (*AttachmentDownload, error)

	CreateWorkflow(context.Context, int64, WorkflowCreateRequest) (*Workflow, error)
	UpdateWorkflowDefinition(context.Context, int64, WorkflowDefinitionUpdateRequest) (*Workflow, error)
	UpdateTaskStatus(context.Context, int64, string) (*Workflow, error)
	CreateProjectTask(context.Context, int64, int64, TaskCreateRequest) (*Workflow, error)
	UpdateProjectTaskDefinition(context.Context, int64, TaskDefinitionUpdateRequest) (*Workflow, error)
	DeleteProjectTask(context.Context, int64) (WorkflowMutation, error)
	ReorderProjectTasks(context.Context, int64, int64, []int64) (*Workflow, error)
	CreateProjectContent(context.Context, int64, int64, ContentCreateRequest) (*Workflow, error)
	UpdateProjectContent(context.Context, int64, ContentUpdateRequest) (*Workflow, error)
	DeleteProjectContent(context.Context, int64) (*Workflow, error)
	InsertProjectAttachment(context.Context, int64, int64, AttachmentUpload) (*Workflow, error)
	DeleteProjectAttachment(context.Context, int64, int64) (WorkflowMutation, error)

	ListWorkflowTemplateRows(context.Context) ([]TemplateListItem, error)
	GetWorkflowTemplate(context.Context, int64) (*TemplateDetail, error)
	CreateWorkflowTemplate(context.Context, TemplateCreateRequest) (*TemplateDetail, error)
	UpdateWorkflowTemplate(context.Context, int64, TemplateUpdateRequest) (*TemplateDetail, error)
	DeleteWorkflowTemplate(context.Context, int64) (TemplateMutation, error)
	CopyWorkflowTemplate(context.Context, int64, TemplateCopyRequest) (*TemplateDetail, error)
	CreateTemplateTask(context.Context, int64, TemplateTaskCreateRequest) (*TemplateDetail, error)
	UpdateTemplateTask(context.Context, int64, TemplateTaskUpdateRequest) (*TemplateDetail, error)
	DeleteTemplateTask(context.Context, int64) (TemplateMutation, error)
	ReorderTemplateTasks(context.Context, int64, []int64) (*TemplateDetail, error)
	CreateTemplateContent(context.Context, int64, TemplateContentCreateRequest) (*TemplateDetail, error)
	UpdateTemplateContent(context.Context, int64, TemplateContentUpdateRequest) (*TemplateDetail, error)
	DeleteTemplateContent(context.Context, int64) (*TemplateDetail, error)
	InsertTemplateAttachment(context.Context, int64, AttachmentUpload) (*TemplateDetail, error)
	DeleteTemplateAttachment(context.Context, int64) (TemplateMutation, error)
}

type BlobStore interface {
	// The workflow domain passes only server-generated keys under its fixed
	// project-launch prefixes. Any URL returned by Put is deliberately ignored.
	Put(context.Context, string, []byte, string) (string, error)
	Get(context.Context, string) (io.ReadCloser, error)
	Delete(context.Context, string) error
}

var (
	ErrBlobNotFound     = errors.New("workflow blob not found")
	ErrDocumentNotFound = errors.New("workflow document not found")
)

type FileStore interface {
	// OpenDocument receives an allowlisted document key, never a user path.
	OpenDocument(context.Context, string) (io.ReadCloser, error)
}

type MutationMeta struct {
	Operator      *string
	TraceID       *string
	RequestMethod *string
	RequestPath   *string
	IPAddress     *string
	UserAgent     *string
}

type mutationMetaKey struct{}

func WithMutationMeta(ctx context.Context, meta MutationMeta) context.Context {
	return context.WithValue(ctx, mutationMetaKey{}, meta)
}

func MutationMetaFromContext(ctx context.Context) MutationMeta {
	meta, _ := ctx.Value(mutationMetaKey{}).(MutationMeta)
	return meta
}

func AggregateStatus(statuses []string) string {
	if len(statuses) > 0 {
		allCompleted := true
		for _, status := range statuses {
			if status != StatusCompleted {
				allCompleted = false
			}
			if status == StatusInProgress {
				return StatusInProgress
			}
		}
		if allCompleted {
			return StatusCompleted
		}
	}
	for _, status := range statuses {
		if status == StatusWaitingOnPartner {
			return StatusWaitingOnPartner
		}
	}
	return StatusNotStarted
}

func SpanDays(start, end *string) *int {
	if start == nil || end == nil {
		return nil
	}
	startDate, err := time.Parse("2006-01-02", *start)
	if err != nil {
		return nil
	}
	endDate, err := time.Parse("2006-01-02", *end)
	if err != nil || endDate.Before(startDate) {
		return nil
	}
	days := int(endDate.Sub(startDate).Hours()/24) + 1
	return &days
}

// RecomputeSchedule mirrors the Python service: manual dates win, missing
// dates are filled from the workflow anchor and the preceding task end date.
func RecomputeSchedule(startDate *string, tasks []Task) {
	var cursor *time.Time
	if startDate != nil {
		if parsed, err := time.Parse("2006-01-02", *startDate); err == nil {
			cursor = &parsed
		}
	}
	for index := range tasks {
		task := &tasks[index]
		if task.StartDate == nil && task.EndDate == nil &&
			task.DurationDays != nil && cursor != nil {
			days := *task.DurationDays
			if days < 1 {
				days = 1
			}
			start := *cursor
			end := start.AddDate(0, 0, days-1)
			startText := start.Format("2006-01-02")
			endText := end.Format("2006-01-02")
			task.StartDate = &startText
			task.EndDate = &endText
		}
		if task.EndDate != nil {
			if parsed, err := time.Parse("2006-01-02", *task.EndDate); err == nil {
				next := parsed.AddDate(0, 0, 1)
				cursor = &next
			}
		} else if task.StartDate != nil {
			if parsed, err := time.Parse("2006-01-02", *task.StartDate); err == nil {
				next := parsed.AddDate(0, 0, 1)
				cursor = &next
			}
		}
		task.SpanDays = SpanDays(task.StartDate, task.EndDate)
	}
}

func FinalizeWorkflow(item *Workflow) {
	if item == nil {
		return
	}
	if item.Tasks == nil {
		item.Tasks = []Task{}
	}
	statuses := make([]string, 0, len(item.Tasks))
	starts := make([]string, 0, len(item.Tasks))
	ends := make([]string, 0, len(item.Tasks))
	item.TaskCount = len(item.Tasks)
	item.CompletedTaskCount = 0
	for index := range item.Tasks {
		task := &item.Tasks[index]
		statuses = append(statuses, task.Status)
		if task.Status == StatusCompleted {
			item.CompletedTaskCount++
		}
		task.SpanDays = SpanDays(task.StartDate, task.EndDate)
		if task.StartDate != nil {
			starts = append(starts, *task.StartDate)
		}
		if task.EndDate != nil {
			ends = append(ends, *task.EndDate)
		}
		if task.Contents == nil {
			task.Contents = []Content{}
		}
		if task.Attachments == nil {
			task.Attachments = []Attachment{}
		}
	}
	item.Status = AggregateStatus(statuses)
	item.ScheduleStart = minDate(starts)
	item.ScheduleEnd = maxDate(ends)
	item.ScheduleDays = SpanDays(item.ScheduleStart, item.ScheduleEnd)
}

func minDate(values []string) *string {
	if len(values) == 0 {
		return nil
	}
	value := values[0]
	for _, current := range values[1:] {
		if current < value {
			value = current
		}
	}
	return &value
}

func maxDate(values []string) *string {
	if len(values) == 0 {
		return nil
	}
	value := values[0]
	for _, current := range values[1:] {
		if current > value {
			value = current
		}
	}
	return &value
}

func ValidateAttachmentKey(value *string) error {
	if value == nil {
		return nil
	}
	normalized := strings.TrimSpace(*value)
	if normalized == "" || ValidDocumentKeys[normalized] {
		return nil
	}
	return errors.New("固定文档键不在白名单内")
}
