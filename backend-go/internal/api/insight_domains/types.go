package insight_domains

import (
	"context"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_insight"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/insight_runs"
)

const ModuleName = "insight_domains"

type Store interface {
	VerifyProjectAccess(ctx context.Context, projectID int64, operator string, isAdmin bool) (ai_insight.ProjectInfo, error)
	CreateAdAnalysisRun(ctx context.Context, input AdAnalysisInput, meta ai_insight.MutationMeta) (*insight_runs.Run, bool, error)
	CreateInventoryHealthRun(ctx context.Context, input InventoryHealthInput, meta ai_insight.MutationMeta) (*insight_runs.Run, bool, error)
	RetryRun(ctx context.Context, runID string, meta ai_insight.MutationMeta) (*insight_runs.Run, error)
	RunTransition(ctx context.Context, runID string, attempt int, target string, stage string, progress int, usage *insight_runs.Usage, outputs map[string]insight_runs.Output, content *string, runErr *insight_runs.Error) (bool, error)
}

type AdAnalysisRequest struct {
	ProjectID int64   `json:"project_id"`
	Country   string  `json:"country"`
	StartDate string  `json:"start_date"`
	EndDate   string  `json:"end_date"`
	ModelID   *string `json:"model_id"`
}

type InventoryHealthRequest struct {
	ProjectID  int64   `json:"project_id"`
	Country    string  `json:"country"`
	ReportDate *string `json:"report_date"`
	ModelID    *string `json:"model_id"`
}

type AdAnalysisInput struct {
	ProjectID int64
	Country   string
	StartDate time.Time
	EndDate   time.Time
	ModelID   *string
	Operator  string
}

type InventoryHealthInput struct {
	ProjectID  int64
	Country    string
	ReportDate *time.Time
	ModelID    *string
	Operator   string
}

type Config struct {
	CanonicalDomains string
}
