package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/internal_ad_data"
)

type InternalAdDataStore struct {
	db FullDB
}

func NewInternalAdDataStore(db FullDB) *InternalAdDataStore {
	return &InternalAdDataStore{db: db}
}

func (s *InternalAdDataStore) VerifyProjectAccess(ctx context.Context, projectID int64, operator string, isAdmin bool) error {
	var projOp, assistOp *string
	err := s.db.QueryRow(ctx, `
		select project_operator, assistant_operator
		from public.projects
		where id = $1 and coalesce(is_active, true) = true
	`, projectID).Scan(&projOp, &assistOp)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return internal_ad_data.ErrProjectNotFound
		}
		return err
	}
	if isAdmin {
		return nil
	}
	operator = strings.TrimSpace(operator)
	if operator == "" {
		return internal_ad_data.ErrProjectForbidden
	}
	if textContainsName(projOp, operator) || textContainsName(assistOp, operator) {
		return nil
	}
	return internal_ad_data.ErrProjectForbidden
}

func (s *InternalAdDataStore) ListAdUploadFiles(ctx context.Context, projectID int64, reportType, country *string, includeHistory bool, limit, offset int) ([]internal_ad_data.AdUploadFileItem, error) {
	query := `
		select id, report_type, report_label, country,
		       period_start_date::text, period_end_date::text,
		       version, is_current, ingestion_status, row_count_preview,
		       created_at::text
		from ad_upload_files
		where project_id = $1
	`
	args := []any{projectID}
	if reportType != nil && *reportType != "" {
		args = append(args, *reportType)
		query += fmt.Sprintf(" and report_type = $%d", len(args))
	}
	if country != nil && *country != "" {
		args = append(args, *country)
		query += fmt.Sprintf(" and country = $%d", len(args))
	}
	if !includeHistory {
		query += " and is_current = true"
	}

	if limit <= 0 {
		limit = 100
	}
	if offset < 0 {
		offset = 0
	}
	args = append(args, limit, offset)
	query += fmt.Sprintf(" order by updated_at desc, id desc limit $%d offset $%d", len(args)-1, len(args))

	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	if rows != nil {
		defer rows.Close()
	}
	if rows == nil {
		return []internal_ad_data.AdUploadFileItem{}, nil
	}

	var res []internal_ad_data.AdUploadFileItem
	for rows.Next() {
		var it internal_ad_data.AdUploadFileItem
		if err := rows.Scan(
			&it.FileID, &it.ReportType, &it.ReportLabel, &it.Country,
			&it.PeriodStartDate, &it.PeriodEndDate,
			&it.Version, &it.IsCurrent, &it.IngestionStatus, &it.RowCountPreview,
			&it.UploadedAt,
		); err != nil {
			return nil, err
		}
		res = append(res, it)
	}
	if res == nil {
		res = []internal_ad_data.AdUploadFileItem{}
	}
	return res, rows.Err()
}

func resolvePeriod(period string, startDate, endDate *string) (internal_ad_data.PeriodInfo, error) {
	yesterday := time.Now().UTC().AddDate(0, 0, -1)
	period = strings.TrimSpace(strings.ToLower(period))

	if period == "custom" || (period == "" && startDate != nil && endDate != nil) {
		if startDate == nil || endDate == nil || *startDate == "" || *endDate == "" {
			return internal_ad_data.PeriodInfo{}, errors.New("start_date and end_date are required when period=custom")
		}
		sTime, err1 := time.Parse("2006-01-02", *startDate)
		eTime, err2 := time.Parse("2006-01-02", *endDate)
		if err1 != nil || err2 != nil || sTime.After(eTime) {
			return internal_ad_data.PeriodInfo{}, errors.New("invalid start_date or end_date")
		}
		return internal_ad_data.PeriodInfo{
			Type:      "custom",
			Value:     "custom",
			StartDate: *startDate,
			EndDate:   *endDate,
		}, nil
	}

	if period == "" {
		period = "30d"
	}

	var s, e time.Time
	switch period {
	case "7d":
		s = yesterday.AddDate(0, 0, -6)
		e = yesterday
	case "14d":
		s = yesterday.AddDate(0, 0, -13)
		e = yesterday
	case "28d":
		s = yesterday.AddDate(0, 0, -27)
		e = yesterday
	case "30d":
		s = yesterday.AddDate(0, 0, -29)
		e = yesterday
	case "60d":
		s = yesterday.AddDate(0, 0, -59)
		e = yesterday
	case "90d":
		s = yesterday.AddDate(0, 0, -89)
		e = yesterday
	case "this_month":
		s = time.Date(yesterday.Year(), yesterday.Month(), 1, 0, 0, 0, 0, time.UTC)
		e = yesterday
	case "last_month":
		firstThisMonth := time.Date(yesterday.Year(), yesterday.Month(), 1, 0, 0, 0, 0, time.UTC)
		e = firstThisMonth.AddDate(0, 0, -1)
		s = time.Date(e.Year(), e.Month(), 1, 0, 0, 0, 0, time.UTC)
	case "ytd":
		s = time.Date(yesterday.Year(), 1, 1, 0, 0, 0, 0, time.UTC)
		e = yesterday
	default:
		// Month format YYYY-MM
		if len(period) == 7 && period[4] == '-' {
			mTime, err := time.Parse("2006-01", period)
			if err == nil {
				s = mTime
				nextMonth := mTime.AddDate(0, 1, 0)
				e = nextMonth.AddDate(0, 0, -1)
				return internal_ad_data.PeriodInfo{
					Type:      "relative",
					Value:     period,
					StartDate: s.Format("2006-01-02"),
					EndDate:   e.Format("2006-01-02"),
				}, nil
			}
		}
		return internal_ad_data.PeriodInfo{}, fmt.Errorf("unknown period alias: %q", period)
	}

	return internal_ad_data.PeriodInfo{
		Type:      "relative",
		Value:     period,
		StartDate: s.Format("2006-01-02"),
		EndDate:   e.Format("2006-01-02"),
	}, nil
}

type tableMapping struct {
	tableName  string
	reportType string
}

var endpointTableMap = map[string]tableMapping{
	"ad-campaigns":          {tableName: "ad_upload_campaign_rows", reportType: "ad_campaign_report"},
	"ad-campaign":           {tableName: "ad_upload_campaign_rows", reportType: "ad_campaign_report"},
	"ad-search-terms":       {tableName: "ad_upload_search_term_rows", reportType: "ad_search_term_report"},
	"ad-budgets":            {tableName: "ad_upload_budget_rows", reportType: "ad_budget_report"},
	"ad-targets":            {tableName: "ad_upload_target_rows", reportType: "ad_target_report"},
	"ad-placements":         {tableName: "ad_upload_placement_rows", reportType: "ad_placement_report"},
	"ad-promoted-products":  {tableName: "ad_upload_promoted_product_rows", reportType: "ad_promoted_product_report"},
	"ad-time-trends":        {tableName: "ad_upload_time_trend_rows", reportType: "ad_time_trend_report"},
	"ad-search-term-shares": {tableName: "ad_upload_search_term_share_rows", reportType: "ad_search_term_share_report"},
	"ad-invalid-traffic":    {tableName: "ad_upload_invalid_traffic_rows", reportType: "ad_invalid_traffic_report"},
	"ad-purchased-products": {tableName: "ad_upload_purchased_product_rows", reportType: "ad_purchased_product_report"},
}

func (s *InternalAdDataStore) QueryRaw(ctx context.Context, filter internal_ad_data.RawQueryFilter) (*internal_ad_data.RawResponse, error) {
	periodInfo, err := resolvePeriod(filter.Period, filter.StartDate, filter.EndDate)
	if err != nil {
		return nil, err
	}

	mapping, ok := endpointTableMap[filter.Endpoint]
	if !ok {
		return nil, fmt.Errorf("unknown raw endpoint %q", filter.Endpoint)
	}

	// Select latest version files
	selectFilesQuery := `
		with latest_versions as (
			select project_id, report_type, country, report_date, max(version) as max_version
			from ad_upload_files
			where project_id = $1 and country = $2 and report_type = $3
			  and is_current = true and ingestion_status = 'success' and recognition_status = 'recognized'
			  and (
			    (report_date between $4 and $5)
			    or (report_date is null and period_start_date <= $5 and period_end_date >= $4)
			  )
			group by project_id, report_type, country, report_date
		)
		select f.id
		from ad_upload_files f
		join latest_versions lv on f.project_id = lv.project_id
		  and f.report_type = lv.report_type
		  and f.country = lv.country
		  and (f.report_date = lv.report_date or (f.report_date is null and lv.report_date is null))
		  and f.version = lv.max_version
	`
	fRows, err := s.db.Query(ctx, selectFilesQuery, filter.ProjectID, filter.Country, mapping.reportType, periodInfo.StartDate, periodInfo.EndDate)
	if err != nil {
		return nil, err
	}
	var fileIDs []int64
	if fRows != nil {
		defer fRows.Close()
		for fRows.Next() {
			var fid int64
			if err := fRows.Scan(&fid); err == nil {
				fileIDs = append(fileIDs, fid)
			}
		}
	}

	if len(fileIDs) == 0 {
		return &internal_ad_data.RawResponse{
			ProjectID: filter.ProjectID,
			Period:    periodInfo,
			Country:   filter.Country,
			Data:      []map[string]any{},
			Summary: internal_ad_data.RawSummary{
				TotalRows: 0,
				DateRange: []string{periodInfo.StartDate, periodInfo.EndDate},
			},
		}, nil
	}

	orderBy := "report_end_date"
	switch filter.OrderBy {
	case "id", "report_start_date", "report_end_date", "clicks", "spend", "sales_7d", "impressions", "created_at":
		orderBy = filter.OrderBy
	}
	orderDir := "desc"
	if filter.OrderDir == "asc" {
		orderDir = "asc"
	}

	limit := filter.Limit
	if limit <= 0 || limit > 50000 {
		limit = 10000
	}
	offset := filter.Offset
	if offset < 0 {
		offset = 0
	}

	dataQuery := fmt.Sprintf(`
		select id, source_file_id, report_start_date::text, report_end_date::text, created_at::text, raw_row
		from %s
		where source_file_id = ANY($1)
		order by %s %s
		limit $2 offset $3
	`, mapping.tableName, orderBy, orderDir)

	rows, err := s.db.Query(ctx, dataQuery, fileIDs, limit, offset)
	if err != nil {
		return nil, err
	}
	if rows != nil {
		defer rows.Close()
	}

	var data []map[string]any
	if rows != nil {
		for rows.Next() {
			var id, sourceFileID int64
			var rStart, rEnd, createdAt string
			var rawRow map[string]any
			if err := rows.Scan(&id, &sourceFileID, &rStart, &rEnd, &createdAt, &rawRow); err != nil {
				continue
			}
			rowMap := rawRow
			if rowMap == nil {
				rowMap = make(map[string]any)
			}
			rowMap["id"] = id
			rowMap["source_file_id"] = sourceFileID
			rowMap["report_start_date"] = rStart
			rowMap["report_end_date"] = rEnd
			rowMap["created_at"] = createdAt
			data = append(data, rowMap)
		}
	}
	if data == nil {
		data = []map[string]any{}
	}

	return &internal_ad_data.RawResponse{
		ProjectID: filter.ProjectID,
		Period:    periodInfo,
		Country:   filter.Country,
		Data:      data,
		Summary: internal_ad_data.RawSummary{
			TotalRows: len(data),
			DateRange: []string{periodInfo.StartDate, periodInfo.EndDate},
		},
	}, nil
}
