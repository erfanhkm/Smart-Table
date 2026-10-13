export function badRequest(message: string): Error {
  const e = new Error(message) as Error & { statusCode: number };
  e.statusCode = 400;
  return e;
}
