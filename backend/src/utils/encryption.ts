import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 16;
const PBKDF2_ITERATIONS = 210000;
const DIGEST = "sha512";
const CURRENT_KEY_ID = process.env.E2EE_KEY_ID || "master-v1";
const AAD_PREFIX = "texa:e2ee:message";
const TOKEN_MIN_BYTES = 16;
const TOKEN_MAX_BYTES = 128;

export interface EncryptedMessagePayload {
  encrypted: string;
  iv: string;
  authTag: string;
  keyId: string;
  algorithm: string;
  aad: string;
  version: number;
}

export interface EncryptionEnvelope {
  content: string;
  encryption: EncryptedMessagePayload;
  hash: string;
}

type KeyEncoding = "hex" | "base64" | "base64url" | "utf8";

const toBase64Url = (value: Buffer): string => {
  return value.toString("base64url");
};

const fromBase64Flexible = (value: string): Buffer => {
  if (!value || typeof value !== "string") throw new Error("Invalid base64 value");

  const normalized = value.trim();

  if (!normalized) throw new Error("Invalid base64 value");

  if (/^[a-fA-F0-9]+$/.test(normalized) && normalized.length % 2 === 0 && normalized.length >= 32) {
    return Buffer.from(normalized, "hex");
  }

  if (normalized.includes("-") || normalized.includes("_")) {
    return Buffer.from(normalized, "base64url");
  }

  return Buffer.from(normalized, "base64");
};

const normalizeKeyId = (keyId?: string): string => {
  const value = String(keyId || CURRENT_KEY_ID || "master-v1").trim();
  if (!value || value.length > 80) throw new Error("Invalid key id");
  if (!/^[a-zA-Z0-9._:-]+$/.test(value)) throw new Error("Invalid key id");
  return value;
};

const envNameForKeyId = (keyId: string): string => {
  return `E2EE_MASTER_KEY_${keyId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
};

const detectKeyEncoding = (value: string): KeyEncoding => {
  const key = value.trim();

  if (/^[a-fA-F0-9]{64}$/.test(key)) return "hex";
  if (/^[A-Za-z0-9_-]{43,44}$/.test(key)) return "base64url";
  if (/^[A-Za-z0-9+/]{43,44}={0,2}$/.test(key)) return "base64";

  return "utf8";
};

const decodeMasterKey = (value: string): Buffer => {
  const raw = String(value || "").trim();

  if (!raw) throw new Error("Missing encryption key");

  const encoding = detectKeyEncoding(raw);

  if (encoding === "hex") return Buffer.from(raw, "hex");
  if (encoding === "base64url") return Buffer.from(raw, "base64url");
  if (encoding === "base64") return Buffer.from(raw, "base64");

  const hashed = crypto.createHash("sha256").update(raw, "utf8").digest();

  return hashed;
};

const getMasterKey = (keyId = CURRENT_KEY_ID): Buffer => {
  const normalizedKeyId = normalizeKeyId(keyId);

  const envKey =
    process.env[envNameForKeyId(normalizedKeyId)] ||
    process.env.E2EE_MASTER_KEY ||
    process.env.MESSAGE_ENCRYPTION_KEY ||
    process.env.APP_ENCRYPTION_KEY;

  if (!envKey) throw new Error("Missing encryption key");

  const key = decodeMasterKey(envKey);

  if (key.length !== KEY_LENGTH) throw new Error("Invalid encryption key length");

  return key;
};

const buildAadString = (userId: string, keyId = CURRENT_KEY_ID): string => {
  const safeUserId = String(userId || "").trim();
  const safeKeyId = normalizeKeyId(keyId);

  if (!safeUserId) throw new Error("Invalid user id");

  return `${AAD_PREFIX}:${safeKeyId}:${safeUserId}`;
};

const buildAad = (userId: string, keyId = CURRENT_KEY_ID): Buffer => {
  return Buffer.from(buildAadString(userId, keyId), "utf8");
};

const normalizePlaintext = (plaintext: string): string => {
  if (typeof plaintext !== "string") throw new Error("Invalid plaintext");
  return plaintext;
};

const normalizeUserId = (userId: string): string => {
  const value = String(userId || "").trim();
  if (!value) throw new Error("Invalid user id");
  return value;
};

const normalizeBytes = (bytes: number): number => {
  const value = Number(bytes);
  if (!Number.isFinite(value)) return 32;
  return Math.max(TOKEN_MIN_BYTES, Math.min(TOKEN_MAX_BYTES, Math.floor(value)));
};

const safeJsonStringify = <T>(payload: T): string => {
  try {
    return JSON.stringify(payload);
  } catch {
    throw new Error("Invalid JSON payload");
  }
};

const createCipherPayload = (plaintext: string, userId: string, keyId = CURRENT_KEY_ID): EncryptedMessagePayload => {
  const safePlaintext = normalizePlaintext(plaintext);
  const safeUserId = normalizeUserId(userId);
  const safeKeyId = normalizeKeyId(keyId);
  const key = getMasterKey(safeKeyId);
  const iv = crypto.randomBytes(IV_LENGTH);
  const aad = buildAad(safeUserId, safeKeyId);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  cipher.setAAD(aad);

  const encrypted = Buffer.concat([cipher.update(safePlaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    encrypted: toBase64Url(encrypted),
    iv: toBase64Url(iv),
    authTag: toBase64Url(authTag),
    keyId: safeKeyId,
    algorithm: ALGORITHM,
    aad: toBase64Url(aad),
    version: 1
  };
};

const decryptCipherPayload = (encryptedB64: string, encryption: Partial<EncryptedMessagePayload>, userId: string, strictAad = true): string => {
  if (!encryptedB64 || typeof encryptedB64 !== "string") throw new Error("Invalid encrypted content");
  if (!encryption || typeof encryption !== "object") throw new Error("Invalid encryption payload");

  const safeUserId = normalizeUserId(userId);
  const keyId = normalizeKeyId(encryption.keyId || CURRENT_KEY_ID);
  const algorithm = encryption.algorithm || ALGORITHM;

  if (algorithm !== ALGORITHM) throw new Error("Unsupported encryption algorithm");
  if (!encryption.iv || !encryption.authTag) throw new Error("Missing encryption metadata");

  const key = getMasterKey(keyId);
  const iv = fromBase64Flexible(encryption.iv);
  const authTag = fromBase64Flexible(encryption.authTag);
  const encrypted = fromBase64Flexible(encryptedB64);
  const expectedAad = buildAad(safeUserId, keyId);
  const aad = encryption.aad ? fromBase64Flexible(encryption.aad) : expectedAad;

  if (iv.length !== IV_LENGTH) throw new Error("Invalid IV length");
  if (authTag.length !== AUTH_TAG_LENGTH) throw new Error("Invalid auth tag length");

  if (strictAad && !bufferTimingSafeEqual(aad, expectedAad)) {
    throw new Error("Invalid encryption aad");
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  decipher.setAAD(aad);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

  return decrypted.toString("utf8");
};

const bufferTimingSafeEqual = (a: Buffer, b: Buffer): boolean => {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

export const generateSalt = (): Buffer => {
  return crypto.randomBytes(SALT_LENGTH);
};

export const generateKey = (password: string, salt: Buffer): Buffer => {
  if (!password || typeof password !== "string") throw new Error("Invalid password");
  if (!Buffer.isBuffer(salt) || salt.length < SALT_LENGTH) throw new Error("Invalid salt");
  return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, DIGEST);
};

export const generateKeyAsync = async (password: string, salt: Buffer): Promise<Buffer> => {
  if (!password || typeof password !== "string") throw new Error("Invalid password");
  if (!Buffer.isBuffer(salt) || salt.length < SALT_LENGTH) throw new Error("Invalid salt");

  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, DIGEST, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
};

export const hashMessage = (content: string): string => {
  return crypto.createHash("sha256").update(String(content || ""), "utf8").digest("hex");
};

export const hashBuffer = (content: Buffer): string => {
  if (!Buffer.isBuffer(content)) throw new Error("Invalid buffer");
  return crypto.createHash("sha256").update(content).digest("hex");
};

export const encryptMessage = async (plaintext: string, userId: string): Promise<EncryptedMessagePayload> => {
  return createCipherPayload(plaintext, userId, CURRENT_KEY_ID);
};

export const encryptMessageSync = (plaintext: string, userId: string): EncryptedMessagePayload => {
  return createCipherPayload(plaintext, userId, CURRENT_KEY_ID);
};

export const encryptMessageWithKeyId = async (plaintext: string, userId: string, keyId: string): Promise<EncryptedMessagePayload> => {
  return createCipherPayload(plaintext, userId, keyId);
};

export const decryptMessage = (encryptedB64: string, encryption: Partial<EncryptedMessagePayload>, userId: string): string => {
  try {
    return decryptCipherPayload(encryptedB64, encryption, userId, true);
  } catch {
    try {
      return decryptCipherPayload(encryptedB64, encryption, userId, false);
    } catch {
      return "[Decryption failed]";
    }
  }
};

export const decryptMessageStrict = (encryptedB64: string, encryption: Partial<EncryptedMessagePayload>, userId: string): string => {
  return decryptCipherPayload(encryptedB64, encryption, userId, true);
};

export const encryptJson = async <T>(payload: T, userId: string): Promise<EncryptedMessagePayload> => {
  return encryptMessage(safeJsonStringify(payload), userId);
};

export const encryptJsonSync = <T>(payload: T, userId: string): EncryptedMessagePayload => {
  return encryptMessageSync(safeJsonStringify(payload), userId);
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

export const decryptJsonStrict = <T>(encryptedB64: string, encryption: Partial<EncryptedMessagePayload>, userId: string): T => {
  const decrypted = decryptMessageStrict(encryptedB64, encryption, userId);
  return JSON.parse(decrypted) as T;
};

export const encryptEnvelope = async (plaintext: string, userId: string): Promise<EncryptionEnvelope> => {
  const encryption = await encryptMessage(plaintext, userId);

  return {
    content: encryption.encrypted,
    encryption,
    hash: hashMessage(plaintext)
  };
};

export const encryptEnvelopeSync = (plaintext: string, userId: string): EncryptionEnvelope => {
  const encryption = encryptMessageSync(plaintext, userId);

  return {
    content: encryption.encrypted,
    encryption,
    hash: hashMessage(plaintext)
  };
};

export const decryptEnvelope = (envelope: Partial<EncryptionEnvelope>, userId: string): string => {
  if (!envelope?.content || !envelope?.encryption) return "[Decryption failed]";
  return decryptMessage(envelope.content, envelope.encryption, userId);
};

export const isEncryptedPayload = (value: any): value is EncryptedMessagePayload => {
  return (
    !!value &&
    typeof value === "object" &&
    typeof value.encrypted === "string" &&
    typeof value.iv === "string" &&
    typeof value.authTag === "string" &&
    typeof value.keyId === "string" &&
    typeof value.algorithm === "string"
  );
};

export const timingSafeEqual = (a: string, b: string): boolean => {
  try {
    const first = Buffer.from(String(a || ""), "utf8");
    const second = Buffer.from(String(b || ""), "utf8");

    if (first.length !== second.length) return false;

    return crypto.timingSafeEqual(first, second);
  } catch {
    return false;
  }
};

export const createSecureToken = (bytes = 32): string => {
  return crypto.randomBytes(normalizeBytes(bytes)).toString("base64url");
};

export const createHexToken = (bytes = 32): string => {
  return crypto.randomBytes(normalizeBytes(bytes)).toString("hex");
};

export const createOtp = (digits = 6): string => {
  const length = Math.max(4, Math.min(10, Math.floor(Number(digits) || 6)));
  const min = 10 ** (length - 1);
  const max = 10 ** length - 1;
  return String(crypto.randomInt(min, max + 1));
};

export const createHmac = (payload: string, secret = process.env.HMAC_SECRET || process.env.E2EE_MASTER_KEY || ""): string => {
  if (!secret) throw new Error("Missing HMAC secret");
  return crypto.createHmac("sha256", secret).update(String(payload || ""), "utf8").digest("base64url");
};

export const verifyHmac = (payload: string, signature: string, secret = process.env.HMAC_SECRET || process.env.E2EE_MASTER_KEY || ""): boolean => {
  try {
    if (!signature || typeof signature !== "string") return false;
    return timingSafeEqual(createHmac(payload, secret), signature);
  } catch {
    return false;
  }
};

export const createSignedPayload = <T>(payload: T, secret = process.env.HMAC_SECRET || process.env.E2EE_MASTER_KEY || "") => {
  const body = toBase64Url(Buffer.from(safeJsonStringify(payload), "utf8"));
  const signature = createHmac(body, secret);

  return `${body}.${signature}`;
};

export const verifySignedPayload = <T>(token: string, secret = process.env.HMAC_SECRET || process.env.E2EE_MASTER_KEY || ""): T | null => {
  try {
    if (!token || typeof token !== "string") return null;

    const [body, signature] = token.split(".");

    if (!body || !signature) return null;
    if (!verifyHmac(body, signature, secret)) return null;

    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
};

export const generateMasterKey = (): string => {
  return crypto.randomBytes(KEY_LENGTH).toString("hex");
};

export const getCurrentKeyId = (): string => {
  return normalizeKeyId(CURRENT_KEY_ID);
};

export const getEncryptionAad = (userId: string, keyId = CURRENT_KEY_ID): string => {
  return toBase64Url(buildAad(userId, keyId));
};

export const verifyEncryptionHash = (plaintext: string, hash: string): boolean => {
  try {
    return timingSafeEqual(hashMessage(plaintext), hash);
  } catch {
    return false;
  }
};
