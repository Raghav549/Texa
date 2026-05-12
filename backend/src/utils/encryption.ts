import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const PBKDF2_ITERATIONS = 210000;
const DIGEST = "sha512";
const CURRENT_KEY_ID = process.env.E2EE_KEY_ID || "master-v1";
const AAD_PREFIX = "texa:e2ee:message";

export interface EncryptedMessagePayload {
  encrypted: string;
  iv: string;
  authTag: string;
  keyId: string;
  algorithm: string;
  aad: string;
  version: number;
}

const toBase64Url = (value: Buffer): string => {
  return value.toString("base64url");
};

const fromBase64Flexible = (value: string): Buffer => {
  if (!value || typeof value !== "string") throw new Error("Invalid base64 value");
  return Buffer.from(value, value.includes("-") || value.includes("_") ? "base64url" : "base64");
};

const getMasterKey = (keyId = CURRENT_KEY_ID): Buffer => {
  const envKey =
    process.env[`E2EE_MASTER_KEY_${keyId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`] ||
    process.env.E2EE_MASTER_KEY;

  if (!envKey) throw new Error("Missing encryption key");

  const key = Buffer.from(envKey, "hex");

  if (key.length !== KEY_LENGTH) throw new Error("Invalid encryption key length");

  return key;
};

const buildAad = (userId: string, keyId = CURRENT_KEY_ID): Buffer => {
  return Buffer.from(`${AAD_PREFIX}:${keyId}:${userId}`, "utf8");
};

export const generateSalt = (): Buffer => {
  return crypto.randomBytes(16);
};

export const generateKey = (password: string, salt: Buffer): Buffer => {
  if (!password || typeof password !== "string") throw new Error("Invalid password");
  if (!Buffer.isBuffer(salt) || salt.length < 16) throw new Error("Invalid salt");
  return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, DIGEST);
};

export const generateKeyAsync = async (password: string, salt: Buffer): Promise<Buffer> => {
  if (!password || typeof password !== "string") throw new Error("Invalid password");
  if (!Buffer.isBuffer(salt) || salt.length < 16) throw new Error("Invalid salt");

  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, DIGEST, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
};

export const hashMessage = (content: string): string => {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
};

export const encryptMessage = async (plaintext: string, userId: string): Promise<EncryptedMessagePayload> => {
  if (typeof plaintext !== "string") throw new Error("Invalid plaintext");
  if (!userId || typeof userId !== "string") throw new Error("Invalid user id");

  const keyId = CURRENT_KEY_ID;
  const key = getMasterKey(keyId);
  const iv = crypto.randomBytes(IV_LENGTH);
  const aad = buildAad(userId, keyId);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  cipher.setAAD(aad);

  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    encrypted: toBase64Url(encrypted),
    iv: toBase64Url(iv),
    authTag: toBase64Url(authTag),
    keyId,
    algorithm: ALGORITHM,
    aad: toBase64Url(aad),
    version: 1
  };
};

export const decryptMessage = (encryptedB64: string, encryption: Partial<EncryptedMessagePayload>, userId: string): string => {
  try {
    if (!encryptedB64 || typeof encryptedB64 !== "string") throw new Error("Invalid encrypted content");
    if (!encryption || typeof encryption !== "object") throw new Error("Invalid encryption payload");
    if (!userId || typeof userId !== "string") throw new Error("Invalid user id");

    const keyId = encryption.keyId || CURRENT_KEY_ID;
    const algorithm = encryption.algorithm || ALGORITHM;

    if (algorithm !== ALGORITHM) throw new Error("Unsupported encryption algorithm");
    if (!encryption.iv || !encryption.authTag) throw new Error("Missing encryption metadata");

    const key = getMasterKey(keyId);
    const iv = fromBase64Flexible(encryption.iv);
    const authTag = fromBase64Flexible(encryption.authTag);
    const encrypted = fromBase64Flexible(encryptedB64);
    const aad = encryption.aad ? fromBase64Flexible(encryption.aad) : buildAad(userId, keyId);

    if (iv.length !== IV_LENGTH) throw new Error("Invalid IV length");
    if (authTag.length !== AUTH_TAG_LENGTH) throw new Error("Invalid auth tag length");

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

    return decrypted.toString("utf8");
  } catch {
    return "[Decryption failed]";
  }
};

export const encryptJson = async <T>(payload: T, userId: string): Promise<EncryptedMessagePayload> => {
  return encryptMessage(JSON.stringify(payload), userId);
};

export const decryptJson = <T>(encryptedB64: string, encryption: Partial<EncryptedMessagePayload>, userId: string): T | null => {
  try {
    const decrypted = decryptMessage(encryptedB64, encryption, userId);
    if (decrypted === "[Decryption failed]") return null;
    return JSON.parse(decrypted) as T;
  } catch {
    return null;
  }
};

export const timingSafeEqual = (a: string, b: string): boolean => {
  const first = Buffer.from(a);
  const second = Buffer.from(b);

  if (first.length !== second.length) return false;

  return crypto.timingSafeEqual(first, second);
};

export const createSecureToken = (bytes = 32): string => {
  return crypto.randomBytes(bytes).toString("base64url");
};

export const createHmac = (payload: string, secret = process.env.HMAC_SECRET || process.env.E2EE_MASTER_KEY || ""): string => {
  if (!secret) throw new Error("Missing HMAC secret");
  return crypto.createHmac("sha256", secret).update(payload, "utf8").digest("base64url");
};

export const verifyHmac = (payload: string, signature: string, secret = process.env.HMAC_SECRET || process.env.E2EE_MASTER_KEY || ""): boolean => {
  try {
    return timingSafeEqual(createHmac(payload, secret), signature);
  } catch {
    return false;
  }
};
