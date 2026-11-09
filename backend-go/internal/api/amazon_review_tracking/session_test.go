package amazon_review_tracking

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type fakeSessionValidator struct {
	valid bool
	err   error
}

func (validator fakeSessionValidator) ValidateSession(
	context.Context,
	string,
	string,
) (bool, error) {
	return validator.valid, validator.err
}

func TestRedisSessionValidatorUsesFastAPIKeyLayout(t *testing.T) {
	validator := NewRedisSessionValidator(nil, ":custom:", 0)
	if got, want := validator.sessionKey("user-1", "session-1"), "custom:session:user-1:session-1"; got != want {
		t.Fatalf("session key = %q, want %q", got, want)
	}
	if validator.ttl != 8*time.Hour {
		t.Fatalf("ttl = %s, want 8h", validator.ttl)
	}
	if valid, err := validator.ValidateSession(context.Background(), "user-1", "session-1"); valid ||
		err == nil {
		t.Fatalf("nil client ValidateSession() = %v, %v", valid, err)
	}
}

func TestAmazonReviewTrackingSessionValidatorRejectsRevokedSession(t *testing.T) {
	store := seedAmazonReviewMock()
	router := chi.NewRouter()
	NewRegistrar(
		store,
		&mockAmazonReviewAuditor{},
		WithSessionValidator(fakeSessionValidator{valid: false}),
	).RegisterRoutes(router, func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			identity := auth.UserContextFromRequest(r)
			next.ServeHTTP(w, r.WithContext(auth.WithUserContext(r.Context(), identity)))
		})
	})

	request := httptest.NewRequest(
		http.MethodGet,
		"/api/v1/amazon-review-tracking/targets",
		nil,
	)
	request.Header.Set("X-User-Id", "admin")
	request.Header.Set("X-Session-Id", "revoked")
	request.Header.Set("X-Operator", "admin")
	request.Header.Set("X-Is-Admin", "true")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("revoked session status = %d, body=%s", response.Code, response.Body.String())
	}
}
