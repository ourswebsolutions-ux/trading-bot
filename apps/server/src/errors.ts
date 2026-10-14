export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>
  ) {
    super(message)
  }
}

export const badRequest = (message: string, fields?: Record<string, string>) => new AppError(400, 'validation_failed', message, fields)
export const conflict = (code: string, message: string) => new AppError(409, code, message)
export const notFound = (message = 'Not found') => new AppError(404, 'not_found', message)
