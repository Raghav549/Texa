import type { Express, Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors, { CorsOptions } from 'cors';
import compression from 'compression';
import hpp from 'hpp';
import mongoSanitize from 'express-mongo-sanitize';
import rateLimit, { ipKeyGenerator, type Options as RateLimitOptions } from 'express-rate-limit';
import jwt, { type JwtPayload, type SignOptions } from 'jsonwebtoken';
import { z, type ZodSchema } from 'zod';
import crypto from 'crypto';
import { prisma } from '../config/db';
import { UserRole } from '@prisma/client';

type AppRole = UserRole;

type AuthTokenPayload = JwtPayload & {
  userId: string;
  role?: AppRole;
  sessionId?: string;
  deviceId?: string;
  tokenVersion?: number;
};

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      role?: AppRole;
      sessionId?: string;
      deviceId?: string;
      requestId?: string;
      auth?: AuthTokenPayload;
      clientIp?: string;
    }
  }
}

const isProduction = process.env.NODE_ENV === 'production';

const parseOrigins = (value?: string) => {
  if (!value || value.trim() === '') return [];
  return value
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
};

const safeNumber = (value: unknown, fallback: number, min?: number, max?: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const finalValue = Math.floor(parsed);
  if (typeof min === 'number' && finalValue < min) return min;
  if (typeof max === 'number' && finalValue > max) return max;
  return finalValue;
};

const allowedOrigins = parseOrigins(process.env.CORS_ORIGIN || process.env.CLIENT_URL || process.env.FRONTEND_URL);

const corsOptions: CorsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (!isProduction && allowedOrigins.length === 0) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('CORS origin blocked'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Device-Id',
    'X-Session-Id',
    'X-Request-Id',
    'X-Client-Version',
    'X-Platform',
    'X-Timezone',
    'X-Forwarded-For',
    'X-Real-IP',
    'CF-Connecting-IP'
  ],
  exposedHeaders: [
    'X-Request-Id',
    'X-Refresh-Token',
    'RateLimit-Limit',
    'RateLimit-Remaining',
    'RateLimit-Reset',
    'X-RateLimit-Limit',
    'X-RateLimit-Remaining',
    'X-RateLimit-Reset'
  ],
  maxAge: 86400,
  optionsSuccessStatus: 204
};

const helmetConfig = helmet({
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  dnsPrefetchControl: { allow: false },
  frameguard: { action: 'deny' },
  hidePoweredBy: true,
  hsts: isProduction
    ? {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
      }
    : false,
  noSniff: true,
  originAgentCluster: true,
  permittedCrossDomainPolicies: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  xssFilter: true,
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      scriptSrc: isProduction ? ["'self'"] : ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https:'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      mediaSrc: ["'self'", 'data:', 'blob:', 'https:'],
      fontSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'https:', 'wss:', 'ws:'],
      workerSrc: ["'self'", 'blob:'],
      manifestSrc: ["'self'"],
      upgradeInsecureRequests: isProduction ? [] : null
    }
  }
});

const requestIdMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const incomingId = req.headers['x-request-id'];
  const requestId = typeof incomingId === 'string' && incomingId.trim().length > 0 ? incomingId.trim().slice(0, 128) : crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
};

const normalizeIp = (req: Request) => {
  const cfIp = req.headers['cf-connecting-ip'];
  if (typeof cfIp === 'string' && cfIp.trim()) return cfIp.trim();

  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) return realIp.trim();

  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  if (Array.isArray(forwarded) && forwarded[0]) return forwarded[0].split(',')[0].trim();

  return req.ip || req.socket.remoteAddress || 'unknown';
};

const sanitizeDeep = (value: any, depth = 0): any => {
  if (depth > 20) return undefined;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.replace(/\0/g, '').trim();
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value;
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return value.map(item => sanitizeDeep(item, depth + 1)).filter(item => item !== undefined);

  if (typeof value === 'object') {
    const clean: Record<string, any> = {};

    for (const [key, val] of Object.entries(value)) {
      if (
        key === '__proto__' ||
        key === 'constructor' ||
        key === 'prototype' ||
        key.startsWith('$') ||
        key.includes('.')
      ) {
        continue;
      }

      const sanitized = sanitizeDeep(val, depth + 1);
      if (sanitized !== undefined) clean[key] = sanitized;
    }

    return clean;
  }

  return undefined;
};

const requestSanitizer = (req: Request, _res: Response, next: NextFunction) => {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) req.body = sanitizeDeep(req.body);
  if (req.query && typeof req.query === 'object') req.query = sanitizeDeep(req.query);
  if (req.params && typeof req.params === 'object') req.params = sanitizeDeep(req.params);

  const ip = normalizeIp(req);
  req.clientIp = ip;

  next();
};

const rateKeyGenerator = (req: Request): string => {
  const userId = req.userId || req.auth?.userId;
  const deviceId = req.headers['x-device-id'];
  const ip = normalizeIp(req);
  const safeIp = ipKeyGenerator(ip);
  const safeDevice = typeof deviceId === 'string' && deviceId.trim() ? deviceId.trim().slice(0, 128) : 'no-device';
  return userId ? `user:${userId}:device:${safeDevice}` : `guest:${safeIp}:device:${safeDevice}`;
};

const createLimiter = (options: Partial<RateLimitOptions>) =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: false,
    keyGenerator: rateKeyGenerator,
    handler: (req: Request, res: Response, _next: NextFunction, limiterOptions: RateLimitOptions) => {
      const message = typeof limiterOptions.message === 'string' ? limiterOptions.message : 'Too many requests. Please try again later.';

      res.status(limiterOptions.statusCode || 429).json({
        success: false,
        error: message,
        message,
        requestId: req.requestId,
        retryAfter: res.getHeader('Retry-After') || null
      });
    },
    ...options
  });

export const apiLimiter = createLimiter({
  windowMs: safeNumber(process.env.API_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000, 1000),
  max: safeNumber(process.env.API_RATE_LIMIT || process.env.API_LIMIT_MAX, 300, 1),
  message: 'Too many requests. Please try again later.'
});

export const strictLimiter = createLimiter({
  windowMs: safeNumber(process.env.STRICT_RATE_LIMIT_WINDOW_MS, 60 * 1000, 1000),
  max: safeNumber(process.env.STRICT_RATE_LIMIT || process.env.STRICT_LIMIT_MAX, 20, 1),
  message: 'Rate limit exceeded. Slow down.'
});

export const authLimiter = createLimiter({
  windowMs: safeNumber(process.env.AUTH_RATE_LIMIT_WINDOW_MS, 10 * 60 * 1000, 1000),
  max: safeNumber(process.env.AUTH_RATE_LIMIT || process.env.AUTH_LIMIT_MAX, 30, 1),
  skipSuccessfulRequests: true,
  message: 'Too many authentication attempts. Please try again later.'
});

export const uploadLimiter = createLimiter({
  windowMs: safeNumber(process.env.UPLOAD_RATE_LIMIT_WINDOW_MS, 10 * 60 * 1000, 1000),
  max: safeNumber(process.env.UPLOAD_RATE_LIMIT || process.env.UPLOAD_LIMIT_MAX, 20, 1),
  message: 'Upload limit reached. Try again later.'
});

export const adminLimiter = createLimiter({
  windowMs: safeNumber(process.env.ADMIN_RATE_LIMIT_WINDOW_MS, 60 * 1000, 1000),
  max: safeNumber(process.env.ADMIN_RATE_LIMIT || process.env.ADMIN_LIMIT_MAX, 80, 1),
  message: 'Admin rate limit exceeded.'
});

export const searchLimiter = createLimiter({
  windowMs: safeNumber(process.env.SEARCH_RATE_LIMIT_WINDOW_MS, 60 * 1000, 1000),
  max: safeNumber(process.env.SEARCH_RATE_LIMIT || process.env.SEARCH_LIMIT_MAX, 100, 1),
  message: 'Search limit reached. Please try again later.'
});

export const dmLimiter = createLimiter({
  windowMs: safeNumber(process.env.DM_RATE_LIMIT_WINDOW_MS, 60 * 1000, 1000),
  max: safeNumber(process.env.DM_RATE_LIMIT || process.env.DM_LIMIT_MAX, 60, 1),
  message: 'Message limit reached. Please slow down.'
});

export const commerceLimiter = createLimiter({
  windowMs: safeNumber(process.env.COMMERCE_RATE_LIMIT_WINDOW_MS, 60 * 1000, 1000),
  max: safeNumber(process.env.COMMERCE_RATE_LIMIT || process.env.COMMERCE_LIMIT_MAX, 120, 1),
  message: 'Too many commerce requests. Please slow down.'
});

export const storyUploadLimiter = createLimiter({
  windowMs: safeNumber(process.env.STORY_UPLOAD_RATE_LIMIT_WINDOW_MS, 5 * 60 * 1000, 1000),
  max: safeNumber(process.env.STORY_UPLOAD_RATE_LIMIT || process.env.STORY_UPLOAD_LIMIT_MAX, 15, 1),
  message: 'Story upload limit reached. Try again later.'
});

export const reelUploadLimiter = createLimiter({
  windowMs: safeNumber(process.env.REEL_UPLOAD_RATE_LIMIT_WINDOW_MS, 10 * 60 * 1000, 1000),
  max: safeNumber(process.env.REEL_UPLOAD_RATE_LIMIT || process.env.REEL_UPLOAD_LIMIT_MAX, 8, 1),
  message: 'Reel upload limit reached. Try again later.'
});

export function applySecurity(app: Express) {
  app.disable('x-powered-by');
  app.set('trust proxy', safeNumber(process.env.TRUST_PROXY, 1, 0));
  app.use(requestIdMiddleware);
  app.use(helmetConfig);
  app.use(cors(corsOptions));
  app.options('*', cors(corsOptions));
  app.use(compression({ threshold: 1024 }));
  app.use(hpp());
  app.use(mongoSanitize({ replaceWith: '_' }));
  app.use(requestSanitizer);
  app.use(apiLimiter);
}

type ValidateTarget = 'body' | 'query' | 'params';

export const validate =
  (schema: ZodSchema, target: ValidateTarget = 'body') =>
  (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[target]);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: result.error.flatten(),
        requestId: req.requestId
      });
    }

    req[target] = result.data as any;
    next();
  };

export const validateRequest =
  (schemas: Partial<Record<ValidateTarget, ZodSchema>>) =>
  (req: Request, res: Response, next: NextFunction) => {
    const output: Partial<Record<ValidateTarget, any>> = {};
    const errors: Partial<Record<ValidateTarget, any>> = {};

    for (const target of Object.keys(schemas) as ValidateTarget[]) {
      const schema = schemas[target];
      if (!schema) continue;

      const result = schema.safeParse(req[target]);

      if (!result.success) {
        errors[target] = result.error.flatten();
      } else {
        output[target] = result.data;
      }
    }

    if (Object.keys(errors).length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: errors,
        requestId: req.requestId
      });
    }

    if (output.body !== undefined) req.body = output.body;
    if (output.query !== undefined) req.query = output.query;
    if (output.params !== undefined) req.params = output.params;

    next();
  };

const getBearerToken = (req: Request) => {
  const header = req.headers.authorization;
  if (!header || typeof header !== 'string') return null;

  const [scheme, token] = header.split(' ');
  if (!/^Bearer$/i.test(scheme) || !token) return null;

  return token.trim();
};

const getJwtOptions = () => {
  const issuer = process.env.JWT_ISSUER;
  const audience = process.env.JWT_AUDIENCE;
  const options: jwt.VerifyOptions & SignOptions = {};

  if (issuer) options.issuer = issuer;
  if (audience) options.audience = audience;

  return options;
};

const signAccessToken = (payload: AuthTokenPayload) => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is missing');

  const options: SignOptions = {
    ...getJwtOptions(),
    expiresIn: process.env.JWT_EXPIRES_IN || '24h'
  };

  return jwt.sign(
    {
      userId: payload.userId,
      role: payload.role,
      sessionId: payload.sessionId,
      deviceId: payload.deviceId,
      tokenVersion: payload.tokenVersion
    },
    secret,
    options
  );
};

const attachUserFromToken = async (req: Request, decoded: AuthTokenPayload) => {
  const user = await prisma.user.findUnique({
    where: {
      id: decoded.userId
    },
    select: {
      id: true,
      role: true,
      tokenVersion: true,
      isBanned: true,
      isSuspended: true
    } as any
  });

  if (!user) {
    return {
      ok: false,
      status: 401,
      error: 'User no longer exists'
    };
  }

  if ((user as any).isBanned || (user as any).isSuspended) {
    return {
      ok: false,
      status: 403,
      error: 'Account restricted'
    };
  }

  const currentTokenVersion = Number((user as any).tokenVersion || 0);
  const tokenVersion = Number(decoded.tokenVersion || 0);

  if (currentTokenVersion && tokenVersion !== currentTokenVersion) {
    return {
      ok: false,
      status: 401,
      error: 'Session expired'
    };
  }

  req.auth = decoded;
  req.userId = user.id;
  req.role = user.role as AppRole;
  req.sessionId = decoded.sessionId;
  req.deviceId = typeof req.headers['x-device-id'] === 'string' ? req.headers['x-device-id'] : decoded.deviceId;

  return {
    ok: true,
    status: 200,
    error: null
  };
};

export const jwtAuth = async (req: Request, res: Response, next: NextFunction) => {
  const token = getBearerToken(req);

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      message: 'Authentication token missing',
      requestId: req.requestId
    });
  }

  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET is missing');

    const decoded = jwt.verify(token, secret, getJwtOptions()) as AuthTokenPayload;

    if (!decoded.userId || typeof decoded.userId !== 'string') {
      return res.status(403).json({
        success: false,
        error: 'Invalid token payload',
        requestId: req.requestId
      });
    }

    const attached = await attachUserFromToken(req, decoded);

    if (!attached.ok) {
      return res.status(attached.status).json({
        success: false,
        error: attached.error,
        requestId: req.requestId
      });
    }

    const issuedAt = typeof decoded.iat === 'number' ? decoded.iat * 1000 : 0;
    const rotateAfter = safeNumber(process.env.JWT_ROTATE_AFTER_MS, 12 * 60 * 60 * 1000, 60 * 1000);
    const shouldRotate = issuedAt > 0 && Date.now() - issuedAt > rotateAfter;

    if (shouldRotate) {
      const newToken = signAccessToken({
        ...decoded,
        role: req.role,
        deviceId: req.deviceId,
        sessionId: req.sessionId
      });
      res.setHeader('X-Refresh-Token', newToken);
    }

    next();
  } catch (error) {
    const expired = error instanceof jwt.TokenExpiredError;

    return res.status(401).json({
      success: false,
      error: expired ? 'Token expired' : 'Invalid authentication token',
      message: expired ? 'Token expired' : 'Invalid authentication token',
      requestId: req.requestId
    });
  }
};

export const auth = jwtAuth;

export const optionalJwtAuth = async (req: Request, _res: Response, next: NextFunction) => {
  const token = getBearerToken(req);
  if (!token) return next();

  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) return next();

    const decoded = jwt.verify(token, secret, getJwtOptions()) as AuthTokenPayload;

    if (decoded.userId) {
      await attachUserFromToken(req, decoded);
    }
  } catch {}

  next();
};

export const requireRole =
  (...roles: AppRole[]) =>
  (req: Request, res: Response, next: NextFunction) => {
    if (!req.role || !roles.includes(req.role)) {
      return res.status(403).json({
        success: false,
        error: 'Access denied',
        message: 'Access denied',
        requestId: req.requestId
      });
    }

    next();
  };

export const adminOnly = requireRole(UserRole.ADMIN, UserRole.SUPERADMIN);

export const superAdminOnly = requireRole(UserRole.SUPERADMIN);

export const businessOnly = requireRole(UserRole.BUSINESS, UserRole.ADMIN, UserRole.SUPERADMIN);

export const creatorOnly = requireRole(UserRole.CREATOR, UserRole.BUSINESS, UserRole.ADMIN, UserRole.SUPERADMIN);

export const authorize = (...roles: AppRole[]) => requireRole(...roles);

export const securityErrorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(err);

  const message = typeof err?.message === 'string' ? err.message : 'Security error';

  if (message.toLowerCase().includes('cors')) {
    return res.status(403).json({
      success: false,
      error: 'Origin not allowed',
      message: 'Origin not allowed',
      requestId: req.requestId
    });
  }

  if (message.toLowerCase().includes('too many')) {
    return res.status(429).json({
      success: false,
      error: message,
      message,
      requestId: req.requestId
    });
  }

  return next(err);
};

export const asyncHandler =
  <T extends Request = Request, U extends Response = Response>(fn: (req: T, res: U, next: NextFunction) => Promise<any>) =>
  (req: T, res: U, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

export const zObjectId = z.string().trim().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/);

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(120).optional(),
  cursor: z.string().trim().max(256).optional()
});

export const idParamSchema = z.object({
  id: zObjectId
});
