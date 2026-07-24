/**
 * Main MCP proxy server — wires up stdio transport, middleware, and upstream client.
 *
 * Architecture:
 * MCP Client (stdio/JSON-RPC) <-> Middleware Chain <-> AWSMCPProxyClient <-> AWS MCP Server
 *
 * Middleware chain order:
 * Initialize → ToolError(timeout) → ToolFilter(readOnly) → ProfileSwitcher → Transport
 */

import { createInterface } from "node:readline";
import type { ProxyConfig } from "./context.js";
import { setProxyConfig } from "./context.js";
import { AWSMCPProxyClient } from "./proxy.js";
import {
  composeMiddleware,
  createInitializeMiddleware,
  createToolErrorMiddleware,
  createToolFilterMiddleware,
  createProfileSwitcherMiddleware,
} from "./middleware/index.js";
import type { JsonRpcRequest, JsonRpcResponse, Middleware } from "./middleware/index.js";
import { logger } from "./logging.js";

const COMPONENT = "server";

/**
 * Create a retry middleware that wraps transport errors with backoff.
 */
function createRetryMiddleware(maxRetries: number): Middleware {
  return async (request, next) => {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await next(request);
        // Check if the response indicates a retryable error
        if (response.error && isRetryableError(response.error.code) && attempt < maxRetries) {
          logger.warn(
            COMPONENT,
            `Retryable error (attempt ${attempt + 1}/${maxRetries + 1}): ${response.error.message}`
          );
          await backoff(attempt);
          continue;
        }
        return response;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxRetries) {
          logger.warn(
            COMPONENT,
            `Request error (attempt ${attempt + 1}/${maxRetries + 1}): ${lastError.message}`
          );
          await backoff(attempt);
        }
      }
    }

    return {
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32000,
        message: lastError?.message ?? "Request failed after retries",
      },
    };
  };
}

function isRetryableError(code: number): boolean {
  // Retry on server errors and connection issues
  return code === -32000 || code === -32603;
}

function backoff(attempt: number): Promise<void> {
  const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Create a logging middleware that logs requests and responses.
 */
function createLoggingMiddleware(): Middleware {
  return async (request, next) => {
    logger.debug(COMPONENT, `→ ${request.method} (id=${String(request.id ?? "notification")})`);
    const startTime = Date.now();

    const response = await next(request);

    const elapsed = Date.now() - startTime;
    if (response.error) {
      logger.debug(
        COMPONENT,
        `← ${request.method} ERROR [${elapsed}ms]: ${response.error.message}`
      );
    } else {
      logger.debug(COMPONENT, `← ${request.method} OK [${elapsed}ms]`);
    }

    return response;
  };
}

/**
 * Run the MCP proxy with the given configuration.
 * Reads JSON-RPC from stdin, processes through middleware, and writes to stdout.
 */
export async function runProxy(config: ProxyConfig): Promise<void> {
  setProxyConfig(config);

  logger.info(COMPONENT, `Starting MCP Proxy for AWS`);
  logger.info(COMPONENT, `Endpoint: ${config.endpoint}`);
  logger.info(COMPONENT, `Service: ${config.service}, Region: ${config.region}`);
  logger.info(COMPONENT, `Profiles: ${config.profiles.length > 0 ? config.profiles.join(", ") : "default chain"}`);

  // Create the upstream proxy client
  const proxyClient = new AWSMCPProxyClient(config);

  // Build the middleware chain
  const middlewares: Middleware[] = [
    createInitializeMiddleware(),
    createToolErrorMiddleware({ toolTimeout: config.toolTimeout }),
    createLoggingMiddleware(),
    createToolFilterMiddleware({ readOnly: config.readOnly }),
  ];

  // Add profile switcher if multiple profiles
  if (config.profiles.length > 1) {
    middlewares.push(
      createProfileSwitcherMiddleware({
        profiles: config.profiles,
        getProfileClient: (profile) => proxyClient.getHandler(profile),
      })
    );
  }

  // Add retry middleware
  if (config.retries > 0) {
    middlewares.push(createRetryMiddleware(config.retries));
  }

  // Compose middleware with the transport as the final handler
  const handler = composeMiddleware(middlewares, proxyClient.getDefaultHandler());

  // Set up stdio transport
  const rl = createInterface({
    input: process.stdin,
    terminal: false,
  });

  // Handle graceful shutdown
  const shutdown = async (): Promise<void> => {
    logger.info(COMPONENT, "Shutting down...");
    await proxyClient.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGHUP", () => void shutdown());

  // Process stdin line by line (each line is a JSON-RPC message)
  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    void processMessage(trimmed, handler);
  });

  // Handle stdin close (client disconnected)
  rl.on("close", () => {
    logger.info(COMPONENT, "stdin closed, shutting down");
    void shutdown();
  });

  // Keep the process alive
  logger.info(COMPONENT, "Proxy ready, reading from stdin...");
}

/**
 * Process a single JSON-RPC message from stdin.
 */
async function processMessage(
  line: string,
  handler: (request: JsonRpcRequest) => Promise<JsonRpcResponse>
): Promise<void> {
  let request: JsonRpcRequest;

  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch (err) {
    const parseError: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: null as unknown as undefined,
      error: {
        code: -32700,
        message: `Parse error: ${err instanceof Error ? err.message : "Invalid JSON"}`,
      },
    };
    writeResponse(parseError);
    return;
  }

  // Validate basic JSON-RPC structure
  if (request.jsonrpc !== "2.0" || !request.method) {
    const invalidRequest: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32600,
        message: "Invalid Request: missing jsonrpc version or method",
      },
    };
    writeResponse(invalidRequest);
    return;
  }

  try {
    const response = await handler(request);

    // Only send responses for requests (not notifications — those have no id)
    if (request.id !== undefined) {
      writeResponse(response);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(COMPONENT, `Unhandled error processing ${request.method}: ${message}`);

    if (request.id !== undefined) {
      const errorResponse: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32603,
          message: `Internal error: ${message}`,
        },
      };
      writeResponse(errorResponse);
    }
  }
}

/**
 * Write a JSON-RPC response to stdout.
 * Each response is a single line of JSON followed by a newline.
 */
function writeResponse(response: JsonRpcResponse): void {
  const json = JSON.stringify(response);
  process.stdout.write(json + "\n");
}
