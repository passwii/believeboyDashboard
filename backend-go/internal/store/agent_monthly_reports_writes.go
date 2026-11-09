package store

import (
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
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/audit"
)

const (
	agentMonthlyBuildStatusQueued  = "queued"
	agentMonthlyBuildStatusRunning = "running"
	agentMonthlyBuildStatusSuccess = "success"
	agentMonthlyBuildStatusFailed  = "failed"

	agentMonthlyUploadStatusOpen      = "open"
	agentMonthlyUploadStatusBuilding  = "building"
	agentMonthlyUploadStatusBuilt     = "built"
	agentMonthlyUploadStatusConfirmed = "confirmed"
	agentMonthlyUploadStatusFailed    = "failed"

	agentMonthlyCSVKind = "transaction_csv"
	agentMonthlyPDFKind = "summary_pdf"

	agentMonthlyIdempotencyBuild   = "build"
	agentMonthlyIdempotencyConfirm = "confirm"
)

type agentMonthlyBuildPayload struct {
	CalculationVersion int                            `json:"calculation_version"`
	InputSHA256        string                         `json:"input_sha256"`
	Result             agentMonthlyBuildPayloadResult `json:"result"`
}

type agentMonthlyBuildPayloadResult struct {
	Transactions []agentMonthlyBuildTransaction `json:"transactions"`
	PT3          map[string]string              `json:"pt3"`
	PT4          map[string]string              `json:"pt4"`
	SettlementID string                         `json:"settlement_id,omitempty"`
}

type agentMonthlyBuildTransaction struct {
	SourceRowNo            int       `json:"source_row_no"`
	TransactionDate        time.Time `json:"transaction_date"`
	SettlementID           string    `json:"settlement_id,omitempty"`
	TransactionType        string    `json:"transaction_type"`
	OrderID                string    `json:"order_id,omitempty"`
	SKU                    string    `json:"sku,omitempty"`
	Description            string    `json:"description,omitempty"`
	Quantity               int       `json:"quantity"`
	Marketplace            string    `json:"marketplace,omitempty"`
	AccountType            string    `json:"account_type,omitempty"`
	Fulfillment            string    `json:"fulfillment,omitempty"`
	OrderCity              string    `json:"order_city,omitempty"`
	OrderState             string    `json:"order_state,omitempty"`
	OrderPostal            string    `json:"order_postal,omitempty"`
	TaxCollectionModel     string    `json:"tax_collection_model,omitempty"`
	ProductSales           string    `json:"product_sales,omitempty"`
	ProductSalesTax        string    `json:"product_sales_tax,omitempty"`
	ShippingCredits        string    `json:"shipping_credits,omitempty"`
	ShippingCreditsTax     string    `json:"shipping_credits_tax,omitempty"`
	GiftWrapCredits        string    `json:"gift_wrap_credits,omitempty"`
	GiftWrapCreditsTax     string    `json:"gift_wrap_credits_tax,omitempty"`
	RegulatoryFee          string    `json:"regulatory_fee,omitempty"`
	RegulatoryFeeTax       string    `json:"regulatory_fee_tax,omitempty"`
	PromotionalRebates     string    `json:"promotional_rebates,omitempty"`
	PromotionalRebatesTax  string    `json:"promotional_rebates_tax,omitempty"`
	MarketplaceWithheldTax string    `json:"marketplace_withheld_tax,omitempty"`
	SellingFees            string    `json:"selling_fees,omitempty"`
	FBAFees                string    `json:"fba_fees,omitempty"`
	OtherTransactionFees   string    `json:"other_transaction_fees,omitempty"`
	OtherAmount            string    `json:"other_amount,omitempty"`
	Total                  string    `json:"total,omitempty"`
	RawRowJSON             []byte    `json:"raw_row,omitempty"`
}

func (s *AgentMonthlyReportStore) CreateAgentMonthlyUpload(
	ctx context.Context,
	input AgentMonthlyUploadCreateInput,
	entry audit.Entry,
) (*AgentMonthlyUpload, error) {
	if s == nil || s.db == nil || s.auditor == nil {
		return nil, ErrAgentMonthlyDependency
	}
	country, err := normalizeAgentMonthlyCountry(input.Country)
	if err != nil {
		return nil, err
	}
	month, err := normalizeAgentMonthlyMonth(input.ReportMonth)
	if err != nil {
		return nil, err
	}
	var projectName string
	if err := s.db.QueryRow(
		ctx,
		`select project_name from public.projects where id = $1`,
		input.ProjectID,
	).Scan(&projectName); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrAgentMonthlyNotFound
		}
		return nil, err
	}
	expiresAt := s.now().UTC().Add(s.ttl)
	var upload AgentMonthlyUpload
	var createdDir string
	err = RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		var createdAt, updatedAt time.Time
		if err := txDB.QueryRow(ctx, `
			insert into public.agent_monthly_report_uploads (
			  agent_api_key_id, agent_id, project_id, project_name,
			  country, report_month, status, expires_at, created_at, updated_at
			) values ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())
			returning id, agent_api_key_id, agent_id, project_id, project_name,
			          country, report_month, status, expires_at, created_at, updated_at`,
			input.AgentKeyID,
			input.AgentID,
			input.ProjectID,
			projectName,
			country,
			month,
			agentMonthlyUploadStatusOpen,
			expiresAt,
		).Scan(
			&upload.ID,
			&upload.AgentKeyID,
			&upload.AgentID,
			&upload.ProjectID,
			&upload.ProjectName,
			&upload.Country,
			&upload.ReportMonth,
			&upload.Status,
			&upload.ExpiresAt,
			&createdAt,
			&updatedAt,
		); err != nil {
			return err
		}
		upload.CreatedAt = createdAt
		upload.UpdatedAt = updatedAt

		root, err := ensureAgentMonthlyRoot(s.root)
		if err != nil {
			return err
		}
		createdDir, err = ensureAgentMonthlyDir(root, "uploads", strconv.FormatInt(upload.ID, 10))
		if err != nil {
			return err
		}
		entry.Action = "agent_monthly_reports.upload.create"
		entry.TargetType = "agent_monthly_report_upload"
		target := strconv.FormatInt(upload.ID, 10)
		entry.TargetID = &target
		entry.AfterJSON = map[string]any{
			"upload_id":    upload.ID,
			"project_id":   upload.ProjectID,
			"country":      upload.Country,
			"report_month": upload.ReportMonth,
		}
		return s.auditor.LogActionTx(ctx, tx, entry)
	})
	if err != nil {
		if createdDir != "" {
			_ = os.RemoveAll(createdDir)
		}
		return nil, err
	}
	return &upload, nil
}

func (s *AgentMonthlyReportStore) GetAgentMonthlyUpload(
	ctx context.Context,
	uploadID int64,
	agentKeyID int64,
) (*AgentMonthlyUpload, error) {
	if s == nil || s.db == nil {
		return nil, ErrAgentMonthlyDependency
	}
	return s.getAgentMonthlyUpload(ctx, s.db, uploadID, agentKeyID, false)
}

func (s *AgentMonthlyReportStore) UploadAgentMonthlyFile(
	ctx context.Context,
	input AgentMonthlyUploadFileInput,
	entry audit.Entry,
) (*AgentMonthlyUploadedFile, error) {
	if s == nil || s.db == nil || s.auditor == nil {
		return nil, ErrAgentMonthlyDependency
	}
	kind := strings.TrimSpace(input.Kind)
	if kind != agentMonthlyCSVKind && kind != agentMonthlyPDFKind {
		return nil, fmt.Errorf("%w: kind must be transaction_csv or summary_pdf", ErrAgentMonthlyInvalidInput)
	}
	displayName := safeUploadFilename(input.OriginalFilename, "upload.bin")
	expectedExtension := ".csv"
	if kind == agentMonthlyPDFKind {
		expectedExtension = ".pdf"
	}
	if normalizedFileExtension(displayName) != expectedExtension {
		return nil, fmt.Errorf("%w: %s requires %s", ErrAgentMonthlyInvalidInput, kind, expectedExtension)
	}
	if !agentMonthlyContentTypeAllowed(kind, input.ContentType) {
		return nil, fmt.Errorf("%w: unsupported content type", ErrAgentMonthlyInvalidInput)
	}
	tempInfo, err := os.Lstat(input.TempPath)
	if err != nil || tempInfo.Mode()&os.ModeSymlink != 0 || !tempInfo.Mode().IsRegular() {
		return nil, fmt.Errorf("%w: temporary upload is missing or unsafe", ErrAgentMonthlyInvalidInput)
	}
	if input.MaxBytes <= 0 {
		input.MaxBytes = defaultAgentMonthlyMaxFileBytes
	}

	var storedPath string
	var uploaded AgentMonthlyUploadedFile
	err = RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		upload, err := s.getAgentMonthlyUploadForUpdate(ctx, txDB, input.UploadID, input.AgentKeyID)
		if err != nil {
			return err
		}
		if !upload.ExpiresAt.After(s.now()) {
			return ErrAgentMonthlyExpired
		}
		var existing int
		if err := txDB.QueryRow(ctx, `
			select 1 from public.agent_monthly_report_files
			where upload_id = $1 and kind = $2`,
			input.UploadID,
			kind,
		).Scan(&existing); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if existing == 1 {
			return ErrAgentMonthlyConflict
		}

		root, err := ensureAgentMonthlyRoot(s.root)
		if err != nil {
			return err
		}
		dir, err := ensureAgentMonthlyDir(root, "uploads", strconv.FormatInt(upload.ID, 10))
		if err != nil {
			return err
		}
		filename := kind + "-" + agentMonthlyRandomHex(16) + expectedExtension
		destination := filepath.Join(dir, filename)
		if !pathWithinRoot(root, destination) {
			return ErrAgentMonthlyInvalidInput
		}
		digest, size, err := copyAgentMonthlyFile(input.TempPath, destination, input.MaxBytes)
		if err != nil {
			return err
		}
		storedPath = destination
		validation, err := validateAgentMonthlyUploadedFile(destination, kind)
		if err != nil {
			return err
		}
		fileID := agentMonthlyRandomHex(16)
		var createdAt time.Time
		if err := txDB.QueryRow(ctx, `
			insert into public.agent_monthly_report_files (
			  upload_id, kind, file_id, original_filename, stored_path,
			  content_type, sha256, size_bytes, created_at
			) values ($1, $2, $3, $4, $5, nullif($6, ''), $7, $8, now())
			returning created_at`,
			upload.ID,
			kind,
			fileID,
			displayName,
			destination,
			strings.TrimSpace(input.ContentType),
			digest,
			size,
		).Scan(&createdAt); err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23505" {
				return ErrAgentMonthlyConflict
			}
			return err
		}
		_ = createdAt
		uploaded = AgentMonthlyUploadedFile{
			UploadID:         upload.ID,
			FileID:           fileID,
			Kind:             kind,
			OriginalFilename: displayName,
			SHA256:           digest,
			SizeBytes:        size,
			Validation:       validation,
		}
		entry.Action = "agent_monthly_reports.upload.file"
		entry.TargetType = "agent_monthly_report_upload"
		target := strconv.FormatInt(upload.ID, 10)
		entry.TargetID = &target
		entry.AfterJSON = map[string]any{
			"upload_id":  upload.ID,
			"kind":       kind,
			"file_id":    fileID,
			"sha256":     digest,
			"bytes":      size,
			"validation": validation,
		}
		return s.auditor.LogActionTx(ctx, tx, entry)
	})
	if err != nil {
		if storedPath != "" {
			_ = os.Remove(storedPath)
		}
		return nil, err
	}
	return &uploaded, nil
}

func (s *AgentMonthlyReportStore) CreateAgentMonthlyBuild(
	ctx context.Context,
	input AgentMonthlyBuildCreateInput,
	entry audit.Entry,
) (*AgentMonthlyBuild, bool, error) {
	if s == nil || s.db == nil || s.auditor == nil {
		return nil, false, ErrAgentMonthlyDependency
	}
	var (
		build    *AgentMonthlyBuild
		replayed bool
	)
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		upload, err := s.getAgentMonthlyUploadForUpdate(ctx, txDB, input.UploadID, input.AgentKeyID)
		if err != nil {
			return err
		}
		if !upload.ExpiresAt.After(s.now()) {
			return ErrAgentMonthlyExpired
		}

		existing, err := findAgentMonthlyIdempotency(
			ctx,
			txDB,
			input.AgentKeyID,
			agentMonthlyIdempotencyBuild,
			input.IdempotencyKey,
		)
		if err != nil {
			return err
		}
		if existing != nil {
			if existing.RequestHash != input.RequestHash {
				return ErrAgentMonthlyIdempotencyConflict
			}
			if existing.BuildID != nil {
				build, err = s.getAgentMonthlyBuild(ctx, txDB, *existing.BuildID, input.AgentKeyID)
				if err != nil {
					return err
				}
				replayed = true
				return nil
			}
		}

		transactionFile, err := getAgentMonthlyFile(
			ctx,
			txDB,
			upload.ID,
			input.TransactionFileID,
			agentMonthlyCSVKind,
		)
		if err != nil {
			return err
		}
		var summaryPDF *agentMonthlyFileRow
		if input.SummaryPDFFileID != nil && strings.TrimSpace(*input.SummaryPDFFileID) != "" {
			summaryPDF, err = getAgentMonthlyFile(
				ctx,
				txDB,
				upload.ID,
				*input.SummaryPDFFileID,
				agentMonthlyPDFKind,
			)
			if err != nil {
				return err
			}
		}
		var buildID int64
		if err := txDB.QueryRow(ctx, `
			insert into public.agent_monthly_report_builds (
			  upload_id, agent_api_key_id, agent_id, status, input_sha256,
			  summary_pdf_sha256, idempotency_key, expires_at, created_at, updated_at
			) values ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())
			returning id`,
			upload.ID,
			input.AgentKeyID,
			upload.AgentID,
			agentMonthlyBuildStatusQueued,
			transactionFile.SHA256,
			nullableAgentMonthlyString(summaryPDF, func(value *agentMonthlyFileRow) string {
				return value.SHA256
			}),
			input.IdempotencyKey,
			upload.ExpiresAt,
		).Scan(&buildID); err != nil {
			return err
		}
		if _, err := txDB.Exec(ctx, `
			insert into public.agent_monthly_report_idempotency (
			  agent_api_key_id, action, idempotency_key, request_hash, build_id, created_at
			) values ($1, $2, $3, $4, $5, now())`,
			input.AgentKeyID,
			agentMonthlyIdempotencyBuild,
			input.IdempotencyKey,
			input.RequestHash,
			buildID,
		); err != nil {
			return err
		}
		if err := refreshAgentMonthlyUploadStatus(ctx, txDB, upload.ID); err != nil {
			return err
		}
		build, err = s.getAgentMonthlyBuild(ctx, txDB, buildID, input.AgentKeyID)
		if err != nil {
			return err
		}
		entry.Action = "agent_monthly_reports.build"
		entry.TargetType = "agent_monthly_report_build"
		target := strconv.FormatInt(buildID, 10)
		entry.TargetID = &target
		entry.AfterJSON = map[string]any{
			"build_id":     buildID,
			"upload_id":    upload.ID,
			"project_id":   upload.ProjectID,
			"country":      upload.Country,
			"report_month": upload.ReportMonth,
			"input_sha256": transactionFile.SHA256,
		}
		return s.auditor.LogActionTx(ctx, tx, entry)
	})
	if err != nil {
		return nil, false, err
	}
	return build, replayed, nil
}

func (s *AgentMonthlyReportStore) GetAgentMonthlyBuild(
	ctx context.Context,
	buildID int64,
	agentKeyID int64,
) (*AgentMonthlyBuild, error) {
	if s == nil || s.db == nil {
		return nil, ErrAgentMonthlyDependency
	}
	return s.getAgentMonthlyBuild(ctx, s.db, buildID, agentKeyID)
}

func (s *AgentMonthlyReportStore) GetAgentMonthlyBuildPreview(
	ctx context.Context,
	buildID int64,
	agentKeyID int64,
) (*AgentMonthlyBuildPreview, error) {
	if s == nil || s.db == nil {
		return nil, ErrAgentMonthlyDependency
	}
	build, err := s.getAgentMonthlyBuild(ctx, s.db, buildID, agentKeyID)
	if err != nil {
		return nil, err
	}
	if !build.ExpiresAt.After(s.now()) {
		return nil, ErrAgentMonthlyExpired
	}
	if build.Status != agentMonthlyBuildStatusSuccess {
		return nil, ErrAgentMonthlyNotReady
	}
	payload, err := s.loadAgentMonthlyBuildPayload(build)
	if err != nil {
		return nil, err
	}
	return &AgentMonthlyBuildPreview{
		Build:             build,
		TransactionsCount: len(payload.Result.Transactions),
		PT3:               payload.Result.PT3,
		PT4:               payload.Result.PT4,
	}, nil
}

func (s *AgentMonthlyReportStore) GetAgentMonthlyBuildResult(
	ctx context.Context,
	buildID int64,
	agentKeyID int64,
) (*AgentMonthlyStoredFile, error) {
	if s == nil || s.db == nil {
		return nil, ErrAgentMonthlyDependency
	}
	build, err := s.getAgentMonthlyBuild(ctx, s.db, buildID, agentKeyID)
	if err != nil {
		return nil, err
	}
	if !build.ExpiresAt.After(s.now()) {
		return nil, ErrAgentMonthlyExpired
	}
	if build.Status != agentMonthlyBuildStatusSuccess {
		return nil, ErrAgentMonthlyNotReady
	}
	if build.WorkbookPath == nil || build.WorkbookSHA256 == nil {
		return nil, ErrAgentMonthlyNotReady
	}
	root, err := ensureAgentMonthlyRoot(s.root)
	if err != nil {
		return nil, err
	}
	path := existingRegularFile(build.WorkbookPath, root)
	if path == "" {
		return nil, ErrAgentMonthlyNotReady
	}
	digest, err := sha256AgentMonthlyFile(path)
	if err != nil || digest != *build.WorkbookSHA256 {
		return nil, ErrAgentMonthlyNotReady
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	return &AgentMonthlyStoredFile{
		Path:        path,
		Filename:    filepath.Base(path),
		ContentType: contentTypeForPath(path),
		Size:        info.Size(),
	}, nil
}

func (s *AgentMonthlyReportStore) MarkAgentMonthlyBuildDispatchFailed(
	ctx context.Context,
	buildID int64,
) error {
	if s == nil || s.db == nil {
		return ErrAgentMonthlyDependency
	}
	return RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		build, err := s.getAgentMonthlyBuildUnscoped(ctx, txDB, buildID)
		if err != nil {
			return err
		}
		if _, err := txDB.Exec(ctx, `
			update public.agent_monthly_report_builds
			set status = $2, error_message = 'dispatch_failed',
			    finished_at = now(), updated_at = now()
			where id = $1`,
			buildID,
			agentMonthlyBuildStatusFailed,
		); err != nil {
			return err
		}
		if _, err := txDB.Exec(ctx, `
			delete from public.agent_monthly_report_idempotency
			where action = 'build' and build_id = $1`,
			buildID,
		); err != nil {
			return err
		}
		if err := refreshAgentMonthlyUploadStatus(ctx, txDB, build.UploadID); err != nil {
			return err
		}
		if s.auditor != nil {
			entry := agentMonthlyWorkerAuditEntry(build, "agent_monthly_reports.build.dispatch_failed")
			entry.Result = "failure"
			entry.ErrorMessage = stringPointerValue("dispatch_failed")
			if err := s.auditor.LogActionTx(ctx, tx, entry); err != nil {
				return err
			}
		}
		return nil
	})
}

func (s *AgentMonthlyReportStore) ClaimAgentMonthlyBuild(
	ctx context.Context,
	buildID int64,
) (*AgentMonthlyBuildClaim, error) {
	if s == nil || s.db == nil {
		return nil, ErrAgentMonthlyDependency
	}
	var claim *AgentMonthlyBuildClaim
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		tag, err := txDB.Exec(ctx, `
			update public.agent_monthly_report_builds
			set status = $2, started_at = coalesce(started_at, now()),
			    attempt_count = attempt_count + 1, updated_at = now()
			where id = $1 and status = $3`,
			buildID,
			agentMonthlyBuildStatusRunning,
			agentMonthlyBuildStatusQueued,
		)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrAgentMonthlyConflict
		}
		build, err := s.getAgentMonthlyBuildUnscoped(ctx, txDB, buildID)
		if err != nil {
			return err
		}
		transactionFile, err := getAgentMonthlyFileByUploadKind(
			ctx,
			txDB,
			build.UploadID,
			agentMonthlyCSVKind,
		)
		if err != nil {
			return ErrAgentMonthlyNotReady
		}
		var summaryPath string
		if summaryFile, summaryErr := getAgentMonthlyFileByUploadKind(
			ctx,
			txDB,
			build.UploadID,
			agentMonthlyPDFKind,
		); summaryErr == nil && summaryFile != nil {
			summaryPath = summaryFile.StoredPath
		}
		claim = &AgentMonthlyBuildClaim{
			Build:           build,
			TransactionPath: transactionFile.StoredPath,
			SummaryPDFPath:  summaryPath,
		}
		if s.auditor != nil {
			entry := agentMonthlyWorkerAuditEntry(build, "agent_monthly_reports.build.start")
			if err := s.auditor.LogActionTx(ctx, tx, entry); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return claim, nil
}

func (s *AgentMonthlyReportStore) CompleteAgentMonthlyBuild(
	ctx context.Context,
	buildID int64,
	result MonthlyReportComputedResult,
) error {
	if s == nil || s.db == nil {
		return ErrAgentMonthlyDependency
	}
	var payloadPath string
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		build, err := s.getAgentMonthlyBuildUnscoped(ctx, txDB, buildID)
		if err != nil {
			return err
		}
		if build.Status != agentMonthlyBuildStatusRunning {
			return ErrAgentMonthlyConflict
		}
		root, err := ensureAgentMonthlyRoot(s.root)
		if err != nil {
			return err
		}
		buildDir, err := ensureAgentMonthlyDir(root, "builds", strconv.FormatInt(buildID, 10))
		if err != nil {
			return err
		}
		workbookPath, err := validateAgentMonthlyWorkbook(result.ResultPath, buildDir)
		if err != nil {
			return err
		}
		payload := agentMonthlyBuildPayload{
			CalculationVersion: 1,
			InputSHA256:        build.InputSHA256,
			Result: agentMonthlyBuildPayloadResult{
				Transactions: agentMonthlyPayloadTransactions(result.Transactions),
				PT3:          copyStringMap(result.PT3),
				PT4:          copyStringMap(result.PT4),
				SettlementID: result.SettlementID,
			},
		}
		encoded, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		payloadPath = filepath.Join(buildDir, "preview.json")
		payloadDigest, err := writeAgentMonthlyFileExclusive(payloadPath, encoded, 0o600)
		if err != nil {
			return err
		}
		workbookDigest, err := sha256AgentMonthlyFile(workbookPath)
		if err != nil {
			return err
		}
		info, err := os.Stat(workbookPath)
		if err != nil {
			return err
		}
		if _, err := txDB.Exec(ctx, `
			update public.agent_monthly_report_builds
			set status = $2, result_dir = $3, payload_path = $4,
			    payload_sha256 = $5, workbook_path = $6, workbook_sha256 = $7,
			    calculation_version = $8, error_message = null,
			    finished_at = now(), updated_at = now()
			where id = $1`,
			buildID,
			agentMonthlyBuildStatusSuccess,
			buildDir,
			payloadPath,
			payloadDigest,
			workbookPath,
			workbookDigest,
			payload.CalculationVersion,
		); err != nil {
			return err
		}
		if err := refreshAgentMonthlyUploadStatus(ctx, txDB, build.UploadID); err != nil {
			return err
		}
		if s.auditor != nil {
			entry := agentMonthlyWorkerAuditEntry(build, "agent_monthly_reports.build.complete")
			entry.AfterJSON = map[string]any{
				"build_id":       buildID,
				"workbook_bytes": info.Size(),
				"workbook_sha":   workbookDigest,
				"payload_sha":    payloadDigest,
			}
			if err := s.auditor.LogActionTx(ctx, tx, entry); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		if payloadPath != "" {
			_ = os.Remove(payloadPath)
		}
		return err
	}
	return nil
}

func (s *AgentMonthlyReportStore) FailAgentMonthlyBuild(
	ctx context.Context,
	buildID int64,
	reason string,
) error {
	if s == nil || s.db == nil {
		return ErrAgentMonthlyDependency
	}
	reason = truncateAgentMonthlyReason(reason, 4000)
	return RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		build, err := s.getAgentMonthlyBuildUnscoped(ctx, txDB, buildID)
		if err != nil {
			return err
		}
		if _, err := txDB.Exec(ctx, `
			update public.agent_monthly_report_builds
			set status = $2, error_message = $3,
			    finished_at = now(), updated_at = now()
			where id = $1`,
			buildID,
			agentMonthlyBuildStatusFailed,
			reason,
		); err != nil {
			return err
		}
		if err := refreshAgentMonthlyUploadStatus(ctx, txDB, build.UploadID); err != nil {
			return err
		}
		if s.auditor != nil {
			entry := agentMonthlyWorkerAuditEntry(build, "agent_monthly_reports.build.failed")
			entry.Result = "failure"
			entry.ErrorMessage = &reason
			if err := s.auditor.LogActionTx(ctx, tx, entry); err != nil {
				return err
			}
		}
		return nil
	})
}

func (s *AgentMonthlyReportStore) ConfirmAgentMonthlyBuild(
	ctx context.Context,
	input AgentMonthlyBuildConfirmInput,
	entry audit.Entry,
) (*AgentMonthlyConfirmResult, error) {
	if s == nil || s.db == nil || s.auditor == nil {
		return nil, ErrAgentMonthlyDependency
	}
	var (
		confirmed AgentMonthlyConfirmResult
		created   []string
	)
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		build, err := s.getAgentMonthlyBuild(ctx, txDB, input.BuildID, input.AgentKeyID)
		if err != nil {
			return err
		}
		if !build.ExpiresAt.After(s.now()) {
			return ErrAgentMonthlyExpired
		}
		existing, err := findAgentMonthlyIdempotency(
			ctx,
			txDB,
			input.AgentKeyID,
			agentMonthlyIdempotencyConfirm,
			input.IdempotencyKey,
		)
		if err != nil {
			return err
		}
		if existing != nil {
			if existing.RequestHash != input.RequestHash {
				return ErrAgentMonthlyIdempotencyConflict
			}
			if existing.ReportID == nil {
				return ErrAgentMonthlyConflict
			}
			confirmed, err = getAgentMonthlyConfirmedResult(
				ctx,
				txDB,
				build,
				*existing.ReportID,
				true,
			)
			return err
		}
		if build.Status != agentMonthlyBuildStatusSuccess {
			return ErrAgentMonthlyNotReady
		}
		payload, err := s.loadAgentMonthlyBuildPayloadWithDB(ctx, txDB, build)
		if err != nil {
			return err
		}
		transactionFile, err := getAgentMonthlyFileByUploadKind(
			ctx,
			txDB,
			build.UploadID,
			agentMonthlyCSVKind,
		)
		if err != nil {
			return ErrAgentMonthlyNotReady
		}
		summaryFile, summaryErr := getAgentMonthlyFileByUploadKind(
			ctx,
			txDB,
			build.UploadID,
			agentMonthlyPDFKind,
		)
		if summaryErr != nil && !errors.Is(summaryErr, pgx.ErrNoRows) {
			return summaryErr
		}
		if build.WorkbookPath == nil || build.WorkbookSHA256 == nil {
			return ErrAgentMonthlyNotReady
		}
		root, err := ensureAgentMonthlyRoot(s.root)
		if err != nil {
			return err
		}
		workbookPath := existingRegularFile(build.WorkbookPath, root)
		if workbookPath == "" {
			return ErrAgentMonthlyNotReady
		}
		digest, err := sha256AgentMonthlyFile(workbookPath)
		if err != nil || digest != *build.WorkbookSHA256 {
			return ErrAgentMonthlyNotReady
		}
		transactionPath := agentMonthlyRegularSourcePath(transactionFile.StoredPath, root)
		if transactionPath == "" {
			return ErrAgentMonthlyNotReady
		}
		var summaryPath string
		if summaryFile != nil {
			summaryPath = agentMonthlyRegularSourcePath(summaryFile.StoredPath, root)
			if summaryPath == "" {
				return ErrAgentMonthlyNotReady
			}
		}

		lockKey := fmt.Sprintf(
			"monthly_report:%d:%s:%s",
			build.ProjectID,
			build.Country,
			build.ReportMonth,
		)
		var locked int
		if err := txDB.QueryRow(
			ctx,
			`select 1 from (select pg_advisory_xact_lock(hashtext($1))) locked`,
			lockKey,
		).Scan(&locked); err != nil {
			return err
		}
		var blockingID int64
		var blockingStatus string
		err = txDB.QueryRow(ctx, `
			select id, status::text
			from public.monthly_reports
			where project_id = $1 and country = $2 and report_month = $3
			  and status::text in ('pending', 'running', 'success')
			order by id asc
			limit 1`,
			build.ProjectID,
			build.Country,
			build.ReportMonth,
		).Scan(&blockingID, &blockingStatus)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if blockingID > 0 {
			return fmt.Errorf(
				"%w: existing report id=%d status=%s",
				ErrAgentMonthlyConflict,
				blockingID,
				blockingStatus,
			)
		}

		uploadRoot, err := ensureAgentMonthlyRoot(s.uploadRoot)
		if err != nil {
			return err
		}
		resultRoot, err := ensureAgentMonthlyRoot(s.resultRoot)
		if err != nil {
			return err
		}
		projectFolder := safeMonthlyAgentProjectFolder(build.ProjectName)
		transactionDir, err := ensureAgentMonthlyDir(uploadRoot, projectFolder, "payment-report")
		if err != nil {
			return err
		}
		transactionID := fmt.Sprintf(
			"agent-%d-%s.csv",
			build.ID,
			firstN(build.InputSHA256, 12),
		)
		formalTransactionPath := filepath.Join(transactionDir, transactionID)
		if err := copyAgentMonthlyFileExact(transactionPath, formalTransactionPath); err != nil {
			return err
		}
		created = append(created, formalTransactionPath)

		var (
			formalSummaryID   *string
			formalSummaryPath *string
		)
		if summaryFile != nil {
			summaryDir, err := ensureAgentMonthlyDir(uploadRoot, projectFolder, "monthly-summary-pdf")
			if err != nil {
				return err
			}
			id := fmt.Sprintf(
				"agent-%d-%s.pdf",
				build.ID,
				firstN(dereferenceString(build.SummaryPDFSHA256), 12),
			)
			path := filepath.Join(summaryDir, id)
			if err := copyAgentMonthlyFileExact(summaryPath, path); err != nil {
				return err
			}
			created = append(created, path)
			formalSummaryID = &id
			formalSummaryPath = &path
		}

		resultDir, err := ensureAgentMonthlyDir(
			resultRoot,
			fmt.Sprintf("agent-monthly-report-%d", build.ID),
		)
		if err != nil {
			return err
		}
		formalResultPath := filepath.Join(
			resultDir,
			safeUploadFilename(filepath.Base(workbookPath), "monthly-report.xlsx"),
		)
		if err := copyAgentMonthlyFileExact(workbookPath, formalResultPath); err != nil {
			return err
		}
		copiedDigest, err := sha256AgentMonthlyFile(formalResultPath)
		if err != nil || copiedDigest != digest {
			return ErrAgentMonthlyNotReady
		}
		created = append(created, formalResultPath)

		var latestVersion int
		if err := txDB.QueryRow(ctx, `
			select coalesce(max(version), 0)
			from public.monthly_reports
			where project_id = $1 and country = $2 and report_month = $3`,
			build.ProjectID,
			build.Country,
			build.ReportMonth,
		).Scan(&latestVersion); err != nil {
			return err
		}
		nextVersion := latestVersion + 1
		nowValue := s.now().UTC()
		var reportID int64
		if err := txDB.QueryRow(ctx, `
			insert into public.monthly_reports (
			  project_id, project_name, country, report_month, version,
			  is_current, transaction_file_id, transaction_file_path,
			  summary_pdf_file_id, summary_pdf_file_path, result_file_path,
			  settlement_id, file_size, total_transactions, total_orders,
			  total_refunds, total_adjustments, total_service_fees, total_trans_fees,
			  status, error_message, calculation_version, computed_at, created_at, updated_at
			) values (
			  $1, $2, $3, $4, $5, true, $6, $7, $8, $9, $10, nullif($11, ''),
			  $12, $13, $14, $15, $16, $17, $18, 'success'::public.jobstatus,
			  null, $19, $20, now(), now()
			) returning id`,
			build.ProjectID,
			build.ProjectName,
			build.Country,
			build.ReportMonth,
			nextVersion,
			transactionID,
			formalTransactionPath,
			formalSummaryID,
			formalSummaryPath,
			formalResultPath,
			payload.Result.SettlementID,
			transactionFile.SizeBytes,
			len(payload.Result.Transactions),
			countAgentMonthlyTransactions(payload.Result.Transactions, "Order"),
			countAgentMonthlyTransactions(payload.Result.Transactions, "Refund"),
			countAgentMonthlyTransactions(payload.Result.Transactions, "Adjustment"),
			countAgentMonthlyTransactions(payload.Result.Transactions, "Service Fee"),
			countAgentMonthlyTransactions(payload.Result.Transactions, "FBA Transaction Fees"),
			payload.CalculationVersion,
			nowValue,
		).Scan(&reportID); err != nil {
			return err
		}
		if _, err := txDB.Exec(ctx, `
			update public.monthly_reports
			set is_current = false, superseded_at = $4, updated_at = $4
			where project_id = $1 and country = $2 and report_month = $3
			  and id <> $5 and is_current = true`,
			build.ProjectID,
			build.Country,
			build.ReportMonth,
			nowValue,
			reportID,
		); err != nil {
			return err
		}
		computed := MonthlyReportComputedResult{
			ResultPath:   formalResultPath,
			Transactions: agentMonthlyComputedTransactions(payload.Result.Transactions),
			PT3:          payload.Result.PT3,
			PT4:          payload.Result.PT4,
			SettlementID: payload.Result.SettlementID,
		}
		if err := insertMonthlyReportTransactions(
			ctx,
			txDB,
			reportID,
			build.ProjectName,
			build.ReportMonth,
			computed.Transactions,
		); err != nil {
			return err
		}
		if err := insertMonthlyReportPT3(
			ctx,
			txDB,
			reportID,
			build.ProjectName,
			build.ReportMonth,
			computed.PT3,
		); err != nil {
			return err
		}
		if err := insertMonthlyReportPT4(
			ctx,
			txDB,
			reportID,
			build.ProjectName,
			build.ReportMonth,
			computed.PT4,
		); err != nil {
			return err
		}
		if _, err := txDB.Exec(ctx, `
			update public.agent_monthly_report_builds
			set confirmed_at = $2, report_id = $3,
			    confirm_idempotency_key = $4, updated_at = $2
			where id = $1`,
			build.ID,
			nowValue,
			reportID,
			input.IdempotencyKey,
		); err != nil {
			return err
		}
		if _, err := txDB.Exec(ctx, `
			update public.agent_monthly_report_uploads
			set status = $2, updated_at = $3
			where id = $1`,
			build.UploadID,
			agentMonthlyUploadStatusConfirmed,
			nowValue,
		); err != nil {
			return err
		}
		if _, err := txDB.Exec(ctx, `
			insert into public.agent_monthly_report_idempotency (
			  agent_api_key_id, action, idempotency_key, request_hash,
			  build_id, report_id, created_at
			) values ($1, $2, $3, $4, $5, $6, now())`,
			input.AgentKeyID,
			agentMonthlyIdempotencyConfirm,
			input.IdempotencyKey,
			input.RequestHash,
			build.ID,
			reportID,
		); err != nil {
			return err
		}
		confirmed = AgentMonthlyConfirmResult{
			BuildID:     build.ID,
			ReportID:    reportID,
			Replayed:    false,
			ProjectID:   build.ProjectID,
			ProjectName: build.ProjectName,
			Country:     build.Country,
			ReportMonth: build.ReportMonth,
			Version:     nextVersion,
			IsCurrent:   true,
			Status:      "success",
			ConfirmedAt: &nowValue,
		}
		entry.Action = "agent_monthly_reports.confirm"
		entry.TargetType = "monthly_report"
		target := strconv.FormatInt(reportID, 10)
		entry.TargetID = &target
		entry.AfterJSON = map[string]any{
			"build_id":      build.ID,
			"upload_id":     build.UploadID,
			"project_id":    build.ProjectID,
			"project_name":  build.ProjectName,
			"country":       build.Country,
			"report_month":  build.ReportMonth,
			"input_sha256":  build.InputSHA256,
			"result_sha256": digest,
			"report_id":     reportID,
		}
		return s.auditor.LogActionTx(ctx, tx, entry)
	})
	if err != nil {
		cleanupAgentMonthlyFiles(created)
		return nil, err
	}
	return &confirmed, nil
}

func (s *AgentMonthlyReportStore) GetAgentMonthlyConfirmReplay(
	ctx context.Context,
	input AgentMonthlyBuildConfirmInput,
) (*AgentMonthlyConfirmResult, error) {
	if s == nil || s.db == nil {
		return nil, ErrAgentMonthlyDependency
	}
	build, err := s.getAgentMonthlyBuild(ctx, s.db, input.BuildID, input.AgentKeyID)
	if err != nil {
		return nil, err
	}
	existing, err := findAgentMonthlyIdempotency(
		ctx,
		s.db,
		input.AgentKeyID,
		agentMonthlyIdempotencyConfirm,
		input.IdempotencyKey,
	)
	if err != nil {
		return nil, err
	}
	if existing == nil {
		return nil, nil
	}
	if existing.RequestHash != input.RequestHash {
		return nil, ErrAgentMonthlyIdempotencyConflict
	}
	if existing.ReportID == nil {
		return nil, ErrAgentMonthlyConflict
	}
	result, err := getAgentMonthlyConfirmedResult(ctx, s.db, build, *existing.ReportID, true)
	if err != nil {
		return nil, err
	}
	return &result, nil
}

type agentMonthlyFileRow struct {
	ID               int64
	UploadID         int64
	Kind             string
	FileID           string
	OriginalFilename string
	StoredPath       string
	ContentType      *string
	SHA256           string
	SizeBytes        int64
}

type agentMonthlyIdempotencyRow struct {
	RequestHash string
	BuildID     *int64
	ReportID    *int64
}

func (s *AgentMonthlyReportStore) getAgentMonthlyUpload(
	ctx context.Context,
	db FullDB,
	uploadID int64,
	agentKeyID int64,
	forUpdate bool,
) (*AgentMonthlyUpload, error) {
	if db == nil {
		return nil, ErrAgentMonthlyDependency
	}
	query := `
		select id, agent_api_key_id, agent_id, project_id, project_name,
		       country, report_month, status, expires_at, created_at, updated_at
		from public.agent_monthly_report_uploads
		where id = $1 and agent_api_key_id = $2`
	if forUpdate {
		query += " for update"
	}
	var upload AgentMonthlyUpload
	err := db.QueryRow(ctx, query, uploadID, agentKeyID).Scan(
		&upload.ID,
		&upload.AgentKeyID,
		&upload.AgentID,
		&upload.ProjectID,
		&upload.ProjectName,
		&upload.Country,
		&upload.ReportMonth,
		&upload.Status,
		&upload.ExpiresAt,
		&upload.CreatedAt,
		&upload.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrAgentMonthlyNotFound
		}
		return nil, err
	}
	return &upload, nil
}

func (s *AgentMonthlyReportStore) getAgentMonthlyUploadForUpdate(
	ctx context.Context,
	db FullDB,
	uploadID int64,
	agentKeyID int64,
) (*AgentMonthlyUpload, error) {
	return s.getAgentMonthlyUpload(ctx, db, uploadID, agentKeyID, true)
}

func (s *AgentMonthlyReportStore) getAgentMonthlyBuild(
	ctx context.Context,
	db FullDB,
	buildID int64,
	agentKeyID int64,
) (*AgentMonthlyBuild, error) {
	build, err := s.getAgentMonthlyBuildUnscoped(ctx, db, buildID)
	if err != nil {
		return nil, err
	}
	if build.AgentKeyID != agentKeyID {
		return nil, ErrAgentMonthlyNotFound
	}
	return build, nil
}

func (s *AgentMonthlyReportStore) getAgentMonthlyBuildUnscoped(
	ctx context.Context,
	db FullDB,
	buildID int64,
) (*AgentMonthlyBuild, error) {
	var (
		build                AgentMonthlyBuild
		summarySHA           *string
		idempotencyKey       *string
		resultDir            *string
		payloadPath          *string
		payloadSHA           *string
		workbookPath         *string
		workbookSHA          *string
		calculationVersion   *int
		errorMessage         *string
		reportID             *int64
		confirmedAt          pgtype.Timestamptz
		expiresAt, createdAt time.Time
		updatedAt            time.Time
	)
	err := db.QueryRow(ctx, `
		select b.id, b.upload_id, b.agent_api_key_id, b.agent_id, b.status,
		       b.input_sha256, b.summary_pdf_sha256, b.idempotency_key,
		       b.result_dir, b.payload_path,
		       b.payload_sha256, b.workbook_path, b.workbook_sha256,
		       b.calculation_version, b.error_message, b.report_id, b.confirmed_at,
		       b.expires_at, b.created_at, b.updated_at,
		       u.project_id, u.project_name, u.country, u.report_month
		from public.agent_monthly_report_builds b
		join public.agent_monthly_report_uploads u on u.id = b.upload_id
		where b.id = $1`,
		buildID,
	).Scan(
		&build.ID,
		&build.UploadID,
		&build.AgentKeyID,
		&build.AgentID,
		&build.Status,
		&build.InputSHA256,
		&summarySHA,
		&idempotencyKey,
		&resultDir,
		&payloadPath,
		&payloadSHA,
		&workbookPath,
		&workbookSHA,
		&calculationVersion,
		&errorMessage,
		&reportID,
		&confirmedAt,
		&expiresAt,
		&createdAt,
		&updatedAt,
		&build.ProjectID,
		&build.ProjectName,
		&build.Country,
		&build.ReportMonth,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrAgentMonthlyNotFound
		}
		return nil, err
	}
	build.SummaryPDFSHA256 = summarySHA
	build.IdempotencyKey = idempotencyKey
	build.ResultDir = resultDir
	build.PayloadPath = payloadPath
	build.PayloadSHA256 = payloadSHA
	build.WorkbookPath = workbookPath
	build.WorkbookSHA256 = workbookSHA
	build.CalculationVersion = calculationVersion
	build.ErrorMessage = errorMessage
	build.ReportID = reportID
	build.ConfirmedAt = agentMonthlyTimestamp(confirmedAt)
	build.ExpiresAt = expiresAt
	build.CreatedAt = createdAt
	build.UpdatedAt = updatedAt
	if build.Status == agentMonthlyBuildStatusSuccess {
		var existingID int64
		err := db.QueryRow(ctx, `
			select id from public.monthly_reports
			where project_id = $1 and country = $2 and report_month = $3
			  and status::text = 'success'
			order by id asc
			limit 1`,
			build.ProjectID,
			build.Country,
			build.ReportMonth,
		).Scan(&existingID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
		if existingID > 0 {
			build.ExistingSuccessReportID = &existingID
		}

		var blockingID int64
		var blockingStatus string
		err = db.QueryRow(ctx, `
			select id, status::text
			from public.monthly_reports
			where project_id = $1 and country = $2 and report_month = $3
			  and status::text in ('pending', 'running', 'success')
			order by id asc
			limit 1`,
			build.ProjectID,
			build.Country,
			build.ReportMonth,
		).Scan(&blockingID, &blockingStatus)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
		if blockingID > 0 {
			build.BlockingReportID = &blockingID
			build.BlockingReportStatus = &blockingStatus
		}
	}
	return &build, nil
}

func findAgentMonthlyIdempotency(
	ctx context.Context,
	db FullDB,
	agentKeyID int64,
	action string,
	idempotencyKey string,
) (*agentMonthlyIdempotencyRow, error) {
	var row agentMonthlyIdempotencyRow
	err := db.QueryRow(ctx, `
		select request_hash, build_id, report_id
		from public.agent_monthly_report_idempotency
		where agent_api_key_id = $1 and action = $2 and idempotency_key = $3`,
		agentKeyID,
		action,
		idempotencyKey,
	).Scan(&row.RequestHash, &row.BuildID, &row.ReportID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &row, nil
}

func getAgentMonthlyFile(
	ctx context.Context,
	db FullDB,
	uploadID int64,
	fileID string,
	kind string,
) (*agentMonthlyFileRow, error) {
	var file agentMonthlyFileRow
	err := db.QueryRow(ctx, `
		select id, upload_id, kind, file_id, original_filename,
		       stored_path, content_type, sha256, size_bytes
		from public.agent_monthly_report_files
		where upload_id = $1 and file_id = $2 and kind = $3`,
		uploadID,
		strings.TrimSpace(fileID),
		kind,
	).Scan(
		&file.ID,
		&file.UploadID,
		&file.Kind,
		&file.FileID,
		&file.OriginalFilename,
		&file.StoredPath,
		&file.ContentType,
		&file.SHA256,
		&file.SizeBytes,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrAgentMonthlyNotFound
		}
		return nil, err
	}
	return &file, nil
}

func getAgentMonthlyFileByUploadKind(
	ctx context.Context,
	db FullDB,
	uploadID int64,
	kind string,
) (*agentMonthlyFileRow, error) {
	var file agentMonthlyFileRow
	err := db.QueryRow(ctx, `
		select id, upload_id, kind, file_id, original_filename,
		       stored_path, content_type, sha256, size_bytes
		from public.agent_monthly_report_files
		where upload_id = $1 and kind = $2`,
		uploadID,
		kind,
	).Scan(
		&file.ID,
		&file.UploadID,
		&file.Kind,
		&file.FileID,
		&file.OriginalFilename,
		&file.StoredPath,
		&file.ContentType,
		&file.SHA256,
		&file.SizeBytes,
	)
	if err != nil {
		return nil, err
	}
	return &file, nil
}

func refreshAgentMonthlyUploadStatus(
	ctx context.Context,
	db FullDB,
	uploadID int64,
) error {
	var (
		status        string
		successCount  int
		activeCount   int
		terminalCount int
		totalCount    int
	)
	if err := db.QueryRow(ctx, `
		select u.status,
		       count(b.id) filter (where b.status = 'success'),
		       count(b.id) filter (where b.status in ('queued', 'running')),
		       count(b.id) filter (where b.status in ('failed', 'expired', 'cancelled')),
		       count(b.id)
		from public.agent_monthly_report_uploads u
		left join public.agent_monthly_report_builds b on b.upload_id = u.id
		where u.id = $1
		group by u.status`,
		uploadID,
	).Scan(&status, &successCount, &activeCount, &terminalCount, &totalCount); err != nil {
		return err
	}
	if status == agentMonthlyUploadStatusConfirmed {
		return nil
	}
	next := agentMonthlyUploadStatusOpen
	switch {
	case successCount > 0:
		next = agentMonthlyUploadStatusBuilt
	case activeCount > 0:
		next = agentMonthlyUploadStatusBuilding
	case terminalCount == totalCount && totalCount > 0:
		next = agentMonthlyUploadStatusFailed
	}
	_, err := db.Exec(ctx, `
		update public.agent_monthly_report_uploads
		set status = $2, updated_at = now()
		where id = $1`,
		uploadID,
		next,
	)
	return err
}

func (s *AgentMonthlyReportStore) loadAgentMonthlyBuildPayload(
	build *AgentMonthlyBuild,
) (*agentMonthlyBuildPayload, error) {
	return s.loadAgentMonthlyBuildPayloadWithDB(context.Background(), s.db, build)
}

func (s *AgentMonthlyReportStore) loadAgentMonthlyBuildPayloadWithDB(
	ctx context.Context,
	db FullDB,
	build *AgentMonthlyBuild,
) (*agentMonthlyBuildPayload, error) {
	if build == nil || build.PayloadPath == nil || build.PayloadSHA256 == nil {
		return nil, ErrAgentMonthlyNotReady
	}
	root, err := ensureAgentMonthlyRoot(s.root)
	if err != nil {
		return nil, err
	}
	path := existingRegularFile(build.PayloadPath, root)
	if path == "" {
		return nil, ErrAgentMonthlyNotReady
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, ErrAgentMonthlyNotReady
	}
	digest := sha256Hex(raw)
	if digest != *build.PayloadSHA256 {
		return nil, ErrAgentMonthlyNotReady
	}
	var payload agentMonthlyBuildPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, ErrAgentMonthlyNotReady
	}
	if payload.CalculationVersion != 1 ||
		payload.InputSHA256 != build.InputSHA256 ||
		len(payload.Result.PT3) == 0 ||
		len(payload.Result.PT4) == 0 {
		return nil, ErrAgentMonthlyNotReady
	}
	_ = ctx
	_ = db
	return &payload, nil
}

func getAgentMonthlyConfirmedResult(
	ctx context.Context,
	db FullDB,
	build *AgentMonthlyBuild,
	reportID int64,
	replayed bool,
) (AgentMonthlyConfirmResult, error) {
	var (
		projectID   int64
		projectName string
		country     string
		reportMonth string
		version     int
		isCurrent   bool
		status      string
		computedAt  pgtype.Timestamptz
	)
	err := db.QueryRow(ctx, `
		select project_id, project_name, country, report_month, version,
		       is_current, status::text, computed_at
		from public.monthly_reports
		where id = $1`,
		reportID,
	).Scan(
		&projectID,
		&projectName,
		&country,
		&reportMonth,
		&version,
		&isCurrent,
		&status,
		&computedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return AgentMonthlyConfirmResult{}, ErrAgentMonthlyNotFound
		}
		return AgentMonthlyConfirmResult{}, err
	}
	return AgentMonthlyConfirmResult{
		BuildID:     build.ID,
		ReportID:    reportID,
		Replayed:    replayed,
		ProjectID:   projectID,
		ProjectName: projectName,
		Country:     country,
		ReportMonth: reportMonth,
		Version:     version,
		IsCurrent:   isCurrent,
		Status:      status,
		ConfirmedAt: agentMonthlyTimestamp(computedAt),
	}, nil
}

func agentMonthlyPayloadTransactions(rows []MonthlyReportComputedTransaction) []agentMonthlyBuildTransaction {
	result := make([]agentMonthlyBuildTransaction, 0, len(rows))
	for _, row := range rows {
		result = append(result, agentMonthlyBuildTransaction{
			SourceRowNo:            row.SourceRowNo,
			TransactionDate:        row.TransactionDate,
			SettlementID:           row.SettlementID,
			TransactionType:        row.TransactionType,
			OrderID:                row.OrderID,
			SKU:                    row.SKU,
			Description:            row.Description,
			Quantity:               row.Quantity,
			Marketplace:            row.Marketplace,
			AccountType:            row.AccountType,
			Fulfillment:            row.Fulfillment,
			OrderCity:              row.OrderCity,
			OrderState:             row.OrderState,
			OrderPostal:            row.OrderPostal,
			TaxCollectionModel:     row.TaxCollectionModel,
			ProductSales:           row.ProductSales,
			ProductSalesTax:        row.ProductSalesTax,
			ShippingCredits:        row.ShippingCredits,
			ShippingCreditsTax:     row.ShippingCreditsTax,
			GiftWrapCredits:        row.GiftWrapCredits,
			GiftWrapCreditsTax:     row.GiftWrapCreditsTax,
			RegulatoryFee:          row.RegulatoryFee,
			RegulatoryFeeTax:       row.RegulatoryFeeTax,
			PromotionalRebates:     row.PromotionalRebates,
			PromotionalRebatesTax:  row.PromotionalRebatesTax,
			MarketplaceWithheldTax: row.MarketplaceWithheldTax,
			SellingFees:            row.SellingFees,
			FBAFees:                row.FBAFees,
			OtherTransactionFees:   row.OtherTransactionFees,
			OtherAmount:            row.OtherAmount,
			Total:                  row.Total,
			RawRowJSON:             row.RawRowJSON,
		})
	}
	return result
}

func agentMonthlyComputedTransactions(rows []agentMonthlyBuildTransaction) []MonthlyReportComputedTransaction {
	result := make([]MonthlyReportComputedTransaction, 0, len(rows))
	for _, row := range rows {
		result = append(result, MonthlyReportComputedTransaction{
			SourceRowNo:            row.SourceRowNo,
			TransactionDate:        row.TransactionDate,
			SettlementID:           row.SettlementID,
			TransactionType:        row.TransactionType,
			OrderID:                row.OrderID,
			SKU:                    row.SKU,
			Description:            row.Description,
			Quantity:               row.Quantity,
			Marketplace:            row.Marketplace,
			AccountType:            row.AccountType,
			Fulfillment:            row.Fulfillment,
			OrderCity:              row.OrderCity,
			OrderState:             row.OrderState,
			OrderPostal:            row.OrderPostal,
			TaxCollectionModel:     row.TaxCollectionModel,
			ProductSales:           row.ProductSales,
			ProductSalesTax:        row.ProductSalesTax,
			ShippingCredits:        row.ShippingCredits,
			ShippingCreditsTax:     row.ShippingCreditsTax,
			GiftWrapCredits:        row.GiftWrapCredits,
			GiftWrapCreditsTax:     row.GiftWrapCreditsTax,
			RegulatoryFee:          row.RegulatoryFee,
			RegulatoryFeeTax:       row.RegulatoryFeeTax,
			PromotionalRebates:     row.PromotionalRebates,
			PromotionalRebatesTax:  row.PromotionalRebatesTax,
			MarketplaceWithheldTax: row.MarketplaceWithheldTax,
			SellingFees:            row.SellingFees,
			FBAFees:                row.FBAFees,
			OtherTransactionFees:   row.OtherTransactionFees,
			OtherAmount:            row.OtherAmount,
			Total:                  row.Total,
			RawRowJSON:             row.RawRowJSON,
		})
	}
	return result
}

func copyStringMap(source map[string]string) map[string]string {
	if source == nil {
		return nil
	}
	result := make(map[string]string, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}

func countAgentMonthlyTransactions(rows []agentMonthlyBuildTransaction, transactionType string) int {
	count := 0
	for _, row := range rows {
		if strings.TrimSpace(row.TransactionType) == transactionType {
			count++
		}
	}
	return count
}

func validateAgentMonthlyWorkbook(path, buildDir string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" || !filepath.IsAbs(path) {
		return "", ErrAgentMonthlyNotReady
	}
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return "", ErrAgentMonthlyNotReady
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil || !pathWithinRoot(buildDir, resolved) {
		return "", ErrAgentMonthlyNotReady
	}
	if strings.ToLower(filepath.Ext(resolved)) != ".xlsx" {
		return "", ErrAgentMonthlyNotReady
	}
	file, err := os.Open(resolved)
	if err != nil {
		return "", err
	}
	defer file.Close()
	var magic [4]byte
	if _, err := file.Read(magic[:]); err != nil {
		return "", ErrAgentMonthlyNotReady
	}
	if string(magic[:]) != "PK\x03\x04" {
		return "", ErrAgentMonthlyNotReady
	}
	return resolved, nil
}

func validateAgentMonthlyUploadedFile(path, kind string) (map[string]any, error) {
	if kind == agentMonthlyPDFKind {
		file, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		defer file.Close()
		head := make([]byte, 5)
		if _, err := file.Read(head); err != nil || string(head) != "%PDF-" {
			return nil, fmt.Errorf("%w: invalid PDF signature", ErrAgentMonthlyInvalidInput)
		}
		return map[string]any{}, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if err := validateAgentMonthlyCSVData(data); err != nil {
		return nil, err
	}
	reader := csvReaderData(data)
	return map[string]any{"rows": reader}, nil
}

func newAgentMonthlyCSVReader(data []byte) (*csv.Reader, error) {
	if len(data) == 0 {
		return nil, ErrAgentMonthlyInvalidInput
	}
	reader := csv.NewReader(strings.NewReader(string(data)))
	reader.FieldsPerRecord = -1
	return reader, nil
}

func csvReaderData(data []byte) int {
	reader, err := newAgentMonthlyCSVReader(data)
	if err != nil {
		return 0
	}
	count := 0
	for {
		record, err := reader.Read()
		if err != nil {
			if err == io.EOF {
				break
			}
			return 0
		}
		if len(record) > 0 {
			count++
		}
	}
	if count > 0 {
		count--
	}
	return count
}

func agentMonthlyContentTypeAllowed(kind, contentType string) bool {
	contentType = strings.ToLower(strings.TrimSpace(contentType))
	if kind == agentMonthlyPDFKind {
		return contentType == "" || contentType == "application/pdf" || contentType == "application/octet-stream"
	}
	switch contentType {
	case "", "text/csv", "application/csv", "application/vnd.ms-excel", "text/plain", "application/octet-stream":
		return true
	default:
		return false
	}
}

func ensureAgentMonthlyRoot(root string) (string, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return "", ErrAgentMonthlyDependency
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(absolute, 0o700); err != nil {
		return "", err
	}
	info, err := os.Lstat(absolute)
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return "", ErrAgentMonthlyDependency
	}
	if err := os.Chmod(absolute, 0o700); err != nil {
		// Best effort, matching the private-directory contract.
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", err
	}
	return resolved, nil
}

func ensureAgentMonthlyDir(root string, segments ...string) (string, error) {
	root, err := ensureAgentMonthlyRoot(root)
	if err != nil {
		return "", err
	}
	candidate := filepath.Join(append([]string{root}, segments...)...)
	if err := os.MkdirAll(candidate, 0o700); err != nil {
		return "", err
	}
	info, err := os.Lstat(candidate)
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return "", ErrAgentMonthlyInvalidInput
	}
	resolved, err := filepath.EvalSymlinks(candidate)
	if err != nil || !pathWithinRoot(root, resolved) {
		return "", ErrAgentMonthlyInvalidInput
	}
	return resolved, nil
}

func copyAgentMonthlyFile(source, destination string, maxBytes int64) (string, int64, error) {
	input, err := os.Open(source)
	if err != nil {
		return "", 0, err
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return "", 0, err
	}
	success := false
	defer func() {
		_ = output.Close()
		if !success {
			_ = os.Remove(destination)
		}
	}()
	hash := sha256.New()
	size, err := io.Copy(io.MultiWriter(output, hash), io.LimitReader(input, maxBytes+1))
	if err != nil {
		return "", 0, err
	}
	if size > maxBytes || size == 0 {
		return "", 0, ErrAgentMonthlyInvalidInput
	}
	if err := output.Sync(); err != nil {
		return "", 0, err
	}
	if err := output.Close(); err != nil {
		return "", 0, err
	}
	success = true
	return hex.EncodeToString(hash.Sum(nil)), size, nil
}

func copyAgentMonthlyFileExact(source, destination string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	success := false
	defer func() {
		_ = output.Close()
		if !success {
			_ = os.Remove(destination)
		}
	}()
	if _, err := io.Copy(output, input); err != nil {
		return err
	}
	if err := output.Sync(); err != nil {
		return err
	}
	if err := output.Close(); err != nil {
		return err
	}
	success = true
	return nil
}

func writeAgentMonthlyFileExclusive(path string, data []byte, mode os.FileMode) (string, error) {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return "", err
	}
	success := false
	defer func() {
		_ = file.Close()
		if !success {
			_ = os.Remove(path)
		}
	}()
	if _, err := file.Write(data); err != nil {
		return "", err
	}
	if err := file.Sync(); err != nil {
		return "", err
	}
	if err := file.Close(); err != nil {
		return "", err
	}
	success = true
	return sha256Hex(data), nil
}

func sha256AgentMonthlyFile(path string) (string, error) {
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

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func agentMonthlyRandomHex(bytesCount int) string {
	if bytesCount <= 0 {
		bytesCount = 16
	}
	buffer := make([]byte, bytesCount)
	if _, err := rand.Read(buffer); err != nil {
		panic("crypto/rand failed")
	}
	return hex.EncodeToString(buffer)
}

func safeMonthlyAgentProjectFolder(value string) string {
	var builder strings.Builder
	for _, character := range strings.TrimSpace(value) {
		switch {
		case strings.ContainsRune(`\/:*?"<>|`, character), unicode.IsControl(character):
			builder.WriteByte('-')
		case unicode.IsSpace(character):
			builder.WriteByte('-')
		default:
			builder.WriteRune(character)
		}
	}
	result := strings.Trim(builder.String(), " .-")
	if result == "" {
		result = "project"
	}
	runes := []rune(result)
	if len(runes) > 80 {
		result = string(runes[:80])
	}
	return result
}

func agentMonthlyRegularSourcePath(path, root string) string {
	temp := path
	return existingRegularFile(&temp, root)
}

func nullableAgentMonthlyString(
	file *agentMonthlyFileRow,
	value func(*agentMonthlyFileRow) string,
) any {
	if file == nil {
		return nil
	}
	result := value(file)
	if strings.TrimSpace(result) == "" {
		return nil
	}
	return result
}

func agentMonthlyWorkerAuditEntry(build *AgentMonthlyBuild, action string) audit.Entry {
	if build == nil {
		return audit.Entry{Action: action}
	}
	entry := audit.Entry{
		Action:     action,
		AgentID:    stringPointerValue(build.AgentID),
		TargetType: "agent_monthly_report_build",
	}
	if build.IdempotencyKey != nil && strings.TrimSpace(*build.IdempotencyKey) != "" {
		entry.IdempotencyKey = build.IdempotencyKey
	}
	target := strconv.FormatInt(build.ID, 10)
	entry.TargetID = &target
	return entry
}

func cleanupAgentMonthlyFiles(paths []string) {
	for index := len(paths) - 1; index >= 0; index-- {
		_ = os.Remove(paths[index])
	}
}

func truncateAgentMonthlyReason(value string, limit int) string {
	value = strings.TrimSpace(value)
	if limit <= 0 || len(value) <= limit {
		return value
	}
	return value[:limit]
}

func firstN(value string, n int) string {
	if n <= 0 || len(value) <= n {
		return value
	}
	return value[:n]
}
