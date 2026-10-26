import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

/**
 * SSRF guard for user-supplied webhook URLs. A member can point a webhook at any URL, so the server
 * must never be turned into a proxy to its own network: only public `https` hosts are accepted, the
 * check is repeated at connection time on the resolved addresses (DNS rebinding), and redirects are
 * never followed.
 */

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  // Unspecified, loopback and IPv4-compatible (deprecated `::a.b.c.d`, which URL parsing turns
  // into `::7f00:1`): nothing public lives in ::/96.
  ['::', 96],
  ['::1', 128], // loopback
  ['2001::', 32], // Teredo: embeds an arbitrary (possibly private) IPv4 server/client
  ['2002::', 16], // 6to4: embeds an arbitrary (possibly private) IPv4 address
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** The IPv4 address embedded in an IPv4-mapped, -compatible or NAT64 IPv6 address, if any. */
function embeddedIpv4(ip: string): string | null {
  const lower = ip.toLowerCase();
  const m = /^(?:::ffff:(?:0:)?|::|64:ff9b::)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (m) return m[1]!;
  // Hex form, e.g. ::ffff:7f00:1 (what URL parsing produces for [::ffff:127.0.0.1]).
  const h = /^(?:::ffff:(?:0:)?|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (h) {
    const hi = parseInt(h[1]!, 16);
    const lo = parseInt(h[2]!, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

/** True for an address a webhook may be delivered to (public unicast). */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !blocked.check(ip, 'ipv4');
  if (family === 6) {
    const v4 = embeddedIpv4(ip);
    if (v4 !== null) return isIP(v4) === 4 && !blocked.check(v4, 'ipv4');
    return !blocked.check(ip, 'ipv6');
  }
  return false;
}

export class WebhookUrlError extends Error {}

const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.localdomain'];

/**
 * Static checks on a webhook URL (no DNS): `https`, no credentials, default or explicit port, and a
 * host that is not an IP literal of a private network nor an obviously local name.
 */
export function validateWebhookUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new WebhookUrlError('Not a valid URL');
  }
  if (u.protocol !== 'https:') throw new WebhookUrlError('Only https URLs are accepted');
  if (u.username || u.password) throw new WebhookUrlError('Credentials in the URL are refused');
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) throw new WebhookUrlError('The URL has no host');
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new WebhookUrlError('Private or local addresses are refused');
  } else {
    const lower = host.toLowerCase();
    if (
      lower === 'localhost' ||
      !lower.includes('.') ||
      LOCAL_SUFFIXES.some((s) => lower.endsWith(s))
    ) {
      throw new WebhookUrlError('Local host names are refused');
    }
  }
  return u;
}

type Resolver = (
  hostname: string,
  options: { all: true },
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

/**
 * A `lookup` for http(s).request that resolves the host and refuses the connection when any
 * resolved address is not public. The socket then connects to the checked address, so a second,
 * different DNS answer cannot slip in between the check and the connection.
 */
export function guardedLookup(
  resolve: Resolver = dnsLookup as unknown as Resolver,
): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0);
      const list = addresses.filter((a) => !options.family || a.family === options.family);
      if (list.length === 0) {
        return callback(
          Object.assign(new Error(`No address for ${hostname}`), { code: 'ENOTFOUND' }),
          '',
          0,
        );
      }
      if (list.some((a) => !isPublicAddress(a.address))) {
        return callback(
          Object.assign(new Error('Refused: the host resolves to a private address'), {
            code: 'ESSRF',
          }),
          '',
          0,
        );
      }
      if (options.all)
        return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
      callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

export interface PostResult {
  ok: boolean;
  status: number;
}

/** The HTTP client used for webhooks; tests replace it. */
export type WebhookPoster = (
  url: string,
  body: unknown,
  opts?: { timeoutMs?: number; headers?: Record<string, string>; rawBody?: string },
) => Promise<PostResult>;

/**
 * POSTs JSON to a validated public https URL. Redirects are not followed (a 3xx is a failure) and
 * the response body is discarded.
 */
export const safePost: WebhookPoster = (url, body, opts = {}) => {
  const u = validateWebhookUrl(url);
  // `rawBody`: the exact bytes a signature was computed over.
  const payload = Buffer.from(opts.rawBody ?? JSON.stringify(body));
  return new Promise<PostResult>((resolve, reject) => {
    const req = httpsRequest(
      u,
      {
        method: 'POST',
        // A dedicated agent: never the global one, which honours HTTP(S)_PROXY when
        // NODE_USE_ENV_PROXY is set (Node 24+). Through a proxy, the target would be resolved
        // and reached by the proxy, past the guarded lookup.
        agent: new HttpsAgent({ keepAlive: false }),
        lookup: guardedLookup(),
        // Whole-exchange deadline: `timeout` alone is an idle timeout, which a server dribbling
        // one byte at a time never trips.
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
        headers: {
          ...opts.headers,
          'content-type': 'application/json',
          'content-length': payload.length,
          'user-agent': 'orch-notifier',
        },
        timeout: opts.timeoutMs ?? 10_000,
      },
      (res) => {
        res.on('error', () => {}); // a deadline hit while draining: the status is already known
        res.resume();
        const status = res.statusCode ?? 0;
        resolve({ ok: status >= 200 && status < 300, status });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(payload);
  });
};

/** `https://hooks.slack.com/…a1b2`: enough to recognise a target, useless to post to it. */
export function maskUrl(u: URL): string {
  const tail = u.href.replace(/\/+$/, '').slice(-4);
  return `${u.protocol}//${u.host}/…${tail}`;
}
