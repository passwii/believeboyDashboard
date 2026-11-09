package agent_monthly_reports

import (
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"strings"

	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
)

func (h *Handler) CreateUpload(w http.ResponseWriter, r *http.Request) {
	var request UploadCreateRequest
	if !decodeAgentMonthlyJSON(w, r, &request) {
		return
	}
	if request.ProjectID <= 0 {
		writeValidationError(w, map[string]any{
			"loc":  []string{"body", "project_id"},
			"msg":  "project_id must be positive",
			"type": "value_error",
		})
		return
	}
	if len(strings.TrimSpace(request.Country)) > 8 {
		writeValidationError(w, map[string]any{
			"loc":  []string{"body", "country"},
			"msg":  "country is too long",
			"type": "value_error",
		})
		return
	}
	if len(strings.TrimSpace(request.ReportMonth)) != 7 {
		writeValidationError(w, map[string]any{
			"loc":  []string{"body", "report_month"},
			"msg":  "report_month must be YYYY-MM",
			"type": "value_error",
		})
		return
	}
	if !h.requireProjectScope(w, r, request.ProjectID, false) {
		return
	}
	credential, ok := h.credentialFor(w, r)
	if !ok {
		return
	}
	upload, err := h.store.CreateAgentMonthlyUpload(
		r.Context(),
		store.AgentMonthlyUploadCreateInput{
			AgentKeyID:  credential.KeyID,
			AgentID:     credential.AgentID,
			ProjectID:   request.ProjectID,
			Country:     request.Country,
			ReportMonth: request.ReportMonth,
		},
		h.auditEntry(r, ""),
	)
	if err != nil {
		writeError(w, err)
		return
	}
	writeSuccess(w, http.StatusOK, uploadCreateResponse{
		UploadID:     upload.ID,
		ProjectID:    upload.ProjectID,
		ProjectName:  upload.ProjectName,
		Country:      upload.Country,
		ReportMonth:  upload.ReportMonth,
		Status:       upload.Status,
		ExpiresAt:    httpapi.Timestamp(upload.ExpiresAt),
		MaxFileBytes: h.maxFileBytes,
		AllowedKinds: []string{agentMonthlyCSVKind, agentMonthlyPDFKind},
	}, nil, nil)
}

func (h *Handler) UploadFile(w http.ResponseWriter, r *http.Request) {
	uploadID, ok := h.parsePathID(w, r, "upload_id")
	if !ok {
		return
	}
	credential, ok := h.credentialFor(w, r)
	if !ok {
		return
	}
	upload, err := h.store.GetAgentMonthlyUpload(
		r.Context(),
		uploadID,
		credential.KeyID,
	)
	if err != nil {
		writeError(w, err)
		return
	}
	if !h.requireProjectScope(w, r, upload.ProjectID, false) {
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, h.maxFileBytes+64*1024)
	if err := r.ParseMultipartForm(8 * 1024 * 1024); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeError(w, &apiError{
				Status:       http.StatusRequestEntityTooLarge,
				Code:         ErrorCodeTooLarge,
				HumanMessage: "月报输入文件超过大小上限",
				AgentHint:    "每个 CSV/PDF 上限 50 MiB",
			})
			return
		}
		writeError(w, &apiError{
			Status:       http.StatusUnprocessableEntity,
			Code:         ErrorCodeInvalidInput,
			HumanMessage: "multipart 表单解析失败",
			AgentHint:    "请以 multipart/form-data 提交 file 与 kind 字段",
		})
		return
	}
	defer r.MultipartForm.RemoveAll()

	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, &apiError{
			Status:       http.StatusUnprocessableEntity,
			Code:         ErrorCodeInvalidInput,
			HumanMessage: "缺少 file 字段",
			AgentHint:    "kind=transaction_csv 或 summary_pdf，file 为原始二进制",
		})
		return
	}
	defer file.Close()
	tempPath, err := spoolAgentMonthlyMultipartFile(file, h.maxFileBytes)
	if err != nil {
		writeError(w, err)
		return
	}
	defer os.Remove(tempPath)

	uploaded, err := h.store.UploadAgentMonthlyFile(
		r.Context(),
		store.AgentMonthlyUploadFileInput{
			AgentKeyID:       credential.KeyID,
			UploadID:         uploadID,
			Kind:             r.FormValue("kind"),
			OriginalFilename: header.Filename,
			ContentType:      header.Header.Get("Content-Type"),
			TempPath:         tempPath,
			MaxBytes:         h.maxFileBytes,
		},
		h.auditEntry(r, ""),
	)
	if err != nil {
		if errors.Is(err, store.ErrAgentMonthlyConflict) {
			writeError(w, &apiError{
				Status:       http.StatusConflict,
				Code:         ErrorCodeUploadConflict,
				HumanMessage: "该上传会话已存在同类文件",
				AgentHint:    "每个会话只允许一份 CSV 与一份可选 PDF；更换文件请新建会话",
			})
			return
		}
		writeError(w, err)
		return
	}
	writeSuccess(w, http.StatusOK, uploadFileResponse{
		UploadID:         uploaded.UploadID,
		FileID:           uploaded.FileID,
		Kind:             uploaded.Kind,
		OriginalFilename: uploaded.OriginalFilename,
		SHA256:           uploaded.SHA256,
		Bytes:            uploaded.SizeBytes,
		Validation:       uploaded.Validation,
	}, nil, nil)
}

func spoolAgentMonthlyMultipartFile(
	file multipart.File,
	maxBytes int64,
) (string, error) {
	temp, err := os.CreateTemp("", "agent-monthly-upload-*")
	if err != nil {
		return "", &apiError{
			Status:       http.StatusServiceUnavailable,
			Code:         ErrorCodeInternal,
			HumanMessage: "临时存储暂不可用",
			AgentHint:    "请稍后重试",
		}
	}
	path := temp.Name()
	success := false
	defer func() {
		_ = temp.Close()
		if !success {
			_ = os.Remove(path)
		}
	}()
	if err := temp.Chmod(0o600); err != nil {
		return "", err
	}
	written, err := io.Copy(temp, io.LimitReader(file, maxBytes+1))
	if err != nil {
		return "", err
	}
	if written == 0 {
		return "", &apiError{
			Status:       http.StatusUnprocessableEntity,
			Code:         ErrorCodeInvalidInput,
			HumanMessage: "空文件不被接受",
			AgentHint:    "请上传非空的 CSV/PDF 二进制",
		}
	}
	if written > maxBytes {
		return "", &apiError{
			Status:       http.StatusRequestEntityTooLarge,
			Code:         ErrorCodeTooLarge,
			HumanMessage: "月报输入文件超过大小上限",
			AgentHint:    "每个 CSV/PDF 上限 50 MiB",
		}
	}
	if err := temp.Sync(); err != nil {
		return "", err
	}
	if err := temp.Close(); err != nil {
		return "", err
	}
	success = true
	return path, nil
}
