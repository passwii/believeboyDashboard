package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type Store interface {
	FindForLogin(ctx context.Context, email, password string) (*Account, bool, error)
	GetByIDAndEmail(ctx context.Context, userID, email string) (*Account, error)
	IssueUserAPIKey(ctx context.Context, userID, clientID string) (string, error)
}

type Handler struct {
	store            Store
	sessions         SessionManager
	sessionsRequired bool
	auditor          audit.Service
}

type Option func(*Handler)

func WithSessionManager(sessions SessionManager) Option {
	return func(handler *Handler) {
		handler.sessions = sessions
		handler.sessionsRequired = true
	}
}

func WithAuditor(auditor audit.Service) Option {
	return func(handler *Handler) {
		handler.auditor = auditor
	}
}

// NewHandler keeps direct in-memory handler construction usable by unit
// fixtures. Production registrars must pass WithSessionManager; without it,
// Login/Me retain legacy behavior only for isolated tests.
func NewHandler(store Store, options ...Option) *Handler {
	handler := &Handler{store: store}
	for _, option := range options {
		if option != nil {
			option(handler)
		}
	}
	return handler
}

func (h *Handler) Login(w http.ResponseWriter, r *http.Request) {
	var body LoginRequest
	if !decodeLoginJSON(w, r, &body) {
		return
	}
	email := strings.ToLower(strings.TrimSpace(body.Email))
	if email == "" || body.Password == "" || len(email) > 255 || len(body.Password) > 128 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid email or password")
		return
	}
	clientID, ok := normalizeClientID(r.Header.Get("X-Client-Id"))
	if !ok {
		writeLoginError(w, http.StatusBadRequest, "Invalid X-Client-Id", "INVALID_CLIENT_ID")
		return
	}

	account, passwordValid, err := h.store.FindForLogin(r.Context(), email, body.Password)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if account == nil || !passwordValid {
		writeLoginError(w, http.StatusUnauthorized, "Incorrect email or password", "INVALID_CREDENTIALS")
		return
	}
	if !account.IsActive {
		writeLoginError(w, http.StatusUnauthorized, "Account disabled", "ACCOUNT_DISABLED")
		return
	}

	if h.sessionsRequired && h.sessions == nil {
		writeLoginError(w, http.StatusServiceUnavailable, "Session service unavailable", "SESSION_STORE_UNAVAILABLE")
		return
	}
	sessionID, err := newSessionID()
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	issuedAt := time.Now().UTC()
	if account.PasswordChangedAt != nil && !issuedAt.After(*account.PasswordChangedAt) {
		issuedAt = account.PasswordChangedAt.Add(time.Nanosecond)
	}
	if h.sessions != nil {
		if err := h.sessions.CreateUserSession(r.Context(), account.ID, sessionID, issuedAt); err != nil {
			writeLoginError(w, http.StatusServiceUnavailable, "Session service unavailable", "SESSION_STORE_UNAVAILABLE")
			return
		}
	}
	apiKey, err := h.store.IssueUserAPIKey(r.Context(), account.ID, clientID)
	if err != nil {
		if h.sessions != nil {
			_ = h.sessions.DeleteUserSession(r.Context(), account.ID, sessionID)
		}
		httpapi.WriteInternalServerError(w)
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, LoginResponse{
		ID:        account.ID,
		Name:      account.Name,
		Email:     account.Email,
		FullName:  normalizedFullName(account.FullName),
		IsAdmin:   account.IsAdmin,
		IsActive:  account.IsActive,
		RoleType:  normalizedRole(account.RoleType, account.IsAdmin),
		SessionID: sessionID,
		APIKey:    apiKey,
	})
}

func newSessionID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}

var clientIDPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,64}$`)

func normalizeClientID(value string) (string, bool) {
	if value == "" {
		return "default", true
	}
	if !clientIDPattern.MatchString(value) {
		return "", false
	}
	return value, true
}

func writeLoginError(w http.ResponseWriter, status int, detail, code string) {
	_ = httpapi.WriteJSON(w, status, struct {
		Detail string `json:"detail"`
		Code   string `json:"code"`
	}{Detail: detail, Code: code})
}

func decodeLoginJSON(w http.ResponseWriter, r *http.Request, destination any) bool {
	decoder := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	if err := decoder.Decode(destination); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid JSON body")
		return false
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid JSON body")
		return false
	}
	return true
}

func normalizedRole(role string, isAdmin bool) string {
	if role != "" {
		return role
	}
	if isAdmin {
		return "admin"
	}
	return "operator"
}

func normalizedFullName(value *string) *string {
	if value == nil {
		return nil
	}
	normalized := strings.TrimSpace(*value)
	if normalized == "" {
		return nil
	}
	return &normalized
}
