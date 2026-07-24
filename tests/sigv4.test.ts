import { describe, it, expect } from "vitest";
import { checkCredentialError } from "../src/sigv4.js";

describe("checkCredentialError", () => {
  it("returns error message for 401", () => {
    const result = checkCredentialError(401);
    expect(result).toBeDefined();
    expect(result).toContain("401");
    expect(result).toContain("Unauthorized");
  });

  it("returns error message for 403", () => {
    const result = checkCredentialError(403);
    expect(result).toBeDefined();
    expect(result).toContain("403");
    expect(result).toContain("Forbidden");
  });

  it("returns expired hint when response mentions expired", () => {
    const result = checkCredentialError(403, "The security token included in the request is expired");
    expect(result).toContain("expired");
    expect(result).toContain("aws sso login");
  });

  it("returns general hint for non-expired credential errors", () => {
    const result = checkCredentialError(401, "Access Denied");
    expect(result).toContain("Check your AWS credentials");
  });

  it("returns undefined for success status codes", () => {
    expect(checkCredentialError(200)).toBeUndefined();
    expect(checkCredentialError(201)).toBeUndefined();
    expect(checkCredentialError(204)).toBeUndefined();
  });

  it("returns undefined for non-auth error codes", () => {
    expect(checkCredentialError(500)).toBeUndefined();
    expect(checkCredentialError(404)).toBeUndefined();
    expect(checkCredentialError(429)).toBeUndefined();
  });
});
