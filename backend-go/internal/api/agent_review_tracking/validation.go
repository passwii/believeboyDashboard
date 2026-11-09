package agent_review_tracking

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"
)

func decodeCrawlRunInput(
	w http.ResponseWriter,
	request *http.Request,
) (*CrawlRunInput, error) {
	if request == nil || request.Body == nil {
		return nil, validationFailure("请求体不能为空")
	}
	request.Body = http.MaxBytesReader(w, request.Body, MaxBodyBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()

	var input CrawlRunInput
	if err := decoder.Decode(&input); err != nil {
		if errors.Is(err, io.EOF) {
			return nil, validationFailure("请求体不能为空")
		}
		return nil, validationFailure("请求体格式不合法: " + err.Error())
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return nil, validationFailure("请求体只能包含一个 JSON 对象")
	}
	return &input, nil
}

func validateCrawlRunInput(input *CrawlRunInput) error {
	if input == nil {
		return validationFailure("请求体不能为空")
	}
	if input.CapturedAt.IsZero() {
		return validationFailure("captured_at 必须是带时区的 ISO 8601 时间")
	}
	switch input.Status {
	case "success", "partial", "failed":
	default:
		return validationFailure("status 必须是 success、partial 或 failed")
	}
	if input.IdempotencyKey != nil {
		trimmed := strings.TrimSpace(*input.IdempotencyKey)
		if trimmed == "" {
			return validationFailure("idempotency_key 不能为空白字符串")
		}
		if utf8.RuneCountInString(trimmed) > MaxIdempotencyKey {
			return validationFailure(
				fmt.Sprintf("idempotency_key 长度不能超过 %d 字符", MaxIdempotencyKey),
			)
		}
		input.IdempotencyKey = stringPtr(trimmed)
	}
	if err := validateOptionalText(input.ASINScraped, 20, "asin_scraped"); err != nil {
		return err
	}
	if err := validateOptionalText(input.ErrorMessage, 4000, "error_message"); err != nil {
		return err
	}
	if err := validateOptionalText(input.Source, 64, "source"); err != nil {
		return err
	}
	if input.Rating != nil {
		if err := validateRating(input.Rating); err != nil {
			return err
		}
	}
	if input.Reviews != nil {
		reviews := *input.Reviews
		if len(reviews) > MaxReviewsPerRun {
			return validationFailure(
				fmt.Sprintf("reviews 单次最多 %d 条", MaxReviewsPerRun),
			)
		}
		for index := range reviews {
			if err := validateReview(&reviews[index], index); err != nil {
				return err
			}
		}
	}
	return nil
}

func validateRating(rating *RatingInput) error {
	if rating == nil {
		return nil
	}
	if !rating.StarCountQuality.Set {
		rating.StarCountQuality.Value = "unavailable"
	}
	switch rating.StarCountQuality.Value {
	case "exact", "estimated", "unavailable":
	default:
		return validationFailure("rating.star_count_quality 不合法")
	}
	if rating.AverageRating != nil {
		if math.IsNaN(*rating.AverageRating) ||
			math.IsInf(*rating.AverageRating, 0) ||
			*rating.AverageRating < 0 ||
			*rating.AverageRating > 5 {
			return validationFailure("average_rating 必须是 0 到 5 之间的有限数值")
		}
	}
	if err := validateInt4Count(rating.RatingCount, "rating.rating_count"); err != nil {
		return err
	}
	if err := validateInt4Count(rating.ReviewCount, "rating.review_count"); err != nil {
		return err
	}
	if rating.StarPercentages != nil {
		values := *rating.StarPercentages
		if len(values) != 5 {
			return validationFailure("star_percentages 必须恰好包含 5 项")
		}
		for _, value := range values {
			if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || value > 100 {
				return validationFailure("star_percentages 每项必须是 0 到 100 之间的有限数值")
			}
		}
	}
	if rating.StarCounts != nil {
		values := *rating.StarCounts
		if len(values) != 5 {
			return validationFailure("star_counts 必须恰好包含 5 项")
		}
		for _, value := range values {
			if value < 0 || value > MaxInt4 {
				return validationFailure("star_counts 每项必须是非负 int4 整数")
			}
		}
	}
	return nil
}

func validateReview(review *ReviewInput, index int) error {
	if review == nil {
		return validationFailure(fmt.Sprintf("reviews[%d] 不能为空", index))
	}
	if review.ReviewKey == "" {
		return validationFailure(fmt.Sprintf("reviews[%d].review_key 不能为空", index))
	}
	if utf8.RuneCountInString(review.ReviewKey) > 255 {
		return validationFailure(fmt.Sprintf("reviews[%d].review_key 长度不能超过 255 字符", index))
	}
	switch review.IDConfidence {
	case "original", "derived":
	default:
		return validationFailure(fmt.Sprintf("reviews[%d].id_confidence 不合法", index))
	}
	if review.Rating != nil && (*review.Rating < 1 || *review.Rating > 5) {
		return validationFailure(fmt.Sprintf("reviews[%d].rating 必须是 1 到 5 的整数", index))
	}
	if err := validateOptionalText(review.Title, 512, fmt.Sprintf("reviews[%d].title", index)); err != nil {
		return err
	}
	if err := validateOptionalText(review.Body, 20000, fmt.Sprintf("reviews[%d].body", index)); err != nil {
		return err
	}
	if err := validateOptionalText(review.ReviewerID, 128, fmt.Sprintf("reviews[%d].reviewer_id", index)); err != nil {
		return err
	}
	if err := validateOptionalText(review.ReviewerName, 255, fmt.Sprintf("reviews[%d].reviewer_name", index)); err != nil {
		return err
	}
	if err := validateInt4Count(review.HelpfulCount, fmt.Sprintf("reviews[%d].helpful_count", index)); err != nil {
		return err
	}
	return nil
}

func validateOptionalText(value *string, maxRunes int, field string) error {
	if value == nil {
		return nil
	}
	if utf8.RuneCountInString(*value) > maxRunes {
		return validationFailure(fmt.Sprintf("%s 长度不能超过 %d 字符", field, maxRunes))
	}
	return nil
}

func validateInt4Count(value *int64, field string) error {
	if value == nil {
		return nil
	}
	if *value < 0 || *value > MaxInt4 {
		return validationFailure(fmt.Sprintf("%s 必须是非负 int4 整数", field))
	}
	return nil
}

func validationFailure(message string) *APIError {
	return &APIError{
		Status:       http.StatusBadRequest,
		Code:         "VALIDATION_FAILED",
		Reason:       "validation_failed",
		HumanMessage: message,
		AgentHint:    "请修正请求字段后重试",
	}
}

func parseTargetID(value string) (int64, error) {
	id, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
	if err != nil || id < 1 {
		return 0, validationFailure("target_id 必须是正整数")
	}
	return id, nil
}

func parsePositiveProjectID(value string) (*int64, error) {
	if strings.TrimSpace(value) == "" {
		return nil, validationFailure("project_id 必须是正整数")
	}
	id, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
	if err != nil || id < 1 {
		return nil, validationFailure("project_id 必须是正整数")
	}
	return &id, nil
}

func firstQueryValue(values []string) string {
	if len(values) == 0 {
		return ""
	}
	return strings.TrimSpace(values[0])
}

func rawQueryValue(values []string) string {
	if len(values) == 0 {
		return ""
	}
	return values[0]
}
