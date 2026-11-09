package store

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ad_upload"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/agent_credentials"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/uploads"
)

type AgentCredentialUploadStore struct {
	db         FullDB
	reportRoot string
	maxBytes   int64
	reports    *UploadStore
	ads        *AdUploadStore
}

var _ agent_credentials.UploadStore = (*AgentCredentialUploadStore)(nil)

func NewAgentCredentialUploadStore(
	db FullDB,
	uploadRoot string,
	maxBytes int64,
	invalidators ...uploads.CacheInvalidator,
) *AgentCredentialUploadStore {
	if maxBytes <= 0 {
		maxBytes = defaultUploadMaxBytes
	}
	return &AgentCredentialUploadStore{
		db:         db,
		reportRoot: uploadRoot,
		maxBytes:   maxBytes,
		reports:    NewUploadStore(db, uploadRoot, maxBytes, invalidators...),
		ads:        NewAdUploadStore(db),
	}
}

func (store *AgentCredentialUploadStore) Validate(
	_ context.Context,
	request agent_credentials.AgentUploadValidateRequest,
) (*agent_credentials.AgentUploadValidateResponse, error) {
	if store == nil || store.reports == nil {
		return nil, agent_credentials.ErrUploadDependencyMissing
	}
	if int64(len(request.Data)) > store.maxBytes {
		return nil, uploads.NewAPIError(http.StatusRequestEntityTooLarge, "File too large")
	}
	reportType := normalizeReportType(request.ReportType)
	country := normalizeStoreCountry(request.Country)
	if country == "" {
		return nil, uploads.NewAPIError(
			http.StatusBadRequest,
			"country must be one of: DE, UK, US",
		)
	}
	saved, err := store.reports.SaveReportTemp(request.Filename, request.Data)
	if err != nil {
		return nil, err
	}
	if strings.EqualFold(filepath.Ext(saved.OriginalFilename), ".xlsx") {
		if response := store.validateAdUpload(saved, request.Data, country); response != nil {
			return response, nil
		}
		return invalidAgentUploadResponse(
			saved,
			reportType,
			country,
			fmt.Sprintf("文件类型无法识别（声明类型: %s)", reportType),
			nil,
		), nil
	}
	result, recognitionErr := recognizeLocalFile(saved.Path, saved.OriginalFilename, country)
	if recognitionErr == nil && result != nil && result.Status == "recognized" {
		return buildAgentValidateResponse(result, saved, reportType, country), nil
	}
	if response := store.validateAdUpload(saved, request.Data, country); response != nil {
		return response, nil
	}
	warning := fmt.Sprintf("文件类型无法识别（声明类型: %s)", reportType)
	if recognitionErr != nil {
		warning = recognitionErr.Error()
	}
	return invalidAgentUploadResponse(saved, reportType, country, warning, nil), nil
}

func (store *AgentCredentialUploadStore) Commit(
	ctx context.Context,
	request agent_credentials.AgentUploadCommitRequest,
	projectScope string,
) (*agent_credentials.AgentUploadCommitResponse, error) {
	if store == nil || store.reports == nil || store.db == nil {
		return nil, agent_credentials.ErrUploadDependencyMissing
	}
	reportType := normalizeReportType(request.ReportType)
	country := normalizeStoreCountry(request.Country)
	if country == "" {
		return nil, uploads.NewAPIError(
			http.StatusBadRequest,
			"country must be one of: DE, UK, US",
		)
	}
	projectName := ""
	if request.ProjectName != nil {
		projectName = strings.TrimSpace(*request.ProjectName)
	}
	if projectName == "" {
		return nil, uploads.NewAPIError(
			http.StatusUnprocessableEntity,
			"project_name 必填（agent 通道不支持自动匹配入库）",
		)
	}
	projectID, active, err := store.projectByName(ctx, projectName)
	if err != nil {
		return nil, err
	}
	if !active || projectID <= 0 || !agentProjectScopeAllows(projectScope, projectID) {
		return nil, agent_credentials.ErrAgentProjectOutOfScope
	}

	sourcePath, err := store.reports.ResolveUploadTempPath(request.TempFileID)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(sourcePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, agent_credentials.ErrUploadTempNotFound
		}
		return nil, err
	}
	if info.Size() > store.maxBytes {
		return nil, uploads.NewAPIError(http.StatusRequestEntityTooLarge, "File too large")
	}
	sourceData, err := os.ReadFile(sourcePath)
	if err != nil {
		return nil, err
	}
	originalFilename := strings.TrimSpace(agentDerefString(request.OriginalFilename))
	if originalFilename == "" {
		originalFilename = filepath.Base(sourcePath)
	}

	if parsed, parseErr := parseAdUploadData(originalFilename, sourceData, country); parseErr == nil &&
		isAdReportType(reportType) {
		if parsed.match.spec.reportType != reportType {
			return nil, agent_credentials.ErrUploadTypeMismatch
		}
		return store.commitAdUpload(
			ctx,
			request,
			parsed,
			projectName,
			country,
			sourcePath,
			sourceData,
			originalFilename,
		)
	}

	response, err := store.reports.CommitReport(
		ctx,
		uploads.CommitRequest{
			TempFileID:       request.TempFileID,
			ReportType:       reportType,
			OriginalFilename: request.OriginalFilename,
			ProjectName:      request.ProjectName,
			ReportDate:       request.ReportDate,
			ReportStartDate:  request.ReportStartDate,
			ReportEndDate:    request.ReportEndDate,
			Country:          country,
			UsePeriodDates:   request.UsePeriodDates,
			DryRun:           request.DryRun,
		},
		"",
		true,
	)
	if err != nil {
		return nil, err
	}
	if !request.DryRun {
		_ = os.Remove(sourcePath)
	}
	return mapAgentCommitResponse(response), nil
}

func (store *AgentCredentialUploadStore) validateAdUpload(
	saved uploads.TempFile,
	data []byte,
	country string,
) *agent_credentials.AgentUploadValidateResponse {
	parsed, err := parseAdUploadData(saved.OriginalFilename, data, country)
	if err != nil {
		return nil
	}
	required := append([]string(nil), parsed.match.spec.requiredColumns...)
	rowCount := len(parsed.rows)
	warnings := []string{}
	if rowCount == 0 {
		warnings = append(warnings, "报表已识别，但当前文件没有业务明细行")
	}
	primaryCountry := parsed.country
	if primaryCountry == "" {
		primaryCountry = country
	}
	return &agent_credentials.AgentUploadValidateResponse{
		TempFileID:        saved.TempFileID,
		OriginalFilename:  saved.OriginalFilename,
		ReportType:        parsed.match.spec.reportType,
		Status:            "valid",
		MatchedColumns:    required,
		MissingColumns:    []string{},
		ColumnMatchRatio:  1,
		DetectedCountries: []string{},
		PrimaryCountry:    primaryCountry,
		RowCountPreview:   &rowCount,
		DateInputMode:     "single_manual",
		DetectedDate:      parsed.detectedReportDate,
		DetectedStartDate: parsed.detectedStartDate,
		DetectedEndDate:   parsed.detectedEndDate,
		Warnings:          warnings,
	}
}

func (store *AgentCredentialUploadStore) commitAdUpload(
	ctx context.Context,
	request agent_credentials.AgentUploadCommitRequest,
	parsed *adParsedFile,
	projectName string,
	country string,
	sourcePath string,
	sourceData []byte,
	originalFilename string,
) (*agent_credentials.AgentUploadCommitResponse, error) {
	extension := parsed.extension
	tempID, err := generateTempID()
	if err != nil {
		return nil, err
	}
	tempPath, err := store.ads.writeAdUploadTempFile(tempID, extension, sourceData)
	if err != nil {
		return nil, err
	}
	adTempID := filepath.Base(tempPath)
	cleanupAdTemp := true
	defer func() {
		if cleanupAdTemp {
			_ = os.Remove(tempPath)
		}
	}()

	adRequest := ad_upload.AdUploadCommitRequest{
		TempFileID:       adTempID,
		ReportType:       normalizeReportType(request.ReportType),
		OriginalFilename: &originalFilename,
		ProjectName:      &projectName,
		Country:          country,
		ReportDate:       request.ReportDate,
		ReportStartDate:  request.ReportStartDate,
		ReportEndDate:    request.ReportEndDate,
		DryRun:           request.DryRun,
	}
	response, err := store.ads.Commit(ctx, adRequest, "", true)
	if err != nil {
		switch {
		case errors.Is(err, ad_upload.ErrProjectNotFound):
			return nil, agent_credentials.ErrAgentProjectOutOfScope
		case errors.Is(err, ad_upload.ErrProjectForbidden):
			return nil, agent_credentials.ErrAgentProjectOutOfScope
		case errors.Is(err, ad_upload.ErrTypeMismatch):
			return nil, agent_credentials.ErrUploadTypeMismatch
		default:
			return nil, err
		}
	}
	if request.DryRun {
		_ = os.Remove(tempPath)
		cleanupAdTemp = false
		projectPtr := &projectName
		return &agent_credentials.AgentUploadCommitResponse{
			ReportType:        response.ReportType,
			Status:            "skipped",
			ProjectName:       projectPtr,
			Country:           response.Country,
			ReportDate:        response.ReportDate,
			ReportStartDate:   stringPointerOrNil(response.ReportStartDate),
			ReportEndDate:     stringPointerOrNil(response.ReportEndDate),
			FileID:            sourceFilenameID(sourcePath),
			FilePath:          sourcePath,
			Message:           response.Message,
			DuplicateWarnings: []uploads.DuplicateWarning{},
		}, nil
	}

	permanent, err := store.finalizeAgentReportFile(
		originalFilename,
		projectName,
		response.ReportType,
		sourceData,
	)
	if err != nil {
		return nil, err
	}
	tag, err := store.db.Exec(
		ctx,
		`update public.ad_upload_files
		    set upload_file_id = $2,
		        upload_file_path = $3,
		        stored_filename = $4,
		        logical_filename = $5
		  where upload_file_id = $1
		    and upload_file_path = $6`,
		adTempID,
		permanent.FileID,
		permanent.FilePath,
		permanent.Filename,
		originalFilename,
		tempPath,
	)
	if err != nil {
		_ = os.Remove(permanent.FilePath)
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		_ = os.Remove(permanent.FilePath)
		return nil, errors.New("ad upload commit did not persist a final file row")
	}
	_ = os.Remove(tempPath)
	cleanupAdTemp = false
	_ = os.Remove(sourcePath)
	projectPtr := &projectName
	sourceID := response.ID
	table := "ad_upload_files"
	return &agent_credentials.AgentUploadCommitResponse{
		ReportType:        response.ReportType,
		Status:            "persisted",
		ProjectName:       projectPtr,
		Country:           response.Country,
		ReportDate:        response.ReportDate,
		ReportStartDate:   stringPointerOrNil(response.ReportStartDate),
		ReportEndDate:     stringPointerOrNil(response.ReportEndDate),
		FileID:            permanent.FileID,
		FilePath:          permanent.FilePath,
		PersistedSourceID: &sourceID,
		PersistedTable:    &table,
		Message:           response.Message,
		DuplicateWarnings: []uploads.DuplicateWarning{},
	}, nil
}

func (store *AgentCredentialUploadStore) finalizeAgentReportFile(
	originalFilename string,
	projectName string,
	reportType string,
	data []byte,
) (uploads.PreparedReportFile, error) {
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
	target, err := resolveControlledPath(store.reportRoot, relative)
	if err != nil {
		return uploads.PreparedReportFile{}, err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o750); err != nil {
		return uploads.PreparedReportFile{}, err
	}
	file, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return uploads.PreparedReportFile{}, err
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		_ = os.Remove(target)
		return uploads.PreparedReportFile{}, err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(target)
		return uploads.PreparedReportFile{}, err
	}
	return uploads.PreparedReportFile{
		FileID:           storedName,
		FilePath:         target,
		Filename:         storedName,
		OriginalFilename: filepath.Base(originalFilename),
		Size:             int64(len(data)),
		LocalPath:        target,
	}, nil
}

func (store *AgentCredentialUploadStore) projectByName(
	ctx context.Context,
	name string,
) (int64, bool, error) {
	var id int64
	var active bool
	err := store.db.QueryRow(
		ctx,
		`select id, coalesce(is_active, true)
		   from public.projects
		  where project_name = $1
		  limit 1`,
		name,
	).Scan(&id, &active)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	return id, active, nil
}

func buildAgentValidateResponse(
	result *uploads.RecognitionResponse,
	saved uploads.TempFile,
	declared string,
	country string,
) *agent_credentials.AgentUploadValidateResponse {
	required := agentRequiredColumns[declared]
	matchedLower := make(map[string]bool, len(result.MatchedColumns))
	for _, column := range result.MatchedColumns {
		matchedLower[strings.ToLower(strings.TrimSpace(column))] = true
	}
	matched := make([]string, 0, len(required))
	missing := make([]string, 0, len(required))
	for _, column := range required {
		if matchedLower[strings.ToLower(column)] {
			matched = append(matched, column)
		} else {
			missing = append(missing, column)
		}
	}
	ratio := 1.0
	if len(required) > 0 {
		ratio = float64(len(matched)) / float64(len(required))
	}
	status := "valid"
	warnings := append([]string(nil), result.Warnings...)
	if len(missing) > 0 {
		if ratio >= 0.5 {
			status = "warning"
		} else {
			status = "invalid"
		}
		warnings = append(
			warnings,
			fmt.Sprintf("列不匹配：声明 %s 但缺少 %s", declared, strings.Join(missing, " ")),
		)
	}
	suggested := suggestAgentReportType(result.MatchedColumns)
	detectedCountries := append([]string(nil), result.DetectedCountries...)
	if detectedCountries == nil {
		detectedCountries = []string{}
	}
	primaryCountry := country
	if result.PrimaryCountry != nil && strings.TrimSpace(*result.PrimaryCountry) != "" {
		primaryCountry = *result.PrimaryCountry
	} else if strings.TrimSpace(result.Country) != "" {
		primaryCountry = result.Country
	}
	reportType := result.ReportType
	if reportType == "" {
		reportType = "unknown"
	}
	dateInputMode := result.DateInputMode
	if dateInputMode == "" {
		dateInputMode = "single_manual"
	}
	return &agent_credentials.AgentUploadValidateResponse{
		TempFileID:          saved.TempFileID,
		OriginalFilename:    saved.OriginalFilename,
		ReportType:          reportType,
		Status:              status,
		MatchedColumns:      matched,
		MissingColumns:      missing,
		ColumnMatchRatio:    ratio,
		DetectedCountries:   detectedCountries,
		PrimaryCountry:      primaryCountry,
		RowCountPreview:     result.RowCountPreview,
		DateInputMode:       dateInputMode,
		DetectedDate:        result.DetectedDate,
		DetectedStartDate:   result.DetectedStartDate,
		DetectedEndDate:     result.DetectedEndDate,
		SuggestedReportType: suggested,
		Warnings:            warnings,
	}
}

func invalidAgentUploadResponse(
	saved uploads.TempFile,
	declared string,
	country string,
	warning string,
	missing []string,
) *agent_credentials.AgentUploadValidateResponse {
	if missing == nil {
		missing = append([]string(nil), agentRequiredColumns[declared]...)
	}
	return &agent_credentials.AgentUploadValidateResponse{
		TempFileID:        saved.TempFileID,
		OriginalFilename:  saved.OriginalFilename,
		ReportType:        "unknown",
		Status:            "invalid",
		MatchedColumns:    []string{},
		MissingColumns:    missing,
		ColumnMatchRatio:  0,
		DetectedCountries: []string{},
		PrimaryCountry:    country,
		DateInputMode:     "single_manual",
		Warnings:          []string{warning},
	}
}

var agentRequiredColumns = map[string][]string{
	"sales_report":             {"purchase-date", "sku", "asin"},
	"inventory_report":         {"snapshot-date", "sku", "asin"},
	"business_report":          {"asin"},
	"return_report":            {"return-date", "sku"},
	"payment_report":           {"sku", "asin"},
	"inventory_ledger_summary": {"starting warehouse balance", "ending warehouse balance"},
	"inventory_ledger_detail":  {"fulfillment-center", "quantity"},
}

func suggestAgentReportType(matchedColumns []string) *string {
	matched := make(map[string]bool, len(matchedColumns))
	for _, column := range matchedColumns {
		matched[strings.ToLower(strings.TrimSpace(column))] = true
	}
	best := ""
	bestScore := 0.0
	for reportType, required := range agentRequiredColumns {
		if len(required) == 0 {
			continue
		}
		hits := 0
		for _, column := range required {
			if matched[strings.ToLower(column)] {
				hits++
			}
		}
		score := float64(hits) / float64(len(required))
		if score > bestScore {
			best = reportType
			bestScore = score
		}
	}
	if best == "" || bestScore < 0.5 {
		return nil
	}
	return &best
}

func isAdReportType(reportType string) bool {
	for _, spec := range adReportSpecs {
		if spec.reportType == reportType {
			return true
		}
	}
	return false
}

func mapAgentCommitResponse(source uploads.CommitResponse) *agent_credentials.AgentUploadCommitResponse {
	duplicates := source.DuplicateWarnings
	if duplicates == nil {
		duplicates = []uploads.DuplicateWarning{}
	}
	return &agent_credentials.AgentUploadCommitResponse{
		ReportType:        source.ReportType,
		Status:            source.Status,
		ProjectName:       source.ProjectName,
		Country:           source.Country,
		ReportDate:        source.ReportDate,
		ReportStartDate:   source.ReportStartDate,
		ReportEndDate:     source.ReportEndDate,
		FileID:            source.FileID,
		FilePath:          source.FilePath,
		PersistedSourceID: source.PersistedSourceID,
		PersistedTable:    source.PersistedTable,
		Message:           source.Message,
		DuplicateWarnings: duplicates,
		RowsIngested:      source.RowsIngested,
	}
}

func agentProjectScopeAllows(scope string, projectID int64) bool {
	scope = strings.TrimSpace(scope)
	if scope == "" || scope == "*" {
		return true
	}
	for _, raw := range strings.Split(scope, ",") {
		id, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
		if err == nil && id == projectID {
			return true
		}
	}
	return false
}

func agentDerefString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func stringPointerOrNil(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func sourceFilenameID(path string) string {
	return filepath.Base(path)
}
