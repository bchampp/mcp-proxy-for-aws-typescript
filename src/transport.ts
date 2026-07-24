/**
 * Streamable HTTP transport wrapper for connecting to AWS MCP endpoints.
 *
 * Handles:
 * - HTTP request/response lifecycle with SigV4-signed requests
 * - Session management (Mcp-Session-Id header)
 * - Server-Sent Events (SSE) streaming for responses
 * - Connection keep-alive for the entire stdio session
 * - Metadata injection into JSON-RPC _meta fields
 */

import { signRequest, checkCredentialError, type SigningConfig } from "./sigv4.js";
import { logger, redactHeaders } from "./logging.js";

const COMPONENT = "transport";

export interface TransportConfig {
  endpoint: string;
  signingConfig: SigningConfig;
  timeout: number;
  connectTimeout: number;
  readTimeout: number;
  writeTimeout: number;
  skipAuth: boolean;
  metadata: Record<string, string>;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  sessionId?: string;
}

/**
 * AWS MCP Transport — handles HTTP communication with SigV4 signing.
 * Maintains session state (Mcp-Session-Id) across requests.
 */
export class AWSMCPTransport {
  private sessionId: string | undefined;
  private readonly config: TransportConfig;

  constructor(config: TransportConfig) {
    this.config = config;
  }

  /**
   * Send a JSON-RPC request to the upstream MCP server.
   * Handles SigV4 signing, session headers, and metadata injection.
   */
  async send(jsonRpcBody: unknown): Promise<TransportResponse> {
    // Inject metadata into the request body if configured
    const body = this.injectMetadata(jsonRpcBody);
    const bodyStr = JSON.stringify(body);

    // Build request headers
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };

    // Include session ID if we have one from a previous response
    if (this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
    }

    // Sign the request with SigV4 (unless auth is skipped for testing)
    let finalHeaders: Record<string, string>;
    if (this.config.skipAuth) {
      finalHeaders = { ...headers };
    } else {
      finalHeaders = await signRequest(
        this.config.endpoint,
        "POST",
        headers,
        bodyStr,
        this.config.signingConfig
      );
    }

    logger.debug(COMPONENT, `Sending request to ${this.config.endpoint}`);
    logger.debug(COMPONENT, `Headers: ${JSON.stringify(redactHeaders(finalHeaders))}`);

    // Execute the HTTP request with timeout
    const controller = new AbortController();
    const timeoutMs = this.config.timeout * 1000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(this.config.endpoint, {
        method: "POST",
        headers: finalHeaders,
        body: bodyStr,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Track session ID from response
      const responseSessionId = response.headers.get("mcp-session-id");
      if (responseSessionId) {
        this.sessionId = responseSessionId;
      }

      // Check for credential errors
      const credError = checkCredentialError(response.status);
      if (credError) {
        logger.error(COMPONENT, credError);
        throw new Error(credError);
      }

      // Read the response body
      const contentType = response.headers.get("content-type") ?? "";
      let responseBody: string;

      if (contentType.includes("text/event-stream")) {
        // Handle SSE streaming response
        responseBody = await this.readSSEResponse(response);
      } else {
        responseBody = await response.text();
      }

      // Collect response headers
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      logger.debug(COMPONENT, `Response status: ${response.status}`);

      return {
        status: response.status,
        headers: responseHeaders,
        body: responseBody,
        sessionId: this.sessionId,
      };
    } catch (err) {
      clearTimeout(timeoutId);

      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(
          `Request to ${this.config.endpoint} timed out after ${this.config.timeout}s`
        );
      }
      throw err;
    }
  }

  /**
   * Send a DELETE request to terminate the session.
   */
  async terminate(): Promise<void> {
    if (!this.sessionId) return;

    const headers: Record<string, string> = {
      "mcp-session-id": this.sessionId,
    };

    let finalHeaders: Record<string, string>;
    if (this.config.skipAuth) {
      finalHeaders = headers;
    } else {
      finalHeaders = await signRequest(
        this.config.endpoint,
        "DELETE",
        headers,
        undefined,
        this.config.signingConfig
      );
    }

    try {
      await fetch(this.config.endpoint, {
        method: "DELETE",
        headers: finalHeaders,
      });
      logger.info(COMPONENT, "Session terminated");
    } catch (err) {
      logger.warn(COMPONENT, `Failed to terminate session: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Send a GET request for SSE streaming (server-initiated messages).
   * Returns an async generator of SSE events.
   */
  async *openSSEStream(): AsyncGenerator<string, void, unknown> {
    const headers: Record<string, string> = {
      accept: "text/event-stream",
    };

    if (this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
    }

    let finalHeaders: Record<string, string>;
    if (this.config.skipAuth) {
      finalHeaders = headers;
    } else {
      finalHeaders = await signRequest(
        this.config.endpoint,
        "GET",
        headers,
        undefined,
        this.config.signingConfig
      );
    }

    const response = await fetch(this.config.endpoint, {
      method: "GET",
      headers: finalHeaders,
    });

    if (!response.ok) {
      throw new Error(`SSE stream failed with status ${response.status}`);
    }

    if (!response.body) {
      throw new Error("SSE response has no body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            yield line.slice(6);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Read a complete SSE response, collecting all data events.
   * Returns the concatenated JSON-RPC messages.
   */
  private async readSSEResponse(response: Response): Promise<string> {
    if (!response.body) {
      return "";
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const messages: string[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            messages.push(line.slice(6));
          }
        }
      }

      // Process remaining buffer
      if (buffer.startsWith("data: ")) {
        messages.push(buffer.slice(6));
      }
    } finally {
      reader.releaseLock();
    }

    // If there's only one message, return it directly
    // If multiple, return as JSON array
    if (messages.length === 0) return "";
    if (messages.length === 1) return messages[0]!;
    return `[${messages.join(",")}]`;
  }

  /**
   * Inject metadata into the JSON-RPC body's params._meta field.
   * Merges with existing _meta (does not overwrite).
   */
  private injectMetadata(body: unknown): unknown {
    if (!this.config.metadata || Object.keys(this.config.metadata).length === 0) {
      return body;
    }

    if (typeof body !== "object" || body === null) {
      return body;
    }

    const rpcBody = body as Record<string, unknown>;

    // Only inject if there's a params field (standard JSON-RPC)
    if (!("params" in rpcBody) || typeof rpcBody["params"] !== "object" || rpcBody["params"] === null) {
      return body;
    }

    const params = rpcBody["params"] as Record<string, unknown>;
    const existingMeta = (params["_meta"] as Record<string, unknown>) ?? {};

    return {
      ...rpcBody,
      params: {
        ...params,
        _meta: {
          ...existingMeta,
          ...this.config.metadata,
        },
      },
    };
  }

  /** Get the current session ID */
  getSessionId(): string | undefined {
    return this.sessionId;
  }

  /** Reset session state (for reconnection) */
  resetSession(): void {
    this.sessionId = undefined;
  }
}
