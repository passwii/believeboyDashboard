package scheduledreport

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/ai"
	"github.com/passwii/believeboyDashboard/backend-go/internal/mailer"
	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
)

type captureSender struct {
	message mailer.Message
}

func (sender *captureSender) Send(_ context.Context, message mailer.Message) (mailer.Result, error) {
	sender.message = message
	return mailer.Result{ID: "test-email-id"}, nil
}

func TestDispatchOneWritesDeliveryLogAndSendsEmail(t *testing.T) {
	databaseURL := strings.TrimSpace(os.Getenv("GO_API_TEST_DATABASE_URL"))
	if databaseURL == "" {
		databaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if databaseURL == "" {
		t.Skip("GO_API_TEST_DATABASE_URL/DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := store.OpenPool(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer pool.Close()
	db := store.NewPGXDB(pool)

	var subscriptionID int64
	if err := db.QueryRow(ctx,
		"insert into public.scheduled_report_subscriptions (user_id, email, project_ids, country, frequency, dispatch_hour, dispatch_minute, enabled) "+
			"values (null, 'dispatch-test@example.com', '3748', 'US', 'daily', 15, 0, true) returning id").Scan(&subscriptionID); err != nil {
		t.Fatalf("create subscription: %v", err)
	}
	defer func() {
		_, _ = db.Exec(context.Background(), "delete from public.scheduled_report_delivery_logs where subscription_id = $1", subscriptionID)
		_, _ = db.Exec(context.Background(), "delete from public.scheduled_report_subscriptions where id = $1", subscriptionID)
	}()

	sender := &captureSender{}
	result, err := DispatchOne(ctx, db, sender, DispatchRequest{
		SubscriptionID: subscriptionID,
		Email:          "dispatch-test@example.com",
		ProjectIDs:     []int64{3748},
		Country:        "US",
		Frequency:      "daily",
		ReportDate:     "2026-11-11",
		TriggeredBy:    "manual",
	})
	if err != nil {
		t.Fatalf("DispatchOne error: %v", err)
	}
	if !result.Success || result.DeliveryLogID == 0 {
		t.Fatalf("result = %#v", result)
	}
	if !result.EmailSent {
		t.Fatalf("EmailSent = false, want true when the subscription has an email: %#v", result)
	}
	if sender.message.To != "dispatch-test@example.com" || !strings.Contains(sender.message.HTML, "运营报告") {
		t.Fatalf("email message = %#v", sender.message)
	}
	var status, stage, aiSummaryStatus, aiSummary string
	var sentAt *time.Time
	if err := db.QueryRow(ctx,
		"select status, stage, ai_summary_status, coalesce(ai_summary, ''), sent_at "+
			"from public.scheduled_report_delivery_logs where id = $1", result.DeliveryLogID).
		Scan(&status, &stage, &aiSummaryStatus, &aiSummary, &sentAt); err != nil {
		t.Fatalf("read delivery log: %v", err)
	}
	if status != "sent" || stage != "done" {
		t.Fatalf("delivery log status=%s stage=%s", status, stage)
	}
	if sentAt == nil {
		t.Fatalf("sent_at = nil, want a timestamp when an email was sent")
	}
	if aiSummaryStatus != "done" || strings.TrimSpace(aiSummary) == "" {
		t.Fatalf("ai_summary_status=%q ai_summary=%q, want fallback summary done", aiSummaryStatus, aiSummary)
	}
	for _, frequency := range []string{"weekly", "monthly"} {
		sender := &captureSender{}
		monthlyResult, err := DispatchOne(ctx, db, sender, DispatchRequest{
			SubscriptionID: subscriptionID,
			Email:          "dispatch-test@example.com",
			ProjectIDs:     []int64{3748},
			Country:        "US",
			Frequency:      frequency,
			ReportDate:     "2026-11-11",
			TriggeredBy:    "manual",
		})
		if err != nil {
			t.Fatalf("DispatchOne(%s) error: %v", frequency, err)
		}
		if !monthlyResult.Success || monthlyResult.DeliveryLogID == 0 {
			t.Fatalf("DispatchOne(%s) result = %#v", frequency, monthlyResult)
		}
		if sender.message.Subject == "" || !strings.Contains(sender.message.HTML, "运营报告") {
			t.Fatalf("DispatchOne(%s) email = %#v", frequency, sender.message)
		}
	}
}

type fakeAIProvider struct{}

func (provider *fakeAIProvider) Configured() bool { return true }

func (provider *fakeAIProvider) AvailableModels(context.Context) ([]string, error) {
	return []string{"fake-model"}, nil
}

func (provider *fakeAIProvider) Complete(context.Context, ai.ChatRequest) (string, ai.Usage, error) {
	return "AI 摘要测试", ai.Usage{}, nil
}

func (provider *fakeAIProvider) Stream(context.Context, ai.ChatRequest, func(ai.Chunk) error) (ai.Usage, error) {
	return ai.Usage{}, nil
}

func TestScheduledReportLocationUsesAsiaShanghai(t *testing.T) {
	if got := scheduledReportLocation().String(); got != "Asia/Shanghai" {
		t.Fatalf("scheduledReportLocation() = %q, want Asia/Shanghai", got)
	}
}

func openScheduledReportTestDB(t *testing.T) (context.Context, store.FullDB) {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("GO_API_TEST_DATABASE_URL"))
	if databaseURL == "" {
		databaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if databaseURL == "" {
		t.Skip("GO_API_TEST_DATABASE_URL/DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	pool, err := store.OpenPool(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	t.Cleanup(pool.Close)
	return ctx, store.NewPGXDB(pool)
}

// Production evidence: 22/23 subscriptions have email=NULL. The dispatcher
// must still create a delivery log, report and fallback summary; only the
// outbound email is skipped, and sent_at stays NULL so the ledger does not
// claim an email was delivered.
func TestDispatchOneWithoutEmailStillGeneratesDeliveryLog(t *testing.T) {
	ctx, db := openScheduledReportTestDB(t)

	var subscriptionID int64
	if err := db.QueryRow(ctx,
		"insert into public.scheduled_report_subscriptions (user_id, email, project_ids, country, frequency, dispatch_hour, dispatch_minute, enabled) "+
			"values (null, null, '3748', 'US', 'daily', 15, 0, true) returning id").Scan(&subscriptionID); err != nil {
		t.Fatalf("create subscription: %v", err)
	}
	t.Cleanup(func() {
		_, _ = db.Exec(context.Background(), "delete from public.scheduled_report_delivery_logs where subscription_id = $1", subscriptionID)
		_, _ = db.Exec(context.Background(), "delete from public.scheduled_report_subscriptions where id = $1", subscriptionID)
	})

	sender := &captureSender{}
	result, err := DispatchOne(ctx, db, sender, DispatchRequest{
		SubscriptionID: subscriptionID,
		ProjectIDs:     []int64{3748},
		Country:        "US",
		Frequency:      "daily",
		ReportDate:     "2026-11-11",
		TriggeredBy:    "auto",
	})
	if err != nil {
		t.Fatalf("DispatchOne without email error: %v", err)
	}
	if !result.Success || result.DeliveryLogID == 0 {
		t.Fatalf("result = %#v, want a successful generation-only run", result)
	}
	if result.EmailSent {
		t.Fatalf("EmailSent = true, want false for a no-email dispatch")
	}
	if sender.message.To != "" || sender.message.Subject != "" {
		t.Fatalf("mailer was called for a no-email dispatch: %#v", sender.message)
	}

	var status, stage, aiSummaryStatus, aiSummary, email string
	var sentAt *time.Time
	if err := db.QueryRow(ctx,
		"select status, stage, ai_summary_status, coalesce(ai_summary, ''), coalesce(email, ''), sent_at "+
			"from public.scheduled_report_delivery_logs where id = $1", result.DeliveryLogID).
		Scan(&status, &stage, &aiSummaryStatus, &aiSummary, &email, &sentAt); err != nil {
		t.Fatalf("read delivery log: %v", err)
	}
	if status != "sent" || stage != "done" {
		t.Fatalf("delivery log status=%q stage=%q", status, stage)
	}
	if sentAt != nil {
		t.Fatalf("sent_at = %v, want NULL for a generation-only run", sentAt)
	}
	if aiSummaryStatus != "done" || strings.TrimSpace(aiSummary) == "" {
		t.Fatalf("ai_summary_status=%q ai_summary=%q, want fallback summary persisted as done", aiSummaryStatus, aiSummary)
	}
	if email != "" {
		t.Fatalf("delivery log email = %q, want empty", email)
	}

	var count int
	if err := db.QueryRow(ctx,
		"select count(*) from public.scheduled_report_delivery_logs where subscription_id = $1", subscriptionID).Scan(&count); err != nil {
		t.Fatalf("count delivery logs: %v", err)
	}
	if count != 1 {
		t.Fatalf("delivery logs = %d, want exactly 1", count)
	}
}

// The ledger resend path pre-creates the delivery log and returns its id to
// the polling API. DispatchOne must advance that row instead of inserting a
// second log (which left the pre-created row stuck at stage=preparing), and
// skip_email must suppress mail even when the subscription has an address.
func TestDispatchOneReusesPreExistingLogAndSkipsEmail(t *testing.T) {
	ctx, db := openScheduledReportTestDB(t)

	var subscriptionID int64
	const ownerEmail = "pre-existing-test@example.com"
	if err := db.QueryRow(ctx,
		"insert into public.scheduled_report_subscriptions (user_id, email, project_ids, country, frequency, dispatch_hour, dispatch_minute, enabled) "+
			"values (null, $1, '3748', 'US', 'daily', 15, 0, true) returning id", ownerEmail).Scan(&subscriptionID); err != nil {
		t.Fatalf("create subscription: %v", err)
	}
	t.Cleanup(func() {
		_, _ = db.Exec(context.Background(), "delete from public.scheduled_report_delivery_logs where subscription_id = $1", subscriptionID)
		_, _ = db.Exec(context.Background(), "delete from public.scheduled_report_subscriptions where id = $1", subscriptionID)
	})

	var preExistingLogID int64
	if err := db.QueryRow(ctx,
		"insert into public.scheduled_report_delivery_logs "+
			"(subscription_id, frequency, report_date, report_month, email, triggered_by, status, stage, ai_summary_status) "+
			"values ($1, 'daily', '2026-11-12', null, $2, 'manual', 'pending', 'preparing', 'pending') returning id",
		subscriptionID, ownerEmail).Scan(&preExistingLogID); err != nil {
		t.Fatalf("pre-create delivery log: %v", err)
	}

	sender := &captureSender{}
	result, err := DispatchOne(ctx, db, sender, DispatchRequest{
		SubscriptionID:   subscriptionID,
		Email:            ownerEmail,
		ProjectIDs:       []int64{3748},
		Country:          "US",
		Frequency:        "daily",
		ReportDate:       "2026-11-12",
		TriggeredBy:      "manual",
		SkipEmail:        true,
		PreExistingLogID: &preExistingLogID,
	})
	if err != nil {
		t.Fatalf("DispatchOne pre-existing log error: %v", err)
	}
	if !result.Success || result.DeliveryLogID != preExistingLogID {
		t.Fatalf("result = %#v, want reuse of pre-existing log %d", result, preExistingLogID)
	}
	if result.EmailSent {
		t.Fatalf("EmailSent = true, want false when skip_email is set")
	}
	if sender.message.To != "" {
		t.Fatalf("skip_email still mailed %q", sender.message.To)
	}

	var count int
	if err := db.QueryRow(ctx,
		"select count(*) from public.scheduled_report_delivery_logs where subscription_id = $1", subscriptionID).Scan(&count); err != nil {
		t.Fatalf("count delivery logs: %v", err)
	}
	if count != 1 {
		t.Fatalf("delivery logs = %d, want 1 (DispatchOne must UPDATE the pre-created row)", count)
	}

	var status, stage, aiSummaryStatus, aiSummary string
	var sentAt *time.Time
	if err := db.QueryRow(ctx,
		"select status, stage, ai_summary_status, coalesce(ai_summary, ''), sent_at "+
			"from public.scheduled_report_delivery_logs where id = $1", preExistingLogID).
		Scan(&status, &stage, &aiSummaryStatus, &aiSummary, &sentAt); err != nil {
		t.Fatalf("read pre-existing delivery log: %v", err)
	}
	if status != "sent" || stage != "done" {
		t.Fatalf("pre-existing log status=%q stage=%q, want sent/done", status, stage)
	}
	if sentAt != nil {
		t.Fatalf("sent_at = %v, want NULL when skip_email is set", sentAt)
	}
	if aiSummaryStatus != "done" || strings.TrimSpace(aiSummary) == "" {
		t.Fatalf("ai_summary_status=%q ai_summary=%q, want fallback summary persisted", aiSummaryStatus, aiSummary)
	}
}

func TestGenerateDeliverySummaryWritesAISummary(t *testing.T) {
	databaseURL := strings.TrimSpace(os.Getenv("GO_API_TEST_DATABASE_URL"))
	if databaseURL == "" {
		databaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if databaseURL == "" {
		t.Skip("GO_API_TEST_DATABASE_URL/DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := store.OpenPool(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer pool.Close()
	db := store.NewPGXDB(pool)

	var subscriptionID int64
	if err := db.QueryRow(ctx,
		"insert into public.scheduled_report_subscriptions (user_id, email, project_ids, country, frequency, dispatch_hour, dispatch_minute, enabled) "+
			"values (null, 'summary-test@example.com', '3748', 'US', 'daily', 15, 0, true) returning id").Scan(&subscriptionID); err != nil {
		t.Fatalf("create subscription: %v", err)
	}
	defer func() {
		_, _ = db.Exec(context.Background(), "delete from public.scheduled_report_delivery_logs where subscription_id = $1", subscriptionID)
		_, _ = db.Exec(context.Background(), "delete from public.scheduled_report_subscriptions where id = $1", subscriptionID)
	}()
	sender := &captureSender{}
	dispatchResult, err := DispatchOne(ctx, db, sender, DispatchRequest{
		SubscriptionID: subscriptionID, Email: "summary-test@example.com",
		ProjectIDs: []int64{3748}, Country: "US", Frequency: "daily",
		ReportDate: "2026-11-11", TriggeredBy: "manual",
	})
	if err != nil {
		t.Fatalf("DispatchOne error: %v", err)
	}
	result, err := GenerateDeliverySummary(ctx, db, &fakeAIProvider{}, SummaryRequest{LogID: dispatchResult.DeliveryLogID})
	if err != nil {
		t.Fatalf("GenerateDeliverySummary error: %v", err)
	}
	if result["ai_summary"] != "AI 摘要测试" {
		t.Fatalf("result = %#v", result)
	}
	var summary string
	var status string
	if err := db.QueryRow(ctx,
		"select coalesce(ai_summary, ''), ai_summary_status from public.scheduled_report_delivery_logs where id = $1",
		dispatchResult.DeliveryLogID).Scan(&summary, &status); err != nil {
		t.Fatalf("read delivery log: %v", err)
	}
	if summary != "AI 摘要测试" || status != "done" {
		t.Fatalf("summary=%q status=%q", summary, status)
	}
}
