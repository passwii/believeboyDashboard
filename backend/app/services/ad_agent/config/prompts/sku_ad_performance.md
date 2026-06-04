# SKU/ASIN 广告表现

## 分析目标
评估每个 SKU/ASIN 的广告投入产出比。

## 分析步骤
1. 对 promoted_product_report 的 top 行：
   - 广告 ROAS
   - 广告订单占比 = ad_orders / (ad_orders + natural_orders 估算)
2. 如果有 top_skus（自然销量）数据，计算每个 SKU 的广告依赖度
3. 如果有 inventory_summary，检查广告投入大的 SKU 是否库存充足

## 输出格式
- sku_ad_roas_table: SKU 广告 ROAS 表
- ad_dependency_analysis: 广告依赖度分析
