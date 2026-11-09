package profile

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
	"github.com/passwii/believeboyDashboard/backend-go/internal/blob"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

const (
	maxAvatarBytes          int64 = 5 * 1024 * 1024
	avatarMultipartOverhead int64 = 2 * 1024 * 1024
	avatarDeleteTimeout           = 5 * time.Second
)

var avatarExtensionContentTypes = map[string]string{
	".gif":  "image/gif",
	".jpeg": "image/jpeg",
	".jpg":  "image/jpeg",
	".png":  "image/png",
	".webp": "image/webp",
}

// BlobStore is the narrow object-store surface used by avatar routes. The
// production blob.ObjectStore satisfies it.
type BlobStore interface {
	Put(ctx context.Context, key string, data []byte, contentType string) (string, error)
	Delete(ctx context.Context, key string) error
}

var _ BlobStore = (*blob.Store)(nil)

type AvatarUpdateInput struct {
	AvatarURL *string
	Audit     AvatarAudit
	Auditor   Auditor
}

type AvatarStore interface {
	UpdateAvatar(
		ctx context.Context,
		userID string,
		input AvatarUpdateInput,
	) (*Profile, error)
}

type AvatarUploadResponse struct {
	AvatarURL   string `json:"avatar_url"`
	Size        int    `json:"size"`
	ContentType string `json:"content_type"`
}

type AvatarDeleteResponse struct {
	OK bool `json:"ok"`
}

func (h *Handler) UploadAvatar(w http.ResponseWriter, r *http.Request) {
	identity, userID, ok := h.avatarIdentity(w, r)
	if !ok {
		return
	}
	if h.blobs == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Cloud storage is not configured")
		return
	}
	if h.auditor == nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	writer, ok := h.store.(AvatarStore)
	if !ok {
		httpapi.WriteInternalServerError(w)
		return
	}

	before, err := h.store.GetByUserID(r.Context(), userID)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if before == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "User not found")
		return
	}

	filename, contentType, data, status := readAvatarMultipart(w, r)
	if status != 0 {
		return
	}
	objectKey, err := buildAvatarObjectKey(userID, filename)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}

	publicURL, err := h.blobs.Put(r.Context(), objectKey, data, contentType)
	publicURL = strings.TrimSpace(publicURL)
	if err != nil || publicURL == "" {
		bestEffortAvatarDelete(r.Context(), h.blobs, objectKey)
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "Cloud storage upload failed")
		return
	}

	entry := AvatarAudit{
		Action:     "profile.avatar.upload",
		TargetType: "user_account",
		TargetID:   stringPointer(userID),
		Operator:   operatorPointer(identity),
		BeforeJSON: map[string]any{"had_avatar": hasAvatar(before.AvatarURL)},
		AfterJSON:  map[string]any{"has_avatar": true, "size": len(data)},
		Request:    r,
	}
	updated, err := writer.UpdateAvatar(r.Context(), userID, AvatarUpdateInput{
		AvatarURL: &publicURL,
		Audit:     entry,
		Auditor:   h.auditor,
	})
	if err != nil {
		bestEffortAvatarDelete(r.Context(), h.blobs, objectKey)
		httpapi.WriteInternalServerError(w)
		return
	}
	if updated == nil {
		bestEffortAvatarDelete(r.Context(), h.blobs, objectKey)
		httpapi.WriteDetail(w, http.StatusNotFound, "User not found")
		return
	}

	if before.AvatarURL != nil {
		if oldKey := avatarObjectKey(*before.AvatarURL); oldKey != "" && oldKey != objectKey {
			bestEffortAvatarDelete(r.Context(), h.blobs, oldKey)
		}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, AvatarUploadResponse{
		AvatarURL:   publicURL,
		Size:        len(data),
		ContentType: contentType,
	})
}

func (h *Handler) DeleteAvatar(w http.ResponseWriter, r *http.Request) {
	_, userID, ok := h.avatarIdentity(w, r)
	if !ok {
		return
	}
	if h.auditor == nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	writer, ok := h.store.(AvatarStore)
	if !ok {
		httpapi.WriteInternalServerError(w)
		return
	}

	before, err := h.store.GetByUserID(r.Context(), userID)
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if before == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "User not found")
		return
	}

	entry := AvatarAudit{
		Action:     "profile.avatar.delete",
		TargetType: "user_account",
		TargetID:   stringPointer(userID),
		Operator:   operatorPointerFromRequest(r),
		BeforeJSON: map[string]any{"had_avatar": hasAvatar(before.AvatarURL)},
		AfterJSON:  map[string]any{"has_avatar": false},
		Request:    r,
	}
	updated, err := writer.UpdateAvatar(r.Context(), userID, AvatarUpdateInput{
		AvatarURL: nil,
		Audit:     entry,
		Auditor:   h.auditor,
	})
	if err != nil {
		httpapi.WriteInternalServerError(w)
		return
	}
	if updated == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "User not found")
		return
	}

	if before.AvatarURL != nil && h.blobs != nil {
		if oldKey := avatarObjectKey(*before.AvatarURL); oldKey != "" {
			bestEffortAvatarDelete(r.Context(), h.blobs, oldKey)
		}
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, AvatarDeleteResponse{OK: true})
}

func (h *Handler) avatarIdentity(
	w http.ResponseWriter,
	r *http.Request,
) (auth.UserContext, string, bool) {
	identity, ok := auth.UserContextFromContext(r.Context())
	if !ok {
		httpapi.WriteDetail(w, http.StatusUnauthorized, "Not authenticated")
		return auth.UserContext{}, "", false
	}
	userID := truncateHeaderValue(identity.UserID, 64)
	if userID == "" {
		httpapi.WriteDetail(w, http.StatusUnauthorized, "Not authenticated")
		return auth.UserContext{}, "", false
	}
	return identity, userID, true
}

func readAvatarMultipart(
	w http.ResponseWriter,
	r *http.Request,
) (string, string, []byte, int) {
	r.Body = http.MaxBytesReader(w, r.Body, maxAvatarBytes+avatarMultipartOverhead)
	if err := r.ParseMultipartForm(maxAvatarBytes); err != nil {
		if r.MultipartForm != nil {
			_ = r.MultipartForm.RemoveAll()
		}
		if avatarMultipartTooLarge(err) {
			httpapi.WriteDetail(
				w,
				http.StatusRequestEntityTooLarge,
				fmt.Sprintf("Avatar exceeds %d bytes", maxAvatarBytes),
			)
			return "", "", nil, http.StatusRequestEntityTooLarge
		}
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid multipart form")
		return "", "", nil, http.StatusUnprocessableEntity
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Field required: file")
		return "", "", nil, http.StatusUnprocessableEntity
	}
	defer file.Close()
	if header == nil || strings.TrimSpace(header.Filename) == "" {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Missing filename")
		return "", "", nil, http.StatusBadRequest
	}
	if header.Size > maxAvatarBytes {
		httpapi.WriteDetail(
			w,
			http.StatusRequestEntityTooLarge,
			fmt.Sprintf("Avatar exceeds %d bytes", maxAvatarBytes),
		)
		return "", "", nil, http.StatusRequestEntityTooLarge
	}

	filename := sanitizeAvatarFilename(header.Filename)
	if filename == "" {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Missing filename")
		return "", "", nil, http.StatusBadRequest
	}
	extension := strings.ToLower(filepath.Ext(filename))
	expectedContentType, allowed := avatarExtensionContentTypes[extension]
	if !allowed {
		httpapi.WriteDetail(
			w,
			http.StatusBadRequest,
			fmt.Sprintf(
				"Unsupported avatar extension: %s (expected: %s)",
				extension,
				strings.Join(sortedAvatarExtensions(), ", "),
			),
		)
		return "", "", nil, http.StatusBadRequest
	}

	contentType := normalizedAvatarContentType(header.Header.Get("Content-Type"))
	if !allowedAvatarContentType(contentType) {
		httpapi.WriteDetail(
			w,
			http.StatusBadRequest,
			fmt.Sprintf("Unsupported avatar MIME type: %s", contentType),
		)
		return "", "", nil, http.StatusBadRequest
	}
	if contentType != expectedContentType {
		httpapi.WriteDetail(
			w,
			http.StatusBadRequest,
			fmt.Sprintf(
				"Avatar extension %s does not match MIME type %s",
				extension,
				contentType,
			),
		)
		return "", "", nil, http.StatusBadRequest
	}

	data, err := io.ReadAll(io.LimitReader(file, maxAvatarBytes+1))
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "Failed to read file")
		return "", "", nil, http.StatusBadRequest
	}
	if int64(len(data)) > maxAvatarBytes {
		httpapi.WriteDetail(
			w,
			http.StatusRequestEntityTooLarge,
			fmt.Sprintf("Avatar exceeds %d bytes", maxAvatarBytes),
		)
		return "", "", nil, http.StatusRequestEntityTooLarge
	}
	if len(data) == 0 {
		httpapi.WriteDetail(w, http.StatusBadRequest, "File is empty")
		return "", "", nil, http.StatusBadRequest
	}
	if detected := detectAvatarMIME(data); detected != contentType {
		if detected == "" {
			httpapi.WriteDetail(w, http.StatusBadRequest, "Avatar content is not a supported image")
		} else {
			httpapi.WriteDetail(
				w,
				http.StatusBadRequest,
				fmt.Sprintf("Avatar content does not match MIME type %s", contentType),
			)
		}
		return "", "", nil, http.StatusBadRequest
	}
	return filename, contentType, data, 0
}

func avatarMultipartTooLarge(err error) bool {
	var maxBytesError *http.MaxBytesError
	if errors.As(err, &maxBytesError) {
		return true
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "request body too large") ||
		strings.Contains(message, "message too large")
}

func normalizedAvatarContentType(raw string) string {
	raw = strings.TrimSpace(strings.ToLower(raw))
	if parsed, _, err := mime.ParseMediaType(raw); err == nil {
		return parsed
	}
	if separator := strings.IndexByte(raw, ';'); separator >= 0 {
		return strings.TrimSpace(raw[:separator])
	}
	return raw
}

func allowedAvatarContentType(contentType string) bool {
	for _, allowed := range avatarExtensionContentTypes {
		if contentType == allowed {
			return true
		}
	}
	return false
}

func detectAvatarMIME(data []byte) string {
	switch {
	case len(data) >= 3 &&
		data[0] == 0xff && data[1] == 0xd8 && data[2] == 0xff:
		return "image/jpeg"
	case len(data) >= 8 &&
		data[0] == 0x89 && data[1] == 'P' && data[2] == 'N' && data[3] == 'G' &&
		data[4] == 0x0d && data[5] == 0x0a && data[6] == 0x1a && data[7] == 0x0a:
		return "image/png"
	case len(data) >= 6 &&
		data[0] == 'G' && data[1] == 'I' && data[2] == 'F' &&
		data[3] == '8' && (data[4] == '7' || data[4] == '9') && data[5] == 'a':
		return "image/gif"
	case len(data) >= 12 &&
		string(data[0:4]) == "RIFF" && string(data[8:12]) == "WEBP":
		return "image/webp"
	default:
		return ""
	}
}

func sortedAvatarExtensions() []string {
	extensions := make([]string, 0, len(avatarExtensionContentTypes))
	for extension := range avatarExtensionContentTypes {
		extensions = append(extensions, extension)
	}
	sort.Strings(extensions)
	return extensions
}

func sanitizeAvatarFilename(raw string) string {
	raw = strings.ReplaceAll(raw, "\\", "/")
	base := path.Base(raw)
	if base == "." || base == "/" {
		return ""
	}
	var builder strings.Builder
	for _, character := range base {
		switch {
		case character == '\r' || character == '\n' || character == '\t':
			builder.WriteRune('_')
		case unicode.IsControl(character):
			continue
		default:
			builder.WriteRune(character)
		}
	}
	filename := strings.TrimSpace(builder.String())
	runes := []rune(filename)
	if len(runes) > 256 {
		filename = string(runes[:256])
	}
	return filename
}

func buildAvatarObjectKey(userID, filename string) (string, error) {
	extension := strings.ToLower(filepath.Ext(filename))
	stem := strings.TrimSuffix(filename, filepath.Ext(filename))
	safeStem := asciiSlug(stem)
	if safeStem == "" {
		safeStem = "file"
	}
	randomID, err := randomAvatarID()
	if err != nil {
		return "", err
	}
	key := fmt.Sprintf(
		"avatars/%s/%s_%s%s",
		safeAvatarUserID(userID),
		randomID,
		safeStem,
		extension,
	)
	if err := blob.ValidateKey(key); err != nil {
		return "", err
	}
	return key, nil
}

func safeAvatarUserID(userID string) string {
	raw := strings.TrimSpace(userID)
	var builder strings.Builder
	previousDot := false
	for _, character := range raw {
		allowed := character >= 'A' && character <= 'Z' ||
			character >= 'a' && character <= 'z' ||
			character >= '0' && character <= '9' ||
			character == '.' || character == '_' || character == '-'
		if !allowed {
			if !previousDot {
				builder.WriteByte('-')
				previousDot = false
			}
			continue
		}
		if character == '.' {
			if previousDot {
				continue
			}
			previousDot = true
		} else {
			previousDot = false
		}
		builder.WriteRune(character)
	}
	safe := strings.Trim(builder.String(), " .-_")
	runes := []rune(safe)
	if len(runes) > 80 {
		safe = string(runes[:80])
	}
	if safe == "" {
		return "user_unknown"
	}
	return safe
}

func asciiSlug(value string) string {
	var builder strings.Builder
	separator := false
	for _, character := range strings.ToLower(value) {
		allowed := character >= 'a' && character <= 'z' ||
			character >= '0' && character <= '9'
		if allowed {
			if separator && builder.Len() > 0 {
				builder.WriteByte('-')
			}
			builder.WriteRune(character)
			separator = false
		} else {
			separator = true
		}
		if builder.Len() >= 80 {
			break
		}
	}
	return strings.Trim(builder.String(), "-")
}

func randomAvatarID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}

func avatarObjectKey(rawURL string) string {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return ""
	}
	decoded, err := url.PathUnescape(parsed.EscapedPath())
	if err != nil {
		return ""
	}
	decoded = strings.TrimPrefix(decoded, "/")
	index := strings.Index(decoded, "avatars/")
	if index < 0 {
		return ""
	}
	key := decoded[index:]
	if blob.ValidateKey(key) != nil {
		return ""
	}
	return key
}

func hasAvatar(avatarURL *string) bool {
	return avatarURL != nil && strings.TrimSpace(*avatarURL) != ""
}

func bestEffortAvatarDelete(parent context.Context, blobs BlobStore, key string) {
	if blobs == nil || key == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(parent), avatarDeleteTimeout)
	defer cancel()
	_ = blobs.Delete(ctx, key)
}

func operatorPointer(identity auth.UserContext) *string {
	for _, value := range []string{identity.Operator, identity.Name, identity.Email} {
		if value = strings.TrimSpace(value); value != "" {
			return &value
		}
	}
	return nil
}

func operatorPointerFromRequest(r *http.Request) *string {
	identity, _ := auth.UserContextFromContext(r.Context())
	return operatorPointer(identity)
}

func stringPointer(value string) *string {
	return &value
}
