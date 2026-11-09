package contract

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/exchange_rates"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/projects"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/sku_info"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
	requestauth "github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

func TestStage10ERoutesRequireAuthAndFailClosedWithoutDependencies(t *testing.T) {
	router := stage10ERouter(nil, false)
	paths := []struct {
		method string
		path   string
		body   io.Reader
	}{
		{http.MethodPost, "/api/v1/projects/7/context/parse", bytes.NewBufferString(`{"description":"context"}`)},
		{http.MethodPost, "/api/v1/exchange-rates/upload-image", bytes.NewBuffer(nil)},
		{http.MethodGet, "/api/v1/sku-info/1/fnsku-label/download", nil},
		{http.MethodDelete, "/api/v1/sku-info/1/product-image", nil},
	}
	for _, item := range paths {
		request := httptest.NewRequest(item.method, item.path, item.body)
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s status = %d, body = %s", item.method, item.path, recorder.Code, recorder.Body.String())
		}
	}

	authenticated := stage10ERouter(nil, true)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/projects/7/move-sideways", nil)
	request = request.WithContext(requestauth.WithUserContext(
		request.Context(),
		requestauth.UserContext{Operator: "alice", IsAdmin: true},
	))
	recorder := httptest.NewRecorder()
	authenticated.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("invalid move status = %d, body = %s", recorder.Code, recorder.Body.String())
	}

	for _, item := range paths[1:] {
		request = httptest.NewRequest(item.method, item.path, item.body)
		request = request.WithContext(requestauth.WithUserContext(
			request.Context(),
			requestauth.UserContext{Operator: "alice", IsAdmin: true},
		))
		recorder = httptest.NewRecorder()
		authenticated.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s %s status = %d, body = %s", item.method, item.path, recorder.Code, recorder.Body.String())
		}
	}
}

func TestStage10EFNSKUDownloadAndBatchReturnRealMagic(t *testing.T) {
	key := "sku-info/fnsku-labels/10/1/label.pdf"
	record := sku_info.SkuRecordItem{
		ID: 1, ProjectID: 10, ProjectName: "Project A", SKU: "SKU-1",
		FnskuLabelR2Key: &key,
	}
	skus := &stage10EContractSKUStore{record: record, records: []sku_info.SkuRecordItem{record}}
	blobs := &stage10EContractBlobs{objects: map[string][]byte{key: []byte("%PDF-1.4\n%%EOF")}}
	router := stage10ERouterWithSKU(skus, blobs, true)

	request := httptest.NewRequest(http.MethodGet, "/api/v1/sku-info/1/fnsku-label/download", nil)
	request = request.WithContext(requestauth.WithUserContext(
		request.Context(),
		requestauth.UserContext{Operator: "alice", IsAdmin: true},
	))
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || !bytes.HasPrefix(recorder.Body.Bytes(), []byte("%PDF-")) ||
		recorder.Header().Get("Content-Type") != "application/pdf" {
		t.Fatalf("download = %d %q %x", recorder.Code, recorder.Header().Get("Content-Type"), recorder.Body.Bytes())
	}

	request = httptest.NewRequest(
		http.MethodPost,
		"/api/v1/sku-info/fnsku-labels/batch-download",
		bytes.NewBufferString(`{"sku_record_ids":[1]}`),
	)
	request = request.WithContext(requestauth.WithUserContext(
		request.Context(),
		requestauth.UserContext{Operator: "alice", IsAdmin: true},
	))
	recorder = httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || !bytes.HasPrefix(recorder.Body.Bytes(), []byte("PK\x03\x04")) {
		t.Fatalf("batch = %d %x", recorder.Code, recorder.Body.Bytes())
	}
	if _, err := zip.NewReader(bytes.NewReader(recorder.Body.Bytes()), int64(recorder.Body.Len())); err != nil {
		t.Fatalf("batch ZIP is invalid: %v", err)
	}
}

func TestStage10EExchangeUploadRouteWritesImage(t *testing.T) {
	blobs := &stage10EContractBlobs{}
	router := chi.NewRouter()
	exchange_rates.NewHandler(&stage10EContractExchangeStore{}, exchange_rates.WithBlobStore(blobs)).
		RegisterWriteRoutes(router, stage10ERequireAuth)

	body, contentType := stage10EContractImageMultipart(t)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/exchange-rates/upload-image", body)
	request.Header.Set("Content-Type", contentType)
	request = request.WithContext(requestauth.WithUserContext(
		request.Context(),
		requestauth.UserContext{Operator: "alice", IsAdmin: true},
	))
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if len(blobs.puts) != 2 ||
		!bytes.HasPrefix(blobs.puts[0].data, []byte{0x89, 'P', 'N', 'G'}) {
		t.Fatalf("puts = %#v, want PNG main + thumbnail", blobs.puts)
	}
}

func stage10ERouter(blobs sku_info.BlobStore, authenticated bool) chi.Router {
	return stage10ERouterWithSKU(&stage10EContractSKUStore{
		record: sku_info.SkuRecordItem{ID: 1, ProjectID: 10, ProjectName: "Project A", SKU: "SKU-1"},
	}, blobs, authenticated)
}

func stage10ERouterWithSKU(
	store *stage10EContractSKUStore,
	blobs sku_info.BlobStore,
	authenticated bool,
) chi.Router {
	router := chi.NewRouter()
	authMiddleware := func(next http.Handler) http.Handler { return next }
	if !authenticated {
		authMiddleware = stage10ERequireAuth
	}
	projectStore := &stage10EContractProjectStore{}
	projects.NewRegistrar(projectStore, &stage10EContractAudit{}).RegisterRoutes(router, authMiddleware)
	sku_info.NewRegistrar(store, &stage10EContractAudit{}, projectStore).
		WithBlobStore(blobs).
		RegisterRoutes(router, authMiddleware)
	exchange_rates.NewHandler(&stage10EContractExchangeStore{}).
		RegisterWriteRoutes(router, authMiddleware)
	return router
}

func stage10ERequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := requestauth.UserContextFromContext(r.Context()); !ok {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"detail":"Not authenticated"}`))
			return
		}
		next.ServeHTTP(w, r)
	})
}

func stage10EContractImageMultipart(t *testing.T) (*bytes.Buffer, string) {
	t.Helper()
	content := stage10EContractPNG()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	header := textproto.MIMEHeader{}
	header.Set("Content-Disposition", `form-data; name="file"; filename="note.png"`)
	header.Set("Content-Type", "image/png")
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatalf("create multipart: %v", err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatalf("write multipart: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart: %v", err)
	}
	return &body, writer.FormDataContentType()
}

func stage10EContractPNG() []byte {
	img := image.NewNRGBA(image.Rect(0, 0, 2, 2))
	img.Set(0, 0, color.NRGBA{R: 255, A: 255})
	img.Set(1, 1, color.NRGBA{B: 255, A: 255})
	var buffer bytes.Buffer
	_ = png.Encode(&buffer, img)
	return buffer.Bytes()
}

type stage10EContractPut struct {
	key         string
	data        []byte
	contentType string
}

type stage10EContractBlobs struct {
	objects     map[string][]byte
	puts        []stage10EContractPut
	deletedKeys []string
}

func (blobs *stage10EContractBlobs) Put(
	_ context.Context,
	key string,
	data []byte,
	contentType string,
) (string, error) {
	blobs.puts = append(blobs.puts, stage10EContractPut{
		key: key, data: append([]byte(nil), data...), contentType: contentType,
	})
	return "https://cdn.example.com/" + key, nil
}

func (blobs *stage10EContractBlobs) Get(_ context.Context, key string) (io.ReadCloser, error) {
	data, ok := blobs.objects[key]
	if !ok {
		return nil, errors.New("object not found")
	}
	return io.NopCloser(bytes.NewReader(data)), nil
}

func (blobs *stage10EContractBlobs) Delete(_ context.Context, key string) error {
	blobs.deletedKeys = append(blobs.deletedKeys, key)
	return nil
}

type stage10EContractProjectStore struct{}

func (*stage10EContractProjectStore) ListOptions(context.Context) ([]projects.ProjectOption, error) {
	return nil, nil
}
func (*stage10EContractProjectStore) ListManage(context.Context, string, bool, bool) ([]projects.ProjectItem, error) {
	return nil, nil
}
func (*stage10EContractProjectStore) ListOperatorOptions(context.Context) ([]string, error) {
	return nil, nil
}
func (*stage10EContractProjectStore) GetProject(_ context.Context, id int64) (*projects.ProjectItem, error) {
	return &projects.ProjectItem{ID: id, Name: "Project A", ProjectOperator: stage10EStringPointer("alice")}, nil
}
func (*stage10EContractProjectStore) GetProjectByName(_ context.Context, name string) (*projects.ProjectItem, error) {
	return &projects.ProjectItem{Name: name, ProjectOperator: stage10EStringPointer("alice")}, nil
}
func (*stage10EContractProjectStore) CreateProject(context.Context, projects.CreateProjectInput) (projects.ProjectItem, error) {
	return projects.ProjectItem{}, nil
}
func (*stage10EContractProjectStore) UpdateProject(context.Context, int64, projects.UpdateProjectInput) (projects.ProjectItem, error) {
	return projects.ProjectItem{}, nil
}
func (*stage10EContractProjectStore) MoveProject(context.Context, int64, string) (projects.ProjectItem, error) {
	return projects.ProjectItem{}, nil
}
func (*stage10EContractProjectStore) ListProjectShops(context.Context, int64) ([]projects.ProjectShopItem, error) {
	return nil, nil
}
func (*stage10EContractProjectStore) UpsertProjectShop(context.Context, int64, string, projects.ShopUpsert) (*projects.ProjectShopItem, projects.ProjectShopItem, error) {
	return nil, projects.ProjectShopItem{}, nil
}
func (*stage10EContractProjectStore) DeleteProjectShop(context.Context, int64, string) (bool, error) {
	return false, nil
}
func (*stage10EContractProjectStore) GetProjectContext(context.Context, int64) (projects.ProjectContext, error) {
	return projects.ProjectContext{}, nil
}
func (*stage10EContractProjectStore) PatchProjectContext(context.Context, int64, map[string]any, map[string]any, string) (projects.ProjectContext, error) {
	return projects.ProjectContext{}, nil
}

type stage10EContractSKUStore struct {
	record  sku_info.SkuRecordItem
	records []sku_info.SkuRecordItem
}

func (store *stage10EContractSKUStore) ListSkuRecords(context.Context, sku_info.SkuFilter) (sku_info.SkuRecordsPage, error) {
	return sku_info.SkuRecordsPage{}, nil
}
func (store *stage10EContractSKUStore) GetSkuRecord(_ context.Context, id int64) (*sku_info.SkuRecordItem, error) {
	if store.record.ID != id {
		return nil, nil
	}
	return &store.record, nil
}
func (*stage10EContractSKUStore) GetProjectIDsBySkuIDs(context.Context, []int64) (map[int64]int64, error) {
	return nil, nil
}
func (*stage10EContractSKUStore) CreateOrUpdateSkuRecord(context.Context, sku_info.SkuRecordCreate, string) (sku_info.SkuRecordItem, string, error) {
	return sku_info.SkuRecordItem{}, "", nil
}
func (*stage10EContractSKUStore) BulkCreateOrUpdateSkuRecords(context.Context, sku_info.SkuRecordBulkCreate, string) (sku_info.SkuRecordBulkUpsertResponse, error) {
	return sku_info.SkuRecordBulkUpsertResponse{}, nil
}
func (*stage10EContractSKUStore) UpdateSkuRecord(context.Context, int64, sku_info.SkuRecordUpdate, string) (*sku_info.SkuRecordItem, error) {
	return nil, nil
}
func (*stage10EContractSKUStore) DeleteSkuRecord(context.Context, int64) (bool, error) {
	return false, nil
}
func (*stage10EContractSKUStore) MoveSkuRecord(context.Context, int64, string) (*sku_info.SkuRecordItem, error) {
	return nil, nil
}
func (*stage10EContractSKUStore) RecalculateFirstLegCosts(context.Context, sku_info.SkuRecordFirstLegRecalculateRequest) (int, error) {
	return 0, nil
}
func (*stage10EContractSKUStore) SyncFirstLegFromShipment(context.Context, string, string) (int, error) {
	return 0, nil
}
func (*stage10EContractSKUStore) BatchUpdateFactoryInfo(context.Context, sku_info.BatchUpdateFactoryInfoRequest, string) (int, []int64, error) {
	return 0, nil, nil
}
func (*stage10EContractSKUStore) BatchUpdateListingCopy(context.Context, sku_info.BatchUpdateListingCopyRequest, string) (int, int, []int64, error) {
	return 0, 0, nil, nil
}
func (*stage10EContractSKUStore) GetFnskuLabelsBySkus(context.Context, string, []string) ([]sku_info.SkuRecordFnskuLabelItem, error) {
	return nil, nil
}
func (*stage10EContractSKUStore) ExportCSV(context.Context, sku_info.SkuFilter) (string, []byte, error) {
	return "", nil, nil
}
func (*stage10EContractSKUStore) ImportCSV(context.Context, string, []byte, string) (sku_info.SkuRecordImportResponse, error) {
	return sku_info.SkuRecordImportResponse{}, nil
}
func (store *stage10EContractSKUStore) GetSkuRecordsByIDs(context.Context, []int64) ([]sku_info.SkuRecordItem, error) {
	return store.records, nil
}
func (*stage10EContractSKUStore) SetFnskuLabel(context.Context, int64, string, string, audit.Entry) (*sku_info.SkuRecordItem, *string, error) {
	return nil, nil, nil
}
func (*stage10EContractSKUStore) SetProductImage(context.Context, int64, string, string, string, string, time.Time, string, audit.Entry) (*sku_info.SkuRecordItem, []string, error) {
	return nil, nil, nil
}
func (*stage10EContractSKUStore) ClearProductImage(context.Context, int64, audit.Entry) (*sku_info.SkuRecordItem, []string, error) {
	return nil, nil, nil
}

type stage10EContractExchangeStore struct{}

func (*stage10EContractExchangeStore) List(context.Context, *string, *string, int, int) ([]exchange_rates.ExchangeRate, int, error) {
	return nil, 0, nil
}
func (*stage10EContractExchangeStore) Resolve(context.Context, string, string) (*exchange_rates.ExchangeRate, error) {
	return nil, nil
}
func (*stage10EContractExchangeStore) ListOptionRows(context.Context) ([]exchange_rates.ExchangeRate, error) {
	return nil, nil
}
func (*stage10EContractExchangeStore) Get(context.Context, int64) (*exchange_rates.ExchangeRate, error) {
	return nil, nil
}

type stage10EContractAudit struct{}

func (*stage10EContractAudit) LogAction(context.Context, audit.Entry) error { return nil }
func (*stage10EContractAudit) LogActionTx(context.Context, pgx.Tx, audit.Entry) error {
	return nil
}
func (*stage10EContractAudit) LogView(context.Context, string, string, *string, any, *http.Request) error {
	return nil
}

func stage10EStringPointer(value string) *string {
	return &value
}
