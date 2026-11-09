package agent_commerce

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
	"unicode/utf8"
)

var allowedAgentSources = map[string]bool{
	"agent_listing_pull":  true,
	"agent_user_supplied": true,
	"external_api":        true,
}

var listingCopyFields = map[string]bool{
	"listing_title":          true,
	"listing_bullet_1":       true,
	"listing_bullet_2":       true,
	"listing_bullet_3":       true,
	"listing_bullet_4":       true,
	"listing_bullet_5":       true,
	"listing_description":    true,
	"listing_selling_points": true,
}

var updateFields = map[string]bool{
	"source":                 true,
	"fnsku":                  true,
	"product_name":           true,
	"father_id":              true,
	"fob_unit_cost":          true,
	"first_leg_cost_rmb":     true,
	"package_length_cm":      true,
	"package_width_cm":       true,
	"package_height_cm":      true,
	"weight_kg":              true,
	"carton_length_cm":       true,
	"carton_width_cm":        true,
	"carton_height_cm":       true,
	"carton_weight_kg":       true,
	"units_per_carton":       true,
	"is_active":              true,
	"sort_order":             true,
	"sku_factory_info":       true,
	"listing_title":          true,
	"listing_bullet_1":       true,
	"listing_bullet_2":       true,
	"listing_bullet_3":       true,
	"listing_bullet_4":       true,
	"listing_bullet_5":       true,
	"listing_description":    true,
	"listing_selling_points": true,
}

func decodeJSONObject(body []byte, allowEmpty bool) (map[string]json.RawMessage, *APIError) {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		if allowEmpty {
			return map[string]json.RawMessage{}, nil
		}
		return nil, validationError("请求体必须是 JSON 对象")
	}
	if !json.Valid(trimmed) {
		return nil, validationError("请求体必须是 JSON 对象")
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.UseNumber()
	var values map[string]json.RawMessage
	if err := decoder.Decode(&values); err != nil {
		return nil, validationError("请求体必须是 JSON 对象")
	}
	if values == nil {
		return nil, validationError("请求体必须是 JSON 对象")
	}
	var trailing any
	if err := decoder.Decode(&trailing); err == nil {
		return nil, validationError("请求体必须是单个 JSON 对象")
	} else if !errors.Is(err, io.EOF) {
		return nil, validationError("请求体必须是单个 JSON 对象")
	}
	return values, nil
}

func parseUpsertInput(body []byte) (SKUUpsertInput, *APIError) {
	values, apiErr := decodeJSONObject(body, false)
	if apiErr != nil {
		return SKUUpsertInput{}, apiErr
	}
	provided := providedFields(values)
	sku, apiErr := requiredString(values, "sku", 255)
	if apiErr != nil {
		return SKUUpsertInput{}, apiErr
	}
	asin, apiErr := requiredString(values, "asin", 255)
	if apiErr != nil {
		return SKUUpsertInput{}, apiErr
	}
	country, apiErr := requiredCountry(values, "country")
	if apiErr != nil {
		return SKUUpsertInput{}, apiErr
	}
	source, apiErr := requiredSource(values)
	if apiErr != nil {
		return SKUUpsertInput{}, apiErr
	}

	input := SKUUpsertInput{
		SKU:         sku,
		ASIN:        asin,
		Country:     country,
		Source:      source,
		Provided:    provided,
		ListingCopy: map[string]*string{},
	}
	if input.FNSKU, apiErr = optionalText(values, "fnsku", 255); apiErr != nil {
		return SKUUpsertInput{}, apiErr
	}
	if input.ProductName, apiErr = optionalText(values, "product_name", 255); apiErr != nil {
		return SKUUpsertInput{}, apiErr
	}
	if input.FatherID, apiErr = optionalText(values, "father_id", 255); apiErr != nil {
		return SKUUpsertInput{}, apiErr
	}
	if input.FOBUnitCost, apiErr = optionalNumber(values, "fob_unit_cost", 0, 100000000); apiErr != nil {
		return SKUUpsertInput{}, apiErr
	}
	if input.FirstLegCostRMB, apiErr = optionalNumber(values, "first_leg_cost_rmb", 0, 100000000); apiErr != nil {
		return SKUUpsertInput{}, apiErr
	}
	if input.PackageLengthCM, apiErr = optionalNumber(values, "package_length_cm", 0, 100000); apiErr != nil {
		return SKUUpsertInput{}, apiErr
	}
	if input.PackageWidthCM, apiErr = optionalNumber(values, "package_width_cm", 0, 100000); apiErr != nil {
		return SKUUpsertInput{}, apiErr
	}
	if input.PackageHeightCM, apiErr = optionalNumber(values, "package_height_cm", 0, 100000); apiErr != nil {
		return SKUUpsertInput{}, apiErr
	}
	if input.WeightKG, apiErr = optionalNumber(values, "weight_kg", 0, 100000); apiErr != nil {
		return SKUUpsertInput{}, apiErr
	}
	if input.CartonLengthCM, apiErr = optionalNumber(values, "carton_length_cm", 0, 100000); apiErr != nil {
		return SKUUpsertInput{}, apiErr
	}
	if input.CartonWidthCM, apiErr = optionalNumber(values, "carton_width_cm", 0, 100000); apiErr != nil {
		return SKUUpsertInput{}, apiErr
	}
	if input.CartonHeightCM, apiErr = optionalNumber(values, "carton_height_cm", 0, 100000); apiErr != nil {
		return SKUUpsertInput{}, apiErr
	}
	if input.CartonWeightKG, apiErr = optionalNumber(values, "carton_weight_kg", 0, 100000); apiErr != nil {
		return SKUUpsertInput{}, apiErr
	}
	if input.UnitsPerCarton, apiErr = optionalInt(values, "units_per_carton", 0, 100000000); apiErr != nil {
		return SKUUpsertInput{}, apiErr
	}
	if input.IsActive, apiErr = optionalBool(values, "is_active"); apiErr != nil {
		return SKUUpsertInput{}, apiErr
	}
	if input.Provided["is_active"] && input.IsActive == nil {
		return SKUUpsertInput{}, validationError("is_active 必须是布尔值")
	}
	if input.SortOrder, apiErr = optionalInt(values, "sort_order", 1, math.MaxInt32); apiErr != nil {
		return SKUUpsertInput{}, apiErr
	}
	if input.SKUFactoryInfo, apiErr = optionalObject(values, "sku_factory_info"); apiErr != nil {
		return SKUUpsertInput{}, apiErr
	}
	if input.ListingCopy, apiErr = optionalListingCopy(values, false); apiErr != nil {
		return SKUUpsertInput{}, apiErr
	}
	return input, nil
}

func parseUpdateInput(body []byte) (SKUUpdateInput, *APIError) {
	values, apiErr := decodeJSONObject(body, false)
	if apiErr != nil {
		return SKUUpdateInput{}, apiErr
	}
	for field := range values {
		if !updateFields[field] {
			return SKUUpdateInput{}, validationError(fmt.Sprintf("不允许更新字段 %s", field))
		}
	}
	source, apiErr := requiredSource(values)
	if apiErr != nil {
		return SKUUpdateInput{}, apiErr
	}
	input := SKUUpdateInput{
		Source:      source,
		Provided:    providedFields(values),
		ListingCopy: map[string]*string{},
	}
	if input.FNSKU, apiErr = optionalText(values, "fnsku", 255); apiErr != nil {
		return SKUUpdateInput{}, apiErr
	}
	if input.ProductName, apiErr = optionalText(values, "product_name", 255); apiErr != nil {
		return SKUUpdateInput{}, apiErr
	}
	if input.FatherID, apiErr = optionalText(values, "father_id", 255); apiErr != nil {
		return SKUUpdateInput{}, apiErr
	}
	if input.FOBUnitCost, apiErr = optionalNumber(values, "fob_unit_cost", 0, 100000000); apiErr != nil {
		return SKUUpdateInput{}, apiErr
	}
	if input.FirstLegCostRMB, apiErr = optionalNumber(values, "first_leg_cost_rmb", 0, 100000000); apiErr != nil {
		return SKUUpdateInput{}, apiErr
	}
	if input.PackageLengthCM, apiErr = optionalNumber(values, "package_length_cm", 0, 100000); apiErr != nil {
		return SKUUpdateInput{}, apiErr
	}
	if input.PackageWidthCM, apiErr = optionalNumber(values, "package_width_cm", 0, 100000); apiErr != nil {
		return SKUUpdateInput{}, apiErr
	}
	if input.PackageHeightCM, apiErr = optionalNumber(values, "package_height_cm", 0, 100000); apiErr != nil {
		return SKUUpdateInput{}, apiErr
	}
	if input.WeightKG, apiErr = optionalNumber(values, "weight_kg", 0, 100000); apiErr != nil {
		return SKUUpdateInput{}, apiErr
	}
	if input.CartonLengthCM, apiErr = optionalNumber(values, "carton_length_cm", 0, 100000); apiErr != nil {
		return SKUUpdateInput{}, apiErr
	}
	if input.CartonWidthCM, apiErr = optionalNumber(values, "carton_width_cm", 0, 100000); apiErr != nil {
		return SKUUpdateInput{}, apiErr
	}
	if input.CartonHeightCM, apiErr = optionalNumber(values, "carton_height_cm", 0, 100000); apiErr != nil {
		return SKUUpdateInput{}, apiErr
	}
	if input.CartonWeightKG, apiErr = optionalNumber(values, "carton_weight_kg", 0, 100000); apiErr != nil {
		return SKUUpdateInput{}, apiErr
	}
	if input.UnitsPerCarton, apiErr = optionalInt(values, "units_per_carton", 0, 100000000); apiErr != nil {
		return SKUUpdateInput{}, apiErr
	}
	if input.IsActive, apiErr = optionalBool(values, "is_active"); apiErr != nil {
		return SKUUpdateInput{}, apiErr
	}
	if input.SortOrder, apiErr = optionalInt(values, "sort_order", 1, math.MaxInt32); apiErr != nil {
		return SKUUpdateInput{}, apiErr
	}
	if input.SKUFactoryInfo, apiErr = optionalObject(values, "sku_factory_info"); apiErr != nil {
		return SKUUpdateInput{}, apiErr
	}
	if input.ListingCopy, apiErr = optionalListingCopy(values, false); apiErr != nil {
		return SKUUpdateInput{}, apiErr
	}
	return input, nil
}

func parseListingCopyBatchInput(body []byte) (ListingCopyBatchInput, *APIError) {
	values, apiErr := decodeJSONObject(body, false)
	if apiErr != nil {
		return ListingCopyBatchInput{}, apiErr
	}
	for field := range values {
		if field != "source" && field != "items" {
			return ListingCopyBatchInput{}, validationError(fmt.Sprintf("不允许字段 %s", field))
		}
	}
	source, apiErr := requiredSource(values)
	if apiErr != nil {
		return ListingCopyBatchInput{}, apiErr
	}
	rawItems, ok := values["items"]
	if !ok {
		return ListingCopyBatchInput{}, validationError("items 必填")
	}
	var items []map[string]json.RawMessage
	if err := json.Unmarshal(rawItems, &items); err != nil {
		return ListingCopyBatchInput{}, validationError("items 必须是数组")
	}
	if len(items) < 1 || len(items) > 500 {
		return ListingCopyBatchInput{}, validationError("items 数量必须在 1 到 500 之间")
	}
	result := ListingCopyBatchInput{Source: source, Items: make([]ListingCopyItem, 0, len(items))}
	for index, item := range items {
		for field := range item {
			if field != "sku_record_id" && !listingCopyFields[field] {
				return ListingCopyBatchInput{}, validationError(
					fmt.Sprintf("items[%d] 不允许字段 %s", index, field),
				)
			}
		}
		recordID, apiErr := requiredInt(item, "sku_record_id", 1, math.MaxInt64)
		if apiErr != nil {
			apiErr.Human = fmt.Sprintf("items[%d]: %s", index, apiErr.Human)
			return ListingCopyBatchInput{}, apiErr
		}
		listing, apiErr := optionalListingCopy(item, true)
		if apiErr != nil {
			apiErr.Human = fmt.Sprintf("items[%d]: %s", index, apiErr.Human)
			return ListingCopyBatchInput{}, apiErr
		}
		result.Items = append(result.Items, ListingCopyItem{SKURecordID: recordID, Values: listing})
	}
	return result, nil
}

func parseStatusInput(body []byte) (SKUStatusInput, *APIError) {
	values, apiErr := decodeJSONObject(body, false)
	if apiErr != nil {
		return SKUStatusInput{}, apiErr
	}
	for field := range values {
		if field != "source" && field != "is_active" {
			return SKUStatusInput{}, validationError(fmt.Sprintf("不允许字段 %s", field))
		}
	}
	source, apiErr := requiredSource(values)
	if apiErr != nil {
		return SKUStatusInput{}, apiErr
	}
	raw, ok := values["is_active"]
	if !ok {
		return SKUStatusInput{}, validationError("is_active 必填")
	}
	var active bool
	if err := json.Unmarshal(raw, &active); err != nil {
		return SKUStatusInput{}, validationError("is_active 必须是布尔值")
	}
	return SKUStatusInput{IsActive: active, Source: source}, nil
}

func requiredString(
	values map[string]json.RawMessage,
	key string,
	maxRunes int,
) (string, *APIError) {
	raw, ok := values[key]
	if !ok {
		return "", validationError(key + " 必填")
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", validationError(key + " 必须是字符串")
	}
	value = strings.TrimSpace(value)
	if value == "" {
		return "", validationError(key + " 不能为空")
	}
	if maxRunes > 0 && utf8.RuneCountInString(value) > maxRunes {
		return "", validationError(fmt.Sprintf("%s 长度不能超过 %d", key, maxRunes))
	}
	return value, nil
}

func requiredCountry(values map[string]json.RawMessage, key string) (string, *APIError) {
	value, apiErr := requiredString(values, key, 2)
	if apiErr != nil {
		return "", apiErr
	}
	value = normalizeCountryCode(value)
	if len(value) != 2 {
		return "", validationError(key + " 必须是 2 位国家代码")
	}
	return value, nil
}

func normalizeCountryCode(value string) string {
	value = strings.ToUpper(strings.TrimSpace(value))
	if value == "GB" {
		return "UK"
	}
	return value
}

func requiredSource(values map[string]json.RawMessage) (string, *APIError) {
	raw, ok := values["source"]
	if !ok {
		apiErr := newAPIError(CodeSKUInfoInvalidSource)
		apiErr.Details = map[string]any{"allowed": allowedSources()}
		return "", apiErr
	}
	var source string
	if err := json.Unmarshal(raw, &source); err != nil || !allowedAgentSources[source] {
		apiErr := newAPIError(CodeSKUInfoInvalidSource)
		apiErr.Details = map[string]any{"allowed": allowedSources()}
		return "", apiErr
	}
	return source, nil
}

func optionalText(
	values map[string]json.RawMessage,
	key string,
	maxRunes int,
) (*string, *APIError) {
	raw, ok := values[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, validationError(key + " 必须是字符串或 null")
	}
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, nil
	}
	if maxRunes > 0 && utf8.RuneCountInString(value) > maxRunes {
		return nil, validationError(fmt.Sprintf("%s 长度不能超过 %d", key, maxRunes))
	}
	return &value, nil
}

func optionalNumber(
	values map[string]json.RawMessage,
	key string,
	minimum, maximum float64,
) (*float64, *APIError) {
	raw, ok := values[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}
	var value float64
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, validationError(key + " 必须是数字或 null")
	}
	if math.IsNaN(value) || math.IsInf(value, 0) || value < minimum || value > maximum {
		return nil, validationError(
			fmt.Sprintf("%s 必须介于 %g 和 %g 之间", key, minimum, maximum),
		)
	}
	return &value, nil
}

func optionalInt(
	values map[string]json.RawMessage,
	key string,
	minimum, maximum int64,
) (*int, *APIError) {
	raw, ok := values[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}
	var number json.Number
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&number); err != nil {
		return nil, validationError(key + " 必须是整数或 null")
	}
	value, err := strconv.ParseInt(number.String(), 10, 64)
	if err != nil || value < minimum || value > maximum {
		return nil, validationError(key + " 超出允许范围")
	}
	result := int(value)
	return &result, nil
}

func requiredInt(
	values map[string]json.RawMessage,
	key string,
	minimum, maximum int64,
) (int64, *APIError) {
	raw, ok := values[key]
	if !ok {
		return 0, validationError(key + " 必填")
	}
	var number json.Number
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&number); err != nil {
		return 0, validationError(key + " 必须是整数")
	}
	value, err := strconv.ParseInt(number.String(), 10, 64)
	if err != nil || value < minimum || value > maximum {
		return 0, validationError(key + " 超出允许范围")
	}
	return value, nil
}

func optionalBool(
	values map[string]json.RawMessage,
	key string,
) (*bool, *APIError) {
	raw, ok := values[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, validationError(key + " 必须是布尔值或 null")
	}
	return &value, nil
}

func optionalObject(
	values map[string]json.RawMessage,
	key string,
) (map[string]any, *APIError) {
	raw, ok := values[key]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}
	var value map[string]any
	if err := json.Unmarshal(raw, &value); err != nil || value == nil {
		return nil, validationError(key + " 必须是对象或 null")
	}
	return value, nil
}

func optionalListingCopy(
	values map[string]json.RawMessage,
	itemMode bool,
) (map[string]*string, *APIError) {
	result := map[string]*string{}
	for field := range listingCopyFields {
		raw, ok := values[field]
		if !ok {
			continue
		}
		value, apiErr := optionalText(values, field, fieldMaxLength(field))
		if apiErr != nil {
			return nil, apiErr
		}
		result[field] = value
		_ = raw
	}
	if !itemMode {
		for field := range result {
			if !listingCopyFields[field] {
				delete(result, field)
			}
		}
	}
	return result, nil
}

func fieldMaxLength(field string) int {
	if field == "listing_title" {
		return 500
	}
	return 0
}

func providedFields(values map[string]json.RawMessage) map[string]bool {
	result := make(map[string]bool, len(values))
	for field := range values {
		result[field] = true
	}
	return result
}

func allowedSources() []string {
	return []string{"agent_listing_pull", "agent_user_supplied", "external_api"}
}

func validationError(message string) *APIError {
	return APIErrorWithMessage(CodeValidationFailed, message)
}
