package httpapi

import (
	"math"
	"net/http"
	"strconv"
)

// Pagination holds standardized page, pageSize, and database offset.
type Pagination struct {
	Page     int `json:"page"`
	PageSize int `json:"page_size"`
	Offset   int `json:"-"`
}

// PaginatedResponse is the universal response container for paginated lists.
type PaginatedResponse[T any] struct {
	Items    []T `json:"items"`
	Total    int `json:"total"`
	Page     int `json:"page"`
	PageSize int `json:"page_size"`
}

// NewPaginatedResponse builds a PaginatedResponse ensuring Items is never nil.
func NewPaginatedResponse[T any](items []T, total, page, pageSize int) PaginatedResponse[T] {
	if items == nil {
		items = make([]T, 0)
	}
	return PaginatedResponse[T]{
		Items:    items,
		Total:    total,
		Page:     page,
		PageSize: pageSize,
	}
}

// ParsePagination extracts page and page_size (or limit) query parameters with bounds checking.
func ParsePagination(r *http.Request, defaultPageSize, maxPageSize int) Pagination {
	if defaultPageSize <= 0 {
		defaultPageSize = 20
	}
	if maxPageSize <= 0 {
		maxPageSize = 200
	}

	page := 1
	if rawPage := r.URL.Query().Get("page"); rawPage != "" {
		if val, err := strconv.Atoi(rawPage); err == nil && val >= 1 {
			page = val
		}
	}

	pageSize := defaultPageSize
	rawPageSize := r.URL.Query().Get("page_size")
	if rawPageSize == "" {
		rawPageSize = r.URL.Query().Get("limit")
	}
	if rawPageSize != "" {
		if val, err := strconv.Atoi(rawPageSize); err == nil && val >= 1 {
			pageSize = val
		}
	}
	if pageSize > maxPageSize {
		pageSize = maxPageSize
	}

	offset := SafeOffset(page, pageSize)

	return Pagination{
		Page:     page,
		PageSize: pageSize,
		Offset:   offset,
	}
}

// SafeOffset computes the query offset avoiding integer overflow.
func SafeOffset(page, pageSize int) int {
	if page <= 1 {
		return 0
	}
	if page-1 > math.MaxInt/pageSize {
		return math.MaxInt
	}
	return (page - 1) * pageSize
}
