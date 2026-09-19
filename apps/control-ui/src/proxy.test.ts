import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

afterEach(() => vi.unstubAllEnvs());

function forwarded(response: Response, name: string): string | null {
  return response.headers.get(`x-middleware-request-${name}`);
}

describe("control UI edge authentication", () => {
  it("overwrites spoofed delegated identity with the authenticated local principal", async () => {
    vi.stubEnv("PLATFORM_MODE", "local");
    vi.stubEnv("CONTROL_UI_LOCAL_AUTOLOGIN", "true");
    vi.stubEnv("CONTROL_UI_ACTOR_ID", "verified-author");
    vi.stubEnv("CONTROL_UI_ACTOR_ROLES", "Harness.Reader,Harness.Author");
    const request = new NextRequest("http://localhost/v1/runs", {
      headers: { "x-ehf-authenticated-subject": "attacker", "x-ehf-authenticated-roles": "Harness.Approver" },
    });
    const response = await proxy(request);
    expect(response.status).toBe(200);
    expect(forwarded(response, "x-ehf-authenticated-subject")).toBe("verified-author");
    expect(forwarded(response, "x-ehf-authenticated-roles")).toBe("Harness.Reader,Harness.Author");
  });

  it("uses an independent approver only for the explicit local demo approval route", async () => {
    vi.stubEnv("PLATFORM_MODE", "local");
    vi.stubEnv("CONTROL_UI_LOCAL_AUTOLOGIN", "true");
    vi.stubEnv("CONTROL_UI_LOCAL_AUTOMATED_APPROVAL", "true");
    vi.stubEnv("CONTROL_UI_APPROVER_ID", "verified-approver");
    const response = await proxy(new NextRequest("http://localhost/v1/authoring/drafts/draft_1/approve"));
    expect(forwarded(response, "x-ehf-authenticated-subject")).toBe("verified-approver");
    expect(forwarded(response, "x-ehf-authenticated-roles")).toContain("Harness.Approver");
  });

  it("rejects an unauthenticated request when local autologin is disabled", async () => {
    vi.stubEnv("PLATFORM_MODE", "local");
    vi.stubEnv("CONTROL_UI_LOCAL_AUTOLOGIN", "false");
    const response = await proxy(new NextRequest("http://localhost/v1/runs"));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "authorization.principal_unauthenticated" });
  });
});
