package agentauth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestRequireBusinessScope(t *testing.T) {
	tests := []struct {
		name          string
		businessScope string
		domain        string
		wantStatus    int
		wantCode      string
		wantDetail    string
	}{
		{name: "wildcard allows ordinary domain", businessScope: "*", domain: "shipments", wantStatus: http.StatusNoContent},
		{name: "wildcard denies provisioning", businessScope: "*", domain: "agent_provisioning", wantStatus: http.StatusForbidden, wantCode: ErrorCodeAgentBusinessOutOfScope, wantDetail: DetailBusinessNotInScope},
		{name: "explicit domain allows", businessScope: "shipments, shop_calculations", domain: "shop_calculations", wantStatus: http.StatusNoContent},
		{name: "explicit provisioning allows", businessScope: "agent_provisioning", domain: "agent_provisioning", wantStatus: http.StatusNoContent},
		{name: "explicit domain denies unknown", businessScope: "shipments", domain: "order_info", wantStatus: http.StatusForbidden, wantCode: ErrorCodeAgentBusinessOutOfScope, wantDetail: DetailBusinessNotInScope},
		{name: "empty domain denied", businessScope: "*", domain: "", wantStatus: http.StatusForbidden, wantCode: ErrorCodeAgentBusinessOutOfScope, wantDetail: DetailBusinessNotInScope},
		{name: "empty scope behaves as wildcard", businessScope: "", domain: "shipments", wantStatus: http.StatusNoContent},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := WithAgentCredential(context.Background(), AgentCredential{
				KeyID:         1,
				AgentID:       "agent",
				BusinessScope: tt.businessScope,
			})
			request := httptest.NewRequest(http.MethodGet, "/", nil).WithContext(ctx)
			response := httptest.NewRecorder()
			handler := RequireBusinessScope(tt.domain)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusNoContent)
			}))

			handler.ServeHTTP(response, request)

			if tt.wantCode == "" {
				if response.Code != tt.wantStatus {
					t.Fatalf("status = %d, want %d: %s", response.Code, tt.wantStatus, response.Body.String())
				}
				return
			}
			assertErrorResponse(t, response, tt.wantStatus, tt.wantCode, tt.wantDetail)
		})
	}
}

func TestRequireBusinessScopeWithoutCredentialFailsClosed(t *testing.T) {
	response := httptest.NewRecorder()
	handler := RequireBusinessScope("shipments")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("next handler must not be called")
	}))

	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/", nil))

	assertErrorResponse(t, response, http.StatusUnauthorized, ErrorCodeAgentAuthFailed, DetailTokenInvalid)
}

func TestRequireProjectScope(t *testing.T) {
	tests := []struct {
		name         string
		projectScope string
		projectID    int64
		wantStatus   int
		wantCode     string
		wantDetail   string
	}{
		{name: "wildcard allows", projectScope: "*", projectID: 99, wantStatus: http.StatusNoContent},
		{name: "list allows", projectScope: "11, 42,73", projectID: 42, wantStatus: http.StatusNoContent},
		{name: "list denies", projectScope: "11,42", projectID: 73, wantStatus: http.StatusForbidden, wantCode: ErrorCodeAgentProjectOutOfScope, wantDetail: DetailProjectNotInScope},
		{name: "empty scope behaves as wildcard", projectScope: "", projectID: 73, wantStatus: http.StatusNoContent},
		{name: "invalid fragments are ignored", projectScope: "bad, 42, ,nope", projectID: 11, wantStatus: http.StatusForbidden, wantCode: ErrorCodeAgentProjectOutOfScope, wantDetail: DetailProjectNotInScope},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := WithAgentCredential(context.Background(), AgentCredential{
				KeyID:        1,
				AgentID:      "agent",
				ProjectScope: tt.projectScope,
			})
			request := httptest.NewRequest(http.MethodGet, "/", nil).WithContext(ctx)
			response := httptest.NewRecorder()
			handler := RequireProjectScope(tt.projectID)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusNoContent)
			}))

			handler.ServeHTTP(response, request)

			if tt.wantCode == "" {
				if response.Code != tt.wantStatus {
					t.Fatalf("status = %d, want %d: %s", response.Code, tt.wantStatus, response.Body.String())
				}
				return
			}
			assertErrorResponse(t, response, tt.wantStatus, tt.wantCode, tt.wantDetail)
		})
	}
}

func TestRequireProjectScopeParam(t *testing.T) {
	router := chi.NewRouter()
	router.With(RequireProjectScopeParam("project_id")).Get(
		"/projects/{project_id}",
		func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusNoContent)
		},
	)

	t.Run("authorized path parameter", func(t *testing.T) {
		ctx := WithAgentCredential(context.Background(), AgentCredential{
			AgentID:      "agent",
			ProjectScope: "12,34",
		})
		request := httptest.NewRequest(http.MethodGet, "/projects/34", nil).WithContext(ctx)
		response := httptest.NewRecorder()

		router.ServeHTTP(response, request)

		if response.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want 204: %s", response.Code, response.Body.String())
		}
	})

	t.Run("denied path parameter", func(t *testing.T) {
		ctx := WithAgentCredential(context.Background(), AgentCredential{
			AgentID:      "agent",
			ProjectScope: "12,34",
		})
		request := httptest.NewRequest(http.MethodGet, "/projects/99", nil).WithContext(ctx)
		response := httptest.NewRecorder()

		router.ServeHTTP(response, request)

		assertErrorResponse(t, response, http.StatusForbidden, ErrorCodeAgentProjectOutOfScope, DetailProjectNotInScope)
	})

	t.Run("invalid path parameter", func(t *testing.T) {
		ctx := WithAgentCredential(context.Background(), AgentCredential{
			AgentID:      "agent",
			ProjectScope: "*",
		})
		request := httptest.NewRequest(http.MethodGet, "/projects/not-a-number", nil).WithContext(ctx)
		response := httptest.NewRecorder()

		router.ServeHTTP(response, request)

		assertErrorResponse(t, response, http.StatusBadRequest, ErrorCodeValidationFailed, DetailInvalidProjectID)
	})

	t.Run("missing credential wins over invalid parameter", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodGet, "/projects/not-a-number", nil)
		response := httptest.NewRecorder()

		router.ServeHTTP(response, request)

		assertErrorResponse(t, response, http.StatusUnauthorized, ErrorCodeAgentAuthFailed, DetailTokenInvalid)
	})
}

func TestRequireProjectScopeWithoutCredentialFailsClosed(t *testing.T) {
	response := httptest.NewRecorder()
	handler := RequireProjectScope(1)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("next handler must not be called")
	}))

	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/", nil))

	assertErrorResponse(t, response, http.StatusUnauthorized, ErrorCodeAgentAuthFailed, DetailTokenInvalid)
}
