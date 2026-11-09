package digital_display

import "strings"

var returnReasonTranslations = map[string]string{
	"DEFECTIVE":                              "有缺陷",
	"QUALITY_UNACCEPTABLE":                   "质量不合格",
	"WARRANTY":                               "保修期内损坏",
	"MISSING_PARTS":                          "缺少配件",
	"EXTRA_ITEM":                             "多发货品",
	"UNWANTED_ITEM":                          "不需要",
	"NO_REASON_GIVEN":                        "未说明原因",
	"CHANGED_MIND":                           "改变主意",
	"FOUND_BETTER_PRICE":                     "找到更低价",
	"NOT_AS_DESCRIBED":                       "与描述不符",
	"SWITCHEROO":                             "与订单不符",
	"ORDERED_WRONG_ITEM":                     "误购商品",
	"MISORDERED":                             "订错款式尺码",
	"WRONG_ITEM":                             "错发商品",
	"APPAREL_TOO_LARGE":                      "服装过大",
	"APPAREL_TOO_SMALL":                      "服装过小",
	"APPAREL_STYLE":                          "款式问题",
	"DID_NOT_LIKE_FABRIC":                    "不喜欢面料",
	"DID_NOT_LIKE_COLOR":                     "不喜欢颜色",
	"POOR_FIT":                               "不合身",
	"JEWELRY_TOO_SMALL":                      "首饰过小或过短",
	"JEWELRY_TOO_LARGE":                      "首饰过大或过长",
	"JEWELRY_BATTERY":                        "首饰电池失效",
	"JEWELRY_NO_DOCS":                        "首饰缺少说明书或保修卡",
	"JEWELRY_BAD_CLASP":                      "首饰搭扣损坏",
	"JEWELRY_LOOSE_STONE":                    "首饰宝石脱落或松动",
	"JEWELRY_NO_CERT":                        "首饰缺少承诺的证书",
	"JEWELRY_TARNISHED":                      "首饰氧化变色",
	"NOT_COMPATIBLE":                         "不兼容",
	"PART_NOT_COMPATIBLE":                    "配件不兼容",
	"DAMAGED_BY_FC":                          "仓库致损",
	"DAMAGED_BY_CARRIER":                     "运输致损",
	"MISSED_ESTIMATED_DELIVERY":              "配送超时",
	"NEVER_ARRIVED":                          "未收到",
	"LATE_ARRIVAL":                           "到货延迟",
	"UNDELIVERABLE_UNKNOWN":                  "无法投递",
	"UNDELIVERABLE_REFUSED":                  "无法投递（拒收）",
	"UNDELIVERABLE_UNCLAIMED":                "无法投递（无人认领）",
	"UNDELIVERABLE_INSUFFICIENT_ADDRESS":     "无法投递（地址不详）",
	"UNDELIVERABLE_FAILED_DELIVERY_ATTEMPTS": "无法投递（多次派送失败）",
	"UNAUTHORIZED_PURCHASE":                  "未经授权购买",
	"NOT_AS_PHOTO":                           "与图片不符",
	"WRONG_SIZE":                             "尺码错误",
	"NOT_COMFORTABLE":                        "穿着不舒适",
	"EXCESSIVE_INSTALLATION":                 "无法安装",
	"ACTIVATION_FAILURE":                     "激活失败",
	"CARRIER_BILL_NOT_AS_EXPECTED":           "承运商账单不符预期",
	"CARRIER_SWITCHING_COST":                 "承运商切换成本",
	"OTHER":                                  "其他",
}

var returnReasonAliases = map[string]string{
	"AMZ-PG-WJ-TOO-LARGE":    "JEWELRY_TOO_LARGE",
	"AMZ-PG-WJ-TOO-SMALL":    "JEWELRY_TOO_SMALL",
	"AMZ-PG-WJ-BATTERY":      "JEWELRY_BATTERY",
	"AMZ-PG-WJ-NO-DOCS":      "JEWELRY_NO_DOCS",
	"AMZ-PG-WJ-BAD-CLASP":    "JEWELRY_BAD_CLASP",
	"AMZ-PG-WJ-LOOSE-STONE":  "JEWELRY_LOOSE_STONE",
	"AMZ-PG-WJ-NO-CERT":      "JEWELRY_NO_CERT",
	"AMZ-PG-WJ-TARNISHED":    "JEWELRY_TARNISHED",
	"AMZ-PG-APP-STYLE":       "APPAREL_STYLE",
	"AMZ-PG-APP-TOO-LARGE":   "APPAREL_TOO_LARGE",
	"AMZ-PG-APP-TOO-SMALL":   "APPAREL_TOO_SMALL",
	"AMZ-PG-BAD-DESC":        "NOT_AS_DESCRIBED",
	"AMZ-PG-MISORDERED":      "MISORDERED",
	"CR-MISSING_ITEM_IN_SET": "MISSING_PARTS",
}

func TranslateReturnReason(value string) string {
	if value == "" {
		return value
	}
	code := strings.TrimSpace(value)
	if alias, ok := returnReasonAliases[code]; ok {
		code = alias
	} else if strings.HasPrefix(code, "CR-") {
		code = strings.TrimPrefix(code, "CR-")
	}
	if translated, ok := returnReasonTranslations[code]; ok {
		return translated
	}
	return value
}
