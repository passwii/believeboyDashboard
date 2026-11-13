package autoreport

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// GatewayError is a non-2xx response from the gateway.
type GatewayError struct {
	Status int
	Detail string
}

func (e *GatewayError) Error() string {
	return fmt.Sprintf("gateway returned %d: %s", e.Status, e.Detail)
}

// ProjectMatch mirrors both upload modules' project matching summary.
type ProjectMatch struct {
	Status      string   `json:"status"`
	ProjectName *string  `json:"project_name"`
	Candidates  []string `json:"candidate_projects"`
	Message     *string  `json:"message"`
}

// Recognition is the union of both recognition responses.
type Recognition struct {
	TempFileID        string       `json:"temp_file_id"`
	OriginalFilename  string       `json:"original_filename"`
	ReportType        string       `json:"report_type"`
	ReportLabel       string       `json:"report_label"`
	Reason            string       `json:"reason"`
	Status            string       `json:"status"`
	Country           string       `json:"country"`
	DetectedDate      *string      `json:"detected_report_date"`
	DetectedStartDate *string      `json:"detected_start_date"`
	DetectedEndDate   *string      `json:"detected_end_date"`
	ProjectMatch      ProjectMatch `json:"project_match"`
	Warnings          []string     `json:"warnings"`
}

// CommitResult normalises both commit responses.
type CommitResult struct {
	ReportType   string   `json:"report_type"`
	ProjectName  *string  `json:"project_name"`
	Country      string   `json:"country"`
	FileID       string   `json:"file_id"`
	Message      string   `json:"message"`
	RowsIngested *int     `json:"rows_ingested"`
	Warnings     []string `json:"-"`
}

// DuplicateWarning reports an existing upload covering the same period.
type DuplicateWarning struct {
	ProjectName      string  `json:"project_name"`
	ReportType       string  `json:"report_type"`
	Country          string  `json:"country"`
	Period           string  `json:"period"`
	OriginalFilename *string `json:"original_filename"`
}

// Client talks to the gateway upload endpoints.
type Client struct {
	BaseURL        string
	APIKey         string
	ProxySecret    string
	Operator       string
	Admin          bool
	HTTP           *http.Client
	MaxUploadBytes int64
}

// NewClient builds a client from the watcher config.
func NewClient(c Config) *Client {
	return &Client{
		BaseURL:        strings.TrimRight(c.BaseURL, "/"),
		APIKey:         c.APIKey,
		ProxySecret:    c.TrustedProxySecret,
		Operator:       c.Operator,
		Admin:          c.Admin,
		HTTP:           &http.Client{Timeout: c.RequestTimeout},
		MaxUploadBytes: 50 << 20,
	}
}

func (c *Client) headers(req *http.Request) {
	req.Header.Set("X-API-Key", c.APIKey)
	if c.ProxySecret != "" {
		req.Header.Set("X-Trusted-Proxy-Secret", c.ProxySecret)
	}
	req.Header.Set("X-Operator", c.Operator)
	if c.Admin {
		req.Header.Set("X-Is-Admin", "true")
	}
}

// RecognizeAd uploads the file to /api/v1/ad-upload/recognize.
func (c *Client) RecognizeAd(ctx context.Context, path, country string) (*Recognition, error) {
	return c.recognize(ctx, "/api/v1/ad-upload/recognize", path, country)
}

// RecognizeReport uploads the file to /api/v1/report-upload/recognize.
func (c *Client) RecognizeReport(ctx context.Context, path, country string) (*Recognition, error) {
	return c.recognize(ctx, "/api/v1/report-upload/recognize", path, country)
}

func (c *Client) recognize(ctx context.Context, endpoint, path, country string) (*Recognition, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if info.Size() > c.MaxUploadBytes {
		return nil, fmt.Errorf("file %s exceeds the %d byte upload limit", filepath.Base(path), c.MaxUploadBytes)
	}

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", filepath.Base(path))
	if err != nil {
		return nil, err
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	if _, err := io.Copy(part, file); err != nil {
		file.Close()
		return nil, err
	}
	file.Close()
	if err := writer.WriteField("country", country); err != nil {
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+endpoint, &body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("Content-Length", strconv.Itoa(body.Len()))
	c.headers(req)

	response, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	payload, _ := io.ReadAll(response.Body)
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, &GatewayError{Status: response.StatusCode, Detail: detailFrom(payload)}
	}
	var recognition Recognition
	if err := json.Unmarshal(payload, &recognition); err != nil {
		return nil, fmt.Errorf("decode recognition: %w", err)
	}
	return &recognition, nil
}

// CommitAd persists a recognised ad report.
func (c *Client) CommitAd(ctx context.Context, req AdCommitRequest) (*CommitResult, error) {
	return c.commit(ctx, "/api/v1/ad-upload/commit", req)
}

// CommitReport persists a recognised generic report.
func (c *Client) CommitReport(ctx context.Context, req ReportCommitRequest) (*CommitResult, error) {
	return c.commit(ctx, "/api/v1/report-upload/commit", req)
}

// AdCommitRequest mirrors ad_upload.AdUploadCommitRequest.
type AdCommitRequest struct {
	TempFileID       string  `json:"temp_file_id"`
	ReportType       string  `json:"report_type"`
	OriginalFilename *string `json:"original_filename,omitempty"`
	ProjectName      *string `json:"project_name,omitempty"`
	Country          string  `json:"country"`
	ReportDate       *string `json:"report_date,omitempty"`
	ReportStartDate  *string `json:"report_start_date,omitempty"`
	ReportEndDate    *string `json:"report_end_date,omitempty"`
	DryRun           bool    `json:"dry_run"`
}

// ReportCommitRequest mirrors uploads.CommitRequest.
type ReportCommitRequest struct {
	TempFileID       string  `json:"temp_file_id"`
	ReportType       string  `json:"report_type"`
	OriginalFilename *string `json:"original_filename"`
	ProjectName      *string `json:"project_name"`
	ReportDate       *string `json:"report_date"`
	ReportStartDate  *string `json:"report_start_date"`
	ReportEndDate    *string `json:"report_end_date"`
	Country          string  `json:"country"`
	UsePeriodDates   bool    `json:"use_period_dates"`
	DryRun           bool    `json:"dry_run"`
}

func (c *Client) commit(ctx context.Context, endpoint string, payload any) (*CommitResult, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	c.headers(req)

	response, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(response.Body)
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, &GatewayError{Status: response.StatusCode, Detail: detailFrom(raw)}
	}
	result := &CommitResult{}
	if err := json.Unmarshal(raw, result); err != nil {
		return nil, fmt.Errorf("decode commit: %w", err)
	}
	var dupes struct {
		Warnings []DuplicateWarning `json:"duplicate_warnings"`
	}
	_ = json.Unmarshal(raw, &dupes)
	for _, warning := range dupes.Warnings {
		result.Warnings = append(result.Warnings, fmt.Sprintf(
			"duplicate: %s %s %s %s", warning.ProjectName, warning.ReportType, warning.Country, warning.Period))
	}
	return result, nil
}

func detailFrom(payload []byte) string {
	var envelope struct {
		Detail any `json:"detail"`
	}
	if err := json.Unmarshal(payload, &envelope); err == nil && envelope.Detail != nil {
		switch value := envelope.Detail.(type) {
		case string:
			return value
		default:
			encoded, _ := json.Marshal(value)
			return string(encoded)
		}
	}
	text := strings.TrimSpace(string(payload))
	if len(text) > 300 {
		text = text[:300]
	}
	return text
}
