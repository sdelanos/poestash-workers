import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { revalidateAppPrices } from "./revalidate-app";

// A stand-in for the app's route, answering the way src/server/prices/routes.ts
// does: the bearer secret or 401, a known game or 400, else { revalidated }.
// `mode` makes it answer what PoeStash 1.x, an apex host or a hung app would.
const SECRET = "s3cret";
let mode: "app" | "v1x" | "apex" | "slow" = "app";
let server: Server;
let origin: string;
const seen: IncomingMessage[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push(req);
    const url = new URL(req.url ?? "/", "http://x");
    const json = (status: number, body: object, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (mode === "apex") return json(308, {}, { Location: "https://www.example.com/" });
    if (mode === "slow") return void setTimeout(() => json(200, {}), 500);
    if (mode === "v1x" || url.pathname !== "/api/revalidate/prices" || req.method !== "POST") return json(404, {});
    if (req.headers.authorization !== `Bearer ${SECRET}`) return json(401, { error: "unauthorized" });
    const game = url.searchParams.get("game") ?? "poe1";
    if (game !== "poe1" && game !== "poe2") return json(400, { error: "game" });
    json(200, { revalidated: `prices:${game}` });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

afterEach(() => {
  seen.length = 0;
  mode = "app";
  vi.restoreAllMocks();
});

const quiet = () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  return vi.spyOn(console, "warn").mockImplementation(() => {});
};

describe("revalidateAppPrices", () => {
  it("posts the game with the bearer secret and reports the tag", async () => {
    quiet();
    const env = { POESTASH_APP_URL: `${origin}/`, CRON_SECRET: SECRET };
    expect(await revalidateAppPrices("poe2", { env })).toBe("revalidated");
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].url).toBe("/api/revalidate/prices?game=poe2");
    expect(seen[0].headers.authorization).toBe(`Bearer ${SECRET}`);
  });

  // Before the cut-over: 1.x has no such route, so the owner leaves the URL
  // unset, with or without the secret already in place.
  it("skips quietly, without a request, while the app URL is unset", async () => {
    const warn = quiet();
    expect(await revalidateAppPrices("poe1", { env: {} })).toBe("skipped");
    expect(await revalidateAppPrices("poe1", { env: { CRON_SECRET: SECRET, POESTASH_APP_URL: " " } })).toBe("skipped");
    expect(seen).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns and skips when the app URL is set without the secret", async () => {
    const warn = quiet();
    expect(await revalidateAppPrices("poe1", { env: { POESTASH_APP_URL: origin } })).toBe("skipped");
    expect(seen).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("never throws: a refused secret, a missing route, a redirect, a timeout and a dead host all log and return failed", async () => {
    const warn = quiet();
    const cases = [
      { as: "app", env: { POESTASH_APP_URL: origin, CRON_SECRET: "wrong" } },
      { as: "v1x", env: { POESTASH_APP_URL: origin, CRON_SECRET: SECRET } },
      { as: "apex", env: { POESTASH_APP_URL: origin, CRON_SECRET: SECRET } },
      { as: "slow", env: { POESTASH_APP_URL: origin, CRON_SECRET: SECRET } },
      { as: "app", env: { POESTASH_APP_URL: "http://127.0.0.1:1", CRON_SECRET: SECRET } },
      { as: "app", env: { POESTASH_APP_URL: "not a url", CRON_SECRET: SECRET } },
    ] as const;
    for (const { as, env } of cases) {
      mode = as;
      expect(await revalidateAppPrices("poe1", { env, timeoutMs: 100 })).toBe("failed");
    }
    const messages = warn.mock.calls.map(([m]) => String(m));
    expect(messages[0]).toMatch(/401.*CRON_SECRET differs/);
    expect(messages[1]).toMatch(/404.*no revalidate route/);
    expect(messages[2]).toMatch(/308.*redirected to https:\/\/www\.example\.com\//);
  });

  it("does not follow a redirect, which would drop the Authorization header", async () => {
    quiet();
    mode = "apex";
    const env = { POESTASH_APP_URL: origin, CRON_SECRET: SECRET };
    expect(await revalidateAppPrices("poe1", { env })).toBe("failed");
    expect(seen).toHaveLength(1);
  });

  it("adds a warning annotation on GitHub Actions", async () => {
    quiet();
    const log = vi.mocked(console.log);
    const env = { POESTASH_APP_URL: origin, CRON_SECRET: "wrong", GITHUB_ACTIONS: "true" };
    await revalidateAppPrices("poe1", { env });
    expect(log.mock.calls.some(([m]) => String(m).startsWith("::warning title=App revalidate failed::"))).toBe(true);
  });
});
