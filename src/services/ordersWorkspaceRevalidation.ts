/** DB-read scheduling only. One running read and at most one pending refresh. */
export function createOrdersWorkspaceRevalidator(read: () => Promise<void>) {
  let running: Promise<void> | null = null
  let pending = false
  return {
    request(): Promise<void> {
      pending = true
      if (!running) {
        running = Promise.resolve().then(async () => {
          try {
            do {
              pending = false
              await read()
            } while (pending)
          } finally {
            // Release synchronously with the drain, before its promise settles.
            // A commit in the settlement microtask gap must start a new read.
            running = null
          }
        })
      }
      return running
    },
  }
}
