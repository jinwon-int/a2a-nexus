/**
 * Internal-destination guards shared by the K2 retrieval fetcher
 * (`egress-allowlist-proxy.ts`) and the patch-lane CONNECT proxy
 * (`egress-proxy.ts`, #2395). Dependency-free on purpose: the proxy container
 * runs a minimal bundle of `egress-guards.js`, `egress-proxy.js`, and
 * `egress-proxy-main.js` only.
 */
import { isIP } from "node:net";

function normalizeHostname(hostname: string): string {
  return hostname.trim().replace(/\.$/, "").toLowerCase();
}

export function isDeniedInternalHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal");
}

function ipv4ToNumber(ip: string): number | undefined {
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
  return (((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!) >>> 0;
}

function ipv4InCidr(ip: string, base: string, bits: number): boolean {
  const value = ipv4ToNumber(ip);
  const baseValue = ipv4ToNumber(base);
  if (value === undefined || baseValue === undefined) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (baseValue & mask);
}

/**
 * The embedded IPv4 literal of an IPv6 address that carries one: the
 * `::ffff:a.b.c.d` mapped form, the deprecated `::a.b.c.d` compatible form,
 * and the `64:ff9b::a.b.c.d` NAT64 well-known prefix. Each reaches an IPv4
 * destination, so each must be judged by the IPv4 rules.
 */
function embeddedIpv4(ip: string): string | undefined {
  const lower = ip.toLowerCase();
  const match = /^(?:::ffff:|::|64:ff9b::)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  return match?.[1];
}

const DENIED_IPV4_CIDRS: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // RFC 1918 private
  ["100.64.0.0", 10], // RFC 6598 carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. cloud metadata at 169.254.169.254
  ["172.16.0.0", 12], // RFC 1918 private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16], // RFC 1918 private
  ["198.18.0.0", 15], // RFC 2544 benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. 255.255.255.255 broadcast
];

export function isDeniedInternalIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return DENIED_IPV4_CIDRS.some(([base, bits]) => ipv4InCidr(address, base, bits));
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    const embedded = embeddedIpv4(lower);
    if (embedded) return isDeniedInternalIp(embedded);
    return (
      lower === "::" ||
      lower === "::1" ||
      lower.startsWith("fc") || // fc00::/7 unique local
      lower.startsWith("fd") ||
      // fe00::/8 covers fe80::/10 link-local and fec0::/10 site-local; no
      // global unicast (2000::/3) falls in it, so denying the whole block is
      // safe and leaves no gap between the two.
      lower.startsWith("fe") ||
      lower.startsWith("ff") // ff00::/8 multicast
    );
  }
  return false;
}
