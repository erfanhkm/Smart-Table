// Small HTTP error helpers. The global error handler (src/index.ts) exposes the
// message of 4xx errors to the client and replaces every 5xx with a generic message.

export type HttpError = Error & { statusCode: number; errorCode?: string };

export function httpError(statusCode: number, message: string, errorCode?: string): HttpError {
  const e = new Error(message) as HttpError;
  e.statusCode = statusCode;
  if (errorCode) e.errorCode = errorCode;
  return e;
}

export const badRequest = (message: string): HttpError => httpError(400, message);
export const unauthorized = (message = 'unauthorized'): HttpError => httpError(401, message);
export const forbidden = (message: string): HttpError => httpError(403, message);
export const notFound = (message: string): HttpError => httpError(404, message);
export const conflict = (message: string, errorCode?: string): HttpError => httpError(409, message, errorCode);

export function isClientError(e: unknown): e is HttpError {
  const s = (e as { statusCode?: unknown } | null)?.statusCode;
  return typeof s === 'number' && s >= 400 && s < 500;
}
