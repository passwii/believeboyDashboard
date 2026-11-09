package agent_credentials

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/agentauth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/uploads"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

const (
	maxAgentJSONBytes         = 1 << 20
	maxAgentUploadBytes       = 50 * 1024 * 1024
	maxAgentUploadFormBytes   = maxAgentUploadBytes + 2*1024*1024
	defaultIdempotencyTTL     = 24 * time.Hour
	detailIdempotencyConflict = "Idempotency-Key 已被用于不同的请求体"
)

type Handler struct {
	keys            KeyStore
	uploads         UploadStore
	auditor         audit.Service
	confirmStore    agentauth.ConfirmStore
	idempotency     IdempotencyStore
	now             func() time.Time
	confirmTokenTTL time.Duration
}

func NewHandler(keys KeyStore, uploads UploadStore, options Options) *Handler {
	if options.Now == nil {
		options.Now = time.Now
	}
	if options.Idempotency == nil {
		options.Idempotency = NewMemoryIdempotencyStore(options.Now)
	}
	return &Handler{
		keys:            keys,
		uploads:         uploads,
		auditor:         options.Auditor,
		confirmStore:    options.ConfirmStore,
		idempotency:     options.Idempotency,
		now:             options.Now,
		confirmTokenTTL: agentauth.DefaultConfirmTTL,
	}
}

func (handler *Handler) ListAgentKeys(w http.ResponseWriter, r *http.Request) {
	if handler.keys == nil {
		writeDependencyUnavailable(w, "agent credential store is not configured")
		return
	}
	records, err := handler.keys.ListAgentKeys(r.Context())
	if err != nil {
		writeInternalError(w)
		return
	}
	items := make([]AgentKeyItem, 0, len(records))
	for _, record := range records {
		items = append(items, serializeAgentKey(record))
	}
	writeAgentSuccess(w, http.StatusOK, items, "")
}

func (handler *Handler) CreateAgentKey(w http.ResponseWriter, r *http.Request) {
	if handler.keys == nil {
		writeDependencyUnavailable(w, "agent credential store is not configured")
		return
	}
	builder := func(request *http.Request, body []byte) (any, *agentProblem) {
		var payload AgentKeyCreateRequest
		if err := decodeStrictJSON(body, &payload); err != nil {
			return nil, validationProblem("Invalid JSON body")
		}
		if problem := validateCreateRequest(payload, handler.now().UTC(), ProjectValidation{}); problem != nil {
			return nil, problem
		}
		ids, problem := projectIDsFromCreateRequest(payload)
		if problem != nil {
			return nil, problem
		}
		projects, err := handler.keys.ValidateProjects(request.Context(), ids)
		if err != nil {
			return nil, &agentProblem{
				status: http.StatusInternalServerError,
				code:   "INTERNAL_ERROR",
				detail: "failed to validate project_scope",
			}
		}
		if problem := validateCreateRequest(payload, handler.now().UTC(), projects); problem != nil {
			return nil, problem
		}
		exists, err := handler.keys.ActiveAgentKeyExists(request.Context(), payload.AgentID)
		if err != nil {
			return nil, &agentProblem{
				status: http.StatusInternalServerError,
				code:   "INTERNAL_ERROR",
				detail: "failed to validate agent_id uniqueness",
			}
		}
		if exists {
			return nil, validationProblem(fmt.Sprintf(
				"agent_id %q 已存在有效凭据，请先停用或删除旧 key 后再签发",
				payload.AgentID,
			))
		}
		expiresAt := optionalTimeString(payload.ExpiresAt)
		return map[string]any{
			"action":          "agent_key.create",
			"target_agent_id": payload.AgentID,
			"label":           payload.Label,
			"project_scope":   payload.ProjectScope,
			"business_scope":  payload.BusinessScope,
			"item_key":        payload.ItemKey,
			"expires_at":      expiresAt,
			"note":            "将为目标 agent 签发一张新凭据；明文 key 仅在本次响应返回一次",
		}, nil
	}

	handler.withConfirmation(
		"agent_key.create",
		builder,
		func(writer http.ResponseWriter, request *http.Request) {
			handler.applyCreateAgentKey(writer, request)
		},
	)(w, r)
}

func (handler *Handler) UpdateAgentKey(w http.ResponseWriter, r *http.Request) {
	if handler.keys == nil {
		writeDependencyUnavailable(w, "agent credential store is not configured")
		return
	}
	id, ok := parsePathID(w, chiURLParam(r, "key_id"), "Invalid key id")
	if !ok {
		return
	}
	builder := func(request *http.Request, body []byte) (any, *agentProblem) {
		var payload AgentKeyUpdateRequest
		if err := decodeStrictJSON(body, &payload); err != nil {
			return nil, validationProblem("Invalid JSON body")
		}
		if problem := validateUpdateRequest(payload, ProjectValidation{}); problem != nil {
			return nil, problem
		}
		ids, problem := projectIDsFromUpdateRequest(payload)
		if problem != nil {
			return nil, problem
		}
		projects := ProjectValidation{}
		if len(ids) > 0 {
			var err error
			projects, err = handler.keys.ValidateProjects(request.Context(), ids)
			if err != nil {
				return nil, &agentProblem{
					status: http.StatusInternalServerError,
					code:   "INTERNAL_ERROR",
					detail: "failed to validate project_scope",
				}
			}
		}
		if problem := validateUpdateRequest(payload, projects); problem != nil {
			return nil, problem
		}
		return map[string]any{
			"action":         "agent_key.update",
			"label":          payload.Label,
			"project_scope":  payload.ProjectScope,
			"business_scope": payload.BusinessScope,
			"item_key":       payload.ItemKey,
			"note":           "将更新目标 key 的权限与业务范围；编辑即刻生效",
		}, nil
	}

	handler.withConfirmation(
		"agent_key.update",
		builder,
		func(writer http.ResponseWriter, request *http.Request) {
			handler.applyUpdateAgentKey(writer, request, id)
		},
	)(w, r)
}

func (handler *Handler) applyCreateAgentKey(w http.ResponseWriter, r *http.Request) {
	if handler.keys == nil {
		writeDependencyUnavailable(w, "agent credential store is not configured")
		return
	}
	body, err := readAgentJSONBody(w, r)
	if err != nil {
		writeAgentProblem(w, validationProblem("Invalid JSON body"))
		return
	}
	var payload AgentKeyCreateRequest
	if err := decodeStrictJSON(body, &payload); err != nil {
		writeAgentProblem(w, validationProblem("Invalid JSON body"))
		return
	}
	credential, ok := agentauth.CredentialFromRequest(r)
	if !ok {
		agentauth.WriteError(w, http.StatusUnauthorized, agentauth.ErrorCodeAgentAuthFailed, agentauth.DetailTokenInvalid)
		return
	}
	actor := Actor{AgentID: credential.AgentID, Name: credential.Label}
	entry := audit.Entry{
		Action:     "api_key.create",
		TargetType: "agent_api_key",
		AgentID:    stringPointer(actor.AgentID),
		AgentName:  optionalStringPointer(actor.Name),
		AfterJSON: map[string]any{
			"target_agent_id": payload.AgentID,
			"label":           payload.Label,
			"project_scope":   payload.ProjectScope,
			"business_scope":  payload.BusinessScope,
			"item_key":        payload.ItemKey,
			"expires_at":      optionalTimeString(payload.ExpiresAt),
			"via":             "agent_provisioning",
		},
	}
	entry.PopulateFromRequest(r)
	record, plaintext, err := handler.keys.CreateAgentKey(
		r.Context(),
		AgentKeyCreateInput{
			Label:         payload.Label,
			AgentID:       payload.AgentID,
			ProjectScope:  payload.ProjectScope,
			BusinessScope: payload.BusinessScope,
			ItemKey:       payload.ItemKey,
			ExpiresAt:     payload.ExpiresAt,
		},
		actor,
		entry,
	)
	if err != nil {
		if errors.Is(err, ErrAgentKeyExists) {
			writeAgentProblem(w, validationProblem(
				fmt.Sprintf("agent_id %q 已存在有效凭据，请先停用或删除旧 key 后再签发", payload.AgentID),
			))
			return
		}
		writeInternalError(w)
		return
	}
	if record == nil {
		writeInternalError(w)
		return
	}
	idempotencyKey := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	writeAgentSuccess(w, http.StatusOK, AgentKeyCreateResponse{
		ID:            record.ID,
		KeyPrefix:     record.KeyPrefix,
		Label:         record.Label,
		ProjectScope:  record.ProjectScope,
		BusinessScope: record.BusinessScope,
		AgentID:       record.AgentID,
		ItemKey:       record.ItemKey,
		ExpiresAt:     httpapi.OptionalTimestamp(record.ExpiresAt),
		PlaintextKey:  plaintext,
	}, idempotencyKey)
}

func (handler *Handler) applyUpdateAgentKey(
	w http.ResponseWriter,
	r *http.Request,
	id int64,
) {
	if handler.keys == nil {
		writeDependencyUnavailable(w, "agent credential store is not configured")
		return
	}
	body, err := readAgentJSONBody(w, r)
	if err != nil {
		writeAgentProblem(w, validationProblem("Invalid JSON body"))
		return
	}
	var payload AgentKeyUpdateRequest
	if err := decodeStrictJSON(body, &payload); err != nil {
		writeAgentProblem(w, validationProblem("Invalid JSON body"))
		return
	}
	credential, ok := agentauth.CredentialFromRequest(r)
	if !ok {
		agentauth.WriteError(w, http.StatusUnauthorized, agentauth.ErrorCodeAgentAuthFailed, agentauth.DetailTokenInvalid)
		return
	}
	actor := Actor{AgentID: credential.AgentID, Name: credential.Label}
	entry := audit.Entry{
		Action:     "api_key.update",
		TargetType: "agent_api_key",
		TargetID:   int64StringPointer(id),
		AgentID:    stringPointer(actor.AgentID),
		AgentName:  optionalStringPointer(actor.Name),
		AfterJSON: map[string]any{
			"label":          payload.Label,
			"project_scope":  payload.ProjectScope,
			"business_scope": payload.BusinessScope,
			"item_key":       payload.ItemKey,
			"via":            "agent_provisioning",
		},
	}
	entry.PopulateFromRequest(r)
	record, err := handler.keys.UpdateAgentKey(
		r.Context(),
		id,
		AgentKeyUpdateInput{
			Label:         payload.Label,
			ProjectScope:  payload.ProjectScope,
			BusinessScope: payload.BusinessScope,
			ItemKey:       payload.ItemKey,
		},
		actor,
		entry,
	)
	if err != nil {
		if errors.Is(err, ErrAgentKeyNotFound) {
			writeResourceNotFound(w, "API key not found")
			return
		}
		writeInternalError(w)
		return
	}
	if record == nil {
		writeResourceNotFound(w, "API key not found")
		return
	}
	idempotencyKey := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	writeAgentSuccess(w, http.StatusOK, AgentKeyUpdateResponse{
		ID:            record.ID,
		KeyPrefix:     record.KeyPrefix,
		Label:         record.Label,
		Scope:         record.Scope,
		ProjectScope:  record.ProjectScope,
		BusinessScope: record.BusinessScope,
		AgentID:       record.AgentID,
		ItemKey:       record.ItemKey,
		IsRevoked:     record.IsRevoked,
		ExpiresAt:     httpapi.OptionalTimestamp(record.ExpiresAt),
		CreatedAt:     httpapi.Timestamp(record.CreatedAt),
		LastUsedAt:    httpapi.OptionalTimestamp(record.LastUsedAt),
	}, idempotencyKey)
}

func (handler *Handler) ValidateUpload(w http.ResponseWriter, r *http.Request) {
	if handler.uploads == nil {
		writeDependencyUnavailable(w, "report upload store is not configured")
		return
	}
	file, header, contentType, data, ok := handler.readMultipartUpload(w, r)
	if !ok {
		return
	}
	defer file.Close()
	filename := header.Filename
	reportType := strings.TrimSpace(r.FormValue("report_type"))
	if reportType == "" {
		writeAgentProblem(w, validationProblem("report_type is required"))
		return
	}
	country := normalizeCountry(r.FormValue("country"))
	if country == "" {
		writeUploadDetail(w, http.StatusBadRequest, "country must be one of: DE, UK, US")
		return
	}
	if problem := validateUploadFile(header.Filename, contentType, data); problem != nil {
		writeAgentProblem(w, problem)
		return
	}
	response, err := handler.uploads.Validate(r.Context(), AgentUploadValidateRequest{
		Filename:   filename,
		ReportType: normalizeReportType(reportType),
		Country:    country,
		Data:       data,
	})
	if err != nil {
		handler.auditUploadFailure(r, "report_upload.validate", nil, err)
		writeUploadStoreError(w, err)
		return
	}
	handler.auditUploadSuccess(r, "report_upload.validate", response.TempFileID, response)
	writeJSON(w, http.StatusOK, response)
}

func (handler *Handler) CommitUpload(w http.ResponseWriter, r *http.Request) {
	if handler.uploads == nil || handler.keys == nil {
		writeDependencyUnavailable(w, "report upload store is not configured")
		return
	}
	body, err := readAgentJSONBody(w, r)
	if err != nil {
		writeAgentProblem(w, &agentProblem{
			status: http.StatusUnprocessableEntity,
			code:   "VALIDATION_FAILED",
			detail: "Invalid request body",
		})
		return
	}
	var payload AgentUploadCommitRequest
	if err := decodeStrictJSON(body, &payload); err != nil {
		writeAgentProblem(w, &agentProblem{
			status: http.StatusUnprocessableEntity,
			code:   "VALIDATION_FAILED",
			detail: "Invalid request body",
		})
		return
	}
	payload.TempFileID = strings.TrimSpace(payload.TempFileID)
	payload.ReportType = normalizeReportType(strings.TrimSpace(payload.ReportType))
	if payload.TempFileID == "" || payload.ReportType == "" {
		writeAgentProblem(w, validationProblem("temp_file_id and report_type are required"))
		return
	}
	payload.Country = normalizeCountry(payload.Country)
	if payload.Country == "" {
		writeUploadDetail(w, http.StatusBadRequest, "country must be one of: DE, UK, US")
		return
	}
	for field, value := range map[string]*string{
		"report_date":       payload.ReportDate,
		"report_start_date": payload.ReportStartDate,
		"report_end_date":   payload.ReportEndDate,
	} {
		if problem := validateDate(value, field); problem != nil {
			writeAgentProblem(w, problem)
			return
		}
	}
	projectName := ""
	if payload.ProjectName != nil {
		projectName = strings.TrimSpace(*payload.ProjectName)
	}
	if projectName == "" {
		writeAgentProblem(w, &agentProblem{
			status: http.StatusUnprocessableEntity,
			code:   "VALIDATION_FAILED",
			detail: "project_name 必填（agent 通道不支持自动匹配入库）",
		})
		return
	}
	payload.ProjectName = &projectName
	credential, ok := agentauth.CredentialFromRequest(r)
	if !ok {
		agentauth.WriteError(w, http.StatusUnauthorized, agentauth.ErrorCodeAgentAuthFailed, agentauth.DetailTokenInvalid)
		return
	}
	projectID, active, err := handler.keys.ProjectByName(r.Context(), projectName)
	if err != nil {
		writeInternalError(w)
		return
	}
	if !active || projectID <= 0 {
		writeProjectOutOfScope(w)
		return
	}
	if !projectScopeAllows(credential.ProjectScope, projectID) {
		writeProjectOutOfScope(w)
		return
	}

	idempotencyKey, present, problem := readIdempotencyKey(r)
	if problem != nil {
		writeAgentProblem(w, problem)
		return
	}
	fingerprint := idempotencyFingerprint(r, body, credential.AgentID)
	reserved := false
	if present && idempotencyKey != "" {
		if handler.idempotency == nil {
			writeDependencyUnavailable(w, "idempotency store is not configured")
			return
		}
		cached, hit, err := handler.idempotency.Reserve(
			r.Context(),
			credential.AgentID+":"+idempotencyKey,
			fingerprint,
			defaultIdempotencyTTL,
		)
		if err != nil {
			if errors.Is(err, ErrIdempotencyConflict) {
				writeIdempotencyConflict(w)
				return
			}
			writeInternalError(w)
			return
		}
		if hit {
			writeRawJSON(w, http.StatusOK, cached)
			return
		}
		reserved = true
	}

	response, err := handler.uploads.Commit(
		r.Context(),
		payload,
		credential.ProjectScope,
	)
	if err != nil {
		if reserved {
			_ = handler.idempotency.Release(
				r.Context(),
				credential.AgentID+":"+idempotencyKey,
				fingerprint,
			)
		}
		handler.auditUploadFailure(r, "report_upload.commit", &payload.TempFileID, err)
		writeUploadStoreError(w, err)
		return
	}
	if response.DuplicateWarnings == nil {
		response.DuplicateWarnings = []uploads.DuplicateWarning{}
	}
	handler.auditUploadSuccess(r, "report_upload.commit", response.FileID, response)
	payloadBytes, err := json.Marshal(response)
	if err != nil {
		writeInternalError(w)
		return
	}
	if reserved {
		if err := handler.idempotency.Complete(
			r.Context(),
			credential.AgentID+":"+idempotencyKey,
			fingerprint,
			payloadBytes,
			defaultIdempotencyTTL,
		); err != nil {
			if errors.Is(err, ErrIdempotencyConflict) {
				writeIdempotencyConflict(w)
				return
			}
			writeInternalError(w)
			return
		}
	}
	writeRawJSON(w, http.StatusOK, payloadBytes)
}

type confirmationBuilder func(*http.Request, []byte) (any, *agentProblem)

func (handler *Handler) withConfirmation(
	action string,
	builder confirmationBuilder,
	next http.HandlerFunc,
) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		credential, ok := agentauth.CredentialFromRequest(r)
		if !ok {
			agentauth.WriteError(w, http.StatusUnauthorized, agentauth.ErrorCodeAgentAuthFailed, agentauth.DetailTokenInvalid)
			return
		}
		if handler.confirmStore == nil {
			writeDependencyUnavailable(w, "confirmation store is not configured")
			return
		}
		body, err := readAgentJSONBody(w, r)
		if err != nil {
			writeAgentProblem(w, validationProblem("Invalid JSON body"))
			return
		}
		rawIdempotencyKey, _, problem := readIdempotencyKey(r)
		if problem != nil {
			writeAgentProblem(w, problem)
			return
		}
		token := strings.TrimSpace(r.Header.Get(agentauth.ConfirmTokenHeader))
		if token == "" {
			preview, problem := builder(r, body)
			if problem != nil {
				writeAgentProblem(w, problem)
				return
			}
			confirmToken, err := newConfirmationToken()
			if err != nil {
				writeInternalError(w)
				return
			}
			record := agentauth.ConfirmRecord{
				Token:          confirmToken,
				AgentID:        credential.AgentID,
				Action:         action,
				Resource:       agentauth.CanonicalRequestFingerprint(r),
				IdempotencyKey: rawIdempotencyKey,
				BodyHash:       agentauth.ComputeBodyHash(body),
				CreatedAt:      handler.now().UTC(),
				Context: map[string]any{
					"preview":        preview,
					"key_id":         strconv.FormatInt(credential.KeyID, 10),
					"business_scope": credential.BusinessScope,
					"project_scope":  credential.ProjectScope,
				},
			}
			if err := handler.confirmStore.Put(r.Context(), record, handler.confirmTokenTTL); err != nil {
				writeDependencyUnavailable(w, agentauth.DetailConfirmStoreError)
				return
			}
			writeJSON(w, http.StatusOK, struct {
				OK                   bool   `json:"ok"`
				RequiresConfirmation bool   `json:"requires_confirmation"`
				ConfirmToken         string `json:"confirm_token"`
				Preview              any    `json:"preview"`
				Message              string `json:"message"`
			}{
				OK:                   false,
				RequiresConfirmation: true,
				ConfirmToken:         confirmToken,
				Preview:              preview,
				Message:              "该操作需要用户确认",
			})
			return
		}

		record, err := handler.confirmStore.Consume(r.Context(), token)
		if err != nil {
			if errors.Is(err, agentauth.ErrConfirmTokenNotFound) {
				agentauth.WriteError(
					w,
					http.StatusBadRequest,
					agentauth.ErrorCodeConfirmTokenInvalid,
					agentauth.DetailConfirmInvalid,
				)
				return
			}
			writeDependencyUnavailable(w, agentauth.DetailConfirmStoreError)
			return
		}
		if record == nil {
			agentauth.WriteError(
				w,
				http.StatusBadRequest,
				agentauth.ErrorCodeConfirmTokenInvalid,
				agentauth.DetailConfirmInvalid,
			)
			return
		}
		if record.CreatedAt.IsZero() ||
			handler.now().UTC().Sub(record.CreatedAt) > handler.confirmTokenTTL {
			agentauth.WriteError(
				w,
				http.StatusConflict,
				agentauth.ErrorCodeConfirmTokenExpired,
				agentauth.DetailConfirmExpired,
			)
			return
		}
		if record.AgentID != credential.AgentID ||
			record.Action != action ||
			record.IdempotencyKey != rawIdempotencyKey ||
			record.BodyHash != agentauth.ComputeBodyHash(body) ||
			(record.Resource != "" && record.Resource != agentauth.CanonicalRequestFingerprint(r)) {
			agentauth.WriteError(
				w,
				http.StatusBadRequest,
				agentauth.ErrorCodeConfirmTokenInvalid,
				agentauth.DetailConfirmInvalid,
			)
			return
		}
		if !confirmationScopeMatches(record.Context, credential) {
			agentauth.WriteError(
				w,
				http.StatusBadRequest,
				agentauth.ErrorCodeConfirmTokenInvalid,
				agentauth.DetailConfirmInvalid,
			)
			return
		}
		ctx := agentauth.WithConfirmRecord(r.Context(), record)
		if record.Context != nil {
			ctx = agentauth.WithConfirmContextValue(ctx, record.Context)
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		next(w, r.WithContext(ctx))
	}
}

func (handler *Handler) readMultipartUpload(
	w http.ResponseWriter,
	r *http.Request,
) (multipart.File, *multipart.FileHeader, string, []byte, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxAgentUploadFormBytes)
	if err := r.ParseMultipartForm(maxAgentUploadBytes); err != nil {
		if requestBodyTooLarge(err) {
			writeUploadDetail(w, http.StatusRequestEntityTooLarge, "File too large")
			return nil, nil, "", nil, false
		}
		writeUploadDetail(w, http.StatusBadRequest, "Invalid multipart form")
		return nil, nil, "", nil, false
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeUploadDetail(w, http.StatusBadRequest, "Missing file in multipart form")
		return nil, nil, "", nil, false
	}
	if header == nil || !safeUploadFilename(header.Filename) {
		_ = file.Close()
		writeUploadDetail(w, http.StatusBadRequest, "Invalid filename path")
		return nil, nil, "", nil, false
	}
	contentType := strings.ToLower(strings.TrimSpace(header.Header.Get("Content-Type")))
	data, err := io.ReadAll(io.LimitReader(file, maxAgentUploadBytes+1))
	if err != nil {
		_ = file.Close()
		writeUploadDetail(w, http.StatusBadRequest, "Failed to read file")
		return nil, nil, "", nil, false
	}
	if int64(len(data)) > maxAgentUploadBytes {
		_ = file.Close()
		writeUploadDetail(w, http.StatusRequestEntityTooLarge, "File too large")
		return nil, nil, "", nil, false
	}
	if len(data) == 0 {
		_ = file.Close()
		writeUploadDetail(w, http.StatusBadRequest, "File is empty")
		return nil, nil, "", nil, false
	}
	return file, header, contentType, data, true
}

func validateUploadFile(filename, contentType string, data []byte) *agentProblem {
	extension := strings.ToLower(filepath.Ext(filename))
	switch extension {
	case ".csv", ".txt", ".xlsx":
	default:
		return &agentProblem{
			status: http.StatusBadRequest,
			code:   "VALIDATION_FAILED",
			detail: fmt.Sprintf("Unsupported extension: %s (expected: .csv, .txt, .xlsx)", extension),
		}
	}
	if contentType != "" && !allowedUploadContentType(contentType) {
		return &agentProblem{
			status: http.StatusBadRequest,
			code:   "VALIDATION_FAILED",
			detail: fmt.Sprintf("Unsupported MIME type: %s", contentType),
		}
	}
	if bytes.ContainsRune(data, '\x00') {
		return &agentProblem{
			status: http.StatusBadRequest,
			code:   "VALIDATION_FAILED",
			detail: "File contains NUL bytes",
		}
	}
	if extension == ".xlsx" && !validXLSXArchive(data) {
		return &agentProblem{
			status: http.StatusBadRequest,
			code:   "VALIDATION_FAILED",
			detail: "Invalid XLSX archive",
		}
	}
	if extension != ".xlsx" && bytes.HasPrefix(data, []byte("PK\x03\x04")) {
		return &agentProblem{
			status: http.StatusBadRequest,
			code:   "VALIDATION_FAILED",
			detail: "File content does not match extension",
		}
	}
	return nil
}

func safeUploadFilename(filename string) bool {
	filename = strings.TrimSpace(filename)
	return filename != "" &&
		filepath.Base(filename) == filename &&
		!filepath.IsAbs(filename) &&
		!strings.Contains(filename, `\`) &&
		!strings.Contains(filename, "/") &&
		!strings.Contains(filename, "..")
}

func allowedUploadContentType(contentType string) bool {
	switch strings.Split(strings.ToLower(contentType), ";")[0] {
	case "text/plain", "text/csv", "application/csv", "application/vnd.ms-excel",
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		"application/octet-stream":
		return true
	default:
		return false
	}
}

func validXLSXArchive(data []byte) bool {
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return false
	}
	for _, file := range reader.File {
		if file.Name == "[Content_Types].xml" {
			return true
		}
	}
	return false
}

func (handler *Handler) auditUploadSuccess(
	r *http.Request,
	action string,
	targetID string,
	after any,
) {
	if handler.auditor == nil {
		return
	}
	credential, _ := agentauth.CredentialFromRequest(r)
	entry := audit.Entry{
		Action:     action,
		TargetType: "report_upload",
		TargetID:   optionalStringPointer(targetID),
		AgentID:    stringPointer(credential.AgentID),
		AgentName:  optionalStringPointer(credential.Label),
		AfterJSON:  after,
	}
	entry.PopulateFromRequest(r)
	_ = handler.auditor.LogAction(r.Context(), entry)
}

func (handler *Handler) auditUploadFailure(
	r *http.Request,
	action string,
	targetID *string,
	err error,
) {
	if handler.auditor == nil {
		return
	}
	credential, _ := agentauth.CredentialFromRequest(r)
	message := err.Error()
	entry := audit.Entry{
		Action:       action,
		TargetType:   "report_upload",
		TargetID:     targetID,
		AgentID:      stringPointer(credential.AgentID),
		AgentName:    optionalStringPointer(credential.Label),
		Result:       "failure",
		ErrorMessage: &message,
	}
	entry.PopulateFromRequest(r)
	_ = handler.auditor.LogAction(r.Context(), entry)
}

func writeAgentProblem(w http.ResponseWriter, problem *agentProblem) {
	if problem == nil {
		writeInternalError(w)
		return
	}
	code := problem.code
	if code == "" {
		code = agentauth.ErrorCodeValidationFailed
	}
	agentauth.WriteError(w, problem.status, code, problem.detail)
}

func writeProjectOutOfScope(w http.ResponseWriter) {
	agentauth.WriteError(
		w,
		http.StatusForbidden,
		agentauth.ErrorCodeAgentProjectOutOfScope,
		agentauth.DetailProjectNotInScope,
	)
}

func writeResourceNotFound(w http.ResponseWriter, detail string) {
	agentauth.WriteError(w, http.StatusNotFound, "RESOURCE_NOT_FOUND", detail)
}

func writeDependencyUnavailable(w http.ResponseWriter, detail string) {
	agentauth.WriteError(w, http.StatusServiceUnavailable, "DEPENDENCY_UNAVAILABLE", detail)
}

func writeIdempotencyConflict(w http.ResponseWriter) {
	agentauth.WriteError(w, http.StatusConflict, "IDEMPOTENCY_CONFLICT", detailIdempotencyConflict)
}

func writeInternalError(w http.ResponseWriter) {
	agentauth.WriteError(
		w,
		http.StatusInternalServerError,
		agentauth.ErrorCodeInternalError,
		agentauth.DetailInternalError,
	)
}

func writeUploadDetail(w http.ResponseWriter, status int, detail string) {
	agentauth.WriteError(w, status, agentauth.ErrorCodeValidationFailed, detail)
}

func writeUploadStoreError(w http.ResponseWriter, err error) {
	var apiErr *uploads.APIError
	if errors.As(err, &apiErr) {
		writeUploadDetail(w, apiErr.Status, apiErr.Detail)
		return
	}
	switch {
	case errors.Is(err, ErrAgentProjectOutOfScope):
		writeProjectOutOfScope(w)
	case errors.Is(err, ErrUploadTempNotFound):
		writeResourceNotFound(w, "temp_file_id not found")
	case errors.Is(err, ErrUploadTypeMismatch):
		writeUploadDetail(w, http.StatusUnprocessableEntity, ErrUploadTypeMismatch.Error())
	case errors.Is(err, ErrUploadDependencyMissing):
		writeDependencyUnavailable(w, err.Error())
	default:
		writeInternalError(w)
	}
}

func readAgentJSONBody(w http.ResponseWriter, r *http.Request) ([]byte, error) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxAgentJSONBytes))
	r.Body = io.NopCloser(bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	if len(bytes.TrimSpace(body)) == 0 {
		return nil, io.EOF
	}
	return body, nil
}

func idempotencyFingerprint(r *http.Request, body []byte, agentID string) string {
	return agentID + "|" + agentauth.CanonicalRequestFingerprint(r) + "|" +
		agentauth.ComputeBodyHash(body)
}

func readIdempotencyKey(r *http.Request) (string, bool, *agentProblem) {
	values := r.Header.Values("Idempotency-Key")
	if len(values) == 0 {
		return "", false, nil
	}
	raw := values[len(values)-1]
	if raw == "" || len(raw) > 64 {
		return "", true, validationProblem(
			"Idempotency-Key 必须为非空字符串且不超过 64 字符",
		)
	}
	return raw, true, nil
}

func confirmationScopeMatches(contextValue map[string]any, credential agentauth.AgentCredential) bool {
	if contextValue == nil {
		return false
	}
	keyID, _ := contextValue["key_id"].(string)
	businessScope, _ := contextValue["business_scope"].(string)
	projectScope, _ := contextValue["project_scope"].(string)
	return keyID == strconv.FormatInt(credential.KeyID, 10) &&
		businessScope == credential.BusinessScope &&
		projectScope == credential.ProjectScope
}

func newConfirmationToken() (string, error) {
	random := make([]byte, 24)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	return "cf_" + base64.RawURLEncoding.EncodeToString(random), nil
}

func parsePathID(
	w http.ResponseWriter,
	raw string,
	message string,
) (int64, bool) {
	id, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil || id < 1 {
		writeAgentProblem(w, &agentProblem{
			status: http.StatusUnprocessableEntity,
			code:   "VALIDATION_FAILED",
			detail: message,
		})
		return 0, false
	}
	return id, true
}

func serializeAgentKey(record AgentKey) AgentKeyItem {
	return AgentKeyItem{
		ID:            record.ID,
		KeyPrefix:     record.KeyPrefix,
		Label:         record.Label,
		Scope:         record.Scope,
		ProjectScope:  record.ProjectScope,
		BusinessScope: record.BusinessScope,
		AgentID:       record.AgentID,
		ItemKey:       record.ItemKey,
		IsRevoked:     record.IsRevoked,
		ExpiresAt:     httpapi.OptionalTimestamp(record.ExpiresAt),
		CreatedAt:     httpapi.Timestamp(record.CreatedAt),
		LastUsedAt:    httpapi.OptionalTimestamp(record.LastUsedAt),
	}
}

func optionalTimeString(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := httpapi.Timestamp(value.UTC())
	return &formatted
}

func stringPointer(value string) *string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	copy := value
	return &copy
}

func optionalStringPointer(value string) *string {
	return stringPointer(value)
}

func int64StringPointer(value int64) *string {
	formatted := strconv.FormatInt(value, 10)
	return &formatted
}

func writeAgentSuccess(w http.ResponseWriter, status int, data any, idempotencyKey string) {
	payload := struct {
		OK             bool   `json:"ok"`
		Data           any    `json:"data"`
		IdempotencyKey string `json:"idempotency_key,omitempty"`
	}{
		OK:             true,
		Data:           data,
		IdempotencyKey: strings.TrimSpace(idempotencyKey),
	}
	writeJSON(w, status, payload)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	payload, err := json.Marshal(value)
	if err != nil {
		writeInternalError(w)
		return
	}
	writeRawJSON(w, status, payload)
}

func writeRawJSON(w http.ResponseWriter, status int, payload []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}

func requestBodyTooLarge(err error) bool {
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "too large") ||
		strings.Contains(message, "request body")
}

func normalizeReportType(value string) string {
	switch strings.TrimSpace(value) {
	case "ad_report":
		return "ad_product_report"
	default:
		return strings.TrimSpace(value)
	}
}

// chiURLParam is kept small so the handler remains testable without a route parser.
func chiURLParam(r *http.Request, name string) string {
	if r == nil {
		return ""
	}
	if value := chi.URLParam(r, name); value != "" {
		return value
	}
	if value := r.PathValue(name); value != "" {
		return value
	}
	if params, ok := r.Context().Value(routeParamsContextKey{}).(map[string]string); ok {
		return params[name]
	}
	return ""
}

type routeParamsContextKey struct{}

func withRouteParams(r *http.Request, params map[string]string) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), routeParamsContextKey{}, params))
}
