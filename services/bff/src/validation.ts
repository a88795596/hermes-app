export class ApiError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
  }
}

export function invalid(message: string): never {
  throw new ApiError(422, "VALIDATION_FAILED", message);
}

export function missing(resource: string): never {
  throw new ApiError(404, "NOT_FOUND", `${resource} not found`);
}

export function conflict(message: string): never {
  throw new ApiError(409, "IDEMPOTENCY_CONFLICT", message);
}

export function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
    invalid(`${field} must be a UUID`);
  }
  return value.toLowerCase();
}

export function record(value: unknown, fields?: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || !value || Array.isArray(value)) invalid("Expected a JSON object");
  const object = value as Record<string, unknown>;
  if (fields && Object.keys(object).some((key) => !fields.includes(key))) invalid("Unexpected field");
  return object;
}

export function string(value: unknown, field: string, maxBytes: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || Buffer.from(value).toString() !== value
    || value.includes("\u0000") || Buffer.byteLength(value) > maxBytes) {
    invalid(`Invalid ${field}`);
  }
  return value;
}
