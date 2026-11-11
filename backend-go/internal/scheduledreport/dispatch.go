package scheduledreport

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/mailer"
	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
)

// EmailSender is the subset of mailer.Mailer used by the dispatcher.
type EmailSender interface {
	Send(ctx context.Context, message mailer.Message) (mailer.Result, error)
}

// DispatchRequest is the payload of a scheduled report dispatch.
type DispatchRequest struct {
	SubscriptionID int64
	Email          string
	ProjectIDs     []int64
	Country        string
	Frequency      string
	ReportDate     string
	TriggeredBy    string
}

// DispatchResult reports the outcome of one dispatch.
type DispatchResult struct {
	SubscriptionID int64  `json:"subscription_id"`
	Success        bool   `json:"success"`
	Skipped        bool   `json:"skipped"`
	Error          string `json:"error,omitempty"`
	DeliveryLogID  int64  `json:"delivery_log_id"`
}

// DispatchOne sends one scheduled report email and maintains the delivery log.
// It covers the daily/weekly/monthly email path; AI summaries, screenshots and
// manual-log guards remain separate follow-ups.
func DispatchOne(ctx context.Context, db store.FullDB, sender EmailSender, request DispatchRequest) (DispatchResult, error) {
	result := DispatchResult{SubscriptionID: request.SubscriptionID}
	if db == nil {
		return result, errors.New("database is required")
	}
	email := strings.TrimSpace(request.Email)
	projectIDs := request.ProjectIDs
	var subscriptionEmail *string
	var subscriptionCountry, subscriptionFrequency, projectIDsText string
	err := db.QueryRow(ctx,
		"select email, project_ids, country, frequency from public.scheduled_report_subscriptions where id = $1",
		request.SubscriptionID).Scan(&subscriptionEmail, &projectIDsText, &subscriptionCountry, &subscriptionFrequency)
	if err != nil {
		result.Error = fmt.Sprintf("load subscription: %v", err)
		return result, err
	}
	if email == "" && subscriptionEmail != nil {
		email = strings.TrimSpace(*subscriptionEmail)
	}
	if len(projectIDs) == 0 && projectIDsText != "" && projectIDsText != "*" {
		for _, part := range strings.Split(projectIDsText, ",") {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			var id int64
			if _, scanErr := fmt.Sscanf(part, "%d", &id); scanErr == nil && id > 0 {
				projectIDs = append(projectIDs, id)
			}
		}
	}
	country := strings.TrimSpace(request.Country)
	if country == "" {
		country = subscriptionCountry
	}
	frequency := strings.TrimSpace(request.Frequency)
	if frequency == "" {
		frequency = subscriptionFrequency
	}
	if frequency == "" {
		frequency = "daily"
	}
	now := time.Now()
	reportDateText := strings.TrimSpace(request.ReportDate)
	if reportDateText == "" {
		reportDateText = reportAnchorDate(country, now).Format("2006-01-02")
	}
	reportDate, parseErr := time.ParseInLocation("2006-01-02", reportDateText, time.Local)
	if parseErr != nil {
		result.Error = fmt.Sprintf("invalid report_date %q", reportDateText)
		return result, parseErr
	}
	referenceDate := reportDate
	if frequency == "daily" && strings.TrimSpace(request.ReportDate) != "" {
		referenceDate = reportDate.AddDate(0, 0, -1)
	}
	triggeredBy := strings.TrimSpace(request.TriggeredBy)
	if triggeredBy == "" {
		triggeredBy = "auto"
	}

	var logID int64
	logErr := db.QueryRow(ctx,
		"insert into public.scheduled_report_delivery_logs "+
			"(subscription_id, frequency, report_date, report_month, email, triggered_by, status, stage, ai_summary_status) "+
			"values ($1, $2, $3, $4, $5, $6, 'pending', 'preparing', 'pending') returning id",
		request.SubscriptionID, frequency, reportDateText, reportMonth(frequency, reportDateText),
		nullableString(email), triggeredBy).Scan(&logID)
	if logErr != nil {
		result.Error = fmt.Sprintf("create delivery log: %v", logErr)
		return result, logErr
	}
	result.DeliveryLogID = logID

	fail := func(message string, cause error) (DispatchResult, error) {
		result.Success = false
		result.Error = message
		_, _ = db.Exec(ctx,
			"update public.scheduled_report_delivery_logs set status = 'failed', stage = 'failed', error_message = $2 where id = $1",
			logID, message)
		if cause == nil {
			cause = errors.New(message)
		}
		return result, cause
	}

	if _, err := db.Exec(ctx,
		"update public.scheduled_report_delivery_logs set stage = 'fetching_data' where id = $1", logID); err != nil {
		return fail(fmt.Sprintf("mark fetching_data: %v", err), err)
	}
	var reportData map[string]any
	if frequency == "monthly" {
		reportData, err = BuildMonthlyReportData(ctx, db, MonthlyOptions{
			ProjectIDs:    projectIDs,
			Country:       country,
			ReferenceDate: &referenceDate,
			Now:           now,
		})
	} else {
		reportData, err = BuildDailyReportData(ctx, db, DailyOptions{
			ProjectIDs:    projectIDs,
			Country:       country,
			Frequency:     frequency,
			ReferenceDate: &referenceDate,
			Now:           now,
		})
	}
	if err != nil {
		return fail(fmt.Sprintf("build report data: %v", err), err)
	}
	reportData["frequency"] = frequency
	if _, err := db.Exec(ctx,
		"update public.scheduled_report_delivery_logs set stage = 'rendering_html' where id = $1", logID); err != nil {
		return fail(fmt.Sprintf("mark rendering_html: %v", err), err)
	}
	html := RenderDailyReportHTML(reportData, true)
	if strings.TrimSpace(html) == "" {
		return fail("render report html failed", nil)
	}
	projectName := stringValue(reportData, "project_name")
	subject := fmt.Sprintf("BelieveBoy | %s · %s运营报告 · %s", truncateSubject(projectName), frequencyLabel(frequency), reportDateText)

	if email != "" {
		if sender == nil {
			return fail("email sender is not configured", nil)
		}
		if _, err := db.Exec(ctx,
			"update public.scheduled_report_delivery_logs set stage = 'sending' where id = $1", logID); err != nil {
			return fail(fmt.Sprintf("mark sending: %v", err), err)
		}
		if _, err := sender.Send(ctx, mailer.Message{To: email, Subject: subject, HTML: html}); err != nil {
			return fail(fmt.Sprintf("send email: %v", err), err)
		}
	}

	if _, err := db.Exec(ctx,
		"update public.scheduled_report_delivery_logs set status = 'sent', stage = 'done', sent_at = now(), error_message = null where id = $1", logID); err != nil {
		return fail(fmt.Sprintf("mark sent: %v", err), err)
	}
	result.Success = true
	return result, nil
}

func reportMonth(frequency, reportDate string) *string {
	if frequency != "monthly" || len(reportDate) < 7 {
		return nil
	}
	value := reportDate[:7]
	return &value
}

func nullableString(value string) *string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return &value
}

func truncateSubject(projectName string) string {
	runes := []rune(strings.TrimSpace(projectName))
	if len(runes) <= 40 {
		return string(runes)
	}
	return string(runes[:40])
}
