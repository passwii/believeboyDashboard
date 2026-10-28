package httpapi

import (
	"math"
	"math/big"
	"net/http"
	"strconv"
	"strings"
)

type IntegerParam struct {
	Raw       string
	Canonical string
	Value     *big.Int
	Present   bool
}

type ValidationError struct {
	Type  string         `json:"type"`
	Loc   []string       `json:"loc"`
	Msg   string         `json:"msg"`
	Input string         `json:"input"`
	Ctx   map[string]int `json:"ctx,omitempty"`
}

func ParseIntegerQuery(r *http.Request, name string) (IntegerParam, *ValidationError) {
	values, present := r.URL.Query()[name]
	if !present {
		return IntegerParam{}, nil
	}
	raw := ""
	if len(values) > 0 {
		raw = values[len(values)-1]
	}
	canonical, _, ok := normalizeIntegerText(raw)
	if !ok {
		return IntegerParam{}, newValidationError(
			"int_parsing",
			[]string{"query", name},
			"Input should be a valid integer, unable to parse string as an integer",
			raw,
			nil,
		)
	}
	value, ok := new(big.Int).SetString(canonical, 10)
	if !ok {
		return IntegerParam{}, newValidationError(
			"int_parsing",
			[]string{"query", name},
			"Input should be a valid integer, unable to parse string as an integer",
			raw,
			nil,
		)
	}
	return IntegerParam{
		Raw:       raw,
		Canonical: value.String(),
		Value:     value,
		Present:   true,
	}, nil
}

func ValidateIntegerMinimum(
	param IntegerParam,
	name string,
	minimum int,
) *ValidationError {
	if !param.Present || param.Value == nil {
		return nil
	}
	if param.Value.Cmp(big.NewInt(int64(minimum))) >= 0 {
		return nil
	}
	return newValidationError(
		"greater_than_equal",
		[]string{"query", name},
		"Input should be greater than or equal to "+strconv.Itoa(minimum),
		param.Raw,
		map[string]int{"ge": minimum},
	)
}

func ValidateIntegerMaximum(
	param IntegerParam,
	name string,
	maximum int,
) *ValidationError {
	if !param.Present || param.Value == nil {
		return nil
	}
	if param.Value.Cmp(big.NewInt(int64(maximum))) <= 0 {
		return nil
	}
	return newValidationError(
		"less_than_equal",
		[]string{"query", name},
		"Input should be less than or equal to "+strconv.Itoa(maximum),
		param.Raw,
		map[string]int{"le": maximum},
	)
}

func ParseOptionalBoolQuery(
	r *http.Request,
	name string,
) (*bool, *ValidationError) {
	values, present := r.URL.Query()[name]
	if !present {
		return nil, nil
	}
	raw := ""
	if len(values) > 0 {
		raw = values[len(values)-1]
	}
	value, ok := parseBool(raw)
	if !ok {
		return nil, newValidationError(
			"bool_parsing",
			[]string{"query", name},
			"Input should be a valid boolean, unable to interpret input",
			raw,
			nil,
		)
	}
	return &value, nil
}

func ParseOptionalBoolHeader(
	r *http.Request,
	name string,
) (*bool, *ValidationError) {
	values, present := r.Header[http.CanonicalHeaderKey(name)]
	if !present {
		return nil, nil
	}
	raw := ""
	if len(values) > 0 {
		raw = values[0]
	}
	value, ok := parseBool(raw)
	if !ok {
		return nil, newValidationError(
			"bool_parsing",
			[]string{"header", name},
			"Input should be a valid boolean, unable to interpret input",
			raw,
			nil,
		)
	}
	return &value, nil
}

func (p IntegerParam) IntSaturated() int {
	if p.Value == nil {
		return 0
	}
	if !p.Value.IsInt64() {
		if p.Value.Sign() < 0 {
			return math.MinInt
		}
		return math.MaxInt
	}
	value := p.Value.Int64()
	if strconv.IntSize == 32 {
		if value > math.MaxInt32 {
			return math.MaxInt32
		}
		if value < math.MinInt32 {
			return math.MinInt32
		}
	}
	return int(value)
}

func newValidationError(
	errorType string,
	location []string,
	message string,
	input string,
	context map[string]int,
) *ValidationError {
	return &ValidationError{
		Type:  errorType,
		Loc:   location,
		Msg:   message,
		Input: input,
		Ctx:   context,
	}
}

func WriteValidationErrors(w http.ResponseWriter, errors []ValidationError) {
	_ = WriteJSON(w, http.StatusUnprocessableEntity, validationErrorResponse{
		Detail: errors,
	})
}

type validationErrorResponse struct {
	Detail []ValidationError `json:"detail"`
}

func parseBool(raw string) (bool, bool) {
	switch strings.ToLower(raw) {
	case "1", "on", "t", "true", "y", "yes":
		return true, true
	case "0", "off", "f", "false", "n", "no":
		return false, true
	default:
		return false, false
	}
}

// normalizeIntegerText mirrors the Pydantic integer query grammar used by
// FastAPI: optional sign, single underscore separators, and an all-zero
// fractional suffix such as "1.00".
func normalizeIntegerText(raw string) (string, bool, bool) {
	text := strings.TrimSpace(raw)
	negative := false
	if strings.HasPrefix(text, "+") {
		text = text[1:]
	} else if strings.HasPrefix(text, "-") {
		negative = true
		text = text[1:]
	}
	if text == "" || strings.HasPrefix(text, "_") || strings.HasSuffix(text, "_") {
		return "", false, false
	}

	sign := ""
	if negative {
		sign = "-"
	}
	if dot := strings.IndexByte(text, '.'); dot >= 0 {
		whole := text[:dot]
		fraction := text[dot+1:]
		if !validUnderscoreDigits(whole) ||
			fraction == "" ||
			strings.Contains(fraction, "_") ||
			strings.Trim(fraction, "0") != "" {
			return "", false, false
		}
		text = whole
	}
	if !validUnderscoreDigits(text) {
		return "", false, false
	}
	return sign + strings.ReplaceAll(text, "_", ""), negative, true
}

func validUnderscoreDigits(value string) bool {
	if value == "" {
		return false
	}
	previousUnderscore := false
	for i, char := range value {
		if char == '_' {
			if i == 0 || i == len(value)-1 || previousUnderscore {
				return false
			}
			previousUnderscore = true
			continue
		}
		if char < '0' || char > '9' {
			return false
		}
		previousUnderscore = false
	}
	return true
}
