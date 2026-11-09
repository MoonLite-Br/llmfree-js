// Turn friendly inputs (string / messages / images) into OpenAI-style messages.
import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

function sniff(buf) {
  if (buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return "application/octet-stream";
}

/** URL / data-URI / local path / raw bytes -> something an API accepts. */
export function imageUrl(img) {
  if (img instanceof Uint8Array) {
    const buf = Buffer.from(img);
    return `data:${sniff(buf)};base64,${buf.toString("base64")}`;
  }
  const s = String(img);
  if (/^(https?:|data:)/.test(s)) return s;
  let isFile = false;
  try { isFile = statSync(s).isFile(); } catch { /* not a file */ }
  if (isFile) {
    const buf = readFileSync(s);
    return `data:${MIME[extname(s).toLowerCase()] || sniff(buf)};base64,${buf.toString("base64")}`;
  }
  throw new Error(`image not found: ${JSON.stringify(s)}`);
}

export function buildMessages(prompt, system = null, images = null) {
  let msgs;
  if (typeof prompt === "string") {
    msgs = [{ role: "user", content: prompt }];
  } else {
    msgs = structuredClone([...prompt]);
    if (!msgs.length) throw new TypeError("messages must not be empty");
  }
  if (images?.length) {
    let idx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "user") { idx = i; break; }
    if (idx < 0) throw new TypeError("images need a user message to attach to");
    const content = msgs[idx].content ?? "";
    const parts = typeof content === "string" ? [{ type: "text", text: content }] : [...content];
    for (const i of images) parts.push({ type: "image_url", image_url: { url: imageUrl(i) } });
    msgs[idx].content = parts;
  }
  if (system && !(msgs.length && msgs[0].role === "system")) msgs.unshift({ role: "system", content: system });
  return msgs;
}
