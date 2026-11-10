(function () {
  "use strict";
  var L = (navigator.language || "en").slice(0, 2) === "vi" ?
    {title: "Chat AI", ph: "Nhập tin nhắn… (Enter để gửi)", send: "Gửi", stop: "Dừng", clear: "Xoá", pow: "Đang xác minh bạn là người…",
     err: "Lỗi: ", busy: "Máy chủ đang bận, thử lại sau ", sec: " giây", you: "Bạn", ai: "AI", empty: "Hãy hỏi bất cứ điều gì."} :
    {title: "AI chat", ph: "Type a message… (Enter to send)", send: "Send", stop: "Stop", clear: "Clear", pow: "Verifying you are human…",
     err: "Error: ", busy: "Server busy, retry in ", sec: " s", you: "You", ai: "AI", empty: "Ask anything."};
  var $ = function (id) { return document.getElementById(id); };
  var log = $("log"), box = $("box"), form = $("form"), btn = $("send"), status = $("status");
  var msgs = [], ctl = null;
  try { msgs = JSON.parse(localStorage.getItem("llmf.chat") || "[]").filter(function (m) { return m && typeof m.content === "string" && (m.role === "user" || m.role === "assistant"); }).slice(-30); } catch (e) {}
  document.title = L.title; $("title").textContent = L.title; box.placeholder = L.ph; $("clear").textContent = L.clear; btn.textContent = L.send;
  function save() { try { localStorage.setItem("llmf.chat", JSON.stringify(msgs.slice(-30))); } catch (e) {} }
  function add(role, text) {
    var d = document.createElement("div"); d.className = "m " + role;
    var w = document.createElement("b"); w.textContent = role === "user" ? L.you : L.ai;
    var p = document.createElement("div"); p.className = "t"; p.textContent = text;   // textContent only: no HTML injection
    d.appendChild(w); d.appendChild(p); log.appendChild(d); log.scrollTop = log.scrollHeight; return p;
  }
  function render() { log.textContent = ""; if (!msgs.length) { var e = document.createElement("p"); e.className = "empty"; e.textContent = L.empty; log.appendChild(e); } msgs.forEach(function (m) { add(m.role, m.content); }); }
  function busy(on) { btn.textContent = on ? L.stop : L.send; btn.dataset.busy = on ? "1" : ""; }
  btn.addEventListener("click", function (ev) { if (ctl) { ev.preventDefault(); ctl.abort(); } });
  $("clear").addEventListener("click", function () { if (ctl) ctl.abort(); msgs = []; save(); render(); });
  box.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  form.addEventListener("submit", function (e) {
    e.preventDefault(); if (ctl) return;
    var text = box.value.trim(); if (!text) return;
    box.value = ""; msgs.push({role: "user", content: text}); if (msgs.length === 1) log.textContent = "";
    add("user", text); var out = add("assistant", "…"); status.textContent = "";
    ctl = new AbortController(); busy(true);
    llmf.stream(msgs.slice(-20), {signal: ctl.signal, onStatus: function () { status.textContent = L.pow; },
      onDelta: function (t, full) { status.textContent = ""; out.textContent = full; log.scrollTop = log.scrollHeight; }})
      .then(function (full) { msgs.push({role: "assistant", content: full}); save(); })
      .catch(function (err) {
        var partial = out.textContent === "…" ? "" : out.textContent;
        if (err.name === "AbortError") { if (partial) { msgs.push({role: "assistant", content: partial}); save(); } else out.parentNode.remove(); if (!partial) msgs.pop(); return; }
        msgs.pop(); out.parentNode.classList.add("bad");
        out.textContent = err.status === 429 ? L.busy + (err.retryAfter || "?") + L.sec : L.err + err.message;
      })
      .then(function () { ctl = null; busy(false); status.textContent = ""; box.focus(); });
  });
  render();
})();
