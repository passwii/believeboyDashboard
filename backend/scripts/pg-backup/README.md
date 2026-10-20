# PostgreSQL Backup to Cloudflare R2

本目录包含 PostgreSQL 备份到 Cloudflare R2 的配置文件和脚本，基于 pgBackRest 实现。

## 目录结构

```
pg-backup/
├── conf/
│   └── pgbackrest.conf          # pgBackRest 主配置文件
├── README.md                    # 本文档
├── daily-full-backup.sh         # 每日全量备份脚本
├── restore.sh                   # 恢复脚本 (支持 PITR)
├── backup-info.sh               # 查看备份状态
└── verify-wal-archive.sh       # WAL 归档验证
```

## 备份架构

```
PostgreSQL (VPS)
    │
    ├── WAL 文件 ──(archive-push)──> R2: backups/blf/repo/archive/
    │
    └── 每日全量备份 ──(pgBackRest backup)──> R2: backups/blf/repo/backup/
```

## 前提条件

### 1. 安装 pgBackRest

```bash
# Ubuntu/Debian
sudo apt install pgbackrest -y

# 验证安装
pgbackrest version
```

### 2. 安装 rclone (仅用于手动测试 R2 连接)

```bash
curl https://rclone.org/install.sh | sudo bash
```

### 3. 配置 PostgreSQL WAL 归档

编辑 `/etc/postgresql/*/main/postgresql.conf`:

```ini
wal_level = replica
max_wal_senders = 3
wal_keep_size = 1GB
archive_mode = on
archive_command = 'pgbackrest --stanza=blf archive-push %p'
archive_timeout = 300
```

重启 PostgreSQL:
```bash
sudo systemctl restart postgresql
```

### 4. 配置 pgBackRest

```bash
# 复制配置文件到系统目录
sudo cp conf/pgbackrest.conf /etc/pgbackrest.conf
sudo chown postgres:postgres /etc/pgbackrest.conf
sudo chmod 600 /etc/pgbackrest.conf

# 创建日志目录
sudo mkdir -p /var/log/pgbackrest
sudo chown postgres:postgres /var/log/pgbackrest

# 创建备份目录 (本地缓存)
sudo mkdir -p /var/lib/pgbackrest/backups
sudo chown postgres:postgres /var/lib/pgbackrest
sudo chmod 750 /var/lib/pgbackrest

# 创建 stanza
sudo -u postgres pgbackrest stanza-create --stanza=blf --log-level-console=info

# 验证配置
sudo -u postgres pgbackrest check --stanza=blf
```

### 5. 部署脚本

```bash
# 复制脚本到 /opt/postgresql/backup
sudo mkdir -p /opt/postgresql/backup
sudo cp *.sh /opt/postgresql/backup/
sudo chown postgres:postgres /opt/postgresql/backup/*.sh
sudo chmod 755 /opt/postgresql/backup/*.sh

# 复制日志目录
sudo mkdir -p /var/log/pgbackrest
sudo chown postgres:postgres /var/log/pgbackrest
```

### 6. 配置 crontab

```bash
sudo -u postgres crontab -e
```

添加以下行:

```cron
# PostgreSQL Daily Full Backup - 每天凌晨 3:00
0 3 * * * /opt/postgresql/backup/daily-full-backup.sh >> /var/log/pgbackrest/cron.log 2>&1

# WAL Archive Verification - 每 6 小时
0 */6 * * * /opt/postgresql/backup/verify-wal-archive.sh >> /var/log/pgbackrest/wal_verify.log 2>&1
```

## 使用方法

### 查看备份状态

```bash
# 文本格式
/opt/postgresql/backup/backup-info.sh

# JSON 格式
/opt/postgresql/backup/backup-info.sh --json

# 验证所有备份
/opt/postgresql/backup/backup-info.sh --verify
```

### 执行备份 (手动)

```bash
sudo -u postgres /opt/postgresql/backup/daily-full-backup.sh
```

### 恢复备份

```bash
# 恢复到最新备份
sudo /opt/postgresql/backup/restore.sh

# 恢复到指定日期
sudo /opt/postgresql/backup/restore.sh 2024-01-15

# 恢复到指定时间点 (PITR)
sudo /opt/postgresql/backup/restore.sh "2024-01-15 14:30:00"
```

### 验证 WAL 归档

```bash
/opt/postgresql/backup/verify-wal-archive.sh
```

## R2 存储结构

```
believeboy-private/                 # R2 Bucket（私有桶，不挂自定义域名）BLF-1418
└── backups/
    └── blf/                        # Stanza name
        └── repo/
            ├── backup/            # 备份数据
            │   ├── 20240115-030000_ful/
            │   └── 20240116-030000_ful/
            └── archive/           # WAL 归档
                └── 0000000100000000/
                    └── 000000010000000000000001
```

## 备份保留策略

| 类型 | 保留数 | 说明 |
|------|--------|------|
| 每日全量 | 7 份 | 最近 7 天 |
| 增量备份 | 7 份 | 最近 7 天 |

配置在 `conf/pgbackrest.conf`:
```ini
repo1-retention-full=7
repo1-retention-diff=7
```

## 配置说明

### pgbackrest.conf

主要配置项:

| 配置项 | 说明 | 当前值 |
|--------|------|--------|
| `repo1-s3-bucket` | R2 Bucket 名称 | believeboy-private（私有桶，BLF-1418） |
| `repo1-s3-endpoint` | R2 Endpoint URL | 见配置文件 |
| `repo1-s3-key` | R2 Access Key | 见配置文件 |
| `repo1-s3-key-secret` | R2 Secret Key | 见配置文件 |
| `repo1-retention-full` | 全量备份保留数 | 7 |
| `process-max` | 并行进程数 | 4 |
| `compress-level` | 压缩级别 | 3 |

### 脚本环境变量

可在运行时覆盖的配置:

```bash
# 指定 pgbackrest 路径
PGBACKREST=/usr/bin/pgbackrest /opt/postgresql/backup/daily-full-backup.sh

# 指定 stanza 名称
STANZA=custom-db /opt/postgresql/backup/backup-info.sh
```

## 故障排除

### pgBackRest 无法连接 R2

```bash
# 测试 R2 连接
rclone copy test-file pg-backups:believeboy-private/test --dry-run

# 检查 endpoint 是否正确
# 正确的格式: https://xxx.r2.cloudflarestorage.com
# 注意: 不是 b2ed6ca0544b57982275dedfa7bca46c.r2.cloudflarestorage.com
```

### Stanza 未找到

```bash
# 检查 stanza 配置
sudo -u postgres pgbackrest stanza-show --stanza=blf

# 重新创建 stanza (如果需要)
sudo -u postgres pgbackrest stanza-create --stanza=blf --force
```

### PostgreSQL WAL 归档失败

```bash
# 检查 PostgreSQL 配置
sudo -u postgres psql -c "SHOW archive_command;"
sudo -u postgres psql -c "SHOW archive_mode;"

# 查看归档日志
sudo tail -f /var/log/postgresql/postgresql-*-main.log | grep archive
```

### 恢复后数据不一致

恢复后 PostgreSQL 会创建新的 timeline，可能需要:
```bash
# 查看当前 timeline
sudo -u postgres psql -c "SELECT timeline_id FROM pg_catalog.pg_control_checkpoint();"

# 查看备份后的 timeline
pgbackrest info --stanza=blf
```

## 安全注意事项

1. **配置文件权限**: `/etc/pgbackrest.conf` 必须设为 600，仅 postgres 用户可读
2. **R2 凭证**: 存储在配置文件中的 Access Key 和 Secret Key 需要保护
3. **crontab**: 确保 crontab 配置正确，避免在错误时间执行备份

## 监控建议

### 备份成功/失败通知

在 `daily-full-backup.sh` 中添加邮件通知:

```bash
# 备份成功后发送通知
if [ $? -eq 0 ]; then
    curl -X POST "https://api.resend.com/emails" \
        -H "Authorization: Bearer ${RESEND_API_KEY}" \
        -d '{"from":"alerts@believeboy.com","to":"admin@believeboy.com","subject":"PG Backup Success","text":"Daily backup completed successfully"}'
fi
```

### 监控指标

建议监控:
- 备份执行时间 (duration)
- 备份大小 (size)
- R2 存储使用量
- WAL 归档延迟

## 参考资料

- [pgBackRest 官方文档](https://pgbackrest.org/)
- [pgBackRest S3/R2 配置](https://pgbackrest.org/configuration.html#section-repository/repo1-s3)
- [Cloudflare R2 文档](https://developers.cloudflare.com/r2/)