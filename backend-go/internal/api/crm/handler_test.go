package crm

import (
	"net/http"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestCRMRegistrarMatchesPythonRouteInventory(t *testing.T) {
	router := chi.NewRouter()
	NewRegistrar(nil, nil, nil).RegisterRoutes(router, func(next http.Handler) http.Handler {
		return next
	})

	want := []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/v1/crm/customers"},
		{http.MethodGet, "/api/v1/crm/customers/export"},
		{http.MethodPost, "/api/v1/crm/customers"},
		{http.MethodPost, "/api/v1/crm/customers/import-sea"},
		{http.MethodGet, "/api/v1/crm/customers/{customer_id}"},
		{http.MethodPatch, "/api/v1/crm/customers/{customer_id}"},
		{http.MethodPatch, "/api/v1/crm/customers/{customer_id}/value-scores"},
		{http.MethodDelete, "/api/v1/crm/customers/{customer_id}"},
		{http.MethodPost, "/api/v1/crm/customers/batch-transfer"},
		{http.MethodPost, "/api/v1/crm/customers/batch-move-sea"},
		{http.MethodPost, "/api/v1/crm/customers/{customer_id}/claim"},
		{http.MethodGet, "/api/v1/crm/customers/{customer_id}/contacts"},
		{http.MethodPost, "/api/v1/crm/customers/{customer_id}/contacts"},
		{http.MethodPatch, "/api/v1/crm/contacts/{contact_id}"},
		{http.MethodDelete, "/api/v1/crm/contacts/{contact_id}"},
		{http.MethodGet, "/api/v1/crm/users"},
		{http.MethodGet, "/api/v1/crm/users/{user_id}"},
		{http.MethodGet, "/api/v1/crm/leads"},
		{http.MethodGet, "/api/v1/crm/leads/export"},
		{http.MethodPost, "/api/v1/crm/leads"},
		{http.MethodGet, "/api/v1/crm/leads/{lead_id}"},
		{http.MethodPatch, "/api/v1/crm/leads/{lead_id}"},
		{http.MethodPost, "/api/v1/crm/leads/batch-transfer"},
		{http.MethodPost, "/api/v1/crm/leads/batch-move-pool"},
		{http.MethodPost, "/api/v1/crm/leads/{lead_id}/claim"},
		{http.MethodPost, "/api/v1/crm/leads/{lead_id}/convert"},
		{http.MethodGet, "/api/v1/crm/follows"},
		{http.MethodPost, "/api/v1/crm/follows"},
		{http.MethodGet, "/api/v1/crm/follow-ups"},
		{http.MethodGet, "/api/v1/crm/audit-logs"},
		{http.MethodGet, "/api/v1/crm/dashboard/stats"},
		{http.MethodGet, "/api/v1/crm/dashboard/funnel"},
		{http.MethodGet, "/api/v1/crm/dashboard/funnel/stage/{stage}"},
		{http.MethodGet, "/api/v1/crm/dashboard/performance"},
		{http.MethodGet, "/api/v1/crm/dashboard/lifecycle"},
		{http.MethodGet, "/api/v1/crm/tasks"},
		{http.MethodGet, "/api/v1/crm/tasks/reminders/stream"},
		{http.MethodGet, "/api/v1/crm/follow-ups/reminders/stream"},
		{http.MethodPost, "/api/v1/crm/tasks"},
		{http.MethodGet, "/api/v1/crm/tasks/{task_id}"},
		{http.MethodPatch, "/api/v1/crm/tasks/{task_id}"},
		{http.MethodPost, "/api/v1/crm/tasks/{task_id}/status"},
		{http.MethodPost, "/api/v1/crm/tasks/{task_id}/complete"},
		{http.MethodPost, "/api/v1/crm/tasks/{task_id}/cancel"},
		{http.MethodGet, "/api/v1/crm/rules"},
		{http.MethodPost, "/api/v1/crm/rules"},
		{http.MethodPatch, "/api/v1/crm/rules/{rule_id}"},
		{http.MethodDelete, "/api/v1/crm/rules/{rule_id}"},
		{http.MethodGet, "/api/v1/crm/settings/workflow"},
		{http.MethodPut, "/api/v1/crm/settings/workflow"},
		{http.MethodGet, "/api/v1/crm/categories"},
		{http.MethodPost, "/api/v1/crm/categories"},
		{http.MethodPatch, "/api/v1/crm/categories/{category_id}"},
		{http.MethodDelete, "/api/v1/crm/categories/{category_id}"},
		{http.MethodPut, "/api/v1/crm/customers/{customer_id}/categories"},
		{http.MethodGet, "/api/v1/crm/saved-views"},
		{http.MethodPost, "/api/v1/crm/saved-views"},
		{http.MethodPatch, "/api/v1/crm/saved-views/{view_id}"},
		{http.MethodDelete, "/api/v1/crm/saved-views/{view_id}"},
		{http.MethodGet, "/api/v1/crm/proposals"},
		{http.MethodGet, "/api/v1/crm/proposals/{proposal_id}"},
		{http.MethodPost, "/api/v1/crm/proposals/uploads/init"},
		{http.MethodPost, "/api/v1/crm/proposals/{proposal_id}/versions/uploads/init"},
		{http.MethodPost, "/api/v1/crm/proposals/uploads/{upload_id}/chunks/{index}"},
		{http.MethodPost, "/api/v1/crm/proposals/uploads/{upload_id}/finalize"},
		{http.MethodPost, "/api/v1/crm/proposals"},
		{http.MethodPost, "/api/v1/crm/proposals/{proposal_id}/versions"},
		{http.MethodPatch, "/api/v1/crm/proposals/{proposal_id}"},
		{http.MethodDelete, "/api/v1/crm/proposals/{proposal_id}"},
		{http.MethodGet, "/api/v1/crm/proposals/{proposal_id}/versions/{version_no}/content"},
		{http.MethodGet, "/api/v1/crm/proposals/{proposal_id}/versions/{version_no}/download"},
	}

	got := make(map[string]bool, len(want))
	if err := chi.Walk(router, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		got[method+" "+route] = true
		return nil
	}); err != nil {
		t.Fatalf("walk routes: %v", err)
	}
	for _, route := range want {
		key := route.method + " " + route.path
		if !got[key] {
			t.Errorf("missing route %s", key)
		}
		if len(got) != len(want) {
			t.Errorf("route count = %d, want %d", len(got), len(want))
		}
	}
}
