/**
 * Utility functions for endpoint URL parsing and service/region inference.
 *
 * Supports these URL patterns:
 * - *.bedrock-agentcore.<region>.amazonaws.com → service=bedrock-agentcore
 * - <service>.<region>.api.aws → service and region from URL
 * - *.lambda-url.<region>.on.aws → service=lambda
 * - *.<service>.<region>.amazonaws.com → service and region from URL
 */

export interface EndpointInfo {
  service: string | undefined;
  region: string | undefined;
}

/**
 * Parse an AWS endpoint URL to extract service name and region.
 * Returns undefined for fields that cannot be inferred.
 */
export function parseEndpointUrl(url: string): EndpointInfo {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return { service: undefined, region: undefined };
  }

  // Pattern: *.bedrock-agentcore.<region>.amazonaws.com
  const bedrockAgentcoreMatch = hostname.match(
    /\.bedrock-agentcore\.([a-z0-9-]+)\.amazonaws\.com$/
  );
  if (bedrockAgentcoreMatch) {
    return { service: "bedrock-agentcore", region: bedrockAgentcoreMatch[1] };
  }

  // Pattern: <service>.<region>.api.aws
  const apiAwsMatch = hostname.match(/^([a-z0-9-]+)\.([a-z0-9-]+)\.api\.aws$/);
  if (apiAwsMatch) {
    return { service: apiAwsMatch[1], region: apiAwsMatch[2] };
  }

  // Pattern: *.lambda-url.<region>.on.aws
  const lambdaUrlMatch = hostname.match(/\.lambda-url\.([a-z0-9-]+)\.on\.aws$/);
  if (lambdaUrlMatch) {
    return { service: "lambda", region: lambdaUrlMatch[1] };
  }

  // Pattern: *.<service>.<region>.amazonaws.com
  const generalAwsMatch = hostname.match(/\.([a-z0-9-]+)\.([a-z0-9-]+)\.amazonaws\.com$/);
  if (generalAwsMatch) {
    return { service: generalAwsMatch[1], region: generalAwsMatch[2] };
  }

  // Pattern: <service>.<region>.amazonaws.com (no subdomain)
  const directAwsMatch = hostname.match(/^([a-z0-9-]+)\.([a-z0-9-]+)\.amazonaws\.com$/);
  if (directAwsMatch) {
    return { service: directAwsMatch[1], region: directAwsMatch[2] };
  }

  return { service: undefined, region: undefined };
}

/**
 * Resolve the effective service name from CLI args, URL inference, and env vars.
 */
export function resolveService(
  cliService: string | undefined,
  endpointUrl: string
): string {
  if (cliService) return cliService;

  const parsed = parseEndpointUrl(endpointUrl);
  if (parsed.service) return parsed.service;

  return "execute-api"; // Safe default for generic API Gateway endpoints
}

/**
 * Resolve the effective region from CLI args, URL inference, and env vars.
 */
export function resolveRegion(
  cliRegion: string | undefined,
  endpointUrl: string
): string {
  if (cliRegion) return cliRegion;

  const parsed = parseEndpointUrl(endpointUrl);
  if (parsed.region) return parsed.region;

  const envRegion = process.env["AWS_REGION"] ?? process.env["AWS_DEFAULT_REGION"];
  if (envRegion) return envRegion;

  return "us-east-1"; // Ultimate fallback
}

/**
 * Resolve AWS profiles from env vars and CLI args.
 * AWS_MCP_PROXY_PROFILES env var takes precedence over --profile CLI args.
 */
export function resolveProfiles(cliProfiles: string[]): string[] {
  const envProfiles = process.env["AWS_MCP_PROXY_PROFILES"];
  if (envProfiles) {
    return envProfiles.split(/\s+/).filter((p) => p.length > 0);
  }

  if (cliProfiles.length > 0) {
    return cliProfiles;
  }

  const defaultProfile = process.env["AWS_PROFILE"];
  if (defaultProfile) {
    return [defaultProfile];
  }

  return []; // Empty means use default credential chain
}

/**
 * Parse metadata key=value pairs from CLI arguments.
 */
export function parseMetadata(pairs: string[]): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const pair of pairs) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx === -1) {
      throw new Error(`Invalid metadata format: "${pair}" (expected key=value)`);
    }
    const key = pair.slice(0, eqIdx);
    const value = pair.slice(eqIdx + 1);
    metadata[key] = value;
  }
  return metadata;
}

/** Tool names that require AWS authentication and support profile switching */
export const AUTH_REQUIRING_TOOLS = new Set([
  "aws___call_aws",
  "aws___run_script",
  "aws___get_presigned_url",
  "aws___get_tasks",
  "aws___suggest_aws_commands",
]);

/**
 * Check if a tool name requires AWS authentication.
 */
export function isAuthRequiringTool(toolName: string): boolean {
  return AUTH_REQUIRING_TOOLS.has(toolName);
}
