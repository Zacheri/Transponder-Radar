import { describe, it, expect } from "vitest";
import { createTokenProvider } from "../server/opensky-auth.js";

function tokenResponse(token = "tok123", expiresIn = 1800) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ access_token: token, expires_in: expiresIn, token_type: "Bearer" }),
  };
}

describe("createTokenProvider", () => {
  it("fetches a token and caches it until near expiry", async () => {
    let calls = 0;
    let lastBody: URLSearchParams | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      calls += 1;
      lastBody = init?.body as URLSearchParams;
      return tokenResponse();
    }) as unknown as typeof fetch;
    const p = createTokenProvider({ clientId: "id", clientSecret: "sec", fetchImpl });
    expect(await p.getToken()).toBe("tok123");
    expect(await p.getToken()).toBe("tok123");
    expect(calls).toBe(1);
    expect(lastBody?.get("grant_type")).toBe("client_credentials");
    expect(lastBody?.get("client_id")).toBe("id");
    expect(lastBody?.get("client_secret")).toBe("sec");
  });

  it("refreshes when the token is within the refresh margin of expiry", async () => {
    let calls = 0;
    let t = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return tokenResponse(`t${calls}`, 1800);
    }) as unknown as typeof fetch;
    const p = createTokenProvider({
      clientId: "id",
      clientSecret: "sec",
      fetchImpl,
      now: () => t,
      refreshMarginMs: 60000,
    });
    expect(await p.getToken()).toBe("t1"); // expiresAt = 1800000, refresh at >= 1740000
    t = 1739999;
    expect(await p.getToken()).toBe("t1"); // still cached
    t = 1740000;
    expect(await p.getToken()).toBe("t2"); // refreshed
    expect(calls).toBe(2);
  });

  it("invalidate() forces an immediate refresh", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return tokenResponse(`t${calls}`);
    }) as unknown as typeof fetch;
    const p = createTokenProvider({ clientId: "id", clientSecret: "sec", fetchImpl });
    expect(await p.getToken()).toBe("t1");
    p.invalidate();
    expect(await p.getToken()).toBe("t2");
    expect(calls).toBe(2);
  });

  it("throws when the token endpoint rejects the client", async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const p = createTokenProvider({ clientId: "bad", clientSecret: "bad", fetchImpl });
    await expect(p.getToken()).rejects.toThrow("token endpoint HTTP 401");
  });

  it("throws when the response has no access_token", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ token_type: "Bearer" }),
    })) as unknown as typeof fetch;
    const p = createTokenProvider({ clientId: "id", clientSecret: "sec", fetchImpl });
    await expect(p.getToken()).rejects.toThrow("missing access_token");
  });
});
