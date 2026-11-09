package digital_display

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type Handler struct {
	store Store
	now   func() time.Time
}

type Option func(*Handler)

func WithNow(now func() time.Time) Option {
	return func(handler *Handler) {
		if now != nil {
			handler.now = now
		}
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
