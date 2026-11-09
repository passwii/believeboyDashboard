package page_render

type UploadedPage struct {
	ID               string `json:"id"`
	Title            string `json:"title"`
	SourceFormat     string `json:"source_format"`
	PublicURL        string `json:"public_url"`
	OriginalFilename string `json:"original_filename"`
	FileSize         int64  `json:"file_size"`
	CreatedAt        string `json:"created_at"`
}

type HistoryResponse struct {
	Items []UploadedPage `json:"items"`
	Total int64          `json:"total"`
}

type PublicResponse struct {
	ID           string `json:"id"`
	Title        string `json:"title"`
	SourceFormat string `json:"source_format"`
	PublicURL    string `json:"public_url"`
}

type PageRecord struct {
	ID               string
	OwnerUserID      int64
	Title            string
	SourceFormat     string
	OriginalFilename string
	ContentType      string
	FileSize         int64
	R2Key            string
	PublicURL        string
}
