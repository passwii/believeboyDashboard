package platform_revenues

import (
	"context"
	"errors"
)

var (
	ErrRevenueNotFound  = errors.New("回款记录不存在")
	ErrRevenueForbidden = errors.New("无权限访问该回款记录")
	ErrProjectNotFound  = errors.New("项目不存在")
	ErrProjectForbidden = errors.New("无权限在该项目下创建回款")
)

type PlatformRevenueAttachment struct {
	ID         string  `json:"id"`
	Filename   string  `json:"filename"`
	URL        string  `json:"url"`
	Size       int64   `json:"size"`
	CreatedAt  string  `json:"created_at"`
	StoredPath *string `json:"stored_path,omitempty"`
	Key        *string `json:"key,omitempty"`
	ThumbURL   *string `json:"thumb_url,omitempty"`
}

type PlatformRevenueItem struct {
	ID              int64                       `json:"id"`
	ProjectID       int64                       `json:"project_id"`
	ProjectName     string                      `json:"project_name"`
	Country         string                      `json:"country"`
	ReceivedDate    string                      `json:"received_date"`
	Amount          float64                     `json:"amount"`
	Currency        string                      `json:"currency"`
	ExchangeRate    *float64                    `json:"exchange_rate"`
	RevenueType     string                      `json:"revenue_type"`
	Note            *string                     `json:"note"`
	Attachments     []PlatformRevenueAttachment `json:"attachments"`
	ScreenshotR2Key *string                     `json:"screenshot_r2_key"`
	ScreenshotR2URL *string                     `json:"screenshot_r2_url"`
	CreatedBy       string                      `json:"created_by"`
	CreatedAt       string                      `json:"created_at"`
	UpdatedAt       string                      `json:"updated_at"`
}

type PlatformRevenueListResponse struct {
	Items      []PlatformRevenueItem `json:"items"`
	Total      int                   `json:"total"`
	Page       int                   `json:"page"`
	PageSize   int                   `json:"page_size"`
	TotalPages int                   `json:"total_pages"`
}

type PlatformRevenueCreate struct {
	ProjectID       int64                       `json:"project_id"`
	Country         string                      `json:"country"`
	ReceivedDate    string                      `json:"received_date"`
	Amount          float64                     `json:"amount"`
	Currency        string                      `json:"currency"`
	ExchangeRate    *float64                    `json:"exchange_rate,omitempty"`
	RevenueType     string                      `json:"revenue_type"`
	Note            *string                     `json:"note,omitempty"`
	Attachments     []PlatformRevenueAttachment `json:"attachments"`
	ScreenshotR2Key *string                     `json:"screenshot_r2_key,omitempty"`
	ScreenshotR2URL *string                     `json:"screenshot_r2_url,omitempty"`
}

type PlatformRevenueUpdate struct {
	Country         *string                      `json:"country,omitempty"`
	ReceivedDate    *string                      `json:"received_date,omitempty"`
	Amount          *float64                     `json:"amount,omitempty"`
	Currency        *string                      `json:"currency,omitempty"`
	ExchangeRate    *float64                     `json:"exchange_rate,omitempty"`
	RevenueType     *string                      `json:"revenue_type,omitempty"`
	Note            *string                      `json:"note,omitempty"`
	Attachments     *[]PlatformRevenueAttachment `json:"attachments,omitempty"`
	ScreenshotR2Key *string                      `json:"screenshot_r2_key,omitempty"`
	ScreenshotR2URL *string                      `json:"screenshot_r2_url,omitempty"`
}

type PlatformRevenueFilter struct {
	ProjectID int64
	Year      int
	Month     int
	Country   string
	Currency  string
	Page      int
	PageSize  int
	Operator  string
	IsAdmin   bool
}

type UploadImageResponse struct {
	ID        string `json:"id"`
	URL       string `json:"url"`
	ThumbURL  string `json:"thumb_url"`
	Key       string `json:"key"`
	Filename  string `json:"filename"`
	Size      int64  `json:"size"`
	CreatedAt string `json:"created_at"`
}

type ProjectCountriesResponse struct {
	Countries []string `json:"countries"`
}

type Store interface {
	VerifyProjectAccess(ctx context.Context, projectID int64, operator string, isAdmin bool) error
	AccessibleProjectIDs(ctx context.Context, operator string) ([]int64, error)
	ListRevenues(ctx context.Context, filter PlatformRevenueFilter) ([]PlatformRevenueItem, int, error)
	GetRevenue(ctx context.Context, revenueID int64, operator string, isAdmin bool) (*PlatformRevenueItem, error)
	CreateRevenue(ctx context.Context, payload PlatformRevenueCreate, operator string, isAdmin bool) (*PlatformRevenueItem, error)
	UpdateRevenue(ctx context.Context, revenueID int64, payload PlatformRevenueUpdate, operator string, isAdmin bool) (*PlatformRevenueItem, error)
	DeleteRevenue(ctx context.Context, revenueID int64, operator string, isAdmin bool) error
	GetProjectCountries(ctx context.Context, projectID int64) ([]string, error)
	SavePaymentScreenshot(ctx context.Context, projectName string, filename string, contentType string, data []byte) (*UploadImageResponse, error)
}
