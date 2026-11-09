package ai_insight

import (
	"context"
)

type Store interface {
	VerifyProjectAccess(ctx context.Context, projectID int64, operator string, isAdmin bool) (ProjectInfo, error)
	AccessibleProjectIDs(ctx context.Context, operator string, isAdmin bool) ([]int64, error)

	ListInsights(ctx context.Context, filter ListFilter) ([]InsightItem, int, error)
	GetInsight(ctx context.Context, insightID int64) (*InsightDetail, error)
	GetLatestInsight(ctx context.Context, projectID int64, country string) (*InsightDetail, error)
	CreateInsight(ctx context.Context, input CreateInsightInput) (*InsightDetail, error)
	UpdateInsightContent(ctx context.Context, insightID int64, input UpdateInsightInput) (*InsightDetail, error)
	DeleteInsight(ctx context.Context, insightID int64, operator string, isAdmin bool, meta MutationMeta) (bool, error)
	ResetInsightForRetry(ctx context.Context, insightID int64, operator string, isAdmin bool, meta MutationMeta) (*InsightDetail, error)
	GetInsightStatus(ctx context.Context, insightID int64) (*InsightStatusSnapshot, error)

	ListSchedules(ctx context.Context, filter ScheduleFilter) ([]Schedule, error)
	GetSchedule(ctx context.Context, scheduleID int64) (*Schedule, error)
	CreateSchedule(ctx context.Context, input CreateScheduleInput) (*Schedule, error)
	UpdateSchedule(ctx context.Context, scheduleID int64, input UpdateScheduleInput) (*Schedule, error)
	DeleteSchedule(ctx context.Context, scheduleID int64, operator string, isAdmin bool, meta MutationMeta) (bool, error)
	ToggleSchedule(ctx context.Context, scheduleID int64, operator string, isAdmin bool, meta MutationMeta) (*Schedule, error)
	RunScheduleNow(ctx context.Context, scheduleID int64, operator string, isAdmin bool, meta MutationMeta) (*RunScheduleResult, error)
	FailScheduleRun(ctx context.Context, scheduleID, insightID int64, message string) error

	ListAdAgentRuns(ctx context.Context, projectID *int64, limit int) ([]AdAgentRun, error)

	LoadGenerationContext(ctx context.Context, insightID int64) (*GenerationContext, error)
	SetGenerationStatus(ctx context.Context, insightID int64, status, subStatus string) error
	CompleteGeneration(ctx context.Context, insightID int64, title, content string) error
	FailGeneration(ctx context.Context, insightID int64, message string) error
}
