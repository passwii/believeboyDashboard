package amazon_review_tracking

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type mockAmazonReviewStore struct {
	adminAccount       *SessionAccount
	operatorAccount    *SessionAccount
	businessAccount    *SessionAccount
	inactiveAccount    *SessionAccount
	groups             []ReviewGroupItem
	group              *ReviewGroupItem
	mutation           *ReviewGroupMutation
	targets            []TargetItem
	snapshots          []RatingSnapshotItem
	reviews            []ReviewItem
	runs               []CrawlRunItem
	externalTargets    []ExternalTargetItem
	externalTarget     *ExternalTargetItem
	externalLink       *ExternalLinkItem
	createGroupErr     error
	patchGroupErr      error
	deactivateErr      error
	listTargetsErr     error
	snapshotsErr       error
	reviewsErr         error
	runsErr            error
	externalTargetErr  error
	addLinkErr         error
	removeLinkErr      error
	lastTargetFilter   *TargetListFilter
	lastSnapshotFilter *RatingSnapshotFilter
	lastReviewFilter   *ReviewFilter
	lastRunFilter      *CrawlRunFilter
}

func (m *mockAmazonReviewStore) GetSessionAccount(_ context.Context, userID string) (*SessionAccount, error) {
	switch userID {
	case "admin":
		return m.adminAccount, nil
	case "operator":
		return m.operatorAccount, nil
	case "business":
		return m.businessAccount, nil
	case "inactive":
		return m.inactiveAccount, nil
	default:
		return nil, nil
	}
}

func (m *mockAmazonReviewStore) ListGroups(_ context.Context, _ GroupListFilter) ([]ReviewGroupItem, error) {
	return m.groups, nil
}

func (m *mockAmazonReviewStore) CreateGroup(_ context.Context, input ReviewGroupCreateInput) (*ReviewGroupItem, error) {
	if m.createGroupErr != nil {
		return nil, m.createGroupErr
	}
	if m.group != nil {
		return m.group, nil
	}
	return &ReviewGroupItem{
		ID: 1, ProjectID: input.ProjectID, Marketplace: input.Marketplace,
		Name: input.Name, Description: input.Description,
		RepresentativeID: amazonReviewHandlerInt64Pointer(input.RepresentativeID),
		MemberIDs:        input.MemberIDs, IsActive: true,
	}, nil
}

func (m *mockAmazonReviewStore) PatchGroup(_ context.Context, _ int64, _ ReviewGroupPatchInput) (*ReviewGroupMutation, error) {
	if m.patchGroupErr != nil {
		return nil, m.patchGroupErr
	}
	return m.mutation, nil
}

func (m *mockAmazonReviewStore) DeactivateGroup(_ context.Context, _ int64) (*ReviewGroupMutation, error) {
	if m.deactivateErr != nil {
		return nil, m.deactivateErr
	}
	return m.mutation, nil
}

func (m *mockAmazonReviewStore) ListTargets(_ context.Context, filter TargetListFilter) ([]TargetItem, error) {
	m.lastTargetFilter = &filter
	items := m.targets
	if m.listTargetsErr != nil {
		return nil, m.listTargetsErr
	}
	return items, nil
}

func (m *mockAmazonReviewStore) ListRatingSnapshots(_ context.Context, filter RatingSnapshotFilter) ([]RatingSnapshotItem, error) {
	m.lastSnapshotFilter = &filter
	if m.snapshotsErr != nil {
		return nil, m.snapshotsErr
	}
	return m.snapshots, nil
}

func (m *mockAmazonReviewStore) ListReviews(_ context.Context, filter ReviewFilter) ([]ReviewItem, error) {
	m.lastReviewFilter = &filter
	if m.reviewsErr != nil {
		return nil, m.reviewsErr
	}
	return m.reviews, nil
}

func (m *mockAmazonReviewStore) ListRuns(_ context.Context, filter CrawlRunFilter) ([]CrawlRunItem, error) {
	m.lastRunFilter = &filter
	if m.runsErr != nil {
		return nil, m.runsErr
	}
	return m.runs, nil
}

func (m *mockAmazonReviewStore) ListExternalTargets(_ context.Context, _, _ int64) ([]ExternalTargetItem, error) {
	return m.externalTargets, nil
}

func (m *mockAmazonReviewStore) CreateExternalTarget(_ context.Context, _ ExternalTargetCreateInput) (*ExternalTargetItem, error) {
	if m.externalTargetErr != nil {
		return nil, m.externalTargetErr
	}
	return m.externalTarget, nil
}

func (m *mockAmazonReviewStore) AddExternalLink(_ context.Context, _, _ int64) (*ExternalLinkItem, error) {
	if m.addLinkErr != nil {
		return nil, m.addLinkErr
	}
	return m.externalLink, nil
}

func (m *mockAmazonReviewStore) RemoveExternalLink(_ context.Context, _, _ int64) (*ExternalLinkItem, error) {
	if m.removeLinkErr != nil {
		return nil, m.removeLinkErr
	}
	return m.externalLink, nil
}

func (m *mockAmazonReviewStore) RunInTx(
	ctx context.Context,
	fn func(context.Context, pgx.Tx, Store) error,
) error {
	return fn(ctx, nil, m)
}

type mockAmazonReviewAuditor struct {
	entries []audit.Entry
	err     error
}

func (m *mockAmazonReviewAuditor) LogAction(_ context.Context, entry audit.Entry) error {
	m.entries = append(m.entries, entry)
	return m.err
}

func (m *mockAmazonReviewAuditor) LogActionTx(_ context.Context, _ pgx.Tx, entry audit.Entry) error {
	m.entries = append(m.entries, entry)
	return m.err
}

func (m *mockAmazonReviewAuditor) LogView(_ context.Context, _ string, _ string, _ *string, _ any, _ *http.Request) error {
	return nil
}

func setupAmazonReviewRouter(store Store, auditor audit.Service) http.Handler {
	router := chi.NewRouter()
	NewRegistrar(store, auditor).RegisterRoutes(router, func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			identity := auth.UserContextFromRequest(r)
			ctx := auth.WithUserContext(r.Context(), identity)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	})
	return router
}

func seedAmazonReviewMock() *mockAmazonReviewStore {
	description := "共享组"
	representativeID := int64(101)
	group := &ReviewGroupItem{
		ID: 1, ProjectID: 10, Marketplace: "US", Name: "Core",
		Description: &description, RepresentativeID: &representativeID,
		MemberIDs: []int64{101, 102}, IsActive: true,
	}
	asin := "B012345678"
	displayName := "Competitor"
	link := &ExternalLinkItem{ID: 9, TargetID: 5, ShopID: 3, IsActive: true}
	return &mockAmazonReviewStore{
		adminAccount:    &SessionAccount{IsAdmin: true, IsActive: true, RoleType: "admin"},
		operatorAccount: &SessionAccount{IsAdmin: false, IsActive: true, RoleType: "operator"},
		businessAccount: &SessionAccount{IsAdmin: false, IsActive: true, RoleType: "businessdev"},
		inactiveAccount: &SessionAccount{IsAdmin: false, IsActive: false, RoleType: "operator"},
		groups:          []ReviewGroupItem{*group},
		group:           group,
		mutation: &ReviewGroupMutation{
			Before: group,
			After: &ReviewGroupItem{
				ID: 1, ProjectID: 10, Marketplace: "US", Name: "Core Updated",
				Description: nil, RepresentativeID: &representativeID,
				MemberIDs: []int64{101}, IsActive: false,
			},
		},
		targets: []TargetItem{{
			ID: 5, Kind: "external_asin", Marketplace: "US",
			ASIN: &asin, DisplayName: &displayName, IsActive: true,
		}},
		snapshots: []RatingSnapshotItem{{
			CaptureDate: "2026-10-21", CapturedAt: "2026-10-21T00:00:00Z",
			RatingCount:      amazonReviewHandlerInt64Pointer(9),
			StarCountQuality: "exact", CaptureStatus: "success",
		}},
		reviews: []ReviewItem{{
			ReviewKey: "R1", IDConfidence: "original",
			FirstSeenAt:      "2026-10-21T00:00:00Z",
			LastSeenAt:       "2026-10-21T00:00:00Z",
			VisibilityStatus: "visible",
		}},
		runs: []CrawlRunItem{{
			ID: 7, StartedAt: "2026-10-21T00:00:00Z", Status: "success",
			IsCompleteList: true, RatingsCaptured: true,
		}},
		externalTargets: []ExternalTargetItem{{
			TargetItem: TargetItem{
				ID: 5, Kind: "external_asin", Marketplace: "US",
				ASIN: &asin, DisplayName: &displayName, IsActive: true,
			},
			Links: []ExternalLinkItem{*link},
		}},
		externalTarget: &ExternalTargetItem{
			TargetItem: TargetItem{
				ID: 5, Kind: "external_asin", Marketplace: "US",
				ASIN: &asin, DisplayName: &displayName, IsActive: true,
			},
			Links: []ExternalLinkItem{*link},
		},
		externalLink: link,
	}
}

func TestAmazonReviewTrackingReadRoutes(t *testing.T) {
	store := seedAmazonReviewMock()
	auditor := &mockAmazonReviewAuditor{}
	router := setupAmazonReviewRouter(store, auditor)

	requests := []struct {
		name       string
		userID     string
		operator   string
		path       string
		wantStatus int
	}{
		{"groups", "admin", "admin", "/api/v1/amazon-review-tracking/groups?project_id=10&marketplace=us", http.StatusOK},
		{"targets", "operator", "operator", "/api/v1/amazon-review-tracking/targets?project_id=10&kind=internal_group&is_active=true&limit=2&offset=0", http.StatusOK},
		{"external targets", "operator", "operator", "/api/v1/amazon-review-tracking/external-targets?limit=1", http.StatusOK},
		{"snapshots", "operator", "operator", "/api/v1/amazon-review-tracking/targets/5/rating-snapshots?from=2026-10-01&to=2026-10-31", http.StatusOK},
		{"reviews", "operator", "operator", "/api/v1/amazon-review-tracking/targets/5/reviews?visibility_status=visible&review_date_from=2026-10-01", http.StatusOK},
		{"runs", "operator", "operator", "/api/v1/amazon-review-tracking/targets/5/runs?limit=1", http.StatusOK},
	}
	for _, test := range requests {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, test.path, nil)
			req.Header.Set("X-User-Id", test.userID)
			req.Header.Set("X-Session-Id", "session-valid")
			req.Header.Set("X-Operator", test.operator)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)
			if rec.Code != test.wantStatus {
				t.Fatalf("GET %s status = %d, want %d; body=%s", test.path, rec.Code, test.wantStatus, rec.Body.String())
			}
			if rec.Code == http.StatusOK {
				assertAmazonReviewJSONArray(t, rec)
			}
		})
	}
	if store.lastTargetFilter == nil ||
		store.lastTargetFilter.Operator != "operator" ||
		store.lastTargetFilter.IsAdmin {
		t.Fatalf("target filter = %#v, want non-admin operator scope", store.lastTargetFilter)
	}
	if store.lastSnapshotFilter == nil || store.lastSnapshotFilter.TargetID != 5 {
		t.Fatalf("snapshot filter = %#v", store.lastSnapshotFilter)
	}
	if store.lastReviewFilter == nil ||
		store.lastReviewFilter.VisibilityStatus == nil ||
		*store.lastReviewFilter.VisibilityStatus != "visible" {
		t.Fatalf("review filter = %#v", store.lastReviewFilter)
	}
	if store.lastRunFilter == nil || store.lastRunFilter.Limit != 1 {
		t.Fatalf("run filter = %#v", store.lastRunFilter)
	}
}

func TestAmazonReviewTrackingWriteRoutesAndAudit(t *testing.T) {
	store := seedAmazonReviewMock()
	auditor := &mockAmazonReviewAuditor{}
	router := setupAmazonReviewRouter(store, auditor)

	body := `{"project_id":10,"marketplace":" us ","name":" Core ","description":"共享组","member_ids":[101,102],"representative_id":101}`
	rec := serveAmazonReviewRequest(router, http.MethodPost, "/api/v1/amazon-review-tracking/groups", body, "admin", "admin")
	if rec.Code != http.StatusCreated {
		t.Fatalf("create group status = %d; body=%s", rec.Code, rec.Body.String())
	}
	assertAmazonReviewJSONObjectKeys(t, rec, "project_id", "member_ids", "representative_id", "is_active")

	body = `{"name":"Core Updated","description":null,"member_ids":[101],"representative_id":101}`
	rec = serveAmazonReviewRequest(router, http.MethodPatch, "/api/v1/amazon-review-tracking/groups/1", body, "admin", "admin")
	if rec.Code != http.StatusOK {
		t.Fatalf("patch group status = %d; body=%s", rec.Code, rec.Body.String())
	}
	rec = serveAmazonReviewRequest(router, http.MethodPost, "/api/v1/amazon-review-tracking/groups/1/deactivate", "", "admin", "admin")
	if rec.Code != http.StatusOK {
		t.Fatalf("deactivate group status = %d; body=%s", rec.Code, rec.Body.String())
	}

	body = `{"marketplace":" us ","asin":" b012345678 ","shop_id":3,"display_name":" Competitor "}`
	rec = serveAmazonReviewRequest(router, http.MethodPost, "/api/v1/amazon-review-tracking/external-targets", body, "admin", "admin")
	if rec.Code != http.StatusCreated {
		t.Fatalf("create external target status = %d; body=%s", rec.Code, rec.Body.String())
	}
	assertAmazonReviewJSONObjectKeys(t, rec, "kind", "asin", "links", "is_active")

	rec = serveAmazonReviewRequest(router, http.MethodPost, "/api/v1/amazon-review-tracking/targets/5/external-links", `{"shop_id":3}`, "admin", "admin")
	if rec.Code != http.StatusCreated {
		t.Fatalf("create external link status = %d; body=%s", rec.Code, rec.Body.String())
	}
	rec = serveAmazonReviewRequest(router, http.MethodDelete, "/api/v1/amazon-review-tracking/targets/5/external-links/9", "", "admin", "admin")
	if rec.Code != http.StatusOK {
		t.Fatalf("delete external link status = %d; body=%s", rec.Code, rec.Body.String())
	}

	wantActions := []string{
		"amazon_review_tracking.group.create",
		"amazon_review_tracking.group.update",
		"amazon_review_tracking.group.deactivate",
		"amazon_review_tracking.external_target.create",
		"amazon_review_tracking.external_link.add",
		"amazon_review_tracking.external_link.remove",
	}
	if len(auditor.entries) != len(wantActions) {
		t.Fatalf("audit entries = %d, want %d", len(auditor.entries), len(wantActions))
	}
	for index, action := range wantActions {
		if auditor.entries[index].Action != action {
			t.Errorf("audit[%d] action = %q, want %q", index, auditor.entries[index].Action, action)
		}
	}
}

func TestAmazonReviewTrackingPermissionsAndValidation(t *testing.T) {
	store := seedAmazonReviewMock()
	auditor := &mockAmazonReviewAuditor{}
	router := setupAmazonReviewRouter(store, auditor)

	rec := serveAmazonReviewRequest(router, http.MethodGet, "/api/v1/amazon-review-tracking/targets", "", "", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("missing session status = %d, want 401", rec.Code)
	}

	rec = serveAmazonReviewRequest(router, http.MethodGet, "/api/v1/amazon-review-tracking/targets", "", "inactive", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("inactive status = %d, want 401", rec.Code)
	}

	rec = serveAmazonReviewRequest(router, http.MethodGet, "/api/v1/amazon-review-tracking/targets", "", "business", "business")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("business role status = %d, want 403", rec.Code)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/amazon-review-tracking/groups", nil)
	req.Header.Set("X-User-Id", "operator")
	req.Header.Set("X-Session-Id", "session-valid")
	req.Header.Set("X-Operator", "operator")
	req.Header.Set("X-Is-Admin", "true")
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("X-Is-Admin escalation status = %d, want 403; body=%s", rec.Code, rec.Body.String())
	}

	rec = serveAmazonReviewRequest(router, http.MethodPost, "/api/v1/amazon-review-tracking/groups", `{"project_id":10}`, "operator", "operator")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("operator group write status = %d, want 403", rec.Code)
	}

	for _, path := range []string{
		"/api/v1/amazon-review-tracking/targets?limit=0",
		"/api/v1/amazon-review-tracking/targets?limit=1001",
		"/api/v1/amazon-review-tracking/targets?offset=-1",
		"/api/v1/amazon-review-tracking/targets/5/rating-snapshots?from=bad-date",
	} {
		rec = serveAmazonReviewRequest(router, http.MethodGet, path, "", "operator", "operator")
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("invalid query %s status = %d, want 422; body=%s", path, rec.Code, rec.Body.String())
		}
	}

	for _, body := range []string{
		`{"project_id":10,"marketplace":"US","name":"Core","member_ids":[],"representative_id":101}`,
		`{"project_id":10,"marketplace":"ZZ","name":"Core","member_ids":[101],"representative_id":101}`,
		`{"project_id":10,"marketplace":"US","name":"Core","member_ids":[101],"representative_id":102}`,
		`{"project_id":10,"marketplace":"US","name":"Core","member_ids":[101],"representative_id":101,"extra":true}`,
	} {
		rec = serveAmazonReviewRequest(router, http.MethodPost, "/api/v1/amazon-review-tracking/groups", body, "admin", "admin")
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("invalid create group body %s status = %d, want 422; body=%s", body, rec.Code, rec.Body.String())
		}
	}

	for _, body := range []string{`{}`, `{"name":null}`, `{"member_ids":[]}`, `{"representative_id":null}`} {
		rec = serveAmazonReviewRequest(router, http.MethodPatch, "/api/v1/amazon-review-tracking/groups/1", body, "admin", "admin")
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("invalid patch body %s status = %d, want 422; body=%s", body, rec.Code, rec.Body.String())
		}
	}

	rec = serveAmazonReviewRequest(router, http.MethodPost, "/api/v1/amazon-review-tracking/external-targets", `{"marketplace":"US","asin":"short"}`, "admin", "admin")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bad ASIN status = %d, want 422", rec.Code)
	}
	store.externalTargetErr = NewError(http.StatusUnprocessableEntity, "shop not found")
	rec = serveAmazonReviewRequest(
		router, http.MethodPost, "/api/v1/amazon-review-tracking/external-targets",
		`{"marketplace":"US","asin":"B012345678","shop_id":999}`,
		"admin", "admin",
	)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("missing shop status = %d, want 422", rec.Code)
	}
	store.externalTargetErr = nil

	store.createGroupErr = NewError(http.StatusConflict, "active review group with this name already exists")
	rec = serveAmazonReviewRequest(
		router, http.MethodPost, "/api/v1/amazon-review-tracking/groups",
		`{"project_id":10,"marketplace":"US","name":"Core","member_ids":[101],"representative_id":101}`,
		"admin", "admin",
	)
	if rec.Code != http.StatusConflict {
		t.Fatalf("group conflict status = %d, want 409", rec.Code)
	}
	store.createGroupErr = nil

	store.addLinkErr = NewError(http.StatusUnprocessableEntity, "external target not found")
	rec = serveAmazonReviewRequest(router, http.MethodPost, "/api/v1/amazon-review-tracking/targets/1/external-links", `{"shop_id":3}`, "admin", "admin")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("internal target link status = %d, want 422", rec.Code)
	}

	store.removeLinkErr = NewError(http.StatusNotFound, "external link not found")
	rec = serveAmazonReviewRequest(router, http.MethodDelete, "/api/v1/amazon-review-tracking/targets/5/external-links/99", "", "admin", "admin")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing link status = %d, want 404", rec.Code)
	}
	store.removeLinkErr = nil

	store.snapshotsErr = NewError(http.StatusNotFound, "review target not found")
	rec = serveAmazonReviewRequest(router, http.MethodGet, "/api/v1/amazon-review-tracking/targets/999/rating-snapshots", "", "operator", "operator")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing target status = %d, want 404", rec.Code)
	}
	store.snapshotsErr = nil

	rec = serveAmazonReviewRequest(router, http.MethodPost, "/api/v1/amazon-review-tracking/groups", `{`, "admin", "admin")
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("malformed JSON status = %d, want 422", rec.Code)
	}
}

func TestAmazonReviewTrackingAuditFailureRollsBack(t *testing.T) {
	store := seedAmazonReviewMock()
	auditor := &mockAmazonReviewAuditor{err: NewError(http.StatusInternalServerError, "audit failed")}
	router := setupAmazonReviewRouter(store, auditor)

	rec := serveAmazonReviewRequest(
		router, http.MethodPost, "/api/v1/amazon-review-tracking/groups",
		`{"project_id":10,"marketplace":"US","name":"Core","member_ids":[101],"representative_id":101}`,
		"admin", "admin",
	)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("audit failure status = %d, want 500; body=%s", rec.Code, rec.Body.String())
	}
}

func TestAmazonReviewTrackingDeactivateIsIdempotent(t *testing.T) {
	store := seedAmazonReviewMock()
	auditor := &mockAmazonReviewAuditor{}
	router := setupAmazonReviewRouter(store, auditor)
	for attempt := 0; attempt < 2; attempt++ {
		rec := serveAmazonReviewRequest(
			router, http.MethodPost,
			"/api/v1/amazon-review-tracking/groups/1/deactivate",
			"", "admin", "admin",
		)
		if rec.Code != http.StatusOK {
			t.Fatalf("deactivate attempt %d status = %d, want 200", attempt+1, rec.Code)
		}
	}
}

func TestAmazonReviewTrackingModuleName(t *testing.T) {
	registrar := NewRegistrar(seedAmazonReviewMock(), &mockAmazonReviewAuditor{})
	if got := registrar.ModuleName(); got != "amazon_review_tracking" {
		t.Fatalf("ModuleName() = %q, want amazon_review_tracking", got)
	}
}

func TestAmazonReviewTrackingRegistersExactlyTwelveRoutes(t *testing.T) {
	router := chi.NewRouter()
	NewRegistrar(seedAmazonReviewMock(), &mockAmazonReviewAuditor{}).RegisterRoutes(
		router,
		func(next http.Handler) http.Handler { return next },
	)
	count := 0
	err := chi.Walk(router, func(_ string, _ string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		count++
		return nil
	})
	if err != nil {
		t.Fatalf("chi.Walk() error = %v", err)
	}
	if count != 12 {
		t.Fatalf("registered routes = %d, want 12", count)
	}
}

func serveAmazonReviewRequest(
	router http.Handler,
	method string,
	path string,
	body string,
	userID string,
	operator string,
) *httptest.ResponseRecorder {
	var reader *bytes.Reader
	if body == "" {
		reader = bytes.NewReader(nil)
	} else {
		reader = bytes.NewReader([]byte(body))
	}
	req := httptest.NewRequest(method, path, reader)
	if userID != "" {
		req.Header.Set("X-User-Id", userID)
	}
	if userID != "" {
		req.Header.Set("X-Session-Id", "session-valid")
	}
	if operator != "" {
		req.Header.Set("X-Operator", operator)
	}
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func assertAmazonReviewJSONArray(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	var value []any
	if err := json.Unmarshal(rec.Body.Bytes(), &value); err != nil {
		t.Fatalf("response is not a JSON array: %v; body=%s", err, rec.Body.String())
	}
}

func assertAmazonReviewJSONObjectKeys(t *testing.T, rec *httptest.ResponseRecorder, keys ...string) {
	t.Helper()
	var value map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &value); err != nil {
		t.Fatalf("response is not a JSON object: %v; body=%s", err, rec.Body.String())
	}
	for _, key := range keys {
		if _, ok := value[key]; !ok {
			t.Errorf("response missing key %q; body=%s", key, rec.Body.String())
		}
	}
}

func amazonReviewHandlerInt64Pointer(value int64) *int64 {
	return &value
}
