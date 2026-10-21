import type { FastifyInstance, FastifyReply } from 'fastify';
import { ZodError, type ZodTypeAny, type z } from 'zod';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function sendError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: { code, message } });
}

export function parseBody<T extends ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    throw new HttpError(400, 'invalid_request', msg);
  }
  return r.data;
}

export function installErrorHandling(app: FastifyInstance): void {
  // Allow POST/DELETE with a JSON content-type and an empty body.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (body === '') return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new HttpError(400, 'invalid_json', 'Malformed JSON body'), undefined);
    }
  });
  app.setErrorHandler((err: Error, req, reply) => {
    if (err instanceof HttpError) return sendError(reply, err.status, err.code, err.message);
    if (err instanceof ZodError) return sendError(reply, 400, 'invalid_request', err.message);
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return sendError(reply, status, 'bad_request', err.message);
    req.log.error(err);
    return sendError(reply, 500, 'internal', 'Internal server error');
  });
  app.setNotFoundHandler((_req, reply) => sendError(reply, 404, 'not_found', 'Route not found'));
}
