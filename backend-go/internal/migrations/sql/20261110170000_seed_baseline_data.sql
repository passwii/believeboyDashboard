-- Baseline seed data for fresh databases and existing 285 databases.
-- Derived from Alembic revisions 250, 251, 252, 276 and 285.
-- Idempotent: every insert uses ON CONFLICT or NOT EXISTS.

-- +goose Up
-- +goose StatementBegin

-- pgcrypto backs the Go gateway's crypt()/gen_salt() password paths.
-- Fresh databases get the extension from the baseline. Existing 285 databases
-- may have the functions as orphan objects (no pg_extension row), so create the
-- extension only when neither the extension nor the functions are present.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto')
       AND NOT EXISTS (
           SELECT 1 FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname IN ('crypt', 'gen_salt')
       ) THEN
        EXECUTE 'CREATE EXTENSION pgcrypto';
    END IF;
END $$;

-- 285: crm_intent_meta singleton (required by Go write paths).
INSERT INTO public.crm_intent_meta (id, data_rev, followup_rev)
VALUES (1, 0, 0)
ON CONFLICT (id) DO NOTHING;

-- 251: crm workflow settings singleton.
INSERT INTO public.crm_workflow_settings (id, stale_days, stale_email_enabled)
VALUES (1, 7, true)
ON CONFLICT (id) DO NOTHING;

-- 252: CRM product categories.
INSERT INTO public.crm_categories (name, sort_order)
VALUES ('家居', 0)
ON CONFLICT (name) DO NOTHING;
INSERT INTO public.crm_categories (name, sort_order)
VALUES ('3C', 1)
ON CONFLICT (name) DO NOTHING;
INSERT INTO public.crm_categories (name, sort_order)
VALUES ('服装', 2)
ON CONFLICT (name) DO NOTHING;
INSERT INTO public.crm_categories (name, sort_order)
VALUES ('家纺', 3)
ON CONFLICT (name) DO NOTHING;
INSERT INTO public.crm_categories (name, sort_order)
VALUES ('科学配件', 4)
ON CONFLICT (name) DO NOTHING;
INSERT INTO public.crm_categories (name, sort_order)
VALUES ('工业配件', 5)
ON CONFLICT (name) DO NOTHING;
INSERT INTO public.crm_categories (name, sort_order)
VALUES ('工具配件', 6)
ON CONFLICT (name) DO NOTHING;
INSERT INTO public.crm_categories (name, sort_order)
VALUES ('电动工具', 7)
ON CONFLICT (name) DO NOTHING;
INSERT INTO public.crm_categories (name, sort_order)
VALUES ('户外用品', 8)
ON CONFLICT (name) DO NOTHING;

-- 250: MVP stale-follow-up rule (rule + conditions + action).
INSERT INTO public.crm_rules
    (name, description, entity_type, event_type, enabled, priority, created_by)
SELECT '客户创建 7 天无跟进提醒（MVP）', '客户创建满 7 天且从未跟进 → 提醒负责人（P9 规则引擎 MVP，BLF-544）', 'customer', 'stale_follow_up', true, 0, NULL
WHERE NOT EXISTS (SELECT 1 FROM public.crm_rules WHERE name = '客户创建 7 天无跟进提醒（MVP）');

INSERT INTO public.crm_rule_conditions (rule_id, field, operator, value, sort_order)
SELECT r.id, 'days_since_created', 'gte', '7', 0
FROM public.crm_rules r
WHERE r.name = '客户创建 7 天无跟进提醒（MVP）'
  AND NOT EXISTS (SELECT 1 FROM public.crm_rule_conditions c WHERE c.rule_id = r.id AND c.field = 'days_since_created');

INSERT INTO public.crm_rule_conditions (rule_id, field, operator, value, sort_order)
SELECT r.id, 'last_follow_at', 'is_null', NULL, 1
FROM public.crm_rules r
WHERE r.name = '客户创建 7 天无跟进提醒（MVP）'
  AND NOT EXISTS (SELECT 1 FROM public.crm_rule_conditions c WHERE c.rule_id = r.id AND c.field = 'last_follow_at');

INSERT INTO public.crm_rule_actions (rule_id, action_type, params, sort_order)
SELECT r.id, 'notify_owner', '{"message": "客户创建满 7 天无跟进，请及时跟进"}'::json, 0
FROM public.crm_rules r
WHERE r.name = '客户创建 7 天无跟进提醒（MVP）'
  AND NOT EXISTS (SELECT 1 FROM public.crm_rule_actions a WHERE a.rule_id = r.id AND a.action_type = 'notify_owner');

-- 276: project launch templates and their tasks.
INSERT INTO public.workflow_templates (key, kind, title, description, sort_order)
SELECT 'store-launch-v1', 'store_launch', '店铺启动', NULL, 0
WHERE NOT EXISTS (SELECT 1 FROM public.workflow_templates WHERE key = 'store-launch-v1');

INSERT INTO public.workflow_template_tasks
    (template_id, title, description, sort_order, attachment_key, duration_days)
SELECT t.id, '店铺注册资料收集', '按《亚马逊_注册信息收集表》收集主体、法人、地址、联系方式等注册资料，汇总回传后进入注册流程。', 0, 'amazon_registration_form', NULL
FROM public.workflow_templates t
WHERE t.key = 'store-launch-v1'
  AND NOT EXISTS (SELECT 1 FROM public.workflow_template_tasks x WHERE x.template_id = t.id AND x.title = '店铺注册资料收集');

INSERT INTO public.workflow_template_tasks
    (template_id, title, description, sort_order, attachment_key, duration_days)
SELECT t.id, '万里汇收款账户注册', '按《万里汇海外收款注册流程》完成海外收款账户注册，并回填账户主体与账号信息。', 1, 'worldfirst_registration_guide', NULL
FROM public.workflow_templates t
WHERE t.key = 'store-launch-v1'
  AND NOT EXISTS (SELECT 1 FROM public.workflow_template_tasks x WHERE x.template_id = t.id AND x.title = '万里汇收款账户注册');

INSERT INTO public.workflow_template_tasks
    (template_id, title, description, sort_order, attachment_key, duration_days)
SELECT t.id, '店铺业务审核', '完成卖家平台业务审核（身份/视频验证等），直至审核通过。', 2, NULL, NULL
FROM public.workflow_templates t
WHERE t.key = 'store-launch-v1'
  AND NOT EXISTS (SELECT 1 FROM public.workflow_template_tasks x WHERE x.template_id = t.id AND x.title = '店铺业务审核');

INSERT INTO public.workflow_template_tasks
    (template_id, title, description, sort_order, attachment_key, duration_days)
SELECT t.id, '品牌备案', '提交品牌备案（Brand Registry）并跟进平台审核结果。', 3, NULL, NULL
FROM public.workflow_templates t
WHERE t.key = 'store-launch-v1'
  AND NOT EXISTS (SELECT 1 FROM public.workflow_template_tasks x WHERE x.template_id = t.id AND x.title = '品牌备案');

INSERT INTO public.workflow_template_tasks
    (template_id, title, description, sort_order, attachment_key, duration_days)
SELECT t.id, 'UPC 注册豁免', '申请 GTIN/UPC 豁免，避免上架时强制使用外部条码。', 4, NULL, NULL
FROM public.workflow_templates t
WHERE t.key = 'store-launch-v1'
  AND NOT EXISTS (SELECT 1 FROM public.workflow_template_tasks x WHERE x.template_id = t.id AND x.title = 'UPC 注册豁免');

INSERT INTO public.workflow_template_tasks
    (template_id, title, description, sort_order, attachment_key, duration_days)
SELECT t.id, '收款账户后台绑定验证', '在卖家后台绑定万里汇收款账户并完成小额验证。', 5, NULL, NULL
FROM public.workflow_templates t
WHERE t.key = 'store-launch-v1'
  AND NOT EXISTS (SELECT 1 FROM public.workflow_template_tasks x WHERE x.template_id = t.id AND x.title = '收款账户后台绑定验证');

INSERT INTO public.workflow_templates (key, kind, title, description, sort_order)
SELECT 'product-womens-swimwear-v1', 'product_development', '女士泳衣', NULL, 1
WHERE NOT EXISTS (SELECT 1 FROM public.workflow_templates WHERE key = 'product-womens-swimwear-v1');

INSERT INTO public.workflow_template_tasks
    (template_id, title, description, sort_order, attachment_key, duration_days)
SELECT t.id, '产品选款对接', '与供应商确认款式、版型、面料与目标成本，锁定选款方向。', 0, NULL, NULL
FROM public.workflow_templates t
WHERE t.key = 'product-womens-swimwear-v1'
  AND NOT EXISTS (SELECT 1 FROM public.workflow_template_tasks x WHERE x.template_id = t.id AND x.title = '产品选款对接');

INSERT INTO public.workflow_template_tasks
    (template_id, title, description, sort_order, attachment_key, duration_days)
SELECT t.id, '产品打样对接', '确认打样尺寸与工艺要求，跟进打样进度并评审样衣。', 1, NULL, NULL
FROM public.workflow_templates t
WHERE t.key = 'product-womens-swimwear-v1'
  AND NOT EXISTS (SELECT 1 FROM public.workflow_template_tasks x WHERE x.template_id = t.id AND x.title = '产品打样对接');

INSERT INTO public.workflow_template_tasks
    (template_id, title, description, sort_order, attachment_key, duration_days)
SELECT t.id, '产品包装设计', '输出包装结构与视觉设计稿，完成内部与业务方确认。', 2, NULL, NULL
FROM public.workflow_templates t
WHERE t.key = 'product-womens-swimwear-v1'
  AND NOT EXISTS (SELECT 1 FROM public.workflow_template_tasks x WHERE x.template_id = t.id AND x.title = '产品包装设计');

INSERT INTO public.workflow_template_tasks
    (template_id, title, description, sort_order, attachment_key, duration_days)
SELECT t.id, '产品吊卡设计', '输出吊卡文案与视觉设计稿，完成确认并交付供应商。', 3, NULL, NULL
FROM public.workflow_templates t
WHERE t.key = 'product-womens-swimwear-v1'
  AND NOT EXISTS (SELECT 1 FROM public.workflow_template_tasks x WHERE x.template_id = t.id AND x.title = '产品吊卡设计');

INSERT INTO public.workflow_template_tasks
    (template_id, title, description, sort_order, attachment_key, duration_days)
SELECT t.id, '产品洗标', '确认洗标内容（成分、洗涤说明、产地）与样式要求。', 4, NULL, NULL
FROM public.workflow_templates t
WHERE t.key = 'product-womens-swimwear-v1'
  AND NOT EXISTS (SELECT 1 FROM public.workflow_template_tasks x WHERE x.template_id = t.id AND x.title = '产品洗标');

INSERT INTO public.workflow_template_tasks
    (template_id, title, description, sort_order, attachment_key, duration_days)
SELECT t.id, '完整款打样、打包与邮寄', '完成完整款打样、包装打包并邮寄，作为量产前的最终确认。', 5, NULL, NULL
FROM public.workflow_templates t
WHERE t.key = 'product-womens-swimwear-v1'
  AND NOT EXISTS (SELECT 1 FROM public.workflow_template_tasks x WHERE x.template_id = t.id AND x.title = '完整款打样、打包与邮寄');

-- +goose StatementEnd

-- +goose Down
-- Seed data is intentionally retained on downgrade; remove manually if required.
