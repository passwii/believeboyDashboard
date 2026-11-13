package store

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/crm"
)

func TestCRMStoreIntegrationAgainstBLFTest(t *testing.T) {
	databaseURL := os.Getenv("GO_API_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set GO_API_TEST_DATABASE_URL to a BLF_test connection")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	pool, err := OpenPool(ctx, databaseURL)
	if err != nil {
		t.Fatalf("OpenPool() error = %v", err)
	}
	t.Cleanup(pool.Close)
	if err := pool.Ping(ctx); err != nil {
		t.Skipf("test database unavailable: %v", err)
	}
	sfx := fmt.Sprintf("%d", time.Now().UnixNano())
	var userID string
	if err := pool.QueryRow(ctx, `
		insert into public.user_accounts
			(name, email, password_hash, full_name, role_type, is_active)
		values ($1, $2, 'integration-only-password-hash', $3, 'operator', true)
		returning id::text
	`, "crm-store-"+sfx, "crm-store-"+sfx+"@example.invalid", "CRM 集成测试").
		Scan(&userID); err != nil {
		t.Fatalf("insert test user: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cleanupCancel()
		_, _ = pool.Exec(cleanupCtx, `delete from public.crm_proposals where owner_id = $1 or created_by = $1`, userID)
		_, _ = pool.Exec(cleanupCtx, `delete from public.crm_tasks where owner_id = $1 or created_by = $1`, userID)
		_, _ = pool.Exec(cleanupCtx, `delete from public.crm_follows where created_by = $1`, userID)
		_, _ = pool.Exec(cleanupCtx, `delete from public.crm_reminder_logs where owner_id = $1`, userID)
		_, _ = pool.Exec(cleanupCtx, `delete from public.crm_saved_views where owner_id = $1`, userID)
		_, _ = pool.Exec(cleanupCtx, `delete from public.crm_rules where created_by = $1`, userID)
		_, _ = pool.Exec(cleanupCtx, `delete from public.crm_categories where name = $1`, "集成类目 "+sfx)
		_, _ = pool.Exec(cleanupCtx, `delete from public.crm_customers where owner_id = $1 or created_by = $1`, userID)
		_, _ = pool.Exec(cleanupCtx, `delete from public.crm_leads where owner_id = $1 or created_by = $1`, userID)
		_, _ = pool.Exec(cleanupCtx, `delete from public.crm_audit_logs where actor_id = $1`, userID)
		_, _ = pool.Exec(cleanupCtx, `delete from public.user_accounts where id::text = $1`, userID)
	})

	store := NewCRMStore(NewPGXDB(pool))
	customer, err := store.CreateCustomer(ctx, crm.CustomerCreateInput{
		Name:         "CRM 集成客户 " + sfx,
		ContactName:  ptr("张总"),
		ContactPhone: ptr("13800001111"),
	}, userID)
	if err != nil {
		t.Fatalf("CreateCustomer() error = %v", err)
	}
	if customer.ID == 0 || customer.OwnerID == nil || *customer.OwnerID != userID ||
		customer.Categories == nil {
		t.Fatalf("created customer = %#v", customer)
	}
	importResult, err := store.ImportCustomersToSea(ctx, []crm.CustomerSeaImportRow{
		{Name: "公海导入 " + sfx, Source: ptr("referral"), ContactName: ptr("王总")},
		{Name: "公海导入 " + sfx, Source: ptr("referral"), ContactName: ptr("王总")},
	}, userID)
	if err != nil || importResult.Created != 1 || importResult.SkippedDupes != 1 {
		t.Fatalf("ImportCustomersToSea() = %#v, %v", importResult, err)
	}

	contact, err := store.CreateContact(ctx, customer.ID, crm.ContactCreateInput{
		Name: "李经理", Phone: ptr("13900002222"),
	}, userID)
	if err != nil || contact == nil || contact.IsPrimary {
		t.Fatalf("CreateContact() = %#v, %v", contact, err)
	}
	updatedContact, err := store.UpdateContact(ctx, contact.ID, crm.ContactUpdateInput{
		Title: crm.Optional[string]{Set: true, Value: ptr("采购经理")},
	}, userID)
	if err != nil || updatedContact == nil || updatedContact.Title == nil ||
		*updatedContact.Title != "采购经理" {
		t.Fatalf("UpdateContact() = %#v, %v", updatedContact, err)
	}
	noOpContact, err := store.UpdateContact(ctx, contact.ID, crm.ContactUpdateInput{}, userID)
	if err != nil || noOpContact == nil {
		t.Fatalf("UpdateContact(no-op) = %#v, %v", noOpContact, err)
	}
	// Negative ids cannot exist; using 1<<62 would overflow the int4 column
	// before the query even runs.
	missingID := int64(-1)
	if missing, err := store.UpdateContact(ctx, missingID, crm.ContactUpdateInput{}, userID); err != nil || missing != nil {
		t.Fatalf("UpdateContact(missing) = %#v, %v", missing, err)
	}
	var fakeContactAudits int
	if err := pool.QueryRow(ctx, `
		select count(*) from public.crm_audit_logs
		where actor_id = $1 and entity_type = 'contact' and entity_id = $2
	`, userID, missingID).Scan(&fakeContactAudits); err != nil {
		t.Fatalf("count missing contact audits: %v", err)
	}
	if fakeContactAudits != 0 {
		t.Fatalf("missing contact produced %d audit rows", fakeContactAudits)
	}
	if err := store.DeleteContact(ctx, contact.ID, userID); err != nil {
		t.Fatalf("DeleteContact() error = %v", err)
	}
	contacts, err := store.ListContacts(ctx, customer.ID)
	if err != nil || len(contacts) != 1 || !contacts[0].IsPrimary {
		t.Fatalf("ListContacts() = %#v, %v", contacts, err)
	}
	updatedCustomer, err := store.UpdateCustomer(ctx, customer.ID, crm.CustomerUpdateInput{
		Remark: crm.Optional[string]{Set: true, Value: ptr("集成备注")},
	}, userID)
	if err != nil || updatedCustomer == nil || updatedCustomer.Remark == nil ||
		*updatedCustomer.Remark != "集成备注" {
		t.Fatalf("UpdateCustomer() = %#v, %v", updatedCustomer, err)
	}
	noOpCustomer, err := store.UpdateCustomer(ctx, customer.ID, crm.CustomerUpdateInput{}, userID)
	if err != nil || noOpCustomer == nil {
		t.Fatalf("UpdateCustomer(no-op) = %#v, %v", noOpCustomer, err)
	}
	if missing, err := store.UpdateCustomer(ctx, missingID, crm.CustomerUpdateInput{}, userID); err != nil || missing != nil {
		t.Fatalf("UpdateCustomer(missing) = %#v, %v", missing, err)
	}
	var fakeCustomerAudits int
	if err := pool.QueryRow(ctx, `
		select count(*) from public.crm_audit_logs
		where actor_id = $1 and entity_type = 'customer' and entity_id = $2
	`, userID, missingID).Scan(&fakeCustomerAudits); err != nil {
		t.Fatalf("count missing customer audits: %v", err)
	}
	if fakeCustomerAudits != 0 {
		t.Fatalf("missing customer produced %d audit rows", fakeCustomerAudits)
	}
	if err := store.BatchTransferCustomers(ctx, []int64{customer.ID}, userID, userID); err != nil {
		t.Fatalf("BatchTransferCustomers() error = %v", err)
	}
	if err := store.BatchMoveCustomersToSea(ctx, []int64{customer.ID}, userID, true, userID); err != nil {
		t.Fatalf("BatchMoveCustomersToSea() error = %v", err)
	}
	claimed, err := store.ClaimCustomer(ctx, customer.ID, userID)
	if err != nil || claimed == nil || claimed.OwnerID == nil || *claimed.OwnerID != userID {
		t.Fatalf("ClaimCustomer() = %#v, %v", claimed, err)
	}

	scored, err := store.UpdateCustomerValueScores(ctx, customer.ID, crm.ValueScoresUpdateInput{
		ScoreScale: ptr("A"), ScorePay: ptr("A"), ScoreFit: ptr("A"), ScoreCoop: ptr("A"),
	}, userID)
	if err != nil || scored == nil || scored.Rating != "A" {
		t.Fatalf("UpdateCustomerValueScores() = %#v, %v", scored, err)
	}

	lead, err := store.CreateLead(ctx, crm.LeadCreateInput{
		Name: "集成线索联系人", Company: ptr("集成线索公司"), Source: ptr("referral"),
		OwnerID: &userID,
	}, userID)
	if err != nil {
		t.Fatalf("CreateLead() error = %v", err)
	}
	updatedLead, err := store.UpdateLead(ctx, lead.ID, crm.LeadUpdateInput{
		Intent: crm.Optional[string]{Set: true, Value: ptr("high")},
	}, userID)
	if err != nil || updatedLead == nil || updatedLead.Intent != "high" {
		t.Fatalf("UpdateLead() = %#v, %v", updatedLead, err)
	}
	poolLead, err := store.CreateLead(ctx, crm.LeadCreateInput{
		Name: "池线索 " + sfx, OwnerID: &userID,
	}, userID)
	if err != nil {
		t.Fatalf("CreateLead(pool) error = %v", err)
	}
	if err := store.BatchTransferLeads(ctx, []int64{poolLead.ID, missingID}, userID, userID); err != nil {
		t.Fatalf("BatchTransferLeads() error = %v", err)
	}
	var fakeLeadAudits int
	if err := pool.QueryRow(ctx, `
		select count(*) from public.crm_audit_logs
		where actor_id = $1 and entity_type = 'lead' and entity_id = $2
	`, userID, missingID).Scan(&fakeLeadAudits); err != nil {
		t.Fatalf("count missing lead audits: %v", err)
	}
	if fakeLeadAudits != 0 {
		t.Fatalf("missing lead produced %d audit rows", fakeLeadAudits)
	}
	if err := store.BatchMoveLeadsToPool(ctx, []int64{poolLead.ID}, userID, true, userID); err != nil {
		t.Fatalf("BatchMoveLeadsToPool() error = %v", err)
	}
	claimedLead, err := store.ClaimLead(ctx, poolLead.ID, userID)
	if err != nil || claimedLead == nil || claimedLead.OwnerID == nil ||
		*claimedLead.OwnerID != userID {
		t.Fatalf("ClaimLead() = %#v, %v", claimedLead, err)
	}
	converted, err := store.ConvertLead(ctx, lead.ID, &crm.ConvertLeadInput{
		Name: ptr("转化客户 " + sfx),
	}, userID)
	if err != nil {
		t.Fatalf("ConvertLead() error = %v", err)
	}
	if converted == nil || converted.Lead.Status != "converted" ||
		converted.Lead.ConvertedToCustomerID == nil ||
		converted.Customer.ID != *converted.Lead.ConvertedToCustomerID {
		t.Fatalf("converted = %#v", converted)
	}

	task, err := store.CreateTask(ctx, crm.TaskCreateInput{
		Title: "电话回访", Type: "call", CustomerID: &customer.ID,
	}, userID, false)
	if err != nil {
		t.Fatalf("CreateTask() error = %v", err)
	}
	completed, err := store.CompleteTask(ctx, task.ID, &crm.TaskCompleteInput{
		Note: ptr("已沟通，下周再联系"),
	}, userID)
	if err != nil || completed == nil || completed.Status != "done" ||
		completed.CompletedAt == nil {
		t.Fatalf("CompleteTask() = %#v, %v", completed, err)
	}
	follows, err := store.ListFollows(ctx, "customer", customer.ID)
	if err != nil || len(follows) == 0 || follows[0].Type != "phone" {
		t.Fatalf("ListFollows() = %#v, %v", follows, err)
	}
	if _, err := store.CompleteTask(ctx, task.ID, nil, userID); err == nil {
		t.Fatalf("second CompleteTask() succeeded, want terminal-state conflict")
	}
	nextFollowAt := time.Now().Add(time.Hour)
	createdFollow, err := store.CreateFollow(ctx, crm.FollowCreateInput{
		EntityType: "customer", EntityID: customer.ID, Type: "note",
		Content: "安排下次沟通", NextFollowAt: &nextFollowAt,
	}, userID)
	if err != nil || createdFollow == nil {
		t.Fatalf("CreateFollow() = %#v, %v", createdFollow, err)
	}
	followUps, err := store.ListFollowUps(ctx, "mine", userID, false)
	if err != nil || followUps.TotalCount == 0 {
		t.Fatalf("ListFollowUps() = %#v, %v", followUps, err)
	}
	if _, err := pool.Exec(ctx, `
		insert into public.crm_reminder_logs
			(entity_type, entity_id, reminder_type, owner_id, status, reminded_at)
		values ('customer', $1, 'stale_follow_up', $2, 'active', now())
	`, customer.ID, userID); err != nil {
		t.Fatalf("insert reminder log: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		update public.crm_customers set last_follow_at = now() - interval '10 days'
		where id = $1
	`, customer.ID); err != nil {
		t.Fatalf("age customer follow time: %v", err)
	}
	staleReminders, err := store.ListFollowUpReminders(ctx, userID, 7)
	if err != nil || len(staleReminders) == 0 {
		t.Fatalf("ListFollowUpReminders() = %#v, %v", staleReminders, err)
	}
	remindTask, err := store.CreateTask(ctx, crm.TaskCreateInput{
		Title: "即将到期任务", DueDate: &nextFollowAt, CustomerID: &customer.ID,
	}, userID, false)
	if err != nil {
		t.Fatalf("CreateTask(reminder) error = %v", err)
	}
	if _, err := pool.Exec(ctx, `
		update public.crm_tasks set reminded_at = now() where id = $1
	`, remindTask.ID); err != nil {
		t.Fatalf("mark reminder task: %v", err)
	}
	reminders, err := store.ListTaskReminders(ctx, &userID)
	if err != nil || len(reminders) == 0 {
		t.Fatalf("ListTaskReminders() = %#v, %v", reminders, err)
	}

	category, err := store.CreateCategory(ctx, crm.CategoryCreateInput{
		Name: "集成类目 " + sfx, SortOrder: 99,
	}, userID)
	if err != nil {
		t.Fatalf("CreateCategory() error = %v", err)
	}
	withCategories, err := store.SetCustomerCategories(ctx, customer.ID, []int64{category.ID}, userID)
	if err != nil || len(withCategories.Categories) != 1 ||
		withCategories.Categories[0].ID != category.ID {
		t.Fatalf("SetCustomerCategories() = %#v, %v", withCategories, err)
	}

	rule, err := store.CreateRule(ctx, crm.RuleCreateInput{
		Name: "集成规则 " + sfx, EntityType: "customer", EventType: "stale_follow_up",
		Enabled: true,
		Conditions: []crm.RuleConditionInput{{
			Field: "days_since_created", Operator: "gte", Value: ptr("7"),
		}},
		Actions: []crm.RuleActionInput{{ActionType: "notify_owner"}},
	}, userID)
	if err != nil {
		t.Fatalf("CreateRule() error = %v", err)
	}
	rules, err := store.ListRules(ctx)
	if err != nil || len(rules) == 0 {
		t.Fatalf("ListRules() = %#v, %v", rules, err)
	}
	if err := store.DeleteRule(ctx, rule.ID, userID); err != nil {
		t.Fatalf("DeleteRule() error = %v", err)
	}

	view, err := store.CreateSavedView(ctx, crm.SavedViewCreateInput{
		Name: "集成视图 " + sfx, EntityType: "customer", Scope: "mine",
		Filters: []crm.FilterCondition{{Field: "status", Op: "eq", Value: "active"}},
		SortBy:  "updated_at", SortOrder: "desc",
	}, userID, false)
	if err != nil {
		t.Fatalf("CreateSavedView() error = %v", err)
	}
	views, err := store.ListSavedViews(ctx, ptr("customer"), userID, false)
	if err != nil || len(views) == 0 || views[0].ID != view.ID {
		t.Fatalf("ListSavedViews() = %#v, %v", views, err)
	}
	if err := store.DeleteSavedView(ctx, view.ID, userID, false); err != nil {
		t.Fatalf("DeleteSavedView() error = %v", err)
	}

	stats, err := store.GetDashboardStats(ctx)
	if err != nil || stats.LeadFunnel["converted"] < 1 || len(stats.PerOwner) == 0 {
		t.Fatalf("GetDashboardStats() = %#v, %v", stats, err)
	}
	funnel, err := store.GetFunnelMetrics(ctx, "owner", nil, nil, nil, nil)
	if err != nil || len(funnel.Items) == 0 {
		t.Fatalf("GetFunnelMetrics() = %#v, %v", funnel, err)
	}
	stage, err := store.GetStageDetail(ctx, "converted", "dwell", 7, nil, nil, nil, nil, 1, 50)
	if err != nil || stage.Count < 1 {
		t.Fatalf("GetStageDetail() = %#v, %v", stage, err)
	}
	performance, err := store.GetPerformanceBoard(ctx, "mine", "converted_count", nil, userID)
	if err != nil || performance.Mine.ConvertedCount < 1 {
		t.Fatalf("GetPerformanceBoard() = %#v, %v", performance, err)
	}
	lifecycle, err := store.GetLifecycleBoard(ctx)
	if err != nil || lifecycle.NowInSea < 0 {
		t.Fatalf("GetLifecycleBoard() = %#v, %v", lifecycle, err)
	}

	storage, err := NewLocalProposalStorage(t.TempDir())
	if err != nil {
		t.Fatalf("NewLocalProposalStorage() error = %v", err)
	}
	upload, err := store.CreateProposal(ctx, crm.ProposalCreateInput{
		Title: ptr("集成方案 " + sfx), ProposalType: "other", CustomerID: &customer.ID,
		Filename: "proposal.html", ContentType: "text/html",
		RawBytes:     []byte("<html><body>proposal</body></html>"),
		AdaptedBytes: []byte("<html><head></head><body>proposal</body></html>"),
	}, userID, false, storage)
	if err != nil {
		t.Fatalf("CreateProposal() error = %v", err)
	}
	detail, err := store.GetProposal(ctx, upload.Proposal.ID)
	if err != nil || detail == nil || len(detail.Versions) != 1 {
		t.Fatalf("GetProposal() = %#v, %v", detail, err)
	}
	noOpProposal, err := store.UpdateProposal(ctx, upload.Proposal.ID, crm.ProposalUpdateInput{}, userID, false)
	if err != nil || noOpProposal == nil {
		t.Fatalf("UpdateProposal(no-op) = %#v, %v", noOpProposal, err)
	}
	if missing, err := store.UpdateProposal(ctx, missingID, crm.ProposalUpdateInput{}, userID, false); err != nil || missing != nil {
		t.Fatalf("UpdateProposal(missing) = %#v, %v", missing, err)
	}
	var fakeProposalAudits int
	if err := pool.QueryRow(ctx, `
		select count(*) from public.crm_audit_logs
		where actor_id = $1 and entity_type = 'proposal' and entity_id = $2
	`, userID, missingID).Scan(&fakeProposalAudits); err != nil {
		t.Fatalf("count missing proposal audits: %v", err)
	}
	if fakeProposalAudits != 0 {
		t.Fatalf("missing proposal produced %d audit rows", fakeProposalAudits)
	}
	record, err := store.GetProposalVersionRecord(ctx, upload.Proposal.ID, 1)
	if err != nil || record == nil {
		t.Fatalf("GetProposalVersionRecord() = %#v, %v", record, err)
	}
	object, err := storage.GetObject(ctx, record.AdaptedKey)
	if err != nil || len(object) == 0 {
		t.Fatalf("proposal object = %q, %v", object, err)
	}
	version2, err := store.AddProposalVersion(ctx, upload.Proposal.ID, crm.ProposalAddVersionInput{
		Filename: "proposal-v2.pdf", ContentType: "application/octet-stream",
		RawBytes: []byte("%PDF-1.7 test"), ChangeNote: ptr("第二版"),
	}, userID, storage)
	if err != nil || version2.Version.VersionNo != 2 ||
		version2.Proposal.CurrentVersionNo != 2 {
		t.Fatalf("AddProposalVersion() = %#v, %v", version2, err)
	}
	if err := store.DeleteProposal(ctx, upload.Proposal.ID, userID, storage); err != nil {
		t.Fatalf("DeleteProposal() error = %v", err)
	}
	if _, err := store.GetProposal(ctx, upload.Proposal.ID); err != nil {
		t.Fatalf("GetProposal after delete error = %v", err)
	}

	audit, err := store.ListAuditLogs(ctx, crm.AuditLogFilter{
		ActorID: &userID, Page: 1, PageSize: 100,
	})
	if err != nil || audit.Total == 0 {
		t.Fatalf("ListAuditLogs() = %#v, %v", audit, err)
	}
}
