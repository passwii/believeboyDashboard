package store

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/platform_revenues"
)

type PlatformRevenueStore struct {
	db FullDB
}

const (
	maxPlatformScreenshotBytes = 10 * 1024 * 1024
	accessibleProjectIDsSQL    = `
		select id from public.projects
		where coalesce(is_active, true) = true
		  and (
		    exists (
		      select 1 from unnest(regexp_split_to_array(
		        coalesce(project_operator, ''),
		        E'[、,，;\n\r]+'
		      )) as names(value)
		      where btrim(names.value) = $1
		    )
		    or exists (
		      select 1 from unnest(regexp_split_to_array(
		        coalesce(assistant_operator, ''),
		        E'[、,，;\n\r]+'
		      )) as names(value)
		      where btrim(names.value) = $1
		    )
		  )
		order by id asc
	`
)

func NewPlatformRevenueStore(db FullDB) *PlatformRevenueStore {
	return &PlatformRevenueStore{db: db}
}

func (s *PlatformRevenueStore) VerifyProjectAccess(ctx context.Context, projectID int64, op string, isAdmin bool) error {
	var projOp, asstOp *string
	err := s.db.QueryRow(ctx, "select project_operator, assistant_operator from public.projects where id = $1", projectID).Scan(&projOp, &asstOp)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return platform_revenues.ErrProjectNotFound
		}
		return err
	}
	if isAdmin {
		return nil
	}
	op = strings.TrimSpace(op)
	if op == "" {
		return platform_revenues.ErrProjectForbidden
	}
	if textContainsName(projOp, op) || textContainsName(asstOp, op) {
		return nil
	}
	return platform_revenues.ErrProjectForbidden
}

func (s *PlatformRevenueStore) AccessibleProjectIDs(ctx context.Context, op string) ([]int64, error) {
	op = strings.TrimSpace(op)
	if op == "" {
		return []int64{}, nil
	}
	rows, err := s.db.Query(ctx, accessibleProjectIDsSQL, op)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if ids == nil {
		ids = []int64{}
	}
	return ids, rows.Err()
}

func (s *PlatformRevenueStore) ListRevenues(ctx context.Context, filter platform_revenues.PlatformRevenueFilter) ([]platform_revenues.PlatformRevenueItem, int, error) {
	var accessibleIDs []int64
	var err error
	if !filter.IsAdmin {
		accessibleIDs, err = s.AccessibleProjectIDs(ctx, filter.Operator)
		if err != nil {
			return nil, 0, err
		}
		if len(accessibleIDs) == 0 {
			return []platform_revenues.PlatformRevenueItem{}, 0, nil
		}
		if filter.ProjectID > 0 {
			allowed := false
			for _, id := range accessibleIDs {
				if id == filter.ProjectID {
					allowed = true
					break
				}
			}
			if !allowed {
				return nil, 0, platform_revenues.ErrProjectForbidden
			}
		}
	}

	var conditions []string
	var args []any
	idx := 1

	if filter.ProjectID > 0 {
		conditions = append(conditions, fmt.Sprintf("project_id = $%d", idx))
		args = append(args, filter.ProjectID)
		idx++
	} else if !filter.IsAdmin && len(accessibleIDs) > 0 {
		conditions = append(conditions, fmt.Sprintf("project_id = any($%d)", idx))
		args = append(args, accessibleIDs)
		idx++
	}

	if filter.Year > 0 {
		conditions = append(conditions, fmt.Sprintf("extract(year from received_date) = $%d", idx))
		args = append(args, filter.Year)
		idx++
	}
	if filter.Month > 0 {
		conditions = append(conditions, fmt.Sprintf("extract(month from received_date) = $%d", idx))
		args = append(args, filter.Month)
		idx++
	}
	if filter.Country != "" {
		conditions = append(conditions, fmt.Sprintf("country = $%d", idx))
		args = append(args, filter.Country)
		idx++
	}
	if filter.Currency != "" {
		conditions = append(conditions, fmt.Sprintf("currency = $%d", idx))
		args = append(args, filter.Currency)
		idx++
	}

	where := ""
	if len(conditions) > 0 {
		where = "where " + strings.Join(conditions, " and ")
	}

	var total int
	countSQL := fmt.Sprintf("select count(*) from public.platform_revenues %s", where)
	if err := s.db.QueryRow(ctx, countSQL, args...).Scan(&total); err != nil {
		return nil, 0, err
	}

	offset := (filter.Page - 1) * filter.PageSize
	if offset < 0 {
		offset = 0
	}

	querySQL := fmt.Sprintf(`
		select
			id, project_id, project_name, country, received_date::text,
			amount, currency, exchange_rate, revenue_type, note,
			attachments::text, screenshot_r2_key, screenshot_r2_url,
			created_by, created_at, updated_at
		from public.platform_revenues
		%s
		order by received_date desc, id desc
		limit $%d offset $%d
	`, where, idx, idx+1)
	args = append(args, filter.PageSize, offset)

	rows, err := s.db.Query(ctx, querySQL, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var items []platform_revenues.PlatformRevenueItem
	for rows.Next() {
		var it platform_revenues.PlatformRevenueItem
		var attJSON *string
		var createdAt, updatedAt time.Time
		if err := rows.Scan(
			&it.ID, &it.ProjectID, &it.ProjectName, &it.Country, &it.ReceivedDate,
			&it.Amount, &it.Currency, &it.ExchangeRate, &it.RevenueType, &it.Note,
			&attJSON, &it.ScreenshotR2Key, &it.ScreenshotR2URL,
			&it.CreatedBy, &createdAt, &updatedAt,
		); err != nil {
			return nil, 0, err
		}
		it.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
		it.UpdatedAt = updatedAt.UTC().Format(time.RFC3339Nano)
		it.Attachments = []platform_revenues.PlatformRevenueAttachment{}
		if attJSON != nil && *attJSON != "" {
			_ = json.Unmarshal([]byte(*attJSON), &it.Attachments)
		}
		items = append(items, it)
	}
	if items == nil {
		items = []platform_revenues.PlatformRevenueItem{}
	}
	return items, total, rows.Err()
}

func (s *PlatformRevenueStore) GetRevenue(ctx context.Context, revenueID int64, op string, isAdmin bool) (*platform_revenues.PlatformRevenueItem, error) {
	querySQL := `
		select
			id, project_id, project_name, country, received_date::text,
			amount, currency, exchange_rate, revenue_type, note,
			attachments::text, screenshot_r2_key, screenshot_r2_url,
			created_by, created_at, updated_at
		from public.platform_revenues
		where id = $1
	`
	var it platform_revenues.PlatformRevenueItem
	var attJSON *string
	var createdAt, updatedAt time.Time
	err := s.db.QueryRow(ctx, querySQL, revenueID).Scan(
		&it.ID, &it.ProjectID, &it.ProjectName, &it.Country, &it.ReceivedDate,
		&it.Amount, &it.Currency, &it.ExchangeRate, &it.RevenueType, &it.Note,
		&attJSON, &it.ScreenshotR2Key, &it.ScreenshotR2URL,
		&it.CreatedBy, &createdAt, &updatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, platform_revenues.ErrRevenueNotFound
		}
		return nil, err
	}

	if !isAdmin {
		if err := s.VerifyProjectAccess(ctx, it.ProjectID, op, false); err != nil {
			return nil, platform_revenues.ErrRevenueForbidden
		}
	}

	it.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
	it.UpdatedAt = updatedAt.UTC().Format(time.RFC3339Nano)
	it.Attachments = []platform_revenues.PlatformRevenueAttachment{}
	if attJSON != nil && *attJSON != "" {
		_ = json.Unmarshal([]byte(*attJSON), &it.Attachments)
	}
	return &it, nil
}

func (s *PlatformRevenueStore) CreateRevenue(ctx context.Context, payload platform_revenues.PlatformRevenueCreate, op string, isAdmin bool) (*platform_revenues.PlatformRevenueItem, error) {
	var projectName string
	err := s.db.QueryRow(ctx, "select project_name from public.projects where id = $1", payload.ProjectID).Scan(&projectName)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, platform_revenues.ErrProjectNotFound
		}
		return nil, err
	}

	if !isAdmin {
		if err := s.VerifyProjectAccess(ctx, payload.ProjectID, op, false); err != nil {
			return nil, platform_revenues.ErrProjectForbidden
		}
	}

	attBytes, _ := json.Marshal(payload.Attachments)
	createdBy := op
	if createdBy == "" {
		createdBy = "system"
	}

	querySQL := `
		insert into public.platform_revenues (
			project_id, project_name, country, received_date, amount, currency,
			exchange_rate, revenue_type, note, attachments, screenshot_r2_key,
			screenshot_r2_url, created_by, created_at, updated_at
		) values (
			$1, $2, $3, $4::date, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, now(), now()
		)
		returning id, created_at, updated_at
	`
	var id int64
	var createdAt, updatedAt time.Time
	err = s.db.QueryRow(
		ctx, querySQL,
		payload.ProjectID, projectName, payload.Country, payload.ReceivedDate,
		payload.Amount, payload.Currency, payload.ExchangeRate, payload.RevenueType,
		payload.Note, string(attBytes), payload.ScreenshotR2Key, payload.ScreenshotR2URL,
		createdBy,
	).Scan(&id, &createdAt, &updatedAt)
	if err != nil {
		return nil, err
	}

	return &platform_revenues.PlatformRevenueItem{
		ID:              id,
		ProjectID:       payload.ProjectID,
		ProjectName:     projectName,
		Country:         payload.Country,
		ReceivedDate:    payload.ReceivedDate,
		Amount:          payload.Amount,
		Currency:        payload.Currency,
		ExchangeRate:    payload.ExchangeRate,
		RevenueType:     payload.RevenueType,
		Note:            payload.Note,
		Attachments:     payload.Attachments,
		ScreenshotR2Key: payload.ScreenshotR2Key,
		ScreenshotR2URL: payload.ScreenshotR2URL,
		CreatedBy:       createdBy,
		CreatedAt:       createdAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt:       updatedAt.UTC().Format(time.RFC3339Nano),
	}, nil
}

func (s *PlatformRevenueStore) UpdateRevenue(ctx context.Context, revenueID int64, payload platform_revenues.PlatformRevenueUpdate, op string, isAdmin bool) (*platform_revenues.PlatformRevenueItem, error) {
	existing, err := s.GetRevenue(ctx, revenueID, op, isAdmin)
	if err != nil {
		return nil, err
	}

	var sets []string
	var args []any
	idx := 2
	args = append(args, revenueID)

	if payload.Country != nil {
		sets = append(sets, fmt.Sprintf("country = $%d", idx))
		args = append(args, *payload.Country)
		idx++
		existing.Country = *payload.Country
	}
	if payload.ReceivedDate != nil {
		sets = append(sets, fmt.Sprintf("received_date = $%d::date", idx))
		args = append(args, *payload.ReceivedDate)
		idx++
		existing.ReceivedDate = *payload.ReceivedDate
	}
	if payload.Amount != nil {
		sets = append(sets, fmt.Sprintf("amount = $%d", idx))
		args = append(args, *payload.Amount)
		idx++
		existing.Amount = *payload.Amount
	}
	if payload.Currency != nil {
		sets = append(sets, fmt.Sprintf("currency = $%d", idx))
		args = append(args, *payload.Currency)
		idx++
		existing.Currency = *payload.Currency
	}
	if payload.ExchangeRate != nil {
		sets = append(sets, fmt.Sprintf("exchange_rate = $%d", idx))
		args = append(args, *payload.ExchangeRate)
		idx++
		existing.ExchangeRate = payload.ExchangeRate
	}
	if payload.RevenueType != nil {
		sets = append(sets, fmt.Sprintf("revenue_type = $%d", idx))
		args = append(args, *payload.RevenueType)
		idx++
		existing.RevenueType = *payload.RevenueType
	}
	if payload.Note != nil {
		sets = append(sets, fmt.Sprintf("note = $%d", idx))
		args = append(args, *payload.Note)
		idx++
		existing.Note = payload.Note
	}
	if payload.Attachments != nil {
		attBytes, _ := json.Marshal(*payload.Attachments)
		sets = append(sets, fmt.Sprintf("attachments = $%d::jsonb", idx))
		args = append(args, string(attBytes))
		idx++
		existing.Attachments = *payload.Attachments
	}
	if payload.ScreenshotR2Key != nil {
		sets = append(sets, fmt.Sprintf("screenshot_r2_key = $%d", idx))
		args = append(args, *payload.ScreenshotR2Key)
		idx++
		existing.ScreenshotR2Key = payload.ScreenshotR2Key
	}
	if payload.ScreenshotR2URL != nil {
		sets = append(sets, fmt.Sprintf("screenshot_r2_url = $%d", idx))
		args = append(args, *payload.ScreenshotR2URL)
		idx++
		existing.ScreenshotR2URL = payload.ScreenshotR2URL
	}

	if len(sets) == 0 {
		return existing, nil
	}

	sets = append(sets, "updated_at = now()")
	querySQL := fmt.Sprintf("update public.platform_revenues set %s where id = $1 returning updated_at", strings.Join(sets, ", "))
	var updatedAt time.Time
	if err := s.db.QueryRow(ctx, querySQL, args...).Scan(&updatedAt); err != nil {
		return nil, err
	}
	existing.UpdatedAt = updatedAt.UTC().Format(time.RFC3339Nano)
	return existing, nil
}

func (s *PlatformRevenueStore) DeleteRevenue(ctx context.Context, revenueID int64, op string, isAdmin bool) error {
	_, err := s.GetRevenue(ctx, revenueID, op, isAdmin)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(ctx, "delete from public.platform_revenues where id = $1", revenueID)
	return err
}

func (s *PlatformRevenueStore) GetProjectCountries(ctx context.Context, projectID int64) ([]string, error) {
	rows, err := s.db.Query(ctx, `
		select distinct country
		from public.product_costs
		where project_id = $1
		order by country asc
	`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var countries []string
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err == nil {
			c = strings.TrimSpace(c)
			if c != "" {
				countries = append(countries, c)
			}
		}
	}
	if countries == nil {
		countries = []string{}
	}
	return countries, rows.Err()
}

func (s *PlatformRevenueStore) SavePaymentScreenshot(ctx context.Context, projectName string, filename string, contentType string, data []byte) (*platform_revenues.UploadImageResponse, error) {
	if len(data) == 0 {
		return nil, errors.New("图片文件为空")
	}
	if len(data) > maxPlatformScreenshotBytes {
		return nil, errors.New("File size exceeds 10MB")
	}
	normalizedType := strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	detectedType := detectPlatformImageType(data)
	if detectedType == "" {
		return nil, errors.New("Unsupported image content")
	}
	if normalizedType == "" {
		normalizedType = detectedType
	}
	if !allowedPlatformImageTypes[normalizedType] || normalizedType != detectedType {
		return nil, errors.New("Unsupported file type")
	}

	idBytes := make([]byte, 16)
	if _, err := rand.Read(idBytes); err != nil {
		return nil, fmt.Errorf("generate image id: %w", err)
	}
	imageID := hex.EncodeToString(idBytes)

	safeProject := safeStoragePathSegment(projectName, "project")
	key := fmt.Sprintf("%s/payment_screenshot/images/%s.webp", safeProject, imageID)
	url := fmt.Sprintf("https://pub-r2.believeboy.com/%s", key)
	thumbURL := fmt.Sprintf("https://pub-r2.believeboy.com/%s/payment_screenshot/thumbs/%s_thumb.webp", safeProject, imageID)
	safeFilename := safeUploadFilename(filename, imageID+".webp")

	return &platform_revenues.UploadImageResponse{
		ID:        imageID,
		URL:       url,
		ThumbURL:  thumbURL,
		Key:       key,
		Filename:  safeFilename,
		Size:      int64(len(data)),
		CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}, nil
}

var allowedPlatformImageTypes = map[string]bool{
	"image/jpeg": true,
	"image/png":  true,
	"image/webp": true,
	"image/gif":  true,
}

func detectPlatformImageType(data []byte) string {
	switch {
	case bytes.HasPrefix(data, []byte{0xFF, 0xD8, 0xFF}):
		return "image/jpeg"
	case bytes.HasPrefix(data, []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}):
		return "image/png"
	case bytes.HasPrefix(data, []byte("GIF87a")) || bytes.HasPrefix(data, []byte("GIF89a")):
		return "image/gif"
	case len(data) >= 12 && bytes.Equal(data[0:4], []byte("RIFF")) && bytes.Equal(data[8:12], []byte("WEBP")):
		return "image/webp"
	default:
		return ""
	}
}
