import { describe, it, expect } from "vitest";
import {
  parseEndpointUrl,
  resolveService,
  resolveRegion,
  resolveProfiles,
  parseMetadata,
  isAuthRequiringTool,
} from "../src/utils.js";

describe("parseEndpointUrl", () => {
  it("parses bedrock-agentcore URLs", () => {
    const result = parseEndpointUrl(
      "https://mcp.bedrock-agentcore.us-east-1.amazonaws.com/agents/abc123"
    );
    expect(result.service).toBe("bedrock-agentcore");
    expect(result.region).toBe("us-east-1");
  });

  it("parses api.aws URLs", () => {
    const result = parseEndpointUrl("https://bedrock.us-west-2.api.aws/mcp");
    expect(result.service).toBe("bedrock");
    expect(result.region).toBe("us-west-2");
  });

  it("parses lambda-url URLs", () => {
    const result = parseEndpointUrl(
      "https://abc123.lambda-url.eu-west-1.on.aws/mcp"
    );
    expect(result.service).toBe("lambda");
    expect(result.region).toBe("eu-west-1");
  });

  it("parses general amazonaws.com URLs", () => {
    const result = parseEndpointUrl(
      "https://my-api.execute-api.ap-southeast-1.amazonaws.com/prod"
    );
    expect(result.service).toBe("execute-api");
    expect(result.region).toBe("ap-southeast-1");
  });

  it("parses direct service.region.amazonaws.com URLs", () => {
    const result = parseEndpointUrl(
      "https://execute-api.us-east-1.amazonaws.com/endpoint"
    );
    expect(result.service).toBe("execute-api");
    expect(result.region).toBe("us-east-1");
  });

  it("returns undefined for unrecognized patterns", () => {
    const result = parseEndpointUrl("https://example.com/api");
    expect(result.service).toBeUndefined();
    expect(result.region).toBeUndefined();
  });

  it("handles invalid URLs gracefully", () => {
    const result = parseEndpointUrl("not-a-url");
    expect(result.service).toBeUndefined();
    expect(result.region).toBeUndefined();
  });
});

describe("resolveService", () => {
  it("uses CLI argument when provided", () => {
    expect(resolveService("custom-service", "https://example.com")).toBe(
      "custom-service"
    );
  });

  it("infers from URL when no CLI arg", () => {
    expect(
      resolveService(
        undefined,
        "https://mcp.bedrock-agentcore.us-east-1.amazonaws.com"
      )
    ).toBe("bedrock-agentcore");
  });

  it("falls back to execute-api for unrecognized URLs", () => {
    expect(resolveService(undefined, "https://example.com/api")).toBe(
      "execute-api"
    );
  });
});

describe("resolveRegion", () => {
  it("uses CLI argument when provided", () => {
    expect(resolveRegion("eu-west-1", "https://example.com")).toBe("eu-west-1");
  });

  it("infers from URL when no CLI arg", () => {
    expect(
      resolveRegion(
        undefined,
        "https://mcp.bedrock-agentcore.us-west-2.amazonaws.com"
      )
    ).toBe("us-west-2");
  });

  it("uses AWS_REGION env var as fallback", () => {
    const originalRegion = process.env["AWS_REGION"];
    process.env["AWS_REGION"] = "ap-northeast-1";
    try {
      expect(resolveRegion(undefined, "https://example.com")).toBe(
        "ap-northeast-1"
      );
    } finally {
      if (originalRegion !== undefined) {
        process.env["AWS_REGION"] = originalRegion;
      } else {
        delete process.env["AWS_REGION"];
      }
    }
  });

  it("uses AWS_DEFAULT_REGION when AWS_REGION is not set", () => {
    const originalRegion = process.env["AWS_REGION"];
    const originalDefaultRegion = process.env["AWS_DEFAULT_REGION"];
    delete process.env["AWS_REGION"];
    process.env["AWS_DEFAULT_REGION"] = "sa-east-1";
    try {
      expect(resolveRegion(undefined, "https://example.com")).toBe("sa-east-1");
    } finally {
      if (originalRegion !== undefined) {
        process.env["AWS_REGION"] = originalRegion;
      }
      if (originalDefaultRegion !== undefined) {
        process.env["AWS_DEFAULT_REGION"] = originalDefaultRegion;
      } else {
        delete process.env["AWS_DEFAULT_REGION"];
      }
    }
  });
});

describe("resolveProfiles", () => {
  it("returns empty array when no profiles configured", () => {
    const originalEnv = process.env["AWS_MCP_PROXY_PROFILES"];
    const originalProfile = process.env["AWS_PROFILE"];
    delete process.env["AWS_MCP_PROXY_PROFILES"];
    delete process.env["AWS_PROFILE"];
    try {
      expect(resolveProfiles([])).toEqual([]);
    } finally {
      if (originalEnv !== undefined) process.env["AWS_MCP_PROXY_PROFILES"] = originalEnv;
      if (originalProfile !== undefined) process.env["AWS_PROFILE"] = originalProfile;
    }
  });

  it("uses CLI profiles when provided", () => {
    const originalEnv = process.env["AWS_MCP_PROXY_PROFILES"];
    delete process.env["AWS_MCP_PROXY_PROFILES"];
    try {
      expect(resolveProfiles(["dev", "prod"])).toEqual(["dev", "prod"]);
    } finally {
      if (originalEnv !== undefined) process.env["AWS_MCP_PROXY_PROFILES"] = originalEnv;
    }
  });

  it("env var AWS_MCP_PROXY_PROFILES takes precedence over CLI", () => {
    const originalEnv = process.env["AWS_MCP_PROXY_PROFILES"];
    process.env["AWS_MCP_PROXY_PROFILES"] = "env-profile-1 env-profile-2";
    try {
      expect(resolveProfiles(["cli-profile"])).toEqual([
        "env-profile-1",
        "env-profile-2",
      ]);
    } finally {
      if (originalEnv !== undefined) {
        process.env["AWS_MCP_PROXY_PROFILES"] = originalEnv;
      } else {
        delete process.env["AWS_MCP_PROXY_PROFILES"];
      }
    }
  });

  it("uses AWS_PROFILE when no CLI args or env var", () => {
    const originalEnv = process.env["AWS_MCP_PROXY_PROFILES"];
    const originalProfile = process.env["AWS_PROFILE"];
    delete process.env["AWS_MCP_PROXY_PROFILES"];
    process.env["AWS_PROFILE"] = "my-profile";
    try {
      expect(resolveProfiles([])).toEqual(["my-profile"]);
    } finally {
      if (originalEnv !== undefined) process.env["AWS_MCP_PROXY_PROFILES"] = originalEnv;
      if (originalProfile !== undefined) {
        process.env["AWS_PROFILE"] = originalProfile;
      } else {
        delete process.env["AWS_PROFILE"];
      }
    }
  });
});

describe("parseMetadata", () => {
  it("parses key=value pairs", () => {
    expect(parseMetadata(["key1=value1", "key2=value2"])).toEqual({
      key1: "value1",
      key2: "value2",
    });
  });

  it("handles values with equals signs", () => {
    expect(parseMetadata(["key=val=ue"])).toEqual({ key: "val=ue" });
  });

  it("throws on invalid format", () => {
    expect(() => parseMetadata(["invalid"])).toThrow("Invalid metadata format");
  });

  it("returns empty object for empty input", () => {
    expect(parseMetadata([])).toEqual({});
  });
});

describe("isAuthRequiringTool", () => {
  it("returns true for known auth-requiring tools", () => {
    expect(isAuthRequiringTool("aws___call_aws")).toBe(true);
    expect(isAuthRequiringTool("aws___run_script")).toBe(true);
    expect(isAuthRequiringTool("aws___get_presigned_url")).toBe(true);
    expect(isAuthRequiringTool("aws___get_tasks")).toBe(true);
    expect(isAuthRequiringTool("aws___suggest_aws_commands")).toBe(true);
  });

  it("returns false for other tools", () => {
    expect(isAuthRequiringTool("some_other_tool")).toBe(false);
    expect(isAuthRequiringTool("")).toBe(false);
  });
});
