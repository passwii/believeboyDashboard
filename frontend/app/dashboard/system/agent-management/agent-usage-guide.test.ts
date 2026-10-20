import { describe, expect, it } from 'vitest'

import { buildUsageText } from './agent-usage-guide'

describe('buildUsageText', () => {
  it('未提供 baseUrl 时保留 <后端地址> 占位符', () => {
    const text = buildUsageText({ plaintextKey: 'bbx_test', agentId: 'agent-1' })
    expect(text).toContain('<后端地址>')
  })

  it('传入 baseUrl 时替换占位符为真实 API 地址', () => {
    const text = buildUsageText({
      plaintextKey: 'bbx_test',
      agentId: 'agent-1',
      baseUrl: 'https://dash-api.believeboy.com',
    })
    expect(text).toContain('https://dash-api.believeboy.com/api/v1/agent/health')
    expect(text).toContain(
      'https://dash-api.believeboy.com/api/v1/agent/projects/$PROJECT_ID/shipments?page_size=20'
    )
    expect(text).not.toContain('<后端地址>')
  })

  it('BLF-461：示例里先展示「项目名 → ID」解析步骤，不再用 {project_id} 占位符', () => {
    const text = buildUsageText({
      plaintextKey: 'bbx_test',
      agentId: 'agent-1',
      baseUrl: 'https://dash-api.believeboy.com',
    })
    expect(text).toContain('/projects?name=')
    expect(text).toContain('$PROJECT_ID')
    expect(text).not.toContain('{project_id}')
  })

  it('baseUrl 末尾斜杠会被去掉，避免出现双斜杠', () => {
    const text = buildUsageText({
      plaintextKey: 'bbx_test',
      agentId: 'agent-1',
      baseUrl: 'https://dash-api.believeboy.com/',
    })
    expect(text).toContain('https://dash-api.believeboy.com/api/v1/agent/health')
    expect(text).not.toContain('com//api')
  })

  it('baseUrl 为空串时回退占位符', () => {
    const text = buildUsageText({
      plaintextKey: 'bbx_test',
      agentId: 'agent-1',
      baseUrl: '',
    })
    expect(text).toContain('<后端地址>')
  })
})

describe('buildUsageText · 业务域分支（BLF-448）', () => {
  it('缺省 domain 仍为货件示例（兼容旧签名）', () => {
    const text = buildUsageText({ plaintextKey: 'bbx_test', agentId: 'agent-1' })
    expect(text).toContain('/shipments?page_size=20')
  })

  it('domain=shipments 显式货件示例', () => {
    const text = buildUsageText({
      plaintextKey: 'bbx_test',
      agentId: 'agent-1',
      domain: 'shipments',
    })
    expect(text).toContain('/shipments?page_size=20')
    expect(text).toContain('货件管理')
  })

  it('domain=shop_calculations 输出店铺测算示例', () => {
    const text = buildUsageText({
      plaintextKey: 'bbx_test',
      agentId: 'agent-1',
      domain: 'shop_calculations',
    })
    expect(text).toContain('/shop-calculations?page_size=20')
    expect(text).toContain('/shop-calculations/compute')
    expect(text).toContain('店铺测算')
    expect(text).not.toContain('/shipments?page_size=20')
  })

  it('domain=shop_calculations 含定价派生块 anchor 与 BI 扁平 3 路由（BLF-1043）', () => {
    const text = buildUsageText({
      plaintextKey: 'bbx_test',
      agentId: 'agent-1',
      domain: 'shop_calculations',
    })
    // 锚本身 + 自检恒等式 + 参数
    expect(text).toContain('breakeven_advertising_rate')
    expect(text).toContain('non_ad_fee_usd')
    expect(text).toContain('max_ad_spend_per_unit_usd')
    expect(text).toContain('target_net_margin')
    expect(text).toContain('include_anchor')
    expect(text).toContain('breakeven_advertising_rate ≡ advertising_rate + profit_rate')
    // 实际在用的 BI 扁平 3 条路由（此前完全没列）
    expect(text).toContain('/shop-calculation-history')
    expect(text).toContain('/shop-calculation/snapshots')
    expect(text).toContain('/pricing-snapshots')
    expect(text).toContain('include_anchor=false')
  })

  it('domain=return_analysis 输出退货分析示例（BLF-474）', () => {
    const text = buildUsageText({
      plaintextKey: 'bbx_test',
      agentId: 'agent-1',
      domain: 'return_analysis',
    })
    expect(text).toContain('退货分析')
    expect(text).toContain('/return-analysis/overview')
    expect(text).toContain('/return-analysis?period=30d')
    expect(text).toContain('/return-analysis-raw')
    expect(text).toContain('/return-analysis/skus/{sku}')
    expect(text).toContain('/return-analysis/coverage')
    expect(text).not.toContain('/shipments?page_size=20')
    expect(text).not.toContain('尚未接入 Agent API')
  })

  it('domain=inventory 输出库存信息示例（BLF-478）', () => {
    const text = buildUsageText({
      plaintextKey: 'bbx_test',
      agentId: 'agent-1',
      domain: 'inventory',
    })
    expect(text).toContain('库存信息')
    expect(text).toContain('/inventory?country=US')
    expect(text).toContain('/inventory?country=US&sku=X-001')
    expect(text).toContain('report_date')
    expect(text).toContain('补货分析')
    expect(text).not.toContain('/shipments?page_size=20')
    expect(text).not.toContain('尚未接入 Agent API')
  })

  it('domain=inventory_ledger 输出库存台账示例（BLF-485）', () => {
    const text = buildUsageText({
      plaintextKey: 'bbx_test',
      agentId: 'agent-1',
      domain: 'inventory_ledger',
    })
    expect(text).toContain('库存台账')
    expect(text).toContain('/inventory-ledger/months')
    expect(text).toContain('/inventory-ledger/snapshot?period=last_month')
    expect(text).toContain('/inventory-ledger/events?period=2026-06')
    expect(text).toContain('/inventory-ledger/receipt-clusters?period=30d')
    expect(text).toContain('/inventory-ledger/integrity?period=last_month')
    expect(text).toContain('/inventory-ledger/trend?months=6')
    expect(text).toContain('/inventory-ledger/detail?period=2026-06')
    expect(text).toContain('/inventory-ledger/summary?period=2026-06')
    expect(text).toContain('/inventory-ledger/batches?limit=20')
    expect(text).toContain('/inventory-ledger/consistency?period=last_month')
    expect(text).toContain('period=custom')
    expect(text).not.toContain('/shipments?page_size=20')
    expect(text).not.toContain('尚未接入 Agent API')
  })

  it('domain=report_upload_status 输出报表状态示例（BLF-484）', () => {
    const text = buildUsageText({
      plaintextKey: 'bbx_test',
      agentId: 'agent-1',
      domain: 'report_upload_status',
    })
    expect(text).toContain('报表状态')
    expect(text).toContain('/report-upload-status?report_date=2026-06-15&country=US')
    expect(text).toContain('report_date')
    expect(text).toContain('missing_report_types')
    expect(text).not.toContain('/shipments?page_size=20')
    expect(text).not.toContain('尚未接入 Agent API')
  })

  it('domain=ad_analysis 输出广告分析示例（BLF-490，10 条聚合路由）', () => {
    const text = buildUsageText({
      plaintextKey: 'bbx_test',
      agentId: 'agent-1',
      domain: 'ad_analysis',
    })
    expect(text).toContain('广告分析')
    expect(text).toContain('/ad-campaigns?period=30d&country=US')
    expect(text).toContain('/ad-search-terms?period=30d&country=US')
    expect(text).toContain('/ad-budgets?period=30d&country=US')
    expect(text).toContain('/ad-targets?period=30d&country=US')
    expect(text).toContain('/ad-placements?period=30d&country=US')
    expect(text).toContain('/ad-promoted-products?period=30d&country=US')
    expect(text).toContain('/ad-time-trends?period=30d&country=US')
    expect(text).toContain('/ad-search-term-shares?period=30d&country=US')
    expect(text).toContain('/ad-invalid-traffic?period=30d&country=US')
    expect(text).toContain('/ad-purchased-products?period=30d&country=US')
    expect(text).toContain('period=custom')
    expect(text).toContain('ad-campaigns-raw')
    expect(text).not.toContain('/shipments?page_size=20')
    expect(text).not.toContain('尚未接入 Agent API')
  })

  it('domain=replenishment_analysis 输出补货分析示例（BLF-502，6 条路由）', () => {
    const text = buildUsageText({
      plaintextKey: 'bbx_test',
      agentId: 'agent-1',
      domain: 'replenishment_analysis',
    })
    expect(text).toContain('补货分析')
    expect(text).toContain('/replenishment-analysis?country=US&inventory_state=critical')
    expect(text).toContain('replenishment_action')
    expect(text).toContain('/replenishment-analysis/skus/')
    expect(text).toContain('/replenishment-analysis/summary')
    expect(text).toContain('/replenishment-analysis/coverage')
    expect(text).toContain('/replenishment-analysis/settings')
    expect(text).toContain('confirm_token')
    expect(text).toContain('decision_path')
    expect(text).not.toContain('/shipments?page_size=20')
    expect(text).not.toContain('尚未接入 Agent API')
  })

  it('domain=new_product_calculations 输出新品测算示例（BLF-526，5 条路由）', () => {
    const text = buildUsageText({
      plaintextKey: 'bbx_test',
      agentId: 'agent-1',
      domain: 'new_product_calculations',
    })
    expect(text).toContain('新品测算')
    expect(text).toContain('/new-product-calculations?calculation_type=profit_calc')
    expect(text).toContain('/new-product-calculations/skus/{sku}')
    expect(text).toContain('/new-product-calculations/skus/{sku}/audit')
    expect(text).toContain('/new-product-calculations/compute')
    expect(text).toContain('confirm_token')
    expect(text).toContain('fbm_calc')
    expect(text).toContain('anchor')
    expect(text).toContain('breakeven_advertising_rate')
    expect(text).toContain('target_profit_rate')
    expect(text).not.toContain('/shipments?page_size=20')
    expect(text).not.toContain('尚未接入 Agent API')
  })

  it('domain=account_health 输出店铺合规健康示例（BLF-551，5 条纯读路由）', () => {
    const text = buildUsageText({
      plaintextKey: 'bbx_test',
      agentId: 'agent-1',
      domain: 'account_health',
    })
    expect(text).toContain('店铺合规健康')
    expect(text).toContain('/account-health/periods')
    expect(text).toContain('/account-health/periods/current')
    expect(text).toContain('/account-health/periods/{period_id}/overview')
    expect(text).toContain('/account-health/periods/{period_id}/projects/{project_id}')
    expect(text).toContain('/account-health/history')
    expect(text).not.toContain('/shipments?page_size=20')
    expect(text).not.toContain('尚未接入 Agent API')
  })

  it('domain=sales 输出销售数据示例（BLF-569，1 条纯读路由）', () => {
    const text = buildUsageText({
      plaintextKey: 'bbx_test',
      agentId: 'agent-1',
      domain: 'sales',
    })
    expect(text).toContain('销售数据')
    expect(text).toContain('/sales/summary?period=30d&country=US')
    expect(text).toContain('group_by=asin|asin_day|day')
    expect(text).toContain('/sales/summary?period=30d&country=US&group_by=asin')
    expect(text).toContain('/sales/summary?period=30d&country=US,DE&group_by=day')
    expect(text).toContain('by_country')
    expect(text).not.toContain('/shipments?page_size=20')
    expect(text).not.toContain('尚未接入 Agent API')
  })

  it('domain=sku_info 输出 SKU 主数据示例（BLF-579/BLF-628，读3+写4 全 confirm）', () => {
    const text = buildUsageText({
      plaintextKey: 'bbx_test',
      agentId: 'agent-1',
      domain: 'sku_info',
    })
    expect(text).toContain('SKU 主数据')
    expect(text).toContain('/sku-info?country=US&page_size=20')
    expect(text).toContain('/sku-info/{sku_record_id}')
    expect(text).toContain('/sku-info/{sku_record_id}/audit')
    expect(text).toContain('confirm_token')
    expect(text).toContain('agent_listing_pull')
    expect(text).toContain('agent_user_supplied')
    expect(text).toContain('external_api')
    expect(text).toContain('SKU_INFO_INVALID_SOURCE')
    expect(text).toContain('SKU_INFO_DUPLICATE')
    expect(text).toContain('/sku-info/{sku_record_id}/status')
    expect(text).toContain('is_active')
    expect(text).toContain('/sku-info/{sku_record_id}/fnsku-label')
    expect(text).toContain('-F "file=@./fnsku-label.pdf"')
    expect(text).toContain('X-Confirm-Token')
    expect(text).toContain('sku_info.upload_fnsku_label')
    expect(text).not.toContain('/shipments?page_size=20')
    expect(text).not.toContain('尚未接入 Agent API')
  })

  it('domain=platform_inspection 输出平台巡检写侧示例（BLF-948，R0+W1–W4 共 5 条路由）', () => {
    const text = buildUsageText({
      plaintextKey: 'bbx_test',
      agentId: 'agent-1',
      domain: 'platform_inspection',
    })
    expect(text).toContain('平台巡检')
    expect(text).toContain('/platform-inspection/template')
    expect(text).toContain(
      '/platform-inspection/periods/{period_id}/projects/$PROJECT_ID/screenshots'
    )
    expect(text).toContain(
      '/platform-inspection/periods/{period_id}/projects/$PROJECT_ID/submit'
    )
    expect(text).toContain('/platform-inspection/periods/{period_id}/projects/$PROJECT_ID')
    expect(text).toContain('/platform-inspection/screenshots/{screenshot_id}')
    expect(text).toContain('confirm_token')
    expect(text).toContain('X-Confirm-Token')
    expect(text).toContain('显式字段合并')
    expect(text).toContain('account_health')
    expect(text).not.toContain('/shipments?page_size=20')
    expect(text).not.toContain('尚未接入 Agent API')
  })

  it('domain=review_tracking 输出评论追踪采集示例（BLF-1378，R1+W1 共 2 条路由）', () => {
    const text = buildUsageText({
      plaintextKey: 'bbx_test',
      agentId: 'agent-1',
      domain: 'review_tracking',
    })
    expect(text).toContain('评论追踪')
    expect(text).toContain('/review-tracking/targets')
    expect(text).toContain('/review-tracking/targets/$TARGET_ID/runs')
    // 幂等与顺序护栏是本域最容易踩的语义，必须在派发文档里写明
    expect(text).toContain('replayed=true')
    expect(text).toContain('REVIEW_TRACKING_CAPTURE_OUT_OF_ORDER')
    expect(text).toContain('captured_at_in_future')
    expect(text).toContain('is_complete_list')
    expect(text).not.toContain('/shipments?page_size=20')
    expect(text).not.toContain('尚未接入 Agent API')
  })

  it('domain=review_tracking 的 W1 示例只给幂等键一处，且 captured_at / 幂等键是每次生成的占位（BLF-1376 复审 P1）', () => {
    const text = buildUsageText({
      plaintextKey: 'bbx_test',
      agentId: 'agent-1',
      domain: 'review_tracking',
    })
    // 提取 W1 示例的 curl 块（从提交采集结果到 body 结束）
    const w1Start = text.indexOf('/review-tracking/targets/$TARGET_ID/runs')
    expect(w1Start).toBeGreaterThan(-1)
    const w1 = text.slice(w1Start, text.indexOf('\n\n', w1Start))

    // ① 幂等键只保留一处：示例只在 Idempotency-Key 头上给，body 不再带 idempotency_key
    //    （头 + body 同时给且不一致 → 后端 400 VALIDATION_FAILED）
    expect(w1).toContain('-H "Idempotency-Key: ')
    expect(w1).not.toContain('"idempotency_key":')
    // 旧的钉死字面量占位符与固定 target-12 key 一并清掉
    expect(w1).not.toContain('Idempotency-Key: <≤64 字符>')
    expect(w1).not.toContain('target-12')

    // ② captured_at / 幂等键必须一眼看出是每次生成的占位，不能钉成一次性字面量
    const bodyMatch = w1.match(/-d '(\{.*\})'/)
    expect(bodyMatch).not.toBeNull()
    const body = JSON.parse(bodyMatch![1]) as Record<string, unknown>
    expect(String(body.captured_at).startsWith('<')).toBe(true)
    // 保留时区格式示范
    expect(String(body.captured_at)).toContain('+08:00')
    expect(body.idempotency_key).toBeUndefined()
  })

  it('domain=review_tracking 的 R1 示例不过滤 kind，外部竞品目标也要能被采集（BLF-1376 复审 P1 第 2 轮）', () => {
    const text = buildUsageText({
      plaintextKey: 'bbx_test',
      agentId: 'agent-1',
      domain: 'review_tracking',
    })
    // 提取 R1 示例的 curl 块（从读取采集目标到第一个空行）
    const r1Start = text.indexOf('/review-tracking/targets')
    expect(r1Start).toBeGreaterThan(-1)
    const r1 = text.slice(r1Start, text.indexOf('\n\n', r1Start))

    // 后端 kind 参数可空：不传时同时返回 internal_group 与 external_asin。
    // 示例里一旦带上 ?kind=internal_group，采集 Agent 就永远拿不到竞品 ASIN 那半边，
    // 也无法为它们提交采集结果。
    expect(r1).not.toContain('?kind=')
    expect(r1).not.toContain('kind=internal_group')
    expect(r1).not.toContain('kind=external_asin')
    // URL 必须保持裸路径（不带任何 query），否则示例就预设了过滤
    expect(r1).toContain('review-tracking/targets"')
    // 文档里要写明「按 item.kind 分流」而不是「靠 URL 参数砍掉一半」
    expect(text).toContain('item.kind')
  })

  it('domain=review_tracking 的 R1 示例要求翻完全部分页，W1 示例默认 is_complete_list=false（BLF-1376 复审 P1 第 3 轮）', () => {
    const text = buildUsageText({
      plaintextKey: 'bbx_test',
      agentId: 'agent-1',
      domain: 'review_tracking',
    })

    // ① 分页：R1 的 limit 默认 200、offset 默认 0，只发一次默认请求只能拿到前 200 条，
    //    第 201 条之后的目标永远排不进采集队列。文档必须要求按 offset 递增翻到 total。
    expect(text).toContain('必须翻完所有分页')
    expect(text).toContain('offset=0,200,400')

    // ② is_complete_list：置 true 时，本次 reviews 里没出现的可见评论会被计缺失，
    //    连续两次就误判「疑似移除」。抓不全却置 true 是假数据，示例必须默认 false。
    const w1Start = text.indexOf('/review-tracking/targets/$TARGET_ID/runs')
    expect(w1Start).toBeGreaterThan(-1)
    const w1 = text.slice(w1Start, text.indexOf('\n\n', w1Start))
    const bodyMatch = w1.match(/-d '(\{.*\})'/)
    expect(bodyMatch).not.toBeNull()
    const body = JSON.parse(bodyMatch![1]) as Record<string, unknown>
    expect(body.is_complete_list).toBe(false)
    // 三种 reviews 语义（null / [] / [...]）不可合并，必须在文档里写明
    expect(text).toContain('reviews 三种语义不可合并')
    expect(text).toContain('不能提交 []')
  })

  it('domain=review_tracking 的 W1 文档写清星级数组顺序、review_key 去重与 W1 响应（BLF-1376 复审第 4 轮自查）', () => {
    const text = buildUsageText({
      plaintextKey: 'bbx_test',
      agentId: 'agent-1',
      domain: 'review_tracking',
    })

    const w1Start = text.indexOf('/review-tracking/targets/$TARGET_ID/runs')
    expect(w1Start).toBeGreaterThan(-1)
    const w1 = text.slice(w1Start, text.indexOf('\n\n', w1Start))
    const bodyMatch = w1.match(/-d '(\{.*\})'/)
    expect(bodyMatch).not.toBeNull()
    const body = JSON.parse(bodyMatch![1]) as {
      rating?: { star_percentages?: number[] }
    }

    // ① 星级百分比数组的顺序：服务端按下标 0=1★ … 下标 4=5★ 落库，
    //    而 Amazon 页面直出是 5★→1★。不写清顺序，采集端照页面顺序填就会把
    //    5 星占比写进 1 星桶，运营页星级分布整条错位。
    expect(text).toContain('1 星 → 5 星')
    expect(text).toContain('采集端必须自己按星级重排')
    // 示例数组本身也必须是 1→5 序（[7,3,6,20,64] = 1★7% … 5★64%）
    expect(body.rating?.star_percentages).toEqual([7, 3, 6, 20, 64])
    // 合计不必等于 100：页面原始比例有舍入，别为了凑 100 调数
    expect(text).toContain('合计不必等于 100')

    // ② reviews[] 内 review_key 重复会被服务端静默去重（只留最后一条），
    //    且 review_key 是当前态唯一键 —— 必须写明，否则采集端以为能同键多传。
    expect(text).toContain('reviews[] 内 review_key 重复')
    expect(text).toContain('UNIQUE(target_id, review_key)')
    expect(text).toContain('derived')

    // ③ W1 响应字段要写出来（采集端要靠 reviews_suspected_removed 判断是否
    //    真有评论被标记疑似移除）
    expect(text).toContain('reviews_suspected_removed')
    expect(text).toContain('replayed')

    // ④ 凭据缺该业务域 → 403（与项目越权 403 不是同一个码）
    expect(text).toContain('AGENT_BUSINESS_OUT_OF_SCOPE')
    // ⑤ marketplace 长度上限 2，避免照抄超长值白跑一次 400
    expect(text).toContain('2 个字母')

    // ⑥ 共享页脚的限流字面量：后端写桶已由 BLF-782 从 30 提到 120/minute，
    //    但页脚一直写着 30 —— 照着它做批处理的 Agent 会白白把频率压到 1/4。
    expect(text).toContain('读 300 次/分钟，写 120 次/分钟')
    expect(text).not.toContain('写 30 次/分钟')

    // ⑦ star_count_quality 描述的是「绝对星数」的口径，不是百分比的口径：
    //    把百分比反推的数当 exact 填，运营页就会把估算值显示成确定值。
    expect(text).toContain('star_count_quality 描述的是 star_counts')
    expect(text).not.toContain('star_count_quality 描述的是 star_percentages')

    // ⑧ 同日重跑不受「同日一快照」限制，但仍受顺序护栏（必须更晚的 captured_at）
    expect(text).toContain('同一业务日重跑')
    expect(text).toContain('仍受上面这条顺序护栏')
  })

  it('未知域输出占位说明', () => {
    const text = buildUsageText({
      plaintextKey: 'bbx_test',
      agentId: 'agent-1',
      domain: 'mystery_domain',
    })
    expect(text).toContain('尚未接入 Agent API')
  })
})
