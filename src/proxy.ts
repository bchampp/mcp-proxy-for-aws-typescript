/**
 * AWSMCPProxyClient — manages per-profile MCP client connections.
 *
 * Key design:
 * - Lazy client creation per profile (behind async lock)
 * - Invalidate + reconnect on connection failure
 * - Retry logic with configurable max retries
 * - Fresh credentials on every request (no caching)
 */

import { AWSMCPTransport, type TransportConfig } from "./transport.js";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  NextFunction,
} from "./middleware/index.js";
import { logger } from "./logging.js";
import type { ProxyConfig } from "./context.js";

const COMPONENT = "proxy";

/** Maximum connection retries before giving up */
const MAX_CONNECTION_RETRIES = 3;

/**
 * Simple async mutex for serializing per-profile client creation.
 */
class AsyncMutex {
  private locked = false;
  private waiters: Array<() => void> = [];

  async acquire(): Promise<void> {
    while (this.locked) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.locked = true;
  }

  release(): void {
    this.locked = false;
    const next = this.waiters.shift();
    if (next) next();
  }
}

/**
 * Per-profile client state.
 */
interface ProfileClient {
  transport: AWSMCPTransport;
  mutex: AsyncMutex;
}

/**
 * AWSMCPProxyClient manages transport connections for each AWS profile.
 * Provides lazy initialization, connection retry, and invalidation.
 */
export class AWSMCPProxyClient {
  private readonly clients: Map<string, ProfileClient> = new Map();
  private readonly config: ProxyConfig;

  constructor(config: ProxyConfig) {
    this.config = config;
  }

  /**
   * Get the NextFunction handler for a specific profile.
   * Creates the transport lazily on first use.
   */
  getHandler(profile: string): NextFunction {
    return async (request: JsonRpcRequest): Promise<JsonRpcResponse> => {
      return this.sendRequest(profile, request);
    };
  }

  /**
   * Get the default handler (uses the first profile or default chain).
   */
  getDefaultHandler(): NextFunction {
    const profile = this.config.profiles[0] ?? "__default__";
    return this.getHandler(profile);
  }

  /**
   * Send a request through the transport for a given profile.
   * Handles retry logic with connection invalidation.
   */
  private async sendRequest(
    profile: string,
    request: JsonRpcRequest
  ): Promise<JsonRpcResponse> {
    const maxRetries = Math.min(this.config.retries, MAX_CONNECTION_RETRIES);
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const client = await this.getOrCreateClient(profile);
        const response = await client.transport.send(request);

        // Parse the response body as JSON-RPC
        if (response.body) {
          try {
            const parsed = JSON.parse(response.body) as JsonRpcResponse | JsonRpcResponse[];
            // Handle batch responses
            if (Array.isArray(parsed)) {
              // Return the response matching the request ID, or the first one
              const matching = parsed.find((r) => r.id === request.id) ?? parsed[0];
              if (matching) return matching;
            }
            return parsed as JsonRpcResponse;
          } catch {
            // If the body isn't valid JSON, return it as an error
            return {
              jsonrpc: "2.0",
              id: request.id,
              error: {
                code: -32000,
                message: `Invalid response from upstream: ${response.body.slice(0, 200)}`,
              },
            };
          }
        }

        // Empty response
        return {
          jsonrpc: "2.0",
          id: request.id,
          result: null,
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        logger.warn(
          COMPONENT,
          `Request failed (attempt ${attempt + 1}/${maxRetries + 1}): ${lastError.message}`
        );

        // Invalidate the client on connection failure
        if (attempt < maxRetries) {
          await this.invalidateClient(profile);
          // Brief backoff before retry
          await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
        }
      }
    }

    // All retries exhausted
    return {
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32000,
        message: `Request failed after ${maxRetries + 1} attempts: ${lastError?.message ?? "unknown error"}`,
      },
    };
  }

  /**
   * Get or create a transport client for a given profile.
   * Uses an async mutex to prevent duplicate client creation.
   */
  private async getOrCreateClient(profile: string): Promise<ProfileClient> {
    let client = this.clients.get(profile);
    if (client) return client;

    // Create a new client behind a mutex
    const mutex = new AsyncMutex();
    await mutex.acquire();
    try {
      // Double-check after acquiring lock
      client = this.clients.get(profile);
      if (client) return client;

      const resolvedProfile = profile === "__default__" ? undefined : profile;
      const transportConfig: TransportConfig = {
        endpoint: this.config.endpoint,
        signingConfig: {
          service: this.config.service,
          region: this.config.region,
          profile: resolvedProfile,
        },
        timeout: this.config.timeout,
        connectTimeout: this.config.connectTimeout,
        readTimeout: this.config.readTimeout,
        writeTimeout: this.config.writeTimeout,
        skipAuth: this.config.skipAuth,
        metadata: this.config.metadata,
      };

      const transport = new AWSMCPTransport(transportConfig);

      client = { transport, mutex };
      this.clients.set(profile, client);

      logger.info(COMPONENT, `Created client for profile: ${resolvedProfile ?? "default"}`);
      return client;
    } finally {
      mutex.release();
    }
  }

  /**
   * Invalidate a client (forces reconnection on next use).
   */
  private async invalidateClient(profile: string): Promise<void> {
    const client = this.clients.get(profile);
    if (client) {
      logger.info(COMPONENT, `Invalidating client for profile: ${profile}`);
      try {
        await client.transport.terminate();
      } catch {
        // Ignore termination errors during invalidation
      }
      this.clients.delete(profile);
    }
  }

  /**
   * Terminate all client connections.
   */
  async shutdown(): Promise<void> {
    for (const [profile, client] of this.clients) {
      logger.info(COMPONENT, `Shutting down client for profile: ${profile}`);
      try {
        await client.transport.terminate();
      } catch {
        // Best-effort termination
      }
    }
    this.clients.clear();
  }
}
