package agent_commerce

import (
	"net"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/agentauth"
)

type Handler struct {
	store   Store
	options Options
}

func NewHandler(store Store, options Options) *Handler {
	if options.ConfirmStore == nil {
		options.ConfirmStore = agentauth.NewMemoryConfirmStore()
	}
	return &Handler{store: store, options: options}
}

func (h *Handler) requireStore(w http.ResponseWriter) bool {
	if h.store == nil {
		writeAPIError(w, newAPIError(CodeServiceUnavailable))
		return false
	}
	return true
}

func (h *Handler) verifyProject(
	w http.ResponseWriter,
	r *http.Request,
) (*ProjectInfo, int64, bool) {
	projectID, ok := parsePositivePathID(w, r, "project_id")
	if !ok {
		return nil, 0, false
	}
	project, err := h.store.VerifyProject(r.Context(), projectID)
	if err != nil {
		writeAPIError(w, mapStoreError(err))
		return nil, 0, false
	}
	if project == nil {
		writeAPIError(w, APIErrorWithMessage(CodeResourceNotFound, "项目不存在"))
		return nil, 0, false
	}
	return project, projectID, true
}

func parsePositivePathID(w http.ResponseWriter, r *http.Request, name string) (int64, bool) {
	raw := strings.TrimSpace(chi.URLParam(r, name))
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < 1 {
		writeValidationError(w, name+" 必须是正整数", nil)
		return 0, false
	}
	return value, true
}

func (h *Handler) auditEntry(r *http.Request, action string) AuditEntry {
	credential, _ := agentauth.CredentialFromRequest(r)
	agentID := credential.AgentID
	agentName := credential.Label
	entry := AuditEntry{
		Action:    action,
		AgentID:   &agentID,
		AgentName: &agentName,
	}
	if key, _ := requestIdempotencyKey(r); key != "" {
		entry.IdempotencyKey = &key
	}
	if traceID := strings.TrimSpace(r.Header.Get("X-Request-ID")); traceID != "" {
		entry.TraceID = &traceID
	}
	method := r.Method
	entry.RequestMethod = &method
	path := r.URL.Path
	entry.RequestPath = &path
	if userAgent := strings.TrimSpace(r.UserAgent()); userAgent != "" {
		entry.UserAgent = &userAgent
	}
	remote := strings.TrimSpace(r.Header.Get("X-Forwarded-For"))
	if remote != "" {
		remote = strings.TrimSpace(strings.Split(remote, ",")[0])
	} else if host, _, err := net.SplitHostPort(strings.TrimSpace(r.RemoteAddr)); err == nil {
		remote = host
	} else {
		remote = strings.TrimSpace(r.RemoteAddr)
	}
	if remote != "" {
		entry.IPAddress = &remote
	}
	return entry
}

func responseIdempotencyKey(r *http.Request) string {
	key, _ := requestIdempotencyKey(r)
	return key
}
