package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/scheduled_reports"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type ScheduledReportStore struct {
	db FullDB
}

func NewScheduledReportStore(db FullDB) *ScheduledReportStore {
	return &ScheduledReportStore{db: db}
}

func (store *ScheduledReportStore) RunInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, scheduled_reports.Store) error,
) error {
	if store == nil || store.db == nil {
		return errors.New("scheduled report database is not configured")
	}
	return RunInTx(ctx, store.db, func(tx pgx.Tx) error {
		txStore := &ScheduledReportStore{db: NewTxDB(tx)}
		return fn(ctx, tx, txStore)
	})
}

func (store *ScheduledReportStore) VerifyProjectAccess(
	ctx context.Context,
	projectID int64,
	operator string,
	isAdmin bool,
) error {
	if isAdmin {
		return nil
	}
	if store == nil || store.db == nil {
		return errors.New("scheduled report database is not configured")
	}
	var projectOperator, assistantOperator *string
	err := store.db.QueryRow(
		ctx,
		`select project_operator, assistant_operator from public.projects where id = $1`,
		projectID,
	).Scan(&projectOperator, &assistantOperator)
	if errors.Is(err, pgx.ErrNoRows) {
		return scheduled_reports.ErrProjectNotFound
	}
	if err != nil {
		return err
	}
	operator = strings.TrimSpace(operator)
	if operator == "" {
		return scheduled_reports.ErrProjectForbidden
	}
	if scheduledContainsOperator(projectOperator, operator) || scheduledContainsOperator(assistantOperator, operator) {
		return nil
	}
	return scheduled_reports.ErrProjectForbidden
}

func scheduledContainsOperator(value *string, target string) bool {
	target = strings.TrimSpace(target)
	if target == "" || value == nil {
		return false
	}
	separator := func(r rune) bool {
		switch r {
		case ',', '、', '，', ';', '\n', '\r', '\t', ' ':
			return true
		default:
			return false
		}
	}
	for _, name := range strings.FieldsFunc(*value, separator) {
		if strings.TrimSpace(name) == target {
			return true
		}
	}
	return false
}

const scheduledReportSubscriptionColumns = `
	id, user_id, email, project_ids, country, frequency,
	dispatch_hour, dispatch_minute, dispatch_weekday, dispatch_day,
	ai_model, enabled, created_at, updated_at`

func (store *ScheduledReportStore) ListSubscriptions(
	ctx context.Context,
	scope scheduled_reports.Scope,
	frequency *string,
) ([]scheduled_reports.Subscription, error) {
	if store == nil || store.db == nil {
		return nil, errors.New("scheduled report database is not configured")
	}
	args := make([]any, 0, 2)
	where := ""
	if !scope.IsAdmin {
		if scope.UserID == nil {
			return []scheduled_reports.Subscription{}, nil
		}
		args = append(args, *scope.UserID)
		where = fmt.Sprintf(" where user_id = $%d", len(args))
	}
	if frequency != nil && strings.TrimSpace(*frequency) != "" {
		args = append(args, strings.TrimSpace(*frequency))
		if where == "" {
			where = fmt.Sprintf(" where frequency = $%d", len(args))
		} else {
			where += fmt.Sprintf(" and frequency = $%d", len(args))
		}
	}
	query := `select ` + scheduledReportSubscriptionColumns + `
		from public.scheduled_report_subscriptions` + where + `
		order by created_at desc, id desc`
	rows, err := store.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	subscriptions := make([]scheduled_reports.Subscription, 0)
	for rows.Next() {
		subscription, err := scanScheduledReportSubscription(rows)
		if err != nil {
			return nil, err
		}
		subscriptions = append(subscriptions, subscription)
	}
	return subscriptions, rows.Err()
}

func (store *ScheduledReportStore) GetSubscription(
	ctx context.Context,
	subscriptionID int64,
) (*scheduled_reports.Subscription, error) {
	if store == nil || store.db == nil {
		return nil, errors.New("scheduled report database is not configured")
	}
	subscription, err := scanScheduledReportSubscription(store.db.QueryRow(
		ctx,
		`select `+scheduledReportSubscriptionColumns+`
		 from public.scheduled_report_subscriptions
		 where id = $1
		 limit 1`,
		subscriptionID,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &subscription, nil
}

func (store *ScheduledReportStore) CreateSubscription(
	ctx context.Context,
	input scheduled_reports.SubscriptionCreateInput,
) (*scheduled_reports.Subscription, error) {
	if store == nil || store.db == nil {
		return nil, errors.New("scheduled report database is not configured")
	}
	subscription, err := scanScheduledReportSubscription(store.db.QueryRow(
		ctx,
		`insert into public.scheduled_report_subscriptions (
		   user_id, email, project_ids, country, frequency,
		   dispatch_hour, dispatch_minute, dispatch_weekday, dispatch_day,
		   ai_model, enabled, created_at, updated_at
		 ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, now(), now())
		 returning `+scheduledReportSubscriptionColumns,
		input.UserID,
		input.Email,
		input.ProjectIDs,
		input.Country,
		input.Frequency,
		input.DispatchHour,
		input.DispatchMinute,
		input.DispatchWeekday,
		input.DispatchDay,
		input.AIModel,
	))
	if err != nil {
		return nil, err
	}
	return &subscription, nil
}

func (store *ScheduledReportStore) UpdateSubscription(
	ctx context.Context,
	subscriptionID int64,
	patch scheduled_reports.SubscriptionPatch,
) (*scheduled_reports.Subscription, error) {
	if store == nil || store.db == nil {
		return nil, errors.New("scheduled report database is not configured")
	}
	args := []any{subscriptionID}
	sets := make([]string, 0, 10)
	if patch.Email.Set {
		args = append(args, optionalStringArgument(patch.Email.Value))
		sets = append(sets, fmt.Sprintf("email = $%d", len(args)))
	}
	if patch.ProjectIDs.Set && patch.ProjectIDs.Value != nil {
		args = append(args, *patch.ProjectIDs.Value)
		sets = append(sets, fmt.Sprintf("project_ids = $%d", len(args)))
	}
	if patch.Country.Set && patch.Country.Value != nil {
		args = append(args, *patch.Country.Value)
		sets = append(sets, fmt.Sprintf("country = $%d", len(args)))
	}
	if patch.Frequency.Set && patch.Frequency.Value != nil {
		args = append(args, *patch.Frequency.Value)
		sets = append(sets, fmt.Sprintf("frequency = $%d", len(args)))
	}
	if patch.DispatchHour.Set && patch.DispatchHour.Value != nil {
		args = append(args, *patch.DispatchHour.Value)
		sets = append(sets, fmt.Sprintf("dispatch_hour = $%d", len(args)))
	}
	if patch.DispatchMinute.Set && patch.DispatchMinute.Value != nil {
		args = append(args, *patch.DispatchMinute.Value)
		sets = append(sets, fmt.Sprintf("dispatch_minute = $%d", len(args)))
	}
	if patch.DispatchWeekday.Set {
		args = append(args, patch.DispatchWeekday.Value)
		sets = append(sets, fmt.Sprintf("dispatch_weekday = $%d", len(args)))
	}
	if patch.DispatchDay.Set {
		args = append(args, patch.DispatchDay.Value)
		sets = append(sets, fmt.Sprintf("dispatch_day = $%d", len(args)))
	}
	if patch.AIModel.Set {
		args = append(args, optionalStringArgument(patch.AIModel.Value))
		sets = append(sets, fmt.Sprintf("ai_model = $%d", len(args)))
	}
	if patch.Enabled.Set && patch.Enabled.Value != nil {
		args = append(args, *patch.Enabled.Value)
		sets = append(sets, fmt.Sprintf("enabled = $%d", len(args)))
	}
	if len(sets) == 0 {
		return store.GetSubscription(ctx, subscriptionID)
	}
	sets = append(sets, "updated_at = now()")
	query := `update public.scheduled_report_subscriptions
		set ` + strings.Join(sets, ", ") + `
		where id = $1
		returning ` + scheduledReportSubscriptionColumns
	subscription, err := scanScheduledReportSubscription(store.db.QueryRow(ctx, query, args...))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &subscription, nil
}

func (store *ScheduledReportStore) DeleteSubscription(
	ctx context.Context,
	subscriptionID int64,
) (bool, error) {
	if store == nil || store.db == nil {
		return false, errors.New("scheduled report database is not configured")
	}
	tag, err := store.db.Exec(
		ctx,
		`delete from public.scheduled_report_subscriptions where id = $1`,
		subscriptionID,
	)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

func (store *ScheduledReportStore) ListActiveSubscriptions(
	ctx context.Context,
	frequency string,
) ([]scheduled_reports.Subscription, error) {
	if store == nil || store.db == nil {
		return nil, errors.New("scheduled report database is not configured")
	}
	args := make([]any, 0, 1)
	where := " where enabled = true"
	if strings.TrimSpace(frequency) != "" && frequency != "all" {
		args = append(args, strings.TrimSpace(frequency))
		where += fmt.Sprintf(" and frequency = $%d", len(args))
	}
	rows, err := store.db.Query(
		ctx,
		`select `+scheduledReportSubscriptionColumns+`
		 from public.scheduled_report_subscriptions`+where+`
		 order by id asc`,
		args...,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	subscriptions := make([]scheduled_reports.Subscription, 0)
	for rows.Next() {
		subscription, err := scanScheduledReportSubscription(rows)
		if err != nil {
			return nil, err
		}
		subscriptions = append(subscriptions, subscription)
	}
	return subscriptions, rows.Err()
}

const scheduledReportDeliveryLogColumns = `
	id, subscription_id, frequency, report_date, report_month, email,
	status, error_message, sent_at,
	screenshot_r2_key, screenshot_r2_url,
	screenshot_r2_thumb_key, screenshot_r2_thumb_url,
	ai_summary, ai_summary_status, ai_summary_error, ai_summary_model,
	insight_run_id, ai_summary_updated_at, stage, created_at`

// ListDueSubscriptions returns the enabled subscriptions whose dispatch hour,
// minute and day match now in the supplied location.
func (store *ScheduledReportStore) ListDueSubscriptions(
	ctx context.Context,
	now time.Time,
	location *time.Location,
) ([]scheduled_reports.Subscription, error) {
	if location == nil {
		location = time.UTC
	}
	subscriptions, err := store.ListActiveSubscriptions(ctx, "all")
	if err != nil {
		return nil, err
	}
	return filterDueSubscriptions(subscriptions, now.In(location)), nil
}

// filterDueSubscriptions keeps enabled subscriptions whose dispatch hour and
// minute match local and whose frequency-specific day rule matches too.
func filterDueSubscriptions(
	subscriptions []scheduled_reports.Subscription,
	local time.Time,
) []scheduled_reports.Subscription {
	due := make([]scheduled_reports.Subscription, 0, len(subscriptions))
	for _, subscription := range subscriptions {
		if subscription.DispatchHour != local.Hour() || subscription.DispatchMinute != local.Minute() {
			continue
		}
		if !subscriptionMatchesDate(subscription, local) {
			continue
		}
		due = append(due, subscription)
	}
	return due
}

func (store *ScheduledReportStore) ListDeliveryLogs(
	ctx context.Context,
	scope scheduled_reports.Scope,
	status *string,
	limit int,
	offset int,
) (scheduled_reports.DeliveryLogListResponse, error) {
	if store == nil || store.db == nil {
		return scheduled_reports.DeliveryLogListResponse{}, errors.New("scheduled report database is not configured")
	}
	args := make([]any, 0, 3)
	where := ""
	if !scope.IsAdmin {
		if scope.UserID == nil {
			return scheduled_reports.DeliveryLogListResponse{Items: []scheduled_reports.DeliveryLog{}}, nil
		}
		args = append(args, *scope.UserID)
		where = fmt.Sprintf(` where subscription_id in (
			select id from public.scheduled_report_subscriptions where user_id = $%d
		)`, len(args))
	}
	if status != nil && strings.TrimSpace(*status) != "" {
		args = append(args, strings.TrimSpace(*status))
		if where == "" {
			where = fmt.Sprintf(" where status = $%d", len(args))
		} else {
			where += fmt.Sprintf(" and status = $%d", len(args))
		}
	}
	args = append(args, limit, offset)
	limitPlaceholder := len(args) - 1
	offsetPlaceholder := len(args)
	rows, err := store.db.Query(
		ctx,
		`select `+scheduledReportDeliveryLogColumns+`
		 from public.scheduled_report_delivery_logs`+where+`
		 order by created_at desc, id desc
		 limit $`+fmt.Sprintf("%d", limitPlaceholder)+` offset $`+fmt.Sprintf("%d", offsetPlaceholder),
		args...,
	)
	if err != nil {
		return scheduled_reports.DeliveryLogListResponse{}, err
	}
	defer rows.Close()
	items := make([]scheduled_reports.DeliveryLog, 0)
	for rows.Next() {
		item, err := scanScheduledReportDeliveryLog(rows)
		if err != nil {
			return scheduled_reports.DeliveryLogListResponse{}, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return scheduled_reports.DeliveryLogListResponse{}, err
	}

	countQuery := `select count(*) from public.scheduled_report_delivery_logs` + where
	countArgs := args[:len(args)-2]
	var total int
	if err := store.db.QueryRow(ctx, countQuery, countArgs...).Scan(&total); err != nil {
		return scheduled_reports.DeliveryLogListResponse{}, err
	}
	return scheduled_reports.DeliveryLogListResponse{Items: items, Total: total}, nil
}

func (store *ScheduledReportStore) RefreshLedger(
	ctx context.Context,
	query scheduled_reports.LedgerQuery,
) (scheduled_reports.LedgerListResponse, error) {
	if store == nil || store.db == nil {
		return scheduled_reports.LedgerListResponse{}, errors.New("scheduled report database is not configured")
	}
	err := RunInTx(ctx, store.db, func(tx pgx.Tx) error {
		txStore := &ScheduledReportStore{db: NewTxDB(tx)}
		return txStore.refreshLedgerTx(ctx, query)
	})
	if err != nil {
		return scheduled_reports.LedgerListResponse{}, err
	}
	return store.queryLedger(ctx, query)
}

func (store *ScheduledReportStore) refreshLedgerTx(
	ctx context.Context,
	query scheduled_reports.LedgerQuery,
) error {
	startDate, err := time.Parse("2006-01-02", query.StartDate)
	if err != nil {
		return scheduled_reports.NewAPIError(400, "start_date must be YYYY-MM-DD")
	}
	endDate, err := time.Parse("2006-01-02", query.EndDate)
	if err != nil {
		return scheduled_reports.NewAPIError(400, "end_date must be YYYY-MM-DD")
	}
	if endDate.Before(startDate) {
		return scheduled_reports.NewAPIError(400, "end_date must be greater than or equal to start_date")
	}
	frequency := ""
	if query.Frequency != "" && query.Frequency != "all" {
		frequency = query.Frequency
	}
	subscriptions, err := store.ListActiveSubscriptions(ctx, frequency)
	if err != nil {
		return err
	}
	location, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		location = time.FixedZone("CST", 8*60*60)
	}
	for _, subscription := range subscriptions {
		createdAt := parseScheduledReportTimestamp(subscription.CreatedAt)
		createdDate := startDate
		if createdAt != nil {
			localCreated := createdAt.In(location)
			candidate := time.Date(
				localCreated.Year(),
				localCreated.Month(),
				localCreated.Day(),
				0,
				0,
				0,
				0,
				location,
			)
			if candidate.After(startDate) {
				createdDate = candidate
			}
			if _, err := store.db.Exec(
				ctx,
				`delete from public.scheduled_report_ledger_entries
				 where subscription_id = $1 and expected_date < $2`,
				subscription.ID,
				createdDate.Format("2006-01-02"),
			); err != nil {
				return err
			}
		}
		for day := createdDate; !day.After(endDate); day = day.AddDate(0, 0, 1) {
			if !subscriptionMatchesDate(subscription, day) {
				continue
			}
			expectedDate := day.Format("2006-01-02")
			ledgerKey := fmt.Sprintf("%d:%s", subscription.ID, expectedDate)
			if err := acquireAdvisoryLock(ctx, store.db, "scheduled-report-ledger:"+ledgerKey); err != nil {
				return err
			}
			if _, err := store.db.Exec(
				ctx,
				`delete from public.scheduled_report_ledger_entries
				 where subscription_id = $1 and expected_date = $2 and ledger_key <> $3`,
				subscription.ID,
				expectedDate,
				ledgerKey,
			); err != nil {
				return err
			}
			latestID, latestStatus, latestError, latestSentAt, err := store.latestDeliveryLog(
				ctx,
				subscription.ID,
				subscription.Frequency,
				expectedDate,
			)
			if err != nil {
				return err
			}
			status := classifyDeliveryStatus(latestID, latestStatus)
			expectedAt := expectedAtFor(subscription, day, location)
			if _, err := store.db.Exec(
				ctx,
				`insert into public.scheduled_report_ledger_entries (
				   ledger_key, subscription_id, frequency, expected_date, expected_at,
				   email, project_ids, country, status, latest_delivery_log_id,
				   error_message, sent_at, last_checked_at, created_at, updated_at
				 ) values (
				   $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), now(), now()
				 )
				 on conflict (ledger_key) do update set
				   frequency = excluded.frequency,
				   expected_date = excluded.expected_date,
				   expected_at = excluded.expected_at,
				   email = excluded.email,
				   project_ids = excluded.project_ids,
				   country = excluded.country,
				   status = excluded.status,
				   latest_delivery_log_id = excluded.latest_delivery_log_id,
				   error_message = excluded.error_message,
				   sent_at = excluded.sent_at,
				   last_checked_at = now(),
				   updated_at = now()`,
				ledgerKey,
				subscription.ID,
				subscription.Frequency,
				expectedDate,
				expectedAt,
				subscription.Email,
				subscription.ProjectIDs,
				subscription.Country,
				status,
				latestID,
				latestError,
				latestSentAt,
			); err != nil {
				return err
			}
		}
	}
	return nil
}

func (store *ScheduledReportStore) latestDeliveryLog(
	ctx context.Context,
	subscriptionID int64,
	frequency string,
	reportDate string,
) (*int64, string, *string, *time.Time, error) {
	var id int
	var status string
	var errorMessage *string
	var sentAt *time.Time
	err := store.db.QueryRow(
		ctx,
		`select id, status, error_message, sent_at
		 from public.scheduled_report_delivery_logs
		 where subscription_id = $1 and frequency = $2 and report_date = $3
		 order by created_at desc, id desc
		 limit 1`,
		subscriptionID,
		frequency,
		reportDate,
	).Scan(&id, &status, &errorMessage, &sentAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, "", nil, nil, nil
	}
	if err != nil {
		return nil, "", nil, nil, err
	}
	id64 := int64(id)
	return &id64, status, errorMessage, sentAt, nil
}

type ledgerWhere struct {
	sql  string
	args []any
}

func buildLedgerWhere(query scheduled_reports.LedgerQuery) ledgerWhere {
	args := []any{query.StartDate, query.EndDate}
	sql := "le.expected_date >= $1 and le.expected_date <= $2"
	if query.Frequency != "" && query.Frequency != "all" {
		args = append(args, query.Frequency)
		sql += fmt.Sprintf(" and le.frequency = $%d", len(args))
	}
	if query.Status != "" && query.Status != "all" {
		args = append(args, query.Status)
		sql += fmt.Sprintf(" and (case when dl.status = 'sent' then 'sent' when dl.status = 'failed' then 'failed' else le.status end) = $%d", len(args))
	}
	if query.Email != nil && strings.TrimSpace(*query.Email) != "" {
		args = append(args, "%"+strings.TrimSpace(*query.Email)+"%")
		sql += fmt.Sprintf(" and le.email ilike $%d", len(args))
	}
	if query.ProjectID != nil {
		args = append(args, fmt.Sprintf("%d", *query.ProjectID))
		placeholder := fmt.Sprintf("$%d", len(args))
		sql += fmt.Sprintf(` and (
			le.project_ids = '*'
			or le.project_ids = %[1]s
			or le.project_ids like %[1]s || ',%%'
			or le.project_ids like '%%' || ',' || %[1]s || ',%%'
			or le.project_ids like '%%' || ',' || %[1]s
		)`, placeholder)
	}
	if !query.Scope.IsAdmin {
		if query.Scope.UserID == nil {
			sql += " and false"
		} else {
			args = append(args, *query.Scope.UserID)
			sql += fmt.Sprintf(" and s.user_id = $%d", len(args))
		}
	}
	return ledgerWhere{sql: sql, args: args}
}

func (store *ScheduledReportStore) queryLedger(
	ctx context.Context,
	query scheduled_reports.LedgerQuery,
) (scheduled_reports.LedgerListResponse, error) {
	if store == nil || store.db == nil {
		return scheduled_reports.LedgerListResponse{}, errors.New("scheduled report database is not configured")
	}
	where := buildLedgerWhere(query)
	from := `
		from public.scheduled_report_ledger_entries le
		join public.scheduled_report_subscriptions s on s.id = le.subscription_id
		left join public.scheduled_report_delivery_logs dl on dl.id = le.latest_delivery_log_id
		where ` + where.sql

	var expected, sent, failed, missing int
	if err := store.db.QueryRow(
		ctx,
		`select count(*),
		        count(*) filter (where (case when dl.status = 'sent' then 'sent'
		                                      when dl.status = 'failed' then 'failed'
		                                      else le.status end) = 'sent'),
		        count(*) filter (where (case when dl.status = 'sent' then 'sent'
		                                      when dl.status = 'failed' then 'failed'
		                                      else le.status end) = 'failed'),
		        count(*) filter (where (case when dl.status = 'sent' then 'sent'
		                                      when dl.status = 'failed' then 'failed'
		                                      else le.status end) = 'missing')`+from,
		where.args...,
	).Scan(&expected, &sent, &failed, &missing); err != nil {
		return scheduled_reports.LedgerListResponse{}, err
	}

	limit := query.Limit
	if limit <= 0 {
		limit = 100
	}
	offset := query.Offset
	if offset < 0 {
		offset = 0
	}
	dayArgs := append([]any(nil), where.args...)
	dayArgs = append(dayArgs, limit, offset)
	rows, err := store.db.Query(
		ctx,
		`select distinct le.expected_date`+from+`
		 order by le.expected_date desc
		 limit $`+fmt.Sprintf("%d", len(where.args)+1)+`
		 offset $`+fmt.Sprintf("%d", len(where.args)+2),
		dayArgs...,
	)
	if err != nil {
		return scheduled_reports.LedgerListResponse{}, err
	}
	defer rows.Close()
	days := make([]string, 0)
	for rows.Next() {
		var day string
		if err := rows.Scan(&day); err != nil {
			return scheduled_reports.LedgerListResponse{}, err
		}
		days = append(days, day)
	}
	if err := rows.Err(); err != nil {
		return scheduled_reports.LedgerListResponse{}, err
	}

	items := make([]scheduled_reports.LedgerItem, 0)
	if len(days) > 0 {
		args := append([]any(nil), where.args...)
		args = append(args, days)
		rows, err := store.db.Query(
			ctx,
			`select
			   le.id, le.ledger_key, le.expected_date, le.expected_at,
			   le.frequency, le.subscription_id, le.email, le.project_ids,
			   le.country,
			   case when dl.status = 'sent' then 'sent'
			        when dl.status = 'failed' then 'failed'
			        else le.status end as effective_status,
			   le.latest_delivery_log_id, le.error_message,
			   coalesce(le.sent_at, dl.sent_at), le.last_checked_at,
			   dl.screenshot_r2_url, dl.screenshot_r2_thumb_url,
			   dl.ai_summary,
			   coalesce(dl.ai_summary_status, 'pending'),
			   dl.ai_summary_error, dl.ai_summary_model, dl.insight_run_id,
			   dl.ai_summary_updated_at`+from+`
			   and le.expected_date = any($`+fmt.Sprintf("%d", len(where.args)+1)+`::text[])
			 order by le.expected_at desc, le.id desc`,
			args...,
		)
		if err != nil {
			return scheduled_reports.LedgerListResponse{}, err
		}
		defer rows.Close()
		for rows.Next() {
			item, err := scanLedgerItem(rows)
			if err != nil {
				return scheduled_reports.LedgerListResponse{}, err
			}
			projectNames, err := store.projectNamesFor(ctx, item.ProjectIDs)
			if err != nil {
				return scheduled_reports.LedgerListResponse{}, err
			}
			item.ProjectNames = projectNames
			item.CanResend = item.Status == scheduled_reports.StatusMissing || item.Status == scheduled_reports.StatusFailed
			items = append(items, item)
		}
		if err := rows.Err(); err != nil {
			return scheduled_reports.LedgerListResponse{}, err
		}
	}
	return scheduled_reports.LedgerListResponse{
		Items: items,
		Total: expected,
		Summary: scheduled_reports.LedgerSummary{
			Expected:   expected,
			Sent:       sent,
			Failed:     failed,
			Missing:    missing,
			Resendable: failed + missing,
		},
	}, nil
}

func (store *ScheduledReportStore) projectNamesFor(
	ctx context.Context,
	projectIDs string,
) ([]string, error) {
	if projectIDs == "*" {
		return []string{"全部项目"}, nil
	}
	ids := parseProjectIDList(projectIDs)
	if len(ids) == 0 {
		return []string{}, nil
	}
	values := make([]int32, 0, len(ids))
	for _, id := range ids {
		values = append(values, int32(id))
	}
	rows, err := store.db.Query(
		ctx,
		`select id, project_name
		 from public.projects
		 where id = any($1::int[])
		 order by sort_order`,
		values,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	nameByID := make(map[int64]string, len(ids))
	for rows.Next() {
		var id int
		var name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, err
		}
		nameByID[int64(id)] = name
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	names := make([]string, 0, len(ids))
	for _, id := range ids {
		name, ok := nameByID[id]
		if !ok {
			name = fmt.Sprintf("项目%d", id)
		}
		names = append(names, name)
	}
	return names, nil
}

func (store *ScheduledReportStore) PrepareResend(
	ctx context.Context,
	request scheduled_reports.ResendRequest,
) (scheduled_reports.ResendResult, error) {
	if store == nil || store.db == nil {
		return scheduled_reports.ResendResult{}, errors.New("scheduled report database is not configured")
	}
	if err := acquireAdvisoryLock(ctx, store.db, "scheduled-report-resend:"+request.LedgerKey); err != nil {
		return scheduled_reports.ResendResult{}, err
	}
	var entryID, subscriptionID int
	var frequency, expectedDate, projectIDs, country, status string
	var email *string
	var latestLogID *int
	err := store.db.QueryRow(
		ctx,
		`select id, subscription_id, frequency, expected_date, email,
		        project_ids, country, status, latest_delivery_log_id
		 from public.scheduled_report_ledger_entries
		 where ledger_key = $1
		 for update`,
		request.LedgerKey,
	).Scan(
		&entryID,
		&subscriptionID,
		&frequency,
		&expectedDate,
		&email,
		&projectIDs,
		&country,
		&status,
		&latestLogID,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return scheduled_reports.ResendResult{}, scheduled_reports.ErrLedgerNotFound
	}
	if err != nil {
		return scheduled_reports.ResendResult{}, err
	}
	if status == scheduled_reports.StatusSent && !request.Force {
		return scheduled_reports.ResendResult{}, scheduled_reports.ErrAlreadySent
	}
	subscription, err := store.GetSubscription(ctx, int64(subscriptionID))
	if err != nil {
		return scheduled_reports.ResendResult{}, err
	}
	if subscription == nil {
		return scheduled_reports.ResendResult{}, scheduled_reports.ErrSubscriptionNotFound
	}
	effectiveAIModel := effectiveAIModel(subscription.AIModel, request.OverrideAI)
	if latestLogID != nil {
		var existingID int
		var existingStatus, triggeredBy, stage string
		err := store.db.QueryRow(
			ctx,
			`select id, status, triggered_by, stage
			 from public.scheduled_report_delivery_logs
			 where id = $1`,
			*latestLogID,
		).Scan(&existingID, &existingStatus, &triggeredBy, &stage)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return scheduled_reports.ResendResult{}, err
		}
		if err == nil && existingStatus == scheduled_reports.StatusSent && !request.Force {
			return scheduled_reports.ResendResult{}, scheduled_reports.ErrAlreadySent
		}
		if err == nil && deliveryInProgress(existingStatus, stage) {
			existingID64 := int64(existingID)
			return scheduled_reports.ResendResult{
				DeliveryLogID:  &existingID64,
				Status:         "processing",
				Message:        "补发任务已在处理中，请勿重复提交",
				SubscriptionID: int64(subscriptionID),
				Frequency:      frequency,
				Email:          email,
				ProjectIDs:     projectIDs,
				Country:        country,
				ReportDate:     expectedDate,
				AIModel:        effectiveAIModel,
				Reused:         true,
			}, nil
		}
	}

	var reportMonth *string
	if frequency == scheduled_reports.FrequencyMonthly {
		month := expectedDate
		if len(month) > 7 {
			month = month[:7]
		}
		reportMonth = &month
	}
	var newLogID int
	err = store.db.QueryRow(
		ctx,
		`insert into public.scheduled_report_delivery_logs (
		   subscription_id, frequency, report_date, report_month, email,
		   triggered_by, status, stage, created_at
		 ) values ($1, $2, $3, $4, $5, 'manual', 'pending', 'preparing', now())
		 returning id`,
		subscription.ID,
		frequency,
		expectedDate,
		reportMonth,
		email,
	).Scan(&newLogID)
	if err != nil {
		return scheduled_reports.ResendResult{}, err
	}
	if _, err := store.db.Exec(
		ctx,
		`update public.scheduled_report_ledger_entries
		 set latest_delivery_log_id = $1,
		     status = 'missing',
		     error_message = null,
		     sent_at = null,
		     last_checked_at = now(),
		     updated_at = now()
		 where id = $2`,
		newLogID,
		entryID,
	); err != nil {
		return scheduled_reports.ResendResult{}, err
	}
	newLogID64 := int64(newLogID)
	var oldLogID64 *int64
	if latestLogID != nil {
		value := int64(*latestLogID)
		oldLogID64 = &value
	}
	return scheduled_reports.ResendResult{
		DeliveryLogID:  &newLogID64,
		Status:         "processing",
		Message:        "补发任务已派发到 scheduled 队列，请在台账中查看进度",
		OldLogID:       oldLogID64,
		SubscriptionID: int64(subscriptionID),
		Frequency:      frequency,
		Email:          email,
		ProjectIDs:     projectIDs,
		Country:        country,
		ReportDate:     expectedDate,
		AIModel:        effectiveAIModel,
	}, nil
}

func (store *ScheduledReportStore) PrepareAISummaryRegeneration(
	ctx context.Context,
	request scheduled_reports.RegenerateRequest,
) (scheduled_reports.RegenerateResult, error) {
	if store == nil || store.db == nil {
		return scheduled_reports.RegenerateResult{}, errors.New("scheduled report database is not configured")
	}
	if err := acquireAdvisoryLock(ctx, store.db, "scheduled-report-ai-summary:"+request.LedgerKey); err != nil {
		return scheduled_reports.RegenerateResult{}, err
	}
	var subscriptionID int
	var latestLogID *int
	err := store.db.QueryRow(
		ctx,
		`select subscription_id, latest_delivery_log_id
		 from public.scheduled_report_ledger_entries
		 where ledger_key = $1
		 for update`,
		request.LedgerKey,
	).Scan(&subscriptionID, &latestLogID)
	if errors.Is(err, pgx.ErrNoRows) {
		return scheduled_reports.RegenerateResult{}, scheduled_reports.ErrLedgerNotFound
	}
	if err != nil {
		return scheduled_reports.RegenerateResult{}, err
	}
	if latestLogID == nil {
		return scheduled_reports.RegenerateResult{}, scheduled_reports.ErrMissingDeliveryLog
	}
	var logID int
	var deliveryStatus, currentSummaryModel *string
	var insightRunID *string
	err = store.db.QueryRow(
		ctx,
		`select id, status, insight_run_id, ai_summary_model
		 from public.scheduled_report_delivery_logs
		 where id = $1
		 for update`,
		*latestLogID,
	).Scan(&logID, &deliveryStatus, &insightRunID, &currentSummaryModel)
	if errors.Is(err, pgx.ErrNoRows) {
		return scheduled_reports.RegenerateResult{}, scheduled_reports.ErrMissingDeliveryLog
	}
	if err != nil {
		return scheduled_reports.RegenerateResult{}, err
	}
	if deliveryStatus == nil || *deliveryStatus != scheduled_reports.StatusSent {
		return scheduled_reports.RegenerateResult{}, scheduled_reports.ErrDeliveryNotSent
	}
	subscription, err := store.GetSubscription(ctx, int64(subscriptionID))
	if err != nil {
		return scheduled_reports.RegenerateResult{}, err
	}
	if subscription == nil {
		return scheduled_reports.RegenerateResult{}, scheduled_reports.ErrSubscriptionNotFound
	}
	effectiveModel := effectiveAIModel(subscription.AIModel, request.OverrideAI)
	if effectiveModel == nil {
		effectiveModel = currentSummaryModel
	}
	if _, err := store.db.Exec(
		ctx,
		`update public.scheduled_report_delivery_logs
		 set ai_summary_status = 'pending',
		     ai_summary_error = null,
		     ai_summary_model = $1,
		     ai_summary_updated_at = now()
		 where id = $2`,
		effectiveModel,
		logID,
	); err != nil {
		return scheduled_reports.RegenerateResult{}, err
	}
	logID64 := int64(logID)
	return scheduled_reports.RegenerateResult{
		DeliveryLogID: &logID64,
		Status:        "generating",
		InsightRunID:  insightRunID,
		Message:       "AI 摘要生成已启动",
		AIModel:       effectiveModel,
	}, nil
}

func (store *ScheduledReportStore) AcquireTriggerLock(
	ctx context.Context,
	frequency string,
) error {
	if store == nil || store.db == nil {
		return errors.New("scheduled report database is not configured")
	}
	return acquireAdvisoryLock(ctx, store.db, scheduled_reports.TriggerLockKey(frequency))
}

func (store *ScheduledReportStore) FindIdempotencyRecord(
	ctx context.Context,
	action string,
	idempotencyKey string,
) (*scheduled_reports.IdempotencyRecord, error) {
	if store == nil || store.db == nil {
		return nil, errors.New("scheduled report database is not configured")
	}
	var beforeJSON, afterJSON []byte
	err := store.db.QueryRow(
		ctx,
		`select before_json, after_json
		 from public.operation_audit_logs
		 where action = $1 and idempotency_key = $2 and result = 'success'
		 order by id desc
		 limit 1`,
		action,
		idempotencyKey,
	).Scan(&beforeJSON, &afterJSON)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var marker struct {
		Fingerprint string `json:"fingerprint"`
	}
	if err := json.Unmarshal(beforeJSON, &marker); err != nil {
		return nil, fmt.Errorf("decode idempotency fingerprint: %w", err)
	}
	if marker.Fingerprint == "" {
		return nil, errors.New("idempotency audit row is missing fingerprint")
	}
	return &scheduled_reports.IdempotencyRecord{
		Fingerprint: marker.Fingerprint,
		Response:    json.RawMessage(afterJSON),
	}, nil
}

func scanScheduledReportSubscription(scanner interface {
	Scan(dest ...any) error
}) (scheduled_reports.Subscription, error) {
	var id int
	var userID *int
	var email *string
	var projectIDs, country, frequency string
	var dispatchHour, dispatchMinute int
	var dispatchWeekday, dispatchDay *int
	var aiModel *string
	var enabled bool
	var createdAt, updatedAt time.Time
	err := scanner.Scan(
		&id,
		&userID,
		&email,
		&projectIDs,
		&country,
		&frequency,
		&dispatchHour,
		&dispatchMinute,
		&dispatchWeekday,
		&dispatchDay,
		&aiModel,
		&enabled,
		&createdAt,
		&updatedAt,
	)
	if err != nil {
		return scheduled_reports.Subscription{}, err
	}
	return scheduled_reports.Subscription{
		ID:              int64(id),
		UserID:          userID,
		Email:           email,
		ProjectIDs:      projectIDs,
		Country:         country,
		Frequency:       frequency,
		DispatchHour:    dispatchHour,
		DispatchMinute:  dispatchMinute,
		DispatchWeekday: dispatchWeekday,
		DispatchDay:     dispatchDay,
		AIModel:         aiModel,
		Enabled:         enabled,
		CreatedAt:       httpapi.Timestamp(createdAt),
		UpdatedAt:       httpapi.Timestamp(updatedAt),
	}, nil
}

func scanScheduledReportDeliveryLog(scanner interface {
	Scan(dest ...any) error
}) (scheduled_reports.DeliveryLog, error) {
	var id, subscriptionID int
	var frequency, reportDate string
	var reportMonth, email *string
	var status, stage, aiSummaryStatus string
	var errorMessage *string
	var sentAt *time.Time
	var screenshotKey, screenshotURL, screenshotThumbKey, screenshotThumbURL *string
	var aiSummary, aiSummaryError, aiSummaryModel, insightRunID *string
	var aiSummaryUpdatedAt *time.Time
	var createdAt time.Time
	err := scanner.Scan(
		&id,
		&subscriptionID,
		&frequency,
		&reportDate,
		&reportMonth,
		&email,
		&status,
		&errorMessage,
		&sentAt,
		&screenshotKey,
		&screenshotURL,
		&screenshotThumbKey,
		&screenshotThumbURL,
		&aiSummary,
		&aiSummaryStatus,
		&aiSummaryError,
		&aiSummaryModel,
		&insightRunID,
		&aiSummaryUpdatedAt,
		&stage,
		&createdAt,
	)
	if err != nil {
		return scheduled_reports.DeliveryLog{}, err
	}
	return scheduled_reports.DeliveryLog{
		ID:                   int64(id),
		SubscriptionID:       int64(subscriptionID),
		Frequency:            frequency,
		ReportDate:           reportDate,
		ReportMonth:          reportMonth,
		Email:                email,
		Status:               status,
		Stage:                stage,
		ErrorMessage:         errorMessage,
		SentAt:               httpapi.OptionalTimestamp(sentAt),
		ScreenshotR2Key:      screenshotKey,
		ScreenshotR2URL:      screenshotURL,
		ScreenshotR2ThumbKey: screenshotThumbKey,
		ScreenshotR2ThumbURL: screenshotThumbURL,
		AISummary:            aiSummary,
		AISummaryStatus:      aiSummaryStatus,
		AISummaryError:       aiSummaryError,
		AISummaryModel:       aiSummaryModel,
		InsightRunID:         insightRunID,
		AISummaryUpdatedAt:   httpapi.OptionalTimestamp(aiSummaryUpdatedAt),
		CreatedAt:            httpapi.Timestamp(createdAt),
	}, nil
}

func scanLedgerItem(scanner interface {
	Scan(dest ...any) error
}) (scheduled_reports.LedgerItem, error) {
	var id, subscriptionID int
	var ledgerKey, expectedDate, frequency string
	var expectedAt time.Time
	var email *string
	var projectIDs, country, status string
	var latestDeliveryLogID *int
	var errorMessage *string
	var sentAt *time.Time
	var lastCheckedAt time.Time
	var screenshotURL, screenshotThumbURL, aiSummary, aiSummaryError, aiSummaryModel, insightRunID *string
	var aiSummaryStatus string
	var aiSummaryUpdatedAt *time.Time
	err := scanner.Scan(
		&id,
		&ledgerKey,
		&expectedDate,
		&expectedAt,
		&frequency,
		&subscriptionID,
		&email,
		&projectIDs,
		&country,
		&status,
		&latestDeliveryLogID,
		&errorMessage,
		&sentAt,
		&lastCheckedAt,
		&screenshotURL,
		&screenshotThumbURL,
		&aiSummary,
		&aiSummaryStatus,
		&aiSummaryError,
		&aiSummaryModel,
		&insightRunID,
		&aiSummaryUpdatedAt,
	)
	if err != nil {
		return scheduled_reports.LedgerItem{}, err
	}
	var latestID64 *int64
	if latestDeliveryLogID != nil {
		value := int64(*latestDeliveryLogID)
		latestID64 = &value
	}
	return scheduled_reports.LedgerItem{
		ID:                   int64(id),
		LedgerKey:            ledgerKey,
		ExpectedDate:         expectedDate,
		ExpectedAt:           httpapi.Timestamp(expectedAt),
		Frequency:            frequency,
		SubscriptionID:       int64(subscriptionID),
		Email:                email,
		ProjectIDs:           projectIDs,
		ProjectNames:         []string{},
		Country:              country,
		Status:               status,
		LatestDeliveryLogID:  latestID64,
		ErrorMessage:         errorMessage,
		SentAt:               httpapi.OptionalTimestamp(sentAt),
		LastCheckedAt:        httpapi.Timestamp(lastCheckedAt),
		ScreenshotR2URL:      screenshotURL,
		ScreenshotR2ThumbURL: screenshotThumbURL,
		AISummary:            aiSummary,
		AISummaryStatus:      aiSummaryStatus,
		AISummaryError:       aiSummaryError,
		AISummaryModel:       aiSummaryModel,
		InsightRunID:         insightRunID,
		AISummaryUpdatedAt:   httpapi.OptionalTimestamp(aiSummaryUpdatedAt),
	}, nil
}

func acquireAdvisoryLock(ctx context.Context, db DB, key string) error {
	if db == nil {
		return errors.New("database is not configured")
	}
	var locked int
	return db.QueryRow(
		ctx,
		`select 1 from (select pg_advisory_xact_lock(hashtext($1))) as advisory_lock`,
		key,
	).Scan(&locked)
}

func subscriptionMatchesDate(subscription scheduled_reports.Subscription, day time.Time) bool {
	switch subscription.Frequency {
	case scheduled_reports.FrequencyDaily:
		return true
	case scheduled_reports.FrequencyWeekly:
		weekday := 0
		if subscription.DispatchWeekday != nil {
			weekday = *subscription.DispatchWeekday
		}
		// Python's datetime.weekday() and the subscription schema use 0=Monday;
		// Go's time.Weekday uses 0=Sunday.
		return (int(day.Weekday())+6)%7 == weekday
	case scheduled_reports.FrequencyMonthly:
		expectedDay := 2
		if subscription.DispatchDay != nil {
			expectedDay = *subscription.DispatchDay
		}
		return day.Day() == expectedDay
	default:
		return false
	}
}

func expectedAtFor(
	subscription scheduled_reports.Subscription,
	day time.Time,
	location *time.Location,
) time.Time {
	return time.Date(
		day.Year(),
		day.Month(),
		day.Day(),
		subscription.DispatchHour,
		subscription.DispatchMinute,
		0,
		0,
		location,
	)
}

func classifyDeliveryStatus(id *int64, status string) string {
	if id == nil {
		return scheduled_reports.StatusMissing
	}
	switch status {
	case scheduled_reports.StatusSent:
		return scheduled_reports.StatusSent
	case scheduled_reports.StatusFailed:
		return scheduled_reports.StatusFailed
	default:
		return scheduled_reports.StatusMissing
	}
}

func deliveryInProgress(status, stage string) bool {
	if status == scheduled_reports.StatusSent || status == scheduled_reports.StatusFailed || status == "superseded" {
		return false
	}
	return stage != "done" && stage != "failed"
}

func effectiveAIModel(subscriptionModel, override *string) *string {
	if override != nil {
		trimmed := strings.TrimSpace(*override)
		if trimmed != "" {
			return &trimmed
		}
	}
	if subscriptionModel == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*subscriptionModel)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func parseScheduledReportTimestamp(value string) *time.Time {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return nil
	}
	return &parsed
}

func parseProjectIDList(value string) []int64 {
	if value == "*" {
		return nil
	}
	ids := make([]int64, 0)
	for _, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		var parsed int64
		if _, err := fmt.Sscan(part, &parsed); err == nil && parsed > 0 {
			ids = append(ids, parsed)
		}
	}
	return ids
}

func optionalStringArgument(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}
