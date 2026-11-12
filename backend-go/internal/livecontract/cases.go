// Package livecontract defines the Week 1 live-contract cases shared by the
// golden generator (cmd/livegolden) and the Go-side contract test.
//
// The cases used to be compared against a running FastAPI process. That made
// the whole CI job depend on a Python runtime after the migration finished.
// The FastAPI responses are now captured once into a golden file; the test
// compares the Go gateway against that recording instead.
package livecontract

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

const (
	// ProjectName is the seeded project fixture used by the live contract.
	ProjectName = "__live_contract_project__"
	// NotificationTitle is the seeded notification fixture.
	NotificationTitle = "__live_contract_notification__"
	// ExchangeCurrency is the seeded exchange-rate fixture currency.
	ExchangeCurrency = "LVC"
	// ExchangeYearMonth is the seeded exchange-rate fixture month.
	ExchangeYearMonth = "2026-10"
	// ProfileEmail is the seeded profile fixture account.
	ProfileEmail = "test_admin@believeboy.com"
	// AlertRuleName is the seeded alert-rule fixture.
	AlertRuleName = "__live_contract_rule__"
	// AlertEventMessage is the seeded alert-event fixture message.
	AlertEventMessage = "[live-contract] fixture event"
)

// IdTokens are the placeholders written into the golden file instead of the
// database identifiers, so a recording stays valid on a freshly seeded
// database.
const (
	TokenProjectID          = "__PROJECT_ID__"
	TokenExchangeRateID     = "__EXCHANGE_RATE_ID__"
	TokenNotificationUserID = "__NOTIFICATION_USER_ID__"
	TokenNotificationID     = "__NOTIFICATION_ID__"
	TokenProfileUserID      = "__PROFILE_USER_ID__"
	TokenAlertRuleID        = "__ALERT_RULE_ID__"
	TokenAlertEventID       = "__ALERT_EVENT_ID__"
)

// Fixtures carries the database identifiers the cases need.
type Fixtures struct {
	ProjectID          string
	ExchangeRateID     string
	NotificationUserID string
	NotificationID     string
	ProfileUserID      string
	AlertRuleID        string
	AlertEventID       string
}

// HeaderRole names one of the header sets the cases are allowed to use.
// Roles keep credentials out of the golden file.
type HeaderRole string

const (
	RoleBase          HeaderRole = "base"
	RoleNotification  HeaderRole = "notification"
	RoleAlertAdmin    HeaderRole = "alert-admin"
	RoleAlertOperator HeaderRole = "alert-operator"
	RoleProfile       HeaderRole = "profile"
)

// Case is one request/response pair the contract asserts.
type Case struct {
	Name        string     `json:"name"`
	Route       string     `json:"route"`
	RequestPath string     `json:"request_path"`
	HeaderRole  HeaderRole `json:"header_role"`
	// MaskedKeys lists response fields that are environment bookkeeping rather
	// than contract: seeding rewrites them, so the golden cannot pin them.
	MaskedKeys []string `json:"masked_keys,omitempty"`
}

// Filters and BuildCases assemble the deterministic case list.
func BuildCases(fixtures Fixtures) []Case {
	alertProjectFilters := "project_id=" + fixtures.ProjectID + "&metric=acos&is_active=true"
	alertEventFilters := "project_id=" + fixtures.ProjectID + "&severity=warning&status=active&page=1&page_size=100"

	cases := []Case{
		{Name: "health", Route: "/api/v1/health", RequestPath: "/api/v1/health", HeaderRole: RoleBase},
		{Name: "health live", Route: "/api/v1/health/live", RequestPath: "/api/v1/health/live", HeaderRole: RoleBase},
		{Name: "health ready", Route: "/api/v1/health/ready", RequestPath: "/api/v1/health/ready", HeaderRole: RoleBase},
		{Name: "exchange rates list", Route: "/api/v1/exchange-rates", HeaderRole: RoleBase,
			RequestPath: "/api/v1/exchange-rates?currency=" + ExchangeCurrency + "&year_month=" + ExchangeYearMonth + "&page=1&page_size=50"},
		{Name: "exchange rate resolve", Route: "/api/v1/exchange-rates/resolve", HeaderRole: RoleBase,
			RequestPath: "/api/v1/exchange-rates/resolve?currency=" + ExchangeCurrency + "&year_month=" + ExchangeYearMonth},
		{Name: "exchange rate options", Route: "/api/v1/exchange-rates/options", RequestPath: "/api/v1/exchange-rates/options", HeaderRole: RoleBase},
		{Name: "exchange rate detail", Route: "/api/v1/exchange-rates/{exchange_rate_id}", HeaderRole: RoleBase,
			RequestPath: "/api/v1/exchange-rates/" + fixtures.ExchangeRateID},
		{Name: "notifications list", Route: "/api/v1/notifications", HeaderRole: RoleNotification,
			RequestPath: "/api/v1/notifications?type=alert&read=false&page=1&page_size=100"},
		{Name: "notifications unread count", Route: "/api/v1/notifications/unread-count", HeaderRole: RoleNotification,
			RequestPath: "/api/v1/notifications/unread-count"},
		{Name: "alert metrics", Route: "/api/v1/alerts/metrics", RequestPath: "/api/v1/alerts/metrics", HeaderRole: RoleBase},
		{Name: "alert rules", Route: "/api/v1/alerts/rules", HeaderRole: RoleAlertAdmin,
			RequestPath: "/api/v1/alerts/rules?" + alertProjectFilters},
		{Name: "alert events", Route: "/api/v1/alerts/events", HeaderRole: RoleAlertAdmin,
			RequestPath: "/api/v1/alerts/events?" + alertEventFilters},
		{Name: "alert stats with project", Route: "/api/v1/alerts/stats", HeaderRole: RoleAlertAdmin,
			RequestPath: "/api/v1/alerts/stats?project_id=" + fixtures.ProjectID},
		{Name: "alert stats global non-admin", Route: "/api/v1/alerts/stats", RequestPath: "/api/v1/alerts/stats", HeaderRole: RoleAlertOperator},
		{Name: "profile", Route: "/api/v1/system-management/profile", RequestPath: "/api/v1/system-management/profile", HeaderRole: RoleProfile, MaskedKeys: []string{"created_at", "updated_at", "password_changed_at"}},
	}
	return cases
}

// DistinctRoutes returns the sorted unique route templates covered by the cases.
func DistinctRoutes(cases []Case) []string {
	seen := make(map[string]bool, len(cases))
	for _, item := range cases {
		seen[item.Route] = true
	}
	routes := make([]string, 0, len(seen))
	for route := range seen {
		routes = append(routes, route)
	}
	sort.Strings(routes)
	return routes
}

// ApplyTokens rewrites fixture identifiers in a JSON response into placeholders.
//
// The rewrite is value-aware rather than textual: a plain string replacement
// corrupted unrelated fields whenever a small id also occurred inside a UUID or
// a timestamp ("12" inside "2026-10-21T12:47"). Only whole JSON scalars equal to
// a fixture id are replaced.
func ApplyTokens(body []byte, fixtures Fixtures) []byte {
	decoded, err := decodeJSON(body)
	if err != nil {
		// Recording a non-JSON payload would defeat the contract; return the raw
		// body so the mistake is visible at review time.
		return body
	}
	replaced := replaceScalars(decoded, tokenMap(fixtures))
	encoded, err := encodeJSON(replaced)
	if err != nil {
		return body
	}
	return encoded
}

// ApplyTokensValue is the in-memory form of ApplyTokens: it rewrites fixture
// ids inside an already-decoded JSON value into placeholders. The contract test
// tokenizes the Go response instead of resolving the golden one so numeric ids
// keep their JSON type on both sides.
func ApplyTokensValue(value any, fixtures Fixtures) any {
	return replaceScalars(value, tokenMap(fixtures))
}

// ResolveTokens rewrites placeholders back into the current fixture ids.
func ResolveTokens(body []byte, fixtures Fixtures) []byte {
	decoded, err := decodeJSON(body)
	if err != nil {
		return body
	}
	resolved := replaceScalars(decoded, valueMap(fixtures))
	encoded, err := encodeJSON(resolved)
	if err != nil {
		return body
	}
	return encoded
}

// tokenMap maps fixture ids to their golden placeholders.
func tokenMap(fixtures Fixtures) map[string]string {
	tokens := make(map[string]string, 7)
	for value, token := range valueMap(fixtures) {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		tokens[trimmed] = token
	}
	return tokens
}

// valueMap maps golden placeholders to the current fixture ids.
func valueMap(fixtures Fixtures) map[string]string {
	return map[string]string{
		fixtures.ProjectID:          TokenProjectID,
		fixtures.ExchangeRateID:     TokenExchangeRateID,
		fixtures.NotificationUserID: TokenNotificationUserID,
		fixtures.NotificationID:     TokenNotificationID,
		fixtures.ProfileUserID:      TokenProfileUserID,
		fixtures.AlertRuleID:        TokenAlertRuleID,
		fixtures.AlertEventID:       TokenAlertEventID,
	}
}

func replaceScalars(value any, replacements map[string]string) any {
	if len(replacements) == 0 {
		return value
	}
	switch typed := value.(type) {
	case map[string]any:
		result := make(map[string]any, len(typed))
		for key, item := range typed {
			result[key] = replaceScalars(item, replacements)
		}
		return result
	case []any:
		result := make([]any, len(typed))
		for index, item := range typed {
			result[index] = replaceScalars(item, replacements)
		}
		return result
	case json.Number:
		if replacement, ok := replacements[typed.String()]; ok {
			return replacement
		}
		return typed
	case float64:
		// Normalization converts json.Number to float64 before tokenization.
		if replacement, ok := replacements[strconv.FormatFloat(typed, 'f', -1, 64)]; ok {
			return replacement
		}
		return typed
	case string:
		if replacement, ok := replacements[typed]; ok {
			return replacement
		}
		return typed
	default:
		return value
	}
}

func decodeJSON(body []byte) (any, error) {
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	decoder.UseNumber()
	var decoded any
	if err := decoder.Decode(&decoded); err != nil {
		return nil, err
	}
	return decoded, nil
}

func encodeJSON(value any) ([]byte, error) {
	return json.Marshal(value)
}

// GoldenFile is the recording written by cmd/livegolden.
type GoldenFile struct {
	// Source records what produced the recording, for reviewers.
	Source string       `json:"source"`
	Cases  []GoldenCase `json:"cases"`
}

// GoldenCase is one recorded response.
type GoldenCase struct {
	Name   string `json:"name"`
	Route  string `json:"route"`
	Status int    `json:"status"`
	Body   string `json:"body"`
}

// Validate fails when the recording cannot be trusted.
func (golden GoldenFile) Validate() error {
	if len(golden.Cases) == 0 {
		return fmt.Errorf("golden file has no cases")
	}
	for index, item := range golden.Cases {
		if strings.TrimSpace(item.Name) == "" {
			return fmt.Errorf("case %d has no name", index)
		}
		if item.Status < 200 || item.Status >= 400 {
			return fmt.Errorf("case %q recorded status %d; only 2xx/3xx may be recorded", item.Name, item.Status)
		}
	}
	return nil
}
