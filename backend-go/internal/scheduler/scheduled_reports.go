package scheduler

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/scheduled_reports"
	"github.com/passwii/believeboyDashboard/backend-go/internal/tasks"
)

// ScheduledReportSource supplies the enabled subscriptions that are due at the
// given instant. The production adapter applies the Asia/Shanghai hour/minute
// and day-of-week/day-of-month rules.
type ScheduledReportSource interface {
	ListDueSubscriptions(ctx context.Context, now time.Time) ([]scheduled_reports.Subscription, error)
}

// ScheduledReportEnqueuer enqueues dispatch_one tasks. The delay staggers the
// fan-out so a minute with many subscriptions does not burst the queue.
type ScheduledReportEnqueuer interface {
	EnqueueScheduledReport(ctx context.Context, payload tasks.DispatchOnePayload, delay time.Duration) error
}

// ScheduledReportScanResult summarises one minutely scan.
type ScheduledReportScanResult struct {
	Due      int
	Enqueued int
	Skipped  int
}

// ScheduledReportStaggerDelay is the per-subscription delay applied within one
// scan, mirroring the Python APScheduler scan behaviour.
const ScheduledReportStaggerDelay = 2 * time.Second

// ScanDueScheduledReports reads the subscriptions due at now and enqueues one
// dispatch_one task per subscription. Subscriptions without an email are still
// enqueued: dispatch_one generates the report, screenshot and fallback summary
// and only skips the outbound email. Skipping them here was the production bug
// that left 22 of 23 subscriptions without any delivery log.
func ScanDueScheduledReports(
	ctx context.Context,
	now time.Time,
	source ScheduledReportSource,
	enqueuer ScheduledReportEnqueuer,
	logger *slog.Logger,
) (ScheduledReportScanResult, error) {
	result := ScheduledReportScanResult{}
	if source == nil {
		return result, fmt.Errorf("scheduled report source is nil")
	}
	if enqueuer == nil {
		return result, fmt.Errorf("scheduled report enqueuer is nil")
	}
	if logger == nil {
		logger = slog.Default()
	}

	subscriptions, err := source.ListDueSubscriptions(ctx, now)
	if err != nil {
		return result, fmt.Errorf("list due subscriptions: %w", err)
	}
	result.Due = len(subscriptions)
	// The due check uses Asia/Shanghai; report_date must use the same
	// timezone. Formatting now directly uses the container-local (UTC) clock
	// and writes the previous day for the 00:00-08:00 local window.
	location := scheduledReportLocation()
	reportDate := now.In(location).Format("2006-01-02")

	for index, subscription := range subscriptions {
		projectIDs, err := ParseScheduledReportProjectIDs(subscription.ProjectIDs)
		if err != nil {
			result.Skipped++
			logger.Warn(
				"scheduled report skipped: invalid project_ids",
				slog.Int64("subscription_id", subscription.ID),
				slog.String("project_ids", subscription.ProjectIDs),
				slog.Any("error", err),
			)
			continue
		}
		useCache := true
		email := ""
		if subscription.Email != nil {
			email = strings.TrimSpace(*subscription.Email)
		}
		payload := tasks.DispatchOnePayload{
			SubscriptionID: subscription.ID,
			Email:          email,
			ProjectIDs:     projectIDs,
			Country:        subscription.Country,
			Frequency:      subscription.Frequency,
			AIModel:        subscription.AIModel,
			UseCache:       &useCache,
			TriggeredBy:    "auto",
			ReportDate:     reportDate,
		}
		if err := enqueuer.EnqueueScheduledReport(
			ctx,
			payload,
			time.Duration(index)*ScheduledReportStaggerDelay,
		); err != nil {
			logger.Error(
				"scheduled report enqueue failed",
				slog.Int64("subscription_id", subscription.ID),
				slog.Any("error", err),
			)
			continue
		}
		result.Enqueued++
	}
	return result, nil
}

func scheduledReportLocation() *time.Location {
	location, err := time.LoadLocation(DefaultTimezone)
	if err != nil {
		return time.FixedZone("CST", 8*60*60)
	}
	return location
}

// ParseScheduledReportProjectIDs converts the stored project_ids value ("*" or
// comma separated ids) into the dispatch payload form.
func ParseScheduledReportProjectIDs(raw string) ([]int64, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || trimmed == "*" {
		return nil, nil
	}
	parts := strings.Split(trimmed, ",")
	ids := make([]int64, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		id, err := strconv.ParseInt(part, 10, 64)
		if err != nil || id <= 0 {
			return nil, fmt.Errorf("invalid project id %q", part)
		}
		ids = append(ids, id)
	}
	return ids, nil
}
