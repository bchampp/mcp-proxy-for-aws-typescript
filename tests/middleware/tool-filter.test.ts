import { describe, it, expect } from "vitest";
import { createToolFilterMiddleware } from "../../src/middleware/tool-filter.js";
import type { JsonRpcRequest, JsonRpcResponse } from "../../src/middleware/index.js";

describe("ToolFilterMiddleware", () => {
  const mockToolsListResponse: JsonRpcResponse = {
    jsonrpc: "2.0",
    id: 1,
    result: {
      tools: [
        {
          name: "read_resource",
          description: "Read a resource",
          annotations: { readOnlyHint: true },
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "write_resource",
          description: "Write a resource",
          annotations: { readOnlyHint: false },
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "delete_resource",
          description: "Delete a resource",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    },
  };

  it("passes through all tools when readOnly is false", async () => {
    const middleware = createToolFilterMiddleware({ readOnly: false });
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    };

    const next = async () => mockToolsListResponse;
    const response = await middleware(request, next);

    const result = response.result as Record<string, unknown>;
    const tools = result["tools"] as Array<{ name: string }>;
    expect(tools).toHaveLength(3);
  });

  it("filters to read-only tools when enabled", async () => {
    const middleware = createToolFilterMiddleware({ readOnly: true });
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    };

    const next = async () => mockToolsListResponse;
    const response = await middleware(request, next);

    const result = response.result as Record<string, unknown>;
    const tools = result["tools"] as Array<{ name: string }>;
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("read_resource");
  });

  it("blocks calls to non-read-only tools", async () => {
    const middleware = createToolFilterMiddleware({ readOnly: true });

    // First, populate the allowlist by calling tools/list
    const listRequest: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    };
    await middleware(listRequest, async () => mockToolsListResponse);

    // Now try calling a filtered-out tool
    const callRequest: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "write_resource", arguments: {} },
    };

    const next = async (): Promise<JsonRpcResponse> => ({
      jsonrpc: "2.0",
      id: 2,
      result: { content: [{ type: "text", text: "done" }] },
    });

    const response = await middleware(callRequest, next);
    expect(response.error).toBeDefined();
    expect(response.error?.message).toContain("not available in read-only mode");
  });

  it("allows calls to read-only tools", async () => {
    const middleware = createToolFilterMiddleware({ readOnly: true });

    // Populate allowlist
    const listRequest: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    };
    await middleware(listRequest, async () => mockToolsListResponse);

    // Call an allowed tool
    const callRequest: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "read_resource", arguments: {} },
    };

    const expectedResponse: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: 3,
      result: { content: [{ type: "text", text: "resource data" }] },
    };

    const next = async () => expectedResponse;
    const response = await middleware(callRequest, next);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual(expectedResponse.result);
  });

  it("passes through non-tool methods unchanged", async () => {
    const middleware = createToolFilterMiddleware({ readOnly: true });
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    };

    const expectedResponse: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: { capabilities: {} },
    };

    const next = async () => expectedResponse;
    const response = await middleware(request, next);
    expect(response).toEqual(expectedResponse);
  });
});
