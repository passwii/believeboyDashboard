package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
)

var seedCategories = []string{"家居", "3C", "服装", "家纺", "科学配件", "工业配件", "工具配件", "电动工具", "户外用品"}

type workflowTemplate struct {
	Key       string
	Kind      string
	Title     string
	SortOrder int
	Tasks     []workflowTask
}

type workflowTask struct {
	Title         string
	Description   string
	AttachmentKey *string
}

var seedTemplates = []workflowTemplate{
	{
		Key: "store-launch-v1", Kind: "store_launch", Title: "店铺启动", SortOrder: 0,
		Tasks: []workflowTask{
			{"店铺注册资料收集", "按《亚马逊_注册信息收集表》收集主体、法人、地址、联系方式等注册资料，汇总回传后进入注册流程。", stringPtr("amazon_registration_form")},
			{"万里汇收款账户注册", "按《万里汇海外收款注册流程》完成海外收款账户注册，并回填账户主体与账号信息。", stringPtr("worldfirst_registration_guide")},
			{"店铺业务审核", "完成卖家平台业务审核（身份/视频验证等），直至审核通过。", nil},
			{"品牌备案", "提交品牌备案（Brand Registry）并跟进平台审核结果。", nil},
			{"UPC 注册豁免", "申请 GTIN/UPC 豁免，避免上架时强制使用外部条码。", nil},
			{"收款账户后台绑定验证", "在卖家后台绑定万里汇收款账户并完成小额验证。", nil},
		},
	},
	{
		Key: "product-womens-swimwear-v1", Kind: "product_development", Title: "女士泳衣", SortOrder: 1,
		Tasks: []workflowTask{
			{"产品选款对接", "与供应商确认款式、版型、面料与目标成本，锁定选款方向。", nil},
			{"产品打样对接", "确认打样尺寸与工艺要求，跟进打样进度并评审样衣。", nil},
			{"产品包装设计", "输出包装结构与视觉设计稿，完成内部与业务方确认。", nil},
			{"产品吊卡设计", "输出吊卡文案与视觉设计稿，完成确认并交付供应商。", nil},
			{"产品洗标", "确认洗标内容（成分、洗涤说明、产地）与样式要求。", nil},
			{"完整款打样、打包与邮寄", "完成完整款打样、包装打包并邮寄，作为量产前的最终确认。", nil},
		},
	},
}

func main() {
	databaseURL := flag.String("database-url", "", "exact database URL")
	flag.Parse()
	url := strings.TrimSpace(*databaseURL)
	if url == "" {
		url = strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	}
	if url == "" {
		url = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if url == "" {
		fmt.Fprintln(os.Stderr, "seed_test_reference_data: TEST_DATABASE_URL or DATABASE_URL is required")
		os.Exit(1)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	pool, err := store.OpenPool(ctx, url)
	if err != nil {
		fmt.Fprintln(os.Stderr, "open database:", err)
		os.Exit(1)
	}
	defer pool.Close()
	db := store.NewPGXDB(pool)
	if err := seed(ctx, db); err != nil {
		fmt.Fprintln(os.Stderr, "seed reference data failed:", err)
		os.Exit(1)
	}
	fmt.Println("Test reference data ready (CRM categories + workflow templates).")
}

func seed(ctx context.Context, db store.FullDB) error {
	for index, name := range seedCategories {
		if _, err := db.Exec(ctx,
			"insert into public.crm_categories (name, sort_order) values ($1, $2) on conflict (name) do nothing",
			name, index); err != nil {
			return err
		}
	}
	for _, template := range seedTemplates {
		var templateID int64
		err := db.QueryRow(ctx, "select id from public.workflow_templates where key = $1", template.Key).Scan(&templateID)
		if err != nil {
			templateID, err = insertReturningID(ctx, db,
				"insert into public.workflow_templates (key, kind, title, description, sort_order) values ($1, $2, $3, null, $4) returning id",
				template.Key, template.Kind, template.Title, template.SortOrder)
			if err != nil {
				return err
			}
		}
		var taskCount int
		if err := db.QueryRow(ctx, "select count(*) from public.workflow_template_tasks where template_id = $1", templateID).Scan(&taskCount); err != nil {
			return err
		}
		if taskCount > 0 {
			continue
		}
		for index, task := range template.Tasks {
			if _, err := db.Exec(ctx,
				"insert into public.workflow_template_tasks (template_id, title, description, sort_order, attachment_key, duration_days) values ($1, $2, $3, $4, $5, null)",
				templateID, task.Title, task.Description, index, task.AttachmentKey); err != nil {
				return err
			}
		}
	}
	return nil
}

func insertReturningID(ctx context.Context, db store.FullDB, query string, args ...any) (int64, error) {
	var id int64
	if err := db.QueryRow(ctx, query, args...).Scan(&id); err != nil {
		return 0, err
	}
	return id, nil
}

func stringPtr(value string) *string { return &value }
