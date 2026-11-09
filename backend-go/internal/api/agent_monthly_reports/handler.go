package agent_monthly_reports

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"mime"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/agentauth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
)

const maxAgentMonthlyJSONBodyBytes = int64(10 * 1024 * 1024)

type Handler struct {
	store        Store
	auditor      audit.Service
	confirmStore agentauth.ConfirmStore
	dispatcher   BuildDispatcher
	now          func() time.Time
	maxFileBytes int64
	uploadTTL    time.Duration
}

func (h *Handler) auditEntry(r *http.Request, idempotencyKey string) audit.Entry {
	entry := audit.Entry{}
	entry.PopulateFromRequest(r)
	if credential, ok := agentauth.CredentialFromRequest(r); ok {
		agentID := credential.AgentID
		entry.AgentID = &agentID
		if strings.TrimSpace(credential.Label) != "" {
			agentName := credential.Label
			entry.AgentName = &agentName
		}
	}
	if strings.TrimSpace(idempotencyKey) != "" {
		key := strings.TrimSpace(idempotencyKey)
		entry.IdempotencyKey = &key
	}
	return entry
}

func (h *Handler) credentialFor(
	w http.ResponseWriter,
	r *http.Request,
) (agentauth.AgentCredential, bool) {
	credential, ok := agentauth.CredentialFromRequest(r)
	if !ok {
		agentauth.WriteError(
			w,
			http.StatusUnauthorized,
			agentauth.ErrorCodeAgentAuthFailed,
			agentauth.DetailTokenInvalid,
		)
		return agentauth.AgentCredential{}, false
	}
	return credential, true
}

func (h *Handler) requireProjectScope(
	w http.ResponseWriter,
	r *http.Request,
	projectID int64,
	notFoundOnDenied bool,
) bool {
	credential, ok := agentauth.CredentialFromRequest(r)
	if !ok {
		agentauth.WriteError(
			w,
			http.StatusUnauthorized,
			agentauth.ErrorCodeAgentAuthFailed,
			agentauth.DetailTokenInvalid,
		)
		return false
	}
	if projectInScope(credential.ProjectScope, projectID) {
		return true
	}
	if notFoundOnDenied {
		writeError(w, store.ErrAgentMonthlyNotFound)
		return false
	}
	writeError(w, &apiError{
		Status:       http.StatusForbidden,
		Code:         ErrorCodeAgentProjectOutOfScope,
		HumanMessage: "本凭据未被授权访问该项目",
		AgentHint:    "请在 Agent 平台为该 agent 配置项目访问权限",
	})
	return false
}

func projectInScope(scope string, projectID int64) bool {
	scope = strings.TrimSpace(scope)
	if scope == "" || scope == "*" {
		return true
	}
	for _, item := range strings.Split(scope, ",") {
		value, err := strconv.ParseInt(strings.TrimSpace(item), 10, 64)
		if err == nil && value == projectID {
			return true
		}
	}
	return false
}

func (h *Handler) parseProjectQuery(
	w http.ResponseWriter,
	r *http.Request,
) (int64, bool) {
	raw := strings.TrimSpace(r.URL.Query().Get("project_id"))
	projectID, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || projectID <= 0 {
		writeValidationError(w, map[string]any{
			"loc":  []string{"query", "project_id"},
			"msg":  "project_id must be a positive integer",
			"type": "value_error",
		})
		return 0, false
	}
	return projectID, true
}

func (h *Handler) parsePathID(
	w http.ResponseWriter,
	r *http.Request,
	name string,
) (int64, bool) {
	raw := strings.TrimSpace(chi.URLParam(r, name))
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value <= 0 {
		writeValidationError(w, map[string]any{
			"loc":  []string{"path", name},
			"msg":  name + " must be a positive integer",
			"type": "value_error",
		})
		return 0, false
	}
	return value, true
}

func (h *Handler) idempotencyKey(
	w http.ResponseWriter,
	r *http.Request,
) (string, bool) {
	key := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if key == "" {
		writeValidationError(w, map[string]any{
			"loc":  []string{"header", "Idempotency-Key"},
			"msg":  "Idempotency-Key is required",
			"type": "value_error.missing",
		})
		return "", false
	}
	if len(key) > 64 {
		key = key[:64]
	}
	return key, true
}

func decodeAgentMonthlyJSON(
	w http.ResponseWriter,
	r *http.Request,
	destination any,
) bool {
	reader := http.MaxBytesReader(w, r.Body, maxAgentMonthlyJSONBodyBytes)
	decoder := json.NewDecoder(reader)
	if err := decoder.Decode(destination); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeError(w, &apiError{
				Status:       http.StatusRequestEntityTooLarge,
				Code:         ErrorCodeTooLarge,
				HumanMessage: "请求体超过大小上限",
				AgentHint:    "请压缩请求体后重试",
			})
			return false
		}
		writeValidationError(w, map[string]any{
			"loc":  []string{"body"},
			"msg":  "invalid JSON body",
			"type": "value_error.json",
		})
		return false
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		writeValidationError(w, map[string]any{
			"loc":  []string{"body"},
			"msg":  "trailing JSON value",
			"type": "value_error.json",
		})
		return false
	}
	return true
}

func parseAgentMonthlyBool(value string, fallback bool) (bool, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback, nil
	}
	switch strings.ToLower(value) {
	case "true", "1", "yes":
		return true, nil
	case "false", "0", "no":
		return false, nil
	default:
		return false, fmt.Errorf("%w: invalid boolean", store.ErrAgentMonthlyInvalidInput)
	}
}

func parseAgentMonthlyTolerance(value string) (float64, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0.01, nil
	}
	tolerance, err := strconv.ParseFloat(value, 64)
	if err != nil || math.IsNaN(tolerance) || math.IsInf(tolerance, 0) || tolerance < 0 {
		return 0, fmt.Errorf("%w: tolerance must be a non-negative number", store.ErrAgentMonthlyInvalidInput)
	}
	return tolerance, nil
}

func (h *Handler) writeStoredFile(
	w http.ResponseWriter,
	r *http.Request,
	file *store.AgentMonthlyStoredFile,
) {
	if file == nil {
		writeError(w, store.ErrAgentMonthlyNotFound)
		return
	}
	input, err := os.Open(file.Path)
	if err != nil {
		writeError(w, store.ErrAgentMonthlyNotReady)
		return
	}
	defer input.Close()
	info, err := input.Stat()
	if err != nil {
		writeError(w, store.ErrAgentMonthlyNotReady)
		return
	}
	contentType := file.ContentType
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", mime.FormatMediaType(
		"attachment",
		map[string]string{"filename": file.Filename},
	))
	http.ServeContent(w, r, file.Filename, info.ModTime(), input)
}

func (h *Handler) writeFileContent(
	w http.ResponseWriter,
	file *store.AgentMonthlyFileResult,
) {
	if file == nil {
		writeError(w, store.ErrAgentMonthlyNotFound)
		return
	}
	contentType := file.ContentType
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", mime.FormatMediaType(
		"attachment",
		map[string]string{"filename": file.Filename},
	))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(file.Content)
}

func agentMonthlyItem(item store.AgentMonthlyReportItem) MonthlyReportItem {
	return MonthlyReportItem{
		ID:                 item.ID,
		ProjectID:          item.ProjectID,
		ProjectName:        item.ProjectName,
		Country:            item.Country,
		ReportMonth:        item.ReportMonth,
		Version:            item.Version,
		IsCurrent:          item.IsCurrent,
		SupersededAt:       httpapi.OptionalTimestamp(item.SupersededAt),
		Status:             item.Status,
		SettlementID:       item.SettlementID,
		TotalTransactions:  item.TotalTransactions,
		TotalOrders:        item.TotalOrders,
		TotalRefunds:       item.TotalRefunds,
		TotalAdjustments:   item.TotalAdjustments,
		TotalServiceFees:   item.TotalServiceFees,
		TotalTransFees:     item.TotalTransFees,
		ResultFilePath:     nil,
		ErrorMessage:       nil,
		CalculationVersion: item.CalculationVersion,
		ComputedAt:         httpapi.OptionalTimestamp(item.ComputedAt),
		CreatedAt:          httpapi.OptionalTimestamp(item.CreatedAt),
		UpdatedAt:          httpapi.OptionalTimestamp(item.UpdatedAt),
	}
}

func (h *Handler) buildStatus(build *store.AgentMonthlyBuild) buildStatusResponse {
	if build == nil {
		return buildStatusResponse{}
	}
	response := buildStatusResponse{
		BuildID:                 build.ID,
		UploadID:                build.UploadID,
		Status:                  build.Status,
		ProjectID:               build.ProjectID,
		ProjectName:             build.ProjectName,
		Country:                 build.Country,
		ReportMonth:             build.ReportMonth,
		InputSHA256:             build.InputSHA256,
		CalculationVersion:      build.CalculationVersion,
		ReportID:                build.ReportID,
		ConfirmedAt:             httpapi.OptionalTimestamp(build.ConfirmedAt),
		ErrorMessage:            build.ErrorMessage,
		ExpiresAt:               httpapi.Timestamp(build.ExpiresAt),
		ExistingSuccessReportID: build.ExistingSuccessReportID,
		CreatedAt:               httpapi.Timestamp(build.CreatedAt),
		UpdatedAt:               httpapi.Timestamp(build.UpdatedAt),
	}
	if build.Status != "failed" {
		response.ErrorMessage = nil
	}
	return response
}

func (h *Handler) preview(
	build *store.AgentMonthlyBuild,
	result *store.AgentMonthlyBuildPreview,
) buildPreviewResponse {
	return buildPreviewResponse{
		BuildID:              build.ID,
		ProjectID:            build.ProjectID,
		ProjectName:          build.ProjectName,
		Country:              build.Country,
		ReportMonth:          build.ReportMonth,
		InputSHA256:          build.InputSHA256,
		CalculationVersion:   build.CalculationVersion,
		TransactionsCount:    result.TransactionsCount,
		PT3:                  result.PT3,
		PT4:                  result.PT4,
		ExpiresAt:            httpapi.Timestamp(build.ExpiresAt),
		RequiresConfirmation: true,
	}
}

func (h *Handler) confirmationPreview(
	build *store.AgentMonthlyBuild,
	preview *store.AgentMonthlyBuildPreview,
) confirmationPreview {
	willConflict := build.BlockingReportID != nil
	var existingStatus *string
	if build.BlockingReportStatus != nil {
		status := *build.BlockingReportStatus
		existingStatus = &status
	}
	return confirmationPreview{
		BuildID:              build.ID,
		ProjectID:            build.ProjectID,
		ProjectName:          build.ProjectName,
		Country:              build.Country,
		ReportMonth:          build.ReportMonth,
		TransactionsCount:    preview.TransactionsCount,
		InputSHA256:          build.InputSHA256,
		SummaryPDFIncluded:   build.SummaryPDFSHA256 != nil,
		CalculationVersion:   build.CalculationVersion,
		ExistingReportID:     build.BlockingReportID,
		ExistingReportStatus: existingStatus,
		WillConflict:         willConflict,
		ExpiresAt:            httpapi.Timestamp(build.ExpiresAt),
	}
}

func newAgentMonthlyConfirmToken() (string, error) {
	buffer := make([]byte, 24)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return "cf_" + base64.RawURLEncoding.EncodeToString(buffer), nil
}

func bodySHA256(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}
