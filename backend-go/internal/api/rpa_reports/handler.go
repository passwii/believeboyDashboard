package rpa_reports

import (
	"net/http"
	"strings"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type Handler struct {
	store   Store
	auditor audit.Service
}

func NewHandler(store Store, auditor audit.Service) *Handler {
	return &Handler{store: store, auditor: auditor}
}

func (h *Handler) GetStatus(w http.ResponseWriter, r *http.Request) {
	reportDate := strings.TrimSpace(r.URL.Query().Get("report_date"))
	if reportDate == "" {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Field required: report_date")
		return
	}
	if len(reportDate) != 10 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "report_date must be YYYY-MM-DD")
		return
	}
	if _, err := time.Parse("2006-01-02", reportDate); err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "report_date must be YYYY-MM-DD")
		return
	}

	country := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("country")))
	if country == "" {
		country = "US"
	}

	identity, _ := auth.UserContextFromContext(r.Context())
	resp, err := h.store.GetReportStatusForDate(r.Context(), reportDate, country, identity.Operator, identity.IsAdmin)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusInternalServerError, err.Error())
		return
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, resp)
}
