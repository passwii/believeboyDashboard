package store

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ad_upload"
)

type AdUploadStore struct {
	db       FullDB
	tempRoot string
}

type adProjectItem struct {
	id        int64
	name      string
	sortOrder int
}

func NewAdUploadStore(db FullDB) *AdUploadStore {
	return &AdUploadStore{
		db:       db,
		tempRoot: filepath.Join(os.TempDir(), "_ad_upload_tmp"),
	}
}

var adTempFileNamePattern = regexp.MustCompile(`^[0-9a-f]{32}\.(csv|xlsx)$`)

func parseCSVHeadersAndRows(data []byte) ([]string, [][]string, error) {
	data = bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))
	reader := csv.NewReader(bytes.NewReader(data))
	reader.LazyQuotes = true
	reader.FieldsPerRecord = -1

	records, err := reader.ReadAll()
	if err != nil {
		return nil, nil, err
	}
	if len(records) == 0 {
		return nil, nil, errors.New("empty file")
	}
	headers := make([]string, len(records[0]))
	for i, header := range records[0] {
		headers[i] = strings.TrimSpace(header)
	}
	var rows [][]string
	if len(records) > 1 {
		rows = records[1:]
	}
	return headers, rows, nil
}

func generateTempID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate temp file id: %w", err)
	}
	return hex.EncodeToString(b), nil
}

func (s *AdUploadStore) Recognize(ctx context.Context, filename string, data []byte, country, operator string, isAdmin bool) (*ad_upload.AdUploadRecognitionResponse, error) {
	if len(data) > 50*1024*1024 {
		return nil, errors.New("file exceeds upload size limit")
	}
	parsed, err := parseAdUploadData(filename, data, country)
	if err != nil {
		return nil, err
	}

	projItems, err := s.getAccessibleProjects(ctx, operator, isAdmin)
	if err != nil {
		return nil, err
	}
	projectMatch := ad_upload.AdUploadProjectMatchSummary{
		Status: "unmatched",
	}
	if len(projItems) == 1 {
		projectMatch.Status = "matched"
		projectMatch.ProjectName = &projItems[0].name
		projectMatch.CandidateProjects = []string{projItems[0].name}
		matchedBy := "operator_scope"
		projectMatch.MatchedBy = &matchedBy
	} else if len(projItems) > 1 {
		candidates := make([]string, len(projItems))
		for i, p := range projItems {
			candidates[i] = p.name
		}
		projectMatch.CandidateProjects = candidates
	}

	tempID, err := generateTempID()
	if err != nil {
		return nil, err
	}
	tempFilePath, err := s.writeAdUploadTempFile(tempID, parsed.extension, data)
	if err != nil {
		return nil, err
	}

	warnings := []string{}
	if len(parsed.rows) == 0 {
		warnings = append(warnings, "报表已识别，但当前文件没有业务明细行")
	}
	rowCount := len(parsed.rows)

	return &ad_upload.AdUploadRecognitionResponse{
		TempFileID:         filepath.Base(tempFilePath),
		OriginalFilename:   filename,
		Extension:          parsed.extension,
		ReportType:         parsed.match.spec.reportType,
		ReportLabel:        parsed.match.spec.reportLabel,
		MatchedColumns:     parsed.match.matchedColumns,
		Reason:             "规则匹配成功",
		Status:             "recognized",
		Country:            parsed.country,
		DetectedReportDate: parsed.detectedReportDate,
		DetectedStartDate:  parsed.detectedStartDate,
		DetectedEndDate:    parsed.detectedEndDate,
		ProjectMatch:       projectMatch,
		RowCountPreview:    &rowCount,
		Warnings:           warnings,
	}, nil
}

func (s *AdUploadStore) getAccessibleProjects(ctx context.Context, operator string, isAdmin bool) ([]adProjectItem, error) {
	var query string
	var args []any
	if isAdmin {
		query = `select id, project_name, coalesce(sort_order, 0) from public.projects where coalesce(is_active, true) = true order by sort_order asc, id asc`
	} else {
		operator = strings.TrimSpace(operator)
		if operator == "" {
			return []adProjectItem{}, nil
		}
		query = `
			select id, project_name, coalesce(sort_order, 0)
			from public.projects
			where coalesce(is_active, true) = true
			  and (
			    exists (
			      select 1 from unnest(regexp_split_to_array(
			        coalesce(project_operator, ''),
			        '[、,，;' || chr(10) || ']+'
			      )) as names(value)
			      where btrim(names.value) = $1
			    )
			    or exists (
			      select 1 from unnest(regexp_split_to_array(
			        coalesce(assistant_operator, ''),
			        '[、,，;' || chr(10) || ']+'
			      )) as names(value)
			      where btrim(names.value) = $1
			    )
			  )
			order by sort_order asc, id asc
		`
		args = append(args, operator)
	}
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	if rows != nil {
		defer rows.Close()
	}
	if rows == nil {
		return []adProjectItem{}, nil
	}
	var res []adProjectItem
	for rows.Next() {
		var p adProjectItem
		if err := rows.Scan(&p.id, &p.name, &p.sortOrder); err != nil {
			return nil, err
		}
		res = append(res, p)
	}
	return res, rows.Err()
}

func (s *AdUploadStore) Commit(ctx context.Context, req ad_upload.AdUploadCommitRequest, operator string, isAdmin bool) (*ad_upload.AdUploadCommitResponse, error) {
	tempData, tempPath, err := s.readAdUploadTempFile(req.TempFileID)
	if err != nil {
		return nil, err
	}

	filename := safeStr(req.OriginalFilename)
	if filename != "" {
		originalExtension, err := validateAdUploadFilename(filename)
		if err != nil {
			return nil, err
		}
		if originalExtension != strings.ToLower(filepath.Ext(req.TempFileID)) {
			return nil, errors.New("original_filename extension does not match temp_file_id")
		}
	} else {
		filename = req.TempFileID
	}
	parsed, err := parseAdUploadData(req.TempFileID, tempData, req.Country)
	if err != nil {
		return nil, err
	}
	if req.ReportType != parsed.match.spec.reportType {
		return nil, ad_upload.ErrTypeMismatch
	}

	projectName := strings.TrimSpace(safeStr(req.ProjectName))
	if projectName == "" {
		projects, err := s.getAccessibleProjects(ctx, operator, isAdmin)
		if err != nil {
			return nil, err
		}
		if len(projects) != 1 {
			return nil, errors.New("project_name is required")
		}
		projectName = projects[0].name
	}

	var projectID int64
	var projOp, assistOp *string
	err = s.db.QueryRow(ctx, `
		select id, project_operator, assistant_operator
		from public.projects
		where project_name = $1 and coalesce(is_active, true) = true
	`, projectName).Scan(&projectID, &projOp, &assistOp)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ad_upload.ErrProjectNotFound
		}
		return nil, err
	}

	if !isAdmin {
		operator = strings.TrimSpace(operator)
		if operator == "" || (!adTextContainsName(projOp, operator) && !adTextContainsName(assistOp, operator)) {
			return nil, ad_upload.ErrProjectForbidden
		}
	}

	country := parsed.country
	if country == "" {
		country = adNormalizeCountry(req.Country)
	}
	if country == "" {
		country = "US"
	}

	scopes, startDate, endDate, err := adUploadCommitScopes(req, parsed)
	if err != nil {
		return nil, err
	}
	reportLabel := parsed.match.spec.reportLabel

	if req.DryRun {
		rowCount := 0
		for _, scope := range scopes {
			rowCount += len(scope.rows)
		}
		return &ad_upload.AdUploadCommitResponse{
			ID:              0,
			ReportType:      req.ReportType,
			ReportLabel:     reportLabel,
			IngestionStatus: "skipped",
			ProjectName:     projectName,
			Country:         country,
			ReportDate:      &startDate,
			ReportStartDate: startDate,
			ReportEndDate:   endDate,
			FileID:          req.TempFileID,
			FilePath:        tempPath,
			Version:         0,
			IsCurrent:       false,
			Message:         fmt.Sprintf("已识别广告报表（dry_run）：未写入数据库，共解析 %d 行。", rowCount),
		}, nil
	}

	fileHash := sha256.Sum256(tempData)
	fileSHA := hex.EncodeToString(fileHash[:])
	fileSize := int64(len(tempData))
	recognitionPayload, err := json.Marshal(map[string]any{
		"report_type":       parsed.match.spec.reportType,
		"report_label":      parsed.match.spec.reportLabel,
		"extension":         parsed.extension,
		"country":           parsed.country,
		"matched_columns":   parsed.match.matchedColumns,
		"periodic":          parsed.match.periodic,
		"row_count_preview": len(parsed.rows),
	})
	if err != nil {
		return nil, fmt.Errorf("marshal recognition payload: %w", err)
	}
	matchedColumnsJSON, err := json.Marshal(parsed.match.matchedColumns)
	if err != nil {
		return nil, fmt.Errorf("marshal matched columns: %w", err)
	}
	warningsJSON, err := json.Marshal([]string{})
	if err != nil {
		return nil, fmt.Errorf("marshal warnings: %w", err)
	}

	type savedScope struct {
		id        int64
		version   int
		startDate string
		endDate   string
		rowCount  int
	}
	var saved []savedScope

	err = RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)

		seenTodayLogs := map[string]bool{}
		for _, scope := range scopes {
			var maxVersion int
			if err := txDB.QueryRow(ctx, `
				select coalesce(max(version), 0)
				from ad_upload_files
				where project_id = $1 and report_type = $2 and country = $3
				  and period_start_date = $4 and period_end_date = $5
			`, projectID, req.ReportType, country, scope.startDate, scope.endDate).Scan(&maxVersion); err != nil {
				return err
			}
			version := maxVersion + 1

			if _, err := txDB.Exec(ctx, `
				update ad_upload_files
				set is_current = false, superseded_at = now()
				where project_id = $1 and report_type = $2 and country = $3
				  and period_start_date = $4 and period_end_date = $5
				  and is_current = true
			`, projectID, req.ReportType, country, scope.startDate, scope.endDate); err != nil {
				return err
			}

			originalFilename := adNullableText(filename)
			var newID int64
			if err := txDB.QueryRow(ctx, `
				insert into ad_upload_files (
					project_id, project_name, report_type, report_label, country,
					report_date, period_start_date, period_end_date, version, is_current,
					upload_file_id, upload_file_path, original_filename, stored_filename,
					logical_filename, file_extension, file_size_bytes, file_sha256,
					recognition_status, ingestion_status, row_count_preview,
					matched_columns, warnings, recognition_payload, created_by
				) values (
					$1, $2, $3, $4, $5,
					$6, $7, $8, $9, true,
					$10, $11, $12, $13,
					$14, $15, $16, $17,
					'recognized', 'success', $18,
					$19::json, $20::json, $21::json, $22
				) returning id
			`, projectID, projectName, req.ReportType, reportLabel, country,
				scope.startDate, scope.startDate, scope.endDate, version,
				req.TempFileID, tempPath, originalFilename, req.TempFileID,
				filename, parsed.extension, fileSize, fileSHA,
				len(scope.rows), string(matchedColumnsJSON), string(warningsJSON),
				string(recognitionPayload), operator,
			).Scan(&newID); err != nil {
				return err
			}

			if err := insertAdDetailRows(ctx, txDB, newID, parsed, scope.rows, scope.startDate, scope.endDate); err != nil {
				return err
			}

			hasRealData := len(scope.rows) > 0
			if _, err := txDB.Exec(ctx, `
				insert into report_upload_logs (
					project_id, country, report_type, upload_date, has_real_data,
					row_count, original_filename, created_at
				) values ($1, $2, $3, $4, $5, $6, $7, now())
			`, projectID, country, req.ReportType, scope.startDate, hasRealData,
				len(scope.rows), originalFilename); err != nil {
				return err
			}

			today := time.Now().UTC().Format("2006-01-02")
			logKey := projectName + "|" + req.ReportType + "|" + country
			if scope.startDate != today && !seenTodayLogs[logKey] {
				if _, err := txDB.Exec(ctx, `
					insert into report_upload_logs (
						project_id, country, report_type, upload_date, has_real_data,
						row_count, original_filename, created_at
					) values ($1, $2, $3, $4, $5, $6, $7, now())
				`, projectID, country, req.ReportType, today, hasRealData,
					len(scope.rows), originalFilename); err != nil {
					return err
				}
				seenTodayLogs[logKey] = true
			}

			saved = append(saved, savedScope{
				id:        newID,
				version:   version,
				startDate: scope.startDate,
				endDate:   scope.endDate,
				rowCount:  len(scope.rows),
			})
		}

		return nil
	})
	if err != nil {
		return nil, err
	}

	if len(saved) == 0 {
		return nil, errors.New("no ad upload scopes were saved")
	}
	last := saved[len(saved)-1]
	message := "广告报表已保存并写入明细数据"
	if len(saved) > 1 {
		message = fmt.Sprintf("广告报表已按 %d 个日期保存并覆盖对应单日数据", len(saved))
	}
	return &ad_upload.AdUploadCommitResponse{
		ID:              last.id,
		ReportType:      req.ReportType,
		ReportLabel:     reportLabel,
		IngestionStatus: "success",
		ProjectName:     projectName,
		Country:         country,
		ReportDate:      &last.startDate,
		ReportStartDate: last.startDate,
		ReportEndDate:   last.endDate,
		FileID:          req.TempFileID,
		FilePath:        tempPath,
		Version:         last.version,
		IsCurrent:       true,
		Message:         message,
	}, nil
}

func safeStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func adTextContainsName(value *string, target string) bool {
	target = strings.TrimSpace(target)
	if target == "" || value == nil {
		return false
	}
	for _, name := range strings.FieldsFunc(*value, func(r rune) bool {
		return r == ',' || r == '、' || r == '，' || r == ';' || r == '\n' || r == '\r' || r == '\t' || r == ' '
	}) {
		if strings.TrimSpace(name) == target {
			return true
		}
	}
	return false
}

func adNullableText(value string) any {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return value
}

type adUploadScope struct {
	startDate string
	endDate   string
	rows      [][]string
}

func adUploadCommitScopes(req ad_upload.AdUploadCommitRequest, parsed *adParsedFile) ([]adUploadScope, string, string, error) {
	startDate := strings.TrimSpace(safeStr(req.ReportStartDate))
	if startDate == "" {
		startDate = safeStr(parsed.detectedStartDate)
	}
	if startDate == "" {
		startDate = strings.TrimSpace(safeStr(req.ReportDate))
	}
	endDate := strings.TrimSpace(safeStr(req.ReportEndDate))
	if endDate == "" {
		endDate = safeStr(parsed.detectedEndDate)
	}
	if endDate == "" {
		endDate = startDate
	}

	periodic := parsed.match.periodic
	if periodic {
		rowIndex, ok := parsedRowIndex(parsed.headers, "日期")
		if !ok {
			return nil, "", "", errors.New("日期 is required")
		}
		groups := map[string][][]string{}
		for _, row := range parsed.rows {
			if rowIndex >= len(row) {
				continue
			}
			parsedDate, err := parseAdDate(row[rowIndex])
			if err != nil {
				return nil, "", "", fmt.Errorf("日期 must be a valid date: %w", err)
			}
			key := parsedDate.Format("2006-01-02")
			groups[key] = append(groups[key], row)
		}
		if len(groups) == 0 {
			return nil, "", "", errors.New("日期 is required")
		}
		keys := make([]string, 0, len(groups))
		for key := range groups {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		scopes := make([]adUploadScope, 0, len(keys))
		for _, key := range keys {
			scopes = append(scopes, adUploadScope{
				startDate: key,
				endDate:   key,
				rows:      groups[key],
			})
		}
		if startDate == "" {
			startDate = keys[0]
		}
		if endDate == "" {
			endDate = keys[len(keys)-1]
		}
		return scopes, startDate, endDate, nil
	}

	if startDate == "" || endDate == "" {
		return nil, "", "", errors.New("422: report_start_date and report_end_date are required")
	}
	parsedStart, err := parseAdDate(startDate)
	if err != nil {
		return nil, "", "", fmt.Errorf("422: report_start_date must be YYYY-MM-DD: %w", err)
	}
	parsedEnd, err := parseAdDate(endDate)
	if err != nil {
		return nil, "", "", fmt.Errorf("422: report_end_date must be YYYY-MM-DD: %w", err)
	}
	if parsedStart.After(parsedEnd) {
		return nil, "", "", errors.New("422: report_start_date must be <= report_end_date")
	}
	startDate = parsedStart.Format("2006-01-02")
	endDate = parsedEnd.Format("2006-01-02")
	if !req.DryRun {
		if startDate != endDate {
			return nil, "", "", errors.New("422: 当前 ad-upload 仅支持单日报表入库：report_start_date 必须等于 report_end_date")
		}
		if reportDate := strings.TrimSpace(safeStr(req.ReportDate)); reportDate != "" {
			parsedReportDate, err := parseAdDate(reportDate)
			if err != nil {
				return nil, "", "", fmt.Errorf("422: report_date must be YYYY-MM-DD: %w", err)
			}
			if parsedReportDate.Format("2006-01-02") != startDate {
				return nil, "", "", errors.New("422: report_date 必须与识别出的单日报表日期一致")
			}
		}
	}
	return []adUploadScope{{
		startDate: startDate,
		endDate:   endDate,
		rows:      parsed.rows,
	}}, startDate, endDate, nil
}

func parsedRowIndex(headers []string, name string) (int, bool) {
	normalized := strings.ToLower(strings.TrimSpace(name))
	for i, header := range headers {
		if strings.ToLower(strings.TrimSpace(header)) == normalized {
			return i, true
		}
	}
	return 0, false
}

func (s *AdUploadStore) writeAdUploadTempFile(tempID, extension string, data []byte) (string, error) {
	root, err := canonicalAdUploadTempRoot(s.tempRoot)
	if err != nil {
		return "", err
	}
	filename := tempID + extension
	if !adTempFileNamePattern.MatchString(filename) {
		return "", errors.New("invalid temp file name")
	}
	target := filepath.Join(root, filename)
	if !adPathWithinRoot(root, target) {
		return "", errors.New("invalid temp file path")
	}
	if _, err := os.Lstat(target); !errors.Is(err, os.ErrNotExist) {
		if err != nil {
			return "", fmt.Errorf("inspect temp file: %w", err)
		}
		return "", errors.New("temp file already exists")
	}
	file, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return "", fmt.Errorf("create temp file: %w", err)
	}
	defer file.Close()
	if _, err := file.Write(data); err != nil {
		_ = os.Remove(target)
		return "", fmt.Errorf("write temp file: %w", err)
	}
	if err := file.Sync(); err != nil {
		_ = os.Remove(target)
		return "", fmt.Errorf("sync temp file: %w", err)
	}
	return target, nil
}

func (s *AdUploadStore) readAdUploadTempFile(tempID string) ([]byte, string, error) {
	root, err := canonicalAdUploadTempRoot(s.tempRoot)
	if err != nil {
		return nil, "", err
	}
	tempID = strings.TrimSpace(tempID)
	if !adTempFileNamePattern.MatchString(tempID) {
		return nil, "", errors.New("invalid temp_file_id")
	}
	target := filepath.Join(root, tempID)
	if !adPathWithinRoot(root, target) {
		return nil, "", errors.New("invalid temp_file_id path")
	}
	info, err := os.Lstat(target)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, "", errors.New("temp_file_id not found")
		}
		return nil, "", fmt.Errorf("inspect temp file: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return nil, "", errors.New("temp_file_id must reference a regular file")
	}
	canonicalTarget, err := filepath.EvalSymlinks(target)
	if err != nil {
		return nil, "", fmt.Errorf("resolve temp file: %w", err)
	}
	if !adPathWithinRoot(root, canonicalTarget) {
		return nil, "", errors.New("temp_file_id escapes temp root")
	}
	file, err := os.Open(canonicalTarget)
	if err != nil {
		return nil, "", fmt.Errorf("open temp file: %w", err)
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 50*1024*1024+1))
	if err != nil {
		return nil, "", fmt.Errorf("read temp file: %w", err)
	}
	if len(data) > 50*1024*1024 {
		return nil, "", errors.New("temp file exceeds upload size limit")
	}
	return data, canonicalTarget, nil
}

func canonicalAdUploadTempRoot(root string) (string, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return "", errors.New("temp root is required")
	}
	absoluteRoot, err := filepath.Abs(root)
	if err != nil {
		return "", fmt.Errorf("resolve temp root: %w", err)
	}
	if err := os.MkdirAll(absoluteRoot, 0700); err != nil {
		return "", fmt.Errorf("create temp dir: %w", err)
	}
	info, err := os.Lstat(absoluteRoot)
	if err != nil {
		return "", fmt.Errorf("inspect temp dir: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return "", errors.New("temp root must be a directory and not a symlink")
	}
	canonical, err := filepath.EvalSymlinks(absoluteRoot)
	if err != nil {
		return "", fmt.Errorf("resolve temp root symlinks: %w", err)
	}
	return canonical, nil
}

func adPathWithinRoot(root, target string) bool {
	canonicalRoot := filepath.Clean(root)
	canonicalTarget := filepath.Clean(target)
	return canonicalTarget == canonicalRoot ||
		strings.HasPrefix(canonicalTarget, canonicalRoot+string(filepath.Separator))
}

func (s *AdUploadStore) ListStatus(ctx context.Context, filter ad_upload.AdUploadStatusFilter) (*ad_upload.AdUploadStatusResponse, error) {
	query := `
		select f.id, f.project_name, f.report_type, f.report_label, f.country,
		       f.report_date::text, f.period_start_date::text, f.period_end_date::text,
		       f.version, f.is_current, f.recognition_status, f.ingestion_status,
		       f.original_filename, f.row_count_preview, f.updated_at::text
		from ad_upload_files f
		where f.country = $1
	`
	args := []any{filter.Country}

	if !filter.IsAdmin {
		projItems, err := s.getAccessibleProjects(ctx, filter.Operator, false)
		if err != nil {
			return nil, err
		}
		if len(projItems) == 0 {
			return &ad_upload.AdUploadStatusResponse{Country: filter.Country, Items: []ad_upload.AdUploadStatusItem{}}, nil
		}
		names := make([]string, len(projItems))
		for i, p := range projItems {
			names[i] = p.name
		}
		args = append(args, names)
		query += fmt.Sprintf(" and f.project_name = ANY($%d)", len(args))
	}

	if filter.ProjectName != nil && *filter.ProjectName != "" {
		args = append(args, *filter.ProjectName)
		query += fmt.Sprintf(" and f.project_name = $%d", len(args))
	}
	if filter.ReportType != nil && *filter.ReportType != "" {
		args = append(args, *filter.ReportType)
		query += fmt.Sprintf(" and f.report_type = $%d", len(args))
	}
	if filter.ReportDate != nil && *filter.ReportDate != "" {
		args = append(args, *filter.ReportDate)
		query += fmt.Sprintf(" and f.report_date = $%d", len(args))
	}

	limit := filter.Limit
	if limit <= 0 {
		limit = 50
	}
	args = append(args, limit)
	query += fmt.Sprintf(" order by f.updated_at desc, f.id desc limit $%d", len(args))

	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	if rows != nil {
		defer rows.Close()
	}
	if rows == nil {
		return &ad_upload.AdUploadStatusResponse{Country: filter.Country, Items: []ad_upload.AdUploadStatusItem{}}, nil
	}

	var items []ad_upload.AdUploadStatusItem
	for rows.Next() {
		var it ad_upload.AdUploadStatusItem
		var origName, repDate, updated *string
		if err := rows.Scan(
			&it.ID, &it.ProjectName, &it.ReportType, &it.ReportLabel, &it.Country,
			&repDate, &it.ReportStartDate, &it.ReportEndDate,
			&it.Version, &it.IsCurrent, &it.RecognitionStatus, &it.IngestionStatus,
			&origName, &it.RowCountPreview, &updated,
		); err != nil {
			return nil, err
		}
		it.ReportDate = repDate
		it.OriginalFilename = origName
		it.UpdatedAt = updated
		it.Warnings = []string{}
		items = append(items, it)
	}
	if items == nil {
		items = []ad_upload.AdUploadStatusItem{}
	}

	return &ad_upload.AdUploadStatusResponse{
		Country: filter.Country,
		Items:   items,
	}, nil
}
