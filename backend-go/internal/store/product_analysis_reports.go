package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/product_analysis_reports"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type ProductAnalysisReportStore struct {
	db         FullDB
	uploadRoot string
}

type productAnalysisJobEnvelope struct {
	JobType string                   `json:"job_type"`
	FileID  string                   `json:"file_id"`
	Params  productAnalysisJobParams `json:"params"`
}

type productAnalysisJobParams struct {
	ProjectID         int64             `json:"project_id"`
	ProjectName       string            `json:"project_name"`
	ReportStartDate   string            `json:"report_start_date"`
	ReportEndDate     string            `json:"report_end_date"`
	Country           string            `json:"country"`
	FileIDs           map[string]string `json:"file_ids"`
	ResolvedFilePaths map[string]string `json:"resolved_file_paths"`
	Operator          string            `json:"operator,omitempty"`
}

type productAnalysisRunProgress struct {
	Stage              string  `json:"stage"`
	Progress           int     `json:"progress"`
	Message            *string `json:"message"`
	PersistenceStatus  string  `json:"persistence_status"`
	PersistenceMessage *string `json:"persistence_message"`
}

func NewProductAnalysisReportStore(db FullDB) *ProductAnalysisReportStore {
	return NewProductAnalysisReportStoreWithUploadRoot(
		db,
		storageRoot("UPLOAD_ROOT", "backend/storage/uploads"),
	)
}

func NewProductAnalysisReportStoreWithUploadRoot(
	db FullDB,
	uploadRoot string,
) *ProductAnalysisReportStore {
	return &ProductAnalysisReportStore{
		db:         db,
		uploadRoot: strings.TrimSpace(uploadRoot),
	}
}

func (store *ProductAnalysisReportStore) CreateTask(
	ctx context.Context,
	input product_analysis_reports.CreateInput,
) (*product_analysis_reports.Task, error) {
	var projectID int64
	var projectOperator, assistantOperator *string
	err := store.db.QueryRow(
		ctx,
		`SELECT id, project_operator, assistant_operator
		 FROM public.projects
		 WHERE project_name = $1
		   AND coalesce(is_active, true)
		 ORDER BY id
		 LIMIT 1`,
		input.ProjectName,
	).Scan(&projectID, &projectOperator, &assistantOperator)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, product_analysis_reports.ErrProjectNotFound
		}
		return nil, fmt.Errorf("load product analysis project: %w", err)
	}
	if !input.IsAdmin &&
		(strings.TrimSpace(input.Operator) == "" ||
			(!textContainsName(projectOperator, input.Operator) &&
				!textContainsName(assistantOperator, input.Operator))) {
		return nil, product_analysis_reports.ErrProjectForbidden
	}

	fileIDs := map[string]string{
		"business_report": input.BusinessReportFileID,
		"payment_report":  input.PaymentReportFileID,
		"ad_report":       input.AdReportFileID,
	}
	if input.InventoryReportFileID != nil &&
		strings.TrimSpace(*input.InventoryReportFileID) != "" {
		fileIDs["inventory_report"] = strings.TrimSpace(
			*input.InventoryReportFileID,
		)
	}
	resolvedPaths := make(map[string]string, len(fileIDs))
	for reportType, fileID := range fileIDs {
		resolved, err := ResolveProductAnalysisUploadPath(
			store.uploadRoot,
			input.ProjectName,
			reportType,
			fileID,
		)
		if err != nil {
			return nil, err
		}
		resolvedPaths[reportType] = resolved
	}

	payload := productAnalysisJobEnvelope{
		JobType: product_analysis_reports.JobType,
		FileID:  input.BusinessReportFileID,
		Params: productAnalysisJobParams{
			ProjectID:         projectID,
			ProjectName:       input.ProjectName,
			ReportStartDate:   input.ReportStartDate,
			ReportEndDate:     input.ReportEndDate,
			Country:           input.Country,
			FileIDs:           fileIDs,
			ResolvedFilePaths: resolvedPaths,
			Operator:          strings.TrimSpace(input.Operator),
		},
	}
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("encode product analysis job payload: %w", err)
	}

	var task product_analysis_reports.Task
	var createdAt, updatedAt pgtype.Timestamptz
	var operator *string
	if value := strings.TrimSpace(input.Operator); value != "" {
		operator = &value
	}
	if err := store.db.QueryRow(
		ctx,
		`INSERT INTO public.jobs (job_type, status, payload_json, operator)
		 VALUES ($1, 'pending', $2, $3)
		 RETURNING id, status::text, created_at, updated_at`,
		product_analysis_reports.JobType,
		payloadBytes,
		operator,
	).Scan(
		&task.ID,
		&task.Status,
		&createdAt,
		&updatedAt,
	); err != nil {
		return nil, fmt.Errorf("create product analysis job: %w", err)
	}
	task.ProjectID = projectID
	task.ProjectName = input.ProjectName
	task.CreatedAt = httpapi.Timestamp(createdAt.Time)
	task.UpdatedAt = httpapi.Timestamp(updatedAt.Time)
	applyProductAnalysisTaskDefaults(&task)
	return &task, nil
}

func (store *ProductAnalysisReportStore) GetTask(
	ctx context.Context,
	taskID int64,
	operator string,
	isAdmin bool,
) (*product_analysis_reports.Task, error) {
	var task product_analysis_reports.Task
	var createdAt, updatedAt pgtype.Timestamptz
	var projectIDFromPayload, projectID int64
	var projectOperator, assistantOperator *string
	var logExcerpt string
	var errorMessage, resultPath *string

	err := store.db.QueryRow(
		ctx,
		`SELECT j.id,
		        j.status::text,
		        j.created_at,
		        j.updated_at,
		        coalesce(j.payload_json #>> '{params,project_name}', ''),
		        coalesce(
		          nullif(j.payload_json #>> '{params,project_id}', '')::bigint,
		          0
		        ),
		        coalesce(p.id, 0),
		        p.project_operator,
		        p.assistant_operator,
		        coalesce(latest.log_excerpt, ''),
		        latest.error_message,
		        latest.result_path
		 FROM public.jobs j
		 LEFT JOIN public.projects p
		   ON p.id = nullif(
		     j.payload_json #>> '{params,project_id}', ''
		   )::bigint
		 LEFT JOIN LATERAL (
		   SELECT log_excerpt, error_message, result_path
		   FROM public.job_runs
		   WHERE job_id = j.id
		   ORDER BY id DESC
		   LIMIT 1
		 ) latest ON true
		 WHERE j.id = $1
		   AND j.job_type = 'product_analysis'
		 LIMIT 1`,
		taskID,
	).Scan(
		&task.ID,
		&task.Status,
		&createdAt,
		&updatedAt,
		&task.ProjectName,
		&projectIDFromPayload,
		&projectID,
		&projectOperator,
		&assistantOperator,
		&logExcerpt,
		&errorMessage,
		&resultPath,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, product_analysis_reports.ErrTaskNotFound
		}
		return nil, fmt.Errorf("load product analysis task: %w", err)
	}
	if projectID <= 0 || projectID != projectIDFromPayload {
		return nil, product_analysis_reports.ErrTaskNotFound
	}
	if !isAdmin &&
		(strings.TrimSpace(operator) == "" ||
			(!textContainsName(projectOperator, operator) &&
				!textContainsName(assistantOperator, operator))) {
		return nil, product_analysis_reports.ErrProjectForbidden
	}

	task.ProjectID = projectID
	task.CreatedAt = httpapi.Timestamp(createdAt.Time)
	task.UpdatedAt = httpapi.Timestamp(updatedAt.Time)
	task.ErrorMessage = errorMessage
	task.ResultPath = resultPath
	applyProductAnalysisTaskRunProgress(&task, logExcerpt)
	return &task, nil
}

func (store *ProductAnalysisReportStore) MarkTaskFailed(
	ctx context.Context,
	taskID int64,
	message string,
) error {
	message = strings.TrimSpace(message)
	if message == "" {
		message = "product analysis task failed"
	}
	now := time.Now().UTC()
	logExcerpt, err := json.Marshal(map[string]any{
		"stage":    "failed",
		"progress": 100,
		"message":  "处理失败：" + message,
	})
	if err != nil {
		return fmt.Errorf("encode product analysis failure: %w", err)
	}

	return RunInTx(ctx, store.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		tag, err := txDB.Exec(
			ctx,
			`UPDATE public.jobs
			 SET status = 'failed', updated_at = $2
			 WHERE id = $1
			   AND job_type = 'product_analysis'
			   AND status <> 'success'`,
			taskID,
			now,
		)
		if err != nil {
			return fmt.Errorf("mark product analysis job failed: %w", err)
		}
		if tag.RowsAffected() == 0 {
			return product_analysis_reports.ErrTaskNotFound
		}
		_, err = txDB.Exec(
			ctx,
			`INSERT INTO public.job_runs (
			   job_id, started_at, finished_at, operator,
			   log_excerpt, error_message
			 )
			 SELECT j.id, $2, $2, j.operator, $3, $4
			 FROM public.jobs j
			 WHERE j.id = $1`,
			taskID,
			now,
			string(logExcerpt),
			message,
		)
		if err != nil {
			return fmt.Errorf("record product analysis failure: %w", err)
		}
		return nil
	})
}

func applyProductAnalysisTaskDefaults(task *product_analysis_reports.Task) {
	task.Progress = 1
	task.Stage = "started"
	message := "处理中：任务已接收"
	task.Message = &message
	task.PersistenceStatus = "idle"
	task.PersistenceMessage = nil
}

func applyProductAnalysisTaskRunProgress(
	task *product_analysis_reports.Task,
	logExcerpt string,
) {
	applyProductAnalysisTaskDefaults(task)
	if strings.TrimSpace(logExcerpt) != "" {
		var progress productAnalysisRunProgress
		if err := json.Unmarshal([]byte(logExcerpt), &progress); err == nil {
			if strings.TrimSpace(progress.Stage) != "" {
				task.Stage = strings.TrimSpace(progress.Stage)
			}
			if progress.Progress >= 0 {
				task.Progress = minInt(progress.Progress, 100)
			}
			if progress.Message != nil {
				task.Message = progress.Message
			}
			if strings.TrimSpace(progress.PersistenceStatus) != "" {
				task.PersistenceStatus = strings.TrimSpace(
					progress.PersistenceStatus,
				)
			}
			if progress.PersistenceMessage != nil {
				task.PersistenceMessage = progress.PersistenceMessage
			}
		}
	}

	switch task.Status {
	case product_analysis_reports.StatusSuccess:
		task.Stage = "completed"
		task.Progress = 100
		message := "处理完成：报表已生成，可下载"
		task.Message = &message
	case product_analysis_reports.StatusFailed:
		task.Stage = "failed"
		task.Progress = 100
		if task.ErrorMessage != nil && strings.TrimSpace(*task.ErrorMessage) != "" {
			message := "处理失败：" + strings.TrimSpace(*task.ErrorMessage)
			task.Message = &message
		}
	case product_analysis_reports.StatusRunning:
		if task.Stage == "started" {
			task.Stage = "processing"
		}
		if task.Progress < 10 {
			task.Progress = 10
		}
		message := "处理中：开始执行核算逻辑"
		if task.Message == nil || *task.Message == "处理中：任务已接收" {
			task.Message = &message
		}
	}
}

func minInt(left, right int) int {
	if left < right {
		return left
	}
	return right
}

// ResolveProductAnalysisUploadPath builds a lexical server-controlled upload
// path. It rejects absolute paths, traversal, control characters, and paths
// that otherwise escape UPLOAD_ROOT. Existence is intentionally not required:
// create semantics are asynchronous, so a missing file fails the task later.
func ResolveProductAnalysisUploadPath(
	uploadRoot string,
	projectName string,
	reportType string,
	fileID string,
) (string, error) {
	uploadRoot = strings.TrimSpace(uploadRoot)
	if uploadRoot == "" {
		return "", product_analysis_reports.ErrStorageNotConfigured
	}
	fileID = strings.TrimSpace(fileID)
	if fileID == "" || len([]rune(fileID)) > 255 {
		return "", product_analysis_reports.ErrInvalidStoredPath
	}
	for _, char := range fileID {
		if unicode.IsControl(char) {
			return "", product_analysis_reports.ErrInvalidStoredPath
		}
	}
	slashPath := strings.ReplaceAll(fileID, `\`, "/")
	if strings.HasPrefix(slashPath, "/") {
		return "", product_analysis_reports.ErrInvalidStoredPath
	}
	for _, segment := range strings.Split(slashPath, "/") {
		if segment == ".." {
			return "", product_analysis_reports.ErrInvalidStoredPath
		}
	}
	relativeID := filepath.Clean(filepath.FromSlash(slashPath))
	if relativeID == "." || relativeID == ".." || filepath.IsAbs(relativeID) {
		return "", product_analysis_reports.ErrInvalidStoredPath
	}

	rootAbsolute, err := filepath.Abs(uploadRoot)
	if err != nil {
		return "", fmt.Errorf("resolve upload root: %w", err)
	}
	candidate := filepath.Join(
		rootAbsolute,
		safeProjectFolder(projectName),
		safeFileTypeFolder(reportType),
		relativeID,
	)
	if _, err := relativeInside(rootAbsolute, candidate); err != nil {
		return "", product_analysis_reports.ErrInvalidStoredPath
	}
	return candidate, nil
}
