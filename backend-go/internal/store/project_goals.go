package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/project_goals"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type ProjectGoalStore struct {
	db FullDB
}

func NewProjectGoalStore(db FullDB) *ProjectGoalStore {
	return &ProjectGoalStore{db: db}
}

func (s *ProjectGoalStore) RunInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, project_goals.Store) error,
) error {
	return RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txStore := &ProjectGoalStore{db: NewTxDB(tx)}
		return fn(ctx, tx, txStore)
	})
}

func (s *ProjectGoalStore) VerifyProjectAccess(
	ctx context.Context,
	projectID int64,
	operator string,
	isAdmin bool,
) error {
	if isAdmin {
		return nil
	}
	var projOp, asstOp *string
	err := s.db.QueryRow(
		ctx,
		`select project_operator, assistant_operator from public.projects where id = $1`,
		projectID,
	).Scan(&projOp, &asstOp)
	if errors.Is(err, pgx.ErrNoRows) {
		return project_goals.ErrProjectNotFound
	}
	if err != nil {
		return err
	}
	operator = strings.TrimSpace(operator)
	if operator == "" {
		return project_goals.ErrProjectForbidden
	}
	if textContainsName(projOp, operator) || textContainsName(asstOp, operator) {
		return nil
	}
	return project_goals.ErrProjectForbidden
}

const projectGoalSelectColumns = `
	id, project_id, country, goal_type, metric_type, period_year,
	period_month, target_amount, created_at, updated_at`

func (s *ProjectGoalStore) ListGoals(
	ctx context.Context,
	projectID int64,
	country string,
	year int,
	goalType *string,
	metricType *string,
) ([]project_goals.ProjectGoalItem, error) {
	country = normalizeGoalCountry(country)
	var args []any
	args = append(args, projectID, country, year)

	where := `where project_id = $1 and country = $2 and period_year = $3`
	if goalType != nil && *goalType != "" {
		args = append(args, *goalType)
		where += fmt.Sprintf(` and goal_type = $%d`, len(args))
	}
	if metricType != nil && *metricType != "" {
		args = append(args, *metricType)
		where += fmt.Sprintf(` and metric_type = $%d`, len(args))
	}

	sql := `select ` + projectGoalSelectColumns + `
	        from public.project_goals
	        ` + where + `
	        order by goal_type asc, period_month asc nulls last`

	rows, err := s.db.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]project_goals.ProjectGoalItem, 0)
	for rows.Next() {
		item, err := scanProjectGoalItem(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *ProjectGoalStore) GetGoal(
	ctx context.Context,
	goalID int64,
) (*project_goals.ProjectGoalItem, error) {
	row := s.db.QueryRow(
		ctx,
		`select `+projectGoalSelectColumns+`
		 from public.project_goals
		 where id = $1
		 limit 1`,
		goalID,
	)
	item, err := scanProjectGoalItem(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (s *ProjectGoalStore) CreateGoal(
	ctx context.Context,
	input project_goals.ProjectGoalCreate,
) (*project_goals.ProjectGoalItem, error) {
	country := normalizeGoalCountry(input.Country)
	row := s.db.QueryRow(
		ctx,
		`insert into public.project_goals (
		   project_id, country, goal_type, metric_type, period_year,
		   period_month, target_amount, created_at, updated_at
		 )
		 values ($1, $2, $3, $4, $5, $6, $7, now(), now())
		 returning `+projectGoalSelectColumns,
		input.ProjectID,
		country,
		input.GoalType,
		input.MetricType,
		input.PeriodYear,
		input.PeriodMonth,
		input.TargetAmount,
	)
	item, err := scanProjectGoalItem(row)
	if err != nil {
		if isGoalUniqueConflict(err) {
			return nil, project_goals.ErrGoalConflict
		}
		return nil, err
	}
	return &item, nil
}

func (s *ProjectGoalStore) UpdateGoal(
	ctx context.Context,
	goalID int64,
	targetAmount float64,
) (*project_goals.ProjectGoalItem, error) {
	row := s.db.QueryRow(
		ctx,
		`update public.project_goals
		 set target_amount = $1,
		     updated_at = now()
		 where id = $2
		 returning `+projectGoalSelectColumns,
		targetAmount,
		goalID,
	)
	item, err := scanProjectGoalItem(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, project_goals.ErrGoalNotFound
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (s *ProjectGoalStore) DeleteGoal(
	ctx context.Context,
	goalID int64,
) (bool, error) {
	execer, ok := s.db.(Execer)
	if !ok {
		return false, errors.New("database does not support Exec")
	}
	tag, err := execer.Exec(ctx, `delete from public.project_goals where id = $1`, goalID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

func (s *ProjectGoalStore) GetProgress(
	ctx context.Context,
	projectID int64,
	country string,
	year int,
	metricType string,
) (*project_goals.ProjectGoalProgressResponse, error) {
	country = normalizeGoalCountry(country)
	currency := goalCurrency(country)

	var projName string
	err := s.db.QueryRow(ctx, `select project_name from public.projects where id = $1`, projectID).Scan(&projName)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, project_goals.ErrProjectNotFound
	}
	if err != nil {
		return nil, err
	}

	goals, err := s.ListGoals(ctx, projectID, country, year, nil, &metricType)
	if err != nil {
		return nil, err
	}

	monthlyGoalMap := make(map[int]float64)
	var annualGoal *float64
	for _, g := range goals {
		if g.GoalType == "monthly" && g.PeriodMonth != nil {
			monthlyGoalMap[*g.PeriodMonth] = g.TargetAmount
		} else if g.GoalType == "annual" {
			a := g.TargetAmount
			annualGoal = &a
		}
	}

	todayYear, todayMonth, todayDay := getTodayInCountryTimezone(country)

	startDate := time.Date(year, 1, 1, 0, 0, 0, 0, time.UTC)
	endDate := time.Date(year, 12, 31, 23, 59, 59, 0, time.UTC)

	salesRows, err := s.db.Query(
		ctx,
		`select
		   extract(month from purchase_date_pt)::int as m,
		   coalesce(sum(
		     case
		       when upper(country) in ('DE', 'UK') then
		         coalesce(item_price, 0) + coalesce(shipping_price, 0) + coalesce(item_tax, 0) + coalesce(shipping_tax, 0)
		       else
		         coalesce(item_price, 0) + coalesce(shipping_price, 0)
		     end
		   ), 0) as sales
		 from public.analysis_sales_order_rows
		 where project_id = $1
		   and country = $2
		   and purchase_date_pt >= $3
		   and purchase_date_pt <= $4
		   and is_counted_sales = true
		   and order_status != 'Cancelled'
		 group by extract(month from purchase_date_pt)`,
		projectID,
		country,
		startDate,
		endDate,
	)
	if err != nil {
		return nil, err
	}
	defer salesRows.Close()

	monthlySalesMap := make(map[int]float64)
	var annualAchieved float64
	for salesRows.Next() {
		var m int
		var sAmount float64
		if err := salesRows.Scan(&m, &sAmount); err != nil {
			return nil, err
		}
		monthlySalesMap[m] = sAmount
		annualAchieved += sAmount
	}
	if err := salesRows.Err(); err != nil {
		return nil, err
	}

	monthlyProgress := make([]project_goals.MonthlyProgressItem, 0, 12)
	for month := 1; month <= 12; month++ {
		target := monthlyGoalMap[month]
		achieved := monthlySalesMap[month]
		daysInM := daysInMonth(year, month)

		td := 0
		if todayYear == year && todayMonth == month {
			td = todayDay
		}

		dailyTarget := 0.0
		if target > 0 && daysInM > 0 {
			dailyTarget = target / float64(daysInM)
		}
		cumulativeDailyTarget := dailyTarget * float64(td)

		completionVsMonthly := 0.0
		if target > 0 {
			completionVsMonthly = achieved / target
		}

		completionVsDaily := 0.0
		if cumulativeDailyTarget > 0 {
			completionVsDaily = achieved / cumulativeDailyTarget
		}

		monthLabel := fmt.Sprintf("%d年%d月", year, month)

		monthlyProgress = append(monthlyProgress, project_goals.MonthlyProgressItem{
			Year:                  year,
			Month:                 month,
			MonthLabel:            monthLabel,
			TargetAmount:          target,
			AchievedAmount:        achieved,
			CompletionRate:        completionVsMonthly,
			DaysInMonth:           daysInM,
			TodayDay:              td,
			DailyTarget:           dailyTarget,
			CumulativeDailyTarget: cumulativeDailyTarget,
			CompletionVsDaily:     completionVsDaily,
			CompletionVsMonthly:   completionVsMonthly,
			Currency:              currency,
		})
	}

	var annualProgress *project_goals.AnnualProgressItem
	if annualGoal != nil {
		target := *annualGoal
		rate := 0.0
		if target > 0 {
			rate = annualAchieved / target
		}
		annualProgress = &project_goals.AnnualProgressItem{
			Year:           year,
			TargetAmount:   target,
			AchievedAmount: annualAchieved,
			CompletionRate: rate,
			Currency:       currency,
		}
	}

	return &project_goals.ProjectGoalProgressResponse{
		ProjectID:       projectID,
		Country:         country,
		Year:            year,
		Currency:        currency,
		MonthlyProgress: monthlyProgress,
		AnnualProgress:  annualProgress,
	}, nil
}

type goalScanner interface {
	Scan(dest ...any) error
}

func scanProjectGoalItem(scanner goalScanner) (project_goals.ProjectGoalItem, error) {
	var (
		item         project_goals.ProjectGoalItem
		periodMonth  pgtype.Int4
		targetAmount pgtype.Numeric
		createdAt    pgtype.Timestamptz
		updatedAt    pgtype.Timestamptz
	)
	if err := scanner.Scan(
		&item.ID,
		&item.ProjectID,
		&item.Country,
		&item.GoalType,
		&item.MetricType,
		&item.PeriodYear,
		&periodMonth,
		&targetAmount,
		&createdAt,
		&updatedAt,
	); err != nil {
		return project_goals.ProjectGoalItem{}, err
	}

	if periodMonth.Valid {
		m := int(periodMonth.Int32)
		item.PeriodMonth = &m
	}

	val, err := numericFloat64(targetAmount)
	if err != nil {
		return project_goals.ProjectGoalItem{}, err
	}
	item.TargetAmount = val
	item.Currency = goalCurrency(item.Country)
	if createdAt.Valid {
		item.CreatedAt = httpapi.Timestamp(createdAt.Time)
	}
	if updatedAt.Valid {
		item.UpdatedAt = httpapi.Timestamp(updatedAt.Time)
	}
	return item, nil
}

func isGoalUniqueConflict(err error) bool {
	if err == nil {
		return false
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return true
	}
	msg := err.Error()
	return strings.Contains(msg, "project_goals_unique_period") ||
		strings.Contains(msg, "UNIQUE constraint failed: project_goals.")
}

func normalizeGoalCountry(country string) string {
	c := strings.ToUpper(strings.TrimSpace(country))
	if c == "" {
		return "US"
	}
	if c == "GB" {
		return "UK"
	}
	return c
}

func goalCurrency(country string) string {
	switch normalizeGoalCountry(country) {
	case "DE":
		return "EUR"
	case "UK":
		return "GBP"
	default:
		return "USD"
	}
}

func daysInMonth(year, month int) int {
	return time.Date(year, time.Month(month+1), 0, 0, 0, 0, 0, time.UTC).Day()
}

func getTodayInCountryTimezone(country string) (int, int, int) {
	tzName := "America/Los_Angeles"
	switch normalizeGoalCountry(country) {
	case "DE":
		tzName = "Europe/Berlin"
	case "UK":
		tzName = "Europe/London"
	}
	loc, err := time.LoadLocation(tzName)
	if err != nil {
		loc = time.UTC
	}
	now := time.Now().In(loc)
	return now.Year(), int(now.Month()), now.Day()
}
