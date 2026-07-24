/**
 * Primary programmatic API for mcp-proxy-for-aws.
 *
 * Provides a pre-configured MCP transport with AWS SigV4 signing, so consumers
 * can connect to IAM-secured MCP endpoints without managing auth themselves.
 *
 * @example
 * ```typescript
 * import { Client } from "@modelcontextprotocol/sdk/client/index.js";
 * import { AwsIamStreamableHTTPClientTransport } from "mcp-proxy-for-aws";
 *
 * const transport = new AwsIamStreamableHTTPClientTransport({
 *   url: "https://endpoint.bedrock-agentcore.us-east-1.amazonaws.com/mcp",
 *   profile: "my-profile",
 *   region: "us-east-1",
 *   service: "bedrock-agentcore",
 * });
 *
 * const client = new Client({ name: "my-app", version: "1.0.0" });
 * await client.connect(transport);
 * const tools = await client.listTools();
 * ```
 */

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { signRequest, type SigningConfig } from "./sigv4.js";
import { resolveRegion, resolveService } from "./utils.js";

/**
 * Configuration options for {@link AwsIamStreamableHTTPClientTransport}.
 *
 * Only `url` is required — region and service can be auto-detected from the URL.
 */
export interface AwsIamStreamableHTTPClientTransportOptions {
  /** The MCP server endpoint URL (required). */
  url: string;

  /** AWS named profile for credential resolution. Falls back to default chain if omitted. */
  profile?: string;

  /** AWS region for SigV4 signing. Auto-detected from URL if omitted. */
  region?: string;

  /** AWS service name for SigV4 signing. Auto-detected from URL if omitted. */
  service?: string;

  /** Key-value metadata injected into JSON-RPC _meta on every request. */
  metadata?: Record<string, string>;

  /**
   * Overall request timeout in seconds.
   * Applied as an AbortSignal on each fetch call.
   * @default 300
   */
  timeout?: number;

  /**
   * Connection timeout in seconds (reserved for future use).
   * @default 60
   */
  connectTimeout?: number;

  /**
   * Read timeout in seconds (reserved for future use).
   * @default 300
   */
  readTimeout?: number;

  /**
   * Write timeout in seconds (reserved for future use).
   * @default 60
   */
  writeTimeout?: number;

  /**
   * Skip SigV4 signing entirely. Useful for local testing against mock servers.
   * @default false
   */
  skipAuth?: boolean;

  /**
   * Additional headers to include on every request (merged with transport defaults).
   */
  requestHeaders?: Record<string, string>;

  /**
   * Session ID to resume an existing session. When omitted, the server creates a new session.
   */
  sessionId?: string;
}

/**
 * An MCP client transport that adds AWS IAM SigV4 request signing to the
 * standard {@link StreamableHTTPClientTransport}.
 *
 * This is the primary programmatic API for mcp-proxy-for-aws. Instantiate it
 * with your endpoint URL and AWS configuration, then pass it directly to
 * the MCP SDK `Client.connect()` method.
 *
 * Key behaviors:
 * - Injects a custom `fetch` that signs every outgoing request with SigV4
 * - Credentials are resolved fresh on every request (no caching) to support
 *   SSO token refresh and credential rotation
 * - Region and service are auto-detected from the endpoint URL when not specified
 * - Metadata is injected into the JSON-RPC `_meta` field of every request body
 *
 * @example
 * ```typescript
 * import { Client } from "@modelcontextprotocol/sdk/client/index.js";
 * import { AwsIamStreamableHTTPClientTransport } from "mcp-proxy-for-aws";
 *
 * const transport = new AwsIamStreamableHTTPClientTransport({
 *   url: "https://endpoint.bedrock-agentcore.us-east-1.amazonaws.com/mcp",
 *   profile: "my-profile",
 *   region: "us-east-1",
 * });
 *
 * const client = new Client({ name: "my-app", version: "1.0.0" });
 * await client.connect(transport);
 * ```
 */
export class AwsIamStreamableHTTPClientTransport extends StreamableHTTPClientTransport {
  constructor(options: AwsIamStreamableHTTPClientTransportOptions) {
    const {
      url,
      profile,
      region,
      service,
      metadata,
      timeout = 300,
      skipAuth = false,
      requestHeaders,
      sessionId,
    } = options;

    // Resolve region and service from URL if not explicitly provided
    const resolvedRegion = resolveRegion(region, url);
    const resolvedService = resolveService(service, url);

    const signingConfig: SigningConfig = {
      service: resolvedService,
      region: resolvedRegion,
      profile,
    };

    // Build a custom fetch that signs each request with SigV4 before sending.
    // Fresh credentials are resolved on every call — no caching.
    const sigv4Fetch = createSigV4Fetch(signingConfig, {
      skipAuth,
      metadata,
      timeoutSeconds: timeout,
    });

    // Construct the parent transport with our signing fetch and any extra headers
    super(new URL(url), {
      fetch: sigv4Fetch,
      requestInit: requestHeaders ? { headers: requestHeaders } : undefined,
      sessionId,
    });
  }
}

/** Internal options for the SigV4 fetch wrapper */
interface SigV4FetchOptions {
  skipAuth: boolean;
  metadata?: Record<string, string>;
  timeoutSeconds: number;
}

/**
 * Create a fetch function that intercepts requests and applies SigV4 signing.
 *
 * The returned function has the same signature as the global `fetch`, so it can
 * be passed directly to StreamableHTTPClientTransport's `fetch` option.
 *
 * Key behaviors:
 * - Reads the request body to sign it (required for SigV4 payload hash)
 * - Injects metadata into the JSON-RPC _meta field before signing
 * - Applies an AbortSignal timeout to every request
 * - Preserves the original request method, headers, and other options
 */
function createSigV4Fetch(
  signingConfig: SigningConfig,
  options: SigV4FetchOptions
): (url: string | URL, init?: RequestInit) => Promise<Response> {
  const { skipAuth, metadata, timeoutSeconds } = options;

  return async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = url.toString();
    const method = init?.method ?? "GET";

    // Extract existing headers from the request
    const existingHeaders: Record<string, string> = {};
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((value, key) => {
          existingHeaders[key] = value;
        });
      } else if (Array.isArray(init.headers)) {
        for (const pair of init.headers) {
          const [key, value] = pair as [string, string];
          existingHeaders[key] = value;
        }
      } else {
        Object.assign(existingHeaders, init.headers);
      }
    }

    // Read the body — we need it as a string for signing and metadata injection
    let bodyStr: string | undefined;
    if (init?.body != null) {
      if (typeof init.body === "string") {
        bodyStr = init.body;
      } else if (init.body instanceof ArrayBuffer) {
        bodyStr = new TextDecoder().decode(init.body);
      } else if (ArrayBuffer.isView(init.body)) {
        bodyStr = new TextDecoder().decode(init.body);
      } else {
        // ReadableStream or other — convert to string
        const response = new Response(init.body);
        bodyStr = await response.text();
      }
    }

    // Inject metadata into the JSON-RPC body's _meta field (if applicable)
    if (bodyStr && metadata && Object.keys(metadata).length > 0) {
      bodyStr = injectMetadataIntoBody(bodyStr, metadata);
    }

    // Apply SigV4 signing to get authorized headers
    let finalHeaders: Record<string, string>;
    if (skipAuth) {
      finalHeaders = { ...existingHeaders };
    } else {
      finalHeaders = await signRequest(
        urlStr,
        method,
        existingHeaders,
        bodyStr,
        signingConfig
      );
    }

    // Set up timeout via AbortSignal
    const controller = new AbortController();
    const timeoutMs = timeoutSeconds * 1000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    // Compose abort signals: respect caller's signal AND our timeout
    const callerSignal = init?.signal;

    if (callerSignal?.aborted) {
      clearTimeout(timeoutId);
      controller.abort(callerSignal.reason);
    } else {
      callerSignal?.addEventListener("abort", () => {
        clearTimeout(timeoutId);
        controller.abort(callerSignal.reason);
      });
    }

    try {
      const response = await fetch(urlStr, {
        ...init,
        method,
        headers: finalHeaders,
        body: bodyStr,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      return response;
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === "AbortError" && !callerSignal?.aborted) {
        throw new Error(`Request to ${urlStr} timed out after ${timeoutSeconds}s`);
      }
      throw err;
    }
  };
}

/**
 * Inject metadata into a JSON-RPC request body's params._meta field.
 * Handles both single requests and batched request arrays.
 * If the body isn't valid JSON or doesn't have params, returns it unchanged.
 */
function injectMetadataIntoBody(
  bodyStr: string,
  metadata: Record<string, string>
): string {
  try {
    const parsed: unknown = JSON.parse(bodyStr);

    if (Array.isArray(parsed)) {
      // Batch request — inject metadata into each element
      const injected = parsed.map((item) => injectMetadataIntoMessage(item, metadata));
      return JSON.stringify(injected);
    }

    // Single request
    return JSON.stringify(injectMetadataIntoMessage(parsed, metadata));
  } catch {
    // Not valid JSON — return unchanged (e.g., SSE reconnection or non-JSON body)
    return bodyStr;
  }
}

/**
 * Inject metadata into a single JSON-RPC message's params._meta field.
 * Merges with existing _meta without overwriting caller-set values.
 */
function injectMetadataIntoMessage(
  message: unknown,
  metadata: Record<string, string>
): unknown {
  if (typeof message !== "object" || message === null) {
    return message;
  }

  const msg = message as Record<string, unknown>;

  // Only inject if this is a request with params (not a response/notification without params)
  if (!("params" in msg) || typeof msg["params"] !== "object" || msg["params"] === null) {
    return message;
  }

  const params = msg["params"] as Record<string, unknown>;
  const existingMeta = (params["_meta"] as Record<string, unknown>) ?? {};

  return {
    ...msg,
    params: {
      ...params,
      _meta: {
        ...existingMeta,
        ...metadata,
      },
    },
  };
}
