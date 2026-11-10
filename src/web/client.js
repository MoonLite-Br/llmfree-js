/* llmf browser helper (served at /_llmf/client.js): window.llmf.chat() / .stream() / .fetch().
 * It gets a short-lived session token (proof of work or Cloudflare Turnstile) and calls /v1/chat/completions with it. */
(function () {
  "use strict";
  var token = null, expires = 0, pending = null;

  // --- SHA-256 (sync, tiny): the browser's crypto.subtle is async and too slow for a proof-of-work loop
  var K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  var W = new Uint32Array(64), H = new Uint32Array(8);
  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
  function sha256(bytes) {
    var len = bytes.length, total = ((len + 9 + 63) >> 6) << 6, buf = new Uint8Array(total);
    buf.set(bytes); buf[len] = 0x80;
    var bits = len * 8, dv = new DataView(buf.buffer);
    dv.setUint32(total - 8, Math.floor(bits / 4294967296)); dv.setUint32(total - 4, bits >>> 0);
    H.set([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    for (var off = 0; off < total; off += 64) {
      var i;
      for (i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
      for (i = 16; i < 64; i++) {
        var s0 = rotr(W[i-15], 7) ^ rotr(W[i-15], 18) ^ (W[i-15] >>> 3), s1 = rotr(W[i-2], 17) ^ rotr(W[i-2], 19) ^ (W[i-2] >>> 10);
        W[i] = (W[i-16] + s0 + W[i-7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
        var t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    return H;
  }
  function zeroBits(words) { var n = 0; for (var i = 0; i < 8; i++) { var w = words[i]; if (w === 0) { n += 32; continue; } return n + Math.clz32(w); } return n; }
  function solve(challenge, bits, signal) {
    var enc = new TextEncoder(), n = 0;
    return new Promise(function (resolve, reject) {
      (function step() {
        if (signal && signal.aborted) return reject(new DOMException("aborted", "AbortError"));
        for (var end = n + 20000; n < end; n++) if (zeroBits(sha256(enc.encode(challenge + ":" + n))) >= bits) return resolve(n);
        setTimeout(step, 0);
      })();
    });
  }

  function fail(res, data) {
    var e = new Error((data && data.error && data.error.message) || ("HTTP " + res.status));
    e.status = res.status; e.retryAfter = res.headers.get("Retry-After"); return e;
  }
  function json(url, init) { return fetch(url, init).then(function (r) { return r.json().catch(function () { return null; }).then(function (d) { if (!r.ok) throw fail(r, d); return d; }); }); }

  function turnstile(sitekey) {
    return new Promise(function (resolve, reject) {
      var box = document.createElement("div"); box.style.cssText = "position:fixed;inset:auto 12px 12px auto;z-index:99"; document.body.appendChild(box);
      var go = function () { window.turnstile.render(box, { sitekey: sitekey, callback: function (t) { box.remove(); resolve(t); }, "error-callback": function () { box.remove(); reject(new Error("turnstile failed")); } }); };
      if (window.turnstile) return go();
      var s = document.createElement("script"); s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"; s.onload = go; s.onerror = function () { reject(new Error("turnstile unavailable")); }; document.head.appendChild(s);
    });
  }

  function session(opts) {
    opts = opts || {};
    if (token && Date.now() < expires - 30000) return Promise.resolve(token);
    if (pending) return pending;
    if (opts.onStatus) opts.onStatus("verify");
    pending = json("/_llmf/config").then(function (cfg) {
      if (cfg.antibot === "pow") return json("/_llmf/challenge").then(function (c) { return solve(c.challenge, c.bits, opts.signal).then(function (n) { return { challenge: c.challenge, counter: n }; }); });
      if (cfg.antibot === "turnstile") return turnstile(cfg.turnstile_sitekey).then(function (t) { return { turnstile: t }; });
      return {};
    }).then(function (proof) {
      return json("/_llmf/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(proof) });
    }).then(function (s) { token = s.token; expires = Date.now() + s.expires_in * 1000; return token; })
      .then(function (t) { pending = null; return t; }, function (e) { pending = null; throw e; });
    return pending;
  }

  /** fetch() with the session token attached (one retry with a fresh session on 401/403). */
  function authFetch(url, init, opts) {
    function go() {
      return session(opts).then(function (t) {
        var h = Object.assign({}, init && init.headers, { Authorization: "Bearer " + t });
        return fetch(url, Object.assign({}, init, { headers: h }));
      });
    }
    return go().then(function (r) { if (r.status !== 401 && r.status !== 403) return r; token = null; return go(); });
  }

  function body(messages, o, stream) {
    var b = { messages: messages, stream: !!stream };
    ["model", "max_tokens", "temperature"].forEach(function (k) { if (o && o[k] !== undefined) b[k] = o[k]; });
    return JSON.stringify(b);
  }

  function chat(messages, o) {
    o = o || {};
    return authFetch("/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: body(messages, o, false), signal: o.signal }, o)
      .then(function (r) { return r.json().catch(function () { return null; }).then(function (d) { if (!r.ok) throw fail(r, d); return d.choices[0].message.content || ""; }); });
  }

  function stream(messages, o) {
    o = o || {};
    return authFetch("/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json" }, body: body(messages, o, true), signal: o.signal }, o).then(function (r) {
      if (!r.ok) return r.json().catch(function () { return null; }).then(function (d) { throw fail(r, d); });
      var reader = r.body.getReader(), dec = new TextDecoder(), buf = "", full = "";
      return (function pump() {
        return reader.read().then(function (x) {
          if (x.done) return full;
          buf += dec.decode(x.value, { stream: true });
          var lines = buf.split("\n"); buf = lines.pop();
          lines.forEach(function (line) {
            line = line.trim(); if (line.indexOf("data:") !== 0) return;
            var p = line.slice(5).trim(); if (!p || p === "[DONE]") return;
            var ev; try { ev = JSON.parse(p); } catch (e) { return; }
            if (ev.error) throw new Error(ev.error.message || "error");
            var t = ev.choices && ev.choices[0] && ev.choices[0].delta && ev.choices[0].delta.content;
            if (t) { full += t; if (o.onDelta) o.onDelta(t, full); }
          });
          return pump();
        });
      })();
    });
  }

  window.llmf = { session: session, fetch: authFetch, chat: chat, stream: stream };
})();
