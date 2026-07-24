/**
 * SigV4 request signing for AWS MCP endpoints.
 *
 * Key design decisions:
 * - Fresh credentials on EVERY request (no caching) — supports SSO token refresh
 * - Removes 'connection' header before signing (AWS rejects it)
 * - Uses @aws-sdk/signature-v4 for standards-compliant signing
 */

import { SignatureV4 } from "@smithy/signature-v4";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { HttpRequest } from "@smithy/protocol-http";
import { Sha256 } from "@aws-crypto/sha256-js";
import type { AwsCredentialIdentity, Provider } from "@smithy/types";
import { logger } from "./logging.js";

const COMPONENT = "sigv4";

/**
 * Headers to remove before signing (AWS SigV4 rejects certain headers).
 */
const HEADERS_TO_REMOVE_BEFORE_SIGNING = ["connection"];

export interface SigningConfig {
  service: string;
  region: string;
  profile?: string;
}

/**
 * Create a fresh credential provider for a given profile.
 * Returns a new provider each time — credentials are resolved fresh per request.
 */
function createCredentialProvider(profile?: string): Provider<AwsCredentialIdentity> {
  return fromNodeProviderChain({
    profile: profile || undefined,
    // Don't cache — we want fresh credentials every time
  });
}

/**
 * Sign an HTTP request using AWS SigV4.
 *
 * Flow:
 * 1. Create fresh credential provider (no caching)
 * 2. Resolve credentials from the provider chain
 * 3. Remove prohibited headers (connection)
 * 4. Construct HttpRequest from URL and options
 * 5. Sign with SignatureV4
 * 6. Return signed headers
 */
export async function signRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  config: SigningConfig
): Promise<Record<string, string>> {
  const { service, region, profile } = config;

  logger.debug(COMPONENT, `Signing request: ${method} ${url} (service=${service}, region=${region}, profile=${profile ?? "default"})`);

  // Step 1: Get fresh credentials
  const credentialProvider = createCredentialProvider(profile);
  let credentials: AwsCredentialIdentity;
  try {
    credentials = await credentialProvider();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(COMPONENT, `Failed to resolve credentials: ${message}`);
    throw new Error(
      `Failed to resolve AWS credentials${profile ? ` for profile "${profile}"` : ""}: ${message}. ` +
      "Ensure your credentials are configured (aws configure, SSO login, or env vars)."
    );
  }

  // Step 2: Parse URL and prepare headers
  const parsedUrl = new URL(url);
  const cleanHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!HEADERS_TO_REMOVE_BEFORE_SIGNING.includes(key.toLowerCase())) {
      cleanHeaders[key] = value;
    }
  }

  // Step 3: Construct HttpRequest for signing
  const request = new HttpRequest({
    method: method.toUpperCase(),
    protocol: parsedUrl.protocol,
    hostname: parsedUrl.hostname,
    port: parsedUrl.port ? Number(parsedUrl.port) : undefined,
    path: parsedUrl.pathname + parsedUrl.search,
    headers: {
      ...cleanHeaders,
      host: parsedUrl.host,
    },
    body: body ?? undefined,
  });

  // Step 4: Sign with SigV4
  const signer = new SignatureV4({
    service,
    region,
    credentials,
    sha256: Sha256,
  });

  const signedRequest = await signer.sign(request);

  logger.debug(COMPONENT, `Request signed successfully (service=${service}, region=${region})`);

  // Return only the headers (the signed headers are what callers need)
  return signedRequest.headers as Record<string, string>;
}

/**
 * Check if an HTTP response indicates a credentials error.
 * Returns a user-friendly error message if so, undefined otherwise.
 */
export function checkCredentialError(
  statusCode: number,
  responseBody?: string
): string | undefined {
  if (statusCode === 401 || statusCode === 403) {
    const hint = responseBody?.includes("expired")
      ? "Your credentials may have expired. Try running 'aws sso login' or refreshing your credentials."
      : "Check your AWS credentials and ensure you have permission to access this endpoint.";

    return `AWS returned ${statusCode} (${statusCode === 401 ? "Unauthorized" : "Forbidden"}). ${hint}`;
  }
  return undefined;
}
