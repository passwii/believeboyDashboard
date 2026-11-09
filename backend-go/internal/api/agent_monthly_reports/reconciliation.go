package agent_monthly_reports

import (
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
)

func (h *Handler) ReconcileAuto(w http.ResponseWriter, r *http.Request) {
	reportID, ok := h.parsePathID(w, r, "report_id")
	if !ok {
		return
	}
	tolerance, err := parseAgentMonthlyTolerance(r.URL.Query().Get("tolerance"))
	if err != nil {
		writeError(w, err)
		return
	}
	credential, ok := h.credentialFor(w, r)
	if !ok {
		return
	}
	projectID, err := h.store.GetAgentMonthlyReportProjectID(r.Context(), reportID)
	if err != nil {
		writeError(w, err)
		return
	}
	if !h.requireProjectScope(w, r, projectID, true) {
		return
	}
	result, err := h.store.AutoReconcileAgentMonthlyReport(
		r.Context(),
		store.AgentMonthlyAutoReconcileInput{
			ReportID:  reportID,
			Tolerance: tolerance,
			AgentID:   credential.AgentID,
		},
		h.auditEntry(r, ""),
	)
	if err != nil {
		writeError(w, err)
		return
	}
	writeSuccess(w, http.StatusOK, result, nil, nil)
}

func (h *Handler) ReconcileManual(w http.ResponseWriter, r *http.Request) {
	reportID, ok := h.parsePathID(w, r, "report_id")
	if !ok {
		return
	}
	tolerance, err := parseAgentMonthlyTolerance(r.URL.Query().Get("tolerance"))
	if err != nil {
		writeError(w, err)
		return
	}
	credential, ok := h.credentialFor(w, r)
	if !ok {
		return
	}
	projectID, err := h.store.GetAgentMonthlyReportProjectID(r.Context(), reportID)
	if err != nil {
		writeError(w, err)
		return
	}
	if !h.requireProjectScope(w, r, projectID, true) {
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, h.maxFileBytes*2+64*1024)
	if err := r.ParseMultipartForm(8 * 1024 * 1024); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeError(w, &apiError{
				Status:       http.StatusRequestEntityTooLarge,
				Code:         ErrorCodeTooLarge,
				HumanMessage: "对账文件超过大小上限",
				AgentHint:    "Excel 与 PDF 单文件各不超过 50 MiB",
			})
			return
		}
		writeError(w, &apiError{
			Status:       http.StatusUnprocessableEntity,
			Code:         ErrorCodeInvalidInput,
			HumanMessage: "multipart 表单解析失败",
			AgentHint:    "请提交 excel_file 与 pdf_file",
		})
		return
	}
	defer r.MultipartForm.RemoveAll()

	excel, excelHeader, err := r.FormFile("excel_file")
	if err != nil {
		writeError(w, &apiError{
			Status:       http.StatusUnprocessableEntity,
			Code:         ErrorCodeInvalidInput,
			HumanMessage: "缺少 excel_file 字段",
			AgentHint:    "请上传未加密的 .xlsx 文件和有效的 .pdf 文件",
		})
		return
	}
	defer excel.Close()
	pdf, pdfHeader, err := r.FormFile("pdf_file")
	if err != nil {
		writeError(w, &apiError{
			Status:       http.StatusUnprocessableEntity,
			Code:         ErrorCodeInvalidInput,
			HumanMessage: "缺少 pdf_file 字段",
			AgentHint:    "请上传未加密的 .xlsx 文件和有效的 .pdf 文件",
		})
		return
	}
	defer pdf.Close()

	if !strings.EqualFold(filepath.Ext(excelHeader.Filename), ".xlsx") ||
		!strings.EqualFold(filepath.Ext(pdfHeader.Filename), ".pdf") {
		writeError(w, &apiError{
			Status:       http.StatusUnprocessableEntity,
			Code:         ErrorCodeInvalidInput,
			HumanMessage: "对账文件扩展名不合法",
			AgentHint:    "excel_file 必须为 .xlsx，pdf_file 必须为 .pdf",
		})
		return
	}
	excelBytes, err := readAgentMonthlyMultipart(excel, h.maxFileBytes)
	if err != nil {
		writeError(w, err)
		return
	}
	pdfBytes, err := readAgentMonthlyMultipart(pdf, h.maxFileBytes)
	if err != nil {
		writeError(w, err)
		return
	}
	if !strings.HasPrefix(string(excelBytes), "PK\x03\x04") {
		writeError(w, &apiError{
			Status:       http.StatusUnprocessableEntity,
			Code:         ErrorCodeInvalidInput,
			HumanMessage: "Excel 文件内容无效",
			AgentHint:    "请确认文件未损坏且为真实 .xlsx",
		})
		return
	}
	if !strings.HasPrefix(string(pdfBytes), "%PDF-") {
		writeError(w, &apiError{
			Status:       http.StatusUnprocessableEntity,
			Code:         ErrorCodeInvalidInput,
			HumanMessage: "PDF 文件内容无效",
			AgentHint:    "请确认文件未损坏且为真实 PDF",
		})
		return
	}

	result, err := h.store.ManualReconcileAgentMonthlyReport(
		r.Context(),
		store.AgentMonthlyManualReconcileInput{
			ReportID:   reportID,
			Tolerance:  tolerance,
			AgentID:    credential.AgentID,
			ExcelBytes: excelBytes,
			PDFBytes:   pdfBytes,
		},
		h.auditEntry(r, ""),
	)
	if err != nil {
		writeError(w, err)
		return
	}
	writeSuccess(w, http.StatusOK, result, nil, nil)
}

func readAgentMonthlyMultipart(file multipart.File, maxBytes int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(file, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) == 0 {
		return nil, &apiError{
			Status:       http.StatusUnprocessableEntity,
			Code:         ErrorCodeInvalidInput,
			HumanMessage: "对账文件不能为空",
			AgentHint:    "请上传非空的 Excel/PDF 文件",
		}
	}
	if int64(len(data)) > maxBytes {
		return nil, &apiError{
			Status:       http.StatusRequestEntityTooLarge,
			Code:         ErrorCodeTooLarge,
			HumanMessage: "对账文件超过单文件大小上限",
			AgentHint:    "Excel 与 PDF 单文件各不超过 50 MiB",
		}
	}
	return data, nil
}
