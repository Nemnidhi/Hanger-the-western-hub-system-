/** Parses req.body with a zod schema; a bad body is a 400 with the first problem in plain words. */
export function parseBody(schema, req) {
  const result = schema.safeParse(req.body ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue?.path?.join(".");
    throw Object.assign(new Error(field ? `${field}: ${issue.message}` : issue?.message || "Invalid request"), { status: 400 });
  }
  return result.data;
}

export const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });

/** Wraps an async route so its errors reach the error handler. */
export const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
