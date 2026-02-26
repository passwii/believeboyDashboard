# CORS与网络安全配置审查报告

**审查日期:** 2026-02-25  
**审查范围:** 后端CORS配置、前端安全配置、环境变量配置  
**审查重点:** CORS配置、API暴露、安全环境变量、前端中间件

---

## 一、审查概述

本次审查涵盖以下文件：

| 文件路径 | 用途 |
|----------|------|
| backend/app/main.py | 后端主应用配置 |
| backend/app/core/config.py | 后端配置文件 |
| frontend/next.config.js | Next.js安全配置 |
| frontend/vercel.json | Vercel部署配置 |
| frontend/.env.example | 前端环境变量示例 |
| frontend/middleware.ts | 前端中间件认证 |
| backend/app/core/security.py | API Key认证机制 |

---

## 二、发现的安全问题

### 2.1 严重级别 (CRITICAL)

#### 问题1: CORS配置允许所有来源且允许凭证

| 项目 | 内容 |
|------|------|
| **文件位置** | backend/app/main.py:11-17 |
| **问题描述** | CORS配置 `allow_origins=['*']` 配合 `allow_credentials=True` 是极其危险的组合 |
| **安全风险** | 1. 任何网站都可以向你的API发送带凭证的请求<br>2. 违反浏览器CORS安全策略<br>3. 容易被CSRF攻击 |
| **修复建议** | 将 `allow_origins` 改为具体的允许域名列表，移除credentials或明确限制来源 |

**当前代码 (危险):**
```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],          # 允许所有来源
    allow_credentials=True,        # 允许凭证
    allow_methods=['*'],           # 允许所有方法
    allow_headers=['*'],          # 允许所有头部
)
```

**修复后的代码:**
```python
# 在 config.py 中定义允许的来源
ALLOWED_ORIGINS = [
    "http://localhost:3000",
    "https://your-production-domain.com",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "PATCH"],
    allow_headers=["Authorization", "Content-Type", "X-API-Key"],
)
```

---

#### 问题2: Jobs端点部分缺少认证保护

| 项目 | 内容 |
|------|------|
| **文件位置** | backend/app/api/v1/endpoints/jobs.py:38-90 |
| **问题描述** | `get_job` 和 `download_job_result` 函数未继承router的 `protected` 依赖 |
| **安全风险** | 攻击者无需认证即可查看Job详情和下载结果文件 |
| **修复建议** | 在这两个函数中添加认证依赖 |

**当前代码 (无认证):**
```python
@router.get('/jobs/{job_id}', response_model=JobDetailResponse)
def get_job(job_id: int, db: Session = Depends(get_db_session)) -> JobDetailResponse:
    # 缺少 Depends(protected)
```

**修复后的代码:**
```python
@router.get('/jobs/{job_id}', response_model=JobDetailResponse)
def get_job(
    job_id: int, 
    db: Session = Depends(get_db_session),
    _: None = Depends(protected),  # 添加认证依赖
) -> JobDetailResponse:
    ...

@router.get('/jobs/{job_id}/result')
def download_job_result(
    job_id: int,
    db: Session = Depends(get_db_session),
    settings: Settings = Depends(get_settings),
    _: None = Depends(protected),  # 添加认证依赖
):
    ...
```

---

#### 问题3: 环境变量示例泄露真实配置信息

| 项目 | 内容 |
|------|------|
| **文件位置** | frontend/.env.example |
| **问题描述** | 示例文件包含真实的生产环境Supabase URL和数据库配置 |
| **安全风险** | 1. 开发者可能意外提交到代码仓库<br>2. 暴露数据库连接信息<br>3. 暴露项目标识符 |

**当前代码 (泄露敏感信息):**
```env
# Public (safe for browser)
NEXT_PUBLIC_SUPABASE_URL=https://nkeieekzajfdsuxuywux.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_or_publishable_key

# Server only (never expose to client)
SUPABASE_SECRET_KEY=your_server_secret_key

# Direct Postgres connection (for migrations/import scripts)
SUPABASE_DB_HOST=db.nkeieekzajfdsuxuywux.supabase.co
SUPABASE_DB_PORT=5432
SUPABASE_DB_NAME=postgres
SUPABASE_DB_USER=postgres
SUPABASE_DB_PASSWORD=your_db_password
```

**修复后的代码 (使用占位符):**
```env
# Public (safe for browser)
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key

# Server only (never expose to client)
SUPABASE_SECRET_KEY=your_service_role_key

# Direct Postgres connection (for migrations/import scripts)
SUPABASE_DB_HOST=db.your-project.supabase.co
SUPABASE_DB_PORT=5432
SUPABASE_DB_NAME=postgres
SUPABASE_DB_USER=postgres
SUPABASE_DB_PASSWORD=your_production_password
```

---

### 2.2 警告级别 (WARNING)

#### 问题4: API Key默认值过于简单

| 项目 | 内容 |
|------|------|
| **文件位置** | backend/app/core/config.py:22 |
| **问题描述** | API Key默认值为 `change-me`，仅要求最小长度8字符 |
| **安全风险** | 1. 生产环境可能忘记修改默认值<br>2. 弱密钥容易被暴力破解<br>3. 无复杂度要求 |

**当前代码 (不安全):**
```python
api_key: str = Field(default='change-me', min_length=8)
```

**修复建议:**
```python
import re
from pydantic import field_validator

def validate_api_key(cls, v):
    if v is None:
        raise ValueError("API Key must be configured")
    if len(v) < 32:
        raise ValueError("API Key must be at least 32 characters")
    if not re.match(r'^[A-Za-z0-9_-]+$', v):
        raise ValueError("API Key must contain only alphanumeric characters")
    return v

api_key: str = Field(default=None, validator=validate_api_key)
```

---

#### 问题5: 前端权限检查可能失效

| 项目 | 内容 |
|------|------|
| **文件位置** | frontend/middleware.ts:24 |
| **问题描述** | 权限检查依赖 `token.isAdmin` 字段，如果字段不存在可能产生逻辑错误 |
| **安全风险** | 1. 用户JWT中无isAdmin字段时可能被错误处理<br>2. 权限判断逻辑不够健壮 |

**当前代码 (可能有问题):**
```typescript
if (pathname.startsWith('/dashboard/system-management') && !token.isAdmin) {
```

**修复建议:**
```typescript
if (pathname.startsWith('/dashboard/system-management')) {
  // 检查isAdmin属性是否存在且为true
  const isAdmin = token?.isAdmin === true;
  if (!isAdmin) {
    return NextResponse.redirect(new URL('/dashboard?forbidden=1', request.url));
  }
}
```

---

#### 问题6: Next.js安全配置不完整

| 项目 | 内容 |
|------|------|
| **文件位置** | frontend/next.config.js |
| **问题描述** | 缺少一些重要的安全配置 |
| **风险**** | 1. 未隐藏技术栈信息<br>2. 图片域名未配置 |

**当前代码:**
```javascript
const nextConfig = {
  reactStrictMode: true,
  images: {
    domains: [],
    unoptimized: false,
  },
}
```

**建议配置:**
```javascript
const nextConfig = {
  reactStrictMode: true,
  // 隐藏X-Powered-By头
  poweredByHeader: false,
  images: {
    domains: ['your-cdn-domain.com'],  // 配置允许的图片域名
    unoptimized: false,
  },
  // 安全头部 (推荐使用next-secure-headers包)
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
        ],
      },
    ];
  },
}
```

---

### 2.3 信息级别 (INFO)

#### 问题7: Vercel配置已包含安全头部

| 项目 | 内容 |
|------|------|
| **文件位置** | frontend/vercel.json |
| **状态** | ✅ 已正确配置 |

Vercel部署配置已包含以下安全头部：
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `X-XSS-Protection: 1; mode=block`

---

## 三、安全建议优先级

| 优先级 | 修复项 | 预计工作量 |
|--------|--------|------------|
| P0 | 修复CORS配置 - 限制允许的域名 | 低 |
| P0 | 修复Jobs端点认证 - 添加protected依赖 | 低 |
| P0 | 清理.env.example中的真实配置信息 | 低 |
| P1 | 加强API Key配置 - 移除默认值，增加复杂度要求 | 低 |
| P1 | 改进前端权限检查逻辑 | 低 |
| P2 | 完善Next.js安全配置 | 中 |

---

## 四、总结

本次审查发现 **3个严重问题** 和 **3个警告问题**：

**严重问题：**
1. CORS配置允许所有来源且允许凭证 - 必须立即修复
2. Jobs端点部分缺少API Key认证 - 需要添加保护
3. 环境变量示例泄露真实Supabase URL和数据库配置 - 需要清理

**警告问题：**
4. API Key默认值过于简单 - 需要加强
5. 前端权限检查可能失效 - 需要改进逻辑
6. Next.js安全配置不完整 - 建议完善

**建议优先修复P0级别的问题**，确保系统基本的网络安全。

---

*本报告由自动安全审查生成*
