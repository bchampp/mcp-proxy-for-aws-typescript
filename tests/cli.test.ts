import { describe, it, expect } from "vitest";
import { createCli } from "../src/cli.js";

describe("CLI", () => {
  it("creates a command with expected options", () => {
    const program = createCli();
    expect(program.name()).toBe("mcp-proxy-for-aws");
  });

  it("has the endpoint argument", () => {
    const program = createCli();
    // Commander stores arguments in _args
    const args = program.registeredArguments;
    expect(args.length).toBe(1);
    expect(args[0]?.name()).toBe("endpoint");
    expect(args[0]?.required).toBe(true);
  });

  it("has all expected options", () => {
    const program = createCli();
    const optionNames = program.options.map((o) => o.long);
    expect(optionNames).toContain("--service");
    expect(optionNames).toContain("--profile");
    expect(optionNames).toContain("--region");
    expect(optionNames).toContain("--metadata");
    expect(optionNames).toContain("--read-only");
    expect(optionNames).toContain("--retries");
    expect(optionNames).toContain("--log-level");
    expect(optionNames).toContain("--timeout");
    expect(optionNames).toContain("--connect-timeout");
    expect(optionNames).toContain("--read-timeout");
    expect(optionNames).toContain("--write-timeout");
    expect(optionNames).toContain("--tool-timeout");
    expect(optionNames).toContain("--disable-telemetry");
    expect(optionNames).toContain("--skip-auth");
  });

  it("has correct default values", () => {
    const program = createCli();
    const retriesOpt = program.options.find((o) => o.long === "--retries");
    expect(retriesOpt?.defaultValue).toBe(0);

    const logLevelOpt = program.options.find((o) => o.long === "--log-level");
    expect(logLevelOpt?.defaultValue).toBe("ERROR");

    const timeoutOpt = program.options.find((o) => o.long === "--timeout");
    expect(timeoutOpt?.defaultValue).toBe("180");

    const toolTimeoutOpt = program.options.find((o) => o.long === "--tool-timeout");
    expect(toolTimeoutOpt?.defaultValue).toBe("300");
  });
});
