package agentauth

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	ConfirmTokenHeader   = "X-Confirm-Token"
	DefaultConfirmTTL    = 300 * time.Second
	defaultConfirmPrefix = "agent:confirm:"
)

var ErrConfirmTokenNotFound = errors.New("confirm token not found")

// ConfirmRecord binds a dangerous mutation to the authenticated agent and exact request body.
type ConfirmRecord struct {
	Token          string         `json:"token"`
	AgentID        string         `json:"agent_id"`
	Action         string         `json:"action"`
	Resource       string         `json:"resource,omitempty"`
	IdempotencyKey string         `json:"idempotency_key,omitempty"`
	BodyHash       string         `json:"body_hash"`
	CreatedAt      time.Time      `json:"created_at"`
	Context        map[string]any `json:"context,omitempty"`
}

type ConfirmStore interface {
	Put(ctx context.Context, record ConfirmRecord, ttl time.Duration) error
	Consume(ctx context.Context, token string) (*ConfirmRecord, error)
}

type ConfirmValidator func(r *http.Request, body []byte) error
type ConfirmContextBuilder func(r *http.Request, body []byte) map[string]any

type ConfirmOption func(*confirmConfig)

type confirmConfig struct {
	ttl       time.Duration
	validator ConfirmValidator
	context   ConfirmContextBuilder
}

func WithConfirmValidator(validator ConfirmValidator) ConfirmOption {
	return func(config *confirmConfig) {
		config.validator = validator
	}
}

func WithConfirmContext(builder ConfirmContextBuilder) ConfirmOption {
	return func(config *confirmConfig) {
		config.context = builder
	}
}

func WithConfirmTTL(ttl time.Duration) ConfirmOption {
	return func(config *confirmConfig) {
		if ttl > 0 {
			config.ttl = ttl
		}
	}
}

// RequireConfirmation implements the preview/replay confirm gate for dangerous writes.
func RequireConfirmation(
	store ConfirmStore,
	action string,
	options ...ConfirmOption,
) func(http.Handler) http.Handler {
	config := confirmConfig{
		ttl: DefaultConfirmTTL,
	}
	for _, option := range options {
		if option != nil {
			option(&config)
		}
	}
	action = strings.TrimSpace(action)

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			credential, ok := CredentialFromRequest(r)
			if !ok {
				writeAuthFailure(w, DetailTokenInvalid)
				return
			}
			if store == nil {
				WriteError(w, http.StatusInternalServerError, ErrorCodeInternalError, DetailConfirmStoreError)
				return
			}

			body, err := io.ReadAll(r.Body)
			if err != nil {
				WriteError(w, http.StatusBadRequest, ErrorCodeValidationFailed, DetailValidationFailed)
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(body))

			idempotencyKey := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
			token := strings.TrimSpace(r.Header.Get(ConfirmTokenHeader))
			if token == "" {
				if config.validator != nil {
					if err := config.validator(r, body); err != nil {
						writeConfirmationValidationError(w, err)
						return
					}
				}

				confirmToken, err := newConfirmToken()
				if err != nil {
					WriteError(w, http.StatusInternalServerError, ErrorCodeInternalError, DetailInternalError)
					return
				}
				var confirmContext map[string]any
				if config.context != nil {
					confirmContext = config.context(r, body)
				}
				record := ConfirmRecord{
					Token:          confirmToken,
					AgentID:        credential.AgentID,
					Action:         action,
					Resource:       CanonicalRequestFingerprint(r),
					IdempotencyKey: idempotencyKey,
					BodyHash:       ComputeBodyHash(body),
					CreatedAt:      time.Now().UTC(),
					Context:        confirmContext,
				}
				if err := store.Put(r.Context(), record, config.ttl); err != nil {
					WriteError(w, http.StatusInternalServerError, ErrorCodeInternalError, DetailConfirmStoreError)
					return
				}
				_ = writeJSON(w, http.StatusOK, struct {
					OK                   bool   `json:"ok"`
					RequiresConfirmation bool   `json:"requires_confirmation"`
					ConfirmToken         string `json:"confirm_token"`
					Message              string `json:"message"`
				}{
					OK:                   false,
					RequiresConfirmation: true,
					ConfirmToken:         record.Token,
					Message:              "该操作需要用户确认",
				})
				return
			}

			record, err := store.Consume(r.Context(), token)
			if err != nil {
				if errors.Is(err, ErrConfirmTokenNotFound) {
					WriteError(w, http.StatusBadRequest, ErrorCodeConfirmTokenInvalid, DetailConfirmInvalid)
					return
				}
				WriteError(w, http.StatusInternalServerError, ErrorCodeInternalError, DetailConfirmStoreError)
				return
			}
			if record == nil {
				WriteError(w, http.StatusBadRequest, ErrorCodeConfirmTokenInvalid, DetailConfirmInvalid)
				return
			}
			if record.CreatedAt.IsZero() {
				WriteError(w, http.StatusBadRequest, ErrorCodeConfirmTokenInvalid, DetailConfirmInvalid)
				return
			}
			if time.Since(record.CreatedAt) > config.ttl {
				WriteError(w, http.StatusConflict, ErrorCodeConfirmTokenExpired, DetailConfirmExpired)
				return
			}
			if record.AgentID != credential.AgentID ||
				record.Action != action ||
				record.IdempotencyKey != idempotencyKey ||
				!bodyHashEqual(record.BodyHash, ComputeBodyHash(body)) ||
				(record.Resource != "" && record.Resource != CanonicalRequestFingerprint(r)) {
				WriteError(w, http.StatusBadRequest, ErrorCodeConfirmTokenInvalid, DetailConfirmInvalid)
				return
			}

			ctx := WithConfirmRecord(r.Context(), record)
			if record.Context != nil {
				ctx = WithConfirmContextValue(ctx, record.Context)
			}
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// CanonicalRequestFingerprint binds confirmations to the exact method, path,
// and normalized query parameters so a token cannot be replayed on another
// resource under the same action.
func CanonicalRequestFingerprint(r *http.Request) string {
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

func ComputeBodyHash(body []byte) string {
	digest := sha256.Sum256(body)
	return hex.EncodeToString(digest[:])
}

type confirmRecordContextKey struct{}
type confirmContextValueKey struct{}

func WithConfirmRecord(ctx context.Context, record *ConfirmRecord) context.Context {
	return context.WithValue(ctx, confirmRecordContextKey{}, record)
}

func ConfirmRecordFromContext(ctx context.Context) (*ConfirmRecord, bool) {
	record, ok := ctx.Value(confirmRecordContextKey{}).(*ConfirmRecord)
	return record, ok && record != nil
}

func WithConfirmContextValue(ctx context.Context, value map[string]any) context.Context {
	return context.WithValue(ctx, confirmContextValueKey{}, value)
}

func ConfirmContextFromContext(ctx context.Context) (map[string]any, bool) {
	value, ok := ctx.Value(confirmContextValueKey{}).(map[string]any)
	return value, ok && value != nil
}

type MemoryConfirmStore struct {
	mu      sync.Mutex
	records map[string]memoryConfirmEntry
	now     func() time.Time
}

type memoryConfirmEntry struct {
	record            ConfirmRecord
	physicalExpiresAt time.Time
}

type MemoryConfirmStoreOption func(*MemoryConfirmStore)

func WithMemoryConfirmClock(now func() time.Time) MemoryConfirmStoreOption {
	return func(store *MemoryConfirmStore) {
		if now != nil {
			store.now = now
		}
	}
}

func NewMemoryConfirmStore(options ...MemoryConfirmStoreOption) *MemoryConfirmStore {
	store := &MemoryConfirmStore{
		records: make(map[string]memoryConfirmEntry),
		now:     time.Now,
	}
	for _, option := range options {
		if option != nil {
			option(store)
		}
	}
	return store
}

func (s *MemoryConfirmStore) Put(_ context.Context, record ConfirmRecord, ttl time.Duration) error {
	if ttl <= 0 {
		ttl = DefaultConfirmTTL
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.records[record.Token] = memoryConfirmEntry{
		record:            cloneConfirmRecord(record),
		physicalExpiresAt: s.now().Add(2 * ttl),
	}
	return nil
}

func (s *MemoryConfirmStore) Consume(_ context.Context, token string) (*ConfirmRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.records[token]
	if !ok {
		return nil, ErrConfirmTokenNotFound
	}
	delete(s.records, token)
	if s.now().After(entry.physicalExpiresAt) {
		return nil, ErrConfirmTokenNotFound
	}
	record := cloneConfirmRecord(entry.record)
	return &record, nil
}

type RedisConfirmStore struct {
	client *redis.Client
	prefix string
}

func NewRedisConfirmStore(client *redis.Client, prefix string) *RedisConfirmStore {
	prefix = strings.TrimSpace(prefix)
	if prefix == "" {
		prefix = defaultConfirmPrefix
	}
	return &RedisConfirmStore{client: client, prefix: prefix}
}

func (s *RedisConfirmStore) Put(ctx context.Context, record ConfirmRecord, ttl time.Duration) error {
	if s == nil || s.client == nil {
		return errors.New("redis confirm store client is nil")
	}
	if ttl <= 0 {
		ttl = DefaultConfirmTTL
	}
	payload, err := json.Marshal(record)
	if err != nil {
		return err
	}
	return s.client.Set(ctx, s.prefix+record.Token, payload, 2*ttl).Err()
}

func (s *RedisConfirmStore) Consume(ctx context.Context, token string) (*ConfirmRecord, error) {
	if s == nil || s.client == nil {
		return nil, errors.New("redis confirm store client is nil")
	}
	payload, err := s.client.GetDel(ctx, s.prefix+token).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, ErrConfirmTokenNotFound
	}
	if err != nil {
		return nil, err
	}
	var record ConfirmRecord
	if err := json.Unmarshal(payload, &record); err != nil {
		return nil, ErrConfirmTokenNotFound
	}
	return &record, nil
}

func newConfirmToken() (string, error) {
	random := make([]byte, 24)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	return "cf_" + base64.RawURLEncoding.EncodeToString(random), nil
}

func writeConfirmationValidationError(w http.ResponseWriter, err error) {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		WriteAPIError(w, apiErr)
		return
	}
	WriteError(w, http.StatusBadRequest, ErrorCodeValidationFailed, DetailValidationFailed)
}

func bodyHashEqual(left, right string) bool {
	return len(left) == len(right) && subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}

func cloneConfirmRecord(record ConfirmRecord) ConfirmRecord {
	if record.Context == nil {
		return record
	}
	contextCopy := make(map[string]any, len(record.Context))
	for key, value := range record.Context {
		contextCopy[key] = value
	}
	record.Context = contextCopy
	return record
}
