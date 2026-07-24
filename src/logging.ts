/**
 * Logging configuration for MCP Proxy for AWS.
 * All logs go to stderr only (stdout is reserved for MCP JSON-RPC).
 * Sensitive headers (Authorization, X-Amz-Security-Token) are redacted.
 */

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LOG_LEVELS: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

/** Headers whose values should be redacted in log output */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "x-amz-security-token",
  "x-amz-content-sha256",
]);

let currentLevel: LogLevel = "ERROR";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function formatMessage(level: LogLevel, component: string, message: string): string {
  const timestamp = new Date().toISOString();
  return `[${timestamp}] [${level}] [${component}] ${message}`;
}

export function debug(component: string, message: string): void {
  if (shouldLog("DEBUG")) {
    process.stderr.write(formatMessage("DEBUG", component, message) + "\n");
  }
}

export function info(component: string, message: string): void {
  if (shouldLog("INFO")) {
    process.stderr.write(formatMessage("INFO", component, message) + "\n");
  }
}

export function warn(component: string, message: string): void {
  if (shouldLog("WARN")) {
    process.stderr.write(formatMessage("WARN", component, message) + "\n");
  }
}

export function error(component: string, message: string): void {
  if (shouldLog("ERROR")) {
    process.stderr.write(formatMessage("ERROR", component, message) + "\n");
  }
}

/**
 * Redact sensitive header values for safe logging.
 * Returns a new object with sensitive values replaced by "[REDACTED]".
 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
      redacted[key] = "[REDACTED]";
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

export const logger = { debug, info, warn, error, redactHeaders };
