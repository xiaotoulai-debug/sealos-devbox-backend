/**
 * 独立运维脚本：按用户名重置登录密码（需配置 DATABASE_URL）。
 * 用法：cd backend && npx tsx scripts/reset-admin-password.ts <username> <newPassword>
 * 禁止在 src/index.ts 或任何业务入口中 import 本文件。
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const username = process.argv[2] ?? 'admin';
  const plain = process.argv[3] ?? '123456';
  if (!username.trim() || !plain) {
    console.error('用法: npx tsx scripts/reset-admin-password.ts <username> <newPassword>');
    process.exit(1);
  }
  const passwordHash = await bcrypt.hash(plain, 10);
  await prisma.user.update({
    where: { username },
    data: { passwordHash },
  });
  console.log(`[reset-admin-password] 已更新用户「${username}」的密码哈希`);
}

main()
  .catch((e) => {
    console.error('[reset-admin-password]', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
