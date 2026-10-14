import type { Channel, EventContract, EventName, IpcError, Req, Res } from '@shared/ipc'

export class ApiError extends Error {
  readonly code: string
  readonly fields: Record<string, string>
  constructor(e: IpcError) {
    super(e.message)
    this.code = e.code
    this.fields = e.fields ?? {}
  }
}

/** Typed call into the main process; throws ApiError with a user-readable message. */
export async function call<C extends Channel>(channel: C, ...args: Req<C> extends void ? [] : [Req<C>]): Promise<Res<C>> {
  const result = await window.tradepilot.invoke(channel, ...args)
  if (!result.ok) throw new ApiError(result.error)
  return result.data
}

export function subscribe<E extends EventName>(event: E, fn: (payload: EventContract[E]) => void): () => void {
  return window.tradepilot.on(event, fn)
}

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))
export const fieldErrors = (err: unknown) => (err instanceof ApiError ? err.fields : {})
