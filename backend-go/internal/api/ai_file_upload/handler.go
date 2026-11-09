package ai_file_upload

import (
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"path/filepath"
	"strings"
	"unicode"

	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

const maxRequestBytes = 12 * 1024 * 1024

var extensionSizeLimits = map[string]int64{
	".csv":  5 * 1024 * 1024,
	".xlsx": 5 * 1024 * 1024,
	".xls":  5 * 1024 * 1024,
	".jpg":  10 * 1024 * 1024,
	".jpeg": 10 * 1024 * 1024,
	".png":  10 * 1024 * 1024,
	".pdf":  5 * 1024 * 1024,
	".txt":  2 * 1024 * 1024,
}

type Handler struct{}

func NewHandler() *Handler {
	return &Handler{}
}

type uploadResponse struct {
	FileName      string  `json:"file_name"`
	FileType      string  `json:"file_type"`
	Content       string  `json:"content"`
	Truncated     bool    `json:"truncated"`
	TruncatedNote *string `json:"truncated_note"`
}

func (handler *Handler) Upload(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBytes)
	reader, err := r.MultipartReader()
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid multipart form")
		return
	}
	var filePart *multipart.Part
	for {
		part, nextErr := reader.NextPart()
		if errors.Is(nextErr, io.EOF) {
			break
		}
		if nextErr != nil {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Invalid multipart form")
			return
		}
		if part.FormName() == "file" {
			filePart = part
			break
		}
		_ = part.Close()
	}
	if filePart == nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "Field required: file")
		return
	}
	defer filePart.Close()

	filename := sanitizeFilename(filePart.FileName())
	extension := strings.ToLower(filepath.Ext(filename))
	limit, allowed := extensionSizeLimits[extension]
	if !allowed {
		httpapi.WriteDetail(w, http.StatusBadRequest, fmt.Sprintf(
			"不支持的文件类型: %s，支持的类型：CSV、Excel、图片（jpg/png）、PDF、TXT",
			extension,
		))
		return
	}
	content, err := io.ReadAll(io.LimitReader(filePart, limit+1))
	if err != nil {
		httpapi.WriteDetail(w, http.StatusBadRequest, "读取文件失败")
		return
	}
	if int64(len(content)) > limit {
		sizeMB := float64(len(content)) / (1024 * 1024)
		limitMB := float64(limit) / (1024 * 1024)
		httpapi.WriteDetail(w, http.StatusBadRequest, fmt.Sprintf(
			"文件大小超过限制：%.1fMB > %.0fMB",
			sizeMB,
			limitMB,
		))
		return
	}
	if len(content) == 0 {
		httpapi.WriteDetail(w, http.StatusBadRequest, "上传的文件为空")
		return
	}

	fileType, extracted, truncated, note, extractErr := extractContent(extension, filename, content)
	if extractErr != nil {
		httpapi.WriteDetail(w, extractErr.status, extractErr.detail)
		return
	}
	extracted, truncatedByLength, lengthNote := limitContent(extracted)
	if truncatedByLength {
		truncated = true
		note = lengthNote
	}
	_ = httpapi.WriteJSON(w, http.StatusOK, uploadResponse{
		FileName:      filename,
		FileType:      fileType,
		Content:       extracted,
		Truncated:     truncated,
		TruncatedNote: note,
	})
}

type extractError struct {
	status int
	detail string
}

func extractContent(
	extension string,
	filename string,
	content []byte,
) (string, string, bool, *string, *extractError) {
	switch extension {
	case ".txt":
		text, truncated, note := extractText(filename, content)
		return "text", text, truncated, note, nil
	case ".csv":
		text, truncated, note, err := extractCSV(filename, content)
		return "csv", text, truncated, note, err
	case ".xlsx":
		text, truncated, note, err := extractXLSX(filename, content)
		return "excel", text, truncated, note, err
	case ".xls":
		return "excel", "", false, nil, &extractError{
			status: http.StatusUnprocessableEntity,
			detail: "Excel 解析失败：暂不支持旧版 .xls，请另存为 .xlsx",
		}
	case ".jpg", ".jpeg", ".png":
		text, err := extractImage(filename, content)
		return "image", text, false, nil, err
	case ".pdf":
		text, truncated, note, err := extractPDF(filename, content)
		return "pdf", text, truncated, note, err
	default:
		return "", "", false, nil, &extractError{
			status: http.StatusBadRequest,
			detail: "不支持的文件类型: " + extension,
		}
	}
}

func sanitizeFilename(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "未命名文件"
	}
	value = strings.ReplaceAll(value, "\\", "/")
	if index := strings.LastIndex(value, "/"); index >= 0 {
		value = value[index+1:]
	}
	var builder strings.Builder
	for _, char := range value {
		if unicode.IsControl(char) || char == '/' || char == '\\' {
			continue
		}
		builder.WriteRune(char)
		if builder.Len() >= 500*4 {
			break
		}
	}
	result := strings.TrimSpace(builder.String())
	if result == "" {
		return "未命名文件"
	}
	runes := []rune(result)
	if len(runes) > 500 {
		result = string(runes[:500])
	}
	return result
}

func limitContent(value string) (string, bool, *string) {
	runes := []rune(value)
	if len(runes) <= 50000 {
		return value, false, nil
	}
	note := "（内容已截断，仅显示前 50000 字符）"
	return string(runes[:50000]), true, &note
}
