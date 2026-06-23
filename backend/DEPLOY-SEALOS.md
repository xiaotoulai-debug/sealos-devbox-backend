# EMAG 后端 — Sealos 部署指南

## 1. 构建镜像

在 `backend` 目录下执行：

```bash
cd backend
docker build -t emag-backend:latest .
```

如需推送到镜像仓库（供 Sealos 拉取）：

```bash
# 示例：推送到 Docker Hub
docker tag emag-backend:latest 你的用户名/emag-backend:latest
docker push 你的用户名/emag-backend:latest

# 或推送到 Sealos 云镜像仓库
docker tag emag-backend:latest registry.sealos.io/你的空间/emag-backend:latest
docker push registry.sealos.io/你的空间/emag-backend:latest
```

---

## 2. 在 Sealos「应用管理」中部署

### 2.1 创建应用

1. 登录 [Sealos 控制台](https://cloud.sealos.io)
2. 进入 **应用管理** → **新建应用**
3. 选择 **自定义应用** 或 **Deployment**

### 2.2 配置镜像

- **镜像地址**：填写你推送后的镜像，例如：
  - `你的用户名/emag-backend:latest`（Docker Hub）
  - `registry.sealos.io/你的空间/emag-backend:latest`（Sealos 云镜像）
- **镜像拉取策略**：`Always` 或 `IfNotPresent`

### 2.3 配置环境变量（关键）

在「环境变量」中新增以下变量，**务必使用内网数据库地址**：

| 变量名 | 值 | 说明 |
|--------|-----|------|
| `DATABASE_URL` | `postgresql://postgres:424dvg74@test-db-postgresql.ns-ts7adfw9.svc:5432/postgres` | 数据库连接（内网） |
| `DIRECT_URL` | `postgresql://postgres:424dvg74@test-db-postgresql.ns-ts7adfw9.svc:5432/postgres` | Prisma 直连 |
| `PORT` | `3001` | 服务端口 |
| `NODE_ENV` | `production` | 生产环境 |
| `JWT_SECRET` | `emag_boss_very_rich_20260303` | JWT 密钥（生产建议更换） |
| `JWT_EXPIRES_IN` | `7d` | Token 有效期 |
| `CORS_ORIGIN` | `https://你的前端域名` | 前端地址，用于 CORS |
| `ALIBABA_APP_KEY` | `9058737` | 1688 配置（按需） |
| `ALIBABA_APP_SECRET` | `YXqsI0qv4fa` | 1688 配置（按需） |
| `ALIBABA_REDIRECT_URI` | `https://你的后端域名/api/alibaba/callback` | 1688 回调（按需） |

### 2.4 端口与网络

- **容器端口**：`3001`
- **协议**：TCP
- 如需外网访问，在 Sealos 中配置 **外网访问** 或 **Ingress**

### 2.5 命名空间

确保应用与数据库在同一集群。若数据库在 `ns-ts7adfw9`，应用可部署到同一命名空间，以便通过 `test-db-postgresql.ns-ts7adfw9.svc` 访问。

---

## 3. 内网数据库地址说明

`.env` 中的内网地址：

```
postgresql://postgres:424dvg74@test-db-postgresql.ns-ts7adfw9.svc:5432/postgres
```

- `test-db-postgresql`：数据库服务名
- `ns-ts7adfw9`：命名空间
- `.svc`：Kubernetes 集群内服务发现

应用与数据库在同一集群时，使用该地址即可稳定连接，无需外网。
