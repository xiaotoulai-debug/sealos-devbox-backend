import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: 'ts-node --compiler-options {"module":"CommonJS"} prisma/seed.ts',
  },
  datasource: {
    // Prisma 7 中 CLI（db push / migrate）使用此 URL
    // Supabase：必须用 DIRECT_URL 直连，绕过 pgBouncer 连接池
    // 应用运行时的 PrismaClient 初始化使用 DATABASE_URL（pooler）
    url: env("DIRECT_URL"),
  },
});
