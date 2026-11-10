package crm_intent

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/blob"
)

const maxUploadBytes = 32 << 20

// ingestPayload is the shared input for AI JSON import, AI file import and
// human multipart import (spec §10: one ingest path).
type ingestPayload struct {
	BatchDate      time.Time
	Source         string
	SourceFileName *string
	Mode           string
	ContentType    string
	Raw            []byte
	Companies      []CompanyInput
	Pool           []PoolInput
	Rejected       []RejectedRow
	IdempotencyKey string
	Actor          Actor
}

func r2UnavailableError() *DomainError {
	return NewDomainError(
		http.StatusServiceUnavailable,
		"INTENT_R2_UNAVAILABLE",
		"R2 未配置或不可用，无法归档批次",
	)
}

// executeIngest archives the raw payload to R2 first, then upserts rows.
func (handler *Handler) executeIngest(
	ctx context.Context,
	payload ingestPayload,
) (IngestResult, error) {
	batchDate := payload.BatchDate
	if batchDate.IsZero() {
		now := handler.now().In(shanghaiLocation())
		batchDate = time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, shanghaiLocation())
	}
	mode := payload.Mode
	if mode == "" {
		mode = ModeUpsert
	}
	var createdBy *string
	if payload.Actor.ID != "" {
		value := payload.Actor.ID
		createdBy = &value
	}
	batchID, err := handler.store.CreateBatch(ctx, BatchCreate{
		BatchDate: batchDate, Source: payload.Source,
		SourceFileName: payload.SourceFileName, CreatedBy: createdBy,
	})
	if err != nil {
		return IngestResult{}, internalError()
	}
	if handler.blobs == nil {
		_ = handler.store.FailBatch(ctx, batchID, "R2 unavailable")
		return IngestResult{}, r2UnavailableError()
	}
	filename := "batch-" + batchDate.Format("2006-01-02") + ".json"
	if payload.SourceFileName != nil && strings.TrimSpace(*payload.SourceFileName) != "" {
		filename = *payload.SourceFileName
	}
	key, err := blob.ObjectKey(
		"crm-intent", "batches", batchDate.Format("2006-01-02"),
		fmt.Sprintf("%d-%s", batchID, sanitizeFilename(filename)),
	)
	if err != nil {
		_ = handler.store.FailBatch(ctx, batchID, "invalid object key")
		return IngestResult{}, internalError()
	}
	contentType := payload.ContentType
	if strings.TrimSpace(contentType) == "" {
		contentType = "application/octet-stream"
	}
	if _, err := handler.blobs.Put(ctx, key, payload.Raw, contentType); err != nil {
		_ = handler.blobs.TryDelete(ctx, key)
		_ = handler.store.FailBatch(ctx, batchID, "R2 upload failed")
		return IngestResult{}, r2UnavailableError()
	}
	if err := handler.store.AttachBatchArchive(ctx, batchID, key, sha256Hex(payload.Raw)); err != nil {
		_ = handler.store.FailBatch(ctx, batchID, "archive attach failed")
		return IngestResult{}, internalError()
	}
	result, err := handler.store.IngestBatch(ctx, IngestRequest{
		BatchID: batchID, Mode: mode, Companies: payload.Companies,
		Pool: payload.Pool, Rejected: payload.Rejected, Actor: payload.Actor,
	})
	if err != nil {
		_ = handler.store.FailBatch(ctx, batchID, err.Error())
		return result, err
	}
	result.RequestID = payload.IdempotencyKey
	return result, nil
}

func parseBatchDate(raw string, fallback func() time.Time) (time.Time, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fallback(), nil
	}
	parsed, err := time.ParseInLocation("2006-01-02", raw, shanghaiLocation())
	if err != nil {
		return time.Time{}, newValidationError("batch_date 必须使用 YYYY-MM-DD")
	}
	return parsed, nil
}

func (handler *Handler) today() time.Time {
	now := handler.now().In(shanghaiLocation())
	return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, shanghaiLocation())
}

// parseMultipartUpload extracts the uploaded file bytes and metadata.
func parseMultipartUpload(r *http.Request) ([]byte, string, string, string, error) {
	if err := r.ParseMultipartForm(maxUploadBytes); err != nil {
		return nil, "", "", "", newValidationError("multipart 表单格式错误")
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		return nil, "", "", "", newValidationError("缺少 file 上传字段")
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxUploadBytes+1))
	if err != nil {
		return nil, "", "", "", newValidationError("读取上传文件失败")
	}
	if len(data) > maxUploadBytes {
		return nil, "", "", "", newValidationError("上传文件超过 32MB")
	}
	filename := ""
	if header != nil {
		filename = header.Filename
	}
	return data, filename, r.FormValue("batch_date"), r.FormValue("source_note"), nil
}

// UploadBatch is the admin-only human multipart import endpoint.
func (handler *Handler) UploadBatch(w http.ResponseWriter, r *http.Request) {
	actor := requestActor(r)
	if !actor.IsAdminActor() {
		writeUserError(w, newForbiddenError("仅管理员可导入批次"))
		return
	}
	data, filename, batchDateText, _, err := parseMultipartUpload(r)
	if err != nil {
		writeUserError(w, err)
		return
	}
	batchDate, err := parseBatchDate(batchDateText, handler.today)
	if err != nil {
		writeUserError(w, err)
		return
	}
	companies, pool, rejected, err := ParseImportFile(data, filename)
	if err != nil {
		writeUserError(w, err)
		return
	}
	result, err := handler.executeIngest(r.Context(), ingestPayload{
		BatchDate: batchDate, Source: BatchSourceManual, SourceFileName: &filename,
		Mode: ModeUpsert, ContentType: "application/octet-stream", Raw: data,
		Companies: companies, Pool: pool, Rejected: rejected, Actor: actor,
	})
	if err != nil {
		writeUserError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

type agentBatchMeta struct {
	BatchDate  *string `json:"batch_date"`
	Source     *string `json:"source"`
	SourceFile *string `json:"source_file"`
	Note       *string `json:"note"`
}

type agentBatchEnvelope struct {
	Batch     json.RawMessage   `json:"batch"`
	Mode      string            `json:"mode"`
	Companies []json.RawMessage `json:"companies"`
	Pool      []json.RawMessage `json:"pool"`
}

func decodeAgentBatchBody(body []byte) (ingestPayload, error) {
	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" {
		return ingestPayload{}, newValidationError("请求体不能为空")
	}
	var envelope agentBatchEnvelope
	if err := decodeStrictObject(body, batchEnvelopeFields, companyBannedFields, &envelope); err != nil {
		return ingestPayload{}, err
	}
	mode := strings.TrimSpace(envelope.Mode)
	if mode == "" {
		mode = ModeUpsert
	}
	if mode != ModeUpsert && mode != ModeInsertOnly {
		return ingestPayload{}, newValidationError("mode 只接受 upsert / insert_only")
	}
	meta := agentBatchMeta{}
	if len(envelope.Batch) > 0 && string(envelope.Batch) != "null" {
		if err := decodeStrictObject(envelope.Batch, batchMetaFields, companyBannedFields, &meta); err != nil {
			return ingestPayload{}, err
		}
	}
	batchDate := time.Time{}
	if meta.BatchDate != nil {
		parsed, err := parseBatchDate(*meta.BatchDate, time.Now)
		if err != nil {
			return ingestPayload{}, err
		}
		batchDate = parsed
	}
	if len(envelope.Companies) > maxCompaniesPerBatch {
		return ingestPayload{}, newValidationError(
			fmt.Sprintf("companies 单批不能超过 %d 条", maxCompaniesPerBatch),
		)
	}
	if len(envelope.Pool) > maxPoolPerBatch {
		return ingestPayload{}, newValidationError(
			fmt.Sprintf("pool 单批不能超过 %d 条", maxPoolPerBatch),
		)
	}
	companies, rejected := decodeCompanyRows(envelope.Companies, 0)
	pool, poolRejected := decodePoolRows(envelope.Pool, 0)
	rejected = append(rejected, poolRejected...)
	return ingestPayload{
		BatchDate: batchDate, Source: BatchSourceAI, SourceFileName: meta.SourceFile,
		Mode: mode, ContentType: "application/json", Raw: []byte(body),
		Companies: companies, Pool: pool, Rejected: rejected,
	}, nil
}

// AgentImportBatchJSON implements POST /api/v1/agent/crm-intent/batches.
func (handler *Handler) AgentImportBatchJSON(w http.ResponseWriter, r *http.Request) {
	handler.runAgentWrite(w, r, func(actor Actor, body []byte) (any, error) {
		payload, err := decodeAgentBatchBody(body)
		if err != nil {
			return nil, err
		}
		payload.Actor = actor
		key := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
		payload.IdempotencyKey = key
		return handler.executeIngest(r.Context(), payload)
	})
}

// AgentImportBatchUpload implements POST /api/v1/agent/crm-intent/batches/upload.
func (handler *Handler) AgentImportBatchUpload(w http.ResponseWriter, r *http.Request) {
	actor, err := agentActor(r)
	if err != nil {
		writeAgentError(w, err)
		return
	}
	key, err := requireIdempotencyKey(r)
	if err != nil {
		writeAgentError(w, err)
		return
	}
	data, filename, batchDateText, _, err := parseMultipartUpload(r)
	if err != nil {
		writeAgentError(w, err)
		return
	}
	batchDate, err := parseBatchDate(batchDateText, handler.today)
	if err != nil {
		writeAgentError(w, err)
		return
	}
	companies, pool, rejected, err := ParseImportFile(data, filename)
	if err != nil {
		writeAgentError(w, err)
		return
	}
	hashSource := append(append([]byte{}, data...), []byte(batchDate.Format("2006-01-02"))...)
	hash := sha256Hex(hashSource)
	state, err := handler.store.ReserveImportRequest(
		r.Context(), ActorKindAgent, actor.ID, key, hash,
	)
	if err != nil {
		writeAgentError(w, err)
		return
	}
	if state.Replay {
		if len(state.Response) == 0 {
			writeAgentError(w, ErrIdempotencyInFlight)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(state.Response)
		return
	}
	result, err := handler.executeIngest(r.Context(), ingestPayload{
		BatchDate: batchDate, Source: BatchSourceAI, SourceFileName: &filename,
		Mode: ModeUpsert, ContentType: "application/octet-stream", Raw: data,
		Companies: companies, Pool: pool, Rejected: rejected, Actor: actor,
		IdempotencyKey: key,
	})
	if err != nil {
		_ = handler.store.DeleteImportRequest(r.Context(), ActorKindAgent, actor.ID, key)
		writeAgentError(w, err)
		return
	}
	payload, marshalErr := json.Marshal(result)
	if marshalErr != nil {
		writeAgentError(w, internalError())
		return
	}
	_ = handler.store.CompleteImportRequest(r.Context(), ActorKindAgent, actor.ID, key, payload)
	writeJSON(w, http.StatusOK, result)
}
