package agent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/projects"
)

func TestListProjectsCodeFiltersAndResponseFields(t *testing.T) {
	store := &projectCodeAgentStore{
		items: []projects.ProjectItem{
			{ID: 1, Name: "铨富", ProjectCode: projectCodePointer("QUF"), Country: "US", IsActive: true},
			{ID: 2, Name: "诗澜瑞", Country: "US", IsActive: true},
			{ID: 3, Name: "犀牛", ProjectCode: projectCodePointer("XNU"), Country: "US", IsActive: false},
		},
		shops: map[int64][]projects.ProjectShopItem{
			1: {{ID: 11, ShopID: "shop-1"}, {ID: 12, ShopID: "shop-2"}},
			3: {{ID: 31, ShopID: "shop-3"}},
		},
	}

	recorder := runAgentProjectList(t, store, "", "*")
	active := decodeAgentProjectResponse(t, recorder)
	if recorder.Code != http.StatusOK || !active.OK || len(active.Data) != 2 {
		t.Fatalf("default response = %d %s", recorder.Code, recorder.Body.String())
	}
	if active.Data[0].ProjectID != 1 || active.Data[0].ProjectCode == nil ||
		*active.Data[0].ProjectCode != "QUF" || active.Data[0].ShopCount != 2 ||
		active.Data[1].ProjectID != 2 || active.Data[1].ProjectCode != nil ||
		active.Data[1].ShopCount != 0 || !strings.Contains(recorder.Body.String(), `"project_code":null`) {
		t.Fatalf("default data = %#v; body=%s", active.Data, recorder.Body.String())
	}

	for _, query := range []string{"?code=QUF", "?code=quf"} {
		recorder = runAgentProjectList(t, store, query, "*")
		response := decodeAgentProjectResponse(t, recorder)
		if recorder.Code != http.StatusOK || len(response.Data) != 1 ||
			response.Data[0].ProjectID != 1 || response.Data[0].ProjectName != "铨富" {
			t.Fatalf("%s response = %d %s", query, recorder.Code, recorder.Body.String())
		}
	}

	recorder = runAgentProjectList(t, store, "?code=ZZZ", "*")
	response := decodeAgentProjectResponse(t, recorder)
	if recorder.Code != http.StatusOK || !response.OK || len(response.Data) != 0 {
		t.Fatalf("unknown code response = %d %s", recorder.Code, recorder.Body.String())
	}

	recorder = runAgentProjectList(t, store, "?code=QU", "*")
	var invalid struct {
		OK    bool `json:"ok"`
		Error struct {
			Code  ErrorCode `json:"code"`
			Human string    `json:"human_message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &invalid); err != nil {
		t.Fatal(err)
	}
	if recorder.Code != http.StatusBadRequest || invalid.OK ||
		invalid.Error.Code != ErrValidationFailed ||
		!strings.Contains(invalid.Error.Human, "project_code must match ^[A-Z]{3}$") {
		t.Fatalf("invalid code response = %d %s", recorder.Code, recorder.Body.String())
	}

	recorder = runAgentProjectList(t, store, "?name=铨富", "*")
	response = decodeAgentProjectResponse(t, recorder)
	if recorder.Code != http.StatusOK || len(response.Data) != 1 || response.Data[0].ProjectID != 1 {
		t.Fatalf("exact name response = %d %s", recorder.Code, recorder.Body.String())
	}
	recorder = runAgentProjectList(t, store, "?name=铨", "*")
	response = decodeAgentProjectResponse(t, recorder)
	if recorder.Code != http.StatusOK || len(response.Data) != 0 {
		t.Fatalf("non-exact name response = %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestListProjectsStatusWhitelistInactiveCodesAndProjectScope(t *testing.T) {
	store := &projectCodeAgentStore{
		items: []projects.ProjectItem{
			{ID: 1, Name: "铨富", ProjectCode: projectCodePointer("QUF"), Country: "US", IsActive: true},
			{ID: 2, Name: "犀牛", ProjectCode: projectCodePointer("XNU"), Country: "US", IsActive: false},
		},
	}
	tests := []struct {
		name         string
		query        string
		scope        string
		wantIDs      []int64
		wantShowOff  bool
		wantHTTPCode int
	}{
		{name: "default active", wantIDs: []int64{1}},
		{name: "active", query: "?status=active", wantIDs: []int64{1}},
		{name: "inactive", query: "?status=inactive", wantIDs: []int64{2}, wantShowOff: true},
		{name: "all retains inactive code", query: "?status=all", wantIDs: []int64{1, 2}, wantShowOff: true},
		{name: "scope still filters", query: "?status=all", scope: "1", wantIDs: []int64{1}, wantShowOff: true},
		{name: "invalid status", query: "?status=actve", wantHTTPCode: http.StatusBadRequest},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store.listCalls = 0
			recorder := runAgentProjectList(t, store, test.query, test.scope)
			if recorder.Code != 0 && recorder.Code != http.StatusOK && recorder.Code != test.wantHTTPCode {
				t.Fatalf("status = %d, body=%s", recorder.Code, recorder.Body.String())
			}
			if test.wantHTTPCode != 0 {
				if recorder.Code != test.wantHTTPCode ||
					!strings.Contains(recorder.Body.String(), "status must be active, inactive, or all") {
					t.Fatalf("invalid status response = %d %s", recorder.Code, recorder.Body.String())
				}
				if store.listCalls != 0 {
					t.Fatalf("ListManage calls = %d for invalid status, want 0", store.listCalls)
				}
				return
			}

			response := decodeAgentProjectResponse(t, recorder)
			if recorder.Code != http.StatusOK || len(response.Data) != len(test.wantIDs) {
				t.Fatalf("response = %d %s", recorder.Code, recorder.Body.String())
			}
			if store.showInactive != test.wantShowOff {
				t.Errorf("showInactive = %v, want %v", store.showInactive, test.wantShowOff)
			}
			for index, wantID := range test.wantIDs {
				if response.Data[index].ProjectID != wantID {
					t.Errorf("data[%d].project_id = %d, want %d", index, response.Data[index].ProjectID, wantID)
				}
			}
			if test.query == "?status=all" && test.scope == "" && len(response.Data) == 2 {
				if response.Data[1].ProjectCode == nil || *response.Data[1].ProjectCode != "XNU" {
					t.Errorf("inactive project code = %#v, want retained XNU", response.Data[1].ProjectCode)
				}
			}
		})
	}
}

type projectCodeAgentStore struct {
	items        []projects.ProjectItem
	shops        map[int64][]projects.ProjectShopItem
	showInactive bool
	listCalls    int
}

func (store *projectCodeAgentStore) ListManage(
	_ context.Context,
	_ string,
	_ bool,
	showInactive bool,
) ([]projects.ProjectItem, error) {
	store.listCalls++
	store.showInactive = showInactive
	return store.items, nil
}

func (store *projectCodeAgentStore) ListProjectShops(
	_ context.Context,
	projectID int64,
) ([]projects.ProjectShopItem, error) {
	return store.shops[projectID], nil
}

type agentProjectTestResponse struct {
	OK   bool `json:"ok"`
	Data []struct {
		ProjectID   int64   `json:"project_id"`
		ProjectName string  `json:"project_name"`
		ProjectCode *string `json:"project_code"`
		ShopCount   int     `json:"shop_count"`
	} `json:"data"`
}

func runAgentProjectList(
	t *testing.T,
	store *projectCodeAgentStore,
	query string,
	scope string,
) *httptest.ResponseRecorder {
	t.Helper()
	handler := NewHandler(Stores{Projects: store}, Options{})
	request := httptest.NewRequest(http.MethodGet, "/api/v1/agent/projects"+query, nil)
	request = request.WithContext(WithCredential(request.Context(), Credential{
		AgentID:      "agent-test",
		ProjectScope: scope,
	}))
	recorder := httptest.NewRecorder()
	handler.ListProjects(recorder, request)
	return recorder
}

func decodeAgentProjectResponse(t *testing.T, recorder *httptest.ResponseRecorder) agentProjectTestResponse {
	t.Helper()
	var response agentProjectTestResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("unmarshal response %q: %v", recorder.Body.String(), err)
	}
	return response
}

func projectCodePointer(value string) *string { return &value }
