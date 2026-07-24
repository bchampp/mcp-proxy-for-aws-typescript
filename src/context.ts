/**
 * Global client information store.
 * Holds proxy configuration that needs to be accessible across modules.
 */

export interface ProxyConfig {
  /** The upstream AWS MCP endpoint URL */
  endpoint: string;
  /** Resolved AWS service name */
  service: string;
  /** Resolved AWS region */
  region: string;
  /** AWS profiles to use (empty = default chain) */
  profiles: string[];
  /** Metadata to inject into _meta */
  metadata: Record<string, string>;
  /** Whether to filter to read-only tools */
  readOnly: boolean;
  /** Number of retries on failure */
  retries: number;
  /** Overall request timeout in seconds */
  timeout: number;
  /** Connection timeout in seconds */
  connectTimeout: number;
  /** Read timeout in seconds */
  readTimeout: number;
  /** Write timeout in seconds */
  writeTimeout: number;
  /** Tool call timeout in seconds */
  toolTimeout: number;
  /** Whether to skip authentication (testing) */
  skipAuth: boolean;
  /** Whether telemetry is disabled */
  disableTelemetry: boolean;
}

/** Singleton proxy config — set once at startup */
let proxyConfig: ProxyConfig | undefined;

export function setProxyConfig(config: ProxyConfig): void {
  proxyConfig = config;
}

export function getProxyConfig(): ProxyConfig {
  if (!proxyConfig) {
    throw new Error("Proxy config not initialized. Call setProxyConfig() first.");
  }
  return proxyConfig;
}
