/**
 * Middleware chain for processing MCP JSON-RPC messages.
 *
 * Middleware chain order: Initialize → ToolError → Logging → ToolFilter → ProfileSwitcher → Retry
 *
 * Each middleware can:
 * - Transform the request before forwarding
 * - Transform the response before returning
 * - Short-circuit the chain by returning early (without calling next)
 */

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type NextFunction = (request: JsonRpcRequest) => Promise<JsonRpcResponse>;

export type Middleware = (
  request: JsonRpcRequest,
  next: NextFunction
) => Promise<JsonRpcResponse>;

/**
 * Compose a series of middleware functions into a single handler.
 * The last middleware in the chain must call next() to reach the transport.
 */
export function composeMiddleware(
  middlewares: Middleware[],
  transport: NextFunction
): NextFunction {
  let handler = transport;

  // Apply middleware in reverse order so the first middleware in the array
  // is the outermost (first to see requests, last to see responses)
  for (let i = middlewares.length - 1; i >= 0; i--) {
    const mw = middlewares[i]!;
    const nextHandler = handler;
    handler = (request: JsonRpcRequest) => mw(request, nextHandler);
  }

  return handler;
}

export { createInitializeMiddleware } from "./initialize.js";
export { createToolErrorMiddleware } from "./tool-error.js";
export { createToolFilterMiddleware } from "./tool-filter.js";
export { createProfileSwitcherMiddleware } from "./profile-switcher.js";
