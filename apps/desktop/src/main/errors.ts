/** An error whose message is safe and useful to show in the UI. */
export class UserError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>
  ) {
    super(message)
  }
}
