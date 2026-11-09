package store

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/csv"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const maxReconciliationFileBytes = 50 * 1024 * 1024

func reconciliationFileRoot() string {
	if root := strings.TrimSpace(os.Getenv("UPLOAD_ROOT")); root != "" {
		return root
	}
	return "backend/storage/uploads"
}

func roundReconciliation2(value float64) float64 {
	return math.Round(value*100) / 100
}

func loadReportArtifact(
	ctx context.Context,
	client *http.Client,
	filePath string,
	url string,
) ([]byte, error) {
	filePath = strings.TrimSpace(filePath)
	if filePath != "" {
		if info, err := os.Lstat(filePath); err == nil {
			if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
				return nil, errors.New("report artifact path must reference a regular file")
			}
			body, err := os.ReadFile(filePath)
			if err != nil {
				return nil, fmt.Errorf("read report artifact: %w", err)
			}
			if len(body) > maxReconciliationFileBytes {
				return nil, errors.New("report artifact exceeds size limit")
			}
			return body, nil
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("inspect report artifact: %w", err)
		}
	}

	url = strings.TrimSpace(url)
	if url == "" {
		return nil, errors.New("report artifact is missing")
	}
	if client == nil {
		client = &http.Client{Timeout: 20 * time.Second}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("build report artifact request: %w", err)
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("download report artifact: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("download report artifact: HTTP %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxReconciliationFileBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read downloaded report artifact: %w", err)
	}
	if len(body) > maxReconciliationFileBytes {
		return nil, errors.New("downloaded report artifact exceeds size limit")
	}
	return body, nil
}

func writeReconciliationFile(root string, reportID int64, extension string, data []byte) (string, error) {
	extension = strings.ToLower(strings.TrimSpace(extension))
	if extension != ".pdf" && extension != ".csv" {
		return "", fmt.Errorf("unsupported reconciliation file extension %s", extension)
	}
	root = strings.TrimSpace(root)
	if root == "" {
		return "", errors.New("reconciliation storage root is required")
	}
	absoluteRoot, err := filepath.Abs(root)
	if err != nil {
		return "", fmt.Errorf("resolve reconciliation storage root: %w", err)
	}
	if err := os.MkdirAll(absoluteRoot, 0700); err != nil {
		return "", fmt.Errorf("create reconciliation storage root: %w", err)
	}
	info, err := os.Lstat(absoluteRoot)
	if err != nil {
		return "", fmt.Errorf("inspect reconciliation storage root: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return "", errors.New("reconciliation storage root must be a directory and not a symlink")
	}
	canonicalRoot, err := filepath.EvalSymlinks(absoluteRoot)
	if err != nil {
		return "", fmt.Errorf("resolve reconciliation storage root: %w", err)
	}
	directory := filepath.Join(canonicalRoot, "reconciliation", fmt.Sprintf("report-%d", reportID))
	if err := os.MkdirAll(directory, 0700); err != nil {
		return "", fmt.Errorf("create reconciliation report directory: %w", err)
	}
	directoryInfo, err := os.Lstat(directory)
	if err != nil {
		return "", fmt.Errorf("inspect reconciliation report directory: %w", err)
	}
	if directoryInfo.Mode()&os.ModeSymlink != 0 || !directoryInfo.IsDir() {
		return "", errors.New("reconciliation report directory must not be a symlink")
	}
	tempID, err := generateTempID()
	if err != nil {
		return "", err
	}
	target := filepath.Join(directory, tempID+extension)
	if !adPathWithinRoot(canonicalRoot, target) {
		return "", errors.New("reconciliation file path escapes storage root")
	}
	file, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return "", fmt.Errorf("create reconciliation file: %w", err)
	}
	defer file.Close()
	if _, err := file.Write(data); err != nil {
		_ = os.Remove(target)
		return "", fmt.Errorf("write reconciliation file: %w", err)
	}
	if err := file.Sync(); err != nil {
		_ = os.Remove(target)
		return "", fmt.Errorf("sync reconciliation file: %w", err)
	}
	return target, nil
}

func validateTransactionCSV(data []byte) error {
	data = bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))
	reader := csv.NewReader(bytes.NewReader(data))
	reader.FieldsPerRecord = -1
	records, err := reader.ReadAll()
	if err != nil {
		return fmt.Errorf("parse transaction CSV: %w", err)
	}
	if len(records) == 0 || len(records[0]) == 0 {
		return errors.New("transaction CSV is empty")
	}
	if len(records) < 2 {
		return errors.New("transaction CSV has no data rows")
	}
	return nil
}

func buildSimpleXLSX(rows [][]string) ([]byte, error) {
	return buildSimpleXLSXSheet("数据库数据", rows)
}

func buildSimpleXLSXSheet(sheetName string, rows [][]string) ([]byte, error) {
	var sheet strings.Builder
	sheet.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`)
	sheet.WriteString(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`)
	for rowIndex, values := range rows {
		rowNumber := rowIndex + 1
		fmt.Fprintf(&sheet, `<row r="%d">`, rowNumber)
		for columnIndex, value := range values {
			ref := xlsxCellRef(rowNumber, columnIndex+1)
			fmt.Fprintf(&sheet, `<c r="%s" t="inlineStr"><is><t>%s</t></is></c>`, ref, escapeXMLText(value))
		}
		sheet.WriteString(`</row>`)
	}
	sheet.WriteString(`</sheetData></worksheet>`)

	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	writeZip := func(name, body string) error {
		header := &zip.FileHeader{Name: name, Method: zip.Deflate}
		header.SetMode(0600)
		part, err := writer.CreateHeader(header)
		if err != nil {
			return err
		}
		_, err = part.Write([]byte(body))
		return err
	}
	if err := writeZip("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`); err != nil {
		return nil, err
	}
	if err := writeZip("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`); err != nil {
		return nil, err
	}
	if err := writeZip("xl/workbook.xml", fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="%s" sheetId="1" r:id="rId1"/></sheets></workbook>`, escapeXMLText(sheetName))); err != nil {
		return nil, err
	}
	if err := writeZip("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`); err != nil {
		return nil, err
	}
	if err := writeZip("xl/worksheets/sheet1.xml", sheet.String()); err != nil {
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

func escapeXMLText(value string) string {
	var buffer bytes.Buffer
	if err := xml.EscapeText(&buffer, []byte(value)); err != nil {
		return ""
	}
	return buffer.String()
}

func sanitizeArtifactFilenamePart(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || !utf8.ValidString(value) {
		return "report"
	}
	replacer := strings.NewReplacer(
		"\\", "_",
		"/", "_",
		":", "_",
		"*", "_",
		"?", "_",
		`"`, "_",
		"<", "_",
		">", "_",
		"|", "_",
		"\r", "",
		"\n", "",
	)
	value = replacer.Replace(value)
	value = strings.Trim(value, " ._-")
	if value == "" {
		return "report"
	}
	return value
}

func snapshotNumberText(value *float64) string {
	if value == nil {
		return ""
	}
	return strconv.FormatFloat(*value, 'f', 2, 64)
}
