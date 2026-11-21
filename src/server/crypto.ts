import crypto from 'node:crypto';

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hexHash] = parts;
  const derived = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hexHash, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

export interface DeviceKeyPair {
  publicKey: string;
  privateKey: string;
}

export function generateDeviceKeyPair(): DeviceKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKey, privateKey };
}

export function canonicalEventString(eventData: {
  event_id: string;
  lamport_clock: number;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: string;
  device_id: string;
  user_id: string;
  created_at: string;
}): string {
  return JSON.stringify({
    event_id: eventData.event_id,
    lamport_clock: eventData.lamport_clock,
    event_type: eventData.event_type,
    aggregate_type: eventData.aggregate_type,
    aggregate_id: eventData.aggregate_id,
    payload: eventData.payload,
    device_id: eventData.device_id,
    user_id: eventData.user_id,
    created_at: eventData.created_at,
  });
}

export function signEventData(
  eventData: Parameters<typeof canonicalEventString>[0],
  privateKeyPem: string
): string {
  const msg = Buffer.from(canonicalEventString(eventData), 'utf8');
  return crypto.sign(null, msg, privateKeyPem).toString('base64');
}

export function verifyEventSignature(
  eventData: Parameters<typeof canonicalEventString>[0],
  signatureBase64: string,
  publicKeyPem: string
): boolean {
  try {
    const msg = Buffer.from(canonicalEventString(eventData), 'utf8');
    const sig = Buffer.from(signatureBase64, 'base64');
    return crypto.verify(null, msg, publicKeyPem, sig);
  } catch {
    return false;
  }
}

export function sha256Hex(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export interface EncryptedBackupEnvelope {
  version: string;
  algorithm: 'aes-256-gcm';
  iv: string;
  authTag: string;
  ciphertext: string;
  checksum_sha256: string;
}

const DEFAULT_BACKUP_SECRET = process.env.BEDCARE_BACKUP_KEY || 'BEDCARE-LOCAL-FIRST-MASTER-BACKUP-KEY-2026';

export function encryptBackupPayload(
  plaintextJson: string,
  secret: string = DEFAULT_BACKUP_SECRET
): EncryptedBackupEnvelope {
  const key = crypto.createHash('sha256').update(secret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintextJson, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const checksum = sha256Hex(plaintextJson);
  return {
    version: '1.0',
    algorithm: 'aes-256-gcm',
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    ciphertext: encrypted.toString('base64'),
    checksum_sha256: checksum,
  };
}

export function decryptBackupPayload(
  envelope: EncryptedBackupEnvelope,
  secret: string = DEFAULT_BACKUP_SECRET
): string {
  const key = crypto.createHash('sha256').update(secret).digest();
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(envelope.iv, 'hex')
  );
  decipher.setAuthTag(Buffer.from(envelope.authTag, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  const actualChecksum = sha256Hex(decrypted);
  if (actualChecksum !== envelope.checksum_sha256) {
    throw new Error('CHECKSUM_MISMATCH: Bản sao lưu bị hỏng hoặc đã bị chỉnh sửa.');
  }
  return decrypted;
}
