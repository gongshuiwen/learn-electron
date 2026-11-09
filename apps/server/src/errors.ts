export type ChatErrorCode =
  | 'conversation_not_found'
  | 'run_not_found'
  | 'conversation_busy'
  | 'idempotency_conflict'
  | 'engine_not_configured'
  | 'storage_unavailable'
  | 'shutting_down'
  | 'connection_changed'

export class ChatError extends Error {
  constructor(
    readonly code: ChatErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}
