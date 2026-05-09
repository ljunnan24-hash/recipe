# 服务器常用命令（Ubuntu）

> 仅整理「在服务器上常敲的命令」；环境变量、Nginx、备案等见 [DEPLOY.md](./DEPLOY.md)。  
> 下文中 **`~/recipe`** 与 **`/home/ubuntu/recipe`** 等价，请按你机器上的实际路径替换。

---

## 1. 进入项目目录

```bash
cd ~/recipe
# 或
cd /home/ubuntu/recipe
```

确认是否为 Git 仓库：

```bash
git remote -v
git status
```

---

## 2. 拉取最新代码

```bash
cd ~/recipe
git pull origin main
```

若提示冲突或远程不一致，先备份本地改动再处理（勿在生产目录强行覆盖未备份文件）。

---

## 3. 安装依赖

```bash
cd ~/recipe
npm ci
```

若无 `package-lock.json` 或需兼容旧流程：

```bash
npm install
```

---

## 4. 前端静态资源（若使用 Nginx 托管 H5）

```bash
cd ~/recipe
npm run build
```

产物目录：`dist/`。

---

## 5. 重启 Node（PM2）

查看进程列表：

```bash
pm2 list
```

重启全部：

```bash
pm2 restart all
```

或按名称重启（名称以 `pm2 list` 里 **name** 为准）：

```bash
pm2 restart recipe
```

查看日志：

```bash
pm2 logs
```

---

## 6. 健康检查（可选）

默认端口见 `.env` / `.env.local` 中的 `SERVER_PORT`（常为 `4301`）：

```bash
curl -s http://127.0.0.1:4301/api/health
```

期望返回类似：`{"ok":true,"service":"recipe-api"}`。

---

## 7. 本项目 `/api/ai/plan` 分支与环境变量（备忘）

| `selectedCanteen` | 是否必须 `DOUBAO_API_KEY` | 典型还需 |
|-------------------|---------------------------|----------|
| `szu_south` | 否（仅本地算法） | `SUPABASE_URL`、`SUPABASE_ANON_KEY` |
| `szu_south_ai` | 是 | `DOUBAO_API_KEY` + Supabase |
| `none`（或其它非 `szu_south`） | 是 | `DOUBAO_API_KEY` |

服务端 `.env` 放置位置示例：`~/recipe/.env`（勿提交到 Git）。

---

## 8. 首次在服务器上没有仓库时

```bash
cd ~
git clone https://github.com/ljunnan24-hash/recipe.git
cd recipe
```

私有仓库需先配置 SSH 或 HTTPS 凭据。
