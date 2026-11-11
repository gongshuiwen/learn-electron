import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { ChatGPTOAuth, CHATGPT_SCOPE } from '../../src/chatgpt/oauth.ts'
import { getOpenAIModels } from '@learn-electron/agent-runtime'

export async function oauthFixture(t) {
  const { privateKey, publicKey } = await generateKeyPair('ES256')
  const key = { ...(await exportJWK(publicKey)), kid: 'fixture-key', alg: 'ES256', use: 'sig' }
  const modelId = (await getOpenAIModels())[0].id
  const fixture = {
    codes: new Map(),
    refreshes: 0,
    revoked: [],
    requests: [],
    scopes: CHATGPT_SCOPE,
    expiresIn: 3600,
    tokenError: null,
    tokenErrorStatus: 400,
    delayRefresh: null,
    delayExchange: null,
    responseError: null,
    issuer: '',
    resource: '',
    modelId,
    calls: 0,
    holdResponse: false,
    responseGate: null,
    subject: 'test-user',
    revocationFails: false,
  }
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url, fixture.issuer)
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = Buffer.concat(chunks).toString()
      const json = (data, status = 200) => {
        response.writeHead(status, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(data))
      }
      if (url.pathname === '/.well-known/openid-configuration')
        return json({
          issuer: fixture.issuer,
          jwks_uri: `${fixture.issuer}/jwks`,
          revocation_endpoint: `${fixture.issuer}/revoke`,
        })
      if (url.pathname === '/jwks') return json({ keys: [key] })
      if (url.pathname === '/api/accounts/oauth/token') {
        const form = new URLSearchParams(body)
        if (fixture.tokenError) return json({ error: fixture.tokenError }, fixture.tokenErrorStatus)
        let nonce
        let subject = fixture.subject
        if (form.get('grant_type') === 'authorization_code') {
          const authorization = fixture.codes.get(form.get('code'))
          if (!authorization) return json({ error: 'invalid_grant' }, 400)
          fixture.codes.delete(form.get('code'))
          nonce = authorization.get('nonce')
          subject = authorization.get('fixture_subject') ?? subject
          await fixture.delayExchange?.()
        } else {
          fixture.refreshes++
          await fixture.delayRefresh?.()
        }
        const idToken = await new SignJWT({ nonce: nonce ?? 'refresh', email: 'test@example.com' })
          .setProtectedHeader({ alg: 'ES256', kid: key.kid })
          .setIssuer(fixture.issuer)
          .setSubject(subject)
          .setAudience(form.get('client_id'))
          .setIssuedAt()
          .setExpirationTime('1h')
          .sign(privateKey)
        return json({
          access_token: `plan-access-${randomUUID()}`,
          refresh_token: (fixture.latestRefreshToken = `plan-refresh-${randomUUID()}`),
          id_token: idToken,
          token_type: 'Bearer',
          expires_in: fixture.expiresIn,
          scope: fixture.scopes,
        })
      }
      if (url.pathname === '/revoke') {
        fixture.revoked.push(new URLSearchParams(body).get('token'))
        response.writeHead(fixture.revocationFails ? 503 : 200)
        response.end()
        return
      }
      if (url.pathname === '/v1/models')
        return json({
          models: [
            { slug: modelId, display_name: 'Fixture model', visibility: 'list' },
            { slug: 'unknown-to-pi', display_name: 'Unsupported', visibility: 'list' },
            { slug: 'hidden', display_name: 'Hidden', visibility: 'hidden' },
          ],
        })
      if (url.pathname === '/v1/responses') {
        fixture.calls++
        fixture.requests.push({
          authorization: request.headers.authorization,
          body: JSON.parse(body),
        })
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const emit = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`)
        const item = {
          id: randomUUID(),
          type: 'message',
          role: 'assistant',
          status: 'in_progress',
          content: [],
        }
        emit({ type: 'response.output_item.added', output_index: 0, item })
        const text = fixture.calls === 1 ? '你好，我记住了。' : '你刚才说了你好。'
        emit({
          type: 'response.content_part.added',
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        })
        emit({
          type: 'response.output_text.delta',
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          delta: text,
        })
        if (fixture.holdResponse) {
          fixture.responseGate = Promise.withResolvers()
          await Promise.race([fixture.responseGate.promise, once(response, 'close')])
          if (response.destroyed) return
        }
        if (fixture.responseError === 'incomplete')
          emit({
            type: 'response.incomplete',
            response: {
              id: randomUUID(),
              status: 'incomplete',
              incomplete_details: { reason: 'max_output_tokens' },
              output: [],
            },
          })
        else if (fixture.responseError)
          emit({
            type: 'response.failed',
            response: { error: { code: fixture.responseError, message: fixture.responseError } },
          })
        else {
          const completed = {
            ...item,
            status: 'completed',
            content: [{ type: 'output_text', text, annotations: [] }],
          }
          emit({ type: 'response.output_item.done', output_index: 0, item: completed })
          emit({
            type: 'response.completed',
            response: {
              id: randomUUID(),
              status: 'completed',
              output: [completed],
              usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
            },
          })
        }
        response.end()
        return
      }
      json({ error: 'not_found' }, 404)
    })().catch((error) => {
      response.writeHead(500)
      response.end(error.message)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  fixture.issuer = `http://127.0.0.1:${server.address().port}`
  fixture.resource = `${fixture.issuer}/v1`
  fixture.oauth = new ChatGPTOAuth({ issuer: fixture.issuer, resource: fixture.resource })
  fixture.authorize = async (login, overrides = {}) => {
    const params = new URL(login.authorizationUrl).searchParams
    const code = randomUUID()
    if (overrides.subject) params.set('fixture_subject', overrides.subject)
    fixture.codes.set(code, params)
    const callback = new URL(params.get('redirect_uri'))
    callback.search = new URLSearchParams({
      code,
      state: params.get('state'),
      client_id:
        params.get('client_id') === 'dynamic_agent_client'
          ? `oaiapp_${randomUUID()}`
          : params.get('client_id'),
      ...overrides,
    }).toString()
    return fetch(callback, { signal: t.signal })
  }
  fixture.sign = async (claims, options = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', kid: key.kid })
      .setIssuer(options.issuer ?? fixture.issuer)
      .setAudience(options.audience ?? 'test-client')
      .setSubject('user')
      .setIssuedAt()
      .setExpirationTime(options.expiration ?? '1h')
      .sign(privateKey)
  t.after(async () => {
    await new Promise((resolve) => {
      server.close(resolve)
      server.closeAllConnections()
    })
  })
  return fixture
}
