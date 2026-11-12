package store

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/uploads"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
	"github.com/redis/go-redis/v9"
)

const (
	defaultUploadMaxBytes = 50 * 1024 * 1024
	reportTempDirectory   = "_report_upload_tmp"
)

var (
	unsafeProjectChars   = regexp.MustCompile(`[\\/:*?"<>|\x00-\x1f]`)
	unsafeNameChars      = regexp.MustCompile(`[^A-Za-z0-9._-]`)
	supportedReportTypes = map[string]bool{
		"inventory_report":         true,
		"inventory_ledger":         true,
		"inventory_ledger_summary": true,
		"inventory_ledger_detail":  true,
		"business_report":          true,
		"ad_search_term_report":    true,
		"sales_report":             true,
		"payment_report":           true,
		"return_report":            true,
	}
	statusReportTypes = []string{
		"inventory_report",
		"business_report",
		"ad_product_report",
		"ad_search_term_report",
		"sales_report",
		"payment_report",
		"return_report",
	}
)

type UploadStore struct {
	db               FullDB
	uploadRoot       string
	maxBytes         int64
	cacheInvalidator uploads.CacheInvalidator
}

func NewUploadStore(
	db FullDB,
	uploadRoot string,
	maxBytes int64,
	invalidators ...uploads.CacheInvalidator,
) *UploadStore {
	if maxBytes <= 0 {
		maxBytes = defaultUploadMaxBytes
	}
	store := &UploadStore{db: db, uploadRoot: uploadRoot, maxBytes: maxBytes}
	if len(invalidators) > 0 {
		store.cacheInvalidator = invalidators[0]
	}
	return store
}

func (store *UploadStore) PrepareGenericUpload(
	filename string,
	projectName string,
	fileType string,
) (uploads.PreparedUpload, error) {
	cleanName, _, err := safeOriginalName(filename)
	if err != nil {
		return uploads.PreparedUpload{}, err
	}
	projectSlug := safeProjectFolder(projectName)
	typeSlug := safeFileTypeFolder(fileType)
	token, err := randomToken(16)
	if err != nil {
		return uploads.PreparedUpload{}, err
	}
	storedName := token + "_" + cleanName
	relative := filepath.Join(projectSlug, typeSlug, storedName)
	localPath, err := resolveControlledPath(store.uploadRoot, relative)
	if err != nil {
		return uploads.PreparedUpload{}, err
	}
	return uploads.PreparedUpload{
		ObjectKey:        pathToSlash(filepath.Join(projectSlug, typeSlug, storedName)),
		Filename:         storedName,
		LocalPath:        localPath,
		OriginalFilename: filepath.Base(filename),
	}, nil
}

func (store *UploadStore) CommitPreparedUpload(
	_ context.Context,
	prepared uploads.PreparedUpload,
	data []byte,
	publicURL string,
) (uploads.UploadResponse, error) {
	if strings.TrimSpace(prepared.LocalPath) == "" {
		return uploads.UploadResponse{}, uploads.NewAPIError(http.StatusBadRequest, "Invalid upload path")
	}
	if int64(len(data)) > store.maxBytes {
		return uploads.UploadResponse{}, uploads.NewAPIError(http.StatusRequestEntityTooLarge, "File too large")
	}
	if strings.ToLower(filepath.Ext(prepared.LocalPath)) != ".pdf" {
		if err := writeFileControlled(store.uploadRoot, prepared.LocalPath, data); err != nil {
			return uploads.UploadResponse{}, err
		}
	}
	return uploads.UploadResponse{
		FileID:           prepared.ObjectKey,
		FilePath:         publicURL,
		Filename:         prepared.Filename,
		OriginalFilename: prepared.OriginalFilename,
		Size:             int64(len(data)),
	}, nil
}

func (store *UploadStore) SaveReportTemp(filename string, data []byte) (uploads.TempFile, error) {
	cleanName, _, err := safeOriginalName(filename)
	if err != nil {
		return uploads.TempFile{}, err
	}
	ext := strings.ToLower(filepath.Ext(cleanName))
	if ext != ".txt" && ext != ".csv" && ext != ".xlsx" {
		return uploads.TempFile{}, uploads.NewAPIError(
			http.StatusBadRequest,
			fmt.Sprintf("Unsupported extension: %s (expected: .csv, .txt, .xlsx)", ext),
		)
	}
	if int64(len(data)) > store.maxBytes {
		return uploads.TempFile{}, uploads.NewAPIError(http.StatusRequestEntityTooLarge, "File too large")
	}
	token, err := randomToken(16)
	if err != nil {
		return uploads.TempFile{}, err
	}
	storedName := token + "_" + cleanName
	relative := filepath.Join(reportTempDirectory, storedName)
	localPath, err := resolveControlledPath(store.uploadRoot, relative)
	if err != nil {
		return uploads.TempFile{}, err
	}
	if err := os.MkdirAll(filepath.Dir(localPath), 0o750); err != nil {
		return uploads.TempFile{}, err
	}
	file, err := os.OpenFile(localPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return uploads.TempFile{}, err
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		_ = os.Remove(localPath)
		return uploads.TempFile{}, err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(localPath)
		return uploads.TempFile{}, err
	}
	return uploads.TempFile{
		TempFileID:       storedName,
		OriginalFilename: filepath.Base(filename),
		Path:             localPath,
		Size:             int64(len(data)),
	}, nil
}

// ResolveUploadTempPath rejects absolute paths, traversal, and symlinks that
// escape the controlled upload root.
func (store *UploadStore) ResolveUploadTempPath(tempFileID string) (string, error) {
	tempFileID = strings.TrimSpace(tempFileID)
	if tempFileID == "" || filepath.IsAbs(tempFileID) ||
		filepath.Base(tempFileID) != tempFileID ||
		strings.ContainsAny(tempFileID, `/\`) || tempFileID == "." || tempFileID == ".." {
		return "", uploads.NewAPIError(http.StatusBadRequest, "Invalid temp_file_id")
	}
	path, err := resolveControlledPath(
		store.uploadRoot,
		filepath.Join(reportTempDirectory, tempFileID),
	)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", uploads.NewAPIError(http.StatusNotFound, "temp_file_id not found")
	}
	root, err := resolveRootForContainment(store.uploadRoot)
	if err != nil {
		return "", err
	}
	if _, err := relativeInside(root, resolved); err != nil {
		return "", uploads.NewAPIError(http.StatusBadRequest, "Invalid temp_file_id")
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.Mode().IsRegular() {
		return "", uploads.NewAPIError(http.StatusNotFound, "temp_file_id not found")
	}
	return resolved, nil
}

func (store *UploadStore) RecognizeReport(
	ctx context.Context,
	saved uploads.TempFile,
	country string,
	operator string,
	isAdmin bool,
) (uploads.RecognitionResponse, error) {
	country = normalizeStoreCountry(country)
	if country == "" {
		return uploads.RecognitionResponse{}, uploads.NewAPIError(http.StatusBadRequest, "country must be one of: DE, UK, US")
	}
	path, err := store.ResolveUploadTempPath(saved.TempFileID)
	if err != nil {
		return uploads.RecognitionResponse{}, err
	}
	allowed, err := store.allowedProjectNames(ctx, operator, isAdmin)
	if err != nil {
		return uploads.RecognitionResponse{}, err
	}
	result, err := recognizeLocalFile(path, saved.OriginalFilename, country)
	if err != nil {
		var recognitionErr *recognitionError
		if errors.As(err, &recognitionErr) {
			return recognitionFailure(saved, country, recognitionErr.Error(), "error"), nil
		}
		return uploads.RecognitionResponse{}, err
	}
	if result == nil {
		return recognitionFailure(saved, country, "文件类型无法识别", "error"), nil
	}
	payload, err := store.buildProjectMatch(ctx, result, country, allowed)
	if err != nil {
		result.ProjectMatch = uploads.ProjectMatchSummary{
			Status: "manual", Message: uploadString("项目匹配失败: " + err.Error()),
			CandidateProjects: []string{}, MatchedValues: []string{},
		}
	} else {
		result.ProjectMatch = payload
	}
	result.TempFileID = saved.TempFileID
	result.OriginalFilename = saved.OriginalFilename
	result.Extension = strings.ToLower(filepath.Ext(path))
	result.Status = "recognized"
	if result.ReportType == "" {
		result.ReportType = "unknown"
	}
	if result.DetectedCountries == nil {
		result.DetectedCountries = []string{}
	}
	if result.MatchedColumns == nil {
		result.MatchedColumns = []string{}
	}
	if result.Warnings == nil {
		result.Warnings = []string{}
	}
	if result.ProjectMatch.CandidateProjects == nil {
		result.ProjectMatch.CandidateProjects = []string{}
	}
	if result.ProjectMatch.MatchedValues == nil {
		result.ProjectMatch.MatchedValues = []string{}
	}
	return *result, nil
}

func (store *UploadStore) CommitReport(
	ctx context.Context,
	payload uploads.CommitRequest,
	operator string,
	isAdmin bool,
) (uploads.CommitResponse, error) {
	reportType := normalizeReportType(payload.ReportType)
	if !supportedReportTypes[reportType] {
		return uploads.CommitResponse{}, uploads.NewAPIError(
			http.StatusBadRequest,
			fmt.Sprintf("Unsupported report_type: %s", reportType),
		)
	}
	country := normalizeStoreCountry(payload.Country)
	if country == "" {
		return uploads.CommitResponse{}, uploads.NewAPIError(http.StatusBadRequest, "country must be one of: DE, UK, US")
	}
	projectName := trimmedValue(payload.ProjectName)
	allowedProjects, err := store.allowedProjectNames(ctx, operator, isAdmin)
	if err != nil {
		return uploads.CommitResponse{}, err
	}

	var recognition *uploads.RecognitionResponse
	var projectInfo projectRow
	if reportType != "ad_search_term_report" {
		temp := uploads.TempFile{
			TempFileID:       payload.TempFileID,
			OriginalFilename: trimmedValue(payload.OriginalFilename),
		}
		if temp.OriginalFilename == "" {
			temp.OriginalFilename = payload.TempFileID
		}
		path, resolveErr := store.ResolveUploadTempPath(payload.TempFileID)
		if resolveErr != nil {
			return uploads.CommitResponse{}, resolveErr
		}
		temp.Path = path
		recognized, err := store.RecognizeReport(ctx, temp, country, operator, isAdmin)
		if err != nil {
			return uploads.CommitResponse{}, err
		}
		if recognized.Status != "recognized" {
			return uploads.CommitResponse{}, uploads.NewAPIError(
				http.StatusUnprocessableEntity,
				"文件识别失败，无法确认项目归属："+recognized.Reason,
			)
		}
		if !recognitionMatchesDeclared(reportType, recognized.ReportType) {
			return uploads.CommitResponse{}, uploads.NewAPIError(
				http.StatusBadRequest,
				"report_type does not match recognized report",
			)
		}
		if reportTypeRequiresCountryMatch(reportType) && recognized.Country != country &&
			!isMultiCountryReport(reportType, recognized.DetectedCountries) {
			return uploads.CommitResponse{}, uploads.NewAPIError(
				http.StatusBadRequest,
				fmt.Sprintf("文件站点（%s）与所选站点（%s）不一致，请确认后重新上传到对应站点", recognized.Country, country),
			)
		}
		recognition = &recognized
		if projectName == "" {
			if recognized.ProjectMatch.Status != "matched" || recognized.ProjectMatch.ProjectName == nil {
				return uploads.CommitResponse{}, uploads.NewAPIError(
					http.StatusUnprocessableEntity,
					"文件未匹配到唯一项目，请先确认文件归属后再入库",
				)
			}
			projectName = *recognized.ProjectMatch.ProjectName
		} else if recognized.ProjectMatch.Status != "matched" ||
			recognized.ProjectMatch.ProjectName == nil ||
			*recognized.ProjectMatch.ProjectName != projectName {
			return uploads.CommitResponse{}, uploads.NewAPIError(
				http.StatusUnprocessableEntity,
				"文件匹配项目与当前选择不一致，请确认后重新选择",
			)
		}
	} else if projectName == "" {
		return uploads.CommitResponse{}, uploads.NewAPIError(
			http.StatusUnprocessableEntity,
			"project_name is required for ad_search_term_report",
		)
	}

	var present bool
	projectInfo, present = allowedProjects[projectName]
	if !present {
		return uploads.CommitResponse{}, uploads.NewAPIError(http.StatusForbidden, "无权限访问该项目")
	}

	originalFilename := trimmedValue(payload.OriginalFilename)
	if originalFilename == "" {
		originalFilename = payload.TempFileID
	}
	finalFile, err := store.finalizeReportTemp(
		payload.TempFileID,
		originalFilename,
		projectName,
		reportType,
	)
	if err != nil {
		return uploads.CommitResponse{}, err
	}

	if payload.DryRun {
		return uploads.CommitResponse{
			ReportType:      reportType,
			Status:          "skipped",
			ProjectName:     uploadString(projectName),
			Country:         country,
			ReportDate:      trimmedPointer(payload.ReportDate),
			ReportStartDate: trimmedPointer(payload.ReportStartDate),
			ReportEndDate:   trimmedPointer(payload.ReportEndDate),
			FileID:          finalFile.FileID,
			FilePath:        finalFile.FilePath,
			Message: fmt.Sprintf(
				"已识别为报表（dry_run）：未写入 analysis_source_files。文件已暂存，临时文件 ID=%s。",
				finalFile.FileID,
			),
			DuplicateWarnings: []uploads.DuplicateWarning{},
		}, nil
	}

	duplicates, err := store.findDuplicateWarnings(ctx, finalFile.LocalPath)
	if err != nil {
		return uploads.CommitResponse{}, err
	}
	base := uploads.CommitResponse{
		ReportType: reportType, ProjectName: uploadString(projectName), Country: country,
		ReportDate:      trimmedPointer(payload.ReportDate),
		ReportStartDate: trimmedPointer(payload.ReportStartDate),
		ReportEndDate:   trimmedPointer(payload.ReportEndDate),
		FileID:          finalFile.FileID, FilePath: finalFile.FilePath,
		DuplicateWarnings: duplicates,
	}

	persisted, err := store.persistReport(ctx, payload, projectInfo, finalFile, recognition, operator)
	if err != nil {
		return uploads.CommitResponse{}, err
	}
	base.Status = persisted.Status
	base.PersistedSourceID = persisted.SourceID
	base.PersistedTable = persisted.Table
	base.Message = persisted.Message
	base.RowsIngested = persisted.RowsIngested
	if persisted.ReportStartDate != nil {
		base.ReportStartDate = persisted.ReportStartDate
	}
	if persisted.ReportEndDate != nil {
		base.ReportEndDate = persisted.ReportEndDate
	}
	if base.DuplicateWarnings == nil {
		base.DuplicateWarnings = []uploads.DuplicateWarning{}
	}
	return base, nil
}

func (store *UploadStore) ListReportStatus(
	ctx context.Context,
	reportDate *string,
	operator string,
	country string,
	isAdmin bool,
) (uploads.StatusResponse, error) {
	country = normalizeStoreCountry(country)
	if country == "" {
		return uploads.StatusResponse{}, uploads.NewAPIError(http.StatusBadRequest, "country must be one of: DE, UK, US")
	}
	var targetDate pgtype.Date
	if reportDate != nil && strings.TrimSpace(*reportDate) != "" {
		parsed, err := time.Parse("2006-01-02", strings.TrimSpace(*reportDate))
		if err != nil {
			return uploads.StatusResponse{}, uploads.NewAPIError(http.StatusBadRequest, "report_date must be YYYY-MM-DD")
		}
		targetDate = pgtype.Date{Time: parsed, Valid: true}
	}
	projects, err := store.listAllowedProjects(ctx, operator, isAdmin)
	if err != nil {
		return uploads.StatusResponse{}, err
	}
	if len(projects) == 0 {
		return uploads.StatusResponse{Country: country, Items: []uploads.ProjectStatusItem{}}, nil
	}

	projectIDs := make([]int64, 0, len(projects))
	projectMap := make(map[int64]projectRow, len(projects))
	for _, project := range projects {
		projectIDs = append(projectIDs, project.ID)
		projectMap[project.ID] = project
	}
	eligible, err := store.eligibleProjectNames(ctx, country)
	if err != nil {
		return uploads.StatusResponse{}, err
	}
	if len(eligible) > 0 {
		filtered := projectIDs[:0]
		for _, id := range projectIDs {
			if eligible[projectMap[id].Name] {
				filtered = append(filtered, id)
			}
		}
		projectIDs = filtered
	} else {
		projectIDs = nil
	}
	if len(projectIDs) == 0 {
		return uploads.StatusResponse{Country: country, Items: []uploads.ProjectStatusItem{}}, nil
	}

	statusByProject := make(map[int64]map[string]uploads.StatusCell, len(projectIDs))
	for _, projectID := range projectIDs {
		cells := make(map[string]uploads.StatusCell, len(statusReportTypes))
		for _, reportType := range statusReportTypes {
			cells[reportType] = uploads.StatusCell{ReportType: reportType, Status: "missing"}
		}
		statusByProject[projectID] = cells
	}
	seen := map[string]bool{}
	rows, err := store.querySourceStatuses(ctx, projectIDs, country, targetDate)
	if err != nil {
		return uploads.StatusResponse{}, err
	}
	for _, row := range rows {
		key := strconv.FormatInt(row.ProjectID, 10) + ":" + row.ReportType
		if seen[key] {
			continue
		}
		seen[key] = true
		display := row.DisplayDate(targetDate)
		start, end := row.PeriodDates()
		sourceTable := "analysis_source_files"
		message := "当前版本"
		if targetDate.Valid {
			message = "当日已入库"
			if row.ReportType == "payment_report" && row.ReportDate.Valid == false &&
				row.PeriodStart.Valid && row.PeriodEnd.Valid &&
				dateWithin(targetDate, row.PeriodStart, row.PeriodEnd) {
				message = "历史周期数据已入库"
			}
		}
		statusByProject[row.ProjectID][row.ReportType] = uploads.StatusCell{
			ReportType:       row.ReportType,
			Status:           "available",
			DisplayDate:      display,
			ReportStartDate:  start,
			ReportEndDate:    end,
			SourceTable:      &sourceTable,
			UpdatedAt:        optionalTimestampString(row.UpdatedAt),
			OriginalFilename: row.OriginalFilename,
			Message:          &message,
		}
	}

	fileOnlyRows, err := store.queryFileOnlyStatuses(ctx, projectIDs, country, targetDate)
	if err != nil {
		return uploads.StatusResponse{}, err
	}
	for _, row := range fileOnlyRows {
		if _, exists := statusByProject[row.ProjectID]; !exists {
			continue
		}
		display := row.ReportDate.Time.Format("2006-01-02")
		start, end := display, display
		sourceTable := "report_upload_statuses"
		message := "仅保存文件，未拆分明细"
		if targetDate.Valid {
			message = "当日仅保存文件，未拆分明细"
		}
		statusByProject[row.ProjectID][row.ReportType] = uploads.StatusCell{
			ReportType:       row.ReportType,
			Status:           "saved_only",
			DisplayDate:      &display,
			ReportStartDate:  &start,
			ReportEndDate:    &end,
			SourceTable:      &sourceTable,
			UpdatedAt:        optionalTimestampString(row.UpdatedAt),
			OriginalFilename: row.OriginalFilename,
			Message:          &message,
		}
	}

	sort.Slice(projectIDs, func(i, j int) bool {
		left, right := projectMap[projectIDs[i]], projectMap[projectIDs[j]]
		if left.SortOrder != right.SortOrder {
			return left.SortOrder < right.SortOrder
		}
		return left.Name < right.Name
	})
	items := make([]uploads.ProjectStatusItem, 0, len(projectIDs))
	for _, projectID := range projectIDs {
		items = append(items, uploads.ProjectStatusItem{
			ProjectID:   projectID,
			ProjectName: projectMap[projectID].Name,
			Statuses:    statusByProject[projectID],
		})
	}
	return uploads.StatusResponse{Country: country, Items: items}, nil
}

type projectRow struct {
	ID        int64
	Name      string
	SortOrder int
}

func (store *UploadStore) allowedProjectNames(
	ctx context.Context,
	operator string,
	isAdmin bool,
) (map[string]projectRow, error) {
	projects, err := store.listAllowedProjects(ctx, operator, isAdmin)
	if err != nil {
		return nil, err
	}
	result := make(map[string]projectRow, len(projects))
	for _, project := range projects {
		result[project.Name] = project
	}
	return result, nil
}

func (store *UploadStore) listAllowedProjects(
	ctx context.Context,
	operator string,
	isAdmin bool,
) ([]projectRow, error) {
	operator = strings.TrimSpace(operator)
	if !isAdmin && operator == "" {
		return []projectRow{}, nil
	}
	rows, err := store.db.Query(
		ctx,
		`SELECT id, project_name, coalesce(sort_order, 0)
		 FROM public.projects
		 WHERE coalesce(is_active, true)
		   AND (
		     $1::boolean
		     OR (
		       $2::text <> ''
		       AND (
		         exists (
		           select 1
		           from unnest(regexp_split_to_array(
		             coalesce(project_operator, ''),
		             '[、,，;' || chr(10) || ']+'
		           )) as names(value)
		           where btrim(names.value) = $2
		         )
		         OR exists (
		           select 1
		           from unnest(regexp_split_to_array(
		             coalesce(assistant_operator, ''),
		             '[、,，;' || chr(10) || ']+'
		           )) as names(value)
		           where btrim(names.value) = $2
		         )
		       )
		     )
		   )
		 ORDER BY coalesce(sort_order, 0), project_name`,
		isAdmin,
		operator,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	projects := make([]projectRow, 0)
	for rows.Next() {
		var project projectRow
		if err := rows.Scan(&project.ID, &project.Name, &project.SortOrder); err != nil {
			return nil, err
		}
		projects = append(projects, project)
	}
	return projects, rows.Err()
}

func (store *UploadStore) eligibleProjectNames(
	ctx context.Context,
	country string,
) (map[string]bool, error) {
	rows, err := store.db.Query(
		ctx,
		`SELECT DISTINCT project_name
		 FROM public.product_costs
		 WHERE country = $1
		   AND is_active IS TRUE
		   AND nullif(trim(project_name), '') IS NOT NULL`,
		country,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	names := make(map[string]bool)
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		names[name] = true
	}
	return names, rows.Err()
}

func (store *UploadStore) finalizeReportTemp(
	tempFileID string,
	originalFilename string,
	projectName string,
	reportType string,
) (uploads.PreparedReportFile, error) {
	sourcePath, err := store.ResolveUploadTempPath(tempFileID)
	if err != nil {
		return uploads.PreparedReportFile{}, err
	}
	cleanName, _, err := safeOriginalName(originalFilename)
	if err != nil {
		return uploads.PreparedReportFile{}, err
	}
	token, err := randomToken(16)
	if err != nil {
		return uploads.PreparedReportFile{}, err
	}
	storedName := token + "_" + cleanName
	relative := filepath.Join(
		safeProjectFolder(projectName),
		safeFileTypeFolder(reportType),
		storedName,
	)
	destination, err := resolveControlledPath(store.uploadRoot, relative)
	if err != nil {
		return uploads.PreparedReportFile{}, err
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0o750); err != nil {
		return uploads.PreparedReportFile{}, err
	}
	source, err := os.Open(sourcePath)
	if err != nil {
		return uploads.PreparedReportFile{}, err
	}
	defer source.Close()
	info, err := source.Stat()
	if err != nil {
		return uploads.PreparedReportFile{}, err
	}
	if info.Size() > store.maxBytes {
		return uploads.PreparedReportFile{}, uploads.NewAPIError(http.StatusRequestEntityTooLarge, "File too large")
	}
	target, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return uploads.PreparedReportFile{}, err
	}
	written, copyErr := io.Copy(target, source)
	closeErr := target.Close()
	if copyErr != nil || closeErr != nil {
		_ = os.Remove(destination)
		if copyErr != nil {
			return uploads.PreparedReportFile{}, copyErr
		}
		return uploads.PreparedReportFile{}, closeErr
	}
	return uploads.PreparedReportFile{
		FileID:           storedName,
		FilePath:         destination,
		Filename:         storedName,
		OriginalFilename: filepath.Base(originalFilename),
		Size:             written,
		LocalPath:        destination,
	}, nil
}

func (store *UploadStore) findDuplicateWarnings(
	ctx context.Context,
	path string,
) ([]uploads.DuplicateWarning, error) {
	hash, err := fileSHA256(path)
	if err != nil {
		return nil, err
	}
	rows, err := store.db.Query(
		ctx,
		`SELECT p.project_name,
		        CASE
		          WHEN b.id IS NOT NULL
		          THEN 'inventory_ledger_' || b.file_kind
		          ELSE f.report_type
		        END,
		        f.country,
		        coalesce(f.period_start_date, f.report_date),
		        f.period_end_date, f.original_filename
		 FROM public.analysis_source_files f
		 JOIN public.projects p ON p.id = f.project_id
		 LEFT JOIN public.inventory_ledger_ingest_batch b
		   ON b.project_id = f.project_id
		  AND b.file_hash = f.file_sha256
		  AND b.source_filename = f.original_filename
		  AND b.report_month = f.period_start_date
		 WHERE f.file_sha256 = $1
		 ORDER BY f.created_at DESC
		 LIMIT 20`,
		hash,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	warnings := make([]uploads.DuplicateWarning, 0)
	for rows.Next() {
		var projectName, reportType, country string
		var start, end pgtype.Date
		var originalFilename *string
		if err := rows.Scan(
			&projectName, &reportType, &country, &start, &end, &originalFilename,
		); err != nil {
			return nil, err
		}
		period := "N/A"
		if start.Valid && end.Valid {
			period = start.Time.Format("2006-01-02") + " ~ " + end.Time.Format("2006-01-02")
		} else if start.Valid {
			period = start.Time.Format("2006-01-02")
		}
		warnings = append(warnings, uploads.DuplicateWarning{
			ProjectName:      projectName,
			ReportType:       reportType,
			Country:          country,
			Period:           period,
			OriginalFilename: originalFilename,
		})
	}
	return warnings, rows.Err()
}

type sourceStatusRow struct {
	ID               int64
	ProjectID        int64
	ReportType       string
	ReportDate       pgtype.Date
	PeriodStart      pgtype.Date
	PeriodEnd        pgtype.Date
	UpdatedAt        pgtype.Timestamptz
	OriginalFilename *string
}

func (row sourceStatusRow) DisplayDate(target pgtype.Date) *string {
	if target.Valid {
		value := target.Time.Format("2006-01-02")
		return &value
	}
	if row.ReportDate.Valid {
		value := row.ReportDate.Time.Format("2006-01-02")
		return &value
	}
	if row.PeriodEnd.Valid {
		value := row.PeriodEnd.Time.Format("2006-01-02")
		return &value
	}
	return nil
}

func (row sourceStatusRow) PeriodDates() (*string, *string) {
	start := row.ReportDate
	if !start.Valid {
		start = row.PeriodStart
	}
	end := row.ReportDate
	if !end.Valid {
		end = row.PeriodEnd
	}
	var startValue, endValue *string
	if start.Valid {
		value := start.Time.Format("2006-01-02")
		startValue = &value
	}
	if end.Valid {
		value := end.Time.Format("2006-01-02")
		endValue = &value
	}
	return startValue, endValue
}

func (store *UploadStore) querySourceStatuses(
	ctx context.Context,
	projectIDs []int64,
	country string,
	target pgtype.Date,
) ([]sourceStatusRow, error) {
	query := `
SELECT f.id, f.project_id, f.report_type, f.report_date,
       f.period_start_date, f.period_end_date, f.updated_at,
       f.original_filename
FROM public.analysis_source_files f
WHERE f.project_id = ANY($1)
  AND f.country = $2
  AND NOT EXISTS (
    SELECT 1
    FROM public.inventory_ledger_ingest_batch b
    WHERE b.project_id = f.project_id
      AND b.file_hash = f.file_sha256
      AND b.source_filename = f.original_filename
      AND b.report_month = f.period_start_date
  )`
	args := []any{projectIDs, country}
	if target.Valid {
		query += `
  AND (
    f.report_date = $3
    OR (
      f.report_type = 'payment_report'
      AND f.report_date IS NULL
      AND f.period_start_date IS NOT NULL
      AND f.period_end_date IS NOT NULL
      AND f.period_start_date <= $3
      AND f.period_end_date >= $3
    )
  )
ORDER BY f.updated_at DESC, f.id DESC`
		args = append(args, target)
	} else {
		query += `
  AND f.is_current IS TRUE
ORDER BY f.updated_at DESC, f.id DESC`
	}
	rows, err := store.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]sourceStatusRow, 0)
	for rows.Next() {
		var item sourceStatusRow
		if err := rows.Scan(
			&item.ID, &item.ProjectID, &item.ReportType, &item.ReportDate,
			&item.PeriodStart, &item.PeriodEnd, &item.UpdatedAt,
			&item.OriginalFilename,
		); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

type fileOnlyStatusRow struct {
	ProjectID        int64
	ReportType       string
	ReportDate       pgtype.Date
	UpdatedAt        pgtype.Timestamptz
	OriginalFilename *string
}

func (store *UploadStore) queryFileOnlyStatuses(
	ctx context.Context,
	projectIDs []int64,
	country string,
	target pgtype.Date,
) ([]fileOnlyStatusRow, error) {
	query := `
SELECT project_id, report_type, report_date, updated_at, original_filename
FROM public.report_upload_statuses
WHERE project_id = ANY($1)
  AND country = $2`
	args := []any{projectIDs, country}
	if target.Valid {
		query += ` AND report_date = $3`
		args = append(args, target)
	}
	rows, err := store.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]fileOnlyStatusRow, 0)
	for rows.Next() {
		var item fileOnlyStatusRow
		if err := rows.Scan(
			&item.ProjectID, &item.ReportType, &item.ReportDate,
			&item.UpdatedAt, &item.OriginalFilename,
		); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func dateWithin(target, start, end pgtype.Date) bool {
	if !target.Valid || !start.Valid || !end.Valid {
		return false
	}
	t := target.Time.Truncate(24 * time.Hour)
	return !t.Before(start.Time.Truncate(24*time.Hour)) &&
		!t.After(end.Time.Truncate(24*time.Hour))
}

func optionalTimestampString(value pgtype.Timestamptz) *string {
	if !value.Valid {
		return nil
	}
	formatted := httpapi.Timestamp(value.Time)
	return &formatted
}

func safeOriginalName(filename string) (string, string, error) {
	filename = filepath.Base(strings.TrimSpace(filename))
	if filename == "" || filename == "." || filename == ".." {
		return "", "", uploads.NewAPIError(http.StatusBadRequest, "Missing filename")
	}
	ext := strings.ToLower(filepath.Ext(filename))
	stem := strings.TrimSuffix(filename, filepath.Ext(filename))
	stem = unsafeNameChars.ReplaceAllString(stem, "-")
	stem = strings.Trim(stem, "._-")
	if stem == "" {
		stem = "file"
	}
	if len(stem) > 80 {
		stem = stem[:80]
	}
	return stem + ext, ext, nil
}

func safeProjectFolder(projectName string) string {
	raw := strings.TrimSpace(projectName)
	if raw == "" {
		return "project"
	}
	safe := unsafeProjectChars.ReplaceAllString(raw, "-")
	safe = strings.Join(strings.Fields(safe), "-")
	safe = strings.Trim(safe, " .-")
	if safe == "" || safe == "." || safe == ".." {
		safe = slugASCII(raw)
	}
	if safe == "" {
		safe = "project"
	}
	runes := []rune(safe)
	if len(runes) > 80 {
		safe = string(runes[:80])
	}
	return safe
}

func safeFileTypeFolder(fileType string) string {
	safe := slugASCII(strings.ToLower(normalizeReportType(fileType)))
	if safe == "" {
		return "file"
	}
	if len(safe) > 50 {
		safe = safe[:50]
	}
	return safe
}

func slugASCII(value string) string {
	var builder strings.Builder
	lastDash := false
	for _, r := range strings.ToLower(value) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			builder.WriteRune(r)
			lastDash = false
			continue
		}
		if !lastDash {
			builder.WriteByte('-')
			lastDash = true
		}
	}
	return strings.Trim(builder.String(), "-")
}

func resolveControlledPath(root string, relative string) (string, error) {
	if strings.TrimSpace(root) == "" {
		return "", errors.New("upload root is empty")
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	if filepath.IsAbs(relative) {
		return "", errors.New("relative path required")
	}
	candidate := filepath.Join(absRoot, filepath.FromSlash(relative))
	if _, err := relativeInside(absRoot, candidate); err != nil {
		return "", err
	}
	return candidate, nil
}

func relativeInside(root string, candidate string) (string, error) {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	absCandidate, err := filepath.Abs(candidate)
	if err != nil {
		return "", err
	}
	relative, err := filepath.Rel(absRoot, absCandidate)
	if err != nil {
		return "", err
	}
	if relative == "." || filepath.IsAbs(relative) || relative == ".." ||
		strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", errors.New("path escapes controlled root")
	}
	return relative, nil
}

func resolveRootForContainment(root string) (string, error) {
	absolute, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", err
	}
	return resolved, nil
}

func writeFileControlled(root, path string, data []byte) error {
	if _, err := relativeInside(root, path); err != nil {
		return uploads.NewAPIError(http.StatusBadRequest, "Invalid upload path")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

func randomToken(bytesCount int) (string, error) {
	raw := make([]byte, bytesCount)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate random upload token: %w", err)
	}
	return hex.EncodeToString(raw), nil
}

func pathToSlash(value string) string {
	return filepath.ToSlash(value)
}

func fileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func normalizeStoreCountry(value string) string {
	switch strings.ToUpper(strings.TrimSpace(value)) {
	case "", "US", "USA", "美国", "美国站":
		return "US"
	case "DE", "GERMANY", "德国", "德国站":
		return "DE"
	case "UK", "GB", "UNITED KINGDOM", "英国", "英国站":
		return "UK"
	default:
		return ""
	}
}

func normalizeReportType(value string) string {
	switch strings.TrimSpace(value) {
	case "ad_report":
		return "ad_product_report"
	default:
		return strings.TrimSpace(value)
	}
}

func recognitionMatchesDeclared(declared, recognized string) bool {
	if declared == recognized {
		return true
	}
	return declared == "inventory_ledger" &&
		(recognized == "inventory_ledger_summary" || recognized == "inventory_ledger_detail")
}

func reportTypeRequiresCountryMatch(reportType string) bool {
	switch reportType {
	case "sales_report", "inventory_report", "business_report",
		"ad_product_report", "payment_report", "return_report":
		return true
	default:
		return false
	}
}

func isMultiCountryReport(reportType string, countries []string) bool {
	return (reportType == "sales_report" || reportType == "return_report") && len(countries) > 1
}

func trimmedPointer(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func trimmedValue(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}

func uploadString(value string) *string {
	return &value
}

type recognitionError struct {
	Message string
}

func (err *recognitionError) Error() string { return err.Message }

type tableData struct {
	Headers []string
	Rows    [][]string
}

func recognizeLocalFile(
	path string,
	originalFilename string,
	country string,
) (*uploads.RecognitionResponse, error) {
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".txt":
		table, err := readTable(path, '\t')
		if err != nil {
			return nil, nil
		}
		lowers := normalizedHeaders(table.Headers)
		switch {
		case hasHeaders(lowers, "snapshot-date", "sku", "asin"):
			return recognizeInventory(table, country), nil
		case hasHeaders(lowers, "purchase-date", "sku", "asin"):
			return recognizeSales(table, country), nil
		case hasHeaders(lowers, "return-date", "sku"):
			return recognizeReturn(table, country), nil
		default:
			return nil, nil
		}
	case ".csv":
		raw, err := os.ReadFile(path)
		if err != nil {
			return nil, nil
		}
		text := decodeText(raw)
		if containsPaymentMarker(text) || strings.Contains(strings.ToLower(originalFilename), "transaction") {
			table, err := readPaymentTable(path, country)
			if err != nil {
				return nil, nil
			}
			return recognizePayment(table, country)
		}
		table, err := readTable(path, ',')
		if err != nil {
			return nil, nil
		}
		lowers := normalizedHeaders(table.Headers)
		if isPaymentTable(lowers) {
			return recognizePayment(table, country)
		}
		if ledger, err := recognizeLedger(table, country, originalFilename); err != nil {
			return nil, err
		} else if ledger != nil {
			return ledger, nil
		}
		if hasAnyUploadHeader(lowers,
			"（子）asin", "(子)asin", "子asin", "asin", "(child) asin", "(parent) asin",
		) {
			return recognizeBusiness(table, country, originalFilename), nil
		}
		return nil, nil
	default:
		return nil, nil
	}
}

func recognitionFailure(
	saved uploads.TempFile,
	country string,
	reason string,
	status string,
) uploads.RecognitionResponse {
	return uploads.RecognitionResponse{
		TempFileID:        saved.TempFileID,
		OriginalFilename:  saved.OriginalFilename,
		Extension:         strings.ToLower(filepath.Ext(saved.OriginalFilename)),
		ReportType:        "unknown",
		MatchedColumns:    []string{},
		Reason:            reason,
		Status:            status,
		Country:           country,
		DetectedCountries: []string{},
		DateInputMode:     "single_manual",
		ProjectMatch: uploads.ProjectMatchSummary{
			Status:            "manual",
			Message:           uploadString("未识别成功"),
			CandidateProjects: []string{},
			MatchedValues:     []string{},
		},
		Warnings: []string{},
	}
}

func recognizeInventory(table tableData, country string) *uploads.RecognitionResponse {
	lowers := normalizedHeaders(table.Headers)
	date := firstDateValue(table, lowers, "snapshot-date", country)
	detectedCountry := detectTableCountry(table, lowers, country)
	warnings := countryWarnings(detectedCountry, country, "")
	mode := "single_manual"
	if date != nil {
		mode = "single_detected"
	}
	rows := len(table.Rows)
	return &uploads.RecognitionResponse{
		ReportType:        "inventory_report",
		MatchedColumns:    []string{"snapshot-date", "sku", "asin"},
		Reason:            "命中 snapshot-date / sku / asin",
		Country:           detectedCountry,
		DetectedCountries: []string{},
		DateInputMode:     mode,
		DetectedDate:      date,
		ProjectMatch:      emptyProjectMatch(),
		RowCountPreview:   &rows,
		Warnings:          warnings,
		Identifiers:       extractColumnValues(table, lowers, "sku"),
		MatchBy:           "sku",
	}
}

func recognizeSales(table tableData, country string) *uploads.RecognitionResponse {
	lowers := normalizedHeaders(table.Headers)
	dates := dateRange(table, lowers, "purchase-date", country)
	detectedCountries := detectSalesCountries(table, lowers, country)
	primary := singleCountry(append(detectedCountries, country))
	warnings := []string{}
	if len(detectedCountries) > 0 && !containsString(detectedCountries, country) {
		warnings = append(warnings, fmt.Sprintf(
			"文件内 sales-channel 为 %s，当前按所选站点 %s 处理",
			strings.Join(detectedCountries, "/"),
			country,
		))
	}
	mode := "single_manual"
	if dates.start != nil && dates.end != nil {
		if *dates.start != *dates.end {
			mode = "multi_auto"
		} else {
			mode = "single_detected"
		}
	}
	rows := len(table.Rows)
	return &uploads.RecognitionResponse{
		ReportType:        "sales_report",
		MatchedColumns:    []string{"purchase-date", "sku", "asin"},
		Reason:            "命中 purchase-date / sku / asin",
		Country:           firstNonEmpty(detectedCountries, country),
		DetectedCountries: detectedCountries,
		PrimaryCountry:    primary,
		DateInputMode:     mode,
		DetectedDate:      dates.end,
		DetectedStartDate: dates.start,
		DetectedEndDate:   dates.end,
		ProjectMatch:      emptyProjectMatch(),
		RowCountPreview:   &rows,
		Warnings:          warnings,
		Identifiers:       extractColumnValues(table, lowers, "sku"),
		MatchBy:           "sku",
	}
}

func recognizeBusiness(
	table tableData,
	country string,
	originalFilename string,
) *uploads.RecognitionResponse {
	lowers := normalizedHeaders(table.Headers)
	asinColumn := findAnyHeader(lowers,
		"（子）asin", "(子)asin", "子asin", "asin", "(child) asin", "(parent) asin",
	)
	date := extractFilenameDate(originalFilename)
	warnings := []string{}
	if date != nil {
		warnings = append(warnings, "从文件名识别日期："+*date)
	}
	detectedCountry := detectBusinessCountry(table, lowers, country)
	if detectedCountry != country {
		warnings = append(warnings, fmt.Sprintf(
			"文件内销售额符号检测为 %s，当前按所选站点 %s 处理",
			detectedCountry,
			country,
		))
	}
	mode := "single_manual"
	if date != nil {
		mode = "single_detected"
	}
	rows := len(table.Rows)
	return &uploads.RecognitionResponse{
		ReportType:        "business_report",
		MatchedColumns:    []string{asinColumn},
		Reason:            "命中（子）ASIN字段",
		Country:           detectedCountry,
		DetectedCountries: []string{},
		DateInputMode:     mode,
		DetectedDate:      date,
		ProjectMatch:      emptyProjectMatch(),
		RowCountPreview:   &rows,
		Warnings:          warnings,
		Identifiers:       extractColumnValues(table, lowers, asinColumn),
		MatchBy:           "asin",
	}
}

func recognizePayment(table tableData, country string) (*uploads.RecognitionResponse, error) {
	lowers := normalizedHeaders(table.Headers)
	if !hasHeaders(lowers, "sku", "type") {
		return nil, &recognitionError{Message: "Payment report missing required columns"}
	}
	detectedCountry := detectTableCountry(table, lowers, country)
	dates := dateRange(table, lowers, "date/time", country)
	warnings := countryWarnings(detectedCountry, country, "文件内检测到")
	mode := "single_manual"
	if dates.start != nil {
		if dates.end != nil && *dates.start != *dates.end {
			mode = "range_auto"
		} else {
			mode = "single_auto"
		}
	}
	rows := len(table.Rows)
	return &uploads.RecognitionResponse{
		ReportType:        "payment_report",
		MatchedColumns:    []string{"sku"},
		Reason:            "命中付款报告表头与 sku 字段",
		Country:           detectedCountry,
		DetectedCountries: []string{},
		DateInputMode:     mode,
		DetectedDate:      dates.end,
		DetectedStartDate: dates.start,
		DetectedEndDate:   dates.end,
		ProjectMatch:      emptyProjectMatch(),
		RowCountPreview:   &rows,
		Warnings:          warnings,
		Identifiers:       extractColumnValues(table, lowers, "sku"),
		MatchBy:           "sku",
	}, nil
}

func recognizeReturn(table tableData, country string) *uploads.RecognitionResponse {
	lowers := normalizedHeaders(table.Headers)
	dates := dateRange(table, lowers, "return-date", country)
	countries := detectReturnCountries(table, lowers)
	if len(countries) == 0 {
		countries = []string{country}
	}
	mode := "single_detected"
	if dates.start != nil && dates.end != nil && *dates.start != *dates.end {
		mode = "multi_auto"
	}
	fullCountries := countries
	var primary *string
	if len(countries) == 1 {
		primary = &countries[0]
	}
	rows := len(table.Rows)
	return &uploads.RecognitionResponse{
		ReportType:        "return_report",
		MatchedColumns:    []string{"return-date", "sku"},
		Reason:            "命中 return-date / sku 字段",
		Country:           country,
		DetectedCountries: fullCountries,
		PrimaryCountry:    primary,
		DateInputMode:     mode,
		DetectedDate:      dates.end,
		DetectedStartDate: dates.start,
		DetectedEndDate:   dates.end,
		ProjectMatch:      emptyProjectMatch(),
		RowCountPreview:   &rows,
		Warnings:          []string{},
		Identifiers:       extractColumnValues(table, lowers, "sku"),
		MatchBy:           "sku",
	}
}

func recognizeLedger(
	table tableData,
	country string,
	originalFilename string,
) (*uploads.RecognitionResponse, error) {
	lowers := normalizedHeaders(table.Headers)
	summaryRequired := []string{
		"date", "msku", "disposition", "location",
		"starting warehouse balance", "ending warehouse balance",
	}
	detailRequired := []string{
		"date", "msku", "event type", "quantity", "fulfillment center", "disposition",
	}
	summaryComplete := hasHeaders(lowers, summaryRequired...)
	detailComplete := hasHeaders(lowers, detailRequired...)
	if summaryComplete && detailComplete {
		return nil, &recognitionError{Message: "库存分类账格式冲突：同时包含 Summary 与 Detail 的关键字段"}
	}
	if summaryComplete {
		return ledgerResult("inventory_ledger_summary", "summary", table, country, originalFilename), nil
	}
	if detailComplete {
		return ledgerResult("inventory_ledger_detail", "detail", table, country, originalFilename), nil
	}
	summaryStrong := hasAnyUploadHeader(lowers, "starting warehouse balance", "ending warehouse balance")
	detailStrongCount := countHeaders(lowers, "event type", "quantity", "fulfillment center")
	if summaryStrong && detailStrongCount >= 2 {
		return nil, &recognitionError{Message: "库存分类账格式冲突：同时包含 Summary 与 Detail 的关键字段"}
	}
	if summaryStrong {
		return nil, &recognitionError{
			Message: "无法识别库存分类账 Summary：缺少 " + missingHeaders(lowers, summaryRequired),
		}
	}
	if detailStrongCount >= 2 {
		return nil, &recognitionError{
			Message: "无法识别库存分类账 Detail：缺少 " + missingHeaders(lowers, detailRequired),
		}
	}
	return nil, nil
}

func ledgerResult(
	reportType string,
	kind string,
	table tableData,
	country string,
	originalFilename string,
) *uploads.RecognitionResponse {
	lowers := normalizedHeaders(table.Headers)
	matched := []string{"date", "msku", "disposition", "location", "starting warehouse balance", "ending warehouse balance"}
	reason := "命中 Amazon Inventory Ledger Summary 22 列签名"
	if kind == "detail" {
		matched = []string{"date", "msku", "event type", "quantity", "fulfillment center", "disposition"}
		reason = "命中 Amazon Inventory Ledger Detail 16 列签名"
	}
	dates := ledgerDates(table, lowers, originalFilename)
	mode := "single_manual"
	if dates.start != nil {
		mode = "range_auto"
	} else if dates.date != nil {
		mode = "single_auto"
	}
	rows := len(table.Rows)
	date := dates.date
	if date == nil {
		date = dates.start
	}
	return &uploads.RecognitionResponse{
		ReportType:        reportType,
		MatchedColumns:    matched,
		Reason:            reason,
		Country:           country,
		DetectedCountries: []string{},
		DateInputMode:     mode,
		DetectedDate:      date,
		DetectedStartDate: dates.start,
		DetectedEndDate:   dates.end,
		ProjectMatch:      emptyProjectMatch(),
		RowCountPreview:   &rows,
		Warnings:          []string{},
		Identifiers:       extractColumnValues(table, lowers, "msku"),
		MatchBy:           "sku",
	}
}

type dateBounds struct {
	date  *string
	start *string
	end   *string
}

func ledgerDates(table tableData, headers []string, filename string) dateBounds {
	var result dateBounds
	index := headerIndex(headers, "date")
	if index >= 0 {
		hasDayLevel := false
		var earliest, latest time.Time
		for _, row := range table.Rows {
			if index >= len(row) {
				continue
			}
			value := strings.TrimSpace(row[index])
			var parsed time.Time
			var err error
			if strings.Count(value, "/") == 1 && len(value) <= 7 {
				parsed, err = time.Parse("1/2006", value)
			} else {
				parsed, err = time.Parse("1/2/2006", value)
				if err == nil {
					hasDayLevel = true
				}
			}
			if err != nil {
				continue
			}
			if earliest.IsZero() || parsed.Before(earliest) {
				earliest = parsed
			}
			if latest.IsZero() || parsed.After(latest) {
				latest = parsed
			}
		}
		if !earliest.IsZero() {
			if hasDayLevel {
				start := earliest.Format("2006-01-02")
				end := latest.Format("2006-01-02")
				result.start, result.end, result.date = &start, &end, &start
			} else {
				value := earliest.Format("2006-01-02")
				result.date = &value
			}
		}
	}
	if result.date == nil {
		result.date = extractLedgerFilenameDate(filename)
	}
	return result
}

func extractLedgerFilenameDate(filename string) *string {
	matches := regexp.MustCompile(`(?:^|\D)(20\d{2})(\d{2})(\d{2})(?:\D|$)`).FindStringSubmatch(filename)
	if len(matches) != 4 {
		return nil
	}
	value := matches[1] + "-" + matches[2] + "-" + matches[3]
	if _, err := time.Parse("2006-01-02", value); err != nil {
		return nil
	}
	return &value
}

func readTable(path string, delimiter rune) (tableData, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return tableData{}, err
	}
	reader := csv.NewReader(bytes.NewReader([]byte(decodeText(raw))))
	reader.Comma = delimiter
	reader.FieldsPerRecord = -1
	reader.LazyQuotes = true
	records, err := reader.ReadAll()
	if err != nil || len(records) == 0 {
		return tableData{}, firstError(err, "empty file")
	}
	headers := make([]string, len(records[0]))
	for index, value := range records[0] {
		headers[index] = strings.TrimSpace(value)
	}
	return tableData{Headers: headers, Rows: records[1:]}, nil
}

func readPaymentTable(path string, country string) (tableData, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return tableData{}, err
	}
	text := decodeText(raw)
	lines := strings.Split(text, "\n")
	for lineIndex := range lines {
		for _, delimiter := range []rune{',', '\t', ';'} {
			reader := csv.NewReader(strings.NewReader(strings.Join(lines[lineIndex:], "\n")))
			reader.Comma = delimiter
			reader.FieldsPerRecord = -1
			reader.LazyQuotes = true
			records, err := reader.ReadAll()
			if err != nil || len(records) == 0 || len(records[0]) < 3 {
				continue
			}
			headers := make([]string, len(records[0]))
			for index, value := range records[0] {
				headers[index] = strings.TrimSpace(value)
			}
			normalized := normalizedHeaders(headers)
			if paymentHeaderMatches(normalized) {
				_ = country
				return tableData{Headers: headers, Rows: records[1:]}, nil
			}
		}
	}
	return tableData{}, errors.New("payment report header row not found")
}

func parseUploadXLSXTable(path string) (tableData, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return tableData{}, err
	}
	reader, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return tableData{}, err
	}
	var shared []string
	for _, file := range reader.File {
		if file.Name != "xl/sharedStrings.xml" {
			continue
		}
		stream, err := file.Open()
		if err != nil {
			return tableData{}, err
		}
		type sharedXML struct {
			Items []struct {
				Text string `xml:"t"`
			} `xml:"si"`
		}
		var value sharedXML
		if err := xml.NewDecoder(stream).Decode(&value); err == nil {
			for _, item := range value.Items {
				shared = append(shared, item.Text)
			}
		}
		_ = stream.Close()
		break
	}
	var sheet *zip.File
	for _, file := range reader.File {
		if strings.HasPrefix(file.Name, "xl/worksheets/sheet") && strings.HasSuffix(file.Name, ".xml") {
			sheet = file
			break
		}
	}
	if sheet == nil {
		return tableData{}, errors.New("cannot find worksheet in xlsx")
	}
	stream, err := sheet.Open()
	if err != nil {
		return tableData{}, err
	}
	defer stream.Close()
	type cell struct {
		Type  string `xml:"t,attr"`
		Value string `xml:"v"`
	}
	type row struct {
		Cells []cell `xml:"c"`
	}
	type sheetData struct {
		Rows []row `xml:"row"`
	}
	type worksheet struct {
		Data sheetData `xml:"sheetData"`
	}
	var value worksheet
	if err := xml.NewDecoder(stream).Decode(&value); err != nil {
		return tableData{}, err
	}
	if len(value.Data.Rows) == 0 {
		return tableData{}, errors.New("empty worksheet")
	}
	decode := func(cell cell) string {
		if cell.Type == "s" {
			index, err := strconv.Atoi(cell.Value)
			if err == nil && index >= 0 && index < len(shared) {
				return shared[index]
			}
		}
		return cell.Value
	}
	headers := make([]string, len(value.Data.Rows[0].Cells))
	for index, cell := range value.Data.Rows[0].Cells {
		headers[index] = strings.TrimSpace(decode(cell))
	}
	rows := make([][]string, 0, len(value.Data.Rows)-1)
	for _, source := range value.Data.Rows[1:] {
		values := make([]string, len(source.Cells))
		for index, cell := range source.Cells {
			values[index] = strings.TrimSpace(decode(cell))
		}
		rows = append(rows, values)
	}
	return tableData{Headers: headers, Rows: rows}, nil
}

func decodeText(raw []byte) string {
	text := string(raw)
	text = strings.TrimPrefix(text, "\ufeff")
	return strings.ToValidUTF8(text, "\uFFFD")
}

func normalizedHeaders(headers []string) []string {
	result := make([]string, len(headers))
	for index, header := range headers {
		result[index] = strings.ToLower(strings.TrimSpace(header))
	}
	return result
}

func hasHeaders(headers []string, required ...string) bool {
	set := make(map[string]bool, len(headers))
	for _, header := range headers {
		set[header] = true
	}
	for _, value := range required {
		if !set[value] {
			return false
		}
	}
	return true
}

func hasAnyUploadHeader(headers []string, candidates ...string) bool {
	set := make(map[string]bool, len(headers))
	for _, header := range headers {
		set[header] = true
	}
	for _, candidate := range candidates {
		if set[candidate] {
			return true
		}
	}
	return false
}

func countHeaders(headers []string, candidates ...string) int {
	set := make(map[string]bool, len(headers))
	for _, header := range headers {
		set[header] = true
	}
	count := 0
	for _, candidate := range candidates {
		if set[candidate] {
			count++
		}
	}
	return count
}

func findAnyHeader(headers []string, candidates ...string) string {
	set := make(map[string]bool, len(headers))
	for _, header := range headers {
		set[header] = true
	}
	for _, candidate := range candidates {
		if set[candidate] {
			return candidate
		}
	}
	return ""
}

func missingHeaders(headers []string, required []string) string {
	set := make(map[string]bool, len(headers))
	for _, header := range headers {
		set[header] = true
	}
	m := make([]string, 0)
	for _, value := range required {
		if !set[value] {
			m = append(m, value)
		}
	}
	return strings.Join(m, ", ")
}

func headerIndex(headers []string, name string) int {
	for index, header := range headers {
		if header == name {
			return index
		}
	}
	return -1
}

func headerValue(row []string, headers []string, name string) string {
	index := headerIndex(headers, name)
	if index < 0 || index >= len(row) {
		return ""
	}
	return strings.TrimSpace(row[index])
}

func containsPaymentMarker(text string) bool {
	lower := strings.ToLower(text)
	return strings.Contains(lower, strings.ToLower("Includes Amazon Marketplace")) ||
		strings.Contains(lower, strings.ToLower("Einschließlich Transaktionen zu Amazon Marketplace"))
}

func isPaymentTable(headers []string) bool {
	required := []string{"type", "sku", "quantity", "product sales", "shipping credits",
		"promotional rebates", "other", "selling fees", "fba fees"}
	return hasHeaders(headers, required...)
}

func paymentHeaderMatches(headers []string) bool {
	canonical := []string{"date/time", "settlement id", "type", "order id", "sku"}
	aliasSets := map[string][]string{
		"date/time":     {"date/time", "datum/uhrzeit"},
		"settlement id": {"settlement id", "abrechnungsnummer"},
		"type":          {"type", "typ"},
		"order id":      {"order id", "bestellnummer"},
		"sku":           {"sku"},
	}
	matches := 0
	for _, name := range canonical {
		if hasAnyUploadHeader(headers, aliasSets[name]...) {
			matches++
		}
	}
	return matches >= 3
}

func detectTableCountry(table tableData, headers []string, fallback string) string {
	if country := detectFromColumn(table, headers, "sales-channel", "sales channel"); country != "" {
		return country
	}
	if country := detectFromColumn(table, headers, "currency"); country != "" {
		return country
	}
	if country := detectFromColumn(table, headers, "marketplace"); country != "" {
		return country
	}
	return fallback
}

func detectFromColumn(table tableData, headers []string, names ...string) string {
	index := -1
	for _, name := range names {
		if candidate := headerIndex(headers, name); candidate >= 0 {
			index = candidate
			break
		}
	}
	if index < 0 {
		return ""
	}
	for _, row := range table.Rows {
		if index >= len(row) {
			continue
		}
		value := strings.ToLower(strings.TrimSpace(row[index]))
		switch {
		case strings.Contains(value, "amazon.de"), value == "eur", value == "euro", value == "de":
			return "DE"
		case strings.Contains(value, "amazon.co.uk"), value == "gbp", value == "uk", value == "gb":
			return "UK"
		case strings.Contains(value, "amazon.com"), value == "usd", value == "us":
			return "US"
		}
	}
	return ""
}

func detectSalesCountries(table tableData, headers []string, fallback string) []string {
	index := headerIndex(headers, "sales-channel")
	if index < 0 {
		index = headerIndex(headers, "sales channel")
	}
	if index < 0 {
		return []string{fallback}
	}
	countries := map[string]bool{}
	for _, row := range table.Rows {
		if index >= len(row) {
			continue
		}
		value := strings.ToLower(row[index])
		switch {
		case strings.Contains(value, "amazon.co.uk"):
			countries["UK"] = true
		case strings.Contains(value, "amazon.de"):
			countries["DE"] = true
		case strings.Contains(value, "amazon.fr"):
			countries["FR"] = true
		case strings.Contains(value, "amazon.com"):
			countries["US"] = true
		}
	}
	result := make([]string, 0, len(countries))
	for _, country := range []string{"UK", "DE", "FR", "US"} {
		if countries[country] {
			result = append(result, country)
		}
	}
	if len(result) == 0 {
		return []string{fallback}
	}
	return result
}

func detectReturnCountries(table tableData, headers []string) []string {
	index := headerIndex(headers, "order-id")
	if index < 0 {
		index = headerIndex(headers, "order id")
	}
	if index < 0 {
		return nil
	}
	countries := map[string]bool{}
	for _, row := range table.Rows {
		if index >= len(row) {
			continue
		}
		parts := strings.Split(strings.TrimSpace(row[index]), "-")
		if len(parts) == 0 {
			continue
		}
		prefix, err := strconv.Atoi(parts[0])
		if err != nil {
			continue
		}
		switch {
		case prefix <= 99:
			countries["UK"] = true
		case prefix >= 300 && prefix <= 399:
			countries["DE"] = true
		case prefix >= 100 && prefix <= 199:
			countries["US"] = true
		}
	}
	result := make([]string, 0, len(countries))
	for _, country := range []string{"UK", "DE", "US"} {
		if countries[country] {
			result = append(result, country)
		}
	}
	return result
}

func detectBusinessCountry(table tableData, headers []string, fallback string) string {
	for _, header := range headers {
		if !strings.Contains(header, "销售额") && !strings.Contains(header, "sales") {
			continue
		}
		index := headerIndex(headers, header)
		for _, row := range table.Rows {
			if index >= len(row) {
				continue
			}
			value := row[index]
			if strings.Contains(value, "€") {
				return "DE"
			}
			if strings.Contains(value, "£") {
				return "UK"
			}
		}
	}
	return fallback
}

func countryWarnings(detected, selected, prefix string) []string {
	if detected == "" || detected == selected {
		return []string{}
	}
	if prefix != "" {
		return []string{fmt.Sprintf("%s %s，当前按所选站点 %s 处理", prefix, detected, selected)}
	}
	return []string{fmt.Sprintf("文件内检测到 %s，当前按所选站点 %s 处理", detected, selected)}
}

func firstDateValue(
	table tableData,
	headers []string,
	name string,
	country string,
) *string {
	index := headerIndex(headers, name)
	if index < 0 {
		return nil
	}
	for _, row := range table.Rows {
		if index >= len(row) {
			continue
		}
		if parsed := parseDateString(row[index], country); parsed != nil {
			return parsed
		}
	}
	return nil
}

func dateRange(
	table tableData,
	headers []string,
	name string,
	country string,
) dateBounds {
	index := headerIndex(headers, name)
	if index < 0 {
		return dateBounds{}
	}
	var earliest, latest time.Time
	for _, row := range table.Rows {
		if index >= len(row) {
			continue
		}
		parsed := parseTimestamp(row[index], country)
		if parsed.IsZero() {
			continue
		}
		if earliest.IsZero() || parsed.Before(earliest) {
			earliest = parsed
		}
		if latest.IsZero() || parsed.After(latest) {
			latest = parsed
		}
	}
	if earliest.IsZero() {
		return dateBounds{}
	}
	start := earliest.Format("2006-01-02")
	if location := countryLocation(country); location != nil {
		start = earliest.In(location).Format("2006-01-02")
	}
	end := latest.Format("2006-01-02")
	if location := countryLocation(country); location != nil {
		end = latest.In(location).Format("2006-01-02")
	}
	return dateBounds{date: &end, start: &start, end: &end}
}

func parseDateString(value string, country string) *string {
	parsed := parseTimestamp(value, country)
	if parsed.IsZero() {
		return nil
	}
	if location := countryLocation(country); location != nil {
		parsed = parsed.In(location)
	}
	formatted := parsed.Format("2006-01-02")
	return &formatted
}

func parseTimestamp(value string, country string) time.Time {
	value = strings.TrimSpace(value)
	if value == "" || strings.EqualFold(value, "nan") || strings.EqualFold(value, "null") {
		return time.Time{}
	}
	for _, layout := range []string{
		time.RFC3339Nano,
		"2006-01-02T15:04:05",
		"2006-01-02 15:04:05",
		"2006-01-02",
		"Jan 2, 2006 1:04:05 PM",
		"Jan 2, 2006 01:04:05 PM",
	} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed
		}
	}
	cleaned := regexp.MustCompile(`\s+(PST|PDT|GMT|UTC)\s*$`).ReplaceAllString(value, "")
	for _, layout := range []string{
		"1/2/2006 3:04:05 PM",
		"1/2/2006 15:04:05",
		"1/2/2006",
		"Jan 2, 2006 1:04:05 PM",
	} {
		if parsed, err := time.Parse(layout, cleaned); err == nil {
			if strings.Contains(value, "PST") {
				return parsed.Add(-8 * time.Hour)
			}
			if strings.Contains(value, "PDT") {
				return parsed.Add(-7 * time.Hour)
			}
			return parsed
		}
	}
	_ = country
	return time.Time{}
}

func countryLocation(country string) *time.Location {
	name := "America/Los_Angeles"
	switch strings.ToUpper(country) {
	case "DE":
		name = "Europe/Berlin"
	case "UK":
		name = "Europe/London"
	}
	location, err := time.LoadLocation(name)
	if err != nil {
		return nil
	}
	return location
}

func extractFilenameDate(filename string) *string {
	matches := regexp.MustCompile(`(20\d{2})(\d{2})(\d{2})`).FindStringSubmatch(filename)
	if len(matches) != 4 {
		return nil
	}
	value := matches[1] + "-" + matches[2] + "-" + matches[3]
	if _, err := time.Parse("2006-01-02", value); err != nil {
		return nil
	}
	return &value
}

func firstNonEmpty(values []string, fallback string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return fallback
}

func singleCountry(values []string) *string {
	unique := make([]string, 0)
	for _, value := range values {
		if value == "" || containsString(unique, value) {
			continue
		}
		unique = append(unique, value)
	}
	if len(unique) != 1 {
		return nil
	}
	return &unique[0]
}

func containsString(values []string, value string) bool {
	for _, item := range values {
		if item == value {
			return true
		}
	}
	return false
}

func emptyProjectMatch() uploads.ProjectMatchSummary {
	return uploads.ProjectMatchSummary{
		Status:            "manual",
		CandidateProjects: []string{},
		MatchedValues:     []string{},
	}
}

func firstError(err error, fallback string) error {
	if err != nil {
		return err
	}
	return errors.New(fallback)
}

func extractColumnValues(table tableData, headers []string, name string) []string {
	if name == "" {
		return []string{}
	}
	index := headerIndex(headers, name)
	if index < 0 {
		return []string{}
	}
	values := make([]string, 0, len(table.Rows))
	for _, row := range table.Rows {
		if index >= len(row) {
			continue
		}
		value := normalizeIdentifier(row[index])
		if value != "" {
			values = append(values, value)
		}
	}
	return values
}

func normalizeIdentifier(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || strings.EqualFold(value, "nan") {
		return ""
	}
	return strings.ToUpper(value)
}

func (store *UploadStore) buildProjectMatch(
	ctx context.Context,
	result *uploads.RecognitionResponse,
	selectedCountry string,
	allowed map[string]projectRow,
) (uploads.ProjectMatchSummary, error) {
	matchBy := result.MatchBy
	if matchBy == "" {
		matchBy = "sku"
	}
	normalized := normalizeIdentifiers(result.Identifiers)
	if len(normalized) == 0 {
		message := "文件中未找到可用于匹配项目的标识"
		return uploads.ProjectMatchSummary{
			Status: "unmatched", CandidateProjects: []string{}, MatchedBy: &matchBy,
			MatchedValues: []string{}, Message: &message,
		}, nil
	}
	column := "sku"
	if matchBy == "asin" {
		column = "asin"
	}
	rows, err := store.db.Query(
		ctx,
		`SELECT p.project_name, s.`+column+`
		 FROM public.projects p
		 JOIN public.product_costs s ON s.project_id = p.id
		 WHERE upper(s.`+column+`) = ANY($1)
		   AND s.country = $2`,
		normalized,
		result.Country,
	)
	if err != nil {
		return uploads.ProjectMatchSummary{}, err
	}
	defer rows.Close()
	matched := make(map[string][]string)
	allProjects := map[string]bool{}
	for rows.Next() {
		var projectName string
		var identifier *string
		if err := rows.Scan(&projectName, &identifier); err != nil {
			return uploads.ProjectMatchSummary{}, err
		}
		if identifier == nil {
			continue
		}
		value := normalizeIdentifier(*identifier)
		if value == "" {
			continue
		}
		matched[value] = appendUnique(matched[value], projectName)
		if len(allowed) == 0 || allowed[projectName].Name != "" {
			allProjects[projectName] = true
		}
	}
	if err := rows.Err(); err != nil {
		return uploads.ProjectMatchSummary{}, err
	}

	projects := make([]string, 0, len(allProjects))
	for name := range allProjects {
		projects = append(projects, name)
	}
	sort.Strings(projects)
	matchedValues := make([]string, 0)
	for value, names := range matched {
		filtered := make([]string, 0, len(names))
		for _, name := range names {
			if _, ok := allowed[name]; ok {
				filtered = append(filtered, name)
			}
		}
		if len(filtered) > 0 {
			matchedValues = append(matchedValues, value)
		}
	}
	sort.Strings(matchedValues)
	if len(matchedValues) > 8 {
		matchedValues = matchedValues[:8]
	}

	if len(projects) == 1 {
		message := "已根据" + strings.ToUpper(matchBy) + "自动匹配项目"
		if len(matchedValues) != len(normalized) {
			message = "已根据部分" + strings.ToUpper(matchBy) + "自动匹配项目"
		}
		return uploads.ProjectMatchSummary{
			Status: "matched", ProjectName: &projects[0], CandidateProjects: projects,
			MatchedBy: &matchBy, MatchedValues: matchedValues, Message: &message,
		}, nil
	}
	if len(projects) > 1 {
		message := fmt.Sprintf("检测到多个项目，请手动确认（%d 个候选项目）", len(projects))
		return uploads.ProjectMatchSummary{
			Status: "conflict", CandidateProjects: projects, MatchedBy: &matchBy,
			MatchedValues: matchedValues, Message: &message,
		}, nil
	}

	if result.ReportType == "payment_report" && result.OriginalFilename != "" {
		matches := regexp.MustCompile(`^\[([^\]]+)\]`).FindStringSubmatch(result.OriginalFilename)
		if len(matches) == 2 {
			if _, ok := allowed[matches[1]]; ok {
				message := fmt.Sprintf("根据文件名 [%s] 匹配项目（SKU 匹配失败）", matches[1])
				folderMatch := "folder_name"
				return uploads.ProjectMatchSummary{
					Status: "matched", ProjectName: &matches[1],
					CandidateProjects: []string{matches[1]}, MatchedBy: &folderMatch,
					MatchedValues: []string{}, Message: &message,
				}, nil
			}
		}
	}
	message := "未匹配到项目，请手动选择"
	return uploads.ProjectMatchSummary{
		Status: "unmatched", CandidateProjects: []string{}, MatchedBy: &matchBy,
		MatchedValues: []string{}, Message: &message,
	}, nil
}

func normalizeIdentifiers(values []string) []string {
	set := make(map[string]bool, len(values))
	for _, value := range values {
		normalized := normalizeIdentifier(value)
		if normalized != "" {
			set[normalized] = true
		}
	}
	result := make([]string, 0, len(set))
	for value := range set {
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}

func appendUnique(values []string, value string) []string {
	for _, current := range values {
		if current == value {
			return values
		}
	}
	return append(values, value)
}

type persistResult struct {
	Status          string
	SourceID        *int64
	Table           *string
	Message         string
	RowsIngested    *int
	ReportStartDate *string
	ReportEndDate   *string
}

func (store *UploadStore) persistReport(
	ctx context.Context,
	payload uploads.CommitRequest,
	project projectRow,
	file uploads.PreparedReportFile,
	recognition *uploads.RecognitionResponse,
	operator string,
) (persistResult, error) {
	reportType := normalizeReportType(payload.ReportType)
	needsInvalidation := reportTypeNeedsCacheInvalidation(reportType)
	if needsInvalidation && store.cacheInvalidator == nil {
		return persistResult{}, uploads.NewAPIError(
			http.StatusServiceUnavailable,
			"日报分析缓存失效依赖尚未接入",
		)
	}
	result, err := store.persistReportData(ctx, payload, project, file, recognition, operator)
	if err != nil {
		return persistResult{}, err
	}
	if needsInvalidation {
		if err := store.cacheInvalidator.InvalidateDailyAnalysis(ctx, project.ID); err != nil {
			return persistResult{}, uploads.NewAPIError(
				http.StatusServiceUnavailable,
				"报表已入库，但日报分析缓存失效失败: "+err.Error(),
			)
		}
	}
	return result, nil
}

func (store *UploadStore) persistReportData(
	ctx context.Context,
	payload uploads.CommitRequest,
	project projectRow,
	file uploads.PreparedReportFile,
	recognition *uploads.RecognitionResponse,
	operator string,
) (persistResult, error) {
	switch normalizeReportType(payload.ReportType) {
	case "inventory_ledger", "inventory_ledger_summary", "inventory_ledger_detail":
		return store.persistLedgerReport(ctx, payload, project, file, operator)
	case "ad_search_term_report":
		return store.persistFileOnlyReportStatus(ctx, payload, project, file, operator)
	case "inventory_report":
		return store.persistInventoryReport(ctx, payload, project, file, recognition, operator)
	case "business_report":
		return store.persistBusinessReport(ctx, payload, project, file, recognition, operator)
	case "payment_report":
		return store.persistPaymentReport(ctx, payload, project, file, recognition, operator)
	case "sales_report":
		return store.persistSalesReport(ctx, payload, project, file, recognition, operator)
	case "return_report":
		return store.persistReturnReport(ctx, payload, project, file, recognition, operator)
	default:
		return persistResult{}, uploads.NewAPIError(
			http.StatusServiceUnavailable,
			"报表原生入库依赖尚未接入",
		)
	}
}

func reportTypeNeedsCacheInvalidation(reportType string) bool {
	switch reportType {
	case "inventory_report", "business_report", "payment_report",
		"sales_report", "return_report":
		return true
	default:
		return false
	}
}

func (store *UploadStore) persistFileOnlyReportStatus(
	ctx context.Context,
	payload uploads.CommitRequest,
	project projectRow,
	file uploads.PreparedReportFile,
	operator string,
) (persistResult, error) {
	reportDate := trimmedValue(payload.ReportDate)
	if reportDate == "" {
		return persistResult{}, uploads.NewAPIError(http.StatusUnprocessableEntity, "report_date is required")
	}
	parsedDate, err := time.Parse("2006-01-02", reportDate)
	if err != nil {
		return persistResult{}, uploads.NewAPIError(http.StatusBadRequest, "report_date must be YYYY-MM-DD")
	}
	var sourceID int64
	err = RunInTx(ctx, store.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		row := txDB.QueryRow(
			ctx,
			`INSERT INTO public.report_upload_statuses (
				project_id, report_type, country, report_date, upload_file_id,
				upload_file_path, original_filename, stored_filename,
				file_size_bytes, created_by
			 ) VALUES ($1, 'ad_search_term_report', $2, $3, $4, $5, $6, $7, $8, $9)
			 ON CONFLICT (project_id, report_type, country, report_date) DO UPDATE SET
				upload_file_id = EXCLUDED.upload_file_id,
				upload_file_path = EXCLUDED.upload_file_path,
				original_filename = EXCLUDED.original_filename,
				stored_filename = EXCLUDED.stored_filename,
				file_size_bytes = EXCLUDED.file_size_bytes,
				created_by = coalesce(EXCLUDED.created_by, report_upload_statuses.created_by),
				updated_at = now()
			 RETURNING id`,
			project.ID,
			normalizeStoreCountry(payload.Country),
			parsedDate,
			file.FileID,
			file.FilePath,
			file.OriginalFilename,
			file.Filename,
			file.Size,
			nullableOperator(operator),
		)
		return row.Scan(&sourceID)
	})
	if err != nil {
		return persistResult{}, err
	}
	table := "report_upload_statuses"
	message := "搜索词报表已保存，本期不拆行落库"
	return persistResult{
		Status: "saved", SourceID: &sourceID, Table: &table, Message: message,
	}, nil
}

func (store *UploadStore) persistInventoryReport(
	ctx context.Context,
	payload uploads.CommitRequest,
	project projectRow,
	file uploads.PreparedReportFile,
	recognition *uploads.RecognitionResponse,
	operator string,
) (persistResult, error) {
	reportDate := trimmedValue(payload.ReportDate)
	if reportDate == "" && recognition != nil && recognition.DetectedDate != nil {
		reportDate = *recognition.DetectedDate
	}
	if reportDate == "" {
		return persistResult{}, uploads.NewAPIError(http.StatusUnprocessableEntity, "report_date is required")
	}
	targetDate, err := time.Parse("2006-01-02", reportDate)
	if err != nil {
		return persistResult{}, uploads.NewAPIError(http.StatusBadRequest, "report_date must be YYYY-MM-DD")
	}
	table, err := readTable(file.LocalPath, '\t')
	if err != nil {
		return persistResult{}, uploads.NewAPIError(http.StatusBadRequest, "库存报表解析失败")
	}
	headers := normalizedHeaders(table.Headers)
	if !hasHeaders(headers, "sku", "asin") {
		return persistResult{}, uploads.NewAPIError(http.StatusBadRequest, "Inventory report missing required columns")
	}
	rows := parseInventoryRows(table, headers)
	var sourceID int64
	err = RunInTx(ctx, store.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		id, err := insertAnalysisSource(ctx, txDB, analysisSourceInput{
			ProjectID:        project.ID,
			ReportType:       "inventory_report",
			Country:          normalizeStoreCountry(payload.Country),
			ReportDate:       &targetDate,
			SnapshotAt:       timePointer(time.Now().UTC()),
			File:             file,
			RowCountTotal:    len(rows),
			RowCountIncluded: len(rows),
			CreatedBy:        nullableOperator(operator),
		})
		if err != nil {
			return err
		}
		if err := insertInventoryRows(ctx, txDB, id, rows); err != nil {
			return err
		}
		if err := insertReportUploadLog(
			ctx, txDB, project.ID, "inventory_report",
			normalizeStoreCountry(payload.Country), targetDate, id, len(rows),
			file.OriginalFilename,
		); err != nil {
			return err
		}
		sourceID = id
		return nil
	})
	if err != nil {
		return persistResult{}, err
	}
	tableName := "analysis_source_files"
	message := "库存报表已保存并写入库存源数据"
	return persistResult{Status: "persisted", SourceID: &sourceID, Table: &tableName, Message: message}, nil
}

func (store *UploadStore) persistBusinessReport(
	ctx context.Context,
	payload uploads.CommitRequest,
	project projectRow,
	file uploads.PreparedReportFile,
	recognition *uploads.RecognitionResponse,
	operator string,
) (persistResult, error) {
	table, err := readTable(file.LocalPath, ',')
	if err != nil {
		return persistResult{}, uploads.NewAPIError(http.StatusBadRequest, "业务报表解析失败")
	}
	headers := trimSpaceHeaders(table.Headers)
	if findCaseInsensitive(headers, []string{
		"（子）ASIN", "(子)ASIN", "子ASIN", "ASIN", "(Child) ASIN", "(Parent) ASIN",
	}) < 0 {
		return persistResult{}, uploads.NewAPIError(http.StatusBadRequest, "Business report missing child ASIN column")
	}
	rows := parseBusinessRows(table, headers)
	start, end, reportDate, err := resolveReportPeriod(payload, recognition, true)
	if err != nil {
		return persistResult{}, err
	}
	var sourceID int64
	err = RunInTx(ctx, store.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		id, err := insertAnalysisSource(ctx, txDB, analysisSourceInput{
			ProjectID:        project.ID,
			ReportType:       "business_report",
			Country:          normalizeStoreCountry(payload.Country),
			ReportDate:       reportDate,
			PeriodStart:      start,
			PeriodEnd:        end,
			File:             file,
			RowCountTotal:    len(rows),
			RowCountIncluded: len(rows),
			CreatedBy:        nullableOperator(operator),
		})
		if err != nil {
			return err
		}
		if err := insertBusinessRows(ctx, txDB, id, rows); err != nil {
			return err
		}
		if !payload.UsePeriodDates {
			logDate := start
			if logDate == nil {
				logDate = reportDate
			}
			if logDate != nil {
				if err := insertReportUploadLog(
					ctx, txDB, project.ID, "business_report",
					normalizeStoreCountry(payload.Country), *logDate, id, len(rows),
					file.OriginalFilename,
				); err != nil {
					return err
				}
			}
		}
		sourceID = id
		return nil
	})
	if err != nil {
		return persistResult{}, err
	}
	tableName := "analysis_source_files"
	message := "业务报表已保存并写入业务源数据"
	return persistResult{
		Status: "persisted", SourceID: &sourceID, Table: &tableName,
		Message: message, ReportStartDate: formatDatePointer(start), ReportEndDate: formatDatePointer(end),
	}, nil
}

func (store *UploadStore) persistPaymentReport(
	ctx context.Context,
	payload uploads.CommitRequest,
	project projectRow,
	file uploads.PreparedReportFile,
	recognition *uploads.RecognitionResponse,
	operator string,
) (persistResult, error) {
	table, err := readPaymentTable(file.LocalPath, normalizeStoreCountry(payload.Country))
	if err != nil {
		return persistResult{}, uploads.NewAPIError(http.StatusBadRequest, "付款报告解析失败")
	}
	headers := normalizedHeaders(table.Headers)
	if !hasHeaders(headers, "sku") {
		return persistResult{}, uploads.NewAPIError(http.StatusBadRequest, "Payment report missing sku column")
	}
	start, end, _, err := resolveReportPeriod(payload, recognition, false)
	if err != nil {
		return persistResult{}, err
	}
	if start == nil || end == nil {
		return persistResult{}, uploads.NewAPIError(
			http.StatusUnprocessableEntity,
			"report_start_date and report_end_date are required",
		)
	}
	rows := parsePaymentRows(table, headers)
	known, err := store.projectIdentifiers(ctx, project, normalizeStoreCountry(payload.Country))
	if err != nil {
		return persistResult{}, err
	}
	included := 0
	for _, row := range rows {
		if matchesKnownIdentifier(row.SKU, row.ASIN, known) {
			included++
		}
	}
	var sourceID int64
	err = RunInTx(ctx, store.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		id, err := insertAnalysisSource(ctx, txDB, analysisSourceInput{
			ProjectID:        project.ID,
			ReportType:       "payment_report",
			Country:          normalizeStoreCountry(payload.Country),
			PeriodStart:      start,
			PeriodEnd:        end,
			File:             file,
			RowCountTotal:    len(rows),
			RowCountIncluded: included,
			CreatedBy:        nullableOperator(operator),
		})
		if err != nil {
			return err
		}
		if err := insertPaymentRows(ctx, txDB, id, rows, known); err != nil {
			return err
		}
		sourceID = id
		return nil
	})
	if err != nil {
		return persistResult{}, err
	}
	tableName := "analysis_source_files"
	message := "付款报告已保存并写入付款源数据"
	return persistResult{
		Status: "persisted", SourceID: &sourceID, Table: &tableName,
		Message: message, ReportStartDate: formatDatePointer(start), ReportEndDate: formatDatePointer(end),
	}, nil
}

func (store *UploadStore) persistSalesReport(
	ctx context.Context,
	payload uploads.CommitRequest,
	project projectRow,
	file uploads.PreparedReportFile,
	recognition *uploads.RecognitionResponse,
	operator string,
) (persistResult, error) {
	table, err := readTable(file.LocalPath, '\t')
	if err != nil {
		return persistResult{}, uploads.NewAPIError(http.StatusBadRequest, "销售报表解析失败")
	}
	headers := normalizedHeaders(table.Headers)
	required := []string{"amazon-order-id", "purchase-date", "order-status", "sku", "asin", "quantity", "item-price"}
	if !hasHeaders(headers, required...) {
		return persistResult{}, uploads.NewAPIError(
			http.StatusBadRequest,
			"Sales report missing required columns",
		)
	}
	countAsOf := time.Now().UTC()
	if value := trimmedValue(payload.ReportDate); value != "" {
		if parsed, err := time.Parse("2006-01-02", value); err == nil {
			countAsOf = parsed
		}
	} else if recognition != nil && recognition.DetectedDate != nil {
		if parsed, err := time.Parse("2006-01-02", *recognition.DetectedDate); err == nil {
			countAsOf = parsed
		}
	}
	rows := parseSalesRows(table, headers, normalizeStoreCountry(payload.Country), countAsOf)
	grouped := make(map[string][]salesRow)
	for _, row := range rows {
		if row.PurchaseDate == "" {
			continue
		}
		grouped[row.PurchaseDate] = append(grouped[row.PurchaseDate], row)
	}
	if len(grouped) == 0 {
		date := time.Now().UTC()
		return store.persistSingleSalesSnapshot(ctx, project, file, date, nil, operator, payload.Country)
	}
	dates := make([]string, 0, len(grouped))
	for date := range grouped {
		dates = append(dates, date)
	}
	sort.Strings(dates)
	var latestID int64
	err = RunInTx(ctx, store.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		for _, dateText := range dates {
			date, _ := time.Parse("2006-01-02", dateText)
			id, err := insertAnalysisSource(ctx, txDB, analysisSourceInput{
				ProjectID:        project.ID,
				ReportType:       "sales_report",
				Country:          normalizeStoreCountry(payload.Country),
				ReportDate:       &date,
				PeriodStart:      &date,
				PeriodEnd:        &date,
				File:             file,
				RowCountTotal:    len(grouped[dateText]),
				RowCountIncluded: countIncludedSales(grouped[dateText]),
				CreatedBy:        nullableOperator(operator),
			})
			if err != nil {
				return err
			}
			if err := insertSalesRows(ctx, txDB, id, grouped[dateText]); err != nil {
				return err
			}
			latestID = id
		}
		return nil
	})
	if err != nil {
		return persistResult{}, err
	}
	tableName := "analysis_source_files"
	message := "销售报表已按购买日期拆分并写入分析销售源数据"
	start, end := dates[0], dates[len(dates)-1]
	return persistResult{
		Status: "persisted", SourceID: &latestID, Table: &tableName,
		Message: message, ReportStartDate: &start, ReportEndDate: &end,
	}, nil
}

func (store *UploadStore) persistSingleSalesSnapshot(
	ctx context.Context,
	project projectRow,
	file uploads.PreparedReportFile,
	date time.Time,
	rows []salesRow,
	operator string,
	country string,
) (persistResult, error) {
	var sourceID int64
	err := RunInTx(ctx, store.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		id, err := insertAnalysisSource(ctx, txDB, analysisSourceInput{
			ProjectID: project.ID, ReportType: "sales_report", Country: normalizeStoreCountry(country),
			ReportDate: &date, PeriodStart: &date, PeriodEnd: &date, File: file,
			RowCountTotal: len(rows), RowCountIncluded: countIncludedSales(rows),
			CreatedBy: nullableOperator(operator),
		})
		if err != nil {
			return err
		}
		if err := insertSalesRows(ctx, txDB, id, rows); err != nil {
			return err
		}
		sourceID = id
		return nil
	})
	if err != nil {
		return persistResult{}, err
	}
	tableName := "analysis_source_files"
	dateText := date.Format("2006-01-02")
	return persistResult{
		Status: "persisted", SourceID: &sourceID, Table: &tableName,
		Message:         "销售报表无有效购买日期记录，已记录空上传",
		ReportStartDate: &dateText, ReportEndDate: &dateText,
	}, nil
}

func (store *UploadStore) persistReturnReport(
	ctx context.Context,
	payload uploads.CommitRequest,
	project projectRow,
	file uploads.PreparedReportFile,
	recognition *uploads.RecognitionResponse,
	operator string,
) (persistResult, error) {
	table, err := readTable(file.LocalPath, '\t')
	if err != nil {
		return persistResult{}, uploads.NewAPIError(http.StatusBadRequest, "退货报表解析失败")
	}
	headers := normalizedHeaders(table.Headers)
	if !hasHeaders(headers, "return-date", "sku") {
		return persistResult{}, uploads.NewAPIError(http.StatusBadRequest, "缺少必要字段: [return-date sku]")
	}
	rows, dates := parseReturnRows(table, headers)
	if len(rows) == 0 {
		return persistResult{}, uploads.NewAPIError(http.StatusBadRequest, "退货报表没有可入库行")
	}
	start := dates[0]
	end := dates[len(dates)-1]
	if recognition != nil {
		if recognition.DetectedStartDate != nil {
			if parsed, err := time.Parse("2006-01-02", *recognition.DetectedStartDate); err == nil {
				start = parsed
			}
		}
		if recognition.DetectedEndDate != nil {
			if parsed, err := time.Parse("2006-01-02", *recognition.DetectedEndDate); err == nil {
				end = parsed
			}
		}
	}
	country := normalizeStoreCountry(payload.Country)
	var sourceID int64
	err = RunInTx(ctx, store.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		id, err := insertAnalysisSource(ctx, txDB, analysisSourceInput{
			ProjectID: project.ID, ReportType: "return_report", Country: country,
			PeriodStart: &start, PeriodEnd: &end, File: file,
			RowCountTotal: len(rows), RowCountIncluded: len(rows),
			CreatedBy: nullableOperator(operator),
		})
		if err != nil {
			return err
		}
		if err := insertReturnRows(ctx, txDB, id, project.ID, country, rows); err != nil {
			return err
		}
		if !payload.UsePeriodDates {
			if err := insertReportUploadLog(
				ctx, txDB, project.ID, "return_report", country, start, id, len(rows),
				file.OriginalFilename,
			); err != nil {
				return err
			}
		}
		sourceID = id
		return nil
	})
	if err != nil {
		return persistResult{}, err
	}
	tableName := "analysis_return_rows"
	message := "退货报表已保存并写入退货数据"
	return persistResult{
		Status: "persisted", SourceID: &sourceID, Table: &tableName, Message: message,
		ReportStartDate: formatDatePointer(&start), ReportEndDate: formatDatePointer(&end),
	}, nil
}

type analysisSourceInput struct {
	ProjectID        int64
	ReportType       string
	Country          string
	ReportDate       *time.Time
	PeriodStart      *time.Time
	PeriodEnd        *time.Time
	SnapshotAt       *time.Time
	File             uploads.PreparedReportFile
	RowCountTotal    int
	RowCountIncluded int
	CreatedBy        *string
}

func insertAnalysisSource(
	ctx context.Context,
	db DB,
	input analysisSourceInput,
) (int64, error) {
	hash, err := fileSHA256(input.File.LocalPath)
	if err != nil {
		return 0, err
	}
	var lock int
	if err := db.QueryRow(
		ctx,
		`SELECT 1 FROM public.projects WHERE id = $1 FOR UPDATE`,
		input.ProjectID,
	).Scan(&lock); err != nil {
		return 0, err
	}
	var version int
	err = db.QueryRow(
		ctx,
		`SELECT coalesce(max(version), 0) + 1
		 FROM public.analysis_source_files
		 WHERE project_id = $1
		   AND report_type = $2
		   AND country = $3
		   AND period_start_date IS NOT DISTINCT FROM $4
		   AND period_end_date IS NOT DISTINCT FROM $5`,
		input.ProjectID,
		input.ReportType,
		input.Country,
		dateArgument(input.PeriodStart),
		dateArgument(input.PeriodEnd),
	).Scan(&version)
	if err != nil {
		return 0, err
	}
	_, err = db.(Execer).Exec(
		ctx,
		`UPDATE public.analysis_source_files
		 SET is_current = false,
		     superseded_at = CASE WHEN is_current THEN now() ELSE superseded_at END
		 WHERE project_id = $1
		   AND report_type = $2
		   AND country = $3
		   AND period_start_date IS NOT DISTINCT FROM $4
		   AND period_end_date IS NOT DISTINCT FROM $5
		   AND is_current IS TRUE`,
		input.ProjectID,
		input.ReportType,
		input.Country,
		dateArgument(input.PeriodStart),
		dateArgument(input.PeriodEnd),
	)
	if err != nil {
		return 0, err
	}
	logicalName := fmt.Sprintf(
		"%s_%s_%s_v%d_%s",
		safeProjectFolder(strings.TrimSpace(input.File.OriginalFilename)),
		input.ReportType,
		periodLabel(input.PeriodStart, input.PeriodEnd, input.SnapshotAt),
		version,
		input.File.Filename,
	)
	var sourceID int64
	err = db.QueryRow(
		ctx,
		`INSERT INTO public.analysis_source_files (
		   project_id, report_type, country, report_date, period_start_date,
		   period_end_date, snapshot_at, version, is_current, superseded_at,
		   upload_file_id, upload_file_path, original_filename, stored_filename,
		   logical_filename, storage_key, file_size_bytes, file_sha256,
		   ingestion_status, ingestion_error, row_count_total, row_count_included,
		   created_by
		 ) VALUES (
		   $1, $2, $3, $4, $5, $6, $7, $8, true, NULL, $9, $10, $11,
		   $12, $13, $14, $15, $16, 'success', NULL, $17, $18, $19
		 )
		RETURNING id`,
		input.ProjectID,
		input.ReportType,
		input.Country,
		dateArgument(input.ReportDate),
		dateArgument(input.PeriodStart),
		dateArgument(input.PeriodEnd),
		timeArgument(input.SnapshotAt),
		version,
		input.File.FileID,
		input.File.FilePath,
		input.File.OriginalFilename,
		input.File.Filename,
		logicalName,
		pathToSlash(input.File.LocalPath),
		input.File.Size,
		hash,
		input.RowCountTotal,
		input.RowCountIncluded,
		input.CreatedBy,
	).Scan(&sourceID)
	return sourceID, err
}

func insertReportUploadLog(
	ctx context.Context,
	db DB,
	projectID int64,
	reportType string,
	country string,
	uploadDate time.Time,
	sourceFileID int64,
	rowCount int,
	originalFilename string,
) error {
	_, err := db.(Execer).Exec(
		ctx,
		`INSERT INTO public.report_upload_logs (
		   project_id, report_type, country, upload_date, has_real_data,
		   row_count, source_file_id, original_filename
		 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		projectID,
		reportType,
		country,
		dateOnly(uploadDate),
		rowCount > 0,
		rowCount,
		sourceFileID,
		originalFilename,
	)
	return err
}

type businessRow struct {
	ASIN               *string
	PageViews          int
	UnitsOrdered       int
	Sessions           int
	OrderedSalesAmount float64
	Raw                map[string]any
}

func parseBusinessRows(table tableData, headers []string) []businessRow {
	asinIndex := findCaseInsensitive(headers, []string{
		"（子）ASIN", "(子)ASIN", "子ASIN", "ASIN", "(Child) ASIN", "(Parent) ASIN",
	})
	pageViewsIndex := findCaseInsensitive(headers, []string{"页面浏览量 - 总计", "页面浏览量-总计", "Page Views - Total"})
	unitsIndex := findCaseInsensitive(headers, []string{"已订购商品数量", "Ordered Product Sales Units", "Units Ordered"})
	sessionsIndex := findCaseInsensitive(headers, []string{"会话数 - 总计", "会话数-总计", "Sessions - Total"})
	salesIndex := findCaseInsensitive(headers, []string{
		"已订购商品销售额", "Ordered Product Sales", "Ordered Product Sales Amount",
	})
	rows := make([]businessRow, 0, len(table.Rows))
	for _, row := range table.Rows {
		rows = append(rows, businessRow{
			ASIN:               nullableRowValue(row, asinIndex),
			PageViews:          parseUploadInt(rowValue(row, pageViewsIndex)),
			UnitsOrdered:       parseUploadInt(rowValue(row, unitsIndex)),
			Sessions:           parseUploadInt(rowValue(row, sessionsIndex)),
			OrderedSalesAmount: parseAmount(rowValue(row, salesIndex)),
			Raw:                rawRow(headers, row),
		})
	}
	return rows
}

func insertBusinessRows(ctx context.Context, db DB, sourceID int64, rows []businessRow) error {
	for index, row := range rows {
		raw, err := json.Marshal(row.Raw)
		if err != nil {
			return err
		}
		_, err = db.(Execer).Exec(
			ctx,
			`INSERT INTO public.analysis_business_rows (
			   source_file_id, source_row_no, asin, page_views, units_ordered,
			   sessions, ordered_sales_amount, raw_row
			 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			 ON CONFLICT (source_file_id, source_row_no) DO UPDATE SET
			   asin = EXCLUDED.asin,
			   page_views = EXCLUDED.page_views,
			   units_ordered = EXCLUDED.units_ordered,
			   sessions = EXCLUDED.sessions,
			   ordered_sales_amount = EXCLUDED.ordered_sales_amount,
			   raw_row = EXCLUDED.raw_row`,
			sourceID, index+1, row.ASIN, row.PageViews, row.UnitsOrdered,
			row.Sessions, row.OrderedSalesAmount, raw,
		)
		if err != nil {
			return err
		}
	}
	return nil
}

type inventoryRow struct {
	SKU               *string
	ASIN              *string
	AvailableQty      int
	Age0To90          int
	Age91To180        int
	Age181To270       int
	Age271To365       int
	Age365Plus        int
	RecommendedAction *string
	StockStatus       string
	AgingStatus       string
	Raw               map[string]any
}

func parseInventoryRows(table tableData, headers []string) []inventoryRow {
	rows := make([]inventoryRow, 0, len(table.Rows))
	for _, row := range table.Rows {
		available := parseUploadInt(headerValue(row, headers, "available"))
		age91 := parseUploadInt(headerValue(row, headers, "inv-age-91-to-180-days"))
		age181 := parseUploadInt(headerValue(row, headers, "inv-age-181-to-270-days"))
		age271 := parseUploadInt(headerValue(row, headers, "inv-age-271-to-365-days"))
		age365 := parseUploadInt(headerValue(row, headers, "inv-age-365-plus-days"))
		stock := "in_stock"
		if available <= 0 {
			stock = "out_of_stock"
		}
		aging := "fresh"
		if age365 > 0 {
			aging = "over_aged"
		} else if age91+age181+age271 > 0 {
			aging = "aging"
		}
		rows = append(rows, inventoryRow{
			SKU:               nullableHeaderValue(row, headers, "sku"),
			ASIN:              nullableHeaderValue(row, headers, "asin"),
			AvailableQty:      available,
			Age0To90:          parseUploadInt(headerValue(row, headers, "inv-age-0-to-90-days")),
			Age91To180:        age91,
			Age181To270:       age181,
			Age271To365:       age271,
			Age365Plus:        age365,
			RecommendedAction: nullableHeaderValue(row, headers, "recommended-action"),
			StockStatus:       stock,
			AgingStatus:       aging,
			Raw:               rawRow(headers, row),
		})
	}
	return rows
}

func insertInventoryRows(ctx context.Context, db DB, sourceID int64, rows []inventoryRow) error {
	for index, row := range rows {
		raw, err := json.Marshal(row.Raw)
		if err != nil {
			return err
		}
		_, err = db.(Execer).Exec(
			ctx,
			`INSERT INTO public.inventory_snapshot_rows (
			   source_file_id, source_row_no, sku, asin, available_qty,
			   age_0_90_qty, age_91_180_qty, age_181_270_qty, age_271_365_qty,
			   age_365_plus_qty, recommended_action, stock_status, aging_status, raw_row
			 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
			 ON CONFLICT (source_file_id, source_row_no) DO UPDATE SET
			   sku = EXCLUDED.sku,
			   asin = EXCLUDED.asin,
			   available_qty = EXCLUDED.available_qty,
			   age_0_90_qty = EXCLUDED.age_0_90_qty,
			   age_91_180_qty = EXCLUDED.age_91_180_qty,
			   age_181_270_qty = EXCLUDED.age_181_270_qty,
			   age_271_365_qty = EXCLUDED.age_271_365_qty,
			   age_365_plus_qty = EXCLUDED.age_365_plus_qty,
			   recommended_action = EXCLUDED.recommended_action,
			   stock_status = EXCLUDED.stock_status,
			   aging_status = EXCLUDED.aging_status,
			   raw_row = EXCLUDED.raw_row`,
			sourceID, index+1, row.SKU, row.ASIN, row.AvailableQty,
			row.Age0To90, row.Age91To180, row.Age181To270, row.Age271To365,
			row.Age365Plus, row.RecommendedAction, row.StockStatus, row.AgingStatus, raw,
		)
		if err != nil {
			return err
		}
	}
	return nil
}

type paymentRow struct {
	TransactionAt          *time.Time
	TransactionType        string
	OrderID                *string
	SKU                    *string
	ASIN                   *string
	Quantity               int
	ProductSales           float64
	ShippingCredits        float64
	PromotionalRebates     float64
	OtherAmount            float64
	SellingFees            float64
	FBAFees                float64
	TotalAmount            float64
	TransactionStatus      *string
	TransactionReleaseDate *time.Time
	Raw                    map[string]any
}

func parsePaymentRows(table tableData, headers []string) []paymentRow {
	asinHeader := "asin"
	if headerIndex(headers, asinHeader) < 0 {
		asinHeader = "ASIN"
	}
	rows := make([]paymentRow, 0, len(table.Rows))
	for _, row := range table.Rows {
		total := parseAmount(headerValue(row, headers, "total"))
		if !hasHeaders(headers, "total") {
			total = parseAmount(headerValue(row, headers, "product sales")) +
				parseAmount(headerValue(row, headers, "shipping credits")) +
				parseAmount(headerValue(row, headers, "promotional rebates")) +
				parseAmount(headerValue(row, headers, "other")) +
				parseAmount(headerValue(row, headers, "selling fees")) +
				parseAmount(headerValue(row, headers, "fba fees"))
		}
		rows = append(rows, paymentRow{
			TransactionAt:          parseTimestampPointer(headerValue(row, headers, "date/time")),
			TransactionType:        firstNonEmpty([]string{headerValue(row, headers, "type")}, "UNKNOWN"),
			OrderID:                nullableHeaderValue(row, headers, "order id"),
			SKU:                    nullableHeaderValue(row, headers, "sku"),
			ASIN:                   nullableHeaderValue(row, headers, asinHeader),
			Quantity:               parseUploadInt(headerValue(row, headers, "quantity")),
			ProductSales:           parseAmount(headerValue(row, headers, "product sales")),
			ShippingCredits:        parseAmount(headerValue(row, headers, "shipping credits")),
			PromotionalRebates:     parseAmount(headerValue(row, headers, "promotional rebates")),
			OtherAmount:            parseAmount(headerValue(row, headers, "other")),
			SellingFees:            parseAmount(headerValue(row, headers, "selling fees")),
			FBAFees:                parseAmount(headerValue(row, headers, "fba fees")),
			TotalAmount:            total,
			TransactionStatus:      nullableHeaderValue(row, headers, "transaction status"),
			TransactionReleaseDate: parseTimestampPointer(headerValue(row, headers, "transaction release date")),
			Raw:                    rawRow(headers, row),
		})
	}
	return rows
}

func insertPaymentRows(
	ctx context.Context,
	db DB,
	sourceID int64,
	rows []paymentRow,
	known identifierSet,
) error {
	for index, row := range rows {
		scope, reason := classifyScope(row.SKU, row.ASIN, known)
		raw, err := json.Marshal(row.Raw)
		if err != nil {
			return err
		}
		_, err = db.(Execer).Exec(
			ctx,
			`INSERT INTO public.analysis_payment_rows (
			   source_file_id, source_row_no, transaction_at, transaction_type,
			   order_id, sku, asin, quantity, product_sales, shipping_credits,
			   promotional_rebates, other_amount, selling_fees, fba_fees,
			   total_amount, scope_status, scope_reason, transaction_status,
			   transaction_release_date, raw_row
			 ) VALUES (
			   $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
			   $14, $15, $16, $17, $18, $19, $20
			 )
			 ON CONFLICT (source_file_id, source_row_no) DO UPDATE SET
			   transaction_at = EXCLUDED.transaction_at,
			   transaction_type = EXCLUDED.transaction_type,
			   order_id = EXCLUDED.order_id,
			   sku = EXCLUDED.sku,
			   asin = EXCLUDED.asin,
			   quantity = EXCLUDED.quantity,
			   product_sales = EXCLUDED.product_sales,
			   shipping_credits = EXCLUDED.shipping_credits,
			   promotional_rebates = EXCLUDED.promotional_rebates,
			   other_amount = EXCLUDED.other_amount,
			   selling_fees = EXCLUDED.selling_fees,
			   fba_fees = EXCLUDED.fba_fees,
			   total_amount = EXCLUDED.total_amount,
			   scope_status = EXCLUDED.scope_status,
			   scope_reason = EXCLUDED.scope_reason,
			   transaction_status = EXCLUDED.transaction_status,
			   transaction_release_date = EXCLUDED.transaction_release_date,
			   raw_row = EXCLUDED.raw_row`,
			sourceID, index+1, row.TransactionAt, row.TransactionType,
			row.OrderID, row.SKU, row.ASIN, row.Quantity, row.ProductSales,
			row.ShippingCredits, row.PromotionalRebates, row.OtherAmount,
			row.SellingFees, row.FBAFees, row.TotalAmount, scope, reason,
			row.TransactionStatus, row.TransactionReleaseDate, raw,
		)
		if err != nil {
			return err
		}
	}
	return nil
}

type salesRow struct {
	Country         string
	AmazonOrderID   string
	PurchaseAtUTC   time.Time
	PurchaseAtLocal time.Time
	PurchaseDate    string
	OrderStatus     string
	SKU             *string
	ASIN            *string
	Quantity        int
	ItemPrice       float64
	ShippingPrice   float64
	ItemTax         float64
	ShippingTax     float64
	Currency        *string
	IsCountedSales  bool
	Raw             map[string]any
}

func parseSalesRows(
	table tableData,
	headers []string,
	country string,
	asOf time.Time,
) []salesRow {
	rows := make([]salesRow, 0, len(table.Rows))
	location := countryLocation(country)
	if location == nil {
		location = time.UTC
	}
	channelIndex := headerIndex(headers, "sales-channel")
	if channelIndex < 0 {
		channelIndex = headerIndex(headers, "sales channel")
	}
	for _, row := range table.Rows {
		orderID := headerValue(row, headers, "amazon-order-id")
		purchase := parseTimestamp(headerValue(row, headers, "purchase-date"), country)
		if orderID == "" || purchase.IsZero() {
			continue
		}
		local := purchase.In(location)
		date := local.Format("2006-01-02")
		status := headerValue(row, headers, "order-status")
		counted := isCountedSalesStatus(status, date, asOf.Format("2006-01-02"))
		rowCountry := country
		if channelIndex >= 0 && channelIndex < len(row) {
			channel := strings.ToLower(row[channelIndex])
			switch {
			case strings.Contains(channel, "amazon.co.uk"):
				rowCountry = "UK"
			case strings.Contains(channel, "amazon.de"):
				rowCountry = "DE"
			case strings.Contains(channel, "amazon.fr"):
				rowCountry = "FR"
			}
		}
		rows = append(rows, salesRow{
			Country:         rowCountry,
			AmazonOrderID:   orderID,
			PurchaseAtUTC:   purchase.UTC(),
			PurchaseAtLocal: local,
			PurchaseDate:    date,
			OrderStatus:     firstNonEmpty([]string{status}, "UNKNOWN"),
			SKU:             nullableHeaderValue(row, headers, "sku"),
			ASIN:            nullableHeaderValue(row, headers, "asin"),
			Quantity:        parseUploadInt(headerValue(row, headers, "quantity")),
			ItemPrice:       parseAmount(headerValue(row, headers, "item-price")),
			ShippingPrice:   parseAmount(headerValue(row, headers, "shipping-price")),
			ItemTax:         parseAmount(headerValue(row, headers, "item-tax")),
			ShippingTax:     parseAmount(headerValue(row, headers, "shipping-tax")),
			Currency:        nullableHeaderValue(row, headers, "currency"),
			IsCountedSales:  counted,
			Raw:             rawRow(headers, row),
		})
	}
	return rows
}

func insertSalesRows(ctx context.Context, db DB, sourceID int64, rows []salesRow) error {
	for index, row := range rows {
		raw, err := json.Marshal(row.Raw)
		if err != nil {
			return err
		}
		_, err = db.(Execer).Exec(
			ctx,
			`INSERT INTO public.analysis_sales_order_rows (
			   source_file_id, source_row_no, project_id, data_version,
			   country, amazon_order_id, purchase_at_utc, purchase_at_pt,
			   purchase_date_pt, order_status, sku, asin, quantity, item_price,
			   shipping_price, item_tax, shipping_tax, currency,
			   is_counted_sales, status_rule_version, raw_row
			 ) SELECT
			   $1, $2, p.id, coalesce(existing.data_version, 0) + 1,
			   $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
			   $17, $18, 1, $19
			 FROM public.analysis_source_files s
			 JOIN public.projects p ON p.id = s.project_id
			 LEFT JOIN public.analysis_sales_order_rows existing
			   ON existing.project_id = p.id
			  AND existing.amazon_order_id = $5
			  AND existing.sku IS NOT DISTINCT FROM $10
			  AND existing.country = $4
			  AND existing.purchase_date_pt = $8
			 WHERE s.id = $1
			 ON CONFLICT (
			   project_id, amazon_order_id, sku, country, purchase_date_pt
			 ) DO UPDATE SET
			   source_file_id = EXCLUDED.source_file_id,
			   source_row_no = EXCLUDED.source_row_no,
			   data_version = analysis_sales_order_rows.data_version + 1,
			   purchase_at_utc = EXCLUDED.purchase_at_utc,
			   purchase_at_pt = EXCLUDED.purchase_at_pt,
			   order_status = EXCLUDED.order_status,
			   asin = EXCLUDED.asin,
			   quantity = EXCLUDED.quantity,
			   item_price = EXCLUDED.item_price,
			   shipping_price = EXCLUDED.shipping_price,
			   item_tax = EXCLUDED.item_tax,
			   shipping_tax = EXCLUDED.shipping_tax,
			   currency = EXCLUDED.currency,
			   is_counted_sales = EXCLUDED.is_counted_sales,
			   status_rule_version = EXCLUDED.status_rule_version,
			   raw_row = EXCLUDED.raw_row`,
			sourceID, index+1, row.PurchaseAtUTC, row.Country, row.AmazonOrderID,
			row.PurchaseAtUTC, row.PurchaseAtLocal, saleDateArgument(row.PurchaseDate),
			row.OrderStatus, row.SKU, row.ASIN, row.Quantity, row.ItemPrice,
			row.ShippingPrice, row.ItemTax, row.ShippingTax, row.Currency,
			row.IsCountedSales, raw,
		)
		if err != nil {
			return err
		}
	}
	return nil
}

type returnRow struct {
	ReturnDate          time.Time
	OriginalDateTime    string
	OrderID             string
	SKU                 string
	ASIN                *string
	FNSKU               *string
	ProductName         *string
	Quantity            int
	FulfillmentCenter   *string
	DetailedDisposition string
	Reason              string
	Status              string
	LicensePlate        string
	CustomerComments    *string
	Raw                 map[string]any
}

func parseReturnRows(table tableData, headers []string) ([]returnRow, []time.Time) {
	rows := make([]returnRow, 0, len(table.Rows))
	dates := make([]time.Time, 0, len(table.Rows))
	for _, row := range table.Rows {
		original := headerValue(row, headers, "return-date")
		parsed := parseTimestamp(original, "US")
		if original == "" || parsed.IsZero() {
			continue
		}
		orderID := headerValue(row, headers, "order-id")
		sku := headerValue(row, headers, "sku")
		if orderID == "" || sku == "" {
			continue
		}
		rows = append(rows, returnRow{
			ReturnDate:          parsed,
			OriginalDateTime:    original,
			OrderID:             orderID,
			SKU:                 sku,
			ASIN:                nullableHeaderValue(row, headers, "asin"),
			FNSKU:               nullableHeaderValue(row, headers, "fnsku"),
			ProductName:         nullableHeaderValue(row, headers, "product-name"),
			Quantity:            maxInt(1, parseUploadInt(headerValue(row, headers, "quantity"))),
			FulfillmentCenter:   nullableHeaderValue(row, headers, "fulfillment-center-id"),
			DetailedDisposition: headerValue(row, headers, "detailed-disposition"),
			Reason:              headerValue(row, headers, "reason"),
			Status:              headerValue(row, headers, "status"),
			LicensePlate:        headerValue(row, headers, "license-plate-number"),
			CustomerComments:    nullableHeaderValue(row, headers, "customer-comments"),
			Raw:                 rawRow(headers, row),
		})
		dates = append(dates, parsed)
	}
	sort.Slice(dates, func(i, j int) bool { return dates[i].Before(dates[j]) })
	return rows, dates
}

func insertReturnRows(
	ctx context.Context,
	db DB,
	sourceID int64,
	projectID int64,
	country string,
	rows []returnRow,
) error {
	for index, row := range rows {
		raw, err := json.Marshal(row.Raw)
		if err != nil {
			return err
		}
		_, err = db.(Execer).Exec(
			ctx,
			`INSERT INTO public.analysis_return_rows (
			   project_id, country, source_file_id, source_row_no, return_date,
			   order_id, sku, asin, fnsku, product_name, quantity,
			   fulfillment_center_id, detailed_disposition, reason, status,
			   license_plate_number, original_return_datetime, customer_comments, raw_row
			 ) VALUES (
			   $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
			   $14, $15, $16, $17, $18, $19
			 )
			 ON CONFLICT (project_id, country, order_id, sku, return_date, license_plate_number)
			 DO UPDATE SET
			   source_file_id = EXCLUDED.source_file_id,
			   source_row_no = EXCLUDED.source_row_no,
			   asin = EXCLUDED.asin,
			   fnsku = EXCLUDED.fnsku,
			   product_name = EXCLUDED.product_name,
			   quantity = EXCLUDED.quantity,
			   fulfillment_center_id = EXCLUDED.fulfillment_center_id,
			   detailed_disposition = EXCLUDED.detailed_disposition,
			   reason = EXCLUDED.reason,
			   status = EXCLUDED.status,
			   original_return_datetime = EXCLUDED.original_return_datetime,
			   customer_comments = EXCLUDED.customer_comments,
			   raw_row = EXCLUDED.raw_row`,
			projectID, country, sourceID, index+1, dateOnly(row.ReturnDate),
			row.OrderID, row.SKU, row.ASIN, row.FNSKU, row.ProductName, row.Quantity,
			row.FulfillmentCenter, row.DetailedDisposition, row.Reason, row.Status,
			row.LicensePlate, row.OriginalDateTime, row.CustomerComments, raw,
		)
		if err != nil {
			return err
		}
	}
	return nil
}

type identifierSet struct {
	SKUs  map[string]bool
	ASINs map[string]bool
}

func (store *UploadStore) projectIdentifiers(
	ctx context.Context,
	project projectRow,
	country string,
) (identifierSet, error) {
	rows, err := store.db.Query(
		ctx,
		// SkuRecord maps to product_costs (backend/app/models/sku_info.py); there
		// is no sku_records table, so the old query failed at runtime.
		`SELECT sku, asin FROM public.product_costs
		 WHERE project_name = $1 AND country = $2`,
		project.Name,
		country,
	)
	if err != nil {
		return identifierSet{}, err
	}
	defer rows.Close()
	result := identifierSet{SKUs: map[string]bool{}, ASINs: map[string]bool{}}
	for rows.Next() {
		var sku, asin *string
		if err := rows.Scan(&sku, &asin); err != nil {
			return identifierSet{}, err
		}
		if sku != nil {
			result.SKUs[normalizeIdentifier(*sku)] = true
		}
		if asin != nil {
			result.ASINs[normalizeIdentifier(*asin)] = true
		}
	}
	return result, rows.Err()
}

func matchesKnownIdentifier(sku, asin *string, known identifierSet) bool {
	if sku != nil && known.SKUs[normalizeIdentifier(*sku)] {
		return true
	}
	if asin != nil && known.ASINs[normalizeIdentifier(*asin)] {
		return true
	}
	return false
}

func classifyScope(sku, asin *string, known identifierSet) (string, *string) {
	if (sku == nil || strings.TrimSpace(*sku) == "") &&
		(asin == nil || strings.TrimSpace(*asin) == "") {
		reason := "missing sku/asin"
		return "excluded_store_level", &reason
	}
	if matchesKnownIdentifier(sku, asin, known) {
		return "included_product", nil
	}
	reason := "sku/asin not found in product_costs"
	return "excluded_unmapped", &reason
}

func countIncludedSales(rows []salesRow) int {
	count := 0
	for _, row := range rows {
		if row.IsCountedSales {
			count++
		}
	}
	return count
}

func isCountedSalesStatus(status string, purchaseDate string, asOf string) bool {
	normalized := strings.ToLower(strings.TrimSpace(status))
	if normalized == "cancelled" || normalized == "canceled" {
		return false
	}
	purchase, err := time.Parse("2006-01-02", purchaseDate)
	if err != nil {
		return false
	}
	asOfDate, err := time.Parse("2006-01-02", asOf)
	if err != nil {
		return false
	}
	ageDays := int(asOfDate.Sub(purchase).Hours() / 24)
	if ageDays <= 7 {
		return normalized == "pending" || normalized == "unshipped" || normalized == "shipped"
	}
	return normalized == "shipped"
}

func resolveReportPeriod(
	payload uploads.CommitRequest,
	recognition *uploads.RecognitionResponse,
	allowSingleDate bool,
) (*time.Time, *time.Time, *time.Time, error) {
	var reportDate *time.Time
	if value := trimmedValue(payload.ReportDate); value != "" {
		parsed, err := time.Parse("2006-01-02", value)
		if err != nil {
			return nil, nil, nil, uploads.NewAPIError(http.StatusBadRequest, "report_date must be YYYY-MM-DD")
		}
		reportDate = &parsed
	} else if recognition != nil && recognition.DetectedDate != nil {
		if parsed, err := time.Parse("2006-01-02", *recognition.DetectedDate); err == nil {
			reportDate = &parsed
		}
	}

	var start, end *time.Time
	if value := trimmedValue(payload.ReportStartDate); value != "" {
		parsed, err := time.Parse("2006-01-02", value)
		if err != nil {
			return nil, nil, nil, uploads.NewAPIError(http.StatusBadRequest, "report_start_date must be YYYY-MM-DD")
		}
		start = &parsed
	} else if recognition != nil && recognition.DetectedStartDate != nil {
		if parsed, err := time.Parse("2006-01-02", *recognition.DetectedStartDate); err == nil {
			start = &parsed
		}
	}
	if value := trimmedValue(payload.ReportEndDate); value != "" {
		parsed, err := time.Parse("2006-01-02", value)
		if err != nil {
			return nil, nil, nil, uploads.NewAPIError(http.StatusBadRequest, "report_end_date must be YYYY-MM-DD")
		}
		end = &parsed
	} else if recognition != nil && recognition.DetectedEndDate != nil {
		if parsed, err := time.Parse("2006-01-02", *recognition.DetectedEndDate); err == nil {
			end = &parsed
		}
	}
	if allowSingleDate && reportDate != nil {
		if start == nil {
			start = reportDate
		}
		if end == nil {
			end = reportDate
		}
	}
	if start == nil && reportDate != nil && !allowSingleDate && payload.UsePeriodDates {
		start = reportDate
	}
	if end == nil && reportDate != nil && !allowSingleDate && payload.UsePeriodDates {
		end = reportDate
	}
	if start != nil && end != nil && start.After(*end) {
		return nil, nil, nil, uploads.NewAPIError(
			http.StatusBadRequest,
			"report_start_date cannot be greater than report_end_date",
		)
	}
	return start, end, reportDate, nil
}

func dateArgument(value *time.Time) any {
	if value == nil {
		return nil
	}
	return dateOnly(*value)
}

func timeArgument(value *time.Time) any {
	if value == nil {
		return nil
	}
	return value.UTC()
}

func saleDateArgument(value string) any {
	parsed, err := time.Parse("2006-01-02", value)
	if err != nil {
		return value
	}
	return dateOnly(parsed)
}

func dateOnly(value time.Time) time.Time {
	return time.Date(value.Year(), value.Month(), value.Day(), 0, 0, 0, 0, time.UTC)
}

func formatDatePointer(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := value.Format("2006-01-02")
	return &formatted
}

func periodLabel(start, end, snapshot *time.Time) string {
	if snapshot != nil {
		return snapshot.Format("20060102")
	}
	if start != nil && end != nil {
		return start.Format("20060102") + "_" + end.Format("20060102")
	}
	if start != nil {
		return start.Format("20060102")
	}
	return "snapshot"
}

func nullableOperator(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	if len([]rune(value)) > 255 {
		value = string([]rune(value)[:255])
	}
	return &value
}

func timePointer(value time.Time) *time.Time {
	return &value
}

func trimSpaceHeaders(headers []string) []string {
	result := make([]string, len(headers))
	for index, header := range headers {
		result[index] = strings.TrimSpace(header)
	}
	return result
}

func findCaseInsensitive(headers []string, candidates []string) int {
	for index, header := range headers {
		for _, candidate := range candidates {
			if strings.EqualFold(strings.TrimSpace(header), candidate) {
				return index
			}
		}
	}
	return -1
}

func rowValue(row []string, index int) string {
	if index < 0 || index >= len(row) {
		return ""
	}
	return strings.TrimSpace(row[index])
}

func nullableRowValue(row []string, index int) *string {
	value := rowValue(row, index)
	if value == "" || strings.EqualFold(value, "nan") {
		return nil
	}
	return &value
}

func nullableHeaderValue(row []string, headers []string, name string) *string {
	index := headerIndex(headers, strings.ToLower(name))
	if index < 0 {
		index = headerIndex(headers, name)
	}
	return nullableRowValue(row, index)
}

func parseAmount(value string) float64 {
	value = strings.TrimSpace(value)
	if value == "" || strings.EqualFold(value, "nan") {
		return 0
	}
	negative := strings.HasPrefix(value, "(") && strings.HasSuffix(value, ")")
	var builder strings.Builder
	dotSeen := false
	lastWasDigit := false
	for _, r := range value {
		switch {
		case r >= '0' && r <= '9':
			builder.WriteRune(r)
			lastWasDigit = true
		case (r == '.' || r == ',') && !dotSeen:
			builder.WriteByte('.')
			dotSeen = true
			lastWasDigit = false
		case r == '-' && builder.Len() == 0:
			builder.WriteRune(r)
		}
	}
	text := strings.TrimSuffix(builder.String(), ".")
	parsed, err := strconv.ParseFloat(text, 64)
	if err != nil {
		return 0
	}
	if negative && parsed > 0 {
		return -parsed
	}
	_ = lastWasDigit
	return parsed
}

func parseUploadInt(value string) int {
	text := strings.TrimSpace(value)
	if text == "" {
		return 0
	}
	negative := strings.HasPrefix(text, "(") && strings.HasSuffix(text, ")")
	var builder strings.Builder
	for _, r := range text {
		if r >= '0' && r <= '9' {
			builder.WriteRune(r)
		}
	}
	parsed, err := strconv.Atoi(builder.String())
	if err != nil {
		if value := parseAmount(text); value != 0 {
			return int(math.Round(value))
		}
		return 0
	}
	if negative {
		parsed = -parsed
	}
	return parsed
}

func parseTimestampPointer(value string) *time.Time {
	parsed := parseTimestamp(value, "US")
	if parsed.IsZero() {
		return nil
	}
	return &parsed
}

func rawRow(headers []string, row []string) map[string]any {
	result := make(map[string]any, len(headers))
	for index, header := range headers {
		if index < len(row) {
			result[header] = row[index]
		} else {
			result[header] = nil
		}
	}
	return result
}

func maxInt(left, right int) int {
	if left > right {
		return left
	}
	return right
}

// RedisDailyAnalysisCacheInvalidator mirrors FastAPI's
// invalidate_daily_analysis_cache: delete per-project cache keys and advance
// the global daily-all data epoch so stale snapshots are ignored.
type RedisDailyAnalysisCacheInvalidator struct {
	client    redis.UniversalClient
	keyPrefix string
}

func NewRedisDailyAnalysisCacheInvalidator(
	client redis.UniversalClient,
	keyPrefix string,
) *RedisDailyAnalysisCacheInvalidator {
	keyPrefix = strings.Trim(strings.TrimSpace(keyPrefix), ":")
	if keyPrefix == "" {
		keyPrefix = "bb"
	}
	return &RedisDailyAnalysisCacheInvalidator{client: client, keyPrefix: keyPrefix}
}

func (invalidator *RedisDailyAnalysisCacheInvalidator) InvalidateDailyAnalysis(
	ctx context.Context,
	projectID int64,
) error {
	if invalidator == nil || invalidator.client == nil {
		return errors.New("daily analysis cache invalidator is not configured")
	}
	pattern := fmt.Sprintf(
		"%s:cache:reports:daily:project:%d:*",
		invalidator.keyPrefix,
		projectID,
	)
	cursor := uint64(0)
	for {
		keys, next, err := invalidator.client.Scan(ctx, cursor, pattern, 1000).Result()
		if err != nil {
			return fmt.Errorf("scan daily analysis cache: %w", err)
		}
		if len(keys) > 0 {
			if err := invalidator.client.Del(ctx, keys...).Err(); err != nil {
				return fmt.Errorf("delete daily analysis cache: %w", err)
			}
		}
		cursor = next
		if cursor == 0 {
			break
		}
	}

	epochKey := invalidator.keyPrefix + ":cache:reports:daily-all:data-epoch"
	epochPayload, err := json.Marshal(map[string]float64{
		"at": float64(time.Now().UTC().UnixNano()) / float64(time.Second),
	})
	if err != nil {
		return fmt.Errorf("marshal daily analysis epoch: %w", err)
	}
	if err := invalidator.client.Set(ctx, epochKey, epochPayload, 24*time.Hour).Err(); err != nil {
		return fmt.Errorf("set daily analysis epoch: %w", err)
	}
	return nil
}
