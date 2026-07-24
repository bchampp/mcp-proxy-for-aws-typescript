/**
 * Tool filter middleware — filters tools to read-only when --read-only is set.
 *
 * Intercepts tools/list responses and removes tools that don't have
 * readOnlyHint set to true. Also blocks calls to non-read-only tools.
 */

import type { Middleware, JsonRpcRequest, JsonRpcResponse, NextFunction } from "./index.js";
import { logger } from "../logging.js";

const COMPONENT = "middleware:tool-filter";

export interface ToolFilterConfig {
  /** Whether to filter to read-only tools only */
  readOnly: boolean;
}

interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: {
    readOnlyHint?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** Cache of allowed tool names for read-only mode */
let allowedTools: Set<string> | undefined;

export function createToolFilterMiddleware(config: ToolFilterConfig): Middleware {
  return async (request: JsonRpcRequest, next: NextFunction): Promise<JsonRpcResponse> => {
    if (!config.readOnly) {
      return next(request);
    }

    // Filter tools/list responses
    if (request.method === "tools/list") {
      const response = await next(request);

      if (response.result && typeof response.result === "object") {
        const result = response.result as Record<string, unknown>;
        const tools = result["tools"] as ToolDefinition[] | undefined;

        if (Array.isArray(tools)) {
          const filteredTools = tools.filter((tool) => {
            const isReadOnly = tool.annotations?.readOnlyHint === true;
            if (!isReadOnly) {
              logger.debug(COMPONENT, `Filtering out non-read-only tool: ${tool.name}`);
            }
            return isReadOnly;
          });

          // Update the allowed tools cache
          allowedTools = new Set(filteredTools.map((t) => t.name));

          logger.info(
            COMPONENT,
            `Filtered tools: ${filteredTools.length}/${tools.length} are read-only`
          );

          return {
            ...response,
            result: {
              ...result,
              tools: filteredTools,
            },
          };
        }
      }

      return response;
    }

    // Block calls to non-read-only tools
    if (request.method === "tools/call") {
      const toolName = (request.params?.["name"] as string) ?? "";

      // If we have a cached allowlist, check it
      if (allowedTools && !allowedTools.has(toolName)) {
        logger.warn(COMPONENT, `Blocked call to non-read-only tool: ${toolName}`);
        return {
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32600,
            message: `Tool "${toolName}" is not available in read-only mode`,
          },
        };
      }
    }

    return next(request);
  };
}
