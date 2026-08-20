# Vo Manager · CVM 部署包

## 📦 包含什么

```
deploy/
├── docker-compose.yml          # Docker 编排（MySQL + Node + Nginx）
├── deploy.sh                    # 一键部署脚本（在 CVM 上运行）
├── .env.example                 # 环境变量模板
├── 一键部署命令.md              # ⭐ 复制这里的命令到「执行命令」
├── README.md                    # 本文件
├── backend/                     # Node.js/Express 后端
│   ├── Dockerfile
│   ├── package.json
│   ├── sql/init.sql             # 建库建表 + 种子数据
│   └── src/                     # API 代码
│       ├── index.js
│       ├── db.js
│       └── routes/
├── frontend/                    # 前端静态资源
│   ├── 互动原型-语音需求管理系统.html
│   └── assets/                  # DELTA FORCE Logo
└── nginx/
    └── default.conf             # Nginx 反代 :80 → 前端 + /api → 后端
```

## 🚀 3 步部署

### Step 1 · 上传到 CVM

打开腾讯云 CVM 控制台 → 你的 CVM (<CVM_IP>) → **顶部「文件上传」标签**

把整个 `音频-Vo管理` 文件夹（含 deploy/）**打包成 zip 上传到 `/root/`**。

或者用 winSCP / 其他方式上传都行，只要 `deploy/` 目录到达 CVM 即可。

### Step 2 · 打开「执行命令」，粘贴一段命令

打开腾讯云 CVM 控制台 → **顶部「执行命令」标签** → 粘贴 `一键部署命令.md` 里的命令 → 点执行。

首次执行约 3-5 分钟（下载 Docker + 拉镜像 + 构建后端）。

### Step 3 · 访问

浏览器打开 `http://<CVM_IP>`，你和同事就都能用了。

## 🔧 技术栈

| 组件 | 版本 | 端口 |
|------|------|------|
| MySQL | 8.0 | 3306（仅内网） |
| Node.js | 20-alpine | 3001（仅容器网络） |
| Nginx | latest-alpine | **80（对外）** |
| Express | 4.21 | — |
| mysql2 | 3.11 | — |

## 📝 数据表清单

- `voice_actors` · 声优库
- `demands` · 需求汇总
- `script_lines` · 台词表
- `script_line_history` · 台词修改留痕
- `recording_schedules` · 录制档期
- `audio_assets` · 音频资产库

## 🔗 API 端点（供前端调用）

```
GET    /api/health
GET    /api/actors                    列出声优（?role_type=干员）
POST   /api/actors                    新增声优
PATCH  /api/actors/:id                更新声优
DELETE /api/actors/:id                删除声优

GET    /api/demands                   列出需求（?release_plan=Yang1&area=AI&status=in_progress）
POST   /api/demands                   新增需求
PATCH  /api/demands/:id               更新需求

GET    /api/scripts                   列出台词（?area=AI&demand_id=1）
POST   /api/scripts                   新增台词
PATCH  /api/scripts/:id               更新台词（自动留痕）
DELETE /api/scripts/:id               删除台词

GET    /api/schedules                 列出档期（?year=2026&month=7）
POST   /api/schedules                 新增档期

GET    /api/assets                    列出资产（?voice_actor_id=1&version=Yang1&q=xxx）
POST   /api/assets/upload             上传音频（multipart/form-data · field: file）
GET    /audio/:filename               下载音频

POST   /api/tapd/sync                 TAPD 同步（占位，需 DFAI_TOKEN）
```

## ⚠️ 注意事项

- 首次部署完成后**改一下 `.env` 的 `DB_PASSWORD`**（数据库密码）
- 音频文件存 CVM 数据盘的 Docker volume（`audio_data`），50GB 数据盘可以撑
- 未来接 TAPD：填 `.env` 的 `DFAI_TOKEN`，改 `backend/src/index.js` 的 `/api/tapd/sync` 实现
- 备份见 `一键部署命令.md` 底部
