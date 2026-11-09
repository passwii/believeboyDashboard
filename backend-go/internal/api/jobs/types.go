package jobs

import (
	"errors"
	"fmt"
	"net/http"
)

type CreateRequest struct {
	JobType string         `json:"job_type"`
	FileID  string         `json:"file_id"`
	Params  map[string]any `json:"params"`
}

type CreateInput struct {
	JobType string
	FileID  string
	Params  map[string]any
}

type Job struct {
	ID          int64          `json:"id"`
	JobType     string         `json:"job_type"`
	Status      string         `json:"status"`
	PayloadJSON map[string]any `json:"payload_json"`
	Operator    *string        `json:"operator"`
	CreatedAt   *string        `json:"created_at"`
	UpdatedAt   *string        `json:"updated_at"`
}

type JobRun struct {
	ID           int64   `json:"id"`
	StartedAt    *string `json:"started_at"`
	FinishedAt   *string `json:"finished_at"`
	Operator     *string `json:"operator"`
	LogExcerpt   *string `json:"log_excerpt"`
	ErrorMessage *string `json:"error_message"`
	ResultPath   *string `json:"result_path"`
}

type Detail struct {
	Job
	Runs []JobRun `json:"runs"`
}

type APIError struct {
	Status int
	Detail string
}

func (err *APIError) Error() string {
	return err.Detail
}

func NewAPIError(status int, detail string) error {
	return &APIError{Status: status, Detail: detail}
}

func ErrEnqueuerNotConfigured() error {
	return errors.New("job enqueuer is not configured")
}

func ErrJobNotFound(jobID int64) error {
	return NewAPIError(http.StatusNotFound, fmt.Sprintf("Job %d not found", jobID))
}
