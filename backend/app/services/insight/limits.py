"""Insight Stage 1 合同常量：唯一上限来源。

endpoint / role / 测试禁止各自复制上限，一律从这里 import。
"""

#: 请求 JSON body 上限（1 MiB）
REQUEST_BODY_MAX_BYTES = 1024 * 1024

#: 单 slot canonical JSON 上限（256 KiB）
SLOT_CANONICAL_MAX_BYTES = 256 * 1024

#: 全部 slots canonical JSON 合计上限（768 KiB）
SLOTS_TOTAL_MAX_BYTES = 768 * 1024

#: 字符串最大字符数（16 KiB）
STRING_MAX_CHARS = 16 * 1024

#: 单个对象最多 key 数
OBJECT_MAX_KEYS = 100

#: 单个对象 key 最大字符数
OBJECT_KEY_MAX_CHARS = 64

#: 数组最多项数
ARRAY_MAX_ITEMS = 500

#: JSON 嵌套最大深度
JSON_MAX_DEPTH = 8

#: status 事件 detail 安全展示文本上限
STATUS_DETAIL_MAX_CHARS = 512

#: 幂等 key 正则：ASCII，1–64 字符
IDEMPOTENCY_KEY_PATTERN = r"^[A-Za-z0-9._:-]{1,64}$"

#: 受控标识正则：endpoint_id / model_id，仅小写标识
CONTROLLED_ID_PATTERN = r"^[a-z0-9][a-z0-9._-]{0,63}$"

#: report.context project_ids 上限
REPORT_PROJECT_IDS_MAX = 50

#: project.context 摘要列表上限
PROJECT_CONTEXT_MAX_ITEMS = 50

#: sku.context 摘要列表上限
SKU_CONTEXT_MAX_ITEMS = 200

#: slot 命名空间分隔符约定：小写点分隔
SLOT_NAME_PATTERN = r"^[a-z0-9]+(\.[a-z0-9]+)+$"
