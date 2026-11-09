package agentauth

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
)

const ScopeAll = "*"

var wildcardDeniedDomains = map[string]struct{}{
	"agent_provisioning": {},
}

// RequireBusinessScope enforces the credential's comma-separated domain whitelist.
func RequireBusinessScope(domain string) func(http.Handler) http.Handler {
	domain = strings.TrimSpace(domain)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			credential, ok := CredentialFromRequest(r)
			if !ok {
				writeAuthFailure(w, DetailTokenInvalid)
				return
			}
			if !businessScopeAllows(credential.BusinessScope, domain) {
				WriteError(
					w,
					http.StatusForbidden,
					ErrorCodeAgentBusinessOutOfScope,
					DetailBusinessNotInScope,
				)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// RequireProjectScope enforces an already parsed project ID against project_scope.
func RequireProjectScope(projectID int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			credential, ok := CredentialFromRequest(r)
			if !ok {
				writeAuthFailure(w, DetailTokenInvalid)
				return
			}
			if !projectScopeAllows(credential.ProjectScope, projectID) {
				WriteError(
					w,
					http.StatusForbidden,
					ErrorCodeAgentProjectOutOfScope,
					DetailProjectNotInScope,
				)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// RequireProjectScopeParam is the route-friendly variant for /projects/{project_id}.
func RequireProjectScopeParam(param string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			credential, ok := CredentialFromRequest(r)
			if !ok {
				writeAuthFailure(w, DetailTokenInvalid)
				return
			}
			projectID, err := strconv.ParseInt(chi.URLParam(r, param), 10, 64)
			if err != nil {
				WriteError(w, http.StatusBadRequest, ErrorCodeValidationFailed, DetailInvalidProjectID)
				return
			}
			if !projectScopeAllows(credential.ProjectScope, projectID) {
				WriteError(
					w,
					http.StatusForbidden,
					ErrorCodeAgentProjectOutOfScope,
					DetailProjectNotInScope,
				)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func businessScopeAllows(scope, domain string) bool {
	if domain == "" {
		return false
	}
	scope = strings.TrimSpace(scope)
	if scope == "" || scope == ScopeAll {
		_, denied := wildcardDeniedDomains[domain]
		return !denied
	}
	for _, item := range strings.Split(scope, ",") {
		if strings.TrimSpace(item) == domain {
			return true
		}
	}
	return false
}

func projectScopeAllows(scope string, projectID int64) bool {
	scope = strings.TrimSpace(scope)
	if scope == "" || scope == ScopeAll {
		return true
	}
	for _, item := range strings.Split(scope, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		allowedID, err := strconv.ParseInt(item, 10, 64)
		if err == nil && allowedID == projectID {
			return true
		}
	}
	return false
}
