import { z } from 'zod';

export class HttpError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 503, message: string, readonly diagnosticCategory?: string) {
    super(message);
  }
}

export const id = z.string().uuid();
export const title = z.string().trim().min(1).max(200);
// Keep UTF-8 text comfortably within D1's bound-value and row limits.
export const body = z.string().min(1).max(24000).refine(value => !!value.trim());
export const seq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const external = z.string().min(1).max(320);

export async function rawBody(request: Request, limit = 256 * 1024): Promise<string> {
  if (Number(request.headers.get('content-length')) > limit) {
    throw new HttpError(413, 'Request too large');
  }
  const reader = request.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let size = 0;
  let result = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return result + decoder.decode();
      size += value.byteLength;
      if (size > limit) throw new HttpError(413, 'Request too large');
      result += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'Invalid request body');
  } finally {
    reader.releaseLock();
  }
}

export function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

export async function json<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'Expected application/json');
  }
  return schema.parse(parseJson(await rawBody(request)));
}
