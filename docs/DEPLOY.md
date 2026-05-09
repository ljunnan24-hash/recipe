# 生产部署与上线顺序（腾讯云轻量 + 域名备案 + 小程序）

## 推荐顺序（和你目标的对应关系）

1. **代码就绪** → `git push` 到 GitHub（本仓库已支持生产构建与生产环境关闭调试接口）。
2. **服务器部署** → 克隆项目、`npm ci`、`npm run build`、配置 `.env`、`pm2` + **Nginx**（可先通过 **公网 IP** 测通，不依赖备案完成）。
3. **ICP 备案** → 在腾讯云备案流程中完成；备案期间按管局/接入商要求操作（是否可先解析域名以各地规则为准）。
4. **备案通过后** → 域名 **A 记录** 指向服务器公网 IP，申请 **HTTPS 证书**（Let’s Encrypt 或腾讯云证书），Nginx 启用 443。
5. **微信小程序** → 公众平台配置 **request 合法域名**（须 HTTPS）；原生小程序修改 `miniprogram/utils/config.js` 里的 `API_BASE` 与合法域名一致。

> **说明**：「先部署再备案」常见做法是：服务器用 IP 或临时方式验证 Node/Nginx；**对外正式用域名 + HTTPS** 往往在备案通过、解析生效之后。具体以腾讯云备案向导为准。

---

## 服务器环境变量（`~/recipe/.env`）

从本仓库 **`.env.example`** 对照填写，至少：

- `DOUBAO_API_KEY`（必填，AI 才可用）
- `SERVER_PORT=4301`（与下方 Nginx 一致）
- `SUPABASE_URL` / `SUPABASE_ANON_KEY`（食堂/成分表需要）
- **`NODE_ENV=production`**（关闭 `/api/test-doubao`、`/api/test-supabase` 等调试路由）

---

## 前端构建（H5）

**推荐架构**：同一域名，Nginx 提供静态文件 + 将 `/api` 反代到 Node → **无需** 设置 `VITE_API_BASE`。

```bash
cd ~/recipe
npm ci
npm run build
```

产物在 `dist/`，由 Nginx `root` 指向该目录。

### 邮箱登录 + 云端用户档案（Supabase）

1. 在 Supabase SQL Editor 执行：`docs/supabase-user-profiles.sql`（创建 `user_profiles` 表 + RLS）。
2. 若需「保存方案后下次登录仍可见」：再执行 `docs/supabase-saved-meal-plan.sql`（表 `user_saved_meal_plan`）。
3. 若需「饮食记录 / 饮水 / 按日事件 / 健康报告」云端同步：再执行 `docs/supabase-daily-logs-and-report.sql`（表 `user_daily_log`、`user_health_report`）。
4. Supabase Authentication → **URL Configuration**：把 `Site URL` 设为你的线上站点（如 `https://你的域名/`），并把 `Redirect URLs` 加入同域名（开发可加 `http://localhost:5173/`）。
5. 服务器构建前在 `~/recipe/.env.production`（或构建环境变量）写入：

```env
VITE_SUPABASE_URL=你的_SUPABASE_URL
VITE_SUPABASE_ANON_KEY=你的_SUPABASE_ANON_KEY
```

> 说明：`anon key` 本来就是“可公开”的浏览器密钥；真正敏感的是服务端 `.env` 里的 `DOUBAO_API_KEY`。

6. 重新 `npm run build` 并部署 `dist/`。

若 API 在 **独立子域**（如 `api.example.com`），则在构建前增加 `.env.production`：

```env
VITE_API_BASE=https://api.example.com/api
```

并在服务端 `.env` 设置 `ALLOWED_ORIGINS=https://www.example.com`（与浏览器访问页面的 Origin 一致）。

---

## Nginx 配置（建议分两步）

### 第一步：只用 HTTP + 公网 IP（先跑通）

适合：**还没有 HTTPS 证书**、或先用 **IP 访问** 验证。小程序正式环境需要 HTTPS，此步仅用于服务器自检。

1. 安装：`sudo apt install -y nginx`
2. 新建站点：`sudo nano /etc/nginx/sites-available/recipe`
3. 粘贴下面整段（`root` 需指向你已 `npm run build` 的 `dist`）：

```nginx
server {
    listen 80;
    server_name _;

    root /home/ubuntu/recipe/dist;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:4301;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 25m;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

4. 启用并关掉默认站点（避免抢 80 端口）：

```bash
sudo ln -sf /etc/nginx/sites-available/recipe /etc/nginx/sites-enabled/recipe
sudo rm -f /etc/nginx/sites-enabled/default
```

5. 检查并重载：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

6. 浏览器访问 `http://公网IP`；自检：`curl -s http://公网IP/api/health`

---

### 第二步：有备案域名 + HTTPS（小程序 / 正式对外）

域名解析到本机、证书就绪后，将 `server_name` 换成域名，并配置 `listen 443 ssl` 与证书路径（Certbot 或腾讯云证书）。

将 `your-domain.com` 换成你的备案域名；证书路径按实际修改。

```nginx
server {
    listen 80;
    server_name your-domain.com www.your-domain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com www.your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    root /home/ubuntu/recipe/dist;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:4301;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 25m;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

---

## PM2 启动后端

```bash
cd ~/recipe
export NODE_ENV=production
pm2 start server/index.js --name recipe-api
pm2 save
pm2 startup
```

---

## 微信小程序

编辑 `miniprogram/utils/config.js`：

```js
const API_BASE = 'https://your-domain.com/api'
```

与公众平台 **request 合法域名** 的根一致（不要带路径到「域名」输入框时按微信规则填写）。

---

## 部署与更新备忘（踩坑记录）

以下为真实环境排查时的经验，避免「路径不对、PM2 找不到、命令打错」反复卡住。

### 1. 项目目录在哪

- 文档里常写 `~/recipe`，但 **`~` 随登录用户变化**：`root` 的 `~/recipe` 是 **`/root/recipe`**，`ubuntu` 的则是 **`/home/ubuntu/recipe`**。
- 腾讯云轻量默认用 **`ubuntu` 用户**克隆时，代码往往在 **`/home/ubuntu/recipe`**，在 root 下执行 `cd ~/recipe` 会报 **No such file** 属正常。
- 不记得路径时，在服务器上搜索目录名：

```bash
find /root /home /opt /var/www -maxdepth 6 -type d -name "recipe" 2>/dev/null
```

进入目录后可用 `pwd` 确认；**Nginx 的 `root`** 必须指向该目录下的 **`dist/`**（例如 `/home/ubuntu/recipe/dist`）。

### 2. 首次部署 vs 更新代码

- 若服务器上**还没有**克隆过仓库，不存在项目目录，需先 **`git clone`**（再 `cd` 进去配 `.env`、`npm ci`、`npm run build`），不能只做 `git pull`。
- **`git pull origin main`**：从当前仓库配置的远程 **`origin`** 拉取 **`main`** 分支；实际 URL 以仓库为准，在**项目目录内**执行 `git remote -v` 可看到（一般为 GitHub 上的本仓库地址）。

### 3. PM2 与 Linux 用户

- **PM2 进程列表按操作系统用户隔离**：在 **`root`** 下执行 `pm2 list` 为空，不代表服务没跑——可能曾在 **`ubuntu`** 用户下执行过 `pm2 start`。
- 排查或重启时，先 **`su - ubuntu`**（或 SSH 直接登录 `ubuntu`），再：

```bash
cd /home/ubuntu/recipe
pm2 list
pm2 restart recipe-api
```

- 进程名是 **`recipe-api`**（中间有连字符），查看详情用：`pm2 show recipe-api`（不要拆成两个单词）。

### 4. 命令与权限

- **`systemctl reload nginx`**：服务名是 **`nginx`**，若打成 **`ngin`** 会报 **Unit not found**。
- 已是 **root** 时一般**不需要** `sudo`；精简镜像若提示 **`sudo: command not found`**，可 `apt install -y sudo`，或直接用 root 执行 `nginx -t`、`systemctl reload nginx`。
- 不要用 **`sudo root`** 这类无效命令；需要 root 权限时直接以 root 登录或使用 **`sudo -i`**（在具备 sudo 的普通用户下）。

### 5. 更新网页版（路径已确定为 `/home/ubuntu/recipe` 时）

在 **`ubuntu` 用户**下（与当初克隆、PM2 启动用户保持一致）：

```bash
cd /home/ubuntu/recipe
git pull origin main
npm ci
npm run build
pm2 restart recipe-api
```

root 下重载 Nginx（若需）：

```bash
nginx -t && systemctl reload nginx
```

---

## 自检清单

- [ ] `curl -s https://你的域名/api/health` 返回 JSON `ok`
- [ ] 浏览器打开 `https://你的域名` 能加载 H5
- [ ] 生产环境访问 `/api/test-doubao` 应为 **404**（除非临时设置 `ENABLE_DEBUG_ROUTES=1`）
- [ ] 小程序真机预览前，开发工具可关「不校验域名」仅作本地调试
