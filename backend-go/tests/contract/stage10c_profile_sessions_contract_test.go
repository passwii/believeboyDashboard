package contract

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"regexp"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/profile"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/users"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	requestauth "github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

func TestStage10CProfileAvatarUploadCommitsAuditAndCleansOldObject(t *testing.T) {
	oldURL := "https://cdn.example.com/avatars/user-123/old.png"
	store := &stage10CProfileStore{
		row: &profile.Profile{
			ID:        "user-123",
			Email:     "owner@example.com",
			Name:      "owner",
			IsActive:  true,
			AvatarURL: &oldURL,
		},
	}
	blobs := &stage10CBlobStore{}
	auditor := &stage10CProfileAuditor{}
	handler := profile.NewHandler(
		store,
		profile.WithBlobStore(blobs),
		profile.WithAuditor(auditor),
	)
	router := chi.NewRouter()
	router.Post("/api/v1/system-management/profile/avatar", handler.UploadAvatar)

	request := stage10CMultipartRequest(
		t,
		"/api/v1/system-management/profile/avatar",
		"avatar.png",
		"image/png",
		stage10CPNG(),
	)
	request = stage10CIdentity(request, "user-123", "运营 A", false)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", recorder.Code, recorder.Body.String())
	}
	var response struct {
		AvatarURL   string `json:"avatar_url"`
		Size        int    `json:"size"`
		ContentType string `json:"content_type"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !strings.HasPrefix(response.AvatarURL, "https://cdn.example.com/avatars/user-123/") {
		t.Errorf("avatar_url = %q, want scoped R2 URL", response.AvatarURL)
	}
	if response.Size != len(stage10CPNG()) || response.ContentType != "image/png" {
		t.Errorf("response = %#v, want size/content type from upload", response)
	}
	keyPattern := regexp.MustCompile(`^avatars/user-123/[0-9a-f]{32}_avatar\.png$`)
	if !keyPattern.MatchString(blobs.putKey) {
		t.Errorf("object key = %q, want avatars/user-123/<uuid>_avatar.png", blobs.putKey)
	}
	if blobs.putContentType != "image/png" || !bytes.Equal(blobs.putData, stage10CPNG()) {
		t.Errorf("Put() = content_type:%q data:%x, want uploaded PNG", blobs.putContentType, blobs.putData)
	}
	if len(store.avatarUpdates) != 1 {
		t.Fatalf("avatar updates = %d, want 1", len(store.avatarUpdates))
	}
	update := store.avatarUpdates[0]
	if update.AvatarURL == nil || *update.AvatarURL != response.AvatarURL {
		t.Errorf("stored avatar URL = %#v, want %q", update.AvatarURL, response.AvatarURL)
	}
	if update.Auditor != auditor {
		t.Errorf("store auditor = %#v, want injected auditor", update.Auditor)
	}
	if update.Audit.Action != "profile.avatar.upload" ||
		update.Audit.TargetType != "user_account" ||
		update.Audit.TargetID == nil || *update.Audit.TargetID != "user-123" ||
		update.Audit.Operator == nil || *update.Audit.Operator != "运营 A" {
		t.Errorf("upload audit = %#v, want profile.avatar.upload with actor", update.Audit)
	}
	if hadAvatar, _ := update.Audit.BeforeJSON.(map[string]any)["had_avatar"].(bool); !hadAvatar {
		t.Errorf("audit before = %#v, want had_avatar=true", update.Audit.BeforeJSON)
	}
	if size, _ := update.Audit.AfterJSON.(map[string]any)["size"].(int); size != len(stage10CPNG()) {
		t.Errorf("audit after = %#v, want upload size", update.Audit.AfterJSON)
	}
	if len(blobs.deletedKeys) != 1 || blobs.deletedKeys[0] != "avatars/user-123/old.png" {
		t.Errorf("deleted keys = %#v, want old avatar after successful commit", blobs.deletedKeys)
	}
}

func TestStage10CProfileAvatarDeleteClearsDatabaseAndBestEffortDeletesOldObject(t *testing.T) {
	oldURL := "https://cdn.example.com/avatars/user-123/old.png"
	store := &stage10CProfileStore{
		row: &profile.Profile{
			ID:        "user-123",
			Email:     "owner@example.com",
			Name:      "owner",
			IsActive:  true,
			AvatarURL: &oldURL,
		},
	}
	blobs := &stage10CBlobStore{deleteErr: errors.New("R2 unavailable")}
	handler := profile.NewHandler(
		store,
		profile.WithBlobStore(blobs),
		profile.WithAuditor(&stage10CProfileAuditor{}),
	)
	request := httptest.NewRequest(
		http.MethodDelete,
		"/api/v1/system-management/profile/avatar",
		nil,
	)
	request = stage10CIdentity(request, "user-123", "运营 A", false)
	recorder := httptest.NewRecorder()

	handler.DeleteAvatar(recorder, request)

	if recorder.Code != http.StatusOK || recorder.Body.String() != `{"ok":true}` {
		t.Fatalf("response = (%d, %s), want 200 {\"ok\":true}", recorder.Code, recorder.Body.String())
	}
	if len(store.avatarUpdates) != 1 {
		t.Fatalf("avatar updates = %d, want 1", len(store.avatarUpdates))
	}
	update := store.avatarUpdates[0]
	if update.AvatarURL != nil {
		t.Errorf("stored avatar URL = %#v, want nil", update.AvatarURL)
	}
	if update.Audit.Action != "profile.avatar.delete" {
		t.Errorf("audit action = %q, want profile.avatar.delete", update.Audit.Action)
	}
	if len(blobs.deletedKeys) != 1 || blobs.deletedKeys[0] != "avatars/user-123/old.png" {
		t.Errorf("deleted keys = %#v, want old avatar", blobs.deletedKeys)
	}
}

func TestStage10CProfileAvatarFailsClosedWithoutBlobStore(t *testing.T) {
	store := &stage10CProfileStore{
		row: &profile.Profile{ID: "user-123", Email: "owner@example.com", Name: "owner", IsActive: true},
	}
	handler := profile.NewHandler(store, profile.WithAuditor(&stage10CProfileAuditor{}))
	request := stage10CMultipartRequest(
		t,
		"/api/v1/system-management/profile/avatar",
		"avatar.png",
		"image/png",
		stage10CPNG(),
	)
	request = stage10CIdentity(request, "user-123", "运营 A", false)
	recorder := httptest.NewRecorder()

	handler.UploadAvatar(recorder, request)

	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body = %s", recorder.Code, recorder.Body.String())
	}
	if len(store.avatarUpdates) != 0 {
		t.Errorf("avatar updates = %d, want 0", len(store.avatarUpdates))
	}
}

func TestStage10CProfileAvatarValidatesSizeMIMEAndMagic(t *testing.T) {
	tests := []struct {
		name        string
		filename    string
		contentType string
		data        []byte
		status      int
	}{
		{
			name:        "unsupported extension",
			filename:    "avatar.exe",
			contentType: "application/octet-stream",
			data:        []byte("MZ"),
			status:      http.StatusBadRequest,
		},
		{
			name:        "unsupported MIME",
			filename:    "avatar.png",
			contentType: "text/plain",
			data:        stage10CPNG(),
			status:      http.StatusBadRequest,
		},
		{
			name:        "extension MIME mismatch",
			filename:    "avatar.jpg",
			contentType: "image/png",
			data:        stage10CPNG(),
			status:      http.StatusBadRequest,
		},
		{
			name:        "magic mismatch",
			filename:    "avatar.png",
			contentType: "image/png",
			data:        []byte("not a png"),
			status:      http.StatusBadRequest,
		},
		{
			name:        "oversized",
			filename:    "avatar.png",
			contentType: "image/png",
			data:        append(stage10CPNG(), make([]byte, 5*1024*1024)...),
			status:      http.StatusRequestEntityTooLarge,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &stage10CProfileStore{
				row: &profile.Profile{
					ID: "user-123", Email: "owner@example.com", Name: "owner", IsActive: true,
				},
			}
			blobs := &stage10CBlobStore{}
			handler := profile.NewHandler(
				store,
				profile.WithBlobStore(blobs),
				profile.WithAuditor(&stage10CProfileAuditor{}),
			)
			request := stage10CMultipartRequest(
				t,
				"/api/v1/system-management/profile/avatar",
				tt.filename,
				tt.contentType,
				tt.data,
			)
			request = stage10CIdentity(request, "user-123", "运营 A", false)
			recorder := httptest.NewRecorder()

			handler.UploadAvatar(recorder, request)

			if recorder.Code != tt.status {
				t.Fatalf("status = %d, want %d; body = %s", recorder.Code, tt.status, recorder.Body.String())
			}
			if blobs.putKey != "" || len(store.avatarUpdates) != 0 {
				t.Errorf("invalid upload reached Put/store: key=%q updates=%d", blobs.putKey, len(store.avatarUpdates))
			}
		})
	}
}

func TestStage10CProfileAvatarSanitizesPathLikeFilename(t *testing.T) {
	store := &stage10CProfileStore{
		row: &profile.Profile{
			ID: "user-123", Email: "owner@example.com", Name: "owner", IsActive: true,
		},
	}
	blobs := &stage10CBlobStore{}
	handler := profile.NewHandler(
		store,
		profile.WithBlobStore(blobs),
		profile.WithAuditor(&stage10CProfileAuditor{}),
	)
	request := stage10CMultipartRequest(
		t,
		"/api/v1/system-management/profile/avatar",
		"../../avatar.png",
		"image/png",
		stage10CPNG(),
	)
	request = stage10CIdentity(request, "user-123", "运营 A", false)
	recorder := httptest.NewRecorder()

	handler.UploadAvatar(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", recorder.Code, recorder.Body.String())
	}
	if strings.Contains(blobs.putKey, "..") ||
		!regexp.MustCompile(`^avatars/user-123/[0-9a-f]{32}_avatar\.png$`).MatchString(blobs.putKey) {
		t.Errorf("object key = %q, want sanitized avatar filename", blobs.putKey)
	}
}

func TestStage10CProfileAvatarAuthMissingUserAndTransactionCompensation(t *testing.T) {
	t.Run("upload unauthenticated", func(t *testing.T) {
		handler := profile.NewHandler(
			&stage10CProfileStore{},
			profile.WithBlobStore(&stage10CBlobStore{}),
			profile.WithAuditor(&stage10CProfileAuditor{}),
		)
		request := stage10CMultipartRequest(
			t,
			"/api/v1/system-management/profile/avatar",
			"avatar.png",
			"image/png",
			stage10CPNG(),
		)
		recorder := httptest.NewRecorder()
		handler.UploadAvatar(recorder, request)
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401; body = %s", recorder.Code, recorder.Body.String())
		}
	})

	t.Run("delete missing user", func(t *testing.T) {
		handler := profile.NewHandler(
			&stage10CProfileStore{},
			profile.WithBlobStore(&stage10CBlobStore{}),
			profile.WithAuditor(&stage10CProfileAuditor{}),
		)
		request := httptest.NewRequest(
			http.MethodDelete,
			"/api/v1/system-management/profile/avatar",
			nil,
		)
		request = stage10CIdentity(request, "missing", "运营 A", false)
		recorder := httptest.NewRecorder()
		handler.DeleteAvatar(recorder, request)
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404; body = %s", recorder.Code, recorder.Body.String())
		}
	})

	t.Run("delete does not remove object before commit", func(t *testing.T) {
		oldURL := "https://cdn.example.com/avatars/user-123/old.png"
		store := &stage10CProfileStore{
			row: &profile.Profile{
				ID: "user-123", Email: "owner@example.com", Name: "owner", IsActive: true,
				AvatarURL: &oldURL,
			},
			updateErr: errors.New("audit insert failed"),
		}
		blobs := &stage10CBlobStore{}
		handler := profile.NewHandler(
			store,
			profile.WithBlobStore(blobs),
			profile.WithAuditor(&stage10CProfileAuditor{}),
		)
		request := httptest.NewRequest(
			http.MethodDelete,
			"/api/v1/system-management/profile/avatar",
			nil,
		)
		request = stage10CIdentity(request, "user-123", "运营 A", false)
		recorder := httptest.NewRecorder()
		handler.DeleteAvatar(recorder, request)

		if recorder.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d, want 500; body = %s", recorder.Code, recorder.Body.String())
		}
		if len(blobs.deletedKeys) != 0 {
			t.Errorf("deleted keys = %#v, want none before commit", blobs.deletedKeys)
		}
	})

	t.Run("transaction failure compensates new object", func(t *testing.T) {
		store := &stage10CProfileStore{
			row: &profile.Profile{
				ID: "user-123", Email: "owner@example.com", Name: "owner", IsActive: true,
			},
			updateErr: errors.New("audit insert failed"),
		}
		blobs := &stage10CBlobStore{}
		handler := profile.NewHandler(
			store,
			profile.WithBlobStore(blobs),
			profile.WithAuditor(&stage10CProfileAuditor{}),
		)
		request := stage10CMultipartRequest(
			t,
			"/api/v1/system-management/profile/avatar",
			"avatar.png",
			"image/png",
			stage10CPNG(),
		)
		request = stage10CIdentity(request, "user-123", "运营 A", false)
		recorder := httptest.NewRecorder()
		handler.UploadAvatar(recorder, request)

		if recorder.Code != http.StatusInternalServerError {
			t.Fatalf("status = %d, want 500; body = %s", recorder.Code, recorder.Body.String())
		}
		if blobs.putKey == "" {
			t.Fatal("Put() was not called")
		}
		if len(blobs.deletedKeys) != 1 || blobs.deletedKeys[0] != blobs.putKey {
			t.Errorf("deleted keys = %#v, want compensating delete %q", blobs.deletedKeys, blobs.putKey)
		}
	})
}

func TestStage10CRevokeSessionsRequiresAdminAndReturnsRealRevocationCount(t *testing.T) {
	store := &stage10CSessionStore{
		userExists: true,
		revoked:    3,
	}
	auditor := audit.NewMockService()
	revoker := &stage10CSessionRevoker{revoked: 3}
	registrar := users.NewRegistrarWithOptions(
		store,
		users.WithAuditor(auditor),
		users.WithSessionRevoker(revoker),
	)
	router := chi.NewRouter()
	registrar.RegisterRoutes(router, nil)

	request := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/system-management/users/user-123/revoke-sessions",
		nil,
	)
	request = stage10CIdentity(request, "admin-1", "管理员 A", true)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", recorder.Code, recorder.Body.String())
	}
	if recorder.Body.String() != `{"ok":true,"revoked":3}` {
		t.Errorf("body = %s, want revoked count", recorder.Body.String())
	}
	if store.revokeCalls != 1 || store.revokeInput.Revoker != revoker || store.revokeInput.Auditor != auditor {
		t.Errorf("revoke input = %#v, calls = %d, want injected dependencies", store.revokeInput, store.revokeCalls)
	}
	if store.revokeInput.UserID != "user-123" ||
		store.revokeInput.Operator == nil || *store.revokeInput.Operator != "管理员 A" {
		t.Errorf("revoke input = %#v, want target and operator", store.revokeInput)
	}
}

func TestStage10CRevokeSessionsPermissionNotFoundAndValidationContracts(t *testing.T) {
	t.Run("non admin forbidden before store", func(t *testing.T) {
		store := &stage10CSessionStore{userExists: true, revoked: 1}
		handler := users.NewHandlerWithOptions(
			store,
			users.WithAuditor(audit.NewMockService()),
			users.WithSessionRevoker(&stage10CSessionRevoker{}),
		)
		request := httptest.NewRequest(
			http.MethodPost,
			"/api/v1/system-management/users/user-123/revoke-sessions",
			nil,
		)
		request = stage10CIdentity(request, "operator-1", "运营 A", false)
		request = stage10CURLParam(request, "user_id", "user-123")
		recorder := httptest.NewRecorder()
		handler.RevokeSessions(recorder, request)

		if recorder.Code != http.StatusForbidden {
			t.Fatalf("status = %d, want 403; body = %s", recorder.Code, recorder.Body.String())
		}
		if store.revokeCalls != 0 {
			t.Errorf("RevokeSessions() calls = %d, want 0", store.revokeCalls)
		}
	})

	t.Run("missing user", func(t *testing.T) {
		store := &stage10CSessionStore{}
		handler := users.NewHandlerWithOptions(
			store,
			users.WithAuditor(audit.NewMockService()),
			users.WithSessionRevoker(&stage10CSessionRevoker{}),
		)
		request := httptest.NewRequest(
			http.MethodPost,
			"/api/v1/system-management/users/missing/revoke-sessions",
			nil,
		)
		request = stage10CIdentity(request, "admin-1", "管理员 A", true)
		request = stage10CURLParam(request, "user_id", "missing")
		recorder := httptest.NewRecorder()
		handler.RevokeSessions(recorder, request)

		if recorder.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404; body = %s", recorder.Code, recorder.Body.String())
		}
	})

	t.Run("revocation dependency failure is not fake success", func(t *testing.T) {
		store := &stage10CSessionStore{
			userExists: true,
			revokeErr:  users.ErrSessionRevocationUnavailable,
		}
		handler := users.NewHandlerWithOptions(
			store,
			users.WithAuditor(audit.NewMockService()),
			users.WithSessionRevoker(&stage10CSessionRevoker{}),
		)
		request := httptest.NewRequest(
			http.MethodPost,
			"/api/v1/system-management/users/user-123/revoke-sessions",
			nil,
		)
		request = stage10CIdentity(request, "admin-1", "管理员 A", true)
		request = stage10CURLParam(request, "user_id", "user-123")
		recorder := httptest.NewRecorder()
		handler.RevokeSessions(recorder, request)

		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, want 503; body = %s", recorder.Code, recorder.Body.String())
		}
	})

	t.Run("blank path parameter", func(t *testing.T) {
		handler := users.NewHandlerWithOptions(
			&stage10CSessionStore{},
			users.WithAuditor(audit.NewMockService()),
			users.WithSessionRevoker(&stage10CSessionRevoker{}),
		)
		request := httptest.NewRequest(
			http.MethodPost,
			"/api/v1/system-management/users/%20/revoke-sessions",
			nil,
		)
		request = stage10CIdentity(request, "admin-1", "管理员 A", true)
		request = stage10CURLParam(request, "user_id", " ")
		recorder := httptest.NewRecorder()
		handler.RevokeSessions(recorder, request)

		if recorder.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status = %d, want 422; body = %s", recorder.Code, recorder.Body.String())
		}
	})
}

type stage10CProfileStore struct {
	profile.Store
	row           *profile.Profile
	getErr        error
	updateErr     error
	avatarUpdates []profile.AvatarUpdateInput
}

func (store *stage10CProfileStore) GetByUserID(
	_ context.Context,
	_ string,
) (*profile.Profile, error) {
	if store.getErr != nil {
		return nil, store.getErr
	}
	return store.row, nil
}

func (store *stage10CProfileStore) UpdateAvatar(
	_ context.Context,
	_ string,
	input profile.AvatarUpdateInput,
) (*profile.Profile, error) {
	store.avatarUpdates = append(store.avatarUpdates, input)
	if store.updateErr != nil {
		return nil, store.updateErr
	}
	if store.row == nil {
		return nil, nil
	}
	result := *store.row
	result.AvatarURL = input.AvatarURL
	return &result, nil
}

type stage10CProfileAuditor struct {
	entries []profile.AvatarAudit
}

func (auditor *stage10CProfileAuditor) LogActionTx(
	_ context.Context,
	_ pgx.Tx,
	entry profile.AvatarAudit,
) error {
	auditor.entries = append(auditor.entries, entry)
	return nil
}

type stage10CBlobStore struct {
	putKey         string
	putData        []byte
	putContentType string
	putErr         error
	deleteErr      error
	deletedKeys    []string
}

func (store *stage10CBlobStore) Put(
	_ context.Context,
	key string,
	data []byte,
	contentType string,
) (string, error) {
	store.putKey = key
	store.putData = append([]byte(nil), data...)
	store.putContentType = contentType
	if store.putErr != nil {
		return "", store.putErr
	}
	return "https://cdn.example.com/" + key, nil
}

func (store *stage10CBlobStore) Delete(_ context.Context, key string) error {
	store.deletedKeys = append(store.deletedKeys, key)
	return store.deleteErr
}

type stage10CSessionStore struct {
	users.Store
	userExists  bool
	revoked     int
	revokeErr   error
	revokeCalls int
	revokeInput users.SessionRevocationInput
}

func (store *stage10CSessionStore) RevokeSessions(
	_ context.Context,
	input users.SessionRevocationInput,
) (int, error) {
	store.revokeCalls++
	store.revokeInput = input
	if !store.userExists {
		return 0, users.ErrUserNotFound
	}
	if store.revokeErr != nil {
		return 0, store.revokeErr
	}
	return store.revoked, nil
}

type stage10CSessionRevoker struct {
	revoked int
	err     error
}

func (revoker *stage10CSessionRevoker) DeleteUserSessions(
	context.Context,
	string,
) (int, error) {
	return revoker.revoked, revoker.err
}

func stage10CMultipartRequest(
	t *testing.T,
	path string,
	filename string,
	contentType string,
	data []byte,
) *http.Request {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", `form-data; name="file"; filename="`+filename+`"`)
	if contentType != "" {
		header.Set("Content-Type", contentType)
	}
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatalf("create multipart part: %v", err)
	}
	if _, err := part.Write(data); err != nil {
		t.Fatalf("write multipart part: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}
	request := httptest.NewRequest(http.MethodPost, path, &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	return request
}

func stage10CIdentity(
	request *http.Request,
	userID string,
	operator string,
	isAdmin bool,
) *http.Request {
	return request.WithContext(requestauth.WithUserContext(request.Context(), requestauth.UserContext{
		UserID:   userID,
		Name:     operator,
		Operator: operator,
		IsAdmin:  isAdmin,
	}))
}

func stage10CURLParam(request *http.Request, key, value string) *http.Request {
	routeContext := chi.NewRouteContext()
	routeContext.URLParams.Add(key, value)
	return request.WithContext(context.WithValue(request.Context(), chi.RouteCtxKey, routeContext))
}

func stage10CPNG() []byte {
	return []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a}
}
