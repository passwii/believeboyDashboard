package sku_info

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/projects"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

func TestSkuMediaUploadFNSKULabelUsesBlobAuditAndFailsClosed(t *testing.T) {
	oldKey := "sku-info/fnsku-labels/10/1/old.pdf"
	store := &stage10EFileStore{
		mockSkuStore: &mockSkuStore{item: SkuRecordItem{
			ID: 1, ProjectID: 10, ProjectName: "ProjectA", SKU: "SKU-1",
			FNSKU: stringMediaPointer("X00ABCDEFG"), FnskuLabelR2Key: &oldKey,
		}},
		listRecords: []SkuRecordItem{{ID: 1, ProjectID: 10, ProjectName: "ProjectA", SKU: "SKU-1"}},
	}
	blobs := &stage10ESKUBlobs{}
	router, _ := stage10EMediaRouter(store, blobs, stage10EAllowProject{})

	request := stage10EMultipartRequest(
		t,
		http.MethodPost,
		"/api/v1/sku-info/1/fnsku-label",
		"file",
		"label.pdf",
		"application/pdf",
		stage10EPDF(),
	)
	request = request.WithContext(auth.WithUserContext(request.Context(), auth.UserContext{
		Operator: "alice", IsAdmin: true,
	}))
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if len(store.fnskuSetCalls) != 1 || len(blobs.puts) != 1 {
		t.Fatalf("store calls = %#v, puts = %#v", store.fnskuSetCalls, blobs.puts)
	}
	if call := store.fnskuSetCalls[0]; call.action.Action != "sku_info.upload_fnsku_label" ||
		!strings.HasPrefix(call.key, "sku-info/fnsku-labels/10/1/") {
		t.Fatalf("fnsku call = %#v", call)
	}
	if len(blobs.deletedKeys) != 1 || blobs.deletedKeys[0] != oldKey {
		t.Fatalf("deleted keys = %#v, want old object cleanup", blobs.deletedKeys)
	}

	missingStorageRouter, _ := stage10EMediaRouter(store, nil, stage10EAllowProject{})
	request = stage10EMultipartRequest(
		t, http.MethodPost, "/api/v1/sku-info/1/fnsku-label",
		"file", "label.pdf", "application/pdf", stage10EPDF(),
	)
	request = request.WithContext(auth.WithUserContext(request.Context(), auth.UserContext{
		Operator: "alice", IsAdmin: true,
	}))
	recorder = httptest.NewRecorder()
	missingStorageRouter.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("missing storage status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestSkuMediaFNSKULabelUploadValidatesMagicAndCompensatesStoreFailure(t *testing.T) {
	store := &stage10EFileStore{
		mockSkuStore: &mockSkuStore{item: SkuRecordItem{
			ID: 1, ProjectID: 10, ProjectName: "ProjectA", SKU: "SKU-1",
		}},
		storeErr: errors.New("database transaction failed"),
	}
	blobs := &stage10ESKUBlobs{}
	router, _ := stage10EMediaRouter(store, blobs, stage10EAllowProject{})

	request := stage10EMultipartRequest(
		t, http.MethodPost, "/api/v1/sku-info/1/fnsku-label",
		"file", "label.pdf", "application/pdf", []byte("not a PDF"),
	)
	request = request.WithContext(auth.WithUserContext(request.Context(), auth.UserContext{
		Operator: "alice", IsAdmin: true,
	}))
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("invalid PDF status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if len(blobs.puts) != 0 {
		t.Fatal("invalid PDF reached object storage")
	}

	request = stage10EMultipartRequest(
		t, http.MethodPost, "/api/v1/sku-info/1/fnsku-label",
		"file", "../label.pdf", "application/pdf", stage10EPDF(),
	)
	request = request.WithContext(auth.WithUserContext(request.Context(), auth.UserContext{
		Operator: "alice", IsAdmin: true,
	}))
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("traversal filename status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if len(blobs.puts) != 0 {
		t.Fatal("traversal filename reached object storage")
	}

	request = stage10EMultipartRequest(
		t, http.MethodPost, "/api/v1/sku-info/1/fnsku-label",
		"file", "label.pdf", "application/pdf", stage10EPDF(),
	)
	request = request.WithContext(auth.WithUserContext(request.Context(), auth.UserContext{
		Operator: "alice", IsAdmin: true,
	}))
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("store failure status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if len(blobs.deletedKeys) != 1 || !strings.Contains(blobs.deletedKeys[0], "sku-info/fnsku-labels/10/1/") {
		t.Fatalf("compensation deletes = %#v", blobs.deletedKeys)
	}
}

func TestSkuMediaDownloadsReturnRealPDFAndZIP(t *testing.T) {
	firstKey := "sku-info/fnsku-labels/10/1/label.pdf"
	secondKey := "sku-info/fnsku-labels/20/2/label.pdf"
	store := &stage10EFileStore{
		mockSkuStore: &mockSkuStore{item: SkuRecordItem{
			ID: 1, ProjectID: 10, ProjectName: "ProjectA", SKU: "SKU/A",
			FnskuLabelR2Key: &firstKey,
		}},
		listRecords: []SkuRecordItem{
			{ID: 2, ProjectID: 20, ProjectName: "Project B", SKU: "SKU/A", FnskuLabelR2Key: &secondKey},
			{ID: 1, ProjectID: 10, ProjectName: "ProjectA", SKU: "SKU/A", FnskuLabelR2Key: &firstKey},
		},
	}
	blobs := &stage10ESKUBlobs{objects: map[string][]byte{
		firstKey:  stage10EPDF(),
		secondKey: stage10EPDF(),
	}}
	router, auditor := stage10EMediaRouter(store, blobs, stage10EAllowProject{})

	request := httptest.NewRequest(http.MethodGet, "/api/v1/sku-info/1/fnsku-label/download", nil)
	request = request.WithContext(auth.WithUserContext(request.Context(), auth.UserContext{
		Operator: "alice", IsAdmin: true,
	}))
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("download status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if !strings.HasPrefix(recorder.Body.String(), "%PDF-") ||
		recorder.Header().Get("Content-Type") != "application/pdf" ||
		!strings.Contains(recorder.Header().Get("Content-Disposition"), "SKU_A-fnsku-label.pdf") {
		t.Fatalf("download headers/body = %s %q", recorder.Header(), recorder.Body.String())
	}

	request = httptest.NewRequest(
		http.MethodPost,
		"/api/v1/sku-info/fnsku-labels/batch-download",
		strings.NewReader(`{"sku_record_ids":[2,1]}`),
	)
	request = request.WithContext(auth.WithUserContext(request.Context(), auth.UserContext{
		Operator: "alice", IsAdmin: true,
	}))
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("batch status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if !bytes.HasPrefix(recorder.Body.Bytes(), []byte("PK\x03\x04")) {
		t.Fatalf("batch body is not ZIP: %x", recorder.Body.Bytes()[:8])
	}
	archive, err := zip.NewReader(bytes.NewReader(recorder.Body.Bytes()), int64(recorder.Body.Len()))
	if err != nil {
		t.Fatalf("open ZIP: %v", err)
	}
	if len(archive.File) != 2 || !strings.HasPrefix(archive.File[0].Name, "SKU_A") {
		t.Fatalf("zip files = %#v", archive.File)
	}
	if len(auditor.entries) == 0 ||
		auditor.entries[len(auditor.entries)-1].Action != "sku_info.batch_download_fnsku_labels" {
		t.Fatalf("batch audit = %#v", auditor.entries)
	}
}

func TestSkuMediaProductImageUploadDeleteAndCompensation(t *testing.T) {
	oldMain := "sku-info/product-images/10/1/old-main.png"
	oldThumb := "sku-info/product-images/10/1/old-thumb.png"
	store := &stage10EFileStore{
		mockSkuStore: &mockSkuStore{item: SkuRecordItem{
			ID: 1, ProjectID: 10, ProjectName: "ProjectA", SKU: "SKU-1",
			ProductImageR2Key: &oldMain, ProductImageThumbnailR2Key: &oldThumb,
		}},
		oldKeys: []string{oldMain, oldThumb},
	}
	blobs := &stage10ESKUBlobs{}
	router, _ := stage10EMediaRouter(store, blobs, stage10EAllowProject{})

	request := stage10EMultipartRequest(
		t, http.MethodPost, "/api/v1/sku-info/1/product-image",
		"file", "product.png", "image/png", stage10ESKUPNG(t),
	)
	request = request.WithContext(auth.WithUserContext(request.Context(), auth.UserContext{
		Operator: "alice", IsAdmin: true,
	}))
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("upload status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if len(blobs.puts) != 2 || len(blobs.deletedKeys) != 2 {
		t.Fatalf("puts/deletes = %#v/%#v", blobs.puts, blobs.deletedKeys)
	}

	request = httptest.NewRequest(http.MethodDelete, "/api/v1/sku-info/1/product-image", nil)
	request = request.WithContext(auth.WithUserContext(request.Context(), auth.UserContext{
		Operator: "alice", IsAdmin: true,
	}))
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("delete status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var response SkuProductImageDeleteResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil || !response.Deleted {
		t.Fatalf("delete response = %s, err = %v", recorder.Body.String(), err)
	}

	store.storeErr = errors.New("database transaction failed")
	request = stage10EMultipartRequest(
		t, http.MethodPost, "/api/v1/sku-info/1/product-image",
		"file", "product.png", "image/png", stage10ESKUPNG(t),
	)
	request = request.WithContext(auth.WithUserContext(request.Context(), auth.UserContext{
		Operator: "alice", IsAdmin: true,
	}))
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("store failure status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if len(blobs.deletedKeys) != 6 {
		t.Fatalf("compensation deletes = %#v, want both new objects", blobs.deletedKeys)
	}
}

func TestSkuMediaPermissionsAndBatchLimit(t *testing.T) {
	store := &stage10EFileStore{
		mockSkuStore: &mockSkuStore{item: SkuRecordItem{
			ID: 1, ProjectID: 10, ProjectName: "Secret", SKU: "SKU-1",
			FnskuLabelR2Key: stringMediaPointer("key"),
		}},
		listRecords: []SkuRecordItem{{ID: 1, ProjectID: 10, ProjectName: "Secret", SKU: "SKU-1"}},
	}
	blobs := &stage10ESKUBlobs{objects: map[string][]byte{"key": stage10EPDF()}}
	projectReader := &mockSkuProjectReader{proj: projects.ProjectItem{
		ID: 10, Name: "Secret", ProjectOperator: stringMediaPointer("alice"),
	}}
	router, _ := stage10EMediaRouter(store, blobs, projectReader)

	request := stage10EMultipartRequest(
		t, http.MethodPost, "/api/v1/sku-info/1/fnsku-label",
		"file", "label.pdf", "application/pdf", stage10EPDF(),
	)
	request = request.WithContext(auth.WithUserContext(request.Context(), auth.UserContext{
		Operator: "bob",
	}))
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("permission status = %d, body = %s", recorder.Code, recorder.Body.String())
	}

	ids := make([]int64, 501)
	for index := range ids {
		ids[index] = int64(index + 1)
	}
	payload, _ := json.Marshal(BatchFnskuLabelDownloadRequest{SkuRecordIDs: ids})
	request = httptest.NewRequest(
		http.MethodPost,
		"/api/v1/sku-info/fnsku-labels/batch-download",
		bytes.NewReader(payload),
	)
	request = request.WithContext(auth.WithUserContext(request.Context(), auth.UserContext{IsAdmin: true}))
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("batch limit status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestSkuMediaBatchRejectsOversizedLabelObject(t *testing.T) {
	key := "sku-info/fnsku-labels/10/1/large.pdf"
	oversized := make([]byte, maxBatchFNSKULabelBytes+1)
	copy(oversized, []byte("%PDF-1.4\n"))
	store := &stage10EFileStore{
		mockSkuStore: &mockSkuStore{item: SkuRecordItem{
			ID: 1, ProjectID: 10, ProjectName: "ProjectA", SKU: "SKU-1",
			FnskuLabelR2Key: &key,
		}},
		listRecords: []SkuRecordItem{{
			ID: 1, ProjectID: 10, ProjectName: "ProjectA", SKU: "SKU-1",
			FnskuLabelR2Key: &key,
		}},
	}
	blobs := &stage10ESKUBlobs{objects: map[string][]byte{key: oversized}}
	router, _ := stage10EMediaRouter(store, blobs, stage10EAllowProject{})

	request := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/sku-info/fnsku-labels/batch-download",
		strings.NewReader(`{"sku_record_ids":[1]}`),
	)
	request = request.WithContext(auth.WithUserContext(request.Context(), auth.UserContext{IsAdmin: true}))
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("oversized label status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
}

type stage10EFnskuCall struct {
	id      int64
	key     string
	url     string
	action  audit.Entry
	product bool
}

type stage10EFileStore struct {
	*mockSkuStore
	listRecords   []SkuRecordItem
	storeErr      error
	oldKeys       []string
	fnskuSetCalls []stage10EFnskuCall
	productCalls  []stage10EFnskuCall
}

func (store *stage10EFileStore) SetFnskuLabel(
	_ context.Context,
	id int64,
	key string,
	publicURL string,
	entry audit.Entry,
) (*SkuRecordItem, *string, error) {
	store.fnskuSetCalls = append(store.fnskuSetCalls, stage10EFnskuCall{
		id: id, key: key, url: publicURL, action: entry,
	})
	if store.storeErr != nil {
		return nil, nil, store.storeErr
	}
	item := store.item
	previous := item.FnskuLabelR2Key
	item.FnskuLabelR2Key = &key
	item.FnskuLabelR2URL = &publicURL
	return &item, previous, nil
}

func (store *stage10EFileStore) SetProductImage(
	_ context.Context,
	id int64,
	mainKey string,
	mainURL string,
	thumbKey string,
	thumbURL string,
	uploadedAt time.Time,
	operator string,
	entry audit.Entry,
) (*SkuRecordItem, []string, error) {
	store.productCalls = append(store.productCalls, stage10EFnskuCall{
		id: id, key: mainKey, url: mainURL, action: entry, product: true,
	})
	if store.storeErr != nil {
		return nil, nil, store.storeErr
	}
	item := store.item
	item.ProductImageR2Key = &mainKey
	item.ProductImageR2URL = &mainURL
	item.ProductImageThumbnailR2Key = &thumbKey
	item.ProductImageThumbnailR2URL = &thumbURL
	uploaded := uploadedAt.Format(time.RFC3339Nano)
	item.ProductImageUploadedAt = &uploaded
	item.ProductImageUploadedBy = &operator
	return &item, append([]string(nil), store.oldKeys...), nil
}

func (store *stage10EFileStore) ClearProductImage(
	_ context.Context,
	id int64,
	entry audit.Entry,
) (*SkuRecordItem, []string, error) {
	if store.storeErr != nil {
		return nil, nil, store.storeErr
	}
	item := store.item
	item.ProductImageR2Key = nil
	item.ProductImageR2URL = nil
	item.ProductImageThumbnailR2Key = nil
	item.ProductImageThumbnailR2URL = nil
	item.ProductImageUploadedAt = nil
	item.ProductImageUploadedBy = nil
	return &item, append([]string(nil), store.oldKeys...), nil
}

func (store *stage10EFileStore) GetSkuRecordsByIDs(
	_ context.Context,
	ids []int64,
) ([]SkuRecordItem, error) {
	if store.storeErr != nil {
		return nil, store.storeErr
	}
	wanted := make(map[int64]bool, len(ids))
	for _, id := range ids {
		wanted[id] = true
	}
	var result []SkuRecordItem
	for _, item := range store.listRecords {
		if wanted[item.ID] {
			result = append(result, item)
		}
	}
	return result, nil
}

type stage10ESKUBlobs struct {
	objects     map[string][]byte
	puts        []stage10EExchangePut
	deletedKeys []string
}

type stage10EExchangePut struct {
	key         string
	data        []byte
	contentType string
}

func (blobs *stage10ESKUBlobs) Put(
	_ context.Context,
	key string,
	data []byte,
	contentType string,
) (string, error) {
	blobs.puts = append(blobs.puts, stage10EExchangePut{
		key: key, data: append([]byte(nil), data...), contentType: contentType,
	})
	return "https://cdn.example.com/" + key, nil
}

func (blobs *stage10ESKUBlobs) Get(_ context.Context, key string) (io.ReadCloser, error) {
	data, ok := blobs.objects[key]
	if !ok {
		return nil, errors.New("object not found")
	}
	return io.NopCloser(bytes.NewReader(data)), nil
}

func (blobs *stage10ESKUBlobs) Delete(_ context.Context, key string) error {
	blobs.deletedKeys = append(blobs.deletedKeys, key)
	return nil
}

type stage10EAllowProject struct{}

func (stage10EAllowProject) GetProject(_ context.Context, id int64) (*projects.ProjectItem, error) {
	return &projects.ProjectItem{ID: id, ProjectOperator: stringMediaPointer("alice")}, nil
}

func (stage10EAllowProject) GetProjectByName(_ context.Context, name string) (*projects.ProjectItem, error) {
	return &projects.ProjectItem{Name: name, ProjectOperator: stringMediaPointer("alice")}, nil
}

func (stage10EAllowProject) ListManage(
	context.Context,
	string,
	bool,
	bool,
) ([]projects.ProjectItem, error) {
	return nil, nil
}

func stage10EMediaRouter(
	store *stage10EFileStore,
	blobs BlobStore,
	projectReader ProjectReader,
) (chi.Router, *mockAuditor) {
	auditor := &mockAuditor{}
	router := chi.NewRouter()
	registrar := NewRegistrar(store, auditor, projectReader).WithBlobStore(blobs)
	registrar.RegisterRoutes(router, stage10EPassthrough)
	return router, auditor
}

func stage10EMultipartRequest(
	t *testing.T,
	method string,
	path string,
	field string,
	filename string,
	contentType string,
	content []byte,
) *http.Request {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	header := textproto.MIMEHeader{}
	header.Set("Content-Disposition", `form-data; name="`+field+`"; filename="`+filename+`"`)
	header.Set("Content-Type", contentType)
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatalf("create multipart part: %v", err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatalf("write multipart part: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}
	request := httptest.NewRequest(method, path, &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	return request
}

func stage10EPDF() []byte {
	return []byte("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF")
}

func stage10ESKUPNG(t *testing.T) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, 4, 2))
	img.Set(0, 0, color.NRGBA{R: 255, A: 255})
	img.Set(3, 1, color.NRGBA{B: 255, A: 255})
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, img); err != nil {
		t.Fatalf("encode PNG: %v", err)
	}
	return buffer.Bytes()
}

func stringMediaPointer(value string) *string {
	return &value
}

func stage10EPassthrough(next http.Handler) http.Handler {
	return next
}
