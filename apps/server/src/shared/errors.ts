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
