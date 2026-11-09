package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/crm"
)

const crmProposalSelect = `
select
	p.id, p.title, p.proposal_type, p.status, p.customer_id, c.name,
	p.owner_id, u.full_name, p.current_version_no,
	(select count(*) from public.crm_proposal_versions v where v.proposal_id = p.id) as version_count,
	p.created_by, p.created_at, p.updated_at
from public.crm_proposals p
left join public.crm_customers c on c.id = p.customer_id
left join public.user_accounts u on u.id::text = p.owner_id
`

func (s *CRMStore) scanProposal(row interface{ Scan(...any) error }) (*crm.Proposal, error) {
	var item crm.Proposal
	var createdAt, updatedAt time.Time
	if err := row.Scan(
		&item.ID, &item.Title, &item.ProposalType, &item.Status, &item.CustomerID,
		&item.CustomerName, &item.OwnerID, &item.OwnerName, &item.CurrentVersionNo,
		&item.VersionCount, &item.CreatedBy, &createdAt, &updatedAt,
	); err != nil {
		return nil, err
	}
	item.CreatedAt = timestampValue(createdAt)
	item.UpdatedAt = timestampValue(updatedAt)
	return &item, nil
}

func (s *CRMStore) ListProposals(
	ctx context.Context,
	filter crm.ProposalListFilter,
	userID *string,
	isAdmin bool,
) (crm.Paginated[crm.Proposal], error) {
	_ = isAdmin
	page := filter.Page
	if page < 1 {
		page = 1
	}
	pageSize := filter.PageSize
	if pageSize < 1 {
		pageSize = 20
	}
	where := []string{"true"}
	args := []any{}
	nextArg := 1
	if filter.Scope == "mine" {
		if userID == nil || strings.TrimSpace(*userID) == "" {
			return crm.Paginated[crm.Proposal]{}, nil
		}
		where = append(where, "p.owner_id = $"+strconv.Itoa(nextArg))
		args = append(args, strings.TrimSpace(*userID))
		nextArg++
	}
	allowedFilters := map[string]string{
		"status": "status", "proposal_type": "proposal_type",
		"customer_id": "customer_id", "owner_id": "owner_id",
	}
	for key, value := range filter.Filters {
		column, ok := allowedFilters[key]
		if !ok {
			return crm.Paginated[crm.Proposal]{}, crm.NewAPIError(400, "不支持的筛选字段: "+key)
		}
		if value == nil || value == "" {
			continue
		}
		where = append(where, "p."+column+" = $"+strconv.Itoa(nextArg))
		args = append(args, value)
		nextArg++
	}
	if filter.Keyword != nil && strings.TrimSpace(*filter.Keyword) != "" {
		where = append(where, "p.title ilike $"+strconv.Itoa(nextArg))
		args = append(args, "%"+strings.TrimSpace(*filter.Keyword)+"%")
		nextArg++
	}
	sortColumn := map[string]string{
		"updated_at": "updated_at", "created_at": "created_at",
		"title": "title", "current_version_no": "current_version_no",
	}[filter.SortBy]
	if sortColumn == "" {
		return crm.Paginated[crm.Proposal]{}, crm.NewAPIError(400, "不支持的排序字段: "+filter.SortBy)
	}
	sortOrder := strings.ToLower(filter.SortOrder)
	if sortOrder != "asc" && sortOrder != "desc" {
		sortOrder = "desc"
	}
	whereSQL := strings.Join(where, " and ")
	var total int
	if err := s.db.QueryRow(ctx, `
		select count(*) from public.crm_proposals p where `+whereSQL, args...).Scan(&total); err != nil {
		return crm.Paginated[crm.Proposal]{}, err
	}
	query := crmProposalSelect + " where " + whereSQL +
		" order by p." + sortColumn + " " + sortOrder +
		" limit $" + strconv.Itoa(nextArg) + " offset $" + strconv.Itoa(nextArg+1)
	args = append(args, pageSize, (page-1)*pageSize)
	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return crm.Paginated[crm.Proposal]{}, err
	}
	defer rows.Close()
	items := []crm.Proposal{}
	for rows.Next() {
		item, err := s.scanProposal(rows)
		if err != nil {
			return crm.Paginated[crm.Proposal]{}, err
		}
		items = append(items, *item)
	}
	if err := rows.Err(); err != nil {
		return crm.Paginated[crm.Proposal]{}, err
	}
	return crm.Paginated[crm.Proposal]{Items: items, Total: total, Page: page, PageSize: pageSize}, nil
}

func (s *CRMStore) GetProposal(ctx context.Context, proposalID int64) (*crm.ProposalDetail, error) {
	proposal, err := s.scanProposal(s.db.QueryRow(ctx, crmProposalSelect+" where p.id = $1", proposalID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	versions, err := s.listProposalVersions(ctx, proposalID)
	if err != nil {
		return nil, err
	}
	return &crm.ProposalDetail{Proposal: *proposal, Versions: versions}, nil
}

func (s *CRMStore) listProposalVersions(ctx context.Context, proposalID int64) ([]crm.ProposalVersion, error) {
	rows, err := s.db.Query(ctx, `
		select v.id, v.version_no, v.original_filename, v.content_type, v.file_size,
		       v.change_note, v.created_by, u.full_name, v.created_at
		from public.crm_proposal_versions v
		left join public.user_accounts u on u.id::text = v.created_by
		where v.proposal_id = $1
		order by v.version_no desc
	`, proposalID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []crm.ProposalVersion{}
	for rows.Next() {
		var item crm.ProposalVersion
		var createdAt time.Time
		if err := rows.Scan(
			&item.ID, &item.VersionNo, &item.OriginalFilename, &item.ContentType,
			&item.FileSize, &item.ChangeNote, &item.CreatedBy, &item.CreatedByName,
			&createdAt,
		); err != nil {
			return nil, err
		}
		item.CreatedAt = timestampValue(createdAt)
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *CRMStore) getProposalVersionItem(
	ctx context.Context,
	proposalID int64,
	versionNo int,
) (*crm.ProposalVersion, error) {
	var item crm.ProposalVersion
	var createdAt time.Time
	err := s.db.QueryRow(ctx, `
		select v.id, v.version_no, v.original_filename, v.content_type, v.file_size,
		       v.change_note, v.created_by, u.full_name, v.created_at
		from public.crm_proposal_versions v
		left join public.user_accounts u on u.id::text = v.created_by
		where v.proposal_id = $1 and v.version_no = $2
	`, proposalID, versionNo).Scan(
		&item.ID, &item.VersionNo, &item.OriginalFilename, &item.ContentType,
		&item.FileSize, &item.ChangeNote, &item.CreatedBy, &item.CreatedByName,
		&createdAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	item.CreatedAt = timestampValue(createdAt)
	return &item, nil
}

func crmProposalTitle(raw *string, fallback string) string {
	value := strings.TrimSpace(derefString(raw))
	if value == "" {
		value = strings.TrimSpace(fallback)
		if index := strings.LastIndex(value, "/"); index >= 0 {
			value = value[index+1:]
		}
		if index := strings.LastIndex(value, "."); index >= 0 {
			value = value[:index]
		}
		value = strings.TrimSpace(value)
	}
	if value == "" {
		value = "未命名方案"
	}
	replacer := strings.NewReplacer(
		"<", "", ">", "", "&", "", "\x00", "", "\r", "", "\n", "",
	)
	value = replacer.Replace(value)
	runes := []rune(value)
	if len(runes) > 200 {
		value = string(runes[:200])
	}
	return value
}

func crmProposalFileFormat(filename, contentType string) string {
	ext := strings.ToLower(filepath.Ext(filename))
	switch ext {
	case ".html", ".htm":
		return "html"
	case ".pdf":
		return "pdf"
	}
	if strings.Contains(strings.ToLower(contentType), "pdf") {
		return "pdf"
	}
	return ""
}

func crmProposalContentType(filename, declared string) string {
	format := crmProposalFileFormat(filename, declared)
	if format == "pdf" {
		return "application/pdf"
	}
	if format == "html" && strings.Contains(strings.ToLower(declared), "pdf") {
		return "text/html"
	}
	if strings.TrimSpace(declared) == "" {
		return "text/html"
	}
	value := declared
	if len([]rune(value)) > 64 {
		value = string([]rune(value)[:64])
	}
	return value
}

func validateCRMProposalPayload(filename string, data []byte) error {
	if len(data) == 0 {
		return crm.NewAPIError(400, "文件为空")
	}
	if len(data) > 20<<20 {
		return crm.NewAPIError(413, "文件超过 20971520 字节上限")
	}
	if crmProposalFileFormat(filename, "") == "" {
		return crm.NewAPIError(400, "unsupported proposal file type")
	}
	return nil
}

func (s *CRMStore) assertProposalCustomerVisible(
	ctx context.Context,
	customerID *int64,
	actorID string,
	isAdmin bool,
) error {
	if customerID == nil {
		return nil
	}
	var ownerID *string
	err := s.db.QueryRow(ctx, `
		select owner_id from public.crm_customers
		where id = $1 and is_deleted = false
	`, *customerID).Scan(&ownerID)
	if errors.Is(err, pgx.ErrNoRows) {
		return crm.NewAPIError(404, "Customer not found")
	}
	if err != nil {
		return err
	}
	if !isAdmin && ownerID != nil && *ownerID != strings.TrimSpace(actorID) {
		return crm.NewAPIError(403, "Not the customer owner")
	}
	return nil
}

func (s *CRMStore) uploadProposalObjects(
	ctx context.Context,
	storage crm.ProposalStorage,
	proposalID int64,
	versionNo int,
	input crm.ProposalCreateInput,
) (string, string, string, error) {
	format := crmProposalFileFormat(input.Filename, input.ContentType)
	if format == "" {
		return "", "", "", crm.NewAPIError(400, "unsupported proposal file type")
	}
	folder := fmt.Sprintf("crm-proposals/%d/v%d", proposalID, versionNo)
	rawName := "raw.html"
	if format == "pdf" {
		rawName = "raw.pdf"
	}
	rawKey := folder + "/" + rawName
	rawContentType := crmProposalContentType(input.Filename, input.ContentType)
	if err := storage.PutObject(ctx, rawKey, input.RawBytes, rawContentType); err != nil {
		return "", "", "", err
	}
	adaptedBytes := input.AdaptedBytes
	if format == "pdf" {
		return rawKey, rawKey, crmSHA256(input.RawBytes), nil
	}
	adaptedKey := folder + "/adapted.html"
	if len(adaptedBytes) == 0 {
		adaptedBytes = input.RawBytes
	}
	if err := storage.PutObject(ctx, adaptedKey, adaptedBytes, "text/html; charset=utf-8"); err != nil {
		_ = storage.DeleteObject(ctx, rawKey)
		return "", "", "", err
	}
	return rawKey, adaptedKey, crmSHA256(adaptedBytes), nil
}

func crmSHA256(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func (s *CRMStore) CreateProposal(
	ctx context.Context,
	input crm.ProposalCreateInput,
	actorID string,
	isAdmin bool,
	storage crm.ProposalStorage,
) (crm.ProposalUploadResponse, error) {
	if storage == nil {
		return crm.ProposalUploadResponse{}, crm.NewAPIError(503, "云存储未配置，请联系管理员")
	}
	if err := validateCRMProposalPayload(input.Filename, input.RawBytes); err != nil {
		return crm.ProposalUploadResponse{}, err
	}
	if input.ProposalType == "" {
		input.ProposalType = "other"
	}
	switch input.ProposalType {
	case "onboarding", "operation", "quotation", "research", "other":
	default:
		return crm.ProposalUploadResponse{}, crm.NewAPIError(400, "无效的方案类型")
	}
	if err := s.assertProposalCustomerVisible(ctx, input.CustomerID, actorID, isAdmin); err != nil {
		return crm.ProposalUploadResponse{}, err
	}
	var proposalID int64
	var uploadedRawKey, uploadedAdaptedKey string
	err := s.inTx(ctx, func(db FullDB) error {
		if err := db.QueryRow(ctx, `
			insert into public.crm_proposals
				(title, proposal_type, status, customer_id, owner_id, current_version_no, created_by)
			values ($1, $2, 'draft', $3, $4, 0, $4)
			returning id
		`,
			crmProposalTitle(input.Title, input.Filename), input.ProposalType,
			input.CustomerID, optionalNullableText(actorID),
		).Scan(&proposalID); err != nil {
			return err
		}
		rawKey, adaptedKey, digest, err := s.uploadProposalObjects(
			ctx, storage, proposalID, 1, input,
		)
		if err != nil {
			return err
		}
		uploadedRawKey, uploadedAdaptedKey = rawKey, adaptedKey
		contentType := crmProposalContentType(input.Filename, input.ContentType)
		filename := input.Filename
		if strings.TrimSpace(filename) == "" {
			filename = "proposal.html"
			if crmProposalFileFormat("", contentType) == "pdf" {
				filename = "proposal.pdf"
			}
		}
		if len([]rune(filename)) > 255 {
			filename = string([]rune(filename)[:255])
		}
		if _, err := db.Exec(ctx, `
			insert into public.crm_proposal_versions
				(proposal_id, version_no, raw_r2_key, adapted_r2_key, adapted_sha256,
				 original_filename, content_type, file_size, change_note, created_by)
			values ($1, 1, $2, $3, $4, $5, $6, $7, '初始版本', $8)
		`,
			proposalID, rawKey, adaptedKey, digest, filename, contentType,
			len(input.RawBytes), optionalNullableText(actorID),
		); err != nil {
			return err
		}
		if _, err := db.Exec(ctx, `
			update public.crm_proposals
			set current_version_no = 1, updated_at = now()
			where id = $1
		`, proposalID); err != nil {
			return err
		}
		return insertCRMAudit(ctx, db, "proposal", proposalID, "create", actorID,
			"新建客户方案 "+crmProposalTitle(input.Title, input.Filename)+"（v1）")
	})
	if err != nil {
		if uploadedRawKey != "" {
			_ = storage.DeleteObject(ctx, uploadedRawKey)
		}
		if uploadedAdaptedKey != "" && uploadedAdaptedKey != uploadedRawKey {
			_ = storage.DeleteObject(ctx, uploadedAdaptedKey)
		}
		return crm.ProposalUploadResponse{}, err
	}
	proposal, err := s.GetProposal(ctx, proposalID)
	if err != nil {
		return crm.ProposalUploadResponse{}, err
	}
	version, err := s.getProposalVersionItem(ctx, proposalID, 1)
	if err != nil {
		return crm.ProposalUploadResponse{}, err
	}
	if proposal == nil || version == nil {
		return crm.ProposalUploadResponse{}, errors.New("proposal rows could not be reloaded")
	}
	return crm.ProposalUploadResponse{
		Proposal: proposal.Proposal, Version: *version, Warnings: ensureCRMProposalSlice(input.Warnings),
	}, nil
}

func ensureCRMProposalSlice[T any](items []T) []T {
	if items == nil {
		return []T{}
	}
	return items
}

func (s *CRMStore) AddProposalVersion(
	ctx context.Context,
	proposalID int64,
	input crm.ProposalAddVersionInput,
	actorID string,
	storage crm.ProposalStorage,
) (crm.ProposalUploadResponse, error) {
	if storage == nil {
		return crm.ProposalUploadResponse{}, crm.NewAPIError(503, "云存储未配置，请联系管理员")
	}
	if err := validateCRMProposalPayload(input.Filename, input.RawBytes); err != nil {
		return crm.ProposalUploadResponse{}, err
	}
	var nextVersion int
	var uploadedRawKey, uploadedAdaptedKey string
	err := s.inTx(ctx, func(db FullDB) error {
		if err := db.QueryRow(ctx, `
			select current_version_no
			from public.crm_proposals
			where id = $1
			for update
		`, proposalID).Scan(&nextVersion); err != nil {
			return err
		}
		nextVersion++
		createLike := crm.ProposalCreateInput{
			Filename: input.Filename, ContentType: input.ContentType,
			RawBytes: input.RawBytes, AdaptedBytes: input.AdaptedBytes,
		}
		rawKey, adaptedKey, digest, err := s.uploadProposalObjects(
			ctx, storage, proposalID, nextVersion, createLike,
		)
		if err != nil {
			return err
		}
		uploadedRawKey, uploadedAdaptedKey = rawKey, adaptedKey
		contentType := crmProposalContentType(input.Filename, input.ContentType)
		filename := input.Filename
		if strings.TrimSpace(filename) == "" {
			filename = "proposal.html"
			if crmProposalFileFormat("", contentType) == "pdf" {
				filename = "proposal.pdf"
			}
		}
		if len([]rune(filename)) > 255 {
			filename = string([]rune(filename)[:255])
		}
		changeNote := crmNullableString(input.ChangeNote)
		if _, err := db.Exec(ctx, `
			insert into public.crm_proposal_versions
				(proposal_id, version_no, raw_r2_key, adapted_r2_key, adapted_sha256,
				 original_filename, content_type, file_size, change_note, created_by)
			values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		`,
			proposalID, nextVersion, rawKey, adaptedKey, digest, filename,
			contentType, len(input.RawBytes), changeNote, optionalNullableText(actorID),
		); err != nil {
			return err
		}
		if _, err := db.Exec(ctx, `
			update public.crm_proposals
			set current_version_no = $1, updated_at = now()
			where id = $2
		`, nextVersion, proposalID); err != nil {
			return err
		}
		return insertCRMAudit(ctx, db, "proposal", proposalID, "update", actorID,
			fmt.Sprintf("上传方案新版本 v%d", nextVersion))
	})
	if err != nil {
		if uploadedRawKey != "" {
			_ = storage.DeleteObject(ctx, uploadedRawKey)
		}
		if uploadedAdaptedKey != "" && uploadedAdaptedKey != uploadedRawKey {
			_ = storage.DeleteObject(ctx, uploadedAdaptedKey)
		}
		return crm.ProposalUploadResponse{}, err
	}
	proposal, err := s.GetProposal(ctx, proposalID)
	if err != nil {
		return crm.ProposalUploadResponse{}, err
	}
	version, err := s.getProposalVersionItem(ctx, proposalID, nextVersion)
	if err != nil {
		return crm.ProposalUploadResponse{}, err
	}
	if proposal == nil || version == nil {
		return crm.ProposalUploadResponse{}, errors.New("proposal rows could not be reloaded")
	}
	return crm.ProposalUploadResponse{
		Proposal: proposal.Proposal, Version: *version, Warnings: ensureCRMProposalSlice(input.Warnings),
	}, nil
}

func (s *CRMStore) UpdateProposal(
	ctx context.Context,
	proposalID int64,
	input crm.ProposalUpdateInput,
	actorID string,
	isAdmin bool,
) (*crm.Proposal, error) {
	sets := []string{}
	args := []any{}
	nextArg := 1
	if input.Title.Set {
		if input.Title.Value == nil || strings.TrimSpace(*input.Title.Value) == "" {
			return nil, crm.NewAPIError(422, "title must contain at least 1 character")
		}
		sets = append(sets, "title = $"+strconv.Itoa(nextArg))
		args = append(args, crmProposalTitle(input.Title.Value, "未命名方案"))
		nextArg++
	}
	if input.ProposalType.Set && input.ProposalType.Value != nil {
		switch *input.ProposalType.Value {
		case "onboarding", "operation", "quotation", "research", "other":
		default:
			return nil, crm.NewAPIError(400, "无效的方案类型")
		}
		sets = append(sets, "proposal_type = $"+strconv.Itoa(nextArg))
		args = append(args, *input.ProposalType.Value)
		nextArg++
	}
	if input.Status.Set && input.Status.Value != nil {
		switch *input.Status.Value {
		case "draft", "published", "archived":
		default:
			return nil, crm.NewAPIError(422, "invalid proposal status")
		}
		sets = append(sets, "status = $"+strconv.Itoa(nextArg))
		args = append(args, *input.Status.Value)
		nextArg++
	}
	if input.CustomerID.Set {
		if err := s.assertProposalCustomerVisible(ctx, input.CustomerID.Value, actorID, isAdmin); err != nil {
			return nil, err
		}
		if input.CustomerID.Value == nil {
			sets = append(sets, "customer_id = null")
		} else {
			sets = append(sets, "customer_id = $"+strconv.Itoa(nextArg))
			args = append(args, *input.CustomerID.Value)
			nextArg++
		}
	}
	if len(sets) == 0 {
		err := s.inTx(ctx, func(db FullDB) error {
			var exists int
			if err := db.QueryRow(ctx, `
				select 1 from public.crm_proposals where id = $1 for update
			`, proposalID).Scan(&exists); err != nil {
				return err
			}
			return insertCRMAudit(ctx, db, "proposal", proposalID, "update", actorID, "编辑方案")
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		proposal, err := s.GetProposal(ctx, proposalID)
		if err != nil || proposal == nil {
			return nil, err
		}
		return &proposal.Proposal, nil
	}
	args = append(args, proposalID)
	err := s.inTx(ctx, func(db FullDB) error {
		var title string
		if err := db.QueryRow(ctx, `
			select title from public.crm_proposals where id = $1 for update
		`, proposalID).Scan(&title); err != nil {
			return err
		}
		if _, err := db.Exec(ctx, `
			update public.crm_proposals
			set `+strings.Join(sets, ", ")+`, updated_at = now()
			where id = $`+strconv.Itoa(nextArg),
			args...,
		); err != nil {
			return err
		}
		action := "update"
		if input.Status.Set {
			action = "status"
		}
		return insertCRMAudit(ctx, db, "proposal", proposalID, action, actorID, "编辑方案 "+title)
	})
	if err != nil {
		return nil, err
	}
	proposal, err := s.GetProposal(ctx, proposalID)
	if err != nil {
		return nil, err
	}
	if proposal == nil {
		return nil, nil
	}
	return &proposal.Proposal, nil
}

func (s *CRMStore) DeleteProposal(
	ctx context.Context,
	proposalID int64,
	actorID string,
	storage crm.ProposalStorage,
) error {
	if storage == nil {
		return crm.NewAPIError(503, "云存储未配置，请联系管理员")
	}
	rows, err := s.db.Query(ctx, `
		select raw_r2_key, adapted_r2_key
		from public.crm_proposal_versions
		where proposal_id = $1
	`, proposalID)
	if err != nil {
		return err
	}
	type keys struct{ raw, adapted string }
	values := []keys{}
	for rows.Next() {
		var value keys
		if err := rows.Scan(&value.raw, &value.adapted); err != nil {
			rows.Close()
			return err
		}
		values = append(values, value)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	deleted := map[string]bool{}
	for _, value := range values {
		for _, key := range []string{value.raw, value.adapted} {
			if key == "" || deleted[key] {
				continue
			}
			deleted[key] = true
			_ = storage.DeleteObject(ctx, key)
		}
	}
	return s.inTx(ctx, func(db FullDB) error {
		var title string
		if err := db.QueryRow(ctx, `
			select title from public.crm_proposals where id = $1 for update
		`, proposalID).Scan(&title); err != nil {
			return err
		}
		if _, err := db.Exec(ctx, `delete from public.crm_proposals where id = $1`, proposalID); err != nil {
			return err
		}
		return insertCRMAudit(ctx, db, "proposal", proposalID, "delete", actorID, "删除客户方案 "+title)
	})
}

func (s *CRMStore) GetProposalVersionRecord(
	ctx context.Context,
	proposalID int64,
	versionNo int,
) (*crm.ProposalVersionRecord, error) {
	var record crm.ProposalVersionRecord
	err := s.db.QueryRow(ctx, `
		select proposal_id, version_no, raw_r2_key, adapted_r2_key,
		       original_filename, content_type
		from public.crm_proposal_versions
		where proposal_id = $1 and version_no = $2
	`, proposalID, versionNo).Scan(
		&record.ProposalID, &record.VersionNo, &record.RawKey,
		&record.AdaptedKey, &record.OriginalFilename, &record.ContentType,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &record, nil
}

type LocalProposalStorage struct {
	root string
}

func NewLocalProposalStorage(root string) (*LocalProposalStorage, error) {
	root = strings.TrimSpace(root)
	if root == "" {
		return nil, errors.New("proposal storage root is required")
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(absolute, 0o700); err != nil {
		return nil, err
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return nil, err
	}
	return &LocalProposalStorage{root: resolved}, nil
}

func (storage *LocalProposalStorage) safePath(key string) (string, error) {
	key = strings.TrimSpace(key)
	if key == "" || strings.HasPrefix(key, "/") || strings.HasPrefix(key, "\\") ||
		strings.Contains(key, "..") {
		return "", fmt.Errorf("unsafe storage key")
	}
	path := filepath.Join(storage.root, filepath.FromSlash(key))
	relative, err := filepath.Rel(storage.root, path)
	if err != nil || relative == "." || strings.HasPrefix(relative, "..") {
		return "", fmt.Errorf("unsafe storage key")
	}
	return path, nil
}

func (storage *LocalProposalStorage) ensureResolvedWithinRoot(path string) error {
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return err
	}
	relative, err := filepath.Rel(storage.root, resolved)
	if err != nil || relative == "." || strings.HasPrefix(relative, "..") {
		return fmt.Errorf("unsafe storage path")
	}
	return nil
}

func (storage *LocalProposalStorage) PutObject(
	_ context.Context,
	key string,
	data []byte,
	_ string,
) error {
	path, err := storage.safePath(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	if err := storage.ensureResolvedWithinRoot(filepath.Dir(path)); err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".proposal-*")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	defer os.Remove(tempName)
	if err := temp.Chmod(0o600); err != nil {
		_ = temp.Close()
		return err
	}
	if _, err := temp.Write(data); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(tempName, path)
}

func (storage *LocalProposalStorage) GetObject(_ context.Context, key string) ([]byte, error) {
	path, err := storage.safePath(key)
	if err != nil {
		return nil, err
	}
	if err := storage.ensureResolvedWithinRoot(path); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, crm.NewAPIError(404, "方案文件不存在")
		}
		return nil, err
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, crm.NewAPIError(404, "方案文件不存在")
	}
	return data, err
}

func (storage *LocalProposalStorage) DeleteObject(_ context.Context, key string) error {
	path, err := storage.safePath(key)
	if err != nil {
		return err
	}
	if resolvedErr := storage.ensureResolvedWithinRoot(path); errors.Is(resolvedErr, os.ErrNotExist) {
		return nil
	} else if resolvedErr != nil {
		return resolvedErr
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

type localChunkMeta struct {
	UploadID        string  `json:"upload_id"`
	OwnerID         *string `json:"owner_id"`
	Filename        string  `json:"filename"`
	Size            int64   `json:"size"`
	ContentType     string  `json:"content_type"`
	Title           *string `json:"title"`
	ProposalType    *string `json:"proposal_type"`
	CustomerID      *int64  `json:"customer_id"`
	ProposalID      *int64  `json:"proposal_id"`
	ChangeNote      *string `json:"change_note"`
	Status          string  `json:"status"`
	ChunkSize       int64   `json:"chunk_size"`
	TotalChunks     int     `json:"total_chunks"`
	CreatedAt       string  `json:"created_at"`
	ExpiresAt       string  `json:"expires_at"`
	FinalProposalID *int64  `json:"proposal_id_final"`
	FinalVersionNo  *int    `json:"version_no"`
}

const crmChunkSize = int64(3 << 20)
const crmChunkTTL = 2 * time.Hour

var crmUploadIDPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

func (storage *LocalProposalStorage) chunkRoot() string {
	return filepath.Join(storage.root, "_crm_proposal_tmp")
}

func (storage *LocalProposalStorage) uploadDirectory(uploadID string) (string, error) {
	if !crmUploadIDPattern.MatchString(uploadID) {
		return "", crm.NewAPIError(400, "非法 upload_id")
	}
	return filepath.Join(storage.chunkRoot(), uploadID), nil
}

func (storage *LocalProposalStorage) writeMeta(uploadID string, meta localChunkMeta) error {
	dir, err := storage.uploadDirectory(uploadID)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := storage.ensureResolvedWithinRoot(dir); err != nil {
		return err
	}
	data, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	path := filepath.Join(dir, "meta.json")
	temp, err := os.CreateTemp(dir, ".meta-*")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	defer os.Remove(tempName)
	if err := temp.Chmod(0o600); err != nil {
		_ = temp.Close()
		return err
	}
	if _, err := temp.Write(data); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(tempName, path)
}

func (storage *LocalProposalStorage) readMeta(uploadID string) (localChunkMeta, error) {
	dir, err := storage.uploadDirectory(uploadID)
	if err != nil {
		return localChunkMeta{}, err
	}
	if err := storage.ensureResolvedWithinRoot(dir); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return localChunkMeta{}, crm.NewAPIError(404, "上传会话不存在或已过期")
		}
		return localChunkMeta{}, err
	}
	data, err := os.ReadFile(filepath.Join(dir, "meta.json"))
	if errors.Is(err, os.ErrNotExist) {
		return localChunkMeta{}, crm.NewAPIError(404, "上传会话不存在或已过期")
	}
	if err != nil {
		return localChunkMeta{}, err
	}
	var meta localChunkMeta
	if err := json.Unmarshal(data, &meta); err != nil {
		return localChunkMeta{}, crm.NewAPIError(404, "上传会话不存在或已过期")
	}
	return meta, nil
}

func (storage *LocalProposalStorage) authorizeChunk(meta localChunkMeta, ownerID *string, isAdmin bool) error {
	if isAdmin {
		return nil
	}
	current := ""
	if ownerID != nil {
		current = strings.TrimSpace(*ownerID)
	}
	expected := ""
	if meta.OwnerID != nil {
		expected = strings.TrimSpace(*meta.OwnerID)
	}
	if current == "" || expected != current {
		return crm.NewAPIError(403, "Not the upload owner")
	}
	return nil
}

func (storage *LocalProposalStorage) validateChunkMeta(meta localChunkMeta, ownerID *string, isAdmin bool) error {
	if err := storage.authorizeChunk(meta, ownerID, isAdmin); err != nil {
		return err
	}
	expiresAt, err := time.Parse(time.RFC3339, meta.ExpiresAt)
	if err == nil && !expiresAt.After(time.Now()) {
		return crm.NewAPIError(410, "上传会话已过期")
	}
	return nil
}

func randomUploadID() (string, error) {
	data := make([]byte, 16)
	if _, err := rand.Read(data); err != nil {
		return "", err
	}
	return hex.EncodeToString(data), nil
}

func (storage *LocalProposalStorage) InitChunkUpload(
	_ context.Context,
	input crm.ChunkUploadInitInput,
) (crm.ChunkUploadMeta, error) {
	if input.Size <= 0 {
		return crm.ChunkUploadMeta{}, crm.NewAPIError(400, "文件为空")
	}
	if input.Size > 20<<20 {
		return crm.ChunkUploadMeta{}, crm.NewAPIError(413, "文件超过 20971520 字节上限")
	}
	if crmProposalFileFormat(input.Filename, input.ContentType) == "" {
		return crm.ChunkUploadMeta{}, crm.NewAPIError(400,
			"不支持的文件类型：仅接受单个 HTML（.html / .htm）或 PDF（.pdf）文件")
	}
	storage.cleanupExpiredChunks()
	uploadID, err := randomUploadID()
	if err != nil {
		return crm.ChunkUploadMeta{}, err
	}
	dir, err := storage.uploadDirectory(uploadID)
	if err != nil {
		return crm.ChunkUploadMeta{}, err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return crm.ChunkUploadMeta{}, err
	}
	if err := storage.ensureResolvedWithinRoot(dir); err != nil {
		return crm.ChunkUploadMeta{}, err
	}
	totalChunks := int((input.Size + crmChunkSize - 1) / crmChunkSize)
	now := time.Now().UTC()
	meta := localChunkMeta{
		UploadID: uploadID, OwnerID: cleanCRMString(input.OwnerID),
		Filename: input.Filename, Size: input.Size,
		ContentType: crmProposalContentType(input.Filename, input.ContentType),
		Title:       input.Title, ProposalType: input.ProposalType,
		CustomerID: input.CustomerID, ProposalID: input.ProposalID,
		ChangeNote: input.ChangeNote, Status: "pending",
		ChunkSize: crmChunkSize, TotalChunks: totalChunks,
		CreatedAt: timestampValue(now),
		ExpiresAt: timestampValue(now.Add(crmChunkTTL)),
	}
	if err := storage.writeMeta(uploadID, meta); err != nil {
		return crm.ChunkUploadMeta{}, err
	}
	return localChunkMetaToAPI(meta), nil
}

func cleanCRMString(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func localChunkMetaToAPI(meta localChunkMeta) crm.ChunkUploadMeta {
	return crm.ChunkUploadMeta{
		UploadID: meta.UploadID, OwnerID: meta.OwnerID, Filename: meta.Filename,
		Size: meta.Size, ContentType: meta.ContentType, Title: meta.Title,
		ProposalType: meta.ProposalType, CustomerID: meta.CustomerID,
		ProposalID: meta.ProposalID, ChangeNote: meta.ChangeNote,
		Status: meta.Status, ChunkSize: meta.ChunkSize, TotalChunks: meta.TotalChunks,
		ExpiresAt: meta.ExpiresAt, FinalProposalID: meta.FinalProposalID,
		FinalVersionNo: meta.FinalVersionNo,
	}
}

func (storage *LocalProposalStorage) WriteChunk(
	_ context.Context,
	uploadID string,
	index int,
	data []byte,
	ownerID *string,
	isAdmin bool,
) (int64, error) {
	meta, err := storage.readMeta(uploadID)
	if err != nil {
		return 0, err
	}
	if err := storage.validateChunkMeta(meta, ownerID, isAdmin); err != nil {
		return 0, err
	}
	if meta.Status != "pending" {
		return 0, crm.NewAPIError(409, "上传会话已结束")
	}
	if index < 0 || index >= meta.TotalChunks {
		return 0, crm.NewAPIError(400, "分段序号越界")
	}
	if int64(len(data)) > crmChunkSize {
		return 0, crm.NewAPIError(413, "单个分段超过 3MB")
	}
	expected := meta.ChunkSize
	if remaining := meta.Size - int64(index)*meta.ChunkSize; remaining < expected {
		expected = remaining
	}
	if int64(len(data)) != expected {
		return 0, crm.NewAPIError(400, "分段大小与声明不一致")
	}
	dir, err := storage.uploadDirectory(uploadID)
	if err != nil {
		return 0, err
	}
	path := filepath.Join(dir, fmt.Sprintf("%05d.part", index))
	if info, statErr := os.Lstat(path); statErr == nil && info.Mode()&os.ModeSymlink != 0 {
		return 0, fmt.Errorf("unsafe chunk path")
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return 0, err
	}
	return int64(len(data)), nil
}

func (storage *LocalProposalStorage) ReadChunkUpload(
	_ context.Context,
	uploadID string,
	ownerID *string,
	isAdmin bool,
) (crm.ChunkUploadMeta, error) {
	meta, err := storage.readMeta(uploadID)
	if err != nil {
		return crm.ChunkUploadMeta{}, err
	}
	if err := storage.validateChunkMeta(meta, ownerID, isAdmin); err != nil {
		return crm.ChunkUploadMeta{}, err
	}
	return localChunkMetaToAPI(meta), nil
}

func (storage *LocalProposalStorage) AssembleChunkUpload(
	_ context.Context,
	uploadID string,
	ownerID *string,
	isAdmin bool,
) ([]byte, crm.ChunkUploadMeta, error) {
	meta, err := storage.readMeta(uploadID)
	if err != nil {
		return nil, crm.ChunkUploadMeta{}, err
	}
	if err := storage.validateChunkMeta(meta, ownerID, isAdmin); err != nil {
		return nil, crm.ChunkUploadMeta{}, err
	}
	if meta.Status == "finalized" {
		return nil, crm.ChunkUploadMeta{}, crm.NewAPIError(409, "该上传已收尾")
	}
	if meta.Status != "pending" {
		return nil, crm.ChunkUploadMeta{}, crm.NewAPIError(409, "上传会话状态异常")
	}
	dir, err := storage.uploadDirectory(uploadID)
	if err != nil {
		return nil, crm.ChunkUploadMeta{}, err
	}
	buffer := make([]byte, 0, meta.Size)
	for index := 0; index < meta.TotalChunks; index++ {
		path := filepath.Join(dir, fmt.Sprintf("%05d.part", index))
		if err := storage.ensureResolvedWithinRoot(path); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return nil, crm.ChunkUploadMeta{}, crm.NewAPIError(400, "分段不完整")
			}
			return nil, crm.ChunkUploadMeta{}, err
		}
		data, err := os.ReadFile(path)
		if errors.Is(err, os.ErrNotExist) {
			return nil, crm.ChunkUploadMeta{}, crm.NewAPIError(400, "分段不完整")
		}
		if err != nil {
			return nil, crm.ChunkUploadMeta{}, err
		}
		buffer = append(buffer, data...)
	}
	if int64(len(buffer)) != meta.Size {
		return nil, crm.ChunkUploadMeta{}, crm.NewAPIError(400, "合并后大小与声明不一致")
	}
	meta.Status = "assembling"
	if err := storage.writeMeta(uploadID, meta); err != nil {
		return nil, crm.ChunkUploadMeta{}, err
	}
	return buffer, localChunkMetaToAPI(meta), nil
}

func (storage *LocalProposalStorage) MarkChunkUploadFinalized(
	_ context.Context,
	uploadID string,
	proposalID int64,
	versionNo int,
) error {
	meta, err := storage.readMeta(uploadID)
	if err != nil {
		return err
	}
	meta.Status = "finalized"
	meta.FinalProposalID = &proposalID
	meta.FinalVersionNo = &versionNo
	return storage.writeMeta(uploadID, meta)
}

func (storage *LocalProposalStorage) cleanupExpiredChunks() {
	root := storage.chunkRoot()
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	now := time.Now()
	for _, entry := range entries {
		if !entry.IsDir() || !crmUploadIDPattern.MatchString(entry.Name()) {
			continue
		}
		meta, err := storage.readMeta(entry.Name())
		if err != nil {
			continue
		}
		expiresAt, err := time.Parse(time.RFC3339, meta.ExpiresAt)
		if err != nil || expiresAt.After(now) {
			continue
		}
		_ = os.RemoveAll(filepath.Join(root, entry.Name()))
	}
}

var _ crm.ProposalStorage = (*LocalProposalStorage)(nil)
