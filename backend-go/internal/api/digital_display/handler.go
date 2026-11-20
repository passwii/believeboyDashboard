package digital_display

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	projectapi "github.com/passwii/believeboyDashboard/backend-go/internal/api/projects"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type Handler struct {
	store         Store
	projectReader ProjectReader
	now           func() time.Time
}

type Option func(*Handler)

func WithNow(now func() time.Time) Option {
	return func(handler *Handler) {
		if now != nil {
			handler.now = now
		}
	}
}

// WithProjectReader enables per-project authorization for non-admin requests.
func WithProjectReader(reader ProjectReader) Option {
	return func(handler *Handler) {
		handler.projectReader = reader
	}
}

func NewHandler(store Store, options ...Option) *Handler {
	handler := &Handler{store: store, now: time.Now}
	for _, option := range options {
		option(handler)
	}
	return handler
}

func (h *Handler) GetDigitalDisplay(w http.ResponseWriter, r *http.Request) {
	projectID, err := strconv.ParseInt(chi.URLParam(r, "project_id"), 10, 64)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "project_id must be an integer")
		return
	}

	identity, hasIdentity := auth.UserContextFromContext(r.Context())
	if h.projectReader != nil && !hasIdentity {
		httpapi.WriteDetail(w, http.StatusUnauthorized, "Not authenticated")
		return
	}
	if hasIdentity && !identity.IsAdmin {
		if h.projectReader == nil {
			httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Project authorization is not configured")
			return
		}
		if strings.TrimSpace(identity.Operator) == "" {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
		project, projectErr := h.projectReader.GetProject(r.Context(), projectID)
		if projectErr != nil {
			if errors.Is(projectErr, projectapi.ErrNotFound) {
				httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
			} else {
				httpapi.WriteInternalServerError(w)
			}
			return
		}
		if project == nil {
			httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
			return
		}
		if !project.IsActive || !projectapi.CanAccessProject(*project, identity.Operator, false) {
			httpapi.WriteDetail(w, http.StatusForbidden, "无权限访问该项目")
			return
		}
	}

	country, err := NormalizeCountry(r.URL.Query().Get("country"))
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, ErrInvalidCountry.Error())
		return
	}
	days := 7
	if values, present := r.URL.Query()["days"]; present {
		raw := ""
		if len(values) > 0 {
			raw = strings.TrimSpace(values[0])
		}
		days, err = strconv.Atoi(raw)
		if err != nil || days < 3 || days > 30 {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "days must be between 3 and 30")
			return
		}
	}
	payload, err := h.store.BuildDigitalDisplay(
		r.Context(),
		projectID,
		country,
		days,
		h.now().UTC(),
	)
	if err != nil {
		switch {
		case errors.Is(err, ErrProjectNotFound):
			httpapi.WriteDetail(w, http.StatusNotFound, "项目不存在")
		case errors.Is(err, ErrInvalidCountry):
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, ErrInvalidCountry.Error())
		default:
			httpapi.WriteInternalServerError(w)
		}
		return
	}
	if payload.SalesTrend == nil {
		payload.SalesTrend = []SalesTrendItem{}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, payload)
}
