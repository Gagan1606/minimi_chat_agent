import { z } from "zod";

export const ApiErrorCodeSchema = z.enum([
  "INVALID_REQUEST",
  "VALIDATION_FAILED",
  "UNAUTHENTICATED",
  "AUTHENTICATION_FAILED",
  "INVALID_AUTH_TRANSACTION",
  "MFA_REQUIRED",
  "CSRF_FAILED",
  "FORBIDDEN",
  "NOT_FOUND",
  "METHOD_NOT_ALLOWED",
  "IDEMPOTENCY_CONFLICT",
  "REQUEST_IN_PROGRESS",
  "RATE_LIMITED",
  "UPSTREAM_INVALID",
  "DEPENDENCY_UNAVAILABLE",
  "DEADLINE_EXCEEDED",
  "INTERNAL_ERROR",
]);

export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiFieldErrorSchema = z
  .object({
    path: z.string().min(1).max(200),
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(300),
  })
  .strict();

export type ApiFieldError = z.infer<typeof ApiFieldErrorSchema>;

export const ApiErrorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: ApiErrorCodeSchema,
        message: z.string().min(1).max(500),
        requestId: z.string().uuid(),
        retryable: z.boolean(),
        fieldErrors: z.array(ApiFieldErrorSchema).max(50).optional(),
      })
      .strict(),
  })
  .strict();

export type ApiErrorEnvelope = z.infer<typeof ApiErrorEnvelopeSchema>;

const STATUS_BY_ERROR: Record<ApiErrorCode, number> = {
  INVALID_REQUEST: 400,
  VALIDATION_FAILED: 422,
  UNAUTHENTICATED: 401,
  AUTHENTICATION_FAILED: 401,
  INVALID_AUTH_TRANSACTION: 400,
  MFA_REQUIRED: 403,
  CSRF_FAILED: 403,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  IDEMPOTENCY_CONFLICT: 409,
  REQUEST_IN_PROGRESS: 409,
  RATE_LIMITED: 429,
  UPSTREAM_INVALID: 502,
  DEPENDENCY_UNAVAILABLE: 503,
  DEADLINE_EXCEEDED: 504,
  INTERNAL_ERROR: 500,
};

export function apiErrorStatus(code: ApiErrorCode): number {
  return STATUS_BY_ERROR[code];
}

export function toFieldErrors(error: z.ZodError): ApiFieldError[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    code: issue.code,
    message: issue.message,
  }));
}
