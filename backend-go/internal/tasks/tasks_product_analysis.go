package tasks

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/hibiken/asynq"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/product_analysis"
	productreports "github.com/passwii/believeboyDashboard/backend-go/internal/api/product_analysis_reports"
	"github.com/passwii/believeboyDashboard/backend-go/internal/queue"
	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
)

const (
	productAnalysisReportJobType = productreports.JobType
	monthlyReportJobType         = "monthly_report"

	productAnalysisMaxFileBytes = 50 << 20
)

const updateRunJobProgressSQL = `
UPDATE public.job_runs
SET log_excerpt = $2
WHERE id = $1
`

// ProductAnalysisReportExecutionInput is the validated job payload passed to
// the product-analysis report executor.
type ProductAnalysisReportExecutionInput struct {
	JobID             int64
	ProjectID         int64
	ProjectName       string
	Country           string
	ReportStartDate   string
	ReportEndDate     string
	FileIDs           map[string]string
	ResolvedFilePaths map[string]string
}

type ProductAnalysisReportExecutionResult struct {
	ResultPath  string
	Filename    string
	RowCount    int
	PeriodCount int
}

// ProductAnalysisReportExecutor runs the async product-analysis report chain.
// A nil implementation is a runtime dependency error and must fail the job.
type ProductAnalysisReportExecutor interface {
	Execute(
		ctx context.Context,
		input ProductAnalysisReportExecutionInput,
	) (*ProductAnalysisReportExecutionResult, error)
}

type productAnalysisFilesRunner interface {
	Run(
		ctx context.Context,
		input store.ProductAnalysisFilesInput,
	) (*product_analysis.RunResponse, error)
}

type storeProductAnalysisFilesRunner struct {
	db store.FullDB
}

func (runner storeProductAnalysisFilesRunner) Run(
	ctx context.Context,
	input store.ProductAnalysisFilesInput,
) (*product_analysis.RunResponse, error) {
	return store.RunProductAnalysisFiles(ctx, runner.db, input)
}

type productAnalysisReportFileExecutor struct {
	runner     productAnalysisFilesRunner
	uploadRoot string
	resultRoot string
}

// NewProductAnalysisReportExecutor wires the task worker to the production
// DB-backed product-analysis file calculation.
func NewProductAnalysisReportExecutor(
	db store.FullDB,
	uploadRoot string,
	resultRoot string,
) ProductAnalysisReportExecutor {
	return newProductAnalysisReportFileExecutor(
		storeProductAnalysisFilesRunner{db: db},
		uploadRoot,
		resultRoot,
	)
}

func newProductAnalysisReportFileExecutor(
	runner productAnalysisFilesRunner,
	uploadRoot string,
	resultRoot string,
) *productAnalysisReportFileExecutor {
	return &productAnalysisReportFileExecutor{
		runner:     runner,
		uploadRoot: strings.TrimSpace(uploadRoot),
		resultRoot: strings.TrimSpace(resultRoot),
	}
}

func (executor *productAnalysisReportFileExecutor) Execute(
	ctx context.Context,
	input ProductAnalysisReportExecutionInput,
) (*ProductAnalysisReportExecutionResult, error) {
	if executor == nil {
		return nil, fmt.Errorf("%w: product analysis report executor", ErrDependencyNotConfigured)
	}
	if executor.runner == nil {
		return nil, fmt.Errorf("%w: product analysis calculation", ErrDependencyNotConfigured)
	}
	if executor.uploadRoot == "" {
		return nil, fmt.Errorf("%w: product analysis upload root", ErrDependencyNotConfigured)
	}
	if executor.resultRoot == "" {
		return nil, fmt.Errorf("%w: product analysis result root", ErrDependencyNotConfigured)
	}
	if input.JobID <= 0 {
		return nil, errPositive("job_id")
	}
	if input.ProjectID <= 0 {
		return nil, errPositive("project_id")
	}
	if strings.TrimSpace(input.ProjectName) == "" {
		return nil, errRequired("project_name")
	}

	reportPaths, err := executor.resolveReportPaths(input)
	if err != nil {
		return nil, err
	}
	response, err := executor.runner.Run(ctx, store.ProductAnalysisFilesInput{
		ProjectID:       input.ProjectID,
		ProjectName:     input.ProjectName,
		Country:         input.Country,
		ReportStartDate: input.ReportStartDate,
		ReportEndDate:   input.ReportEndDate,
		UploadRoot:      executor.uploadRoot,
		ReportPaths:     reportPaths,
	})
	if err != nil {
		return nil, fmt.Errorf("execute product analysis calculation: %w", err)
	}
	if response == nil || len(response.Periods) == 0 {
		return nil, errors.New("product analysis calculation returned no periods")
	}

	workbook, err := buildProductAnalysisReportWorkbook(response, reportPaths["inventory_report"])
	if err != nil {
		return nil, fmt.Errorf("build product analysis workbook: %w", err)
	}
	resultPath, err := executor.writeResultFile(input, workbook)
	if err != nil {
		return nil, err
	}
	rowCount := 0
	for _, period := range response.Periods {
		rowCount += len(period.Details)
	}
	return &ProductAnalysisReportExecutionResult{
		ResultPath:  resultPath,
		Filename:    filepath.Base(resultPath),
		RowCount:    rowCount,
		PeriodCount: len(response.Periods),
	}, nil
}

func (executor *productAnalysisReportFileExecutor) resolveReportPaths(
	input ProductAnalysisReportExecutionInput,
) (map[string]string, error) {
	allowed := map[string]bool{
		"business_report":  true,
		"payment_report":   true,
		"ad_report":        true,
		"inventory_report": true,
	}
	for reportType := range input.FileIDs {
		if !allowed[strings.TrimSpace(reportType)] {
			return nil, errInvalid("file_ids."+reportType, "is not supported")
		}
	}
	for reportType := range input.ResolvedFilePaths {
		if !allowed[strings.TrimSpace(reportType)] {
			return nil, errInvalid("resolved_file_paths."+reportType, "is not supported")
		}
	}

	resolved := make(map[string]string, len(input.ResolvedFilePaths))
	for rawReportType, rawPath := range input.ResolvedFilePaths {
		reportType := strings.TrimSpace(rawReportType)
		rawPath = strings.TrimSpace(rawPath)
		if rawPath == "" {
			continue
		}
		safePath, err := resolveProductAnalysisContainedFile(executor.uploadRoot, rawPath)
		if err != nil {
			return nil, fmt.Errorf("resolved_file_paths.%s: %w", reportType, err)
		}
		resolved[reportType] = safePath
	}
	for rawReportType, fileID := range input.FileIDs {
		reportType := strings.TrimSpace(rawReportType)
		if resolved[reportType] != "" || strings.TrimSpace(fileID) == "" {
			continue
		}
		generated, err := store.ResolveProductAnalysisUploadPath(
			executor.uploadRoot,
			input.ProjectName,
			reportType,
			fileID,
		)
		if err != nil {
			return nil, fmt.Errorf("file_ids.%s: %w", reportType, err)
		}
		safePath, err := resolveProductAnalysisContainedFile(executor.uploadRoot, generated)
		if err != nil {
			return nil, fmt.Errorf("file_ids.%s: %w", reportType, err)
		}
		resolved[reportType] = safePath
	}
	for _, reportType := range []string{
		"business_report",
		"payment_report",
		"ad_report",
	} {
		if resolved[reportType] == "" {
			return nil, errRequired("file path " + reportType)
		}
	}
	return resolved, nil
}

func (executor *productAnalysisReportFileExecutor) writeResultFile(
	input ProductAnalysisReportExecutionInput,
	content []byte,
) (string, error) {
	root, err := ensureProductAnalysisDirectory(executor.resultRoot, true)
	if err != nil {
		return "", fmt.Errorf("prepare product analysis result root: %w", err)
	}
	jobDirectory := filepath.Join(root, strconv.FormatInt(input.JobID, 10))
	if err := os.MkdirAll(jobDirectory, 0o700); err != nil {
		return "", fmt.Errorf("create product analysis result directory: %w", err)
	}
	jobDirectory, err = ensureProductAnalysisDirectory(jobDirectory, false)
	if err != nil {
		return "", fmt.Errorf("validate product analysis result directory: %w", err)
	}
	if _, err := productAnalysisRelativeInside(root, jobDirectory); err != nil {
		return "", fmt.Errorf("product analysis result directory escaped root: %w", err)
	}

	filename := productAnalysisReportFilename(
		input.ProjectName,
		input.ReportStartDate,
		input.ReportEndDate,
	)
	target := filepath.Join(jobDirectory, filename)
	if _, err := productAnalysisRelativeInside(root, target); err != nil {
		return "", fmt.Errorf("product analysis result path escaped root: %w", err)
	}

	temp, err := os.CreateTemp(jobDirectory, ".product-analysis-*.tmp")
	if err != nil {
		return "", fmt.Errorf("create temporary product analysis file: %w", err)
	}
	tempPath := temp.Name()
	defer func() {
		_ = os.Remove(tempPath)
	}()
	if err := temp.Chmod(0o600); err != nil {
		_ = temp.Close()
		return "", fmt.Errorf("set product analysis result permissions: %w", err)
	}
	if _, err := temp.Write(content); err != nil {
		_ = temp.Close()
		return "", fmt.Errorf("write product analysis result: %w", err)
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return "", fmt.Errorf("sync product analysis result: %w", err)
	}
	if err := temp.Close(); err != nil {
		return "", fmt.Errorf("close product analysis result: %w", err)
	}
	if err := os.Rename(tempPath, target); err != nil {
		return "", fmt.Errorf("publish product analysis result: %w", err)
	}
	return target, nil
}

func resolveProductAnalysisContainedFile(rootValue string, rawPath string) (string, error) {
	if strings.TrimSpace(rootValue) == "" {
		return "", fmt.Errorf("%w: product analysis upload root", ErrDependencyNotConfigured)
	}
	root, err := ensureProductAnalysisDirectory(rootValue, false)
	if err != nil {
		return "", fmt.Errorf("product analysis upload root: %w", err)
	}
	rawPath = strings.TrimSpace(rawPath)
	if rawPath == "" {
		return "", errRequired("file path")
	}
	if !filepath.IsAbs(rawPath) {
		return "", errors.New("file path must be absolute")
	}
	extension := strings.ToLower(filepath.Ext(rawPath))
	if extension != ".csv" && extension != ".xlsx" && extension != ".txt" {
		return "", fmt.Errorf("unsupported report extension %q", extension)
	}
	info, err := os.Lstat(rawPath)
	if err != nil {
		return "", err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("report file must not be a symlink")
	}
	if !info.Mode().IsRegular() {
		return "", errors.New("report file must be regular")
	}
	if info.Size() > productAnalysisMaxFileBytes {
		return "", fmt.Errorf("report file exceeds %d bytes", productAnalysisMaxFileBytes)
	}
	resolved, err := filepath.EvalSymlinks(rawPath)
	if err != nil {
		return "", err
	}
	if _, err := productAnalysisRelativeInside(root, resolved); err != nil {
		return "", errors.New("report file escaped UPLOAD_ROOT")
	}
	return resolved, nil
}

func ensureProductAnalysisDirectory(pathValue string, create bool) (string, error) {
	pathValue = strings.TrimSpace(pathValue)
	if pathValue == "" {
		return "", errors.New("directory is empty")
	}
	absolute, err := filepath.Abs(pathValue)
	if err != nil {
		return "", err
	}
	info, err := os.Lstat(absolute)
	if errors.Is(err, os.ErrNotExist) {
		if !create {
			return "", err
		}
		if err := os.MkdirAll(absolute, 0o700); err != nil {
			return "", err
		}
		info, err = os.Lstat(absolute)
	}
	if err != nil {
		return "", err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("directory must not be a symlink")
	}
	if !info.IsDir() {
		return "", errors.New("path must be a directory")
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", err
	}
	return resolved, nil
}

func productAnalysisRelativeInside(root string, candidate string) (string, error) {
	root = filepath.Clean(root)
	candidate = filepath.Clean(candidate)
	relative, err := filepath.Rel(root, candidate)
	if err != nil {
		return "", err
	}
	if relative == ".." ||
		strings.HasPrefix(relative, ".."+string(filepath.Separator)) ||
		filepath.IsAbs(relative) {
		return "", errors.New("path is outside root")
	}
	return relative, nil
}

func productAnalysisReportFilename(
	projectName string,
	reportStartDate string,
	reportEndDate string,
) string {
	start, startErr := time.Parse("2006-01-02", strings.TrimSpace(reportStartDate))
	end, endErr := time.Parse("2006-01-02", strings.TrimSpace(reportEndDate))
	reportDate := strings.TrimSpace(reportStartDate) + "-" + strings.TrimSpace(reportEndDate)
	if startErr == nil && endErr == nil {
		reportDate = start.Format("20060102") + "-" + end.Format("0102")
	}
	return safeProductAnalysisProjectName(projectName) +
		"_Product_Analysis_" + reportDate + ".xlsx"
}

func safeProductAnalysisProjectName(value string) string {
	value = strings.TrimSpace(value)
	var builder strings.Builder
	for _, character := range value {
		if unicode.IsControl(character) ||
			strings.ContainsRune(`\/:*?"<>|`, character) {
			continue
		}
		builder.WriteRune(character)
	}
	result := strings.TrimSpace(builder.String())
	if result == "" {
		return "unknown"
	}
	runes := []rune(result)
	if len(runes) > 128 {
		result = string(runes[:128])
	}
	return result
}

func productAnalysisInputFromJob(
	envelope jobPayloadEnvelope,
	jobID int64,
) (ProductAnalysisReportExecutionInput, error) {
	projectID, err := monthlyReportInt64Param(envelope.Params, "project_id")
	if err != nil {
		return ProductAnalysisReportExecutionInput{}, err
	}
	if projectID <= 0 {
		return ProductAnalysisReportExecutionInput{}, errPositive("params.project_id")
	}
	projectName, err := monthlyReportStringParam(envelope.Params, "project_name")
	if err != nil {
		return ProductAnalysisReportExecutionInput{}, err
	}
	startDate, err := monthlyReportStringParam(envelope.Params, "report_start_date")
	if err != nil {
		return ProductAnalysisReportExecutionInput{}, err
	}
	endDate, err := monthlyReportStringParam(envelope.Params, "report_end_date")
	if err != nil {
		return ProductAnalysisReportExecutionInput{}, err
	}
	if _, err := time.Parse("2006-01-02", startDate); err != nil {
		return ProductAnalysisReportExecutionInput{}, errInvalid(
			"params.report_start_date",
			"must be YYYY-MM-DD",
		)
	}
	if _, err := time.Parse("2006-01-02", endDate); err != nil {
		return ProductAnalysisReportExecutionInput{}, errInvalid(
			"params.report_end_date",
			"must be YYYY-MM-DD",
		)
	}
	if startDate > endDate {
		return ProductAnalysisReportExecutionInput{}, errInvalid(
			"params.report_start_date",
			"must not be after report_end_date",
		)
	}
	country := "US"
	if raw, ok := envelope.Params["country"]; ok && len(raw) > 0 && string(raw) != "null" {
		var value string
		if err := json.Unmarshal(raw, &value); err != nil {
			return ProductAnalysisReportExecutionInput{}, errInvalid(
				"params.country",
				"must be a string",
			)
		}
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			country = trimmed
		}
	}
	fileIDs, err := productAnalysisStringMapParam(envelope.Params, "file_ids")
	if err != nil {
		return ProductAnalysisReportExecutionInput{}, err
	}
	if fileIDs == nil {
		fileIDs = map[string]string{}
	}
	if value := strings.TrimSpace(envelope.FileID); value != "" {
		if fileIDs["business_report"] == "" {
			fileIDs["business_report"] = value
		}
	}
	resolvedPaths, err := productAnalysisStringMapParam(
		envelope.Params,
		"resolved_file_paths",
	)
	if err != nil {
		return ProductAnalysisReportExecutionInput{}, err
	}
	if resolvedPaths == nil {
		resolvedPaths = map[string]string{}
	}
	return ProductAnalysisReportExecutionInput{
		JobID:             jobID,
		ProjectID:         projectID,
		ProjectName:       projectName,
		Country:           country,
		ReportStartDate:   startDate,
		ReportEndDate:     endDate,
		FileIDs:           fileIDs,
		ResolvedFilePaths: resolvedPaths,
	}, nil
}

func productAnalysisStringMapParam(
	params map[string]json.RawMessage,
	key string,
) (map[string]string, error) {
	raw, ok := params[key]
	if !ok || len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var values map[string]string
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil, errInvalid("params."+key, "must be an object of strings")
	}
	if values == nil {
		values = map[string]string{}
	}
	for name, value := range values {
		values[name] = strings.TrimSpace(value)
	}
	return values, nil
}

func (handler *TaskHandler) executeProductAnalysisRunJob(
	ctx context.Context,
	db store.FullDB,
	task *asynq.Task,
	job runJobRecord,
	runID int64,
	now time.Time,
	envelope jobPayloadEnvelope,
) error {
	if handler.config.ProductAnalysisReportExecutor == nil {
		return fmt.Errorf("%w: product analysis report executor", ErrDependencyNotConfigured)
	}
	input, err := productAnalysisInputFromJob(envelope, job.ID)
	if err != nil {
		return fmt.Errorf("decode product analysis job: %w", err)
	}
	if err := handler.updateRunJobProgress(
		ctx,
		db,
		runID,
		"processing",
		10,
		"处理中：开始执行核算逻辑",
	); err != nil {
		return err
	}
	result, err := handler.config.ProductAnalysisReportExecutor.Execute(ctx, input)
	if err != nil {
		return fmt.Errorf("execute product analysis job %d: %w", job.ID, err)
	}
	if result == nil || strings.TrimSpace(result.ResultPath) == "" {
		return errors.New("product analysis executor returned no result path")
	}
	resultPath := strings.TrimSpace(result.ResultPath)
	if _, err := db.Exec(ctx, markJobSuccessSQL, job.ID, now); err != nil {
		return fmt.Errorf("mark product analysis job success: %w", err)
	}
	logExcerpt, err := json.Marshal(map[string]any{
		"stage":    "completed",
		"progress": 100,
		"message":  "处理完成：报表已生成，可下载",
	})
	if err != nil {
		return fmt.Errorf("encode product analysis completion: %w", err)
	}
	if _, err := db.Exec(
		ctx,
		finishJobRunSuccessSQL,
		runID,
		now,
		resultPath,
		string(logExcerpt),
	); err != nil {
		return fmt.Errorf("finish product analysis job run: %w", err)
	}
	return handler.writeResult(task, taskResult{
		TaskType: queue.TypeRunJob,
		Status:   "success",
		Data: map[string]any{
			"job_id":       job.ID,
			"project_id":   input.ProjectID,
			"result_path":  resultPath,
			"filename":     result.Filename,
			"row_count":    result.RowCount,
			"period_count": result.PeriodCount,
		},
	})
}

func (handler *TaskHandler) updateRunJobProgress(
	ctx context.Context,
	db store.FullDB,
	runID int64,
	stage string,
	progress int,
	message string,
) error {
	if runID <= 0 {
		return errPositive("job_run_id")
	}
	logExcerpt, err := json.Marshal(map[string]any{
		"stage":    stage,
		"progress": progress,
		"message":  message,
	})
	if err != nil {
		return fmt.Errorf("encode job progress: %w", err)
	}
	if _, err := db.Exec(ctx, updateRunJobProgressSQL, runID, string(logExcerpt)); err != nil {
		return fmt.Errorf("update job run progress: %w", err)
	}
	return nil
}
