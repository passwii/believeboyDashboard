package agent_commerce

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/agentauth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

const (
	maxJSONConfirmBody = 10 * 1024 * 1024
	confirmTTL         = 5 * time.Minute
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

func (h *Handler) confirmJSON(
	w http.ResponseWriter,
	r *http.Request,
	action string,
	validate func([]byte) *APIError,
	buildPreview func([]byte) (map[string]any, *APIError),
) ([]byte, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxJSONConfirmBody)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeValidationError(w, "请求体超过 10MB 上限", nil)
			return nil, false
		}
		writeValidationError(w, "请求体读取失败", nil)
		return nil, false
	}
	r.Body = io.NopCloser(bytes.NewReader(body))

	idempotencyKey, apiErr := requestIdempotencyKey(r)
	if apiErr != nil {
		writeAPIError(w, apiErr)
		return nil, false
	}
	if validate != nil {
		if apiErr := validate(body); apiErr != nil {
			writeAPIError(w, apiErr)
			return nil, false
		}
	}
	token := strings.TrimSpace(r.Header.Get(agentauth.ConfirmTokenHeader))
	if token == "" {
		preview := map[string]any{}
		if buildPreview != nil {
			var previewErr *APIError
			preview, previewErr = buildPreview(body)
			if previewErr != nil {
				writeAPIError(w, previewErr)
				return nil, false
			}
		}
		preview["action"] = action
		record, tokenErr := h.issueConfirm(r, action, idempotencyKey, hashBytes(body))
		if tokenErr != nil {
			writeAPIError(w, newAPIError(CodeServiceUnavailable))
			return nil, false
		}
		_ = httpapi.WriteJSON(w, http.StatusOK, confirmationPreview{
			OK:                   false,
			RequiresConfirmation: true,
			ConfirmToken:         record.Token,
			Preview:              preview,
			ExpiresInSec:         int(confirmTTL.Seconds()),
			HumanMessage:         "该操作需要用户确认",
			AgentHint:            "向用户复述上述摘要；用户确认后用同一 Idempotency-Key + X-Confirm-Token 与完全相同的请求体重放同一接口",
		})
		return nil, false
	}

	credential, ok := agentauth.CredentialFromRequest(r)
	if !ok {
		writeAPIError(w, APIErrorWithMessage(CodeAgentAuthFailed, "token_invalid"))
		return nil, false
	}
	record, err := h.confirmStore().Consume(r.Context(), token)
	if err != nil {
		if errors.Is(err, agentauth.ErrConfirmTokenNotFound) {
			writeAPIError(w, newAPIError(CodeConfirmTokenInvalid))
		} else {
			writeAPIError(w, newAPIError(CodeServiceUnavailable))
		}
		return nil, false
	}
	if record == nil {
		writeAPIError(w, newAPIError(CodeConfirmTokenInvalid))
		return nil, false
	}
	if record.CreatedAt.IsZero() {
		writeAPIError(w, newAPIError(CodeConfirmTokenInvalid))
		return nil, false
	}
	if h.options.now().Sub(record.CreatedAt) > confirmTTL {
		writeAPIError(w, newAPIError(CodeConfirmTokenExpired))
		return nil, false
	}
	if record.AgentID != credential.AgentID ||
		record.Action != action ||
		record.IdempotencyKey != idempotencyKey ||
		!hashEqual(record.BodyHash, hashBytes(body)) ||
		record.Resource != agentauth.CanonicalRequestFingerprint(r) {
		writeAPIError(w, newAPIError(CodeConfirmTokenInvalid))
		return nil, false
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	return body, true
}

func (h *Handler) issueConfirm(
	r *http.Request,
	action string,
	idempotencyKey, bodyHash string,
) (*agentauth.ConfirmRecord, error) {
	return h.issueConfirmForHash(r, action, idempotencyKey, bodyHash)
}

func (h *Handler) issueConfirmForHash(
	r *http.Request,
	action string,
	idempotencyKey, bodyHash string,
) (*agentauth.ConfirmRecord, error) {
	credential, ok := agentauth.CredentialFromRequest(r)
	if !ok {
		return nil, errors.New("agent credential missing")
	}
	random := make([]byte, 24)
	if _, err := rand.Read(random); err != nil {
		return nil, err
	}
	record := agentauth.ConfirmRecord{
		Token:          "cf_" + base64.RawURLEncoding.EncodeToString(random),
		AgentID:        credential.AgentID,
		Action:         action,
		Resource:       agentauth.CanonicalRequestFingerprint(r),
		IdempotencyKey: idempotencyKey,
		BodyHash:       bodyHash,
		CreatedAt:      h.options.now().UTC(),
	}
	if err := h.confirmStore().Put(r.Context(), record, confirmTTL); err != nil {
		return nil, err
	}
	return &record, nil
}

func (h *Handler) consumeConfirm(
	w http.ResponseWriter,
	r *http.Request,
	action, bodyHash string,
) (*agentauth.ConfirmRecord, bool) {
	idempotencyKey, apiErr := requestIdempotencyKey(r)
	if apiErr != nil {
		writeAPIError(w, apiErr)
		return nil, false
	}
	credential, ok := agentauth.CredentialFromRequest(r)
	if !ok {
		writeAPIError(w, APIErrorWithMessage(CodeAgentAuthFailed, "token_invalid"))
		return nil, false
	}
	token := strings.TrimSpace(r.Header.Get(agentauth.ConfirmTokenHeader))
	if token == "" {
		writeAPIError(w, newAPIError(CodeConfirmTokenInvalid))
		return nil, false
	}
	record, err := h.confirmStore().Consume(r.Context(), token)
	if err != nil {
		if errors.Is(err, agentauth.ErrConfirmTokenNotFound) {
			writeAPIError(w, newAPIError(CodeConfirmTokenInvalid))
		} else {
			writeAPIError(w, newAPIError(CodeServiceUnavailable))
		}
		return nil, false
	}
	if record == nil {
		writeAPIError(w, newAPIError(CodeConfirmTokenInvalid))
		return nil, false
	}
	if record.CreatedAt.IsZero() {
		writeAPIError(w, newAPIError(CodeConfirmTokenInvalid))
		return nil, false
	}
	if h.options.now().Sub(record.CreatedAt) > confirmTTL {
		writeAPIError(w, newAPIError(CodeConfirmTokenExpired))
		return nil, false
	}
	if record.AgentID != credential.AgentID ||
		record.Action != action ||
		record.IdempotencyKey != idempotencyKey ||
		!hashEqual(record.BodyHash, bodyHash) ||
		record.Resource != agentauth.CanonicalRequestFingerprint(r) {
		writeAPIError(w, newAPIError(CodeConfirmTokenInvalid))
		return nil, false
	}
	return record, true
}

func (h *Handler) confirmStore() agentauth.ConfirmStore {
	if h.options.ConfirmStore == nil {
		h.options.ConfirmStore = agentauth.NewMemoryConfirmStore()
	}
	return h.options.ConfirmStore
}

func requestIdempotencyKey(r *http.Request) (string, *APIError) {
	values := r.Header.Values("Idempotency-Key")
	if len(values) == 0 {
		return "", nil
	}
	value := strings.TrimSpace(values[0])
	if value == "" || len([]rune(value)) > 64 {
		return "", APIErrorWithMessage(
			CodeValidationFailed,
			"Idempotency-Key 必须为非空字符串且不超过 64 字符",
		)
	}
	return value, nil
}

func hashBytes(body []byte) string {
	digest := sha256.Sum256(body)
	return hex.EncodeToString(digest[:])
}

func hashEqual(left, right string) bool {
	return len(left) == len(right) && subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}
