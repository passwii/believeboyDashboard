package project_goals

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

var (
	ErrGoalNotFound    = errors.New("goal not found")
	ErrGoalConflict    = errors.New("goal conflict")
	ErrProjectNotFound = errors.New("project not found")
	ErrProjectForbidden = errors.New("project forbidden")
)

type ProjectGoalItem struct {
	ID           int64   `json:"id"`
	ProjectID    int64   `json:"project_id"`
	Country      string  `json:"country"`
	GoalType     string  `json:"goal_type"`
	MetricType   string  `json:"metric_type"`
	PeriodYear   int     `json:"period_year"`
	PeriodMonth  *int    `json:"period_month"`
	TargetAmount float64 `json:"target_amount"`
	Currency     string  `json:"currency"`
	CreatedAt    string  `json:"created_at"`
	UpdatedAt    string  `json:"updated_at"`
}

type ProjectGoalCreate struct {
	ProjectID    int64   `json:"project_id"`
	Country      string  `json:"country"`
	GoalType     string  `json:"goal_type"`
	MetricType   string  `json:"metric_type"`
	PeriodYear   int     `json:"period_year"`
	PeriodMonth  *int    `json:"period_month"`
	TargetAmount float64 `json:"target_amount"`
}

type ProjectGoalUpdate struct {
	TargetAmount float64 `json:"target_amount"`
}

type MonthlyProgressItem struct {
	Year                  int     `json:"year"`
	Month                 int     `json:"month"`
	MonthLabel            string  `json:"month_label"`
	TargetAmount          float64 `json:"target_amount"`
	AchievedAmount        float64 `json:"achieved_amount"`
	CompletionRate        float64 `json:"completion_rate"`
	DaysInMonth           int     `json:"days_in_month"`
	TodayDay              int     `json:"today_day"`
	DailyTarget           float64 `json:"daily_target"`
	CumulativeDailyTarget float64 `json:"cumulative_daily_target"`
	CompletionVsDaily     float64 `json:"completion_vs_daily"`
	CompletionVsMonthly   float64 `json:"completion_vs_monthly"`
	Currency              string  `json:"currency"`
}

type AnnualProgressItem struct {
	Year           int     `json:"year"`
	TargetAmount   float64 `json:"target_amount"`
	AchievedAmount float64 `json:"achieved_amount"`
	CompletionRate float64 `json:"completion_rate"`
	Currency       string  `json:"currency"`
}

type ProjectGoalProgressResponse struct {
	ProjectID       int64                 `json:"project_id"`
	Country         string                `json:"country"`
	Year            int                   `json:"year"`
	Currency        string                `json:"currency"`
	MonthlyProgress []MonthlyProgressItem `json:"monthly_progress"`
	AnnualProgress  *AnnualProgressItem   `json:"annual_progress"`
}

type ProjectGoalListResponse struct {
	Goals []ProjectGoalItem `json:"goals"`
	Total int               `json:"total"`
}

type Store interface {
	VerifyProjectAccess(ctx context.Context, projectID int64, operator string, isAdmin bool) error
	ListGoals(ctx context.Context, projectID int64, country string, year int, goalType *string, metricType *string) ([]ProjectGoalItem, error)
	GetGoal(ctx context.Context, goalID int64) (*ProjectGoalItem, error)
	CreateGoal(ctx context.Context, input ProjectGoalCreate) (*ProjectGoalItem, error)
	UpdateGoal(ctx context.Context, goalID int64, targetAmount float64) (*ProjectGoalItem, error)
	DeleteGoal(ctx context.Context, goalID int64) (bool, error)
	GetProgress(ctx context.Context, projectID int64, country string, year int, metricType string) (*ProjectGoalProgressResponse, error)
}

type TransactionRunner interface {
	RunInTx(ctx context.Context, fn func(context.Context, pgx.Tx, Store) error) error
}
