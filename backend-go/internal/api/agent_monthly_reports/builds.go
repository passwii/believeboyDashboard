package agent_monthly_reports

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/agentauth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
)

func (h *Handler) CreateBuild(w http.ResponseWriter, r *http.Request) {
	var request BuildCreateRequest
	if !decodeAgentMonthlyJSON(w, r, &request) {
		return
	}
	if request.UploadID <= 0 ||
		strings.TrimSpace(request.TransactionFileID) == "" ||
		len(request.TransactionFileID) > 64 ||
		(request.SummaryPDFFileID != nil && len(*request.SummaryPDFFileID) > 64) {
		writeValidationError(w, map[string]any{
			"loc":  []string{"body"},
			"msg":  "upload_id, transaction_file_id, and optional summary_pdf_file_id are invalid",
			"type": "value_error",
		})
		return
	}
	key, ok := h.idempotencyKey(w, r)
	if !ok {
		return
	}
	credential, ok := h.credentialFor(w, r)
	if !ok {
		return
	}
	upload, err := h.store.GetAgentMonthlyUpload(
		r.Context(),
		request.UploadID,
		credential.KeyID,
	)
	if err != nil {
		writeError(w, err)
		return
	}
	if !h.requireProjectScope(w, r, upload.ProjectID, false) {
		return
	}
	requestHash, err := agentMonthlyBuildRequestHash(
		request.UploadID,
		request.TransactionFileID,
		request.SummaryPDFFileID,
	)
	if err != nil {
		writeError(w, &apiError{
			Status:       http.StatusInternalServerError,
			Code:         ErrorCodeInternal,
			HumanMessage: "请求指纹生成失败",
			AgentHint:    "请稍后重试",
		})
		return
	}
	build, replayed, err := h.store.CreateAgentMonthlyBuild(
		r.Context(),
		store.AgentMonthlyBuildCreateInput{
			AgentKeyID:        credential.KeyID,
			UploadID:          request.UploadID,
			TransactionFileID: request.TransactionFileID,
			SummaryPDFFileID:  request.SummaryPDFFileID,
			IdempotencyKey:    key,
			RequestHash:       requestHash,
		},
		h.auditEntry(r, key),
	)
	if err != nil {
		writeError(w, err)
		return
	}
	if !replayed {
		if h.dispatcher == nil {
			_ = h.store.MarkAgentMonthlyBuildDispatchFailed(r.Context(), build.ID)
			writeError(w, &apiError{
				Status:       http.StatusServiceUnavailable,
				Code:         ErrorCodeDispatchFailed,
				HumanMessage: "月报计算任务派发失败",
				AgentHint:    "队列依赖暂不可用，请稍后重试",
			})
			return
		}
		if err := h.dispatcher.EnqueueBuild(r.Context(), build.ID); err != nil {
			_ = h.store.MarkAgentMonthlyBuildDispatchFailed(r.Context(), build.ID)
			writeError(w, &apiError{
				Status:       http.StatusServiceUnavailable,
				Code:         ErrorCodeDispatchFailed,
				HumanMessage: "月报计算任务派发失败",
				AgentHint:    "队列依赖暂不可用，请稍后重试",
			})
			return
		}
	}
	statusEndpoint := fmt.Sprintf(
		"/api/v1/agent/monthly-reports/builds/%d",
		build.ID,
	)
	extra := map[string]any{
		"replayed":        replayed,
		"status_endpoint": statusEndpoint,
	}
	status := http.StatusAccepted
	if replayed {
		status = http.StatusOK
	}
	writeSuccess(w, status, h.buildStatus(build), &key, extra)
}

func agentMonthlyBuildRequestHash(
	uploadID int64,
	transactionFileID string,
	summaryPDFFileID *string,
) (string, error) {
	payload := struct {
		UploadID          int64   `json:"upload_id"`
		TransactionFileID string  `json:"transaction_file_id"`
		SummaryPDFFileID  *string `json:"summary_pdf_file_id"`
	}{
		UploadID:          uploadID,
		TransactionFileID: transactionFileID,
		SummaryPDFFileID:  summaryPDFFileID,
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:]), nil
}

func (h *Handler) GetBuild(w http.ResponseWriter, r *http.Request) {
	buildID, ok := h.parsePathID(w, r, "build_id")
	if !ok {
		return
	}
	credential, ok := h.credentialFor(w, r)
	if !ok {
		return
	}
	build, err := h.store.GetAgentMonthlyBuild(
		r.Context(),
		buildID,
		credential.KeyID,
	)
	if err != nil {
		writeError(w, err)
		return
	}
	if !h.requireProjectScope(w, r, build.ProjectID, false) {
		return
	}
	writeSuccess(w, http.StatusOK, h.buildStatus(build), nil, nil)
}

func (h *Handler) GetBuildPreview(w http.ResponseWriter, r *http.Request) {
	buildID, ok := h.parsePathID(w, r, "build_id")
	if !ok {
		return
	}
	credential, ok := h.credentialFor(w, r)
	if !ok {
		return
	}
	build, err := h.store.GetAgentMonthlyBuild(
		r.Context(),
		buildID,
		credential.KeyID,
	)
	if err != nil {
		writeError(w, err)
		return
	}
	if !h.requireProjectScope(w, r, build.ProjectID, false) {
		return
	}
	preview, err := h.store.GetAgentMonthlyBuildPreview(
		r.Context(),
		buildID,
		credential.KeyID,
	)
	if err != nil {
		writeError(w, err)
		return
	}
	writeSuccess(w, http.StatusOK, h.preview(build, preview), nil, nil)
}

func (h *Handler) DownloadBuildResult(w http.ResponseWriter, r *http.Request) {
	buildID, ok := h.parsePathID(w, r, "build_id")
	if !ok {
		return
	}
	credential, ok := h.credentialFor(w, r)
	if !ok {
		return
	}
	build, err := h.store.GetAgentMonthlyBuild(
		r.Context(),
		buildID,
		credential.KeyID,
	)
	if err != nil {
		writeError(w, err)
		return
	}
	if !h.requireProjectScope(w, r, build.ProjectID, false) {
		return
	}
	file, err := h.store.GetAgentMonthlyBuildResult(
		r.Context(),
		buildID,
		credential.KeyID,
	)
	if err != nil {
		writeError(w, err)
		return
	}
	h.writeStoredFile(w, r, file)
}

func (h *Handler) ConfirmBuild(w http.ResponseWriter, r *http.Request) {
	buildID, ok := h.parsePathID(w, r, "build_id")
	if !ok {
		return
	}
	key, ok := h.idempotencyKey(w, r)
	if !ok {
		return
	}
	credential, ok := h.credentialFor(w, r)
	if !ok {
		return
	}
	body, ok := h.readConfirmBody(w, r)
	if !ok {
		return
	}
	requestHash := agentMonthlyConfirmRequestHash(buildID, body)

	build, err := h.store.GetAgentMonthlyBuild(
		r.Context(),
		buildID,
		credential.KeyID,
	)
	if err != nil {
		writeError(w, err)
		return
	}
	if !h.requireProjectScope(w, r, build.ProjectID, false) {
		return
	}

	replay, err := h.store.GetAgentMonthlyConfirmReplay(
		r.Context(),
		store.AgentMonthlyBuildConfirmInput{
			AgentKeyID:     credential.KeyID,
			BuildID:        buildID,
			IdempotencyKey: key,
			RequestHash:    requestHash,
		},
	)
	if err != nil {
		writeError(w, err)
		return
	}
	if replay != nil {
		writeSuccess(
			w,
			http.StatusOK,
			agentMonthlyConfirmedResult(replay),
			&key,
			nil,
		)
		return
	}
	if h.confirmStore == nil {
		writeError(w, store.ErrAgentMonthlyDependency)
		return
	}

	token := strings.TrimSpace(r.Header.Get(agentauth.ConfirmTokenHeader))
	if token == "" {
		preview, err := h.store.GetAgentMonthlyBuildPreview(
			r.Context(),
			buildID,
			credential.KeyID,
		)
		if err != nil {
			writeError(w, err)
			return
		}
		confirmToken, err := newAgentMonthlyConfirmToken()
		if err != nil {
			writeError(w, store.ErrAgentMonthlyDependency)
			return
		}
		record := agentauth.ConfirmRecord{
			Token:          confirmToken,
			AgentID:        credential.AgentID,
			Action:         confirmAction,
			Resource:       agentauth.CanonicalRequestFingerprint(r),
			IdempotencyKey: key,
			BodyHash:       agentauth.ComputeBodyHash(body),
			CreatedAt:      h.now().UTC(),
			Context:        map[string]any{"build_id": buildID},
		}
		if err := h.confirmStore.Put(
			r.Context(),
			record,
			agentauth.DefaultConfirmTTL,
		); err != nil {
			writeError(w, store.ErrAgentMonthlyDependency)
			return
		}
		previewPayload := h.confirmationPreview(build, preview)
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":                    false,
			"requires_confirmation": true,
			"confirm_token":         confirmToken,
			"preview":               previewPayload,
			"expires_in_sec":        int(agentauth.DefaultConfirmTTL.Seconds()),
			"human_message":         "该操作需要用户确认",
			"agent_hint":            "向用户复述 preview 后，用同一 Idempotency-Key + X-Confirm-Token 与完全相同的请求体重放本接口",
		})
		return
	}

	record, err := h.confirmStore.Consume(r.Context(), token)
	if err != nil {
		if errors.Is(err, agentauth.ErrConfirmTokenNotFound) {
			writeError(w, &apiError{
				Status:       http.StatusBadRequest,
				Code:         ErrorCodeConfirmTokenInvalid,
				HumanMessage: "确认凭证无效或与请求体不匹配",
				AgentHint:    "请重新发起预览请求，向用户确认后用同一请求体重放",
			})
			return
		}
		writeError(w, store.ErrAgentMonthlyDependency)
		return
	}
	if record == nil ||
		record.CreatedAt.IsZero() ||
		record.AgentID != credential.AgentID ||
		record.Action != confirmAction ||
		record.IdempotencyKey != key ||
		!constantTimeEqual(record.BodyHash, agentauth.ComputeBodyHash(body)) ||
		record.Resource != agentauth.CanonicalRequestFingerprint(r) {
		writeError(w, &apiError{
			Status:       http.StatusBadRequest,
			Code:         ErrorCodeConfirmTokenInvalid,
			HumanMessage: "确认凭证无效或与请求体不匹配",
			AgentHint:    "请重新发起预览请求，向用户确认后用同一请求体重放",
		})
		return
	}
	if h.now().UTC().Sub(record.CreatedAt) > agentauth.DefaultConfirmTTL {
		writeError(w, &apiError{
			Status:       http.StatusConflict,
			Code:         ErrorCodeConfirmTokenExpired,
			HumanMessage: "确认凭证已过期",
			AgentHint:    "请重新发起预览请求，向用户再次确认后再调用",
		})
		return
	}

	confirmed, err := h.store.ConfirmAgentMonthlyBuild(
		r.Context(),
		store.AgentMonthlyBuildConfirmInput{
			AgentKeyID:     credential.KeyID,
			BuildID:        buildID,
			IdempotencyKey: key,
			RequestHash:    requestHash,
		},
		h.auditEntry(r, key),
	)
	if err != nil {
		writeError(w, err)
		return
	}
	writeSuccess(w, http.StatusOK, agentMonthlyConfirmedResult(confirmed), &key, nil)
}

func (h *Handler) readConfirmBody(
	w http.ResponseWriter,
	r *http.Request,
) ([]byte, bool) {
	reader := http.MaxBytesReader(w, r.Body, maxAgentMonthlyJSONBodyBytes)
	body, err := io.ReadAll(reader)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeError(w, &apiError{
				Status:       http.StatusRequestEntityTooLarge,
				Code:         ErrorCodeTooLarge,
				HumanMessage: "确认请求体超过大小上限",
				AgentHint:    "请压缩请求体后重试",
			})
			return nil, false
		}
		writeError(w, store.ErrAgentMonthlyInvalidInput)
		return nil, false
	}
	return body, true
}

func agentMonthlyConfirmRequestHash(buildID int64, body []byte) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf(
		"%d:%s",
		buildID,
		bodySHA256(body),
	)))
	return hex.EncodeToString(sum[:])
}

func constantTimeEqual(left, right string) bool {
	if len(left) != len(right) {
		return false
	}
	var result byte
	for index := range left {
		result ^= left[index] ^ right[index]
	}
	return result == 0
}

func agentMonthlyConfirmedResult(result *store.AgentMonthlyConfirmResult) map[string]any {
	if result == nil {
		return map[string]any{}
	}
	var confirmedAt any
	if result.ConfirmedAt != nil {
		confirmedAt = httpapiTimestamp(*result.ConfirmedAt)
	}
	return map[string]any{
		"build_id":      result.BuildID,
		"report_id":     result.ReportID,
		"replayed":      result.Replayed,
		"project_id":    result.ProjectID,
		"project_name":  result.ProjectName,
		"country":       result.Country,
		"report_month":  result.ReportMonth,
		"version":       result.Version,
		"is_current":    result.IsCurrent,
		"status":        result.Status,
		"confirmed_at":  confirmedAt,
		"human_message": "月报已正式入库（阶段一不自动替换已有成功月报）",
	}
}

func httpapiTimestamp(value time.Time) string {
	// httpapi.Timestamp is referenced through a tiny wrapper to keep this
	// domain's non-HTTP mapping helpers in one place.
	return formatAgentMonthlyTimestamp(value)
}

func formatAgentMonthlyTimestamp(value time.Time) string {
	value = value.Truncate(time.Microsecond)
	formatted := value.Format("2006-01-02T15:04:05")
	if value.Nanosecond() != 0 {
		formatted += fmt.Sprintf(".%06d", value.Nanosecond()/1000)
	}
	if _, offset := value.Zone(); offset == 0 {
		return formatted + "Z"
	}
	return formatted + value.Format("-07:00")
}
