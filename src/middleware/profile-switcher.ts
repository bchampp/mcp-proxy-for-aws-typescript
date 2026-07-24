/**
 * Profile switcher middleware — routes tool calls to the correct AWS profile.
 *
 * When multiple profiles are configured:
 * - Injects an `aws_profile` enum into auth-requiring tool schemas
 * - Extracts the selected profile from tool call arguments
 * - Routes the call to the appropriate profile's client
 *
 * Auth-requiring tools: aws___call_aws, aws___run_script, aws___get_presigned_url,
 * aws___get_tasks, aws___suggest_aws_commands
 */

import type { Middleware, JsonRpcRequest, JsonRpcResponse, NextFunction } from "./index.js";
import { isAuthRequiringTool } from "../utils.js";
import { logger } from "../logging.js";

const COMPONENT = "middleware:profile-switcher";

export interface ProfileSwitcherConfig {
  /** Available AWS profiles */
  profiles: string[];
  /** Callback to get or create a client for a specific profile */
  getProfileClient: (profile: string) => NextFunction;
}

interface ToolDefinition {
  name: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Creates the aws_profile property definition for injection into tool schemas.
 */
function createProfileProperty(profiles: string[]): Record<string, unknown> {
  return {
    type: "string",
    enum: profiles,
    description: "AWS profile to use for this request. Select from configured profiles.",
    default: profiles[0],
  };
}

export function createProfileSwitcherMiddleware(config: ProfileSwitcherConfig): Middleware {
  const { profiles, getProfileClient } = config;

  // No-op if there's 0 or 1 profile
  if (profiles.length <= 1) {
    return async (request: JsonRpcRequest, next: NextFunction): Promise<JsonRpcResponse> => {
      return next(request);
    };
  }

  return async (request: JsonRpcRequest, next: NextFunction): Promise<JsonRpcResponse> => {
    // Inject aws_profile enum into tools/list response schemas
    if (request.method === "tools/list") {
      const response = await next(request);

      if (response.result && typeof response.result === "object") {
        const result = response.result as Record<string, unknown>;
        const tools = result["tools"] as ToolDefinition[] | undefined;

        if (Array.isArray(tools)) {
          const modifiedTools = tools.map((tool) => {
            if (!isAuthRequiringTool(tool.name)) return tool;

            // Inject aws_profile into the input schema
            const schema = tool.inputSchema ?? { type: "object", properties: {} };
            const properties = (schema as Record<string, unknown>)["properties"] as Record<string, unknown> ?? {};

            return {
              ...tool,
              inputSchema: {
                ...schema,
                properties: {
                  ...properties,
                  aws_profile: createProfileProperty(profiles),
                },
              },
            };
          });

          return {
            ...response,
            result: {
              ...result,
              tools: modifiedTools,
            },
          };
        }
      }

      return response;
    }

    // Route tool calls to the correct profile's client
    if (request.method === "tools/call") {
      const toolName = (request.params?.["name"] as string) ?? "";

      if (isAuthRequiringTool(toolName)) {
        const args = (request.params?.["arguments"] as Record<string, unknown>) ?? {};
        const selectedProfile = (args["aws_profile"] as string) ?? profiles[0]!;

        logger.debug(COMPONENT, `Routing tool "${toolName}" to profile: ${selectedProfile}`);

        // Remove aws_profile from args before forwarding
        const { aws_profile: _, ...cleanArgs } = args;
        const modifiedRequest: JsonRpcRequest = {
          ...request,
          params: {
            ...request.params,
            arguments: cleanArgs,
          },
        };

        // Route to profile-specific client
        const profileClient = getProfileClient(selectedProfile);
        return profileClient(modifiedRequest);
      }
    }

    return next(request);
  };
}
