# EMAG 跨境电商管理系统 - 后端 Docker 镜像
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY prisma ./prisma/
# 生成 Prisma Client，构建阶段与运行时均需
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src/
RUN npm run build

# --- 生产阶段 ---
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY prisma ./prisma/
RUN npx prisma generate

COPY --from=builder /app/dist ./dist

EXPOSE 3001

CMD ["node", "dist/index.js"]
