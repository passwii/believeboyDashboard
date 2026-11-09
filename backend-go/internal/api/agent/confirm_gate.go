package agent

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

type confirmationPreview struct {
	OK                   bool           `json:"ok"`
	RequiresConfirmation bool           `json:"requires_confirmation"`
	ConfirmToken         string         `json:"confirm_token"`
	Preview              map[string]any `json:"preview"`
	ExpiresInSec         int            `json:"expires_in_sec"`
	HumanMessage         string         `json:"human_message"`
	AgentHint            string         `json:"agent_hint"`
}

func (h *Handler) confirmStore() ConfirmStore {
	return h.options.ConfirmStore
}

func (h *Handler) gateConfirmation(
	w http.ResponseWriter,
	r *http.Request,
	action string,
	preview map[string]any,
	validate ...func(body []byte) error,
) ([]byte, map[string]any, bool) {
	const maxConfirmBodyBytes = 10 * 1024 * 1024 // 10MB
	r.Body = http.MaxBytesReader(w, r.Body, maxConfirmBodyBytes)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			writeValidationError(w, "请求体超过 10MB 上限", nil)
			return nil, nil, false
		}
		writeValidationError(w, "请求体读取失败", nil)
		return nil, nil, false
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	if len(bytes.TrimSpace(body)) == 0 {
		body = []byte("{}")
	}
	if !json.Valid(body) {
		writeValidationError(w, "请求体必须是 JSON 对象", nil)
		return nil, nil, false
	}
	if len(validate) > 0 && validate[0] != nil {
		if err := validate[0](body); err != nil {
			writeValidationError(w, err.Error(), nil)
			return nil, nil, false
		}
	}
	credential, ok := CredentialFromContext(r.Context())
	if !ok {
		writeAPIError(w, ErrorWithReason(ErrAgentAuthFailed, "token_invalid"))
		return nil, nil, false
	}
	tokenHeader := strings.TrimSpace(r.Header.Get("X-Confirm-Token"))
	idempotencyKey := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	resourceFingerprint := canonicalRequestFingerprint(r)
	if tokenHeader == "" {
		token, err := newConfirmToken()
		if err != nil {
			writeAPIError(w, NewAPIError(ErrInternal))
			return nil, nil, false
		}
		record := ConfirmRecord{
			Token:               token,
			AgentID:             credential.AgentID,
			Action:              action,
			ResourceFingerprint: resourceFingerprint,
			IdempotencyKey:      idempotencyKey,
			BodyHash:            HashConfirmBody(body),
			CreatedAt:           h.options.now().UTC(),
		}
		if err := h.confirmStore().Put(r.Context(), record, defaultConfirmTTL); err != nil {
			writeAPIError(w, NewAPIError(ErrInternal))
			return nil, nil, false
		}
		if preview == nil {
			preview = map[string]any{}
		}
		preview["action"] = action
		_ = writeJSON(w, http.StatusOK, confirmationPreview{
			OK:                   false,
			RequiresConfirmation: true,
			ConfirmToken:         token,
			Preview:              preview,
			ExpiresInSec:         int(defaultConfirmTTL.Seconds()),
			HumanMessage:         "该操作需要用户确认",
			AgentHint: "向用户复述上述摘要；用户确认后用同一 Idempotency-Key + " +
				"X-Confirm-Token 与完全相同的请求体重放同一接口",
		})
		return nil, nil, false
	}

	record, err := h.confirmStore().Pop(r.Context(), tokenHeader)
	if err != nil {
		if errors.Is(err, ErrConfirmTokenExpired) {
			writeAPIError(w, NewAPIError(CodeConfirmTokenExpired))
		} else {
			writeAPIError(w, NewAPIError(CodeConfirmTokenInvalid))
		}
		return nil, nil, false
	}
	if record.Action != action ||
		record.AgentID != credential.AgentID ||
		record.IdempotencyKey != idempotencyKey ||
		record.BodyHash != HashConfirmBody(body) ||
		(record.ResourceFingerprint != "" && record.ResourceFingerprint != resourceFingerprint) {
		writeAPIError(w, NewAPIError(CodeConfirmTokenInvalid))
		return nil, nil, false
	}
	if h.options.now().UTC().Sub(record.CreatedAt) > defaultConfirmTTL {
		writeAPIError(w, NewAPIError(CodeConfirmTokenExpired))
		return nil, nil, false
	}
	context := record.Context
	if context == nil {
		context = map[string]any{}
	}
	return body, context, true
}

func canonicalRequestFingerprint(r *http.Request) string {
	if r == nil || r.URL == nil {
		return ""
	}
	path := r.URL.EscapedPath()
	if path == "" {
		path = "/"
	}
	query := r.URL.Query().Encode()
	fingerprint := r.Method + " " + path
	if query != "" {
		fingerprint += "?" + query
	}
	return fingerprint
}

func writeJSON(w http.ResponseWriter, status int, value any) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, err = w.Write(payload)
	return err
}

func confirmTTL() time.Duration {
	return defaultConfirmTTL
}
