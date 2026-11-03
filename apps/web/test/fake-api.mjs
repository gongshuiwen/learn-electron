// Script HTTP/SSE responses for browser scenarios; server tests own run execution
// and persistence guarantees.
export function fakeApi() {
  const conversations = new Map()
  const snapshots = new Map()
  const runs = new Map()
  let configured = true
  let apiVersion = 1
  let snapshotFailures = 0
  let nextId = 0
  let behavior = 'complete'
  let eventReads = 0
  let lastRequest
  let delayedRun
  let clock = Date.now()
  const stamp = () => new Date(++clock).toISOString()
  const clone = (value) => JSON.parse(JSON.stringify(value))
  const event = (snapshot, payload) => ({
    apiVersion: 1,
    conversationId: snapshot.conversation.id,
    runId: snapshot.run.id,
    sequence: snapshot.sequence,
    ...payload,
  })
  const sse = (events) =>
    events.map((value) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join('')
  return {
    setBehavior(value) {
      behavior = value
    },
    setConfigured(value) {
      configured = value
    },
    setApiVersion(value) {
      apiVersion = value
    },
    deferNextRun() {
      let begin
      let resume
      const started = new Promise((resolve) => {
        begin = resolve
      })
      const wait = new Promise((resolve) => {
        resume = resolve
      })
      delayedRun = { begin, wait }
      return { started, resume }
    },
    get runCount() {
      return runs.size
    },
    get eventReads() {
      return eventReads
    },
    get lastRequest() {
      return lastRequest
    },
    async handle(route) {
      const request = route.request()
      const path = new URL(request.url()).pathname.replace('/api/v1', '')
      const method = request.method()
      const json = (body, status = 200) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
      if (path === '/meta')
        return json({
          apiVersion,
          engine: 'mock',
          model: { provider: 'test', id: 'fixture-model' },
          configured,
          capabilities: { tools: false },
        })
      if (path === '/conversations' && method === 'GET')
        return json(
          [...conversations.values()].sort((left, right) =>
            right.updatedAt.localeCompare(left.updatedAt),
          ),
        )
      if (path === '/conversations' && method === 'POST') {
        const conversation = {
          id: `conversation-${++nextId}`,
          title: '新对话',
          createdAt: stamp(),
          updatedAt: stamp(),
        }
        conversations.set(conversation.id, conversation)
        snapshots.set(conversation.id, { conversation, messages: [], run: null, sequence: 0 })
        return json(conversation, 201)
      }
      const id = path.split('/')[2]
      if (path.startsWith('/conversations/') && !path.endsWith('/runs')) {
        const snapshot = snapshots.get(id)
        if (!snapshot) return json({ error: { code: 'NOT_FOUND', message: '对话不存在' } }, 404)
        if (method === 'PATCH') {
          snapshot.conversation.title = request.postDataJSON().title
          snapshot.conversation.updatedAt = stamp()
          return json(snapshot.conversation)
        }
        if (method === 'DELETE') {
          conversations.delete(id)
          snapshots.delete(id)
          return route.fulfill({ status: 204 })
        }
        if (snapshotFailures) {
          snapshotFailures--
          return route.abort('failed')
        }
        return json(snapshot)
      }
      if (path.endsWith('/runs') && method === 'POST') {
        lastRequest = request.postDataJSON()
        const delay = delayedRun
        delayedRun = undefined
        if (delay) {
          delay.begin()
          await delay.wait
        }
        if (behavior === 'request-error')
          return json({ error: { code: 'MODEL_ERROR', message: '模型服务暂时不可用' } }, 503)
        const requestKey = `${id}:${lastRequest.requestId}`
        const existing = runs.get(requestKey)
        if (existing) return json(existing, 202)
        const snapshot = snapshots.get(id)
        const run = {
          id: `run-${++nextId}`,
          conversationId: id,
          status: 'running',
          createdAt: stamp(),
          updatedAt: stamp(),
        }
        snapshot.run = run
        runs.set(requestKey, run)
        if (behavior === 'snapshot-error-once') snapshotFailures++
        snapshot.messages.push(
          {
            id: `user-${nextId}`,
            role: 'user',
            content: lastRequest.message,
            createdAt: stamp(),
            status: 'complete',
          },
          {
            id: `assistant-${nextId}`,
            role: 'assistant',
            content: '',
            createdAt: stamp(),
            status: 'streaming',
          },
        )
        snapshot.sequence++
        snapshot.conversation.updatedAt = stamp()
        return json(run, 202)
      }
      if (path.startsWith('/runs/')) {
        const snapshot = [...snapshots.values()].find((item) => item.run?.id === id)
        if (!snapshot) return json({ error: { code: 'NOT_FOUND', message: '任务不存在' } }, 404)
        const assistant = snapshot.messages.at(-1)
        if (path.endsWith('/cancel')) {
          snapshot.run.status = 'cancelled'
          assistant.status = 'interrupted'
          snapshot.sequence++
          return json(snapshot.run)
        }
        eventReads++
        const initial = event(snapshot, { type: 'snapshot', snapshot: clone(snapshot) })
        if (behavior === 'incompatible-events') {
          return route.fulfill({
            contentType: 'text/event-stream',
            body: sse([{ ...initial, apiVersion: 2 }]),
          })
        }
        if (behavior === 'invalid-payload') {
          return route.fulfill({
            contentType: 'text/event-stream',
            body: sse([
              initial,
              event(snapshot, { type: 'message.delta', messageId: assistant.id }),
            ]),
          })
        }
        const events = [initial]
        if (!assistant.content) {
          assistant.content =
            '**你好**，这是一段回复。<img src="x" onerror="window.__unsafe = true">'
          snapshot.sequence++
          events.push(
            event(snapshot, {
              type: 'message.delta',
              messageId: assistant.id,
              delta: assistant.content,
            }),
          )
        }
        if (behavior === 'complete' || behavior === 'run-error') {
          snapshot.sequence++
          assistant.status = behavior === 'run-error' ? 'interrupted' : 'complete'
          events.push(event(snapshot, { type: 'message.completed', message: clone(assistant) }))
          snapshot.run.status = behavior === 'run-error' ? 'failed' : 'completed'
          if (behavior === 'run-error') snapshot.run.error = '生成过程中发生错误'
          snapshot.sequence++
          events.push(event(snapshot, { type: 'run.updated', run: clone(snapshot.run) }))
        }
        return route.fulfill({ contentType: 'text/event-stream', body: sse(events) })
      }
      return json({ error: { code: 'NOT_FOUND', message: '未知接口' } }, 404)
    },
  }
}
