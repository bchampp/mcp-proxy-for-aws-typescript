#!/usr/bin/env node
/**
 * CLI entry point for mcp-proxy-for-aws.
 *
 * Usage:
 *   mcp-proxy-for-aws <endpoint> [options]
 *
 * Example:
 *   mcp-proxy-for-aws https://mcp.bedrock-agentcore.us-east-1.amazonaws.com \
 *     --profile my-profile \
 *     --log-level INFO
 */

import { parseCli } from "../cli.js";

parseCli();
