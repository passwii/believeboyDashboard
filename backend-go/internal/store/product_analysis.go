package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/product_analysis"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/uploads"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type ProductAnalysisStore struct {
	db     DB
	engine product_analysis.CalculationEngine
}

func NewProductAnalysisStore(db DB) *ProductAnalysisStore {
	store := &ProductAnalysisStore{db: db}
	if fullDB, ok := db.(FullDB); ok && fullDB != nil {
		store.engine = NewProductAnalysisCalculationEngine(
			fullDB,
			productAnalysisUploadRoot(),
		)
	}
	return store
}

// CalculationEngine exposes the production calculation engine to the API
// handler while keeping route wiring independent of the concrete store type.
func (s *ProductAnalysisStore) CalculationEngine() product_analysis.CalculationEngine {
	if s == nil {
		return nil
	}
	return s.engine
}

func (s *ProductAnalysisStore) VerifyProjectAccess(
	ctx context.Context,
	projectID int64,
	operator string,
	isAdmin bool,
) error {
	if s == nil || s.db == nil {
		return errors.New("product analysis database is nil")
	}
	var projectOperator, assistantOperator *string
	err := s.db.QueryRow(
		ctx,
		`select project_operator, assistant_operator from public.projects where id = $1`,
		projectID,
	).Scan(&projectOperator, &assistantOperator)
	if errors.Is(err, pgx.ErrNoRows) {
		return product_analysis.ErrProjectNotFound
	}
	if err != nil {
		return err
	}
	if isAdmin {
		return nil
	}
	operator = strings.TrimSpace(operator)
	if operator == "" {
		return product_analysis.ErrProjectForbidden
	}
	if productAnalysisContainsOperator(projectOperator, operator) ||
		productAnalysisContainsOperator(assistantOperator, operator) {
		return nil
	}
	return product_analysis.ErrProjectForbidden
}

func (s *ProductAnalysisStore) AccessibleProjectIDs(
	ctx context.Context,
	operator string,
	isAdmin bool,
) ([]int64, error) {
	if isAdmin {
		rows, err := s.db.Query(
			ctx,
			`select id from public.projects
			 where coalesce(is_active, true)
			 order by coalesce(is_active, true) desc, sort_order asc, id asc`,
		)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		return productAnalysisScanProjectIDs(rows)
	}

	operator = strings.TrimSpace(operator)
	if operator == "" {
		return []int64{}, nil
	}
	rows, err := s.db.Query(
		ctx,
		`select id, coalesce(project_operator, ''), coalesce(assistant_operator, '')
		 from public.projects
		 where coalesce(is_active, true)
		 order by coalesce(is_active, true) desc, sort_order asc, id asc`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ids []int64
	for rows.Next() {
		var (
			id                int64
			projectOperator   string
			assistantOperator string
		)
		if err := rows.Scan(&id, &projectOperator, &assistantOperator); err != nil {
			return nil, err
		}
		if productAnalysisContainsOperator(&projectOperator, operator) ||
			productAnalysisContainsOperator(&assistantOperator, operator) {
			ids = append(ids, id)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if ids == nil {
		ids = []int64{}
	}
	return ids, nil
}

func (s *ProductAnalysisStore) ProjectIDByName(
	ctx context.Context,
	projectName string,
) (int64, error) {
	var projectID int64
	err := s.db.QueryRow(
		ctx,
		`select id from public.projects where project_name = $1 limit 1`,
		strings.TrimSpace(projectName),
	).Scan(&projectID)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, product_analysis.ErrProjectNotFound
	}
	if err != nil {
		return 0, err
	}
	return projectID, nil
}

func (s *ProductAnalysisStore) SourceProjectID(
	ctx context.Context,
	sourceID int64,
) (int64, error) {
	var projectID int64
	err := s.db.QueryRow(
		ctx,
		`select project_id from public.analysis_source_files where id = $1`,
		sourceID,
	).Scan(&projectID)
	if err == nil {
		return projectID, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return 0, err
	}
	err = s.db.QueryRow(
		ctx,
		`select project_id
		 from public.ad_upload_files
		 where id = $1 and report_type = 'ad_promoted_product_report'`,
		sourceID,
	).Scan(&projectID)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, product_analysis.ErrNotFound
	}
	if err != nil {
		return 0, err
	}
	return projectID, nil
}

func (s *ProductAnalysisStore) ListSources(
	ctx context.Context,
	filter product_analysis.SourceFilter,
) ([]product_analysis.AnalysisSourceFileItem, error) {
	if filter.ProjectIDs != nil && len(filter.ProjectIDs) == 0 {
		return []product_analysis.AnalysisSourceFileItem{}, nil
	}

	includeA := filter.ReportType == nil || *filter.ReportType != "ad_product_report"
	includeAD := filter.ReportType == nil || *filter.ReportType == "ad_product_report"
	items := make([]product_analysis.AnalysisSourceFileItem, 0)

	if includeA {
		query, args := productAnalysisSourceASQL(filter)
		rows, err := s.db.Query(
			ctx,
			query,
			args...,
		)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			item, scanErr := productAnalysisScanSourceA(rows)
			if scanErr != nil {
				rows.Close()
				return nil, scanErr
			}
			items = append(items, item)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}

	if includeAD {
		query, args := productAnalysisSourceADSQL(filter)
		rows, err := s.db.Query(
			ctx,
			query,
			args...,
		)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			item, scanErr := productAnalysisScanSourceAD(rows)
			if scanErr != nil {
				rows.Close()
				return nil, scanErr
			}
			items = append(items, item)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}

	sort.SliceStable(items, func(i, j int) bool {
		if items[i].CreatedAtSort.Equal(items[j].CreatedAtSort) {
			if items[i].ID == items[j].ID {
				return items[i].SourceKind < items[j].SourceKind
			}
			return items[i].ID > items[j].ID
		}
		return items[i].CreatedAtSort.After(items[j].CreatedAtSort)
	})
	if items == nil {
		items = []product_analysis.AnalysisSourceFileItem{}
	}
	return items, nil
}

func productAnalysisSourceASQL(filter product_analysis.SourceFilter) (string, []any) {
	conditions := []string{"true"}
	var args []any
	placeholder := 1
	if filter.ProjectID != nil {
		conditions = append(conditions, fmt.Sprintf("project_id = $%d", placeholder))
		args = append(args, *filter.ProjectID)
		placeholder++
	} else if filter.ProjectIDs != nil {
		conditions = append(conditions, fmt.Sprintf("project_id = any($%d)", placeholder))
		args = append(args, filter.ProjectIDs)
		placeholder++
	}
	if filter.ReportType != nil {
		conditions = append(conditions, fmt.Sprintf("report_type = $%d", placeholder))
		args = append(args, *filter.ReportType)
		placeholder++
	}
	if filter.CurrentOnly {
		conditions = append(conditions, "is_current")
	}
	if filter.PeriodStartDate != nil {
		conditions = append(
			conditions,
			fmt.Sprintf(
				"((period_end_date is not null and period_end_date >= $%d::date) "+
					"or (snapshot_at is not null and snapshot_at >= $%d::date))",
				placeholder,
				placeholder,
			),
		)
		args = append(args, filter.PeriodStartDate.Format("2006-01-02"))
		placeholder++
	}
	if filter.PeriodEndDate != nil {
		conditions = append(
			conditions,
			fmt.Sprintf(
				"((period_start_date is not null and period_start_date <= $%d::date) "+
					"or (snapshot_at is not null and snapshot_at < ($%d::date + interval '1 day')))",
				placeholder,
				placeholder,
			),
		)
		args = append(args, filter.PeriodEndDate.Format("2006-01-02"))
		placeholder++
	}
	return `select id, project_id, report_type, report_date, period_start_date,
		       period_end_date, snapshot_at, version, is_current, superseded_at,
		       upload_file_id, upload_file_path, original_filename, stored_filename,
		       logical_filename, storage_key, file_size_bytes::text, file_sha256,
		       ingestion_status, ingestion_error, row_count_total, row_count_included,
		       created_by, created_at, updated_at
		 from public.analysis_source_files
		 where ` + strings.Join(conditions, " and ") + `
		 order by created_at desc, id desc`, args
}

func productAnalysisSourceADSQL(filter product_analysis.SourceFilter) (string, []any) {
	conditions := []string{
		"report_type = 'ad_promoted_product_report'",
	}
	var args []any
	placeholder := 1
	if filter.ProjectID != nil {
		conditions = append(conditions, fmt.Sprintf("project_id = $%d", placeholder))
		args = append(args, *filter.ProjectID)
		placeholder++
	} else if filter.ProjectIDs != nil {
		conditions = append(conditions, fmt.Sprintf("project_id = any($%d)", placeholder))
		args = append(args, filter.ProjectIDs)
		placeholder++
	}
	if filter.CurrentOnly {
		conditions = append(conditions, "is_current")
	}
	if filter.PeriodStartDate != nil {
		conditions = append(
			conditions,
			fmt.Sprintf("period_end_date >= $%d::date", placeholder),
		)
		args = append(args, filter.PeriodStartDate.Format("2006-01-02"))
		placeholder++
	}
	if filter.PeriodEndDate != nil {
		conditions = append(
			conditions,
			fmt.Sprintf("period_start_date <= $%d::date", placeholder),
		)
		args = append(args, filter.PeriodEndDate.Format("2006-01-02"))
	}
	return `select id, project_id, report_date, period_start_date, period_end_date,
		       version, is_current, superseded_at, upload_file_id, upload_file_path,
		       original_filename, stored_filename, logical_filename,
		       file_size_bytes::text, file_sha256, ingestion_status, ingestion_error,
		       created_by, created_at, updated_at
		 from public.ad_upload_files
		 where ` + strings.Join(conditions, " and ") + `
		 order by created_at desc, id desc`, args
}

func productAnalysisScanSourceA(row pgx.Row) (product_analysis.AnalysisSourceFileItem, error) {
	var (
		item             product_analysis.AnalysisSourceFileItem
		reportDate       *time.Time
		periodStart      *time.Time
		periodEnd        *time.Time
		snapshotAt       *time.Time
		supersededAt     *time.Time
		originalFilename *string
		fileSizeText     *string
		fileSHA256       *string
		ingestionError   *string
		createdBy        *string
		createdAt        *time.Time
		updatedAt        *time.Time
	)
	err := row.Scan(
		&item.ID,
		&item.ProjectID,
		&item.ReportType,
		&reportDate,
		&periodStart,
		&periodEnd,
		&snapshotAt,
		&item.Version,
		&item.IsCurrent,
		&supersededAt,
		&item.UploadFileID,
		&item.UploadFilePath,
		&originalFilename,
		&item.StoredFilename,
		&item.LogicalFilename,
		&item.StorageKey,
		&fileSizeText,
		&fileSHA256,
		&item.IngestionStatus,
		&ingestionError,
		&item.RowCountTotal,
		&item.RowCountIncluded,
		&createdBy,
		&createdAt,
		&updatedAt,
	)
	if err != nil {
		return item, err
	}
	item.ReportDate = productAnalysisDateString(reportDate)
	item.PeriodStartDate = productAnalysisDateString(periodStart)
	item.PeriodEndDate = productAnalysisDateString(periodEnd)
	item.SnapshotAt = productAnalysisTimestampString(snapshotAt)
	item.SupersededAt = productAnalysisTimestampString(supersededAt)
	item.OriginalFilename = originalFilename
	item.FileSizeBytes = productAnalysisTextInt64(fileSizeText)
	item.FileSHA256 = fileSHA256
	item.IngestionError = ingestionError
	item.CreatedBy = createdBy
	item.CreatedAt = productAnalysisTimestampString(createdAt)
	item.UpdatedAt = productAnalysisTimestampString(updatedAt)
	item.SourceKind = "analysis"
	if createdAt != nil {
		item.CreatedAtSort = *createdAt
	}
	return item, nil
}

func productAnalysisScanSourceAD(row pgx.Row) (product_analysis.AnalysisSourceFileItem, error) {
	var (
		item             product_analysis.AnalysisSourceFileItem
		reportDate       *time.Time
		periodStart      *time.Time
		periodEnd        *time.Time
		supersededAt     *time.Time
		originalFilename *string
		fileSizeText     *string
		fileSHA256       *string
		ingestionError   *string
		createdBy        *string
		createdAt        *time.Time
		updatedAt        *time.Time
	)
	err := row.Scan(
		&item.ID,
		&item.ProjectID,
		&reportDate,
		&periodStart,
		&periodEnd,
		&item.Version,
		&item.IsCurrent,
		&supersededAt,
		&item.UploadFileID,
		&item.UploadFilePath,
		&originalFilename,
		&item.StoredFilename,
		&item.LogicalFilename,
		&fileSizeText,
		&fileSHA256,
		&item.IngestionStatus,
		&ingestionError,
		&createdBy,
		&createdAt,
		&updatedAt,
	)
	if err != nil {
		return item, err
	}
	item.ReportType = "ad_product_report"
	item.ReportDate = productAnalysisDateString(reportDate)
	item.PeriodStartDate = productAnalysisDateString(periodStart)
	item.PeriodEndDate = productAnalysisDateString(periodEnd)
	item.SupersededAt = productAnalysisTimestampString(supersededAt)
	item.OriginalFilename = originalFilename
	item.StorageKey = ""
	item.FileSizeBytes = productAnalysisTextInt64(fileSizeText)
	item.FileSHA256 = fileSHA256
	item.IngestionError = ingestionError
	item.CreatedBy = createdBy
	item.CreatedAt = productAnalysisTimestampString(createdAt)
	item.UpdatedAt = productAnalysisTimestampString(updatedAt)
	item.SourceKind = "ad"
	if createdAt != nil {
		item.CreatedAtSort = *createdAt
	}
	return item, nil
}

func (s *ProductAnalysisStore) GetSourceRows(
	ctx context.Context,
	sourceID int64,
	page int,
	pageSize int,
	includeExcluded bool,
) (*product_analysis.SourceRows, error) {
	if page < 1 || pageSize < 1 {
		return nil, fmt.Errorf("%w: page and page_size must be >= 1", product_analysis.ErrInvalid)
	}

	source, kind, actualSourceID, err := s.productAnalysisLoadSource(ctx, sourceID)
	if err != nil {
		return nil, err
	}
	rows, hasNext, err := s.productAnalysisQueryRows(
		ctx,
		kind,
		source.ReportType,
		actualSourceID,
		page,
		pageSize,
		includeExcluded,
	)
	if err != nil {
		return nil, err
	}
	return &product_analysis.SourceRows{
		Source:   source,
		Page:     page,
		PageSize: pageSize,
		HasNext:  hasNext,
		Rows:     rows,
	}, nil
}

func (s *ProductAnalysisStore) productAnalysisLoadSource(
	ctx context.Context,
	sourceID int64,
) (product_analysis.AnalysisSourceFileItem, string, int64, error) {
	var (
		item             product_analysis.AnalysisSourceFileItem
		reportDate       *time.Time
		periodStart      *time.Time
		periodEnd        *time.Time
		snapshotAt       *time.Time
		supersededAt     *time.Time
		originalFilename *string
		fileSizeText     *string
		fileSHA256       *string
		ingestionError   *string
		createdBy        *string
		createdAt        *time.Time
		updatedAt        *time.Time
	)
	err := s.db.QueryRow(
		ctx,
		`select id, project_id, report_type, report_date, period_start_date,
		        period_end_date, snapshot_at, version, is_current, superseded_at,
		        upload_file_id, upload_file_path, original_filename, stored_filename,
		        logical_filename, storage_key, file_size_bytes::text, file_sha256,
		        ingestion_status, ingestion_error, row_count_total, row_count_included,
		        created_by, created_at, updated_at
		 from public.analysis_source_files
		 where id = $1`,
		sourceID,
	).Scan(
		&item.ID,
		&item.ProjectID,
		&item.ReportType,
		&reportDate,
		&periodStart,
		&periodEnd,
		&snapshotAt,
		&item.Version,
		&item.IsCurrent,
		&supersededAt,
		&item.UploadFileID,
		&item.UploadFilePath,
		&originalFilename,
		&item.StoredFilename,
		&item.LogicalFilename,
		&item.StorageKey,
		&fileSizeText,
		&fileSHA256,
		&item.IngestionStatus,
		&ingestionError,
		&item.RowCountTotal,
		&item.RowCountIncluded,
		&createdBy,
		&createdAt,
		&updatedAt,
	)
	if err == nil {
		item.ReportDate = productAnalysisDateString(reportDate)
		item.PeriodStartDate = productAnalysisDateString(periodStart)
		item.PeriodEndDate = productAnalysisDateString(periodEnd)
		item.SnapshotAt = productAnalysisTimestampString(snapshotAt)
		item.SupersededAt = productAnalysisTimestampString(supersededAt)
		item.OriginalFilename = originalFilename
		item.FileSizeBytes = productAnalysisTextInt64(fileSizeText)
		item.FileSHA256 = fileSHA256
		item.IngestionError = ingestionError
		item.CreatedBy = createdBy
		item.CreatedAt = productAnalysisTimestampString(createdAt)
		item.UpdatedAt = productAnalysisTimestampString(updatedAt)
		item.SourceKind = "analysis"
		if item.ReportType != "ad_product_report" {
			return item, "analysis", sourceID, nil
		}
		sourceCountry, countryErr := s.productAnalysisSourceCountry(ctx, sourceID)
		if countryErr != nil {
			return item, "", 0, countryErr
		}
		var adSourceID int64
		adErr := s.db.QueryRow(
			ctx,
			`select id
			 from public.ad_upload_files
			 where project_id = $1 and country = $2
			   and period_start_date = $3::date
			   and period_end_date = $4::date
			   and version = $5 and is_current = $6
			   and report_type = 'ad_promoted_product_report'
			 limit 1`,
			item.ProjectID,
			sourceCountry,
			item.PeriodStartDate,
			item.PeriodEndDate,
			item.Version,
			item.IsCurrent,
		).Scan(&adSourceID)
		if errors.Is(adErr, pgx.ErrNoRows) {
			return item, "", 0, fmt.Errorf(
				"%w: no ad_upload_files source for analysis_source_files id=%d",
				product_analysis.ErrInvalid,
				sourceID,
			)
		}
		if adErr != nil {
			return item, "", 0, adErr
		}
		return item, "ad", adSourceID, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return item, "", 0, err
	}

	var (
		adReportDate       *time.Time
		adPeriodStart      *time.Time
		adPeriodEnd        *time.Time
		adSupersededAt     *time.Time
		adOriginalFilename *string
		adFileSizeText     *string
		adFileSHA256       *string
		adIngestionError   *string
		adCreatedBy        *string
		adCreatedAt        *time.Time
		adUpdatedAt        *time.Time
	)
	err = s.db.QueryRow(
		ctx,
		`select id, project_id, report_date, period_start_date, period_end_date,
		        version, is_current, superseded_at, upload_file_id, upload_file_path,
		        original_filename, stored_filename, logical_filename,
		        file_size_bytes::text, file_sha256, ingestion_status, ingestion_error,
		        created_by, created_at, updated_at
		 from public.ad_upload_files
		 where id = $1 and report_type = 'ad_promoted_product_report'`,
		sourceID,
	).Scan(
		&item.ID,
		&item.ProjectID,
		&adReportDate,
		&adPeriodStart,
		&adPeriodEnd,
		&item.Version,
		&item.IsCurrent,
		&adSupersededAt,
		&item.UploadFileID,
		&item.UploadFilePath,
		&adOriginalFilename,
		&item.StoredFilename,
		&item.LogicalFilename,
		&adFileSizeText,
		&adFileSHA256,
		&item.IngestionStatus,
		&adIngestionError,
		&adCreatedBy,
		&adCreatedAt,
		&adUpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return item, "", 0, product_analysis.ErrNotFound
	}
	if err != nil {
		return item, "", 0, err
	}
	item.ReportType = "ad_product_report"
	item.ReportDate = productAnalysisDateString(adReportDate)
	item.PeriodStartDate = productAnalysisDateString(adPeriodStart)
	item.PeriodEndDate = productAnalysisDateString(adPeriodEnd)
	item.SupersededAt = productAnalysisTimestampString(adSupersededAt)
	item.OriginalFilename = adOriginalFilename
	item.StorageKey = ""
	item.FileSizeBytes = productAnalysisTextInt64(adFileSizeText)
	item.FileSHA256 = adFileSHA256
	item.IngestionError = adIngestionError
	item.CreatedBy = adCreatedBy
	item.CreatedAt = productAnalysisTimestampString(adCreatedAt)
	item.UpdatedAt = productAnalysisTimestampString(adUpdatedAt)
	item.SourceKind = "ad"
	return item, "ad", sourceID, nil
}

func (s *ProductAnalysisStore) productAnalysisSourceCountry(
	ctx context.Context,
	sourceID int64,
) (string, error) {
	var country string
	err := s.db.QueryRow(
		ctx,
		`select country from public.analysis_source_files where id = $1`,
		sourceID,
	).Scan(&country)
	return country, err
}

func (s *ProductAnalysisStore) productAnalysisQueryRows(
	ctx context.Context,
	kind string,
	reportType string,
	sourceID int64,
	page int,
	pageSize int,
	includeExcluded bool,
) ([]map[string]any, bool, error) {
	offset := productAnalysisOffset(page, pageSize)
	limit := pageSize + 1
	switch {
	case kind == "analysis" && reportType == "business_report":
		return productAnalysisQueryBusinessRows(ctx, s.db, sourceID, offset, limit)
	case kind == "analysis" && reportType == "payment_report":
		return productAnalysisQueryPaymentRows(ctx, s.db, sourceID, offset, limit, includeExcluded)
	case kind == "analysis" && reportType == "inventory_report":
		return productAnalysisQueryInventoryRows(ctx, s.db, sourceID, offset, limit)
	case kind == "analysis" && reportType == "sales_report":
		return productAnalysisQuerySalesRows(ctx, s.db, sourceID, offset, limit)
	case kind == "ad":
		return productAnalysisQueryADRows(ctx, s.db, sourceID, offset, limit)
	default:
		return nil, false, fmt.Errorf("%w: unsupported report_type %s", product_analysis.ErrInvalid, reportType)
	}
}

func productAnalysisQueryBusinessRows(
	ctx context.Context,
	db DB,
	sourceID int64,
	offset int64,
	limit int,
) ([]map[string]any, bool, error) {
	rows, err := db.Query(
		ctx,
		`select source_row_no, asin, page_views, units_ordered, sessions,
		        ordered_sales_amount, raw_row::text
		 from public.analysis_business_rows
		 where source_file_id = $1
		 order by source_row_no asc
		 offset $2 limit $3`,
		sourceID,
		offset,
		limit,
	)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	items := make([]map[string]any, 0, limit)
	for rows.Next() {
		var (
			sourceRowNo int
			asin        *string
			pageViews   int
			units       int
			sessions    int
			sales       pgtype.Numeric
			rawJSON     []byte
		)
		if err := rows.Scan(&sourceRowNo, &asin, &pageViews, &units, &sessions, &sales, &rawJSON); err != nil {
			return nil, false, err
		}
		items = append(items, map[string]any{
			"source_row_no":        sourceRowNo,
			"asin":                 asin,
			"page_views":           pageViews,
			"units_ordered":        units,
			"sessions":             sessions,
			"ordered_sales_amount": productAnalysisNumericFloat(sales),
			"raw_row":              productAnalysisJSONMap(rawJSON),
		})
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	return productAnalysisTrimPage(items, limit)
}

func productAnalysisQueryPaymentRows(
	ctx context.Context,
	db DB,
	sourceID int64,
	offset int64,
	limit int,
	includeExcluded bool,
) ([]map[string]any, bool, error) {
	query := `select source_row_no, transaction_at, transaction_type, order_id,
	                 sku, asin, quantity, product_sales, shipping_credits,
	                 promotional_rebates, other_amount, selling_fees, fba_fees,
	                 total_amount, scope_status, scope_reason, raw_row::text
	          from public.analysis_payment_rows
	          where source_file_id = $1`
	if !includeExcluded {
		query += ` and scope_status = 'included_product'`
	}
	query += ` order by source_row_no asc offset $2 limit $3`
	rows, err := db.Query(ctx, query, sourceID, offset, limit)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	items := make([]map[string]any, 0, limit)
	for rows.Next() {
		var (
			sourceRowNo        int
			transactionAt      *time.Time
			transactionType    string
			orderID            *string
			sku                *string
			asin               *string
			quantity           int
			productSales       pgtype.Numeric
			shippingCredits    pgtype.Numeric
			promotionalRebates pgtype.Numeric
			otherAmount        pgtype.Numeric
			sellingFees        pgtype.Numeric
			fbaFees            pgtype.Numeric
			totalAmount        pgtype.Numeric
			scopeStatus        string
			scopeReason        *string
			rawJSON            []byte
		)
		if err := rows.Scan(
			&sourceRowNo,
			&transactionAt,
			&transactionType,
			&orderID,
			&sku,
			&asin,
			&quantity,
			&productSales,
			&shippingCredits,
			&promotionalRebates,
			&otherAmount,
			&sellingFees,
			&fbaFees,
			&totalAmount,
			&scopeStatus,
			&scopeReason,
			&rawJSON,
		); err != nil {
			return nil, false, err
		}
		items = append(items, map[string]any{
			"source_row_no":       sourceRowNo,
			"transaction_at":      productAnalysisTimestampAny(transactionAt),
			"transaction_type":    transactionType,
			"order_id":            orderID,
			"sku":                 sku,
			"asin":                asin,
			"quantity":            quantity,
			"product_sales":       productAnalysisNumericFloat(productSales),
			"shipping_credits":    productAnalysisNumericFloat(shippingCredits),
			"promotional_rebates": productAnalysisNumericFloat(promotionalRebates),
			"other_amount":        productAnalysisNumericFloat(otherAmount),
			"selling_fees":        productAnalysisNumericFloat(sellingFees),
			"fba_fees":            productAnalysisNumericFloat(fbaFees),
			"total_amount":        productAnalysisNumericFloat(totalAmount),
			"scope_status":        scopeStatus,
			"scope_reason":        scopeReason,
			"raw_row":             productAnalysisJSONMap(rawJSON),
		})
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	return productAnalysisTrimPage(items, limit)
}

func productAnalysisQueryInventoryRows(
	ctx context.Context,
	db DB,
	sourceID int64,
	offset int64,
	limit int,
) ([]map[string]any, bool, error) {
	query := `select source_row_no, sku, asin, available_qty, age_0_90_qty,
		         age_91_180_qty, age_181_270_qty, age_271_365_qty,
		         age_365_plus_qty, recommended_action, stock_status,
		         aging_status, raw_row::text
	          from public.inventory_snapshot_rows
	          where source_file_id = $1
	          order by source_row_no asc`
	args := []any{sourceID}
	if limit > 0 {
		query += ` offset $2 limit $3`
		args = append(args, offset, limit)
	}
	rows, err := db.Query(ctx, query, args...)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	items := make([]map[string]any, 0, productAnalysisInitialCapacity(limit))
	for rows.Next() {
		var (
			sourceRowNo       int
			sku               *string
			asin              *string
			availableQty      int
			age090Qty         int
			age91180Qty       int
			age181270Qty      int
			age271365Qty      int
			age365PlusQty     int
			recommendedAction *string
			stockStatus       string
			agingStatus       string
			rawJSON           []byte
		)
		if err := rows.Scan(
			&sourceRowNo,
			&sku,
			&asin,
			&availableQty,
			&age090Qty,
			&age91180Qty,
			&age181270Qty,
			&age271365Qty,
			&age365PlusQty,
			&recommendedAction,
			&stockStatus,
			&agingStatus,
			&rawJSON,
		); err != nil {
			return nil, false, err
		}
		items = append(items, map[string]any{
			"source_row_no":      sourceRowNo,
			"sku":                sku,
			"asin":               asin,
			"available_qty":      availableQty,
			"age_0_90_qty":       age090Qty,
			"age_91_180_qty":     age91180Qty,
			"age_181_270_qty":    age181270Qty,
			"age_271_365_qty":    age271365Qty,
			"age_365_plus_qty":   age365PlusQty,
			"recommended_action": recommendedAction,
			"stock_status":       stockStatus,
			"aging_status":       agingStatus,
			"raw_row":            productAnalysisJSONMap(rawJSON),
		})
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	if limit <= 0 {
		return items, false, nil
	}
	return productAnalysisTrimPage(items, limit)
}

func productAnalysisQuerySalesRows(
	ctx context.Context,
	db DB,
	sourceID int64,
	offset int64,
	limit int,
) ([]map[string]any, bool, error) {
	rows, err := db.Query(
		ctx,
		`select source_row_no, amazon_order_id, purchase_at_utc, purchase_at_pt,
		        purchase_date_pt, order_status, sku, asin, quantity, item_price,
		        shipping_price, currency, is_counted_sales, status_rule_version,
		        raw_row::text
		 from public.analysis_sales_order_rows
		 where source_file_id = $1
		 order by source_row_no asc
		 offset $2 limit $3`,
		sourceID,
		offset,
		limit,
	)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	items := make([]map[string]any, 0, limit)
	for rows.Next() {
		var (
			sourceRowNo       int
			amazonOrderID     string
			purchaseAtUTC     time.Time
			purchaseAtPT      time.Time
			purchaseDatePT    time.Time
			orderStatus       string
			sku               *string
			asin              *string
			quantity          int
			itemPrice         pgtype.Numeric
			shippingPrice     pgtype.Numeric
			currency          *string
			isCountedSales    bool
			statusRuleVersion int
			rawJSON           []byte
		)
		if err := rows.Scan(
			&sourceRowNo,
			&amazonOrderID,
			&purchaseAtUTC,
			&purchaseAtPT,
			&purchaseDatePT,
			&orderStatus,
			&sku,
			&asin,
			&quantity,
			&itemPrice,
			&shippingPrice,
			&currency,
			&isCountedSales,
			&statusRuleVersion,
			&rawJSON,
		); err != nil {
			return nil, false, err
		}
		items = append(items, map[string]any{
			"source_row_no":       sourceRowNo,
			"amazon_order_id":     amazonOrderID,
			"purchase_at_utc":     httpapi.Timestamp(purchaseAtUTC),
			"purchase_at_pt":      httpapi.Timestamp(purchaseAtPT),
			"purchase_date_pt":    purchaseDatePT.Format("2006-01-02"),
			"order_status":        orderStatus,
			"sku":                 sku,
			"asin":                asin,
			"quantity":            quantity,
			"item_price":          productAnalysisNumericFloat(itemPrice),
			"shipping_price":      productAnalysisNumericFloat(shippingPrice),
			"currency":            currency,
			"is_counted_sales":    isCountedSales,
			"status_rule_version": statusRuleVersion,
			"raw_row":             productAnalysisJSONMap(rawJSON),
		})
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	return productAnalysisTrimPage(items, limit)
}

func productAnalysisQueryADRows(
	ctx context.Context,
	db DB,
	sourceID int64,
	offset int64,
	limit int,
) ([]map[string]any, bool, error) {
	rows, err := db.Query(
		ctx,
		`select source_row_no, ad_sku, ad_asin, impressions, clicks, ctr, cpc,
		        spend, sales_7d, acos, roas, orders_7d, units_7d, cvr_7d,
		        ad_sku_units_7d, other_sku_units_7d, ad_sku_sales_7d,
		        other_sku_sales_7d, campaign_name, ad_group_name, scope_status,
		        raw_row::text
		 from public.ad_upload_promoted_product_rows
		 where source_file_id = $1
		 order by source_row_no asc
		 offset $2 limit $3`,
		sourceID,
		offset,
		limit,
	)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	items := make([]map[string]any, 0, limit)
	for rows.Next() {
		var (
			sourceRowNo     int
			adSKU           *string
			adASIN          *string
			impressions     int
			clicks          int
			ctr             pgtype.Numeric
			cpc             pgtype.Numeric
			spend           pgtype.Numeric
			sales7D         pgtype.Numeric
			acos            pgtype.Numeric
			roas            pgtype.Numeric
			orders7D        int
			units7D         int
			cvr7D           pgtype.Numeric
			adSKUUnits7D    int
			otherSKUUnits7D int
			adSKUSales7D    pgtype.Numeric
			otherSKUSales7D pgtype.Numeric
			campaignName    *string
			adGroupName     *string
			scopeStatus     string
			rawJSON         []byte
		)
		if err := rows.Scan(
			&sourceRowNo,
			&adSKU,
			&adASIN,
			&impressions,
			&clicks,
			&ctr,
			&cpc,
			&spend,
			&sales7D,
			&acos,
			&roas,
			&orders7D,
			&units7D,
			&cvr7D,
			&adSKUUnits7D,
			&otherSKUUnits7D,
			&adSKUSales7D,
			&otherSKUSales7D,
			&campaignName,
			&adGroupName,
			&scopeStatus,
			&rawJSON,
		); err != nil {
			return nil, false, err
		}
		rawRow := productAnalysisJSONMap(rawJSON)
		meta, _ := rawRow["__meta__"].(map[string]any)
		oldScopeStatus, _ := meta["old_scope_status"].(string)
		oldScopeReason, _ := meta["old_scope_reason"].(string)
		items = append(items, map[string]any{
			"source_row_no":      sourceRowNo,
			"sku":                adSKU,
			"asin":               adASIN,
			"impressions":        impressions,
			"clicks":             clicks,
			"ctr":                productAnalysisNumericFloat(ctr),
			"cpc":                productAnalysisNumericFloat(cpc),
			"spend":              productAnalysisNumericFloat(spend),
			"sales_7d":           productAnalysisNumericFloat(sales7D),
			"acos":               productAnalysisNumericFloat(acos),
			"roas":               productAnalysisNumericFloat(roas),
			"orders_7d":          orders7D,
			"units_7d":           units7D,
			"cvr_7d":             productAnalysisNumericFloat(cvr7D),
			"ad_sku_units_7d":    adSKUUnits7D,
			"other_sku_units_7d": otherSKUUnits7D,
			"ad_sku_sales_7d":    productAnalysisNumericFloat(adSKUSales7D),
			"other_sku_sales_7d": productAnalysisNumericFloat(otherSKUSales7D),
			"campaign_name":      campaignName,
			"ad_group_name":      adGroupName,
			"scope_status":       productAnalysisPreferredString(oldScopeStatus, scopeStatus),
			"scope_reason":       productAnalysisOptionalString(oldScopeReason),
			"raw_row":            rawRow,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	return productAnalysisTrimPage(items, limit)
}

func (s *ProductAnalysisStore) GetCurrentInventory(
	ctx context.Context,
	projectID int64,
	country string,
	startDate *time.Time,
	endDate *time.Time,
) (*product_analysis.CurrentInventorySnapshot, error) {
	query := `select id, project_id, report_type, report_date, period_start_date,
	                 period_end_date, snapshot_at, version, is_current, superseded_at,
	                 upload_file_id, upload_file_path, original_filename, stored_filename,
	                 logical_filename, storage_key, file_size_bytes::text, file_sha256,
	                 ingestion_status, ingestion_error, row_count_total, row_count_included,
	                 created_by, created_at, updated_at
	          from public.analysis_source_files
	          where project_id = $1
	            and report_type = 'inventory_report'
	            and country = $2`
	args := []any{projectID, productAnalysisNormalizeCountry(country, "US")}
	placeholder := 3
	if startDate == nil && endDate == nil {
		query += ` and is_current`
	} else {
		if startDate != nil {
			query += fmt.Sprintf(
				` and ((report_date is not null and report_date >= $%d::date)
				      or (report_date is null and snapshot_at is not null and snapshot_at >= $%d::date))`,
				placeholder,
				placeholder,
			)
			args = append(args, startDate.Format("2006-01-02"))
			placeholder++
		}
		if endDate != nil {
			query += fmt.Sprintf(
				` and ((report_date is not null and report_date <= $%d::date)
				      or (report_date is null and snapshot_at is not null and snapshot_at < ($%d::date + interval '1 day')))`,
				placeholder,
				placeholder,
			)
			args = append(args, endDate.Format("2006-01-02"))
		}
	}
	query += ` order by report_date desc nulls last, snapshot_at desc nulls last,
	                  version desc, id desc
	           limit 1`
	row := s.db.QueryRow(ctx, query, args...)
	source, err := productAnalysisScanSourceA(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, product_analysis.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	rows, _, err := productAnalysisQueryInventoryRows(ctx, s.db, source.ID, 0, -1)
	if err != nil {
		return nil, err
	}
	return &product_analysis.CurrentInventorySnapshot{Source: source, Rows: rows}, nil
}

func (s *ProductAnalysisStore) ListPT1(
	ctx context.Context,
	filter product_analysis.PT1Filter,
) ([]product_analysis.PT1CalculationItem, error) {
	if filter.ProjectIDs != nil && len(filter.ProjectIDs) == 0 {
		return []product_analysis.PT1CalculationItem{}, nil
	}
	query, args := productAnalysisPT1SQL(filter)
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]product_analysis.PT1CalculationItem, 0)
	for rows.Next() {
		item, scanErr := productAnalysisScanPT1(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if items == nil {
		items = []product_analysis.PT1CalculationItem{}
	}
	return items, nil
}

func (s *ProductAnalysisStore) GetPT1(
	ctx context.Context,
	pt1ID int64,
) (*product_analysis.PT1CalculationItem, error) {
	item, err := productAnalysisScanPT1(s.db.QueryRow(
		ctx,
		`select id, project_id, project_name, country, report_start_date,
		        report_end_date, version, is_current, row_count, summary_row::text,
		        result_file_path, calculation_version, computed_at, created_at
		 from public.analysis_pt1_calculation
		 where id = $1`,
		pt1ID,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, product_analysis.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func productAnalysisPT1SQL(filter product_analysis.PT1Filter) (string, []any) {
	conditions := []string{"true"}
	var args []any
	placeholder := 1
	if filter.ProjectID != nil {
		conditions = append(conditions, fmt.Sprintf("project_id = $%d", placeholder))
		args = append(args, *filter.ProjectID)
		placeholder++
	} else if filter.ProjectIDs != nil {
		conditions = append(conditions, fmt.Sprintf("project_id = any($%d)", placeholder))
		args = append(args, filter.ProjectIDs)
		placeholder++
	}
	if filter.Country != nil {
		conditions = append(conditions, fmt.Sprintf("country = $%d", placeholder))
		args = append(args, *filter.Country)
		placeholder++
	}
	if filter.CurrentOnly {
		conditions = append(conditions, "is_current")
	}
	if filter.StartDate != nil {
		conditions = append(conditions, fmt.Sprintf("report_end_date >= $%d::date", placeholder))
		args = append(args, filter.StartDate.Format("2006-01-02"))
		placeholder++
	}
	if filter.EndDate != nil {
		conditions = append(conditions, fmt.Sprintf("report_start_date <= $%d::date", placeholder))
		args = append(args, filter.EndDate.Format("2006-01-02"))
	}
	return `select id, project_id, project_name, country, report_start_date,
		       report_end_date, version, is_current, row_count, summary_row::text,
		       result_file_path, calculation_version, computed_at, created_at
		 from public.analysis_pt1_calculation
		 where ` + strings.Join(conditions, " and ") + `
		 order by report_start_date desc, id desc`, args
}

func productAnalysisScanPT1(row pgx.Row) (product_analysis.PT1CalculationItem, error) {
	var (
		item        product_analysis.PT1CalculationItem
		reportStart time.Time
		reportEnd   time.Time
		summaryJSON []byte
		resultPath  *string
		computedAt  *time.Time
		createdAt   *time.Time
	)
	err := row.Scan(
		&item.ID,
		&item.ProjectID,
		&item.ProjectName,
		&item.Country,
		&reportStart,
		&reportEnd,
		&item.Version,
		&item.IsCurrent,
		&item.RowCount,
		&summaryJSON,
		&resultPath,
		&item.CalculationVersion,
		&computedAt,
		&createdAt,
	)
	if err != nil {
		return item, err
	}
	item.ReportStartDate = reportStart.Format("2006-01-02")
	item.ReportEndDate = reportEnd.Format("2006-01-02")
	item.SummaryRow = productAnalysisJSONMap(summaryJSON)
	if item.SummaryRow == nil {
		item.SummaryRow = map[string]any{}
	}
	item.ResultFilePath = resultPath
	item.ComputedAt = productAnalysisTimestampString(computedAt)
	item.CreatedAt = productAnalysisTimestampString(createdAt)
	return item, nil
}

func (s *ProductAnalysisStore) ListPT1Details(
	ctx context.Context,
	pt1 product_analysis.PT1CalculationItem,
	country string,
	page int,
	pageSize int,
) (*product_analysis.PT1Details, error) {
	offset := productAnalysisOffset(page, pageSize)
	limit := pageSize + 1
	rows, err := s.db.Query(
		ctx,
		`select d.id, d.source_row_no, d.sku, d.asin,
		        matched.sort_order, d.raw_row::text
		 from public.analysis_pt_sku_details d
		 join lateral (
		   select min(pc.sort_order) as sort_order
		   from public.product_costs pc
		   where pc.project_name = $1
		     and pc.is_active = true
		     and pc.country = $2
		     and (
		       lower(coalesce(pc.sku, '')) = lower(coalesce(d.sku, ''))
		       or lower(coalesce(pc.asin, '')) = lower(coalesce(d.asin, ''))
		     )
		 ) matched on true
		 where d.pt1_calculation_id = $3 and d.country = $4
		   and matched.sort_order is not null
		 order by matched.sort_order asc, d.source_row_no asc, d.id asc
		 offset $5 limit $6`,
		pt1.ProjectName,
		country,
		pt1.ID,
		country,
		offset,
		limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]product_analysis.PT1DetailRow, 0, limit)
	for rows.Next() {
		var (
			row       product_analysis.PT1DetailRow
			sortOrder int
			rawJSON   []byte
		)
		if err := rows.Scan(&row.ID, &row.SourceRowNo, &row.SKU, &row.ASIN, &sortOrder, &rawJSON); err != nil {
			return nil, err
		}
		row.SKUSortOrder = &sortOrder
		row.RawRow = productAnalysisJSONMap(rawJSON)
		if row.RawRow == nil {
			row.RawRow = map[string]any{}
		}
		items = append(items, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	hasNext := len(items) > pageSize
	if hasNext {
		items = items[:pageSize]
	}
	return &product_analysis.PT1Details{
		PT1ID:           pt1.ID,
		ProjectID:       pt1.ProjectID,
		ProjectName:     pt1.ProjectName,
		ReportStartDate: pt1.ReportStartDate,
		ReportEndDate:   pt1.ReportEndDate,
		Version:         pt1.Version,
		Page:            page,
		PageSize:        pageSize,
		HasNext:         hasNext,
		Rows:            items,
	}, nil
}

func (s *ProductAnalysisStore) ListWeekly(
	ctx context.Context,
	filter product_analysis.PT1Filter,
) ([]product_analysis.WeeklyAnalysisItem, error) {
	pt1Rows, err := s.ListPT1(ctx, filter)
	if err != nil {
		return nil, err
	}
	ids := make([]int64, 0, len(pt1Rows))
	for _, item := range pt1Rows {
		ids = append(ids, item.ID)
	}
	totalsByID, err := s.productAnalysisWeeklyTotals(ctx, ids)
	if err != nil {
		return nil, err
	}
	items := make([]product_analysis.WeeklyAnalysisItem, 0, len(pt1Rows))
	for _, pt1Item := range pt1Rows {
		summary := pt1Item.SummaryRow
		if summary == nil {
			summary = map[string]any{}
		}
		aggregate := totalsByID[pt1Item.ID]
		totalSales, hasSales := productAnalysisMapNumber(
			summary,
			"实际销售额",
			"总销售额",
		)
		if !hasSales {
			totalSales = aggregate.Sales
			productAnalysisSetMissingNumber(summary, totalSales, "实际销售额")
			productAnalysisSetMissingNumber(summary, totalSales, "总销售额")
		}
		totalUnitsFloat, hasUnits := productAnalysisMapNumber(
			summary,
			"实际销售量",
			"总销量",
		)
		totalUnits := int(math.Round(totalUnitsFloat))
		if !hasUnits {
			totalUnits = aggregate.Units
			productAnalysisSetMissingNumber(summary, float64(totalUnits), "实际销售量")
			productAnalysisSetMissingNumber(summary, float64(totalUnits), "总销量")
		}
		totalADSpend, hasADSpend := productAnalysisMapNumber(summary, "广告花费")
		if !hasADSpend {
			totalADSpend = aggregate.ADSpend
			productAnalysisSetMissingNumber(summary, totalADSpend, "广告花费")
		}
		rowCount := pt1Item.RowCount
		if rowCount == 0 {
			rowCount = aggregate.RowCount
		}
		items = append(items, product_analysis.WeeklyAnalysisItem{
			ID:               pt1Item.ID,
			ProjectID:        pt1Item.ProjectID,
			ProjectName:      pt1Item.ProjectName,
			Country:          pt1Item.Country,
			ReportStartDate:  pt1Item.ReportStartDate,
			ReportEndDate:    pt1Item.ReportEndDate,
			Version:          pt1Item.Version,
			IsCurrent:        pt1Item.IsCurrent,
			RowCount:         rowCount,
			TotalSales:       totalSales,
			TotalUnits:       totalUnits,
			TotalAdSpend:     totalADSpend,
			SummaryRow:       summary,
			WeeklySummaryRaw: summary,
		})
	}
	if items == nil {
		items = []product_analysis.WeeklyAnalysisItem{}
	}
	return items, nil
}

type productAnalysisWeeklyAggregate struct {
	RowCount int
	Sales    float64
	Units    int
	ADSpend  float64
}

func (s *ProductAnalysisStore) productAnalysisWeeklyTotals(
	ctx context.Context,
	ids []int64,
) (map[int64]productAnalysisWeeklyAggregate, error) {
	result := make(map[int64]productAnalysisWeeklyAggregate)
	if len(ids) == 0 {
		return result, nil
	}
	rows, err := s.db.Query(
		ctx,
		`select pt1_calculation_id, count(*),
		        coalesce(sum(actual_sales_amount), 0)::text,
		        coalesce(sum(actual_sales_units), 0)::text,
		        coalesce(sum(ad_spend), 0)::text
		 from public.analysis_pt_sku_details
		 where pt1_calculation_id = any($1)
		 group by pt1_calculation_id`,
		ids,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			id       int64
			rowCount int
			salesRaw string
			unitsRaw string
			spendRaw string
		)
		if err := rows.Scan(&id, &rowCount, &salesRaw, &unitsRaw, &spendRaw); err != nil {
			return nil, err
		}
		sales, _ := strconv.ParseFloat(strings.TrimSpace(salesRaw), 64)
		units, _ := strconv.ParseFloat(strings.TrimSpace(unitsRaw), 64)
		spend, _ := strconv.ParseFloat(strings.TrimSpace(spendRaw), 64)
		result[id] = productAnalysisWeeklyAggregate{
			RowCount: rowCount,
			Sales:    sales,
			Units:    int(math.Round(units)),
			ADSpend:  spend,
		}
	}
	return result, rows.Err()
}

func (s *ProductAnalysisStore) CheckAvailability(
	ctx context.Context,
	projectID int64,
	country string,
	startDate time.Time,
	endDate time.Time,
) (*product_analysis.AvailabilityCheck, error) {
	country = productAnalysisNormalizeCountry(country, "US")
	businessDaily, err := s.productAnalysisDailyDates(
		ctx,
		projectID,
		country,
		"business_report",
		startDate,
		endDate,
	)
	if err != nil {
		return nil, err
	}
	inventoryDaily, err := s.productAnalysisDailyDates(
		ctx,
		projectID,
		country,
		"inventory_report",
		startDate,
		endDate,
	)
	if err != nil {
		return nil, err
	}
	adDaily, err := s.productAnalysisADDailyDates(ctx, projectID, country, startDate, endDate)
	if err != nil {
		return nil, err
	}
	businessPeriods, err := s.productAnalysisPeriodCoverage(
		ctx,
		projectID,
		country,
		"business_report",
		startDate,
		endDate,
	)
	if err != nil {
		return nil, err
	}
	adPeriods, err := s.productAnalysisADPeriodCoverage(ctx, projectID, country, startDate, endDate)
	if err != nil {
		return nil, err
	}
	paymentDaily, err := s.productAnalysisPaymentDaily(
		ctx,
		projectID,
		country,
		startDate,
		endDate,
	)
	if err != nil {
		return nil, err
	}
	paymentPeriods, err := s.productAnalysisPaymentPeriods(
		ctx,
		projectID,
		country,
		startDate,
		endDate,
	)
	if err != nil {
		return nil, err
	}
	return productAnalysisBuildAvailability(
		startDate,
		endDate,
		businessDaily,
		adDaily,
		inventoryDaily,
		businessPeriods,
		adPeriods,
		paymentDaily,
		paymentPeriods,
	), nil
}

type productAnalysisDateSet map[string]struct{}

type productAnalysisCoverage struct {
	StartDate    string
	EndDate      string
	SourceID     int64
	CoveredDates productAnalysisDateSet
	RowCount     int
}

type productAnalysisPaymentDaily struct {
	Date     string
	RowCount int
}

func (s *ProductAnalysisStore) productAnalysisDailyDates(
	ctx context.Context,
	projectID int64,
	country string,
	reportType string,
	startDate time.Time,
	endDate time.Time,
) (productAnalysisDateSet, error) {
	rows, err := s.db.Query(
		ctx,
		`select report_date
		 from public.analysis_source_files
		 where project_id = $1 and report_type = $2 and country = $3
		   and report_date >= $4::date and report_date <= $5::date
		   and report_date is not null`,
		projectID,
		reportType,
		country,
		startDate.Format("2006-01-02"),
		endDate.Format("2006-01-02"),
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return productAnalysisScanDateSet(rows)
}

func (s *ProductAnalysisStore) productAnalysisADDailyDates(
	ctx context.Context,
	projectID int64,
	country string,
	startDate time.Time,
	endDate time.Time,
) (productAnalysisDateSet, error) {
	rows, err := s.db.Query(
		ctx,
		`select distinct f.period_end_date
		 from public.ad_upload_files f
		 join public.ad_upload_promoted_product_rows r
		   on r.source_file_id = f.id
		 where f.project_id = $1
		   and f.report_type = 'ad_promoted_product_report'
		   and f.country = $2
		   and f.is_current = true
		   and f.period_start_date = f.period_end_date
		   and f.period_end_date >= $3::date
		   and f.period_end_date <= $4::date
		   and r.scope_status = 'included_product'`,
		projectID,
		country,
		startDate.Format("2006-01-02"),
		endDate.Format("2006-01-02"),
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return productAnalysisScanDateSet(rows)
}

func (s *ProductAnalysisStore) productAnalysisPeriodCoverage(
	ctx context.Context,
	projectID int64,
	country string,
	reportType string,
	startDate time.Time,
	endDate time.Time,
) ([]productAnalysisCoverage, error) {
	rows, err := s.db.Query(
		ctx,
		`select period_start_date, period_end_date, id
		 from public.analysis_source_files
		 where project_id = $1 and report_type = $2 and country = $3
		   and report_date is null
		   and period_start_date <= $5::date
		   and period_end_date >= $4::date
		 order by period_start_date asc, period_end_date asc, id asc`,
		projectID,
		reportType,
		country,
		startDate.Format("2006-01-02"),
		endDate.Format("2006-01-02"),
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return productAnalysisScanCoverage(rows, startDate, endDate)
}

func (s *ProductAnalysisStore) productAnalysisADPeriodCoverage(
	ctx context.Context,
	projectID int64,
	country string,
	startDate time.Time,
	endDate time.Time,
) ([]productAnalysisCoverage, error) {
	rows, err := s.db.Query(
		ctx,
		`select f.period_start_date, f.period_end_date, f.id
		 from public.ad_upload_files f
		 join public.ad_upload_promoted_product_rows r
		   on r.source_file_id = f.id
		 where f.project_id = $1
		   and f.report_type = 'ad_promoted_product_report'
		   and f.country = $2
		   and f.is_current = true
		   and f.period_start_date < f.period_end_date
		   and f.period_start_date <= $4::date
		   and f.period_end_date >= $3::date
		   and r.scope_status = 'included_product'
		 group by f.period_start_date, f.period_end_date, f.id
		 order by f.period_start_date asc, f.period_end_date asc, f.id asc`,
		projectID,
		country,
		startDate.Format("2006-01-02"),
		endDate.Format("2006-01-02"),
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return productAnalysisScanCoverage(rows, startDate, endDate)
}

func (s *ProductAnalysisStore) productAnalysisPaymentDaily(
	ctx context.Context,
	projectID int64,
	country string,
	startDate time.Time,
	endDate time.Time,
) ([]productAnalysisPaymentDaily, error) {
	rows, err := s.db.Query(
		ctx,
		`select report_date, row_count_total
		 from public.analysis_source_files
		 where project_id = $1 and report_type = 'payment_report' and country = $2
		   and report_date >= $3::date and report_date <= $4::date`,
		projectID,
		country,
		startDate.Format("2006-01-02"),
		endDate.Format("2006-01-02"),
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]productAnalysisPaymentDaily, 0)
	for rows.Next() {
		var (
			reportDate *time.Time
			rowCount   int
		)
		if err := rows.Scan(&reportDate, &rowCount); err != nil {
			return nil, err
		}
		if reportDate != nil {
			items = append(items, productAnalysisPaymentDaily{
				Date:     reportDate.Format("2006-01-02"),
				RowCount: rowCount,
			})
		}
	}
	return items, rows.Err()
}

func (s *ProductAnalysisStore) productAnalysisPaymentPeriods(
	ctx context.Context,
	projectID int64,
	country string,
	startDate time.Time,
	endDate time.Time,
) ([]productAnalysisCoverage, error) {
	rows, err := s.db.Query(
		ctx,
		`select period_start_date, period_end_date, id, row_count_total
		 from public.analysis_source_files
		 where project_id = $1 and report_type = 'payment_report' and country = $2
		   and report_date is null
		   and period_start_date <= $4::date
		   and period_end_date >= $3::date
		 order by period_start_date asc, period_end_date asc, id asc`,
		projectID,
		country,
		startDate.Format("2006-01-02"),
		endDate.Format("2006-01-02"),
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]productAnalysisCoverage, 0)
	for rows.Next() {
		var (
			periodStart time.Time
			periodEnd   time.Time
			sourceID    int64
			rowCount    int
		)
		if err := rows.Scan(&periodStart, &periodEnd, &sourceID, &rowCount); err != nil {
			return nil, err
		}
		items = append(items, productAnalysisCoverage{
			StartDate:    periodStart.Format("2006-01-02"),
			EndDate:      periodEnd.Format("2006-01-02"),
			SourceID:     sourceID,
			CoveredDates: productAnalysisIntersectCoverage(periodStart, periodEnd, startDate, endDate),
			RowCount:     rowCount,
		})
	}
	return items, rows.Err()
}

func productAnalysisBuildAvailability(
	startDate time.Time,
	endDate time.Time,
	businessDaily productAnalysisDateSet,
	adDaily productAnalysisDateSet,
	inventoryDaily productAnalysisDateSet,
	businessPeriods []productAnalysisCoverage,
	adPeriods []productAnalysisCoverage,
	paymentDaily []productAnalysisPaymentDaily,
	paymentPeriods []productAnalysisCoverage,
) *product_analysis.AvailabilityCheck {
	allDates := productAnalysisDateRange(startDate, endDate)
	businessAll := productAnalysisUnionCoverage(businessDaily, businessPeriods)
	adAll := productAnalysisUnionCoverage(adDaily, adPeriods)

	paymentDailyCovered := productAnalysisDateSet{}
	paymentDailyEmpty := productAnalysisDateSet{}
	for _, item := range paymentDaily {
		if item.RowCount > 0 {
			paymentDailyCovered[item.Date] = struct{}{}
		} else {
			paymentDailyEmpty[item.Date] = struct{}{}
		}
	}
	paymentReal := productAnalysisCopySet(paymentDailyCovered)
	paymentObjectiveEmpty := productAnalysisCopySet(paymentDailyEmpty)
	paymentOverlaps := make([]product_analysis.PaymentPeriodOverlap, 0)
	for _, period := range paymentPeriods {
		if period.RowCount > 0 {
			for date := range period.CoveredDates {
				paymentReal[date] = struct{}{}
			}
			paymentOverlaps = append(paymentOverlaps, product_analysis.PaymentPeriodOverlap{
				PeriodStartDate: period.StartDate,
				PeriodEndDate:   period.EndDate,
				SourceID:        period.SourceID,
			})
		} else {
			for date := range period.CoveredDates {
				paymentObjectiveEmpty[date] = struct{}{}
			}
		}
	}

	check := &product_analysis.AvailabilityCheck{
		BusinessReportMissing:       productAnalysisSetDifferenceStrings(allDates, businessDaily),
		ADReportMissing:             productAnalysisSetDifferenceStrings(allDates, adDaily),
		InventoryMissing:            productAnalysisSetDifferenceStrings(allDates, inventoryDaily),
		BusinessPeriodInfo:          productAnalysisCoverageItems(businessPeriods),
		ADPeriodInfo:                productAnalysisCoverageItems(adPeriods),
		BusinessPeriodicOnlyMissing: productAnalysisIntersectionBetweenSets(productAnalysisSetDifference(allDates, businessDaily), businessAll),
		ADPeriodicOnlyMissing:       productAnalysisIntersectionBetweenSets(productAnalysisSetDifference(allDates, adDaily), adAll),
		PaymentPeriodsOverlapping:   paymentOverlaps,
		PaymentFullPeriodCovered:    productAnalysisSetContainsAll(allDates, paymentReal),
		PaymentDailyCoveredDates:    productAnalysisSortedKeys(paymentDailyCovered),
		PaymentObjectiveEmptyDates:  productAnalysisDifferenceBetweenSets(paymentObjectiveEmpty, paymentReal),
		WeeklyAvailability:          productAnalysisWeeklyAvailability(allDates, businessDaily, adDaily, businessAll, adAll, paymentReal, paymentObjectiveEmpty),
	}
	for _, availability := range check.WeeklyAvailability {
		if availability.CanCalculate {
			check.HasMinimumData = true
			break
		}
	}
	return check
}

func productAnalysisWeeklyAvailability(
	allDates []string,
	businessDaily productAnalysisDateSet,
	adDaily productAnalysisDateSet,
	businessAll productAnalysisDateSet,
	adAll productAnalysisDateSet,
	paymentReal productAnalysisDateSet,
	paymentObjectiveEmpty productAnalysisDateSet,
) []product_analysis.WeeklyAvailability {
	type weekKey struct {
		Year int
		Week int
	}
	groups := map[weekKey][]string{}
	for _, date := range allDates {
		parsed, _ := time.Parse("2006-01-02", date)
		year, week := parsed.ISOWeek()
		groups[weekKey{Year: year, Week: week}] = append(
			groups[weekKey{Year: year, Week: week}],
			date,
		)
	}
	keys := make([]weekKey, 0, len(groups))
	for key := range groups {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].Year == keys[j].Year {
			return keys[i].Week < keys[j].Week
		}
		return keys[i].Year < keys[j].Year
	})

	result := make([]product_analysis.WeeklyAvailability, 0, len(keys))
	for _, key := range keys {
		dates := groups[key]
		businessDailyCount := 0
		adDailyCount := 0
		businessAllCount := 0
		adAllCount := 0
		paymentMissing := false
		businessMissing := make([]string, 0)
		adMissing := make([]string, 0)
		objectiveEmpty := make([]string, 0)
		for _, date := range dates {
			if _, ok := businessDaily[date]; ok {
				businessDailyCount++
			} else {
				businessMissing = append(businessMissing, date)
			}
			if _, ok := adDaily[date]; ok {
				adDailyCount++
			} else {
				adMissing = append(adMissing, date)
			}
			if _, ok := businessAll[date]; ok {
				businessAllCount++
			}
			if _, ok := adAll[date]; ok {
				adAllCount++
			}
			if _, ok := paymentReal[date]; !ok {
				if _, objective := paymentObjectiveEmpty[date]; !objective {
					paymentMissing = true
				}
			}
			if _, ok := paymentObjectiveEmpty[date]; ok {
				if _, real := paymentReal[date]; !real {
					objectiveEmpty = append(objectiveEmpty, date)
				}
			}
		}
		canCalculate := businessAllCount > 0 || adAllCount > 0
		isPartial := businessDailyCount < len(dates) ||
			adDailyCount < len(dates) ||
			paymentMissing
		result = append(result, product_analysis.WeeklyAvailability{
			ISOYear:                     key.Year,
			ISOWeek:                     key.Week,
			WeekStartDate:               dates[0],
			WeekEndDate:                 dates[len(dates)-1],
			TotalDays:                   len(dates),
			BusinessReportAvailableDays: businessDailyCount,
			ADReportAvailableDays:       adDailyCount,
			BusinessPeriodicCovered:     businessAllCount > businessDailyCount,
			ADPeriodicCovered:           adAllCount > adDailyCount,
			PaymentCovered:              !paymentMissing,
			CanCalculate:                canCalculate,
			IsPartial:                   isPartial,
			BusinessMissingDates:        businessMissing,
			ADMissingDates:              adMissing,
			PaymentObjectiveEmptyDates:  objectiveEmpty,
		})
	}
	if result == nil {
		result = []product_analysis.WeeklyAvailability{}
	}
	return result
}

func productAnalysisScanProjectIDs(rows Rows) ([]int64, error) {
	ids := make([]int64, 0)
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func productAnalysisScanDateSet(rows Rows) (productAnalysisDateSet, error) {
	set := productAnalysisDateSet{}
	for rows.Next() {
		var date time.Time
		if err := rows.Scan(&date); err != nil {
			return nil, err
		}
		set[date.Format("2006-01-02")] = struct{}{}
	}
	return set, rows.Err()
}

func productAnalysisScanCoverage(
	rows Rows,
	rangeStart time.Time,
	rangeEnd time.Time,
) ([]productAnalysisCoverage, error) {
	items := make([]productAnalysisCoverage, 0)
	for rows.Next() {
		var (
			periodStart time.Time
			periodEnd   time.Time
			sourceID    int64
		)
		if err := rows.Scan(&periodStart, &periodEnd, &sourceID); err != nil {
			return nil, err
		}
		items = append(items, productAnalysisCoverage{
			StartDate:    periodStart.Format("2006-01-02"),
			EndDate:      periodEnd.Format("2006-01-02"),
			SourceID:     sourceID,
			CoveredDates: productAnalysisIntersectCoverage(periodStart, periodEnd, rangeStart, rangeEnd),
		})
	}
	return items, rows.Err()
}

func productAnalysisTrimPage(items []map[string]any, limit int) ([]map[string]any, bool, error) {
	hasNext := len(items) > limit-1
	if hasNext {
		items = items[:limit-1]
	}
	if items == nil {
		items = []map[string]any{}
	}
	return items, hasNext, nil
}

func productAnalysisInitialCapacity(limit int) int {
	if limit <= 0 {
		return 16
	}
	if limit > 1024 {
		return 1024
	}
	return limit
}

func productAnalysisOffset(page, pageSize int) int64 {
	if page <= 1 {
		return 0
	}
	if page-1 > math.MaxInt/pageSize {
		return math.MaxInt
	}
	return int64((page - 1) * pageSize)
}

func productAnalysisNumericFloat(value pgtype.Numeric) float64 {
	if !value.Valid {
		return 0
	}
	result, err := value.Float64Value()
	if err != nil {
		return 0
	}
	return result.Float64
}

func productAnalysisContainsOperator(value *string, operator string) bool {
	operator = strings.TrimSpace(operator)
	if value == nil || operator == "" {
		return false
	}
	for _, name := range strings.FieldsFunc(*value, func(char rune) bool {
		switch char {
		case ',', '、', '，', ';', '\n', '\r', '\t', ' ':
			return true
		default:
			return false
		}
	}) {
		if strings.TrimSpace(name) == operator {
			return true
		}
	}
	return false
}

func productAnalysisJSONMap(raw []byte) map[string]any {
	if len(raw) == 0 {
		return map[string]any{}
	}
	var value map[string]any
	if err := json.Unmarshal(raw, &value); err != nil || value == nil {
		return map[string]any{}
	}
	return value
}

func productAnalysisDateString(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := value.Format("2006-01-02")
	return &formatted
}

func productAnalysisTimestampString(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := httpapi.Timestamp(*value)
	return &formatted
}

func productAnalysisTimestampAny(value *time.Time) any {
	if value == nil {
		return nil
	}
	return httpapi.Timestamp(*value)
}

func productAnalysisTextInt64(value *string) *int64 {
	if value == nil {
		return nil
	}
	parsed, err := strconv.ParseInt(strings.TrimSpace(*value), 10, 64)
	if err != nil {
		return nil
	}
	return &parsed
}

func productAnalysisOptionalString(value string) *string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	copy := value
	return &copy
}

func productAnalysisPreferredString(preferred, fallback string) any {
	if strings.TrimSpace(preferred) != "" {
		return preferred
	}
	if strings.TrimSpace(fallback) != "" {
		return fallback
	}
	return nil
}

func productAnalysisNormalizeCountry(value, fallback string) string {
	switch strings.ToUpper(strings.TrimSpace(value)) {
	case "US", "USA":
		return "US"
	case "DE", "GERMANY":
		return "DE"
	case "UK", "GB", "UNITED KINGDOM":
		return "UK"
	default:
		return fallback
	}
}

func productAnalysisMapNumber(value map[string]any, keys ...string) (float64, bool) {
	for _, key := range keys {
		raw, ok := value[key]
		if !ok || raw == nil {
			continue
		}
		number, ok := productAnalysisNumber(raw)
		if ok {
			return number, true
		}
	}
	return 0, false
}

func productAnalysisNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case float32:
		return float64(typed), true
	case int:
		return float64(typed), true
	case int32:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case json.Number:
		parsed, err := typed.Float64()
		return parsed, err == nil
	case string:
		clean := strings.TrimSpace(strings.ReplaceAll(typed, ",", ""))
		if clean == "" {
			return 0, false
		}
		parsed, err := strconv.ParseFloat(clean, 64)
		return parsed, err == nil
	default:
		return 0, false
	}
}

func productAnalysisSetMissingNumber(value map[string]any, number float64, key string) {
	if existing, ok := value[key]; ok && existing != nil {
		return
	}
	value[key] = number
}

func productAnalysisDateRange(startDate, endDate time.Time) []string {
	result := make([]string, 0)
	for current := startDate; !current.After(endDate); current = current.AddDate(0, 0, 1) {
		result = append(result, current.Format("2006-01-02"))
	}
	return result
}

func productAnalysisIntersectCoverage(
	periodStart time.Time,
	periodEnd time.Time,
	rangeStart time.Time,
	rangeEnd time.Time,
) productAnalysisDateSet {
	result := productAnalysisDateSet{}
	start := periodStart
	if rangeStart.After(start) {
		start = rangeStart
	}
	end := periodEnd
	if rangeEnd.Before(end) {
		end = rangeEnd
	}
	if start.After(end) {
		return result
	}
	for current := start; !current.After(end); current = current.AddDate(0, 0, 1) {
		result[current.Format("2006-01-02")] = struct{}{}
	}
	return result
}

func productAnalysisUnionCoverage(
	daily productAnalysisDateSet,
	periods []productAnalysisCoverage,
) productAnalysisDateSet {
	result := productAnalysisCopySet(daily)
	for _, period := range periods {
		for date := range period.CoveredDates {
			result[date] = struct{}{}
		}
	}
	return result
}

func productAnalysisCoverageItems(periods []productAnalysisCoverage) []product_analysis.PeriodCoverageInfo {
	items := make([]product_analysis.PeriodCoverageInfo, 0, len(periods))
	for _, period := range periods {
		items = append(items, product_analysis.PeriodCoverageInfo{
			PeriodStartDate: period.StartDate,
			PeriodEndDate:   period.EndDate,
			SourceID:        period.SourceID,
			CoveredDates:    productAnalysisSortedKeys(period.CoveredDates),
		})
	}
	return items
}

func productAnalysisCopySet(source productAnalysisDateSet) productAnalysisDateSet {
	result := make(productAnalysisDateSet, len(source))
	for key := range source {
		result[key] = struct{}{}
	}
	return result
}

func productAnalysisSetDifference(left []string, right productAnalysisDateSet) productAnalysisDateSet {
	result := productAnalysisDateSet{}
	for _, date := range left {
		if _, ok := right[date]; !ok {
			result[date] = struct{}{}
		}
	}
	return result
}

func productAnalysisDifferenceBetweenSets(
	left productAnalysisDateSet,
	right productAnalysisDateSet,
) []string {
	result := productAnalysisDateSet{}
	for date := range left {
		if _, ok := right[date]; !ok {
			result[date] = struct{}{}
		}
	}
	return productAnalysisSortedKeys(result)
}

func productAnalysisIntersectionBetweenSets(
	left productAnalysisDateSet,
	right productAnalysisDateSet,
) []string {
	result := productAnalysisDateSet{}
	for date := range left {
		if _, ok := right[date]; ok {
			result[date] = struct{}{}
		}
	}
	return productAnalysisSortedKeys(result)
}

func productAnalysisSetDifferenceStrings(left []string, right productAnalysisDateSet) []string {
	return productAnalysisSortedKeys(productAnalysisSetDifference(left, right))
}

func productAnalysisSetContainsAll(dates []string, set productAnalysisDateSet) bool {
	for _, date := range dates {
		if _, ok := set[date]; !ok {
			return false
		}
	}
	return true
}

func productAnalysisSortedKeys(set productAnalysisDateSet) []string {
	keys := make([]string, 0, len(set))
	for key := range set {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	if keys == nil {
		keys = []string{}
	}
	return keys
}

const productAnalysisDefaultUploadRoot = "backend/storage/uploads"

type productAnalysisCalculationEngine struct {
	db         FullDB
	uploadRoot string
	now        func() time.Time
}

// NewProductAnalysisCalculationEngine builds the production engine used by
// product-analysis mutation endpoints. The engine reads real source/detail
// rows and writes PT1 calculations transactionally.
func NewProductAnalysisCalculationEngine(
	db FullDB,
	uploadRoot string,
) product_analysis.CalculationEngine {
	if db == nil {
		return nil
	}
	uploadRoot = strings.TrimSpace(uploadRoot)
	if uploadRoot == "" {
		uploadRoot = productAnalysisUploadRoot()
	}
	return &productAnalysisCalculationEngine{
		db:         db,
		uploadRoot: uploadRoot,
		now:        time.Now,
	}
}

func productAnalysisUploadRoot() string {
	if root := strings.TrimSpace(os.Getenv("UPLOAD_ROOT")); root != "" {
		return root
	}
	return productAnalysisDefaultUploadRoot
}

func (e *productAnalysisCalculationEngine) Run(
	ctx context.Context,
	request product_analysis.RunRequest,
	principal product_analysis.Principal,
) (*product_analysis.RunResponse, error) {
	if e == nil || e.db == nil {
		return nil, productAnalysisServiceUnavailable("product analysis database")
	}
	startDate, endDate, err := productAnalysisEngineDates(
		request.StartDate,
		request.EndDate,
	)
	if err != nil {
		return nil, err
	}
	project, err := productAnalysisEngineLoadProject(
		ctx,
		e.db,
		request.ProjectID,
		principal,
	)
	if err != nil {
		return nil, err
	}
	country := productAnalysisNormalizeCountry(request.Country, "US")
	var result *product_analysis.RunResponse
	if productAnalysisIsSingleFullWeek(startDate, endDate) {
		err = e.withTransaction(ctx, func(tx FullDB) error {
			var runErr error
			result, runErr = productAnalysisRunFromHistory(
				ctx,
				tx,
				project,
				country,
				startDate,
				endDate,
				request.CurrentOnly,
			)
			return runErr
		})
	} else {
		result, err = productAnalysisRunFromHistory(
			ctx,
			e.db,
			project,
			country,
			startDate,
			endDate,
			request.CurrentOnly,
		)
	}
	if err != nil {
		return nil, err
	}
	if result == nil {
		result = &product_analysis.RunResponse{
			ProjectID:   project.ID,
			ProjectName: project.Name,
			Country:     country,
			Periods:     []product_analysis.CalculationPeriod{},
		}
	}
	return result, nil
}

func (e *productAnalysisCalculationEngine) Preview(
	ctx context.Context,
	request product_analysis.PreviewRequest,
	principal product_analysis.Principal,
) (*product_analysis.RunResponse, error) {
	if e == nil || e.db == nil {
		return nil, productAnalysisServiceUnavailable("product analysis database")
	}
	startDate, endDate, err := productAnalysisEngineDates(
		request.StartDate,
		request.EndDate,
	)
	if err != nil {
		return nil, err
	}
	project, err := productAnalysisEngineLoadProject(
		ctx,
		e.db,
		request.ProjectID,
		principal,
	)
	if err != nil {
		return nil, err
	}
	country := productAnalysisNormalizeCountry(request.Country, "US")
	missing := make([]string, 0, 3)
	if request.BusinessTempFileID == nil || strings.TrimSpace(*request.BusinessTempFileID) == "" {
		missing = append(missing, "business_temp_file_id")
	}
	if request.PaymentTempFileID == nil || strings.TrimSpace(*request.PaymentTempFileID) == "" {
		missing = append(missing, "payment_temp_file_id")
	}
	if request.ADTempFileID == nil || strings.TrimSpace(*request.ADTempFileID) == "" {
		missing = append(missing, "ad_temp_file_id")
	}
	if len(missing) > 0 {
		return nil, productAnalysisBadRequest(
			"临时文件不存在或已失效: " + strings.Join(missing, ", "),
		)
	}

	businessPath, err := e.resolveTempFile(*request.BusinessTempFileID, false)
	if err != nil {
		return nil, productAnalysisBadRequest(
			"临时文件不存在或已失效: business_temp_file_id",
		)
	}
	paymentPath, err := e.resolveTempFile(*request.PaymentTempFileID, false)
	if err != nil {
		return nil, productAnalysisBadRequest(
			"临时文件不存在或已失效: payment_temp_file_id",
		)
	}
	adPath, err := e.resolveTempFile(*request.ADTempFileID, true)
	if err != nil {
		return nil, productAnalysisBadRequest(
			"临时文件不存在或已失效: ad_temp_file_id",
		)
	}

	result, err := productAnalysisPreviewFromFiles(
		ctx,
		e.db,
		project,
		country,
		startDate,
		endDate,
		businessPath,
		paymentPath,
		adPath,
	)
	if err != nil {
		return nil, err
	}
	if result == nil {
		result = &product_analysis.RunResponse{
			ProjectID:   project.ID,
			ProjectName: project.Name,
			Country:     country,
			Periods:     []product_analysis.CalculationPeriod{},
		}
	}
	return result, nil
}

func (e *productAnalysisCalculationEngine) RecomputeWeekly(
	ctx context.Context,
	request product_analysis.WeeklyRecomputeRequest,
	principal product_analysis.Principal,
) (*product_analysis.WeeklyRecomputeResponse, error) {
	if e == nil || e.db == nil {
		return nil, productAnalysisServiceUnavailable("product analysis database")
	}
	startDate, err := productAnalysisEngineOptionalDate(request.StartDate, "start_date")
	if err != nil {
		return nil, err
	}
	endDate, err := productAnalysisEngineOptionalDate(request.EndDate, "end_date")
	if err != nil {
		return nil, err
	}
	if startDate != nil && endDate != nil && startDate.After(*endDate) {
		return nil, productAnalysisBadRequest("start_date must not be after end_date")
	}
	project, err := productAnalysisEngineLoadProject(
		ctx,
		e.db,
		request.ProjectID,
		principal,
	)
	if err != nil {
		return nil, err
	}
	country := productAnalysisNormalizeCountry(request.Country, "US")
	var result *product_analysis.WeeklyRecomputeResponse
	err = e.withTransaction(ctx, func(tx FullDB) error {
		var recomputeErr error
		result, recomputeErr = productAnalysisRecomputeWeeklyFromHistory(
			ctx,
			tx,
			project,
			country,
			startDate,
			endDate,
			request.CurrentOnly,
		)
		return recomputeErr
	})
	if err != nil {
		return nil, err
	}
	if result == nil {
		result = &product_analysis.WeeklyRecomputeResponse{
			ProjectID:   project.ID,
			ProjectName: project.Name,
			Country:     country,
			Periods:     []product_analysis.WeeklyRecomputePeriod{},
		}
	}
	return result, nil
}

func (e *productAnalysisCalculationEngine) TriggerRecompute(
	ctx context.Context,
	request product_analysis.TriggerRecomputeRequest,
	principal product_analysis.Principal,
) (map[string]any, error) {
	if e == nil || e.db == nil {
		return nil, productAnalysisServiceUnavailable("product analysis database")
	}
	startDate, err := productAnalysisEngineDate(
		request.PeriodStartDate,
		"period_start_date",
	)
	if err != nil {
		return nil, err
	}
	endDate, err := productAnalysisEngineDate(
		request.PeriodEndDate,
		"period_end_date",
	)
	if err != nil {
		return nil, err
	}
	if startDate.After(endDate) {
		return nil, productAnalysisBadRequest(
			"period_start_date must not be after period_end_date",
		)
	}
	project, err := productAnalysisEngineLoadProject(
		ctx,
		e.db,
		request.ProjectID,
		principal,
	)
	if err != nil {
		return nil, err
	}
	country := productAnalysisNormalizeCountry(request.Country, "US")
	var result map[string]any
	err = e.withTransaction(ctx, func(tx FullDB) error {
		var recomputeErr error
		result, recomputeErr = productAnalysisRecomputePeriod(
			ctx,
			tx,
			project,
			country,
			startDate,
			endDate,
		)
		return recomputeErr
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func (e *productAnalysisCalculationEngine) UploadSources(
	ctx context.Context,
	request product_analysis.UploadSourcesRequest,
	principal product_analysis.Principal,
) (*product_analysis.UploadSourcesResponse, error) {
	if e == nil || e.db == nil {
		return nil, productAnalysisServiceUnavailable("product analysis database")
	}
	projectName := strings.TrimSpace(request.ProjectName)
	if projectName == "" {
		return nil, product_analysis.ErrProjectNotFound
	}
	startDate, err := productAnalysisEngineDate(
		request.ReportStartDate,
		"report_start_date",
	)
	if err != nil {
		return nil, err
	}
	endDate, err := productAnalysisEngineDate(
		request.ReportEndDate,
		"report_end_date",
	)
	if err != nil {
		return nil, err
	}
	if startDate.After(endDate) {
		return nil, productAnalysisBadRequest(
			"report_start_date cannot be greater than report_end_date",
		)
	}
	project, err := productAnalysisEngineLoadProjectByName(
		ctx,
		e.db,
		projectName,
		principal,
	)
	if err != nil {
		return nil, err
	}
	country := productAnalysisNormalizeCountry(request.Country, "US")
	reportTypes := []string{
		"business_report",
		"payment_report",
		"ad_product_report",
		"inventory_report",
	}
	resolvedPaths := make(map[string]string, len(reportTypes))
	for _, reportType := range reportTypes {
		fileID := productAnalysisLookupReportValue(request.FileIDs, reportType)
		filePath := productAnalysisLookupReportValue(request.ResolvedFilePaths, reportType)
		rawPath := filePath
		if rawPath == "" {
			rawPath = fileID
		}
		if rawPath == "" {
			continue
		}
		resolvedPath, resolveErr := e.resolveSourceFile(rawPath)
		if resolveErr != nil {
			return nil, productAnalysisBadRequest(
				"Invalid resolved_file_paths for " + reportType,
			)
		}
		resolvedPaths[reportType] = resolvedPath
	}
	response := &product_analysis.UploadSourcesResponse{
		Outcomes: make([]product_analysis.SourcePersistOutcome, 0, 4),
	}
	for _, reportType := range reportTypes {
		fileID := productAnalysisLookupReportValue(request.FileIDs, reportType)
		filePath := productAnalysisLookupReportValue(request.ResolvedFilePaths, reportType)
		if fileID == "" && filePath == "" {
			if reportType == "inventory_report" {
				continue
			}
			message := "missing file for " + reportType
			response.Outcomes = append(
				response.Outcomes,
				product_analysis.SourcePersistOutcome{
					ReportType:   reportType,
					Success:      false,
					ErrorMessage: &message,
				},
			)
			continue
		}
		resolvedPath := resolvedPaths[reportType]
		if fileID == "" {
			fileID = filepath.Base(resolvedPath)
		}
		var sourceID int64
		err := RunInTx(ctx, e.db, func(tx pgx.Tx) error {
			txDB := NewTxDB(tx)
			switch reportType {
			case "ad_product_report":
				var persistErr error
				sourceID, persistErr = productAnalysisPersistADSource(
					ctx,
					txDB,
					project,
					country,
					startDate,
					endDate,
					fileID,
					resolvedPath,
					principal.Operator,
				)
				return persistErr
			case "inventory_report":
				var persistErr error
				sourceID, persistErr = productAnalysisPersistInventorySource(
					ctx,
					txDB,
					project,
					country,
					startDate,
					fileID,
					resolvedPath,
					principal.Operator,
				)
				return persistErr
			default:
				var persistErr error
				sourceID, persistErr = productAnalysisPersistAnalysisSource(
					ctx,
					txDB,
					project,
					country,
					reportType,
					startDate,
					endDate,
					fileID,
					resolvedPath,
					principal.Operator,
				)
				return persistErr
			}
		})
		outcome := product_analysis.SourcePersistOutcome{
			ReportType: reportType,
			Success:    err == nil,
		}
		if err == nil {
			outcome.SourceID = &sourceID
		} else {
			message := err.Error()
			outcome.ErrorMessage = &message
		}
		response.Outcomes = append(response.Outcomes, outcome)
	}
	return response, nil
}

func productAnalysisLookupReportValue(
	values map[string]string,
	reportType string,
) string {
	if values == nil {
		return ""
	}
	keys := []string{reportType}
	if reportType == "ad_product_report" {
		keys = append(
			keys,
			"ad_report",
			"ad_promoted_product_report",
		)
	}
	for _, key := range keys {
		if value := strings.TrimSpace(values[key]); value != "" {
			return value
		}
	}
	return ""
}

func productAnalysisPersistAnalysisSource(
	ctx context.Context,
	db FullDB,
	project productAnalysisEngineProject,
	country string,
	reportType string,
	startDate time.Time,
	endDate time.Time,
	fileID string,
	filePath string,
	createdBy string,
) (int64, error) {
	prepared, err := productAnalysisPreparedFile(fileID, filePath)
	if err != nil {
		return 0, err
	}
	known, err := productAnalysisLoadIdentifiers(ctx, db, project.ID, country)
	if err != nil {
		return 0, err
	}
	var (
		rowCount      int
		includedCount int
		rows          []businessRow
		payments      []paymentRow
	)
	switch reportType {
	case "business_report":
		table, err := productAnalysisReadTableFile(filePath, ',')
		if err != nil {
			return 0, err
		}
		if err := productAnalysisValidateBusinessHeaders(table.Headers); err != nil {
			return 0, err
		}
		rows = parseBusinessRows(table, table.Headers)
		productAnalysisCorrectBusinessRows(table, rows)
		rowCount = len(rows)
		includedCount = rowCount
	case "payment_report":
		table, err := productAnalysisReadPaymentTable(filePath, country)
		if err != nil {
			return 0, err
		}
		headers := normalizedHeaders(table.Headers)
		payments = parsePaymentRows(table, headers)
		productAnalysisCorrectPaymentRows(table, payments, country)
		rowCount = len(payments)
		for _, row := range payments {
			scope, _ := classifyScope(row.SKU, row.ASIN, known)
			if scope == "included_product" {
				includedCount++
			}
		}
	default:
		return 0, fmt.Errorf("unsupported report_type: %s", reportType)
	}
	sourceID, err := insertAnalysisSource(ctx, db, analysisSourceInput{
		ProjectID:        project.ID,
		ReportType:       reportType,
		Country:          country,
		PeriodStart:      &startDate,
		PeriodEnd:        &endDate,
		File:             prepared,
		RowCountTotal:    rowCount,
		RowCountIncluded: includedCount,
		CreatedBy:        productAnalysisOptionalString(createdBy),
	})
	if err != nil {
		return 0, err
	}
	switch reportType {
	case "business_report":
		if err := insertBusinessRows(ctx, db, sourceID, rows); err != nil {
			return 0, err
		}
	case "payment_report":
		if err := insertPaymentRows(ctx, db, sourceID, payments, known); err != nil {
			return 0, err
		}
	}
	if err := insertReportUploadLog(
		ctx,
		db,
		project.ID,
		reportType,
		country,
		endDate,
		sourceID,
		rowCount,
		prepared.OriginalFilename,
	); err != nil {
		return 0, err
	}
	return sourceID, nil
}

func productAnalysisPersistInventorySource(
	ctx context.Context,
	db FullDB,
	project productAnalysisEngineProject,
	country string,
	reportDate time.Time,
	fileID string,
	filePath string,
	createdBy string,
) (int64, error) {
	prepared, err := productAnalysisPreparedFile(fileID, filePath)
	if err != nil {
		return 0, err
	}
	table, err := productAnalysisReadInventoryTable(filePath)
	if err != nil {
		return 0, err
	}
	headers := normalizedHeaders(table.Headers)
	if !hasHeaders(headers, "sku", "asin") {
		return 0, errors.New("Inventory report missing required columns")
	}
	rows := parseInventoryRows(table, headers)
	now := time.Now().UTC()
	sourceID, err := insertAnalysisSource(ctx, db, analysisSourceInput{
		ProjectID:        project.ID,
		ReportType:       "inventory_report",
		Country:          country,
		ReportDate:       &reportDate,
		SnapshotAt:       &now,
		File:             prepared,
		RowCountTotal:    len(rows),
		RowCountIncluded: len(rows),
		CreatedBy:        productAnalysisOptionalString(createdBy),
	})
	if err != nil {
		return 0, err
	}
	if err := insertInventoryRows(ctx, db, sourceID, rows); err != nil {
		return 0, err
	}
	if err := insertReportUploadLog(
		ctx,
		db,
		project.ID,
		"inventory_report",
		country,
		reportDate,
		sourceID,
		len(rows),
		prepared.OriginalFilename,
	); err != nil {
		return 0, err
	}
	return sourceID, nil
}

func productAnalysisPersistADSource(
	ctx context.Context,
	db FullDB,
	project productAnalysisEngineProject,
	country string,
	startDate time.Time,
	endDate time.Time,
	fileID string,
	filePath string,
	createdBy string,
) (int64, error) {
	raw, err := os.ReadFile(filePath)
	if err != nil {
		return 0, err
	}
	parsed, err := parseAdUploadData(filepath.Base(filePath), raw, country)
	if err != nil {
		return 0, err
	}
	if parsed.match.spec.reportType != "ad_promoted_product_report" {
		return 0, errors.New("ad report must be a promoted product report")
	}
	fileHash, err := fileSHA256(filePath)
	if err != nil {
		return 0, err
	}
	info, err := os.Stat(filePath)
	if err != nil {
		return 0, err
	}
	var version int
	if err := db.QueryRow(
		ctx,
		`select coalesce(max(version), 0) + 1
		 from public.ad_upload_files
		 where project_id = $1
		   and report_type = 'ad_promoted_product_report'
		   and country = $2
		   and period_start_date = $3::date
		   and period_end_date = $4::date`,
		project.ID,
		country,
		startDate.Format("2006-01-02"),
		endDate.Format("2006-01-02"),
	).Scan(&version); err != nil {
		return 0, err
	}
	now := time.Now().UTC()
	if _, err := db.Exec(
		ctx,
		`update public.ad_upload_files
		 set is_current = false,
		     superseded_at = case when is_current then $5 else superseded_at end
		 where project_id = $1
		   and report_type = 'ad_promoted_product_report'
		   and country = $2
		   and period_start_date = $3::date
		   and period_end_date = $4::date
		   and is_current is true`,
		project.ID,
		country,
		startDate.Format("2006-01-02"),
		endDate.Format("2006-01-02"),
		now,
	); err != nil {
		return 0, err
	}
	matchedColumns, err := json.Marshal(parsed.match.matchedColumns)
	if err != nil {
		return 0, err
	}
	baseName := filepath.Base(filePath)
	originalName := baseName
	if strings.TrimSpace(fileID) != "" {
		originalName = filepath.Base(fileID)
	}
	var sourceID int64
	err = db.QueryRow(
		ctx,
		`insert into public.ad_upload_files (
		   project_id, project_name, report_type, report_label, country,
		   report_date, period_start_date, period_end_date, version,
		   is_current, superseded_at, upload_file_id, upload_file_path,
		   original_filename, stored_filename, logical_filename,
		   file_extension, file_size_bytes, file_sha256, recognition_status,
		   ingestion_status, ingestion_error, row_count_preview,
		   matched_columns, warnings, recognition_payload, created_by
		 ) values (
		   $1, $2, 'ad_promoted_product_report', $3, $4, null,
		   $5::date, $6::date, $7, true, null, $8, $9, $10, $11,
		   $12, $13, $14, $15, 'recognized', 'saved', null, $16,
		   $17::json, '[]'::json, '{}'::json, $18
		 )
		 returning id`,
		project.ID,
		project.Name,
		"Ad-Promoted-Product-"+startDate.Format("2006-01-02"),
		country,
		startDate.Format("2006-01-02"),
		endDate.Format("2006-01-02"),
		version,
		fileID,
		filePath,
		originalName,
		fileID,
		baseName,
		strings.ToLower(filepath.Ext(baseName)),
		info.Size(),
		fileHash,
		len(parsed.rows),
		matchedColumns,
		productAnalysisOptionalString(createdBy),
	).Scan(&sourceID)
	if err != nil {
		return 0, err
	}
	if err := insertAdDetailRows(
		ctx,
		db,
		sourceID,
		parsed,
		parsed.rows,
		startDate.Format("2006-01-02"),
		endDate.Format("2006-01-02"),
	); err != nil {
		return 0, err
	}
	germanNumbers := strings.EqualFold(country, "DE")
	for rowIndex, values := range parsed.rows {
		row := newAdRowData(
			parsed.headers,
			values,
			startDate.Format("2006-01-02"),
			endDate.Format("2006-01-02"),
			&parsed.country,
		)
		if _, err := db.Exec(
			ctx,
			`update public.ad_upload_promoted_product_rows
			 set impressions = $2,
			     clicks = $3,
			     orders_7d = $4,
			     spend = $5,
			     sales_7d = $6
			 where source_file_id = $1 and source_row_no = $7`,
			sourceID,
			productAnalysisADInteger(row, germanNumbers, "展示量"),
			productAnalysisADInteger(row, germanNumbers, "点击量"),
			productAnalysisADInteger(
				row,
				germanNumbers,
				"购买量",
				"7天总订单数(#)",
			),
			productAnalysisADFloat(row, germanNumbers, "总成本", "花费"),
			productAnalysisADFloat(row, germanNumbers, "销售额", "7天总销售额"),
			rowIndex+1,
		); err != nil {
			return 0, err
		}
	}
	known, err := productAnalysisLoadIdentifiers(ctx, db, project.ID, country)
	if err != nil {
		return 0, err
	}
	rows, err := db.Query(
		ctx,
		`select id, ad_sku, ad_asin
		 from public.ad_upload_promoted_product_rows
		 where source_file_id = $1
		 order by source_row_no asc`,
		sourceID,
	)
	if err != nil {
		return 0, err
	}
	type scopeUpdate struct {
		id    int64
		scope string
	}
	updates := make([]scopeUpdate, 0, len(parsed.rows))
	for rows.Next() {
		var (
			id     int64
			adSKU  *string
			adASIN *string
		)
		if err := rows.Scan(&id, &adSKU, &adASIN); err != nil {
			rows.Close()
			return 0, err
		}
		scope, _ := classifyScope(adSKU, adASIN, known)
		updates = append(updates, scopeUpdate{id: id, scope: scope})
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	rows.Close()
	for _, update := range updates {
		if _, err := db.Exec(
			ctx,
			`update public.ad_upload_promoted_product_rows
			 set scope_status = $2
			 where id = $1`,
			update.id,
			update.scope,
		); err != nil {
			return 0, err
		}
	}
	// ad_product_report is stored in ad_upload_files, while the legacy upload
	// log FK points to analysis_source_files. Keep the log row without a source
	// id instead of violating that FK with a C-table id.
	if _, err := db.Exec(
		ctx,
		`insert into public.report_upload_logs (
		   project_id, report_type, country, upload_date, has_real_data,
		   row_count, source_file_id, original_filename
		 ) values ($1, 'ad_product_report', $2, $3::date, true, $4, null, $5)`,
		project.ID,
		country,
		endDate.Format("2006-01-02"),
		len(parsed.rows),
		originalName,
	); err != nil {
		return 0, err
	}
	return sourceID, nil
}

func productAnalysisPreparedFile(fileID string, filePath string) (uploads.PreparedReportFile, error) {
	info, err := os.Stat(filePath)
	if err != nil {
		return uploads.PreparedReportFile{}, err
	}
	baseName := filepath.Base(filePath)
	if strings.TrimSpace(fileID) == "" {
		fileID = baseName
	}
	return uploads.PreparedReportFile{
		FileID:           fileID,
		FilePath:         filePath,
		Filename:         baseName,
		OriginalFilename: baseName,
		Size:             info.Size(),
		LocalPath:        filePath,
	}, nil
}

func productAnalysisReadPaymentTable(path string, country string) (tableData, error) {
	if strings.EqualFold(filepath.Ext(path), ".xlsx") {
		table, err := parseUploadXLSXTable(path)
		if err != nil {
			return tableData{}, err
		}
		if !paymentHeaderMatches(normalizedHeaders(table.Headers)) {
			return tableData{}, errors.New("payment report header row not found")
		}
		return table, nil
	}
	return readPaymentTable(path, country)
}

func productAnalysisReadInventoryTable(path string) (tableData, error) {
	if strings.EqualFold(filepath.Ext(path), ".xlsx") {
		return parseUploadXLSXTable(path)
	}
	return readTable(path, '\t')
}

func (e *productAnalysisCalculationEngine) withTransaction(
	ctx context.Context,
	fn func(FullDB) error,
) error {
	if e == nil || e.db == nil {
		return productAnalysisServiceUnavailable("product analysis database")
	}
	return RunInTx(ctx, e.db, func(tx pgx.Tx) error {
		return fn(NewTxDB(tx))
	})
}

type productAnalysisEngineProject struct {
	ID                int64
	Name              string
	ProjectOperator   *string
	AssistantOperator *string
}

func productAnalysisEngineLoadProject(
	ctx context.Context,
	db DB,
	projectID int64,
	principal product_analysis.Principal,
) (productAnalysisEngineProject, error) {
	var project productAnalysisEngineProject
	err := db.QueryRow(
		ctx,
		`select id, project_name, project_operator, assistant_operator
		 from public.projects
		 where id = $1`,
		projectID,
	).Scan(
		&project.ID,
		&project.Name,
		&project.ProjectOperator,
		&project.AssistantOperator,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return project, product_analysis.ErrProjectNotFound
	}
	if err != nil {
		return project, err
	}
	if !principal.IsAdmin {
		operator := strings.TrimSpace(principal.Operator)
		if operator == "" ||
			(!productAnalysisContainsOperator(project.ProjectOperator, operator) &&
				!productAnalysisContainsOperator(project.AssistantOperator, operator)) {
			return project, product_analysis.ErrProjectForbidden
		}
	}
	return project, nil
}

func productAnalysisEngineLoadProjectByName(
	ctx context.Context,
	db DB,
	projectName string,
	principal product_analysis.Principal,
) (productAnalysisEngineProject, error) {
	var project productAnalysisEngineProject
	err := db.QueryRow(
		ctx,
		`select id, project_name, project_operator, assistant_operator
		 from public.projects
		 where project_name = $1
		 order by id asc
		 limit 1`,
		strings.TrimSpace(projectName),
	).Scan(
		&project.ID,
		&project.Name,
		&project.ProjectOperator,
		&project.AssistantOperator,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return project, product_analysis.ErrProjectNotFound
	}
	if err != nil {
		return project, err
	}
	if !principal.IsAdmin {
		operator := strings.TrimSpace(principal.Operator)
		if operator == "" ||
			(!productAnalysisContainsOperator(project.ProjectOperator, operator) &&
				!productAnalysisContainsOperator(project.AssistantOperator, operator)) {
			return project, product_analysis.ErrProjectForbidden
		}
	}
	return project, nil
}

func productAnalysisEngineDate(raw string, field string) (time.Time, error) {
	value, err := time.Parse("2006-01-02", strings.TrimSpace(raw))
	if err != nil {
		return time.Time{}, productAnalysisBadRequest(field + " must be YYYY-MM-DD")
	}
	return value, nil
}

func productAnalysisEngineOptionalDate(
	raw *string,
	field string,
) (*time.Time, error) {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return nil, nil
	}
	value, err := productAnalysisEngineDate(*raw, field)
	if err != nil {
		return nil, err
	}
	return &value, nil
}

func productAnalysisEngineDates(rawStart string, rawEnd string) (time.Time, time.Time, error) {
	startDate, err := productAnalysisEngineDate(rawStart, "start_date")
	if err != nil {
		return time.Time{}, time.Time{}, err
	}
	endDate, err := productAnalysisEngineDate(rawEnd, "end_date")
	if err != nil {
		return time.Time{}, time.Time{}, err
	}
	if startDate.After(endDate) {
		return time.Time{}, time.Time{}, productAnalysisBadRequest(
			"start_date must not be after end_date",
		)
	}
	return startDate, endDate, nil
}

func productAnalysisIsSingleFullWeek(startDate time.Time, endDate time.Time) bool {
	if endDate.Sub(startDate) != 6*24*time.Hour ||
		startDate.Weekday() != time.Monday ||
		endDate.Weekday() != time.Sunday {
		return false
	}
	startYear, startWeek := startDate.ISOWeek()
	endYear, endWeek := endDate.ISOWeek()
	return startYear == endYear && startWeek == endWeek
}

func productAnalysisBadRequest(detail string) error {
	return &product_analysis.StatusError{
		Status: http.StatusBadRequest,
		Detail: detail,
	}
}

func productAnalysisUnprocessable(detail string) error {
	return &product_analysis.StatusError{
		Status: http.StatusUnprocessableEntity,
		Detail: detail,
	}
}

func productAnalysisServiceUnavailable(dependency string) error {
	return &product_analysis.StatusError{
		Status: http.StatusServiceUnavailable,
		Detail: dependency + " is not configured",
	}
}

type productAnalysisSourceRef struct {
	ID    int64
	Start time.Time
	End   time.Time
}

type productAnalysisPeriodSources struct {
	Start             time.Time
	End               time.Time
	BusinessSourceIDs []int64
	ADSourceIDs       []int64
	PaymentSourceIDs  []int64
	IsPartial         bool
	Completeness      *product_analysis.PeriodCompleteness
}

type productAnalysisPaymentSourceRef struct {
	ID         int64
	ReportDate *time.Time
	Start      *time.Time
	End        *time.Time
	RowCount   int
}

func productAnalysisRunFromHistory(
	ctx context.Context,
	db FullDB,
	project productAnalysisEngineProject,
	country string,
	startDate time.Time,
	endDate time.Time,
	currentOnly bool,
) (*product_analysis.RunResponse, error) {
	periodSources, err := productAnalysisListPeriodSources(
		ctx,
		db,
		project.ID,
		country,
		&startDate,
		&endDate,
		currentOnly,
	)
	if err != nil {
		return nil, err
	}
	response := &product_analysis.RunResponse{
		ProjectID:   project.ID,
		ProjectName: project.Name,
		Country:     country,
		Periods:     []product_analysis.CalculationPeriod{},
	}
	if productAnalysisIsSingleFullWeek(startDate, endDate) {
		for _, sources := range periodSources {
			payload, err := productAnalysisBuildPayloadForSources(
				ctx,
				db,
				project,
				country,
				sources.Start,
				sources.End,
				sources.BusinessSourceIDs,
				sources.ADSourceIDs,
				sources.PaymentSourceIDs,
			)
			if err != nil {
				return nil, err
			}
			productAnalysisAttachCompleteness(
				payload,
				sources.Completeness,
				sources.IsPartial,
			)
			pt1ID, version, _, err := productAnalysisPersistPT1(
				ctx,
				db,
				project,
				country,
				sources.Start,
				sources.End,
				payload,
			)
			if err != nil {
				return nil, err
			}
			response.Periods = append(
				response.Periods,
				product_analysis.CalculationPeriod{
					ReportStartDate: sources.Start.Format("2006-01-02"),
					ReportEndDate:   sources.End.Format("2006-01-02"),
					Summary:         payload.Summary,
					Details:         payload.Details,
					IsPartial:       sources.IsPartial,
					Completeness:    sources.Completeness,
					Persisted:       true,
					PT1ID:           &pt1ID,
					Version:         &version,
				},
			)
		}
	} else if len(periodSources) > 0 {
		businessIDs := make([]int64, 0)
		adIDs := make([]int64, 0)
		paymentIDs := make([]int64, 0)
		isPartial := false
		var completeness *product_analysis.PeriodCompleteness
		for _, sources := range periodSources {
			businessIDs = append(businessIDs, sources.BusinessSourceIDs...)
			adIDs = append(adIDs, sources.ADSourceIDs...)
			paymentIDs = append(paymentIDs, sources.PaymentSourceIDs...)
			isPartial = isPartial || sources.IsPartial
			if completeness == nil && sources.Completeness != nil {
				completeness = sources.Completeness
			}
		}
		payload, err := productAnalysisBuildPayloadForSources(
			ctx,
			db,
			project,
			country,
			startDate,
			endDate,
			businessIDs,
			adIDs,
			paymentIDs,
		)
		if err != nil {
			return nil, err
		}
		productAnalysisAttachCompleteness(payload, completeness, isPartial)
		response.Periods = append(
			response.Periods,
			product_analysis.CalculationPeriod{
				ReportStartDate: startDate.Format("2006-01-02"),
				ReportEndDate:   endDate.Format("2006-01-02"),
				Summary:         payload.Summary,
				Details:         payload.Details,
				IsPartial:       isPartial,
				Completeness:    completeness,
				Persisted:       false,
			},
		)
	}
	response.TotalPeriods = len(response.Periods)
	return response, nil
}

func productAnalysisRecomputeWeeklyFromHistory(
	ctx context.Context,
	db FullDB,
	project productAnalysisEngineProject,
	country string,
	startDate *time.Time,
	endDate *time.Time,
	currentOnly bool,
) (*product_analysis.WeeklyRecomputeResponse, error) {
	periodSources, err := productAnalysisListPeriodSources(
		ctx,
		db,
		project.ID,
		country,
		startDate,
		endDate,
		currentOnly,
	)
	if err != nil {
		return nil, err
	}
	response := &product_analysis.WeeklyRecomputeResponse{
		ProjectID:   project.ID,
		ProjectName: project.Name,
		Country:     country,
		Periods:     []product_analysis.WeeklyRecomputePeriod{},
	}
	for _, sources := range periodSources {
		payload, err := productAnalysisBuildPayloadForSources(
			ctx,
			db,
			project,
			country,
			sources.Start,
			sources.End,
			sources.BusinessSourceIDs,
			sources.ADSourceIDs,
			sources.PaymentSourceIDs,
		)
		if err != nil {
			return nil, err
		}
		productAnalysisAttachCompleteness(
			payload,
			sources.Completeness,
			sources.IsPartial,
		)
		pt1ID, version, rowCount, err := productAnalysisPersistPT1(
			ctx,
			db,
			project,
			country,
			sources.Start,
			sources.End,
			payload,
		)
		if err != nil {
			return nil, err
		}
		var paymentID *int64
		if len(sources.PaymentSourceIDs) > 0 {
			value := sources.PaymentSourceIDs[0]
			paymentID = &value
		}
		response.Periods = append(
			response.Periods,
			product_analysis.WeeklyRecomputePeriod{
				PT1ID:                  pt1ID,
				Version:                version,
				ReportStartDate:        sources.Start.Format("2006-01-02"),
				ReportEndDate:          sources.End.Format("2006-01-02"),
				RowCount:               rowCount,
				BusinessReportSourceID: productAnalysisFirstID(sources.BusinessSourceIDs),
				ADReportSourceID:       productAnalysisFirstID(sources.ADSourceIDs),
				PaymentReportSourceID:  paymentID,
				IsPartial:              sources.IsPartial,
				Completeness:           sources.Completeness,
			},
		)
	}
	response.Recomputed = len(response.Periods)
	return response, nil
}

func productAnalysisRecomputePeriod(
	ctx context.Context,
	db FullDB,
	project productAnalysisEngineProject,
	country string,
	startDate time.Time,
	endDate time.Time,
) (map[string]any, error) {
	sourceMap := map[string]int64{}
	rows, err := db.Query(
		ctx,
		`select id, report_type
		 from public.analysis_source_files
		 where project_id = $1
		   and report_type in ('business_report', 'payment_report')
		   and country = $2
		   and is_current is true
		   and period_start_date = $3::date
		   and period_end_date = $4::date
		 order by report_type asc, version desc, id desc`,
		project.ID,
		country,
		startDate.Format("2006-01-02"),
		endDate.Format("2006-01-02"),
	)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var (
			id         int64
			reportType string
		)
		if err := rows.Scan(&id, &reportType); err != nil {
			rows.Close()
			return nil, err
		}
		if _, exists := sourceMap[reportType]; !exists {
			sourceMap[reportType] = id
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	var adID int64
	err = db.QueryRow(
		ctx,
		`select id
		 from public.ad_upload_files
		 where project_id = $1
		   and report_type = 'ad_promoted_product_report'
		   and country = $2
		   and is_current is true
		   and period_start_date = $3::date
		   and period_end_date = $4::date
		 order by version desc, id desc
		 limit 1`,
		project.ID,
		country,
		startDate.Format("2006-01-02"),
		endDate.Format("2006-01-02"),
	).Scan(&adID)
	if errors.Is(err, pgx.ErrNoRows) {
		adID = 0
	} else if err != nil {
		return nil, err
	}

	missing := make([]string, 0, 3)
	if sourceMap["business_report"] == 0 {
		missing = append(missing, "business_report")
	}
	if adID == 0 {
		missing = append(missing, "ad_product_report")
	}
	if sourceMap["payment_report"] == 0 {
		missing = append(missing, "payment_report")
	}
	if len(missing) > 0 {
		return nil, productAnalysisBadRequest(fmt.Sprintf(
			"Missing source files for period %s-%s: %s",
			startDate.Format("2006-01-02"),
			endDate.Format("2006-01-02"),
			strings.Join(missing, ", "),
		))
	}

	payload, err := productAnalysisBuildPayloadForSources(
		ctx,
		db,
		project,
		country,
		startDate,
		endDate,
		[]int64{sourceMap["business_report"]},
		[]int64{adID},
		[]int64{sourceMap["payment_report"]},
	)
	if err != nil {
		return nil, err
	}
	pt1ID, version, rowCount, err := productAnalysisPersistPT1(
		ctx,
		db,
		project,
		country,
		startDate,
		endDate,
		payload,
	)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"pt1_id":                    pt1ID,
		"version":                   version,
		"report_start_date":         startDate.Format("2006-01-02"),
		"report_end_date":           endDate.Format("2006-01-02"),
		"row_count":                 rowCount,
		"business_report_source_id": sourceMap["business_report"],
		"ad_report_source_id":       adID,
		"payment_report_source_id":  sourceMap["payment_report"],
	}, nil
}

func productAnalysisFirstID(values []int64) int64 {
	if len(values) == 0 {
		return 0
	}
	return values[0]
}

func productAnalysisAttachCompleteness(
	payload *productAnalysisPT1Payload,
	completeness *product_analysis.PeriodCompleteness,
	isPartial bool,
) {
	if payload == nil || payload.Summary == nil || completeness == nil {
		return
	}
	payload.Summary["_completeness"] = completeness
	payload.Summary["_is_partial"] = isPartial
}

func productAnalysisListPeriodSources(
	ctx context.Context,
	db DB,
	projectID int64,
	country string,
	startDate *time.Time,
	endDate *time.Time,
	currentOnly bool,
) ([]productAnalysisPeriodSources, error) {
	complete, err := productAnalysisCompletePeriodSources(
		ctx,
		db,
		projectID,
		country,
		startDate,
		endDate,
		currentOnly,
	)
	if err != nil {
		return nil, err
	}
	periodsByKey := make(map[string]productAnalysisPeriodSources, len(complete))
	for _, item := range complete {
		periodsByKey[productAnalysisPeriodKey(item.Start, item.End)] = item
	}

	dailyBusiness, err := productAnalysisDailySourceMap(
		ctx,
		db,
		projectID,
		country,
		"business_report",
		startDate,
		endDate,
		currentOnly,
	)
	if err != nil {
		return nil, err
	}
	dailyAD, err := productAnalysisDailyADSourceMap(
		ctx,
		db,
		projectID,
		country,
		startDate,
		endDate,
	)
	if err != nil {
		return nil, err
	}
	knownDates := make([]time.Time, 0, len(dailyBusiness)+len(dailyAD))
	for _, value := range dailyBusiness {
		knownDates = append(knownDates, value.Start)
	}
	for _, value := range dailyAD {
		knownDates = append(knownDates, value.Start)
	}
	sort.Slice(knownDates, func(i, j int) bool {
		return knownDates[i].Before(knownDates[j])
	})
	knownDates = productAnalysisUniqueDates(knownDates)
	if len(knownDates) == 0 {
		return productAnalysisNonDailyPeriods(periodsByKey), nil
	}

	effectiveStart := knownDates[0]
	if startDate != nil {
		effectiveStart = *startDate
	}
	effectiveEnd := knownDates[len(knownDates)-1]
	if endDate != nil {
		effectiveEnd = *endDate
	}
	if effectiveStart.After(effectiveEnd) {
		return productAnalysisNonDailyPeriods(periodsByKey), nil
	}

	businessPeriodic, err := productAnalysisPeriodicSources(
		ctx,
		db,
		projectID,
		country,
		"business_report",
		startDate,
		endDate,
		currentOnly,
	)
	if err != nil {
		return nil, err
	}
	adPeriodic, err := productAnalysisPeriodicADSources(
		ctx,
		db,
		projectID,
		country,
		startDate,
		endDate,
	)
	if err != nil {
		return nil, err
	}
	paymentSources, err := productAnalysisPaymentSourceRefs(
		ctx,
		db,
		projectID,
		country,
		effectiveStart,
		effectiveEnd,
		currentOnly,
	)
	if err != nil {
		return nil, err
	}

	weekDates := map[string][]time.Time{}
	weekKeys := make([]string, 0)
	for current := effectiveStart; !current.After(effectiveEnd); current = current.AddDate(0, 0, 1) {
		year, week := current.ISOWeek()
		key := fmt.Sprintf("%04d-%02d", year, week)
		if _, exists := weekDates[key]; !exists {
			weekKeys = append(weekKeys, key)
		}
		weekDates[key] = append(weekDates[key], current)
	}
	sort.Strings(weekKeys)

	paymentDaily := map[string]productAnalysisPaymentSourceRef{}
	paymentEmptyDaily := map[string]productAnalysisPaymentSourceRef{}
	paymentPeriodic := make([]productAnalysisPaymentSourceRef, 0)
	paymentEmptyPeriodic := make([]productAnalysisPaymentSourceRef, 0)
	for _, source := range paymentSources {
		switch {
		case source.ReportDate != nil && source.RowCount > 0:
			if _, exists := paymentDaily[source.ReportDate.Format("2006-01-02")]; !exists {
				paymentDaily[source.ReportDate.Format("2006-01-02")] = source
			}
		case source.ReportDate != nil:
			if _, exists := paymentEmptyDaily[source.ReportDate.Format("2006-01-02")]; !exists {
				paymentEmptyDaily[source.ReportDate.Format("2006-01-02")] = source
			}
		case source.RowCount > 0:
			paymentPeriodic = append(paymentPeriodic, source)
		default:
			paymentEmptyPeriodic = append(paymentEmptyPeriodic, source)
		}
	}

	for _, weekKey := range weekKeys {
		dates := weekDates[weekKey]
		if len(dates) == 0 {
			continue
		}
		weekStart := dates[0]
		weekEnd := dates[len(dates)-1]

		businessIDs := make([]int64, 0)
		businessMissing := make([]string, 0)
		businessCovered := true
		if productAnalysisDatesAllPresent(dates, dailyBusiness) {
			for _, date := range dates {
				businessIDs = append(businessIDs, dailyBusiness[date.Format("2006-01-02")].ID)
			}
		} else if source, ok := productAnalysisCoveringSource(
			businessPeriodic,
			weekStart,
			weekEnd,
		); ok {
			businessIDs = append(businessIDs, source.ID)
		} else {
			businessCovered = false
			for _, date := range dates {
				key := date.Format("2006-01-02")
				if source, exists := dailyBusiness[key]; exists {
					businessIDs = append(businessIDs, source.ID)
				} else {
					businessMissing = append(businessMissing, key)
				}
			}
		}

		adIDs := make([]int64, 0)
		adMissing := make([]string, 0)
		adCovered := true
		if productAnalysisDatesAllPresent(dates, dailyAD) {
			for _, date := range dates {
				adIDs = append(adIDs, dailyAD[date.Format("2006-01-02")].ID)
			}
		} else if source, ok := productAnalysisCoveringSource(
			adPeriodic,
			weekStart,
			weekEnd,
		); ok {
			adIDs = append(adIDs, source.ID)
		} else {
			adCovered = false
			for _, date := range dates {
				key := date.Format("2006-01-02")
				if source, exists := dailyAD[key]; exists {
					adIDs = append(adIDs, source.ID)
				} else {
					adMissing = append(adMissing, key)
				}
			}
		}

		paymentIDs := make([]int64, 0)
		paymentCovered := false
		paymentType := "none"
		paymentMissingDates := make([]string, 0)
		paymentObjectiveEmptyDates := make([]string, 0)
		if productAnalysisPaymentDatesAllPresent(dates, paymentDaily) {
			for _, date := range dates {
				paymentIDs = append(paymentIDs, paymentDaily[date.Format("2006-01-02")].ID)
			}
			paymentCovered = true
			paymentType = "daily"
		} else if source, ok := productAnalysisCoveringPaymentSource(
			paymentPeriodic,
			weekStart,
			weekEnd,
		); ok {
			paymentIDs = append(paymentIDs, source.ID)
			paymentCovered = true
			paymentType = "period"
		} else if source, ok := productAnalysisCoveringPaymentSource(
			paymentEmptyPeriodic,
			weekStart,
			weekEnd,
		); ok {
			paymentIDs = append(paymentIDs, source.ID)
			paymentCovered = true
			paymentType = "empty"
			for _, date := range dates {
				paymentObjectiveEmptyDates = append(
					paymentObjectiveEmptyDates,
					date.Format("2006-01-02"),
				)
			}
		} else {
			partialIDs := make([]int64, 0)
			emptyIDs := make([]int64, 0)
			for _, date := range dates {
				key := date.Format("2006-01-02")
				if source, exists := paymentDaily[key]; exists {
					partialIDs = append(partialIDs, source.ID)
				} else if _, exists := paymentEmptyDaily[key]; !exists {
					paymentMissingDates = append(paymentMissingDates, key)
				}
			}
			for _, date := range dates {
				key := date.Format("2006-01-02")
				if _, real := paymentDaily[key]; real {
					continue
				}
				if source, exists := paymentEmptyDaily[key]; exists {
					emptyIDs = append(emptyIDs, source.ID)
					paymentObjectiveEmptyDates = append(
						paymentObjectiveEmptyDates,
						date.Format("2006-01-02"),
					)
				}
			}
			paymentIDs = productAnalysisUniqueIDs(append(partialIDs, emptyIDs...))
			switch {
			case len(paymentMissingDates) == 0 && len(paymentObjectiveEmptyDates) > 0:
				paymentCovered = true
				if len(partialIDs) > 0 {
					paymentType = "mixed"
				} else {
					paymentType = "empty"
				}
			case len(partialIDs) > 0:
				paymentType = "partial"
			}
		}

		if len(businessIDs) == 0 && len(adIDs) == 0 {
			continue
		}
		isPartial := !businessCovered || !adCovered || !paymentCovered
		completeness := &product_analysis.PeriodCompleteness{
			TotalDays:                  len(dates),
			AvailableBusinessDays:      len(businessIDs),
			AvailableAdDays:            len(adIDs),
			BusinessMissingDates:       businessMissing,
			ADMissingDates:             adMissing,
			PaymentCovered:             paymentCovered,
			PaymentType:                paymentType,
			PaymentMissing:             !paymentCovered,
			PaymentMissingDates:        productAnalysisPaymentMissingForType(paymentType, paymentMissingDates),
			PaymentObjectiveEmpty:      len(paymentObjectiveEmptyDates) > 0,
			PaymentObjectiveEmptyDates: paymentObjectiveEmptyDates,
		}
		periodsByKey[productAnalysisPeriodKey(weekStart, weekEnd)] = productAnalysisPeriodSources{
			Start:             weekStart,
			End:               weekEnd,
			BusinessSourceIDs: businessIDs,
			ADSourceIDs:       adIDs,
			PaymentSourceIDs:  paymentIDs,
			IsPartial:         isPartial,
			Completeness:      completeness,
		}
	}
	return productAnalysisNonDailyPeriods(periodsByKey), nil
}

func productAnalysisCompletePeriodSources(
	ctx context.Context,
	db DB,
	projectID int64,
	country string,
	startDate *time.Time,
	endDate *time.Time,
	currentOnly bool,
) ([]productAnalysisPeriodSources, error) {
	query := `select id, report_type, period_start_date, period_end_date
	          from public.analysis_source_files
	          where project_id = $1
	            and report_type in ('business_report', 'payment_report')
	            and country = $2
	            and period_start_date is not null
	            and period_end_date is not null`
	args := []any{projectID, country}
	placeholder := 3
	if currentOnly {
		query += ` and is_current is true`
	}
	if startDate != nil {
		query += fmt.Sprintf(` and period_end_date >= $%d::date`, placeholder)
		args = append(args, startDate.Format("2006-01-02"))
		placeholder++
	}
	if endDate != nil {
		query += fmt.Sprintf(` and period_start_date <= $%d::date`, placeholder)
		args = append(args, endDate.Format("2006-01-02"))
	}
	query += ` order by period_start_date asc, period_end_date asc,
	                   report_type asc, version desc, id desc`
	rows, err := db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	groups := map[string]map[string]productAnalysisSourceRef{}
	for rows.Next() {
		var (
			id         int64
			reportType string
			start      time.Time
			end        time.Time
		)
		if err := rows.Scan(&id, &reportType, &start, &end); err != nil {
			return nil, err
		}
		key := productAnalysisPeriodKey(start, end)
		if groups[key] == nil {
			groups[key] = map[string]productAnalysisSourceRef{}
		}
		if _, exists := groups[key][reportType]; !exists {
			groups[key][reportType] = productAnalysisSourceRef{
				ID:    id,
				Start: start,
				End:   end,
			}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()

	adQuery := `select f.id, f.period_start_date, f.period_end_date
	            from public.ad_upload_files f
	            where f.project_id = $1
	              and f.report_type = 'ad_promoted_product_report'
	              and f.country = $2
	              and exists (
	                select 1
	                from public.ad_upload_promoted_product_rows r
	                where r.source_file_id = f.id
	                  and r.scope_status = 'included_product'
	              )`
	adArgs := []any{projectID, country}
	adPlaceholder := 3
	if currentOnly {
		adQuery += ` and f.is_current is true`
	}
	if startDate != nil {
		adQuery += fmt.Sprintf(` and f.period_end_date >= $%d::date`, adPlaceholder)
		adArgs = append(adArgs, startDate.Format("2006-01-02"))
		adPlaceholder++
	}
	if endDate != nil {
		adQuery += fmt.Sprintf(` and f.period_start_date <= $%d::date`, adPlaceholder)
		adArgs = append(adArgs, endDate.Format("2006-01-02"))
	}
	adQuery += ` order by f.period_start_date asc, f.period_end_date asc,
	                    f.version desc, f.id desc`
	adRows, err := db.Query(ctx, adQuery, adArgs...)
	if err != nil {
		return nil, err
	}
	for adRows.Next() {
		var (
			id    int64
			start time.Time
			end   time.Time
		)
		if err := adRows.Scan(&id, &start, &end); err != nil {
			adRows.Close()
			return nil, err
		}
		key := productAnalysisPeriodKey(start, end)
		if groups[key] == nil {
			groups[key] = map[string]productAnalysisSourceRef{}
		}
		if _, exists := groups[key]["ad_product_report"]; !exists {
			groups[key]["ad_product_report"] = productAnalysisSourceRef{
				ID:    id,
				Start: start,
				End:   end,
			}
		}
	}
	if err := adRows.Err(); err != nil {
		adRows.Close()
		return nil, err
	}
	adRows.Close()

	keys := make([]string, 0, len(groups))
	for key := range groups {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]productAnalysisPeriodSources, 0, len(keys))
	for _, key := range keys {
		group := groups[key]
		business, hasBusiness := group["business_report"]
		ad, hasAD := group["ad_product_report"]
		payment, hasPayment := group["payment_report"]
		if !hasBusiness || !hasAD || !hasPayment {
			continue
		}
		totalDays := int(ad.End.Sub(ad.Start).Hours()/24) + 1
		result = append(result, productAnalysisPeriodSources{
			Start:             ad.Start,
			End:               ad.End,
			BusinessSourceIDs: []int64{business.ID},
			ADSourceIDs:       []int64{ad.ID},
			PaymentSourceIDs:  []int64{payment.ID},
			Completeness: &product_analysis.PeriodCompleteness{
				TotalDays:                  totalDays,
				AvailableBusinessDays:      totalDays,
				AvailableAdDays:            totalDays,
				BusinessMissingDates:       []string{},
				ADMissingDates:             []string{},
				PaymentCovered:             true,
				PaymentType:                "period",
				PaymentMissing:             false,
				PaymentMissingDates:        []string{},
				PaymentObjectiveEmpty:      false,
				PaymentObjectiveEmptyDates: []string{},
			},
		})
	}
	return result, nil
}

func productAnalysisDailySourceMap(
	ctx context.Context,
	db DB,
	projectID int64,
	country string,
	reportType string,
	startDate *time.Time,
	endDate *time.Time,
	currentOnly bool,
) (map[string]productAnalysisSourceRef, error) {
	query := `select id, report_date
	          from public.analysis_source_files
	          where project_id = $1
	            and report_type = $2
	            and country = $3
	            and report_date is not null`
	args := []any{projectID, reportType, country}
	placeholder := 4
	if currentOnly {
		query += ` and is_current is true`
	}
	if startDate != nil {
		query += fmt.Sprintf(` and report_date >= $%d::date`, placeholder)
		args = append(args, startDate.Format("2006-01-02"))
		placeholder++
	}
	if endDate != nil {
		query += fmt.Sprintf(` and report_date <= $%d::date`, placeholder)
		args = append(args, endDate.Format("2006-01-02"))
	}
	query += ` order by report_date asc, version desc, id desc`
	rows, err := db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[string]productAnalysisSourceRef{}
	for rows.Next() {
		var (
			id   int64
			date time.Time
		)
		if err := rows.Scan(&id, &date); err != nil {
			return nil, err
		}
		key := date.Format("2006-01-02")
		if _, exists := result[key]; !exists {
			result[key] = productAnalysisSourceRef{ID: id, Start: date, End: date}
		}
	}
	return result, rows.Err()
}

func productAnalysisDailyADSourceMap(
	ctx context.Context,
	db DB,
	projectID int64,
	country string,
	startDate *time.Time,
	endDate *time.Time,
) (map[string]productAnalysisSourceRef, error) {
	query := `select f.id, f.period_end_date
	          from public.ad_upload_files f
	          where f.project_id = $1
	            and f.report_type = 'ad_promoted_product_report'
	            and f.country = $2
	            and f.is_current is true
	            and f.period_start_date = f.period_end_date
	            and exists (
	              select 1
	              from public.ad_upload_promoted_product_rows r
	              where r.source_file_id = f.id
	                and r.scope_status = 'included_product'
	            )`
	args := []any{projectID, country}
	placeholder := 3
	if startDate != nil {
		query += fmt.Sprintf(` and f.period_end_date >= $%d::date`, placeholder)
		args = append(args, startDate.Format("2006-01-02"))
		placeholder++
	}
	if endDate != nil {
		query += fmt.Sprintf(` and f.period_end_date <= $%d::date`, placeholder)
		args = append(args, endDate.Format("2006-01-02"))
	}
	query += ` order by f.period_end_date asc, f.version desc, f.id desc`
	rows, err := db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[string]productAnalysisSourceRef{}
	for rows.Next() {
		var (
			id   int64
			date time.Time
		)
		if err := rows.Scan(&id, &date); err != nil {
			return nil, err
		}
		key := date.Format("2006-01-02")
		if _, exists := result[key]; !exists {
			result[key] = productAnalysisSourceRef{ID: id, Start: date, End: date}
		}
	}
	return result, rows.Err()
}

func productAnalysisPeriodicSources(
	ctx context.Context,
	db DB,
	projectID int64,
	country string,
	reportType string,
	startDate *time.Time,
	endDate *time.Time,
	currentOnly bool,
) ([]productAnalysisSourceRef, error) {
	query := `select id, period_start_date, period_end_date
	          from public.analysis_source_files
	          where project_id = $1
	            and report_type = $2
	            and country = $3
	            and report_date is null
	            and period_start_date is not null
	            and period_end_date is not null`
	args := []any{projectID, reportType, country}
	placeholder := 4
	if currentOnly {
		query += ` and is_current is true`
	}
	if startDate != nil {
		query += fmt.Sprintf(` and period_end_date >= $%d::date`, placeholder)
		args = append(args, startDate.Format("2006-01-02"))
		placeholder++
	}
	if endDate != nil {
		query += fmt.Sprintf(` and period_start_date <= $%d::date`, placeholder)
		args = append(args, endDate.Format("2006-01-02"))
	}
	query += ` order by period_start_date asc, period_end_date asc,
	                   version desc, id desc`
	return productAnalysisScanSourceRefs(ctx, db, query, args...)
}

func productAnalysisPeriodicADSources(
	ctx context.Context,
	db DB,
	projectID int64,
	country string,
	startDate *time.Time,
	endDate *time.Time,
) ([]productAnalysisSourceRef, error) {
	query := `select f.id, f.period_start_date, f.period_end_date
	          from public.ad_upload_files f
	          where f.project_id = $1
	            and f.report_type = 'ad_promoted_product_report'
	            and f.country = $2
	            and f.is_current is true
	            and f.period_start_date < f.period_end_date
	            and exists (
	              select 1
	              from public.ad_upload_promoted_product_rows r
	              where r.source_file_id = f.id
	                and r.scope_status = 'included_product'
	            )`
	args := []any{projectID, country}
	placeholder := 3
	if startDate != nil {
		query += fmt.Sprintf(` and f.period_end_date >= $%d::date`, placeholder)
		args = append(args, startDate.Format("2006-01-02"))
		placeholder++
	}
	if endDate != nil {
		query += fmt.Sprintf(` and f.period_start_date <= $%d::date`, placeholder)
		args = append(args, endDate.Format("2006-01-02"))
	}
	query += ` order by f.period_start_date asc, f.period_end_date asc,
	                   f.version desc, f.id desc`
	return productAnalysisScanSourceRefs(ctx, db, query, args...)
}

func productAnalysisScanSourceRefs(
	ctx context.Context,
	db DB,
	query string,
	args ...any,
) ([]productAnalysisSourceRef, error) {
	rows, err := db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]productAnalysisSourceRef, 0)
	for rows.Next() {
		var item productAnalysisSourceRef
		if err := rows.Scan(&item.ID, &item.Start, &item.End); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func productAnalysisPaymentSourceRefs(
	ctx context.Context,
	db DB,
	projectID int64,
	country string,
	effectiveStart time.Time,
	effectiveEnd time.Time,
	currentOnly bool,
) ([]productAnalysisPaymentSourceRef, error) {
	query := `select id, report_date, period_start_date, period_end_date,
	                 row_count_total
	          from public.analysis_source_files
	          where project_id = $1
	            and report_type = 'payment_report'
	            and country = $2
	            and (
	              (report_date is not null
	               and report_date >= $3::date
	               and report_date <= $4::date)
	              or
	              (report_date is null
	               and period_start_date <= $4::date
	               and period_end_date >= $3::date)
	            )`
	args := []any{
		projectID,
		country,
		effectiveStart.Format("2006-01-02"),
		effectiveEnd.Format("2006-01-02"),
	}
	if currentOnly {
		query += ` and is_current is true`
	}
	query += ` order by report_date asc nulls last,
	                   period_start_date asc nulls last,
	                   version desc, id desc`
	rows, err := db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]productAnalysisPaymentSourceRef, 0)
	for rows.Next() {
		var item productAnalysisPaymentSourceRef
		if err := rows.Scan(
			&item.ID,
			&item.ReportDate,
			&item.Start,
			&item.End,
			&item.RowCount,
		); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func productAnalysisDatesAllPresent(
	dates []time.Time,
	sources map[string]productAnalysisSourceRef,
) bool {
	for _, date := range dates {
		if _, exists := sources[date.Format("2006-01-02")]; !exists {
			return false
		}
	}
	return true
}

func productAnalysisPaymentDatesAllPresent(
	dates []time.Time,
	sources map[string]productAnalysisPaymentSourceRef,
) bool {
	for _, date := range dates {
		if _, exists := sources[date.Format("2006-01-02")]; !exists {
			return false
		}
	}
	return true
}

func productAnalysisCoveringSource(
	sources []productAnalysisSourceRef,
	start time.Time,
	end time.Time,
) (productAnalysisSourceRef, bool) {
	for _, source := range sources {
		if !source.Start.After(start) && !source.End.Before(end) {
			return source, true
		}
	}
	return productAnalysisSourceRef{}, false
}

func productAnalysisCoveringPaymentSource(
	sources []productAnalysisPaymentSourceRef,
	start time.Time,
	end time.Time,
) (productAnalysisPaymentSourceRef, bool) {
	for _, source := range sources {
		if source.Start == nil || source.End == nil {
			continue
		}
		if !source.Start.After(start) && !source.End.Before(end) {
			return source, true
		}
	}
	return productAnalysisPaymentSourceRef{}, false
}

func productAnalysisUniqueDates(values []time.Time) []time.Time {
	result := make([]time.Time, 0, len(values))
	for _, value := range values {
		key := value.Format("2006-01-02")
		exists := false
		for _, existing := range result {
			if existing.Format("2006-01-02") == key {
				exists = true
				break
			}
		}
		if !exists {
			result = append(result, value)
		}
	}
	return result
}

func productAnalysisUniqueIDs(values []int64) []int64 {
	seen := make(map[int64]bool, len(values))
	result := make([]int64, 0, len(values))
	for _, value := range values {
		if value == 0 || seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	return result
}

func productAnalysisPaymentMissingForType(
	paymentType string,
	missing []string,
) []string {
	if paymentType == "partial" || paymentType == "none" {
		return missing
	}
	return []string{}
}

func productAnalysisNonDailyPeriods(
	periods map[string]productAnalysisPeriodSources,
) []productAnalysisPeriodSources {
	keys := make([]string, 0, len(periods))
	for key, period := range periods {
		if period.Start.Equal(period.End) {
			continue
		}
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]productAnalysisPeriodSources, 0, len(keys))
	for _, key := range keys {
		result = append(result, periods[key])
	}
	return result
}

func productAnalysisPeriodKey(start time.Time, end time.Time) string {
	return start.Format("2006-01-02") + ":" + end.Format("2006-01-02")
}

type productAnalysisPT1Payload struct {
	RowCount int
	Summary  map[string]any
	Details  []map[string]any
}

type productAnalysisCost struct {
	SKU      string
	ASIN     string
	FOB      float64
	FirstLeg float64
}

type productAnalysisBusinessTotals struct {
	PageViews    int
	UnitsOrdered int
	Sessions     int
	SalesAmount  float64
}

type productAnalysisADTotals struct {
	Impressions int
	Clicks      int
	Orders      int
	Spend       float64
	Sales       float64
}

type productAnalysisPaymentTotals struct {
	ActualSalesUnits  int
	ActualSales       float64
	ActualRefundUnits int
	ActualRefund      float64
	Commission        float64
	FBAFees           float64
}

func productAnalysisBuildPayloadForSources(
	ctx context.Context,
	db DB,
	project productAnalysisEngineProject,
	country string,
	startDate time.Time,
	endDate time.Time,
	businessSourceIDs []int64,
	adSourceIDs []int64,
	paymentSourceIDs []int64,
) (*productAnalysisPT1Payload, error) {
	costs, err := productAnalysisLoadCosts(
		ctx,
		db,
		project,
		country,
		endDate.Format("2006-01"),
		false,
	)
	if err != nil {
		return nil, err
	}
	business, err := productAnalysisLoadBusinessTotals(ctx, db, businessSourceIDs)
	if err != nil {
		return nil, err
	}
	ads, err := productAnalysisLoadADTotals(ctx, db, adSourceIDs)
	if err != nil {
		return nil, err
	}
	payments, err := productAnalysisLoadPaymentTotals(ctx, db, paymentSourceIDs)
	if err != nil {
		return nil, err
	}
	return productAnalysisBuildOverview(
		startDate,
		endDate,
		costs,
		business,
		ads,
		payments,
	), nil
}

func productAnalysisPreviewFromFiles(
	ctx context.Context,
	db DB,
	project productAnalysisEngineProject,
	country string,
	startDate time.Time,
	endDate time.Time,
	businessPath string,
	paymentPath string,
	adPath string,
) (*product_analysis.RunResponse, error) {
	costs, err := productAnalysisLoadCosts(
		ctx,
		db,
		project,
		country,
		endDate.Format("2006-01"),
		true,
	)
	if err != nil {
		return nil, err
	}
	business, err := productAnalysisParseBusinessFile(businessPath)
	if err != nil {
		return nil, err
	}
	payments, err := productAnalysisParsePaymentFile(paymentPath, country)
	if err != nil {
		return nil, err
	}
	known, err := productAnalysisLoadIdentifiers(ctx, db, project.ID, country)
	if err != nil {
		return nil, err
	}
	ads, err := productAnalysisParseADFile(adPath, country, known)
	if err != nil {
		return nil, err
	}
	payload := productAnalysisBuildOverview(
		startDate,
		endDate,
		costs,
		business,
		ads,
		payments,
	)
	period := product_analysis.CalculationPeriod{
		ReportStartDate: startDate.Format("2006-01-02"),
		ReportEndDate:   endDate.Format("2006-01-02"),
		Summary:         payload.Summary,
		Details:         payload.Details,
		IsPartial:       false,
		Completeness:    nil,
		Persisted:       false,
	}
	return &product_analysis.RunResponse{
		ProjectID:    project.ID,
		ProjectName:  project.Name,
		Country:      country,
		TotalPeriods: 1,
		Periods:      []product_analysis.CalculationPeriod{period},
	}, nil
}

func productAnalysisLoadCosts(
	ctx context.Context,
	db DB,
	project productAnalysisEngineProject,
	country string,
	yearMonth string,
	allowMissing bool,
) ([]productAnalysisCost, error) {
	rows, err := db.Query(
		ctx,
		`select sku, asin, fob_unit_cost::text, first_leg_cost_rmb::text
		 from public.product_costs
		 where project_id = $1
		   and country = $2
		   and is_active is true
		 order by sort_order asc, id asc`,
		project.ID,
		country,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type rawCost struct {
		item     productAnalysisCost
		fobRaw   float64
		firstRaw float64
	}
	rawCosts := make([]rawCost, 0)
	for rows.Next() {
		var (
			item     productAnalysisCost
			fobRaw   string
			firstRaw string
		)
		if err := rows.Scan(&item.SKU, &item.ASIN, &fobRaw, &firstRaw); err != nil {
			return nil, err
		}
		fob, _ := strconv.ParseFloat(strings.TrimSpace(fobRaw), 64)
		firstLeg, _ := strconv.ParseFloat(strings.TrimSpace(firstRaw), 64)
		rawCosts = append(rawCosts, rawCost{
			item:     item,
			fobRaw:   fob,
			firstRaw: firstLeg,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	result := make([]productAnalysisCost, 0, len(rawCosts))
	for _, raw := range rawCosts {
		item := raw.item
		convertedFOB, err := productAnalysisConvertRMB(
			ctx,
			db,
			raw.fobRaw,
			country,
			yearMonth,
		)
		if err != nil {
			return nil, err
		}
		convertedFirstLeg, err := productAnalysisConvertRMB(
			ctx,
			db,
			raw.firstRaw,
			country,
			yearMonth,
		)
		if err != nil {
			return nil, err
		}
		item.FOB = convertedFOB
		item.FirstLeg = convertedFirstLeg
		result = append(result, item)
	}
	if len(result) == 0 && !allowMissing {
		return nil, productAnalysisBadRequest(fmt.Sprintf(
			"No active product_costs found for project_name=%s, country=%s",
			project.Name,
			country,
		))
	}
	return result, nil
}

func productAnalysisConvertRMB(
	ctx context.Context,
	db DB,
	amountRMB float64,
	country string,
	yearMonth string,
) (float64, error) {
	currency := "USD"
	switch strings.ToUpper(strings.TrimSpace(country)) {
	case "DE":
		currency = "EUR"
	case "UK":
		currency = "GBP"
	case "US":
		currency = "USD"
	}
	rate, err := productAnalysisExchangeRate(ctx, db, currency, yearMonth)
	if err != nil {
		return 0, err
	}
	if rate <= 0 {
		return 0, productAnalysisUnprocessable(
			fmt.Sprintf("%s exchange rate for %s is invalid", currency, yearMonth),
		)
	}
	return productAnalysisRound2(amountRMB / rate), nil
}

func productAnalysisExchangeRate(
	ctx context.Context,
	db DB,
	currency string,
	yearMonth string,
) (float64, error) {
	queries := []struct {
		sql  string
		args []any
	}{
		{
			sql: `select rate::text from public.exchange_rates
			      where currency = $1 and year_month = $2
			      order by id desc limit 1`,
			args: []any{currency, yearMonth},
		},
		{
			sql: `select rate::text from public.exchange_rates
			      where currency = $1 and year_month <= $2
			      order by year_month desc, id desc limit 1`,
			args: []any{currency, yearMonth},
		},
		{
			sql: `select rate::text from public.exchange_rates
			      where currency = $1
			      order by year_month desc, id desc limit 1`,
			args: []any{currency},
		},
	}
	for _, query := range queries {
		var raw string
		err := db.QueryRow(ctx, query.sql, query.args...).Scan(&raw)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return 0, err
		}
		value, parseErr := strconv.ParseFloat(strings.TrimSpace(raw), 64)
		if parseErr != nil {
			return 0, parseErr
		}
		return value, nil
	}
	return 0, productAnalysisUnprocessable(fmt.Sprintf(
		"%s exchange rate for %s not found",
		currency,
		yearMonth,
	))
}

func productAnalysisLoadBusinessTotals(
	ctx context.Context,
	db DB,
	sourceIDs []int64,
) (map[string]productAnalysisBusinessTotals, error) {
	result := map[string]productAnalysisBusinessTotals{}
	if len(sourceIDs) == 0 {
		return result, nil
	}
	rows, err := db.Query(
		ctx,
		`select coalesce(asin, ''),
		        coalesce(sum(page_views), 0)::bigint,
		        coalesce(sum(units_ordered), 0)::bigint,
		        coalesce(sum(sessions), 0)::bigint,
		        coalesce(sum(ordered_sales_amount), 0)::text
		 from public.analysis_business_rows
		 where source_file_id = any($1)
		 group by coalesce(asin, '')
		 order by coalesce(asin, '') asc`,
		sourceIDs,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			asin      string
			pageViews int64
			units     int64
			sessions  int64
			salesRaw  string
		)
		if err := rows.Scan(&asin, &pageViews, &units, &sessions, &salesRaw); err != nil {
			return nil, err
		}
		sales, _ := strconv.ParseFloat(strings.TrimSpace(salesRaw), 64)
		result[asin] = productAnalysisBusinessTotals{
			PageViews:    int(pageViews),
			UnitsOrdered: int(units),
			Sessions:     int(sessions),
			SalesAmount:  sales,
		}
	}
	return result, rows.Err()
}

func productAnalysisLoadADTotals(
	ctx context.Context,
	db DB,
	sourceIDs []int64,
) (map[string]productAnalysisADTotals, error) {
	result := map[string]productAnalysisADTotals{}
	if len(sourceIDs) == 0 {
		return result, nil
	}
	rows, err := db.Query(
		ctx,
		`select coalesce(ad_sku, ''),
		        coalesce(sum(impressions), 0)::bigint,
		        coalesce(sum(clicks), 0)::bigint,
		        coalesce(sum(orders_7d), 0)::bigint,
		        coalesce(sum(spend), 0)::text,
		        coalesce(sum(sales_7d), 0)::text
		 from public.ad_upload_promoted_product_rows
		 where source_file_id = any($1)
		   and scope_status = 'included_product'
		 group by coalesce(ad_sku, '')
		 order by coalesce(ad_sku, '') asc`,
		sourceIDs,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			sku         string
			impressions int64
			clicks      int64
			orders      int64
			spendRaw    string
			salesRaw    string
		)
		if err := rows.Scan(
			&sku,
			&impressions,
			&clicks,
			&orders,
			&spendRaw,
			&salesRaw,
		); err != nil {
			return nil, err
		}
		spend, _ := strconv.ParseFloat(strings.TrimSpace(spendRaw), 64)
		sales, _ := strconv.ParseFloat(strings.TrimSpace(salesRaw), 64)
		result[sku] = productAnalysisADTotals{
			Impressions: int(impressions),
			Clicks:      int(clicks),
			Orders:      int(orders),
			Spend:       spend,
			Sales:       sales,
		}
	}
	return result, rows.Err()
}

type productAnalysisPaymentAccumulator struct {
	HasOrder          bool
	SalesUnits        int
	ProductSales      float64
	ShippingCredits   float64
	PromotionalRebate float64
	RefundUnits       int
	RefundProduct     float64
	RefundShipping    float64
	RefundPromotional float64
	RefundOther       float64
	SellingFees       float64
	FBAFees           float64
}

func productAnalysisLoadPaymentTotals(
	ctx context.Context,
	db DB,
	sourceIDs []int64,
) (map[string]productAnalysisPaymentTotals, error) {
	result := map[string]productAnalysisPaymentTotals{}
	if len(sourceIDs) == 0 {
		return result, nil
	}
	rows, err := db.Query(
		ctx,
		`select transaction_type, coalesce(sku, ''), quantity,
		        product_sales::text, shipping_credits::text,
		        promotional_rebates::text, other_amount::text,
		        selling_fees::text, fba_fees::text
		 from public.analysis_payment_rows
		 where source_file_id = any($1)
		 order by source_file_id asc, source_row_no asc`,
		sourceIDs,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	accumulators := map[string]*productAnalysisPaymentAccumulator{}
	for rows.Next() {
		var (
			transactionType string
			sku             string
			quantity        int
			productSalesRaw string
			shippingRaw     string
			promotionalRaw  string
			otherRaw        string
			sellingFeesRaw  string
			fbaFeesRaw      string
		)
		if err := rows.Scan(
			&transactionType,
			&sku,
			&quantity,
			&productSalesRaw,
			&shippingRaw,
			&promotionalRaw,
			&otherRaw,
			&sellingFeesRaw,
			&fbaFeesRaw,
		); err != nil {
			return nil, err
		}
		acc := accumulators[sku]
		if acc == nil {
			acc = &productAnalysisPaymentAccumulator{}
			accumulators[sku] = acc
		}
		productSales, _ := strconv.ParseFloat(strings.TrimSpace(productSalesRaw), 64)
		shipping, _ := strconv.ParseFloat(strings.TrimSpace(shippingRaw), 64)
		promotional, _ := strconv.ParseFloat(strings.TrimSpace(promotionalRaw), 64)
		other, _ := strconv.ParseFloat(strings.TrimSpace(otherRaw), 64)
		sellingFees, _ := strconv.ParseFloat(strings.TrimSpace(sellingFeesRaw), 64)
		fbaFees, _ := strconv.ParseFloat(strings.TrimSpace(fbaFeesRaw), 64)
		switch productAnalysisPaymentType(transactionType) {
		case "order":
			acc.HasOrder = true
			acc.SalesUnits += quantity
			acc.ProductSales += productSales
			acc.ShippingCredits += shipping
			acc.PromotionalRebate += promotional
			acc.SellingFees += sellingFees
			acc.FBAFees += fbaFees
		case "refund":
			acc.RefundUnits += quantity
			acc.RefundProduct += productSales
			acc.RefundShipping += shipping
			acc.RefundPromotional += promotional
			acc.RefundOther += other
			acc.SellingFees += sellingFees
			acc.FBAFees += fbaFees
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for sku, acc := range accumulators {
		if !acc.HasOrder {
			continue
		}
		refundUnits := acc.RefundUnits
		if refundUnits < 0 {
			refundUnits = -refundUnits
		}
		result[sku] = productAnalysisPaymentTotals{
			ActualSalesUnits:  acc.SalesUnits,
			ActualSales:       productAnalysisRound2(acc.ProductSales + acc.ShippingCredits + acc.PromotionalRebate),
			ActualRefundUnits: refundUnits,
			ActualRefund: productAnalysisRound2(math.Abs(
				acc.RefundProduct +
					acc.RefundShipping +
					acc.RefundPromotional +
					acc.RefundOther,
			)),
			Commission: productAnalysisRound2(-acc.SellingFees),
			FBAFees:    productAnalysisRound2(-acc.FBAFees),
		}
	}
	return result, nil
}

func productAnalysisPaymentType(raw string) string {
	normalized := strings.ToLower(strings.TrimSpace(raw))
	switch normalized {
	case "order", "bestellung":
		return "order"
	case "refund", "erstattung":
		return "refund"
	default:
		return ""
	}
}

func productAnalysisBuildOverview(
	startDate time.Time,
	endDate time.Time,
	costs []productAnalysisCost,
	business map[string]productAnalysisBusinessTotals,
	ads map[string]productAnalysisADTotals,
	payments map[string]productAnalysisPaymentTotals,
) *productAnalysisPT1Payload {
	reportDate := startDate.Format("20060102") + "-" + endDate.Format("0102")
	details := make([]map[string]any, 0, len(costs))
	sums := map[string]float64{}
	sumColumns := map[string]bool{
		"总销量": true, "总销售额": true, "页面浏览量": true, "总访客": true,
		"广告展示量": true, "广告点击量": true, "广告订单量": true,
		"广告花费": true, "广告销售额": true, "自然流量": true,
		"自然单": true, "产品FOB": true, "实际销售额": true,
		"实际销售量": true, "实际退款额": true, "实际退款量": true,
		"销售头程": true, "FBA配送费": true, "平台佣金": true,
		"总成本": true, "利润": true,
	}
	for _, cost := range costs {
		businessRow := business[cost.ASIN]
		adRow := ads[cost.SKU]
		paymentRow := payments[cost.SKU]

		totalConversion := productAnalysisSafeDiv(
			float64(businessRow.UnitsOrdered),
			float64(businessRow.PageViews),
		)
		adClickRate := productAnalysisSafeDiv(
			float64(adRow.Clicks),
			float64(adRow.Impressions),
		)
		adOrderShare := productAnalysisSafeDiv(
			float64(adRow.Orders),
			float64(businessRow.UnitsOrdered),
		)
		adConversion := productAnalysisSafeDiv(
			float64(adRow.Orders),
			float64(adRow.Clicks),
		)
		cpc := productAnalysisSafeDiv(adRow.Spend, float64(adRow.Clicks))
		acos := productAnalysisSafeDiv(adRow.Spend, adRow.Sales)
		spShare := productAnalysisSafeDiv(adRow.Spend, businessRow.SalesAmount)
		naturalTraffic := businessRow.PageViews - adRow.Clicks
		naturalTrafficShare := productAnalysisSafeDiv(
			float64(naturalTraffic),
			float64(businessRow.PageViews),
		)
		naturalOrders := businessRow.UnitsOrdered - adRow.Orders
		naturalConversion := productAnalysisSafeDiv(
			float64(naturalOrders),
			float64(naturalTraffic),
		)
		productFOB := float64(paymentRow.ActualSalesUnits) * cost.FOB
		salesFirstLeg := float64(paymentRow.ActualSalesUnits) * cost.FirstLeg
		productFOBCostShare := productAnalysisSafeDiv(productFOB, paymentRow.ActualSales)
		firstLegCostShare := productAnalysisSafeDiv(salesFirstLeg, paymentRow.ActualSales)
		deliveryCostShare := productAnalysisSafeDiv(paymentRow.FBAFees, paymentRow.ActualSales)
		commissionCostShare := productAnalysisSafeDiv(paymentRow.Commission, paymentRow.ActualSales)
		totalCost := productFOB + salesFirstLeg + paymentRow.FBAFees + paymentRow.Commission
		totalCostShare := productAnalysisSafeDiv(totalCost, paymentRow.ActualSales)
		profit := paymentRow.ActualSales - totalCost - adRow.Spend - paymentRow.ActualRefund
		profitRate := productAnalysisSafeDiv(profit, paymentRow.ActualSales)
		averagePrice := productAnalysisSafeDiv(
			paymentRow.ActualSales,
			float64(paymentRow.ActualSalesUnits),
		)
		refundRate := productAnalysisSafeDiv(paymentRow.ActualRefund, paymentRow.ActualSales)

		row := map[string]any{
			"日期":     reportDate,
			"SKU":    cost.SKU,
			"ASIN":   cost.ASIN,
			"总销量":    businessRow.UnitsOrdered,
			"总销售额":   businessRow.SalesAmount,
			"页面浏览量":  businessRow.PageViews,
			"总访客":    businessRow.Sessions,
			"总转化":    totalConversion,
			"广告展示量":  adRow.Impressions,
			"广告点击量":  adRow.Clicks,
			"广告点击率":  adClickRate,
			"广告订单量":  adRow.Orders,
			"广告单占比":  adOrderShare,
			"广告转化率":  adConversion,
			"广告花费":   adRow.Spend,
			"广告销售额":  adRow.Sales,
			"CPC":    cpc,
			"ACOS":   acos,
			"SP占比":   spShare,
			"自然流量":   naturalTraffic,
			"自然流量占比": naturalTrafficShare,
			"自然单":    naturalOrders,
			"自然单转化":  naturalConversion,
			"产品FOB":  productFOB,
			"成本占比":   productFOBCostShare,
			"销售头程":   salesFirstLeg,
			"头程占比":   firstLegCostShare,
			"FBA配送费": paymentRow.FBAFees,
			"配送费占比":  deliveryCostShare,
			"平台佣金":   paymentRow.Commission,
			"佣金占比":   commissionCostShare,
			"总成本":    totalCost,
			"总成本占比":  totalCostShare,
			"利润":     profit,
			"利润率":    profitRate,
			"实际销售额":  paymentRow.ActualSales,
			"实际销售量":  paymentRow.ActualSalesUnits,
			"实际退款额":  paymentRow.ActualRefund,
			"实际退款量":  paymentRow.ActualRefundUnits,
			"平均售价":   averagePrice,
			"退款率":    refundRate,
		}
		productAnalysisRoundOverviewMoney(row)
		details = append(details, row)
		if sumColumns["总销量"] {
			sums["总销量"] += float64(businessRow.UnitsOrdered)
			sums["总销售额"] += businessRow.SalesAmount
			sums["页面浏览量"] += float64(businessRow.PageViews)
			sums["总访客"] += float64(businessRow.Sessions)
			sums["广告展示量"] += float64(adRow.Impressions)
			sums["广告点击量"] += float64(adRow.Clicks)
			sums["广告订单量"] += float64(adRow.Orders)
			sums["广告花费"] += adRow.Spend
			sums["广告销售额"] += adRow.Sales
			sums["自然流量"] += float64(naturalTraffic)
			sums["自然单"] += float64(naturalOrders)
			sums["产品FOB"] += productFOB
			sums["实际销售额"] += paymentRow.ActualSales
			sums["实际销售量"] += float64(paymentRow.ActualSalesUnits)
			sums["实际退款额"] += paymentRow.ActualRefund
			sums["实际退款量"] += float64(paymentRow.ActualRefundUnits)
			sums["销售头程"] += salesFirstLeg
			sums["FBA配送费"] += paymentRow.FBAFees
			sums["平台佣金"] += paymentRow.Commission
			sums["总成本"] += totalCost
			sums["利润"] += profit
		}
	}
	summary := productAnalysisSummaryFromSums(reportDate, sums)
	return &productAnalysisPT1Payload{
		RowCount: len(details),
		Summary:  summary,
		Details:  details,
	}
}

func productAnalysisSummaryFromSums(
	reportDate string,
	sums map[string]float64,
) map[string]any {
	summary := map[string]any{
		"日期":   reportDate,
		"SKU":  "汇总",
		"ASIN": "汇总",
	}
	columns := []string{
		"总销量", "总销售额", "页面浏览量", "总访客", "总转化",
		"广告展示量", "广告点击量", "广告点击率", "广告订单量",
		"广告单占比", "广告转化率", "广告花费", "广告销售额",
		"CPC", "ACOS", "SP占比", "自然流量", "自然流量占比",
		"自然单", "自然单转化", "产品FOB", "成本占比", "销售头程",
		"头程占比", "FBA配送费", "配送费占比", "平台佣金", "佣金占比",
		"总成本", "总成本占比", "利润", "利润率", "实际销售额",
		"实际销售量", "实际退款额", "实际退款量", "平均售价", "退款率",
	}
	for _, column := range columns {
		summary[column] = sums[column]
	}
	summary["自然流量"] = sums["页面浏览量"] - sums["广告点击量"]
	summary["自然单"] = sums["总销量"] - sums["广告订单量"]
	summary["总转化"] = productAnalysisSafeDiv(sums["总销量"], sums["页面浏览量"])
	summary["广告点击率"] = productAnalysisSafeDiv(sums["广告点击量"], sums["广告展示量"])
	summary["广告单占比"] = productAnalysisSafeDiv(sums["广告订单量"], sums["总销量"])
	summary["广告转化率"] = productAnalysisSafeDiv(sums["广告订单量"], sums["广告点击量"])
	summary["CPC"] = productAnalysisSafeDiv(sums["广告花费"], sums["广告点击量"])
	summary["ACOS"] = productAnalysisSafeDiv(sums["广告花费"], sums["广告销售额"])
	summary["SP占比"] = productAnalysisSafeDiv(sums["广告花费"], sums["总销售额"])
	summary["自然流量占比"] = productAnalysisSafeDiv(
		productAnalysisAnyFloat(summary["自然流量"]),
		sums["页面浏览量"],
	)
	summary["自然单转化"] = productAnalysisSafeDiv(
		productAnalysisAnyFloat(summary["自然单"]),
		productAnalysisAnyFloat(summary["自然流量"]),
	)
	summary["成本占比"] = productAnalysisSafeDiv(sums["产品FOB"], sums["实际销售额"])
	summary["头程占比"] = productAnalysisSafeDiv(sums["销售头程"], sums["实际销售额"])
	summary["配送费占比"] = productAnalysisSafeDiv(sums["FBA配送费"], sums["实际销售额"])
	summary["佣金占比"] = productAnalysisSafeDiv(sums["平台佣金"], sums["实际销售额"])
	summary["总成本占比"] = productAnalysisSafeDiv(sums["总成本"], sums["实际销售额"])
	summary["利润率"] = productAnalysisSafeDiv(sums["利润"], sums["实际销售额"])
	summary["退款率"] = productAnalysisSafeDiv(sums["实际退款额"], sums["实际销售额"])
	summary["平均售价"] = productAnalysisSafeDiv(sums["实际销售额"], sums["实际销售量"])
	productAnalysisRoundOverviewMoney(summary)
	return summary
}

func productAnalysisRoundOverviewMoney(row map[string]any) {
	for _, key := range []string{
		"总销售额", "广告花费", "广告销售额", "CPC", "产品FOB",
		"销售头程", "FBA配送费", "平台佣金", "总成本", "利润",
		"实际销售额", "实际退款额", "平均售价",
	} {
		if value, ok := row[key].(float64); ok {
			row[key] = productAnalysisRound2(value)
		}
	}
}

func productAnalysisSafeDiv(numerator float64, denominator float64) float64 {
	if denominator == 0 {
		return 0
	}
	return numerator / denominator
}

func productAnalysisRound2(value float64) float64 {
	return math.Round((value+1e-12)*100) / 100
}

func productAnalysisAnyFloat(value any) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case float32:
		return float64(typed)
	case int:
		return float64(typed)
	case int64:
		return float64(typed)
	default:
		return 0
	}
}

func productAnalysisParseBusinessFile(
	path string,
) (map[string]productAnalysisBusinessTotals, error) {
	table, err := productAnalysisReadTableFile(path, ',')
	if err != nil {
		return nil, productAnalysisBadRequest("Business report parse failed: " + err.Error())
	}
	if err := productAnalysisValidateBusinessHeaders(table.Headers); err != nil {
		return nil, err
	}
	rows := parseBusinessRows(table, table.Headers)
	productAnalysisCorrectBusinessRows(table, rows)
	result := make(map[string]productAnalysisBusinessTotals, len(rows))
	for _, row := range rows {
		asin := ""
		if row.ASIN != nil {
			asin = strings.TrimSpace(*row.ASIN)
		}
		totals := result[asin]
		totals.PageViews += row.PageViews
		totals.UnitsOrdered += row.UnitsOrdered
		totals.Sessions += row.Sessions
		totals.SalesAmount += row.OrderedSalesAmount
		result[asin] = totals
	}
	return result, nil
}

func productAnalysisValidateBusinessHeaders(headers []string) error {
	required := [][]string{
		{"（子）ASIN", "(子)ASIN", "子ASIN", "ASIN", "(Child) ASIN", "(Parent) ASIN"},
		{"页面浏览量 - 总计", "页面浏览量-总计", "Page Views - Total"},
		{"已订购商品数量", "Ordered Product Sales Units", "Units Ordered"},
		{"会话数 - 总计", "会话数-总计", "Sessions - Total"},
		{"已订购商品销售额", "Ordered Product Sales", "Ordered Product Sales Amount"},
	}
	missing := make([]string, 0)
	for _, candidates := range required {
		if findCaseInsensitive(headers, candidates) < 0 {
			missing = append(missing, candidates[0])
		}
	}
	if len(missing) > 0 {
		return productAnalysisBadRequest(
			"Business report missing required columns: " + strings.Join(missing, ", "),
		)
	}
	return nil
}

func productAnalysisParsePaymentFile(
	path string,
	country string,
) (map[string]productAnalysisPaymentTotals, error) {
	var (
		table tableData
		err   error
	)
	if strings.EqualFold(filepath.Ext(path), ".xlsx") {
		table, err = parseUploadXLSXTable(path)
	} else {
		table, err = readPaymentTable(path, country)
	}
	if err != nil {
		return nil, productAnalysisBadRequest("Payment report parse failed: " + err.Error())
	}
	headers := normalizedHeaders(table.Headers)
	if !paymentHeaderMatches(headers) {
		return nil, productAnalysisBadRequest("Payment report header row not found")
	}
	rows := parsePaymentRows(table, headers)
	productAnalysisCorrectPaymentRows(table, rows, country)
	accumulators := map[string]*productAnalysisPaymentAccumulator{}
	for _, row := range rows {
		sku := ""
		if row.SKU != nil {
			sku = strings.TrimSpace(*row.SKU)
		}
		acc := accumulators[sku]
		if acc == nil {
			acc = &productAnalysisPaymentAccumulator{}
			accumulators[sku] = acc
		}
		switch productAnalysisPaymentType(row.TransactionType) {
		case "order":
			acc.HasOrder = true
			acc.SalesUnits += row.Quantity
			acc.ProductSales += row.ProductSales
			acc.ShippingCredits += row.ShippingCredits
			acc.PromotionalRebate += row.PromotionalRebates
			acc.SellingFees += row.SellingFees
			acc.FBAFees += row.FBAFees
		case "refund":
			acc.RefundUnits += row.Quantity
			acc.RefundProduct += row.ProductSales
			acc.RefundShipping += row.ShippingCredits
			acc.RefundPromotional += row.PromotionalRebates
			acc.RefundOther += row.OtherAmount
			acc.SellingFees += row.SellingFees
			acc.FBAFees += row.FBAFees
		}
	}
	result := make(map[string]productAnalysisPaymentTotals, len(accumulators))
	for sku, acc := range accumulators {
		if !acc.HasOrder {
			continue
		}
		refundUnits := acc.RefundUnits
		if refundUnits < 0 {
			refundUnits = -refundUnits
		}
		result[sku] = productAnalysisPaymentTotals{
			ActualSalesUnits:  acc.SalesUnits,
			ActualSales:       productAnalysisRound2(acc.ProductSales + acc.ShippingCredits + acc.PromotionalRebate),
			ActualRefundUnits: refundUnits,
			ActualRefund: productAnalysisRound2(math.Abs(
				acc.RefundProduct +
					acc.RefundShipping +
					acc.RefundPromotional +
					acc.RefundOther,
			)),
			Commission: productAnalysisRound2(-acc.SellingFees),
			FBAFees:    productAnalysisRound2(-acc.FBAFees),
		}
	}
	return result, nil
}

func productAnalysisParseADFile(
	path string,
	country string,
	known identifierSet,
) (map[string]productAnalysisADTotals, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, productAnalysisBadRequest("Ad report parse failed: " + err.Error())
	}
	parsed, err := parseAdUploadData(filepath.Base(path), raw, country)
	if err != nil {
		return nil, productAnalysisBadRequest("Ad report parse failed: " + err.Error())
	}
	if parsed.match.spec.reportType != "ad_promoted_product_report" {
		return nil, productAnalysisBadRequest("Ad report must be a promoted product report")
	}
	start := ""
	end := ""
	if parsed.detectedStartDate != nil {
		start = *parsed.detectedStartDate
	}
	if parsed.detectedEndDate != nil {
		end = *parsed.detectedEndDate
	}
	result := map[string]productAnalysisADTotals{}
	for _, values := range parsed.rows {
		row := newAdRowData(parsed.headers, values, start, end, &parsed.country)
		sku := row.text("推广的商品 SKU-Advertised product SKU", "广告SKU")
		asin := row.text("推广的商品编号", "广告ASIN")
		scope, _ := classifyScope(sku, asin, known)
		if scope != "included_product" {
			continue
		}
		skuValue := ""
		if sku != nil {
			skuValue = strings.TrimSpace(*sku)
		}
		totals := result[skuValue]
		german := strings.EqualFold(country, "DE")
		totals.Impressions += productAnalysisADInteger(row, german, "展示量")
		totals.Clicks += productAnalysisADInteger(row, german, "点击量")
		totals.Orders += productAnalysisADInteger(
			row,
			german,
			"购买量",
			"7天总订单数(#)",
		)
		totals.Spend += productAnalysisADFloat(
			row,
			german,
			"总成本",
			"花费",
		)
		totals.Sales += productAnalysisADFloat(
			row,
			german,
			"销售额",
			"7天总销售额",
		)
		result[skuValue] = totals
	}
	return result, nil
}

func productAnalysisCorrectBusinessRows(table tableData, rows []businessRow) {
	index := findCaseInsensitive(table.Headers, []string{
		"已订购商品销售额",
		"Ordered Product Sales",
		"Ordered Product Sales Amount",
	})
	if index < 0 {
		return
	}
	header := table.Headers[index]
	for rowIndex := range rows {
		if raw, exists := rows[rowIndex].Raw[header]; exists {
			rows[rowIndex].OrderedSalesAmount = productAnalysisParseLocalizedNumber(
				fmt.Sprint(raw),
				false,
			)
		}
	}
}

func productAnalysisCorrectPaymentRows(
	table tableData,
	rows []paymentRow,
	country string,
) {
	german := strings.EqualFold(country, "DE")
	for rowIndex := range rows {
		row := &rows[rowIndex]
		switch productAnalysisPaymentType(row.TransactionType) {
		case "order":
			row.TransactionType = "Order"
		case "refund":
			row.TransactionType = "Refund"
		}
		row.Quantity = int(productAnalysisRawNumber(
			table,
			row.Raw,
			german,
			"quantity",
			"menge",
		))
		row.ProductSales = productAnalysisRawNumber(
			table,
			row.Raw,
			german,
			"product sales",
			"umsaetze",
		)
		row.ShippingCredits = productAnalysisRawNumber(
			table,
			row.Raw,
			german,
			"shipping credits",
			"postage credits",
			"gutschrift fuer versandkosten",
		)
		row.PromotionalRebates = productAnalysisRawNumber(
			table,
			row.Raw,
			german,
			"promotional rebates",
			"rabatte aus werbeaktionen",
		)
		row.OtherAmount = productAnalysisRawNumber(
			table,
			row.Raw,
			german,
			"other",
			"andere",
		)
		row.SellingFees = productAnalysisRawNumber(
			table,
			row.Raw,
			german,
			"selling fees",
			"verkaufsgebuehren",
		)
		row.FBAFees = productAnalysisRawNumber(
			table,
			row.Raw,
			german,
			"fba fees",
			"gebuehren zu versand durch amazon",
		)
		total := productAnalysisRawNumber(
			table,
			row.Raw,
			german,
			"total",
			"gesamt",
		)
		if total != 0 || productAnalysisTableHasHeader(table.Headers, "total", "gesamt") {
			row.TotalAmount = total
		} else {
			row.TotalAmount = row.ProductSales +
				row.ShippingCredits +
				row.PromotionalRebates +
				row.OtherAmount +
				row.SellingFees +
				row.FBAFees
		}
	}
}

func productAnalysisRawNumber(
	table tableData,
	raw map[string]any,
	german bool,
	headers ...string,
) float64 {
	index := findCaseInsensitive(table.Headers, headers)
	if index < 0 {
		return 0
	}
	value, exists := raw[table.Headers[index]]
	if !exists {
		return 0
	}
	return productAnalysisParseLocalizedNumber(fmt.Sprint(value), german)
}

func productAnalysisTableHasHeader(headers []string, candidates ...string) bool {
	return findCaseInsensitive(headers, candidates) >= 0
}

func productAnalysisParseLocalizedNumber(raw string, german bool) float64 {
	raw = strings.TrimSpace(raw)
	if raw == "" || strings.EqualFold(raw, "nan") || strings.EqualFold(raw, "null") {
		return 0
	}
	negative := strings.HasPrefix(raw, "(") && strings.HasSuffix(raw, ")")
	var builder strings.Builder
	for _, r := range raw {
		if (r >= '0' && r <= '9') || r == ',' || r == '.' || r == '-' {
			builder.WriteRune(r)
		}
	}
	cleaned := builder.String()
	if cleaned == "" ||
		cleaned == "-" ||
		cleaned == "," ||
		cleaned == "." ||
		cleaned == "-." ||
		cleaned == "-," {
		return 0
	}
	if german {
		cleaned = strings.ReplaceAll(cleaned, ".", "")
		cleaned = strings.ReplaceAll(cleaned, ",", ".")
	} else if strings.Contains(cleaned, ",") {
		cleaned = strings.ReplaceAll(cleaned, ",", "")
	}
	value, err := strconv.ParseFloat(cleaned, 64)
	if err != nil {
		return 0
	}
	if negative && value > 0 {
		return -value
	}
	return value
}

func productAnalysisADInteger(
	row adRowData,
	german bool,
	columns ...string,
) int {
	value := row.text(columns...)
	if value == nil {
		return 0
	}
	return int(math.Round(productAnalysisParseLocalizedNumber(*value, german)))
}

func productAnalysisADFloat(
	row adRowData,
	german bool,
	columns ...string,
) float64 {
	value := row.text(columns...)
	if value == nil {
		return 0
	}
	return productAnalysisParseLocalizedNumber(*value, german)
}

func productAnalysisReadTableFile(path string, delimiter rune) (tableData, error) {
	if strings.EqualFold(filepath.Ext(path), ".xlsx") {
		return parseUploadXLSXTable(path)
	}
	return readTable(path, delimiter)
}

func productAnalysisLoadIdentifiers(
	ctx context.Context,
	db DB,
	projectID int64,
	country string,
) (identifierSet, error) {
	rows, err := db.Query(
		ctx,
		`select sku, asin
		 from public.product_costs
		 where project_id = $1
		   and country = $2
		   and is_active is true`,
		projectID,
		country,
	)
	if err != nil {
		return identifierSet{}, err
	}
	defer rows.Close()
	result := identifierSet{
		SKUs:  map[string]bool{},
		ASINs: map[string]bool{},
	}
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

func (e *productAnalysisCalculationEngine) resolveTempFile(
	tempFileID string,
	adUpload bool,
) (string, error) {
	tempFileID = strings.TrimSpace(tempFileID)
	if tempFileID == "" ||
		filepath.Base(tempFileID) != tempFileID ||
		strings.Contains(tempFileID, `\`) ||
		strings.Contains(tempFileID, "/") ||
		strings.Contains(tempFileID, "..") {
		return "", errors.New("invalid temp file id")
	}
	extension := strings.ToLower(filepath.Ext(tempFileID))
	if extension != ".csv" && extension != ".xlsx" && extension != ".txt" {
		return "", errors.New("unsupported temp file extension")
	}
	folder := filepath.Join(e.uploadRoot, reportTempDirectory)
	if adUpload {
		folder = filepath.Join(e.uploadRoot, "_ad_upload_tmp")
	}
	folderInfo, err := os.Lstat(folder)
	if err != nil {
		return "", err
	}
	if folderInfo.Mode()&os.ModeSymlink != 0 || !folderInfo.IsDir() {
		return "", errors.New("temp root must be a directory and not a symlink")
	}
	root, err := resolveRootForContainment(folder)
	if err != nil {
		return "", err
	}
	target := filepath.Join(root, tempFileID)
	if _, err := relativeInside(root, target); err != nil {
		return "", err
	}
	info, err := os.Lstat(target)
	if err != nil {
		return "", err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return "", errors.New("temp file must be a regular file")
	}
	if info.Size() > 50*1024*1024 {
		return "", errors.New("temp file exceeds upload size limit")
	}
	resolved, err := filepath.EvalSymlinks(target)
	if err != nil {
		return "", err
	}
	if _, err := relativeInside(root, resolved); err != nil {
		return "", err
	}
	return resolved, nil
}

func (e *productAnalysisCalculationEngine) resolveSourceFile(rawPath string) (string, error) {
	return productAnalysisResolveContainedSourceFile(e.uploadRoot, rawPath)
}

func productAnalysisResolveContainedSourceFile(
	uploadRoot string,
	rawPath string,
) (string, error) {
	rawPath = strings.TrimSpace(rawPath)
	if rawPath == "" {
		return "", errors.New("source path is empty")
	}
	if !filepath.IsAbs(rawPath) {
		return "", errors.New("source path must be absolute")
	}
	extension := strings.ToLower(filepath.Ext(rawPath))
	if extension != ".csv" && extension != ".xlsx" && extension != ".txt" {
		return "", errors.New("unsupported source file extension")
	}
	root, err := resolveRootForContainment(uploadRoot)
	if err != nil {
		return "", err
	}
	info, err := os.Lstat(rawPath)
	if err != nil {
		return "", err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return "", errors.New("source file must be a regular file")
	}
	if info.Size() > 50*1024*1024 {
		return "", errors.New("source file exceeds upload size limit")
	}
	resolved, err := filepath.EvalSymlinks(rawPath)
	if err != nil {
		return "", err
	}
	if _, err := relativeInside(root, resolved); err != nil {
		return "", err
	}
	return resolved, nil
}

func productAnalysisPersistPT1(
	ctx context.Context,
	db FullDB,
	project productAnalysisEngineProject,
	country string,
	startDate time.Time,
	endDate time.Time,
	payload *productAnalysisPT1Payload,
) (int64, int, int, error) {
	if db == nil {
		return 0, 0, 0, productAnalysisServiceUnavailable("product analysis database")
	}
	if payload == nil || payload.Summary == nil {
		return 0, 0, 0, productAnalysisBadRequest("pt1.summary must be a dict")
	}
	var lock int
	if err := db.QueryRow(
		ctx,
		`select 1 from public.projects where id = $1 for update`,
		project.ID,
	).Scan(&lock); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, 0, 0, product_analysis.ErrProjectNotFound
		}
		return 0, 0, 0, err
	}
	var version int
	if err := db.QueryRow(
		ctx,
		`select coalesce(max(version), 0) + 1
		 from public.analysis_pt1_calculation
		 where project_id = $1
		   and country = $2
		   and report_start_date = $3::date
		   and report_end_date = $4::date`,
		project.ID,
		country,
		startDate.Format("2006-01-02"),
		endDate.Format("2006-01-02"),
	).Scan(&version); err != nil {
		return 0, 0, 0, err
	}
	now := time.Now().UTC()
	if _, err := db.Exec(
		ctx,
		`update public.analysis_pt1_calculation
		 set is_current = false,
		     superseded_at = case when is_current then $5 else superseded_at end
		 where project_id = $1
		   and country = $2
		   and report_start_date = $3::date
		   and report_end_date = $4::date
		   and is_current is true`,
		project.ID,
		country,
		startDate.Format("2006-01-02"),
		endDate.Format("2006-01-02"),
		now,
	); err != nil {
		return 0, 0, 0, err
	}
	summaryJSON, err := json.Marshal(payload.Summary)
	if err != nil {
		return 0, 0, 0, err
	}
	var (
		pt1ID  int64
		stored int
	)
	err = db.QueryRow(
		ctx,
		`insert into public.analysis_pt1_calculation (
		   project_id, project_name, country, report_start_date,
		   report_end_date, version, is_current, superseded_at, row_count,
		   summary_row, result_file_path, result_r2_key, result_r2_url,
		   calculation_version, computed_at
		 ) values (
		   $1, $2, $3, $4::date, $5::date, $6, true, null, $7,
		   $8::json, null, null, null, 1, $9
		 )
		 returning id, version`,
		project.ID,
		project.Name,
		country,
		startDate.Format("2006-01-02"),
		endDate.Format("2006-01-02"),
		version,
		payload.RowCount,
		summaryJSON,
		now,
	).Scan(&pt1ID, &stored)
	if err != nil {
		return 0, 0, 0, err
	}
	for index, detail := range payload.Details {
		rawJSON, err := json.Marshal(detail)
		if err != nil {
			return 0, 0, 0, err
		}
		if _, err := db.Exec(
			ctx,
			`insert into public.analysis_pt_sku_details (
			   pt1_calculation_id, country, source_row_no, report_date,
			   sku, asin, total_units, total_sales_amount, page_views,
			   total_visitors, ad_impressions, ad_clicks, ad_orders,
			   ad_spend, ad_sales_amount, actual_sales_amount,
			   actual_sales_units, actual_refund_amount, actual_refund_units,
			   profit_amount, profit_rate, raw_row
			 ) values (
			   $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
			   $13, $14, $15, $16, $17, $18, $19, $20, $21, $22::json
			 )`,
			pt1ID,
			country,
			index+1,
			productAnalysisMapString(detail, "日期"),
			productAnalysisMapString(detail, "SKU"),
			productAnalysisMapString(detail, "ASIN"),
			productAnalysisMapInt(detail, "总销量"),
			productAnalysisMapFloat(detail, "总销售额"),
			productAnalysisMapInt(detail, "页面浏览量"),
			productAnalysisMapInt(detail, "总访客"),
			productAnalysisMapInt(detail, "广告展示量"),
			productAnalysisMapInt(detail, "广告点击量"),
			productAnalysisMapInt(detail, "广告订单量"),
			productAnalysisMapFloat(detail, "广告花费"),
			productAnalysisMapFloat(detail, "广告销售额"),
			productAnalysisMapFloat(detail, "实际销售额"),
			productAnalysisMapInt(detail, "实际销售量"),
			productAnalysisMapFloat(detail, "实际退款额"),
			productAnalysisMapInt(detail, "实际退款量"),
			productAnalysisMapFloat(detail, "利润"),
			productAnalysisMapFloat(detail, "利润率"),
			rawJSON,
		); err != nil {
			return 0, 0, 0, err
		}
	}
	return pt1ID, stored, payload.RowCount, nil
}

func productAnalysisMapString(value map[string]any, key string) *string {
	raw, exists := value[key]
	if !exists || raw == nil {
		return nil
	}
	text := strings.TrimSpace(fmt.Sprint(raw))
	if text == "" {
		return nil
	}
	return &text
}

func productAnalysisMapInt(value map[string]any, key string) int {
	return int(math.Round(productAnalysisAnyFloat(value[key])))
}

func productAnalysisMapFloat(value map[string]any, key string) float64 {
	return productAnalysisAnyFloat(value[key])
}
