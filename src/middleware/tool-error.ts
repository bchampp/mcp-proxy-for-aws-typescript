/**
 * Tool error middleware — handles timeouts and wraps tool call errors.
 *
 * Applies a per-tool-call timeout and converts errors into proper
 * JSON-RPC error responses rather than crashing the proxy.
 */

import type { Middleware, JsonRpcRequest, JsonRpcResponse, NextFunction } from "./index.js";
import { logger } from "../logging.js";

const COMPONENT = "middleware:tool-error";

export interface ToolErrorConfig {
  /** Timeout for tool calls in seconds */
  toolTimeout: number;
}

export function createToolErrorMiddleware(config: ToolErrorConfig): Middleware {
  return async (request: JsonRpcRequest, next: NextFunction): Promise<JsonRpcResponse> => {
    // Only apply timeout to tool calls
    if (request.method !== "tools/call") {
      return next(request);
    }

    const toolName = (request.params?.["name"] as string) ?? "unknown";
    logger.debug(COMPONENT, `Tool call: ${toolName} (timeout: ${config.toolTimeout}s)`);

    // Race the request against a timeout
    const timeoutMs = config.toolTimeout * 1000;

    const timeoutPromise = new Promise<JsonRpcResponse>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Tool call "${toolName}" timed out after ${config.toolTimeout}s`));
      }, timeoutMs);
    });

    try {
      const response = await Promise.race([next(request), timeoutPromise]);
      return response;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(COMPONENT, `Tool call error: ${message}`);

      // Return a proper JSON-RPC error response
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32000,
          message: `Tool error: ${message}`,
          data: {
            toolName,
            isTimeout: message.includes("timed out"),
          },
        },
      };
    }
  };
}
