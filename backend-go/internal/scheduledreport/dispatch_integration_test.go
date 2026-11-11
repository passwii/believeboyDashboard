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
	if sender.message.To != "dispatch-test@example.com" || !strings.Contains(sender.message.HTML, "运营报告") {
		t.Fatalf("email message = %#v", sender.message)
	}
	var status, stage string
	if err := db.QueryRow(ctx,
		"select status, stage from public.scheduled_report_delivery_logs where id = $1", result.DeliveryLogID).Scan(&status, &stage); err != nil {
		t.Fatalf("read delivery log: %v", err)
	}
	if status != "sent" || stage != "done" {
		t.Fatalf("delivery log status=%s stage=%s", status, stage)
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
