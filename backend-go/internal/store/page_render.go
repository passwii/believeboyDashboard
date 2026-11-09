package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/page_render"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type PageRenderStore struct {
	db FullDB
}

func NewPageRenderStore(db FullDB) *PageRenderStore {
	return &PageRenderStore{db: db}
}

const pageRenderColumns = `
id, owner_user_id, title, source_format, original_filename, content_type,
file_size, r2_key, public_url, created_at`

type pageRenderRowScanner interface {
	Scan(dest ...any) error
}

func (store *PageRenderStore) InsertPage(
	ctx context.Context,
	page page_render.PageRecord,
) (page_render.UploadedPage, error) {
	row := store.db.QueryRow(
		ctx,
		`INSERT INTO public.uploaded_pages (
		   id, owner_user_id, title, source_format, original_filename,
		   content_type, file_size, r2_key, public_url
		 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		 RETURNING `+pageRenderColumns,
		page.ID, page.OwnerUserID, page.Title, page.SourceFormat,
		page.OriginalFilename, page.ContentType, page.FileSize, page.R2Key, page.PublicURL,
	)
	return scanUploadedPage(row)
}

func (store *PageRenderStore) GetPage(
	ctx context.Context,
	pageID string,
) (*page_render.PageRecord, error) {
	record, err := scanPageRecord(store.db.QueryRow(
		ctx,
		`SELECT `+pageRenderColumns+`
		 FROM public.uploaded_pages WHERE id = $1 LIMIT 1`,
		pageID,
	))
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &record, nil
}

func (store *PageRenderStore) ListPages(
	ctx context.Context,
	ownerUserID int64,
	limit int,
	offset int,
) ([]page_render.UploadedPage, error) {
	rows, err := store.db.Query(
		ctx,
		`SELECT `+pageRenderColumns+`
		 FROM public.uploaded_pages
		 WHERE owner_user_id = $1
		 ORDER BY created_at DESC
		 LIMIT $2 OFFSET $3`,
		ownerUserID,
		limit,
		offset,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]page_render.UploadedPage, 0)
	for rows.Next() {
		item, err := scanUploadedPage(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (store *PageRenderStore) CountPages(ctx context.Context, ownerUserID int64) (int64, error) {
	var total int64
	err := store.db.QueryRow(
		ctx,
		`SELECT count(*) FROM public.uploaded_pages WHERE owner_user_id = $1`,
		ownerUserID,
	).Scan(&total)
	return total, err
}

func (store *PageRenderStore) DeletePage(
	ctx context.Context,
	pageID string,
	ownerUserID int64,
) (bool, error) {
	tag, err := store.db.Exec(
		ctx,
		`DELETE FROM public.uploaded_pages
		 WHERE id = $1 AND owner_user_id = $2`,
		pageID,
		ownerUserID,
	)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

func scanUploadedPage(row pageRenderRowScanner) (page_render.UploadedPage, error) {
	var item page_render.UploadedPage
	var record page_render.PageRecord
	var createdAt pgtype.Timestamptz
	if err := row.Scan(
		&record.ID,
		&record.OwnerUserID,
		&record.Title,
		&record.SourceFormat,
		&record.OriginalFilename,
		&record.ContentType,
		&record.FileSize,
		&record.R2Key,
		&record.PublicURL,
		&createdAt,
	); err != nil {
		return page_render.UploadedPage{}, err
	}
	item.ID = record.ID
	item.Title = record.Title
	item.SourceFormat = record.SourceFormat
	item.PublicURL = record.PublicURL
	item.OriginalFilename = record.OriginalFilename
	item.FileSize = record.FileSize
	if createdAt.Valid {
		item.CreatedAt = httpapi.Timestamp(createdAt.Time)
	}
	return item, nil
}

func scanPageRecord(row pageRenderRowScanner) (page_render.PageRecord, error) {
	var record page_render.PageRecord
	var createdAt pgtype.Timestamptz
	if err := row.Scan(
		&record.ID,
		&record.OwnerUserID,
		&record.Title,
		&record.SourceFormat,
		&record.OriginalFilename,
		&record.ContentType,
		&record.FileSize,
		&record.R2Key,
		&record.PublicURL,
		&createdAt,
	); err != nil {
		return page_render.PageRecord{}, err
	}
	return record, nil
}

var _ = time.Time{}
