const OPEN = "<think>";
const CLOSE = "</think>";

function partialSuffix(s, token) {
  for (let k = Math.min(token.length - 1, s.length); k > 0; k--) {
    if (s.endsWith(token.slice(0, k))) return k;
  }
  return 0;
}

export class ThinkSplitter {
  constructor() {
    this.buf = "";
    this.inside = false;
    this.started = false;
    this.thought = [];
  }

  _emit(text) {
    if (!this.started) {
      text = text.trimStart();
      if (text) this.started = true;
    }
    return text;
  }

  feed(chunk) {
    this.buf += chunk;
    const out = [];
    for (;;) {
      if (!this.inside) {
        const i = this.buf.indexOf(OPEN);
        if (i >= 0) {
          out.push(this.buf.slice(0, i));
          this.buf = this.buf.slice(i + OPEN.length);
          this.inside = true;
          continue;
        }
        const cut = this.buf.length - partialSuffix(this.buf, OPEN);
        out.push(this.buf.slice(0, cut));
        this.buf = this.buf.slice(cut);
        break;
      }
      const j = this.buf.indexOf(CLOSE);
      if (j >= 0) {
        this.thought.push(this.buf.slice(0, j));
        this.buf = this.buf.slice(j + CLOSE.length);
        this.inside = false;
        continue;
      }
      const cut = this.buf.length - partialSuffix(this.buf, CLOSE);
      this.thought.push(this.buf.slice(0, cut));
      this.buf = this.buf.slice(cut);
      break;
    }
    return this._emit(out.join(""));
  }

  flush() {
    const rest = this.buf;
    this.buf = "";
    if (this.inside) {
      this.thought.push(rest);
      return "";
    }
    return this._emit(rest);
  }

  get reasoning() {
    return this.thought.join("").trim();
  }
}

export function splitThink(text) {

  if (text.includes(CLOSE) && !text.includes(OPEN)) {
    const i = text.indexOf(CLOSE);
    return [text.slice(i + CLOSE.length).trim(), text.slice(0, i).trim() || null];
  }
  const sp = new ThinkSplitter();
  const visible = sp.feed(text) + sp.flush();
  return [visible.trim(), sp.reasoning || null];
}
