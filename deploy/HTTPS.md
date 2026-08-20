# HTTPS 配置说明（Vo Manager）

Nginx 已改为 **HTTPS 优先**：80 端口仅做 301 跳转 + Let's Encrypt 验证，443 提供业务并启用 HSTS。

## 证书来源（二选一）

### A. 公网域名（推荐）：Let's Encrypt
```bash
# 在 CVM 上安装 certbot，签发证书
certbot certonly --webroot -w /var/www/certbot \
  -d your.domain.com --email you@example.com --agree-tos

# 把证书挂到 CERT_DIR（docker-compose 默认 ./certs）
mkdir -p ./certs
cp /etc/letsencrypt/live/your.domain.com/fullchain.pem ./certs/fullchain.pem
cp /etc/letsencrypt/live/your.domain.com/privkey.pem    ./certs/privkey.pem
chmod 600 ./certs/privkey.pem

# 自动续期（加入 crontab）
certbot renew --quiet && cp -L /etc/letsencrypt/live/your.domain.com/* ./certs/ && docker compose restart nginx
```

### B. 内网 / VPN（无公网域名）：企业 CA 或自签
```bash
# 自签示例（仅测试/内网，浏览器需手动信任）
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout ./certs/privkey.pem -out ./certs/fullchain.pem \
  -days 365 -subj "/CN=vo-manager.internal"
```

## 启动
```bash
CERT_DIR=./certs docker compose up -d --build
curl -I https://localhost/        # 应返回 301/200 且带 Strict-Transport-Security
```

## 注意
- 证书文件 `privkey.pem` 含私钥，**务必加入 .gitignore，禁止提交**。
- 未配置证书前 443 无法启动；可临时注释 443 server 块回退到 HTTP（不推荐长期）。
- HSTS 一旦下发，浏览器会强制 HTTPS；测试环境慎用 `includeSubDomains`。
