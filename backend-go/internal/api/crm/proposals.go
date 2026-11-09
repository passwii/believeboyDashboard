package crm

import (
	"bytes"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/transform"
)

const (
	proposalMaxBytes      = 20 << 20
	proposalChunkMaxBytes = 3 << 20
)

var (
	proposalCharsetPattern = regexp.MustCompile(`charset=["']?([A-Za-z0-9_-]+)`)
	proposalHeadOpen       = regexp.MustCompile(`<head\b[^>]*>`)
	proposalHTMLOpen       = regexp.MustCompile(`<html\b[^>]*>`)
	proposalDoctype        = regexp.MustCompile(`<!doctype\b`)
	proposalThemeMarker    = regexp.MustCompile(`id=["']bb-proposal-theme["']`)
	proposalReference      = regexp.MustCompile(`(?:href|src)=["']([^"']+)["']`)
)

func (handler *Handler) ListProposals(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	scope, err := ResolveProposalScope(r.URL.Query().Get("scope"))
	if err != nil {
		WriteError(w, err)
		return
	}
	page, pageSize, err := parsePage(r, 20, maxProposalPageSize)
	if err != nil {
		WriteError(w, err)
		return
	}
	filters, err := flattenProposalFilters(r.URL.Query().Get("filters"))
	if err != nil {
		WriteError(w, err)
		return
	}
	keyword := optionalString(r.URL.Query().Get("keyword"))
	if keyword != nil && len([]rune(*keyword)) > 200 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "keyword is too long")
		return
	}
	sortBy := r.URL.Query().Get("sort_by")
	if sortBy == "" {
		sortBy = "updated_at"
	}
	sortOrder := r.URL.Query().Get("sort_order")
	if sortOrder == "" {
		sortOrder = "desc"
	}
	result, err := handler.store.ListProposals(r.Context(), ProposalListFilter{
		Scope:     scope,
		Keyword:   keyword,
		Filters:   filters,
		SortBy:    sortBy,
		SortOrder: sortOrder,
		Page:      page,
		PageSize:  pageSize,
	}, optionalString(identity.UserID), identity.IsAdmin)
	if err != nil {
		WriteError(w, err)
		return
	}
	result.Items = ensureSlice(result.Items)
	writeJSON(w, http.StatusOK, result)
}

func (handler *Handler) GetProposal(w http.ResponseWriter, r *http.Request) {
	proposalID, err := parsePathID(r, "proposal_id")
	if err != nil {
		WriteError(w, err)
		return
	}
	item, err := handler.store.GetProposal(r.Context(), proposalID)
	if err != nil {
		WriteError(w, err)
		return
	}
	if item == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "方案不存在")
		return
	}
	item.Versions = ensureSlice(item.Versions)
	writeJSON(w, http.StatusOK, item)
}

func (handler *Handler) InitProposalChunkUpload(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	if handler.storage == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "云存储未配置，请联系管理员")
		return
	}
	var raw struct {
		Filename     string  `json:"filename"`
		Size         int64   `json:"size"`
		ContentType  string  `json:"content_type"`
		Title        *string `json:"title"`
		ProposalType string  `json:"proposal_type"`
		CustomerID   *int64  `json:"customer_id"`
		ChangeNote   *string `json:"change_note"`
	}
	if err := decodeJSON(r, &raw, false); err != nil {
		WriteError(w, err)
		return
	}
	if raw.ProposalType == "" {
		raw.ProposalType = "other"
	}
	if err := validateProposalInitMetadata(raw.Filename, raw.Size, raw.Title, raw.ChangeNote); err != nil {
		WriteError(w, err)
		return
	}
	if err := validateProposalType(raw.ProposalType); err != nil {
		WriteError(w, err)
		return
	}
	if err := handler.validateProposalCustomer(r, raw.CustomerID, identity); err != nil {
		WriteError(w, err)
		return
	}
	meta, err := handler.storage.InitChunkUpload(r.Context(), ChunkUploadInitInput{
		OwnerID:      optionalString(identity.UserID),
		Filename:     raw.Filename,
		Size:         raw.Size,
		ContentType:  raw.ContentType,
		Title:        raw.Title,
		ProposalType: &raw.ProposalType,
		CustomerID:   raw.CustomerID,
		ChangeNote:   raw.ChangeNote,
	})
	if err != nil {
		WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ChunkUploadInitResponse{
		UploadID:    meta.UploadID,
		ChunkSize:   meta.ChunkSize,
		TotalChunks: meta.TotalChunks,
		ExpiresAt:   meta.ExpiresAt,
	})
}

func (handler *Handler) InitProposalVersionChunkUpload(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	if handler.storage == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "云存储未配置，请联系管理员")
		return
	}
	proposalID, err := parsePathID(r, "proposal_id")
	if err != nil {
		WriteError(w, err)
		return
	}
	proposal, err := handler.store.GetProposal(r.Context(), proposalID)
	if err != nil {
		WriteError(w, err)
		return
	}
	if proposal == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "方案不存在")
		return
	}
	if err := RequireOwnerOrAdmin(proposal.OwnerID, identity); err != nil {
		WriteError(w, err)
		return
	}
	var raw struct {
		Filename    string  `json:"filename"`
		Size        int64   `json:"size"`
		ContentType string  `json:"content_type"`
		ChangeNote  *string `json:"change_note"`
	}
	if err := decodeJSON(r, &raw, false); err != nil {
		WriteError(w, err)
		return
	}
	if err := validateProposalInitMetadata(raw.Filename, raw.Size, nil, raw.ChangeNote); err != nil {
		WriteError(w, err)
		return
	}
	meta, err := handler.storage.InitChunkUpload(r.Context(), ChunkUploadInitInput{
		OwnerID:     optionalString(identity.UserID),
		Filename:    raw.Filename,
		Size:        raw.Size,
		ContentType: raw.ContentType,
		ChangeNote:  raw.ChangeNote,
		ProposalID:  &proposalID,
	})
	if err != nil {
		WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ChunkUploadInitResponse{
		UploadID:    meta.UploadID,
		ChunkSize:   meta.ChunkSize,
		TotalChunks: meta.TotalChunks,
		ExpiresAt:   meta.ExpiresAt,
	})
}

func (handler *Handler) UploadProposalChunk(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	if handler.storage == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "云存储未配置，请联系管理员")
		return
	}
	uploadID := chi.URLParam(r, "upload_id")
	index, err := strconv.Atoi(chi.URLParam(r, "index"))
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "invalid index")
		return
	}
	data, err := ioReadAllLimited(r.Body, proposalChunkMaxBytes)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusRequestEntityTooLarge, "单个分段超过 3MB")
		return
	}
	size, err := handler.storage.WriteChunk(
		r.Context(),
		uploadID,
		index,
		data,
		optionalString(identity.UserID),
		identity.IsAdmin,
	)
	if err != nil {
		WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ChunkUploadResponse{Received: index, Size: size})
}

func (handler *Handler) FinalizeProposalChunkUpload(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	if handler.storage == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "云存储未配置，请联系管理员")
		return
	}
	uploadID := chi.URLParam(r, "upload_id")
	meta, err := handler.storage.ReadChunkUpload(
		r.Context(),
		uploadID,
		optionalString(identity.UserID),
		identity.IsAdmin,
	)
	if err != nil {
		WriteError(w, err)
		return
	}
	if meta.Status == "finalized" && meta.FinalProposalID != nil && meta.FinalVersionNo != nil {
		proposal, getErr := handler.store.GetProposal(r.Context(), *meta.FinalProposalID)
		if getErr != nil || proposal == nil {
			httpapi.WriteDetail(w, http.StatusConflict, "上传已收尾但结果不可读取")
			return
		}
		var version *ProposalVersion
		for index := range proposal.Versions {
			if proposal.Versions[index].VersionNo == *meta.FinalVersionNo {
				version = &proposal.Versions[index]
				break
			}
		}
		if version == nil {
			httpapi.WriteDetail(w, http.StatusConflict, "上传已收尾但结果不可读取")
			return
		}
		writeJSON(w, http.StatusCreated, ProposalUploadResponse{
			Proposal: proposal.Proposal,
			Version:  *version,
			Warnings: []string{},
		})
		return
	}
	rawBytes, meta, err := handler.storage.AssembleChunkUpload(
		r.Context(),
		uploadID,
		optionalString(identity.UserID),
		identity.IsAdmin,
	)
	if err != nil {
		WriteError(w, err)
		return
	}
	if err := handler.validateProposalBytes(meta.Filename, rawBytes); err != nil {
		WriteError(w, err)
		return
	}
	adapted, warnings := adaptProposalHTML(rawBytes, meta.Filename)
	if meta.ProposalID != nil {
		proposal, getErr := handler.store.GetProposal(r.Context(), *meta.ProposalID)
		if getErr != nil || proposal == nil {
			httpapi.WriteDetail(w, http.StatusNotFound, "方案不存在")
			return
		}
		if err := RequireOwnerOrAdmin(proposal.OwnerID, identity); err != nil {
			WriteError(w, err)
			return
		}
		response, addErr := handler.store.AddProposalVersion(r.Context(), *meta.ProposalID, ProposalAddVersionInput{
			Filename:     meta.Filename,
			ContentType:  meta.ContentType,
			RawBytes:     rawBytes,
			AdaptedBytes: adapted,
			Warnings:     warnings,
			ChangeNote:   meta.ChangeNote,
		}, identity.UserID, handler.storage)
		if addErr != nil {
			WriteError(w, addErr)
			return
		}
		if err := handler.storage.MarkChunkUploadFinalized(r.Context(), uploadID, response.Proposal.ID, response.Version.VersionNo); err != nil {
			WriteError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, response)
		return
	}
	proposalType := "other"
	if meta.ProposalType != nil && *meta.ProposalType != "" {
		proposalType = *meta.ProposalType
	}
	if err := validateProposalType(proposalType); err != nil {
		WriteError(w, err)
		return
	}
	if err := handler.validateProposalCustomer(r, meta.CustomerID, identity); err != nil {
		WriteError(w, err)
		return
	}
	response, createErr := handler.store.CreateProposal(r.Context(), ProposalCreateInput{
		Title:        meta.Title,
		ProposalType: proposalType,
		CustomerID:   meta.CustomerID,
		Filename:     meta.Filename,
		ContentType:  meta.ContentType,
		RawBytes:     rawBytes,
		AdaptedBytes: adapted,
		Warnings:     warnings,
	}, identity.UserID, identity.IsAdmin, handler.storage)
	if createErr != nil {
		WriteError(w, createErr)
		return
	}
	if err := handler.storage.MarkChunkUploadFinalized(r.Context(), uploadID, response.Proposal.ID, response.Version.VersionNo); err != nil {
		WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, response)
}

func (handler *Handler) CreateProposal(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	if handler.storage == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "云存储未配置，请联系管理员")
		return
	}
	if err := r.ParseMultipartForm(proposalMaxBytes + 1<<20); err != nil {
		WriteError(w, malformedMultipart(err))
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "file is required")
		return
	}
	defer file.Close()
	rawBytes, err := ioReadAllLimited(file, proposalMaxBytes)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusRequestEntityTooLarge, "文件超过 20971520 字节上限")
		return
	}
	if err := handler.validateProposalBytes(header.Filename, rawBytes); err != nil {
		WriteError(w, err)
		return
	}
	proposalType := strings.TrimSpace(r.FormValue("proposal_type"))
	if proposalType == "" {
		proposalType = "other"
	}
	if err := validateProposalType(proposalType); err != nil {
		WriteError(w, err)
		return
	}
	title := optionalString(r.FormValue("title"))
	if title != nil && len([]rune(*title)) > 200 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "title is too long")
		return
	}
	var customerID *int64
	if raw := strings.TrimSpace(r.FormValue("customer_id")); raw != "" {
		value, parseErr := strconv.ParseInt(raw, 10, 64)
		if parseErr != nil {
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "customer_id must be an integer")
			return
		}
		customerID = &value
	}
	if err := handler.validateProposalCustomer(r, customerID, identity); err != nil {
		WriteError(w, err)
		return
	}
	adapted, warnings := adaptProposalHTML(rawBytes, header.Filename)
	response, err := handler.store.CreateProposal(r.Context(), ProposalCreateInput{
		Title:        title,
		ProposalType: proposalType,
		CustomerID:   customerID,
		Filename:     header.Filename,
		ContentType:  header.Header.Get("Content-Type"),
		RawBytes:     rawBytes,
		AdaptedBytes: adapted,
		Warnings:     warnings,
	}, identity.UserID, identity.IsAdmin, handler.storage)
	if err != nil {
		WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, response)
}

func (handler *Handler) AddProposalVersion(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	if handler.storage == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "云存储未配置，请联系管理员")
		return
	}
	proposalID, err := parsePathID(r, "proposal_id")
	if err != nil {
		WriteError(w, err)
		return
	}
	proposal, err := handler.store.GetProposal(r.Context(), proposalID)
	if err != nil {
		WriteError(w, err)
		return
	}
	if proposal == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "方案不存在")
		return
	}
	if err := RequireOwnerOrAdmin(proposal.OwnerID, identity); err != nil {
		WriteError(w, err)
		return
	}
	if err := r.ParseMultipartForm(proposalMaxBytes + 1<<20); err != nil {
		WriteError(w, malformedMultipart(err))
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "file is required")
		return
	}
	defer file.Close()
	rawBytes, err := ioReadAllLimited(file, proposalMaxBytes)
	if err != nil {
		httpapi.WriteDetail(w, http.StatusRequestEntityTooLarge, "文件超过 20971520 字节上限")
		return
	}
	if err := handler.validateProposalBytes(header.Filename, rawBytes); err != nil {
		WriteError(w, err)
		return
	}
	changeNote := optionalString(r.FormValue("change_note"))
	if changeNote != nil && len([]rune(*changeNote)) > 500 {
		httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "change_note is too long")
		return
	}
	adapted, warnings := adaptProposalHTML(rawBytes, header.Filename)
	response, err := handler.store.AddProposalVersion(r.Context(), proposalID, ProposalAddVersionInput{
		Filename:     header.Filename,
		ContentType:  header.Header.Get("Content-Type"),
		RawBytes:     rawBytes,
		AdaptedBytes: adapted,
		Warnings:     warnings,
		ChangeNote:   changeNote,
	}, identity.UserID, handler.storage)
	if err != nil {
		WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, response)
}

func (handler *Handler) UpdateProposal(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	proposalID, err := parsePathID(r, "proposal_id")
	if err != nil {
		WriteError(w, err)
		return
	}
	proposal, err := handler.store.GetProposal(r.Context(), proposalID)
	if err != nil {
		WriteError(w, err)
		return
	}
	if proposal == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "方案不存在")
		return
	}
	if err := RequireOwnerOrAdmin(proposal.OwnerID, identity); err != nil {
		WriteError(w, err)
		return
	}
	var input ProposalUpdateInput
	if err := decodeJSON(r, &input, false); err != nil {
		WriteError(w, err)
		return
	}
	if input.ProposalType.Set && input.ProposalType.Value != nil {
		if err := validateProposalType(*input.ProposalType.Value); err != nil {
			WriteError(w, err)
			return
		}
	}
	if input.Status.Set && input.Status.Value != nil {
		switch *input.Status.Value {
		case "draft", "published", "archived":
		default:
			httpapi.WriteDetail(w, http.StatusUnprocessableEntity, "invalid proposal status")
			return
		}
	}
	if input.Title.Set && input.Title.Value != nil {
		trimmed := strings.TrimSpace(*input.Title.Value)
		input.Title.Value = &trimmed
		if err := validateLength(trimmed, 1, 200, "title"); err != nil {
			WriteError(w, err)
			return
		}
	}
	if input.CustomerID.Set {
		if err := handler.validateProposalCustomer(r, input.CustomerID.Value, identity); err != nil {
			WriteError(w, err)
			return
		}
	}
	item, err := handler.store.UpdateProposal(r.Context(), proposalID, input, identity.UserID, identity.IsAdmin)
	if err != nil {
		WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (handler *Handler) DeleteProposal(w http.ResponseWriter, r *http.Request) {
	identity := requestIdentity(r)
	if handler.storage == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "云存储未配置，请联系管理员")
		return
	}
	proposalID, err := parsePathID(r, "proposal_id")
	if err != nil {
		WriteError(w, err)
		return
	}
	proposal, err := handler.store.GetProposal(r.Context(), proposalID)
	if err != nil {
		WriteError(w, err)
		return
	}
	if proposal == nil {
		httpapi.WriteDetail(w, http.StatusNotFound, "方案不存在")
		return
	}
	if err := RequireOwnerOrAdmin(proposal.OwnerID, identity); err != nil {
		WriteError(w, err)
		return
	}
	if err := handler.store.DeleteProposal(r.Context(), proposalID, identity.UserID, handler.storage); err != nil {
		WriteError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (handler *Handler) GetProposalVersionContent(w http.ResponseWriter, r *http.Request) {
	if handler.storage == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "云存储未配置，请联系管理员")
		return
	}
	proposalID, versionNo, proposal, record, err := handler.resolveProposalVersion(w, r)
	if err != nil || record == nil || proposal == nil {
		return
	}
	if proposalFileFormat(record.OriginalFilename, record.ContentType) == "pdf" {
		httpapi.WriteDetail(w, http.StatusUnsupportedMediaType, "PDF 版本没有 HTML 文本，请使用下载端点获取字节")
		return
	}
	raw := r.URL.Query().Get("raw") == "true" || r.URL.Query().Get("raw") == "1"
	key := record.AdaptedKey
	if raw {
		key = record.RawKey
	}
	data, err := handler.storage.GetObject(r.Context(), key)
	if err != nil {
		WriteError(w, err)
		return
	}
	content := string(data)
	if raw {
		content = decodeHTMLBytes(data)
	}
	writeJSON(w, http.StatusOK, ProposalContentResponse{
		ProposalID: proposalID,
		VersionNo:  versionNo,
		Title:      proposal.Title,
		Content:    content,
	})
}

func (handler *Handler) DownloadProposalVersion(w http.ResponseWriter, r *http.Request) {
	if handler.storage == nil {
		httpapi.WriteDetail(w, http.StatusServiceUnavailable, "云存储未配置，请联系管理员")
		return
	}
	proposalID, versionNo, proposal, record, err := handler.resolveProposalVersion(w, r)
	if err != nil || record == nil || proposal == nil {
		return
	}
	_ = proposalID
	raw := r.URL.Query().Get("raw") == "true" || r.URL.Query().Get("raw") == "1"
	fileFormat := proposalFileFormat(record.OriginalFilename, record.ContentType)
	key := record.AdaptedKey
	if raw {
		key = record.RawKey
	}
	data, err := handler.storage.GetObject(r.Context(), key)
	if err != nil {
		WriteError(w, err)
		return
	}
	filename := buildProposalFilename(proposal.Title, versionNo, raw, fileFormat)
	fallback := "fallback.html"
	contentType := "text/html; charset=utf-8"
	if fileFormat == "pdf" {
		fallback = "fallback.pdf"
		contentType = "application/pdf"
	}
	encoded := url.QueryEscape(filename)
	encoded = strings.ReplaceAll(encoded, "+", "%20")
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"; filename*=UTF-8''%s`, fallback, encoded))
	w.Header().Set("Cache-Control", "private, no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func (handler *Handler) resolveProposalVersion(
	w http.ResponseWriter,
	r *http.Request,
) (int64, int, *ProposalDetail, *ProposalVersionRecord, error) {
	proposalID, err := parsePathID(r, "proposal_id")
	if err != nil {
		WriteError(w, err)
		return 0, 0, nil, nil, err
	}
	versionNo, err := strconv.Atoi(chi.URLParam(r, "version_no"))
	if err != nil || versionNo < 1 {
		err = NewAPIError(http.StatusUnprocessableEntity, "invalid version_no")
		WriteError(w, err)
		return 0, 0, nil, nil, err
	}
	proposal, err := handler.store.GetProposal(r.Context(), proposalID)
	if err != nil {
		WriteError(w, err)
		return 0, 0, nil, nil, err
	}
	if proposal == nil {
		err = NewAPIError(http.StatusNotFound, "方案不存在")
		WriteError(w, err)
		return 0, 0, nil, nil, err
	}
	record, err := handler.store.GetProposalVersionRecord(r.Context(), proposalID, versionNo)
	if err != nil {
		WriteError(w, err)
		return 0, 0, nil, nil, err
	}
	if record == nil {
		err = NewAPIError(http.StatusNotFound, "版本不存在")
		WriteError(w, err)
		return 0, 0, nil, nil, err
	}
	return proposalID, versionNo, proposal, record, nil
}

func (handler *Handler) validateProposalCustomer(
	r *http.Request,
	customerID *int64,
	identity Identity,
) error {
	if customerID == nil {
		return nil
	}
	customer, err := handler.store.GetCustomer(r.Context(), *customerID)
	if err != nil {
		return err
	}
	if customer == nil {
		return NewAPIError(http.StatusNotFound, "Customer not found")
	}
	if !identity.IsAdmin && customer.OwnerID != nil && *customer.OwnerID != identity.UserID {
		return NewAPIError(http.StatusForbidden, "Not the customer owner")
	}
	return nil
}

func (handler *Handler) validateProposalBytes(filename string, data []byte) error {
	if len(data) == 0 {
		return NewAPIError(http.StatusBadRequest, "文件为空")
	}
	if len(data) > proposalMaxBytes {
		return NewAPIError(http.StatusRequestEntityTooLarge, fmt.Sprintf("文件超过 %d 字节上限", proposalMaxBytes))
	}
	if proposalFileFormat(filename, "") == "" {
		return NewAPIError(http.StatusBadRequest, "不支持的文件类型：仅接受单个 HTML（.html / .htm）或 PDF（.pdf）文件")
	}
	return nil
}

func validateProposalType(value string) error {
	switch value {
	case "onboarding", "operation", "quotation", "research", "other":
		return nil
	default:
		return NewAPIError(http.StatusBadRequest, "无效的方案类型")
	}
}

func validateProposalInitMetadata(
	filename string,
	size int64,
	title *string,
	changeNote *string,
) error {
	filename = strings.TrimSpace(filename)
	if filename == "" || len([]rune(filename)) > 255 {
		return NewAPIError(http.StatusUnprocessableEntity, "filename must contain 1 to 255 characters")
	}
	if size <= 0 {
		return NewAPIError(http.StatusUnprocessableEntity, "size must be greater than 0")
	}
	if title != nil && len([]rune(*title)) > 200 {
		return NewAPIError(http.StatusUnprocessableEntity, "title is too long")
	}
	if changeNote != nil && len([]rune(*changeNote)) > 500 {
		return NewAPIError(http.StatusUnprocessableEntity, "change_note is too long")
	}
	return nil
}

func flattenProposalFilters(raw string) (map[string]any, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	var values []map[string]any
	if err := jsonUnmarshal(raw, &values); err != nil {
		return nil, NewAPIError(http.StatusBadRequest, "filters 非法 JSON")
	}
	result := map[string]any{}
	for _, condition := range values {
		field, ok := condition["field"].(string)
		if !ok || strings.TrimSpace(field) == "" {
			return nil, NewAPIError(http.StatusBadRequest, "方案筛选仅支持 {field, op:'eq', value} 形态")
		}
		if op, exists := condition["op"]; exists && op != nil && op != "eq" {
			return nil, NewAPIError(http.StatusBadRequest, "方案筛选仅支持 eq 运算符")
		}
		value := condition["value"]
		if number, ok := value.(json.Number); ok {
			if integer, err := number.Int64(); err == nil {
				value = integer
			} else if decimal, err := number.Float64(); err == nil {
				value = decimal
			}
		}
		if field == "customer_id" {
			switch typed := value.(type) {
			case json.Number:
				if integer, err := typed.Int64(); err == nil {
					value = integer
				}
			case float64:
				if typed == float64(int64(typed)) {
					value = int64(typed)
				}
			}
		}
		result[field] = value
	}
	return result, nil
}

func jsonUnmarshal(raw string, target any) error {
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.UseNumber()
	return decoder.Decode(target)
}

func proposalFileFormat(filename, contentType string) string {
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

func normalizeProposalContentType(filename, declared string) string {
	format := proposalFileFormat(filename, declared)
	if format == "pdf" {
		return "application/pdf"
	}
	if format == "html" && strings.Contains(strings.ToLower(declared), "pdf") {
		return "text/html"
	}
	if strings.TrimSpace(declared) == "" {
		return "text/html"
	}
	return declared
}

func adaptProposalHTML(raw []byte, filename string) ([]byte, []string) {
	if proposalFileFormat(filename, "") == "pdf" {
		return nil, []string{}
	}
	text := decodeHTMLBytes(raw)
	warnings := proposalRelativeWarnings(text)
	if proposalThemeMarker.MatchString(text) {
		return []byte(text), warnings
	}
	block := `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style id="bb-proposal-theme">` + proposalThemeCSS + `</style>
`
	adapted := ""
	if location := proposalHeadOpen.FindStringIndex(text); location != nil {
		adapted = text[:location[1]] + "\n" + block + text[location[1]:]
	} else if location := proposalHTMLOpen.FindStringIndex(text); location != nil {
		adapted = text[:location[1]] + "\n<head>\n" + block + "</head>" + text[location[1]:]
	} else {
		adapted = "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n" + block + "</head>\n<body>\n" + text + "\n</body>\n</html>\n"
	}
	if !proposalDoctype.MatchString(adapted) {
		adapted = "<!DOCTYPE html>\n" + adapted
	}
	return []byte(adapted), warnings
}

func decodeHTMLBytes(data []byte) string {
	head := data
	if len(head) > 4096 {
		head = head[:4096]
	}
	if match := proposalCharsetPattern.FindSubmatch(head); len(match) == 2 {
		charset := strings.ToLower(string(match[1]))
		switch charset {
		case "utf-8", "utf8":
			if utf8.Valid(data) {
				return string(data)
			}
		case "gb2312", "gbk", "gb18030":
			reader := transform.NewReader(bytes.NewReader(data), simplifiedchinese.GB18030.NewDecoder())
			decoded, err := io.ReadAll(reader)
			if err == nil {
				return string(decoded)
			}
		}
	}
	if utf8.Valid(data) {
		return string(data)
	}
	reader := transform.NewReader(bytes.NewReader(data), simplifiedchinese.GB18030.NewDecoder())
	decoded, err := io.ReadAll(reader)
	if err == nil {
		return string(decoded)
	}
	return strings.ToValidUTF8(string(data), "\uFFFD")
}

func proposalRelativeWarnings(text string) []string {
	refs := proposalReference.FindAllStringSubmatch(text, -1)
	seen := map[string]bool{}
	warnings := []string{}
	for _, match := range refs {
		ref := strings.TrimSpace(html.UnescapeString(match[1]))
		if ref == "" || seen[ref] {
			continue
		}
		lower := strings.ToLower(ref)
		if strings.HasPrefix(lower, "http:") || strings.HasPrefix(lower, "https:") ||
			strings.HasPrefix(lower, "data:") || strings.HasPrefix(lower, "//") ||
			strings.HasPrefix(lower, "#") {
			continue
		}
		seen[ref] = true
		warnings = append(warnings,
			fmt.Sprintf("检测到相对引用 %s：方案只保存单个 HTML，该引用在查看时不可达，建议内联或改为绝对地址", ref))
	}
	return warnings
}

func buildProposalFilename(title string, versionNo int, raw bool, fileFormat string) string {
	cleaned := strings.TrimSpace(title)
	cleaned = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || strings.ContainsRune("<>&", r) {
			return -1
		}
		return r
	}, cleaned)
	if cleaned == "" {
		cleaned = "方案"
	}
	runes := []rune(cleaned)
	if len(runes) > 200 {
		cleaned = string(runes[:200])
	}
	suffix := ""
	if raw && fileFormat != "pdf" {
		suffix = "-原始"
	}
	ext := "html"
	if fileFormat == "pdf" {
		ext = "pdf"
	}
	return fmt.Sprintf("%s-v%d%s.%s", cleaned, versionNo, suffix, ext)
}

const proposalThemeCSS = `
:root{--bb-background:210 28% 97%;--bb-foreground:214 18% 16%;--bb-border:214 22% 84%;--bb-primary:214 89% 43%;--bb-font:ui-sans-serif,system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
html[data-bb-theme="dark"]{--bb-background:224 3% 7%;--bb-foreground:220 22% 96%;--bb-border:224 4% 24%;--bb-primary:222 100% 68%}
body{margin:0 auto;padding:32px;max-width:1080px;background:hsl(var(--bb-background));color:hsl(var(--bb-foreground));font-family:var(--bb-font);font-size:15px;line-height:1.7}
a{color:hsl(var(--bb-primary))}img,svg,video,canvas,table{max-width:100%}table{border-collapse:collapse}
@media(max-width:640px){body{padding:16px}}
`
