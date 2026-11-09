package notification_settings

import (
	"time"
)

type Project struct {
	ProjectOperator   *string
	AssistantOperator *string
}

type Setting struct {
	ID          int64     `json:"id"`
	ProjectID   int64     `json:"project_id"`
	RuleName    string    `json:"rule_name"`
	Frequency   string    `json:"frequency"`
	ReportTypes []string  `json:"report_types"`
	Recipients  []string  `json:"recipients"`
	Enabled     bool      `json:"enabled"`
	CreatedBy   *int64    `json:"created_by"`
	CreatedAt   time.Time `json:"-"`
	UpdatedAt   time.Time `json:"-"`
}

type CreateRequest struct {
	ProjectID   *int64   `json:"project_id"`
	RuleName    *string  `json:"rule_name"`
	Frequency   *string  `json:"frequency"`
	ReportTypes []string `json:"report_types"`
	Recipients  []string `json:"recipients"`
	Enabled     *bool    `json:"enabled"`
}

type UpdateRequest struct {
	ID          *int64    `json:"id"`
	RuleName    *string   `json:"rule_name"`
	Frequency   *string   `json:"frequency"`
	ReportTypes *[]string `json:"report_types"`
	Recipients  *[]string `json:"recipients"`
	Enabled     *bool     `json:"enabled"`
}

type TestEmailRequest struct {
	TestRecipients *[]string `json:"test_recipients"`
}

type TestEmailResponse struct {
	Success  bool    `json:"success"`
	Message  string  `json:"message"`
	ResendID *string `json:"resend_id"`
}

type TestEmailAttempt struct {
	Fingerprint string
	Result      string
	ResendID    *string
}

type TestEmailAudit struct {
	SubscriptionID int64
	ProjectID      int64
	Recipient      string
	Frequency      string
	Fingerprint    string
	Result         string
	ResendID       *string
	Operator       *string
	TraceID        *string
	RequestMethod  *string
	RequestPath    *string
	IPAddress      *string
	UserAgent      *string
	IdempotencyKey *string
	ErrorMessage   *string
}

type listResponse struct {
	Items []settingResponse `json:"items"`
	Total int               `json:"total"`
}

type settingResponse struct {
	ID          int64    `json:"id"`
	ProjectID   int64    `json:"project_id"`
	RuleName    string   `json:"rule_name"`
	Frequency   string   `json:"frequency"`
	ReportTypes []string `json:"report_types"`
	Recipients  []string `json:"recipients"`
	Enabled     bool     `json:"enabled"`
	CreatedBy   *int64   `json:"created_by"`
	CreatedAt   string   `json:"created_at"`
	UpdatedAt   string   `json:"updated_at"`
}
