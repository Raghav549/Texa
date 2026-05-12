import type { Express, Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors, { CorsOptions } from 'cors';
import compression from 'compression';
import hpp from 'hpp';
import mongoSanitize from 'express-mongo-sanitize';
import { rateLimit, type Options as RateLimitOptions } from 'express-rate-limit';
import jwt, { type JwtPayload, type SignOptions } from 'jsonwebtoken';
import { z, type ZodSchema } from 'zod';
import crypto from 'crypto';

type AppRole = 'user' | 'creator' | 'business' | 'admin' | 'super_admin';

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

const allowedOrigins = parseOrigins(process.env.CORS_ORIGIN || process.env.CLIENT_URL);

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
    'X-Forwarded-For'
  ],
  exposedHeaders: [
    'X-Request-Id',
    'X-Refresh-Token',
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
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
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
  const requestId = typeof incomingId === 'string' && incomingId.trim().length > 0 ? incomingId.trim() : crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
};

const normalizeIp = (req: Request) => {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  if (Array.isArray(forwarded) && forwarded[0]) return forwarded[0].split(',')[0].trim();
  return req.socket.remoteAddress || req.ip || 'unknown';
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
  if (req.body && typeof req.body === 'object') req.body = sanitizeDeep(req.body);
  if (req.query && typeof req.query === 'object') req.query = sanitizeDeep(req.query);
  if (req.params && typeof req.params === 'object') req.params = sanitizeDeep(req.params);
  const ip = normalizeIp(req);
  Object.defineProperty(req, 'clientIp', { value: ip, enumerable: false, configurable: true });
  next();
};

const createLimiter = (options: Partial<RateLimitOptions>) =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: false,
    keyGenerator: req => {
      const userId = (req as Request).userId;
      const deviceId = req.headers['x-device-id'];
      const ip = normalizeIp(req as Request);
      return `${userId || 'guest'}:${typeof deviceId === 'string' ? deviceId : 'no-device'}:${ip}`;
    },
    handler: (req: Request, res: Response) => {
      res.status(429).json({
        success: false,
        error: 'Too many requests. Please try again later.',
        requestId: req.requestId
      });
    },
    ...options
  });

export const apiLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.API_RATE_LIMIT || 300)
});

export const strictLimiter = createLimiter({
  windowMs: 60 * 1000,
  limit: Number(process.env.STRICT_RATE_LIMIT || 20)
});

export const authLimiter = createLimiter({
  windowMs: 10 * 60 * 1000,
  limit: Number(process.env.AUTH_RATE_LIMIT || 30),
  skipSuccessfulRequests: true
});

export const uploadLimiter = createLimiter({
  windowMs: 10 * 60 * 1000,
  limit: Number(process.env.UPLOAD_RATE_LIMIT || 20)
});

export function applySecurity(app: Express) {
  app.disable('x-powered-by');
  app.set('trust proxy', Number(process.env.TRUST_PROXY || 1));
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
      if (!result.success) errors[target] = result.error.flatten();
      else output[target] = result.data;
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

const signAccessToken = (payload: AuthTokenPayload) => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is missing');

  const options: SignOptions = {
    expiresIn: process.env.JWT_EXPIRES_IN || '24h',
    issuer: process.env.JWT_ISSUER || 'texa-api',
    audience: process.env.JWT_AUDIENCE || 'texa-client'
  };

  return jwt.sign(
    {
      userId: payload.userId,
      role: payload.role || 'user',
      sessionId: payload.sessionId,
      deviceId: payload.deviceId,
      tokenVersion: payload.tokenVersion
    },
    secret,
    options
  );
};

export const jwtAuth = (req: Request, res: Response, next: NextFunction) => {
  const token = getBearerToken(req);

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
      requestId: req.requestId
    });
  }

  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET is missing');

    const decoded = jwt.verify(token, secret, {
      issuer: process.env.JWT_ISSUER || 'texa-api',
      audience: process.env.JWT_AUDIENCE || 'texa-client'
    }) as AuthTokenPayload;

    if (!decoded.userId || typeof decoded.userId !== 'string') {
      return res.status(403).json({
        success: false,
        error: 'Invalid token payload',
        requestId: req.requestId
      });
    }

    const issuedAt = typeof decoded.iat === 'number' ? decoded.iat * 1000 : 0;
    const shouldRotate = issuedAt > 0 && Date.now() - issuedAt > Number(process.env.JWT_ROTATE_AFTER_MS || 12 * 60 * 60 * 1000);

    if (shouldRotate) {
      const newToken = signAccessToken(decoded);
      res.setHeader('X-Refresh-Token', newToken);
    }

    req.auth = decoded;
    req.userId = decoded.userId;
    req.role = decoded.role || 'user';
    req.sessionId = decoded.sessionId;
    req.deviceId = typeof req.headers['x-device-id'] === 'string' ? req.headers['x-device-id'] : decoded.deviceId;

    next();
  } catch {
    return res.status(403).json({
      success: false,
      error: 'Invalid or expired token',
      requestId: req.requestId
    });
  }
};

export const optionalJwtAuth = (req: Request, _res: Response, next: NextFunction) => {
  const token = getBearerToken(req);
  if (!token) return next();

  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) return next();

    const decoded = jwt.verify(token, secret, {
      issuer: process.env.JWT_ISSUER || 'texa-api',
      audience: process.env.JWT_AUDIENCE || 'texa-client'
    }) as AuthTokenPayload;

    if (decoded.userId) {
      req.auth = decoded;
      req.userId = decoded.userId;
      req.role = decoded.role || 'user';
      req.sessionId = decoded.sessionId;
      req.deviceId = typeof req.headers['x-device-id'] === 'string' ? req.headers['x-device-id'] : decoded.deviceId;
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
        requestId: req.requestId
      });
    }
    next();
  };

export const adminOnly = requireRole('admin', 'super_admin');

export const businessOnly = requireRole('business', 'admin', 'super_admin');

export const creatorOnly = requireRole('creator', 'business', 'admin', 'super_admin');

export const securityErrorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(err);

  const message = typeof err?.message === 'string' ? err.message : 'Security error';

  if (message.includes('CORS')) {
    return res.status(403).json({
      success: false,
      error: 'Origin not allowed',
      requestId: req.requestId
    });
  }

  return next(err);
};

export const zObjectId = z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/);

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(120).optional()
});
