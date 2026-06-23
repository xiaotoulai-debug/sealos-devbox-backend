import crypto from 'crypto';

const ENCRYPT_KEY = (process.env.SHOP_ENCRYPT_KEY ?? 'emag-cross-border-default-key-32').padEnd(32, '0').slice(0, 32);

export function encrypt(text: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPT_KEY, 'utf8'), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

export function decrypt(data: string): string {
  try {
    const [ivHex, encrypted] = data.split(':');
    if (!ivHex || !encrypted) return data;
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPT_KEY, 'utf8'), Buffer.from(ivHex, 'hex'));
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return data;
  }
}

export function maskSecret(val: string): string {
  if (val.length <= 8) return '****';
  return val.slice(0, 4) + '****' + val.slice(-4);
}
