// A minimal Chrome DevTools Protocol client over Node's built-in WebSocket.

/** Connects to the app's page target on a remote-debugging port. */
export async function connectPage(port, { timeout = 30000 } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = targets.find((target) => target.type === 'page' && target.url.startsWith('docs://'))
      if (page) return await open(page.webSocketDebuggerUrl)
    } catch {
      // The port is not listening yet.
    }
    if (Date.now() > deadline) throw new Error('the app window did not appear on the debugging port')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function open(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    let nextId = 0
    const pending = new Map()
    let closed = false
    const send = (method, params = {}) =>
      new Promise((done, fail) => {
        if (closed) return fail(new Error(`${method}: the app window is closed`))
        const id = (nextId += 1)
        pending.set(id, { done, fail, method })
        socket.send(JSON.stringify({ id, method, params }))
      })
    socket.addEventListener('close', () => {
      closed = true
      for (const waiter of pending.values()) waiter.fail(new Error(`${waiter.method}: the app window closed`))
      pending.clear()
    })
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const waiter = pending.get(message.id)
      if (!waiter) return
      pending.delete(message.id)
      if (message.error) waiter.fail(new Error(`${waiter.method}: ${message.error.message}`))
      else waiter.done(message.result)
    })
    socket.addEventListener('error', () => reject(new Error('could not connect to the app window')))
    socket.addEventListener('open', () =>
      resolve({
        send,
        /** Evaluates an expression in the page and returns its (awaited) value. */
        async evaluate(expression) {
          const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
          if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
          return result.value
        },
        close: () => socket.close(),
      }),
    )
  })
}
