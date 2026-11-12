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

export type ApplicationErrorCode =
  | 'shutting_down'
  | 'connection_busy'
  | 'connection_identity_changed'
  | 'provider_not_found'
  | 'connection_not_found'
  | 'model_unavailable'
  | 'authorization_active'
  | 'login_pending'
  | 'login_not_found'

export class ApplicationError extends Error {
  constructor(
    readonly code: ApplicationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
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
