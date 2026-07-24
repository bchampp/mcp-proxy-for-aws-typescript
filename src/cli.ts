/**
 * CLI argument parsing for mcp-proxy-for-aws.
 *
 * Flags mirror the Python original:
 * - endpoint (positional, required)
 * - --service, --profile, --region, --metadata
 * - --read-only, --retries, --log-level
 * - --timeout, --connect-timeout, --read-timeout, --write-timeout, --tool-timeout
 * - --disable-telemetry, --skip-auth
 */

import { Command } from "commander";
import type { LogLevel } from "./logging.js";
import { setLogLevel } from "./logging.js";
import { resolveService, resolveRegion, resolveProfiles, parseMetadata } from "./utils.js";
import { runProxy } from "./server.js";
import type { ProxyConfig } from "./context.js";

const VALID_LOG_LEVELS = new Set(["DEBUG", "INFO", "WARN", "ERROR"]);

export function createCli(): Command {
  const program = new Command();

  program
    .name("mcp-proxy-for-aws")
    .description(
      "A lightweight proxy that bridges MCP clients and IAM-secured MCP servers on AWS with SigV4 signing"
    )
    .version("1.0.0")
    .argument("<endpoint>", "AWS MCP endpoint URL (required)")
    .option("--service <service>", "AWS service name (inferred from URL if not provided)")
    .option(
      "--profile <profiles...>",
      "AWS profile(s) to use (space-separated, multiple allowed)"
    )
    .option("--region <region>", "AWS region (inferred from URL or env)")
    .option(
      "--metadata <pairs...>",
      "key=value pairs to inject into _meta"
    )
    .option("--read-only", "filter tools to only readOnlyHint ones", false)
    .option(
      "--retries <count>",
      "number of retries (0-10)",
      (val: string) => {
        const n = parseInt(val, 10);
        if (isNaN(n) || n < 0 || n > 10) {
          throw new Error("--retries must be a number between 0 and 10");
        }
        return n;
      },
      0
    )
    .option(
      "--log-level <level>",
      "logging level (DEBUG, INFO, WARN, ERROR)",
      "ERROR"
    )
    .option("--timeout <seconds>", "overall request timeout", "180")
    .option("--connect-timeout <seconds>", "connection timeout", "60")
    .option("--read-timeout <seconds>", "read timeout", "120")
    .option("--write-timeout <seconds>", "write timeout", "180")
    .option("--tool-timeout <seconds>", "tool call timeout", "300")
    .option("--disable-telemetry", "disable telemetry", false)
    .option("--skip-auth", "skip authentication (for testing)", false)
    .action(async (endpoint: string, options: CliOptions) => {
      await runCli(endpoint, options);
    });

  return program;
}

interface CliOptions {
  service?: string;
  profile?: string[];
  region?: string;
  metadata?: string[];
  readOnly: boolean;
  retries: number;
  logLevel: string;
  timeout: string;
  connectTimeout: string;
  readTimeout: string;
  writeTimeout: string;
  toolTimeout: string;
  disableTelemetry: boolean;
  skipAuth: boolean;
}

async function runCli(endpoint: string, options: CliOptions): Promise<void> {
  // Validate endpoint URL
  try {
    new URL(endpoint);
  } catch {
    process.stderr.write(`Error: Invalid endpoint URL: ${endpoint}\n`);
    process.exit(1);
  }

  // Validate and set log level
  const logLevel = options.logLevel.toUpperCase();
  if (!VALID_LOG_LEVELS.has(logLevel)) {
    process.stderr.write(
      `Error: Invalid log level "${options.logLevel}". Must be one of: DEBUG, INFO, WARN, ERROR\n`
    );
    process.exit(1);
  }
  setLogLevel(logLevel as LogLevel);

  // Resolve configuration from CLI args, URL parsing, and env vars
  const service = resolveService(options.service, endpoint);
  const region = resolveRegion(options.region, endpoint);
  const profiles = resolveProfiles(options.profile ?? []);
  const metadata = parseMetadata(options.metadata ?? []);

  const config: ProxyConfig = {
    endpoint,
    service,
    region,
    profiles,
    metadata,
    readOnly: options.readOnly,
    retries: options.retries,
    timeout: parseFloat(options.timeout),
    connectTimeout: parseFloat(options.connectTimeout),
    readTimeout: parseFloat(options.readTimeout),
    writeTimeout: parseFloat(options.writeTimeout),
    toolTimeout: parseFloat(options.toolTimeout),
    skipAuth: options.skipAuth,
    disableTelemetry: options.disableTelemetry,
  };

  await runProxy(config);
}

export function parseCli(argv?: string[]): void {
  const program = createCli();
  program.parse(argv);
}
