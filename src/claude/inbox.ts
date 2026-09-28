/** A pushable async stream: prompts into a Claude Code process, or scripted frames out of a fake one. */
export class Inbox<T> implements AsyncIterable<T> {
  private queue: T[] = []
  private wake: (() => void) | null = null
  private ended = false

  push(item: T) {
    this.queue.push(item)
    this.wake?.()
  }

  end() {
    this.ended = true
    this.wake?.()
  }

  async *[Symbol.asyncIterator]() {
    for (;;) {
      const next = this.queue.shift()
      if (next !== undefined) yield next
      else if (this.ended) return
      else await new Promise<void>((resolve) => (this.wake = resolve))
    }
  }
}
