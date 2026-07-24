/**
 * mcp-proxy-for-aws — TypeScript implementation
 *
 * A lightweight client-side proxy that bridges MCP clients (Claude Desktop, Kiro CLI)
 * and IAM-secured MCP servers on AWS. Handles SigV4 request signing so standard
 * MCP clients can connect to AWS MCP endpoints that require IAM auth.
 *
 * Primary API: `AwsIamStreamableHTTPClientTransport` — an MCP transport class with
 * SigV4 signing pre-configured. Import and connect:
 *
 * ```typescript
 * import { AwsIamStreamableHTTPClientTransport } from "mcp-proxy-for-aws";
 * import { Client } from "@modelcontextprotocol/sdk/client/index.js";
 *
 * const transport = new AwsIamStreamableHTTPClientTransport({
 *   url: "https://endpoint.bedrock-agentcore.us-east-1.amazonaws.com/mcp",
 *   region: "us-east-1",
 *   service: "bedrock-agentcore",
 * });
 *
 * const client = new Client({ name: "my-app", version: "1.0.0" });
 * await client.connect(transport);
 * ```
 */

// Primary client API — the main way customers use this package
export { AwsIamStreamableHTTPClientTransport } from "./client.js";
export type { AwsIamStreamableHTTPClientTransportOptions } from "./client.js";

// Proxy server (CLI mode)
export { runProxy } from "./server.js";
export { parseCli, createCli } from "./cli.js";
export { AWSMCPProxyClient } from "./proxy.js";
export { AWSMCPTransport } from "./transport.js";
export { signRequest, checkCredentialError } from "./sigv4.js";
export {
  parseEndpointUrl,
  resolveService,
  resolveRegion,
  resolveProfiles,
  parseMetadata,
  isAuthRequiringTool,
  AUTH_REQUIRING_TOOLS,
} from "./utils.js";
export { setLogLevel, logger } from "./logging.js";
export { setProxyConfig, getProxyConfig } from "./context.js";
export type { ProxyConfig } from "./context.js";
export type { SigningConfig } from "./sigv4.js";
export type {
  JsonRpcRequest,
  JsonRpcResponse,
  Middleware,
  NextFunction,
} from "./middleware/index.js";
