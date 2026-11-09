// Pure Node SOCKS4 / SOCKS4a / SOCKS5 / SOCKS5h client.
//
//   socks5://user:pass@host:1080   (hostnames resolved locally)
//   socks5h://host:1080            (hostnames resolved by the proxy)
//   socks4://host:1080, socks4a://host:1080
import net from "node:net";
import dns from "node:dns/promises";
import { domainToASCII } from "node:url";

export const SCHEMES = ["socks4", "socks4a", "socks5", "socks5h"];

const SOCKS5_ERRORS = {
  1: "general failure", 2: "connection not allowed by ruleset", 3: "network unreachable", 4: "host unreachable",
  5: "connection refused", 6: "TTL expired", 7: "command not supported", 8: "address type not supported",
};

/** Handshake with the SOCKS proxy failed. */
export class SocksError extends Error {
  constructor(message) {
    super(message);
    this.name = "SocksError";
  }
}

export function parse(url) {
  let u;
  try { u = new URL(url); } catch { throw new TypeError(`invalid SOCKS proxy URL: ${JSON.stringify(url)}`); }
  const scheme = u.protocol.replace(/:$/, "").toLowerCase();
  if (!SCHEMES.includes(scheme) || !u.hostname) throw new TypeError(`invalid SOCKS proxy URL: ${JSON.stringify(url)}`);
  return { scheme, host: u.hostname.replace(/^\[|\]$/g, ""), port: Number(u.port) || 1080,
    user: u.username ? decodeURIComponent(u.username) : null, password: u.password ? decodeURIComponent(u.password) : null };
}

/** Buffered exact-length reader. Uses 'data' events so the socket stays in flowing mode for whoever takes it over. */
function reader(sock) {
  let buf = Buffer.alloc(0);
  let ended = null;
  let wake = null;
  const onData = (d) => { buf = Buffer.concat([buf, d]); wake?.(); };
  const onEnd = () => { ended = new SocksError("proxy closed the connection during the handshake"); wake?.(); };
  const onErr = (e) => { ended = e; wake?.(); };
  sock.on("data", onData);
  sock.once("end", onEnd);
  sock.once("close", onEnd);
  sock.on("error", onErr);
  return {
    async read(n) {
      while (buf.length < n) {
        if (ended) throw ended;
        await new Promise((resolve) => { wake = resolve; });
        wake = null;
      }
      const out = buf.subarray(0, n);
      buf = buf.subarray(n);
      return out;
    },
    done() {
      sock.off("data", onData); sock.off("end", onEnd); sock.off("close", onEnd); sock.off("error", onErr);
    },
  };
}

function ipv6Bytes(ip) {
  let [head, tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g || "0", 16), i * 2));
  return out;
}

const ipBytes = (ip) => (net.isIPv4(ip) ? Buffer.from(ip.split(".").map(Number)) : ipv6Bytes(ip));

/** Open a TCP tunnel to ``host:port`` through ``proxy`` (a parsed proxy); resolves with the connected socket. */
export async function connect(proxy, host, port, timeoutMs = 60000) {
  const sock = net.connect({ host: proxy.host, port: proxy.port });
  sock.setTimeout(timeoutMs, () => sock.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })));
  try {
    await new Promise((resolve, reject) => { sock.once("connect", resolve); sock.once("error", reject); });
    sock.removeAllListeners("error");
    sock.on("error", () => {});
    host = host.replace(/^\[|\]$/g, "");
    const r = reader(sock);
    try {
      if (proxy.scheme.startsWith("socks5")) await socks5(sock, r, proxy, host, port);
      else await socks4(sock, r, proxy, host, port);
    } finally {
      r.done();
    }
    sock.setTimeout(0);
    return sock;
  } catch (e) {
    sock.destroy();
    throw e;
  }
}

async function socks5(sock, r, p, host, port) {
  const methods = p.user !== null ? [0, 2] : [0];
  sock.write(Buffer.from([5, methods.length, ...methods]));
  const [ver, method] = await r.read(2);
  if (ver !== 5) throw new SocksError("not a SOCKS5 proxy");
  if (method === 2) {
    const u = Buffer.from(p.user || ""), pw = Buffer.from(p.password || "");
    if (u.length > 255 || pw.length > 255) throw new SocksError("SOCKS5 user name / password longer than 255 bytes");
    sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([pw.length]), pw]));
    if ((await r.read(2))[1] !== 0) throw new SocksError("SOCKS5 authentication failed");
  } else if (method !== 0) {
    throw new SocksError("SOCKS5 proxy offers no acceptable authentication method");
  }
  let ip = net.isIP(host) ? host : null;
  if (!ip && p.scheme === "socks5") ip = (await dns.lookup(host)).address; // resolve locally unless socks5h
  let addr;
  if (ip) {
    addr = Buffer.concat([Buffer.from([net.isIPv4(ip) ? 1 : 4]), ipBytes(ip)]);
  } else {
    const name = Buffer.from(domainToASCII(host) || host);
    if (name.length > 255) throw new SocksError("host name too long for SOCKS5");
    addr = Buffer.concat([Buffer.from([3, name.length]), name]);
  }
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port);
  sock.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, portBuf]));
  const [, rep, , atyp] = await r.read(4);
  if (rep !== 0) throw new SocksError(`SOCKS5 connect failed: ${SOCKS5_ERRORS[rep] || "error " + rep}`);
  const skip = atyp === 1 ? 4 : atyp === 4 ? 16 : (await r.read(1))[0];
  await r.read(skip + 2);
}

async function socks4(sock, r, p, host, port) {
  const user = Buffer.concat([Buffer.from(p.user || ""), Buffer.from([0])]);
  let ip = net.isIP(host) ? host : null;
  if (!ip && p.scheme === "socks4") ip = (await dns.lookup(host, { family: 4 })).address;
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port);
  let req;
  if (ip) {
    if (!net.isIPv4(ip)) throw new SocksError("SOCKS4 supports IPv4 only");
    req = Buffer.concat([Buffer.from([4, 1]), portBuf, ipBytes(ip), user]);
  } else { // socks4a: let the proxy resolve
    req = Buffer.concat([Buffer.from([4, 1]), portBuf, Buffer.from([0, 0, 0, 1]), user, Buffer.from(domainToASCII(host) || host), Buffer.from([0])]);
  }
  sock.write(req);
  const resp = await r.read(8);
  if (resp[1] !== 0x5a) throw new SocksError(`SOCKS4 request rejected (code 0x${resp[1].toString(16).padStart(2, "0")})`);
}
