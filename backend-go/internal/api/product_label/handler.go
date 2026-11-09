package product_label

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"

	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

const maxUploadBytes = 10 * 1024 * 1024 // 10MB

type Handler struct {
	generator Generator
}

func NewHandler(generator Generator) *Handler {
	return &Handler{generator: generator}
}

func (h *Handler) Generate(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)
	file, header, err := r.FormFile("file")
	if err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) || strings.Contains(err.Error(), "request body too large") {
			httpapi.WriteDetail(w, http.StatusRequestEntityTooLarge, "文件超过 10MB 上限，请压缩后再上传。")
			return
		}
		httpapi.WriteDetail(w, http.StatusBadRequest, "Missing file in multipart form")
		return
	}
	defer file.Close()

	filename := header.Filename
	if filename == "" {
		filename = "label.pdf"
	}
	if strings.ToLower(filepath.Ext(filename)) != ".pdf" {
		httpapi.WriteDetail(w, http.StatusBadRequest, "仅支持 PDF 格式的产品标签。")
		return
	}

	var buf bytes.Buffer
	lr := io.LimitReader(file, maxUploadBytes+1)
	n, err := io.Copy(&buf, lr)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "读取文件失败")
		return
	}
	if n > maxUploadBytes {
		httpapi.WriteDetail(w, http.StatusRequestEntityTooLarge, "文件超过 10MB 上限，请压缩后再上传。")
		return
	}
	pdfBytes := buf.Bytes()
	if err != nil || len(pdfBytes) == 0 {
		httpapi.WriteDetail(w, http.StatusBadRequest, "上传的文件为空。")
		return
	}
	if !bytes.HasPrefix(pdfBytes, []byte("%PDF-")) {
		httpapi.WriteDetail(w, http.StatusBadRequest, "该文件不是有效的 PDF。")
		return
	}

	text := strings.TrimSpace(r.FormValue("text"))
	if len([]rune(text)) > 200 {
		httpapi.WriteDetail(w, http.StatusBadRequest, "文案过长，请控制在 200 字以内。")
		return
	}

	rawMIC := strings.TrimSpace(strings.ToLower(r.FormValue("made_in_china")))
	madeInChina := rawMIC == "1" || rawMIC == "true" || rawMIC == "yes" || rawMIC == "on"

	if text == "" && !madeInChina {
		httpapi.WriteDetail(w, http.StatusBadRequest, "请至少填写「文案」或勾选「Made In China」。")
		return
	}

	outBytes, outFilename, err := h.generator.Generate(r.Context(), GenerateInput{
		Filename:    filename,
		PDFBytes:    pdfBytes,
		Text:        text,
		MadeInChina: madeInChina,
	})
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, err.Error())
		return
	}

	stem := strings.TrimSuffix(filename, filepath.Ext(filename))
	if outFilename == "" {
		outFilename = fmt.Sprintf("%s-labeled.pdf", stem)
	}

	escapedFilename := url.PathEscape(outFilename)
	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"; filename*=UTF-8''%s", outFilename, escapedFilename))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(outBytes)
}
