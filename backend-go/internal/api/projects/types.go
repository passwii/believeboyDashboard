package projects

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
)

type ProjectOption struct {
	ID          *int64  `json:"id"`
	Name        string  `json:"name"`
	Country     string  `json:"country"`
	CountryName *string `json:"country_name"`
}

type ProjectItem struct {
	ID                int64    `json:"id"`
	Name              string   `json:"name"`
	BrandName         *string  `json:"brand_name"`
	StoreAddress      *string  `json:"store_address"`
	ProjectOperator   *string  `json:"project_operator"`
	AssistantOperator *string  `json:"assistant_operator"`
	CommissionBasis   *string  `json:"commission_basis"`
	CommissionRate    *float64 `json:"commission_rate"`
	SortOrder         int      `json:"sort_order"`
	IsActive          bool     `json:"is_active"`
	SourceFile        *string  `json:"source_file"`
	HasContext        bool     `json:"has_context"`
	ProjectTier       *string  `json:"project_tier"`
	Country           string   `json:"country"`
	CountryName       *string  `json:"country_name"`
	VATEnabled        bool     `json:"vat_enabled"`
}

type CreateProjectInput struct {
	Name              string   `json:"name"`
	BrandName         *string  `json:"brand_name"`
	StoreAddress      *string  `json:"store_address"`
	ProjectOperator   *string  `json:"project_operator"`
	AssistantOperator *string  `json:"assistant_operator"`
	CommissionBasis   *string  `json:"commission_basis"`
	CommissionRate    *float64 `json:"commission_rate"`
	ProjectTier       *string  `json:"project_tier"`
	Country           string   `json:"country"`
	VATEnabled        bool     `json:"vat_enabled"`
}

type UpdateProjectInput struct {
	Name              string   `json:"name"`
	BrandName         *string  `json:"brand_name"`
	StoreAddress      *string  `json:"store_address"`
	ProjectOperator   *string  `json:"project_operator"`
	AssistantOperator *string  `json:"assistant_operator"`
	CommissionBasis   *string  `json:"commission_basis"`
	CommissionRate    *float64 `json:"commission_rate"`
	IsActive          *bool    `json:"is_active"`
	ProjectTier       *string  `json:"project_tier"`
	Country           *string  `json:"country"`
	VATEnabled        *bool    `json:"vat_enabled"`
}

type ProjectShopItem struct {
	ID                          int64    `json:"id"`
	Country                     string   `json:"country"`
	ShopID                      string   `json:"shop_id"`
	ShopName                    *string  `json:"shop_name"`
	SellerIdentityExpectedAlias *string  `json:"seller_identity_expected_alias"`
	SellerIdentityAliases       []string `json:"seller_identity_aliases"`
	SellerIdentitySource        *string  `json:"seller_identity_source"`
	SellerIdentityRequired      bool     `json:"seller_identity_required"`
}

type ProjectContext struct {
	ProjectID      int64          `json:"project_id"`
	ProjectName    string         `json:"project_name"`
	ProjectContext map[string]any `json:"project_context"`
	SKUContext     map[string]any `json:"sku_context"`
}

type ShopUpsert struct {
	ShopID                      string          `json:"shop_id"`
	ShopName                    OptionalString  `json:"shop_name"`
	SellerIdentityExpectedAlias OptionalString  `json:"seller_identity_expected_alias"`
	SellerIdentityAliases       OptionalStrings `json:"seller_identity_aliases"`
	SellerIdentitySource        OptionalString  `json:"seller_identity_source"`
	SellerIdentityRequired      OptionalBool    `json:"seller_identity_required"`
}

type OptionalString struct {
	Value   *string
	Present bool
}

func (o *OptionalString) UnmarshalJSON(data []byte) error {
	o.Present = true
	if string(data) == "null" {
		o.Value = nil
		return nil
	}
	var value string
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	o.Value = &value
	return nil
}

type OptionalStrings struct {
	Value   []string
	Present bool
}

func (o *OptionalStrings) UnmarshalJSON(data []byte) error {
	o.Present = true
	if string(data) == "null" {
		o.Value = nil
		return nil
	}
	return json.Unmarshal(data, &o.Value)
}

type OptionalBool struct {
	Value   *bool
	Present bool
}

func (o *OptionalBool) UnmarshalJSON(data []byte) error {
	o.Present = true
	if string(data) == "null" {
		o.Value = nil
		return nil
	}
	var value bool
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	o.Value = &value
	return nil
}

type ContextPatchInput struct {
	ProjectContext map[string]any `json:"project_context"`
	SKUContext     map[string]any `json:"sku_context"`
}

type ShopDeleteResponse struct {
	Deleted   bool   `json:"deleted"`
	ProjectID int64  `json:"project_id"`
	Country   string `json:"country"`
}

type APIError struct {
	Status int
	Detail string
}

func (e *APIError) Error() string {
	return e.Detail
}

var (
	ErrNotFound = &APIError{Status: http.StatusNotFound, Detail: "项目不存在"}
	ErrConflict = &APIError{Status: http.StatusConflict, Detail: "项目已存在"}
)

func NewAPIError(status int, detail string) error {
	return &APIError{Status: status, Detail: detail}
}

func HTTPError(err error) (int, string) {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		return apiErr.Status, apiErr.Detail
	}
	return http.StatusInternalServerError, "Internal Server Error"
}

func ValidateCountry(value string) (string, error) {
	normalized := strings.ToUpper(strings.TrimSpace(value))
	switch normalized {
	case "", "US", "USA", "美国", "美国站":
		return "US", nil
	case "DE", "GERMANY", "德国", "德国站":
		return "DE", nil
	case "UK", "GB", "UNITED KINGDOM", "英国", "英国站":
		return "UK", nil
	default:
		return "", NewAPIError(http.StatusUnprocessableEntity, "country must be one of: DE, UK, US")
	}
}

func CountryName(country string) *string {
	labels := map[string]string{
		"US": "美国站",
		"DE": "德国站",
		"UK": "英国站",
		"JP": "日本站",
		"FR": "法国站",
		"IT": "意大利站",
		"ES": "西班牙站",
		"CA": "加拿大站",
		"MX": "墨西哥站",
		"AU": "澳大利亚站",
	}
	label, ok := labels[strings.ToUpper(strings.TrimSpace(country))]
	if !ok {
		return nil
	}
	return &label
}

func validateProjectInput(input CreateProjectInput) error {
	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" || len([]rune(input.Name)) > 255 {
		return NewAPIError(http.StatusUnprocessableEntity, "name must contain 1 to 255 characters")
	}
	if err := validateProjectFields(input.BrandName, input.StoreAddress, input.ProjectOperator,
		input.AssistantOperator, input.CommissionBasis, input.CommissionRate, input.ProjectTier); err != nil {
		return err
	}
	_, err := ValidateCountry(input.Country)
	return err
}

func validateProjectFields(brandName, storeAddress, projectOperator, assistantOperator,
	commissionBasis *string, commissionRate *float64, projectTier *string) error {
	for name, value := range map[string]*string{
		"brand_name":         brandName,
		"store_address":      storeAddress,
		"project_operator":   projectOperator,
		"assistant_operator": assistantOperator,
		"project_tier":       projectTier,
	} {
		if value != nil {
			limit := 4000
			if name == "project_tier" || name == "brand_name" || name == "store_address" {
				limit = 255
			}
			if len([]rune(*value)) > limit {
				return NewAPIError(http.StatusUnprocessableEntity, fmt.Sprintf("%s is too long", name))
			}
		}
	}
	if commissionBasis != nil && *commissionBasis != "" {
		switch *commissionBasis {
		case "sales_amount", "cash_received", "profit_margin":
		default:
			return NewAPIError(http.StatusUnprocessableEntity,
				"commission_basis must be one of sales_amount, cash_received, profit_margin")
		}
	}
	if commissionRate != nil && (*commissionRate < 0 || *commissionRate > 100) {
		return NewAPIError(http.StatusUnprocessableEntity, "commission_rate must be between 0 and 100")
	}
	if projectTier != nil && *projectTier != "" {
		tier := strings.ToUpper(strings.TrimSpace(*projectTier))
		switch tier {
		case "T1", "T2", "T3", "T4":
		default:
			return NewAPIError(http.StatusUnprocessableEntity, "project_tier must be one of T1, T2, T3, T4")
		}
	}
	return nil
}
