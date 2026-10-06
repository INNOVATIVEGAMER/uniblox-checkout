import type { Hook } from '@hono/zod-validator';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import type { Env, ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';

export const ERRORS = {
  VALIDATION_ERROR: { status: 400, final: false, message: 'The request is invalid' },
  NOT_FOUND: { status: 404, final: false, message: 'No route matches this method and path' },
  PRODUCT_NOT_FOUND: { status: 404, final: false, message: 'Product not found' },
  INTERNAL: { status: 500, final: false, message: 'Something went wrong' },
  LOCK_TIMEOUT: { status: 503, final: false, message: 'The resource is busy, retry shortly' },
} as const satisfies Record<string, { status: ContentfulStatusCode; final: boolean; message: string }>;

export type ErrorCode = keyof typeof ERRORS;

export class AppError extends Error {
  readonly status: ContentfulStatusCode;
  readonly final: boolean;

  constructor(
    readonly code: ErrorCode,
    readonly details?: unknown,
  ) {
    super(ERRORS[code].message);
    this.status = ERRORS[code].status;
    this.final = ERRORS[code].final;
  }
}

type ErrorBody = { error: { code: ErrorCode; message: string; details?: unknown } };

export function toErrorBody(err: AppError): ErrorBody {
  const body: ErrorBody = { error: { code: err.code, message: err.message } };
  if (err.details !== undefined) body.error.details = err.details;
  return body;
}

// Hono's json target silently reads a non-JSON body as {}, so the hook rejects the Content-Type itself.
// Same pattern Hono uses to decide whether to parse.
const JSON_CONTENT_TYPE = /^application\/([a-z-.]+\+)?json(;\s*[a-zA-Z0-9-]+=([^;]+))*$/i;

export const validationHook: Hook<unknown, Env, string> = (result, c) => {
  if (result.target === 'json' && !JSON_CONTENT_TYPE.test(c.req.header('content-type') ?? '')) {
    throw new AppError('VALIDATION_ERROR', [
      { path: 'header.content-type', message: 'Content-Type must be application/json' },
    ]);
  }
  if (result.success) return;
  throw new AppError(
    'VALIDATION_ERROR',
    result.error.issues.map((issue) => ({
      path: [result.target, ...issue.path].map(String).join('.'),
      message: issue.message,
    })),
  );
};

const pgErrorSchema = z.object({ code: z.string(), constraint: z.string().optional() });

function toAppError(err: Error): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof HTTPException) {
    return new AppError('VALIDATION_ERROR', [{ path: 'json', message: err.message }]);
  }
  if (err instanceof DrizzleQueryError) {
    const pg = pgErrorSchema.safeParse(err.cause);
    if (pg.data?.code === '55P03') return new AppError('LOCK_TIMEOUT');
    console.error('database error', { code: pg.data?.code, constraint: pg.data?.constraint, cause: err.cause });
    return new AppError('INTERNAL');
  }
  console.error('unhandled error', err);
  return new AppError('INTERNAL');
}

export const onError: ErrorHandler = (err, c) => {
  const appError = toAppError(err);
  return c.json(toErrorBody(appError), appError.status);
};

export const notFound: NotFoundHandler = (c) => c.json(toErrorBody(new AppError('NOT_FOUND')), 404);
