"""Router 懒分组（BLF-657 方案 1）——每个分组在首次命中时才 import。

分组模块只做 include 聚合，不引入任何额外业务逻辑。加载时机由
`app.api.v1.lazy_router.LazyGroupRouter` 控制（首次请求匹配 / openapi 生成）。
"""
