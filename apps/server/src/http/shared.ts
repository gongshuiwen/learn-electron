import type { IncomingMessage } from 'node:http'
import { MAX_BODY_BYTES } from '@learn-electron/contracts/http'
import type { HttpPathParameters } from '@learn-electron/contracts/http'
import { HttpError } from './errors.ts'

export type IdParams<K extends keyof HttpPathParameters> = { Params: HttpPathParameters[K] }

export function readJson(request: IncomingMessage): Promise<unknown> {
  if (!request.headers['content-type']?.startsWith('application/json')) {
    return Promise.reject(
      new HttpError(415, 'unsupported_media_type', '请求须使用 application/json'),
    )
  }
  return new Promise((resolveBody, rejectBody) => {
    let bytes = 0
    const chunks: Buffer[] = []
    let rejected = false
    request.on('data', (chunk: Buffer) => {
      if (rejected) return
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) {
        rejected = true
        chunks.length = 0
        rejectBody(new HttpError(413, 'body_too_large', '请求内容过大'))
      } else chunks.push(chunk)
    })
    request.once('end', () => {
      if (rejected) return
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
      } catch {
        rejectBody(new HttpError(400, 'invalid_json', 'JSON 格式无效'))
      }
    })
    request.once('error', rejectBody)
    request.once('aborted', () => rejectBody(new HttpError(400, 'request_aborted', '请求已中断')))
  })
}

export function parse<T>(parser: (value: unknown) => T, value: unknown): T {
  try {
    return parser(value)
  } catch (error) {
    throw new HttpError(400, 'invalid_request', error instanceof Error ? error.message : '请求无效')
  }
}

export function methodNotAllowed(): never {
  throw new HttpError(405, 'method_not_allowed', '不支持的请求方法')
}
