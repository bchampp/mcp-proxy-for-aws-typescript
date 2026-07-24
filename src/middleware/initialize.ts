/**
 * Initialize middleware — intercepts MCP initialize requests.
 *
 * Adds proxy identification to the client info sent to the server,
 * ensuring the upstream knows it's communicating through this proxy.
 */

import type { Middleware, JsonRpcRequest, JsonRpcResponse, NextFunction } from "./index.js";
import { logger } from "../logging.js";

const COMPONENT = "middleware:initialize";

const PROXY_INFO = {
  name: "mcp-proxy-for-aws",
  version: "1.0.0",
};

export function createInitializeMiddleware(): Middleware {
  return async (request: JsonRpcRequest, next: NextFunction): Promise<JsonRpcResponse> => {
    if (request.method !== "initialize") {
      return next(request);
    }

    logger.info(COMPONENT, "Intercepting initialize request");

    // Add proxy info to client capabilities
    const params = request.params ?? {};
    const clientInfo = (params["clientInfo"] as Record<string, unknown>) ?? {};

    const modifiedRequest: JsonRpcRequest = {
      ...request,
      params: {
        ...params,
        clientInfo: {
          ...clientInfo,
          // Preserve original client info but add proxy metadata
          _proxy: PROXY_INFO,
        },
      },
    };

    const response = await next(modifiedRequest);

    logger.info(COMPONENT, "Initialize complete");
    return response;
  };
}
