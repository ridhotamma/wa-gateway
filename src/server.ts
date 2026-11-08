import { serve, type ServerType } from '@hono/node-server'

export interface StartServerOptions {
  fetch: (request: Request) => Response | Promise<Response>
  port: number
  hostname?: string
}

export interface RunningServer {
  port: number
  stop(): Promise<void>
}

/** Start the Hono app on Node's HTTP server and resolve once it is listening. */
export function startServer(options: StartServerOptions): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    let settled = false
    const server = serve(
      {
        fetch: options.fetch,
        port: options.port,
        ...(options.hostname ? { hostname: options.hostname } : {}),
      },
      (info) => {
        settled = true
        resolve({
          port: info.port,
          stop: () => stopServer(server),
        })
      },
    )

    server.once('error', (error) => {
      if (!settled) reject(error)
    })
  })
}

/**
 * Stop accepting connections, let in-flight requests finish, and force-close
 * anything still open after a short grace period.
 */
function stopServer(server: ServerType): Promise<void> {
  return new Promise((resolve) => {
    const force = setTimeout(() => {
      if ('closeAllConnections' in server) server.closeAllConnections()
      resolve()
    }, 10_000)
    force.unref()

    if ('closeIdleConnections' in server) {
      try {
        server.closeIdleConnections()
      } catch {
        // Nothing idle to close.
      }
    }

    server.close(() => {
      clearTimeout(force)
      resolve()
    })
  })
}
