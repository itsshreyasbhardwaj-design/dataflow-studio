import { describe, expect, it } from "vitest";
import { assertUrlAllowed, classifyAddress, policyFromEnvironment, sanitizeHeaders, SsrfBlockedError } from "./ssrf.js";
import { ConnectorError } from "./types.js";

const resolves = (address: string) => async () => [address];

describe("classifyAddress", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "240.0.0.1",
    "198.18.0.1", "192.0.2.1", "203.0.113.9",
  ])("blocks %s", (address) => {
    expect(classifyAddress(address).blocked).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "11.0.0.1"])("allows %s", (address) => {
    expect(classifyAddress(address).blocked).toBe(false);
  });

  it("blocks IPv6 loopback, link-local and unique-local", () => {
    for (const address of ["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1"]) {
      expect(classifyAddress(address).blocked, address).toBe(true);
    }
  });

  it("allows public IPv6", () => {
    expect(classifyAddress("2606:4700:4700::1111").blocked).toBe(false);
  });

  it("unwraps IPv4-mapped IPv6 addresses", () => {
    expect(classifyAddress("::ffff:127.0.0.1").blocked).toBe(true);
    expect(classifyAddress("::ffff:8.8.8.8").blocked).toBe(false);
  });

  it("rejects garbage", () => {
    expect(classifyAddress("not-an-ip").blocked).toBe(true);
  });
});

describe("assertUrlAllowed", () => {
  it("allows a public https URL", async () => {
    const result = await assertUrlAllowed("https://api.example.com/v1/orders", {}, resolves("93.184.216.34"));
    expect(result.url.hostname).toBe("api.example.com");
    expect(result.addresses).toEqual(["93.184.216.34"]);
  });

  it("blocks the cloud metadata endpoint by literal IP", async () => {
    await expect(assertUrlAllowed("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(SsrfBlockedError);
  });

  it("blocks a hostname that resolves into a private range", async () => {
    await expect(assertUrlAllowed("https://evil.example.com", {}, resolves("10.0.0.5")))
      .rejects.toThrow(/Blocked request to "evil.example.com"/);
  });

  it("blocks a hostname that resolves to the metadata address (DNS rebinding)", async () => {
    await expect(assertUrlAllowed("https://rebind.example.com", {}, resolves("169.254.169.254")))
      .rejects.toThrow(/link-local/);
  });

  it("blocks localhost and internal TLDs without resolving", async () => {
    for (const host of ["http://localhost/", "http://api.localhost/", "https://db.internal/", "https://printer.local/"]) {
      await expect(assertUrlAllowed(host, {}, async () => { throw new Error("should not resolve"); })).rejects.toThrow(SsrfBlockedError);
    }
  });

  it("blocks non-http schemes", async () => {
    for (const url of ["file:///etc/passwd", "gopher://example.com", "ftp://example.com", "data:text/plain,hi"]) {
      await expect(assertUrlAllowed(url)).rejects.toThrow(/Scheme/);
    }
  });

  it("blocks credentials embedded in the URL", async () => {
    await expect(assertUrlAllowed("https://user:pass@example.com", {}, resolves("8.8.8.8")))
      .rejects.toThrow(/Credentials embedded in a URL/);
  });

  it("blocks unusual ports", async () => {
    await expect(assertUrlAllowed("https://example.com:22/", {}, resolves("8.8.8.8"))).rejects.toThrow(/Port 22/);
    await expect(assertUrlAllowed("https://example.com:6379/", {}, resolves("8.8.8.8"))).rejects.toThrow(/Port 6379/);
  });

  it("enforces an allowlist by suffix", async () => {
    const policy = { allowedHosts: ["example.com"] };
    await expect(assertUrlAllowed("https://api.example.com/x", policy, resolves("8.8.8.8"))).resolves.toBeDefined();
    await expect(assertUrlAllowed("https://example.com/x", policy, resolves("8.8.8.8"))).resolves.toBeDefined();
    await expect(assertUrlAllowed("https://notexample.com/x", policy, resolves("8.8.8.8"))).rejects.toThrow(/not on the connector allowlist/);
    await expect(assertUrlAllowed("https://example.com.evil.net/x", policy, resolves("8.8.8.8"))).rejects.toThrow(/allowlist/);
  });

  it("applies the deny list before the allowlist", async () => {
    await expect(
      assertUrlAllowed("https://secrets.example.com", { allowedHosts: ["example.com"], blockedHosts: ["secrets.example.com"] }, resolves("8.8.8.8")),
    ).rejects.toThrow(/deny list/);
  });

  it("permits private networks only when explicitly opted in", async () => {
    await expect(assertUrlAllowed("http://127.0.0.1:8080/x", { allowPrivateNetworks: true, allowedPorts: [8080] })).resolves.toBeDefined();
  });

  it("reports a resolution failure as a connection error, not a block", async () => {
    await expect(
      assertUrlAllowed("https://nope.example.com", {}, async () => { throw new Error("ENOTFOUND"); }),
    ).rejects.toThrow(ConnectorError);
  });

  it("rejects an empty resolution", async () => {
    await expect(assertUrlAllowed("https://nope.example.com", {}, async () => [])).rejects.toThrow(/did not resolve/);
  });

  it("rejects a malformed URL", async () => {
    await expect(assertUrlAllowed("not a url")).rejects.toThrow(/not a valid absolute URL/);
  });
});

describe("sanitizeHeaders", () => {
  it("drops hop-by-hop and spoofable headers", () => {
    expect(sanitizeHeaders({ Host: "evil", "X-Forwarded-For": "1.2.3.4", "Metadata-Flavor": "Google", Accept: "application/json" }))
      .toEqual({ accept: "application/json" });
  });

  it("rejects header injection via CRLF", () => {
    expect(() => sanitizeHeaders({ "X-Test": "a\r\nX-Admin: true" })).toThrow(/contains a newline/);
  });

  it("rejects an invalid header name", () => {
    expect(() => sanitizeHeaders({ "bad header": "x" })).toThrow(/Invalid header name/);
  });

  it("lower-cases names and stringifies values", () => {
    expect(sanitizeHeaders({ "X-Count": 5, "X-Flag": true })).toEqual({ "x-count": "5", "x-flag": "true" });
  });

  it("skips null values", () => {
    expect(sanitizeHeaders({ a: null, b: undefined })).toEqual({});
  });
});

describe("policyFromEnvironment", () => {
  it("parses comma-separated lists and flags", () => {
    expect(policyFromEnvironment({
      CONNECTOR_ALLOWED_HOSTS: "api.example.com, example.org",
      CONNECTOR_ALLOW_PRIVATE_NETWORKS: "true",
      CONNECTOR_MAX_RESPONSE_BYTES: "1024",
    })).toEqual({
      allowedHosts: ["api.example.com", "example.org"],
      allowPrivateNetworks: true,
      maxResponseBytes: 1024,
    });
  });

  it("defaults to blocking private networks", () => {
    expect(policyFromEnvironment({}).allowPrivateNetworks).toBe(false);
  });
});
