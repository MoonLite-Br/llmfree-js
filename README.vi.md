<div align="center">

# llmf (llmfree) cho Node.js

**LLM miễn phí, không cần API key, chỉ một lời gọi: có fallback, danh mục đã kiểm chứng và server chuẩn OpenAI.**

[![npm](https://img.shields.io/npm/v/llmf?color=2ea44f)](https://www.npmjs.com/package/llmf)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen)

[English](README.md) · Tiếng Việt

</div>

```bash
npm install -g llmf        # dòng lệnh: `llmf-js`
npm install llmf           # hoặc làm thư viện trong dự án
```
```js
import llmf from "llmf";
console.log(String(await llmf.chat("Thủ đô của Việt Nam là gì?")));
```

Không tài khoản, không API key, không khai báo nhà cung cấp. **0 phụ thuộc npm**, Node 18+, chạy trên Linux, macOS, Windows và **Termux/Android** (`pkg install nodejs`).
Đây là bản Node của gói Python [`llmf`](https://pypi.org/project/llmf/): cùng nhà cung cấp, cùng danh mục, cùng cờ, cùng tuỳ chọn `serve`, cùng thư mục cache.

> **Lưu ý.** Đây là các endpoint công khai, không chính thức: có thể đổi, bị giới hạn hoặc biến mất bất cứ lúc nào, và prompt đi tới bên thứ ba ẩn danh. Đừng gửi dữ liệu nhạy cảm. Chạy `llmf-js doctor` định kỳ. llmf không liên kết với bất kỳ nhà cung cấp nào.

**Máy đã cài `llmf` Python?** Cài cả hai được. Gói npm chỉ tạo lệnh `llmf-js`, không đè lệnh `llmf` của Python. Hai bản dùng chung cache `~/.cache/llmf/` và các biến `LLMF_*`. Mỗi bên `serve` nhớ đặt `--port` khác nhau.

## Tính năng chính

- **Một lời gọi**, cú pháp khớp OpenAI (`choices`, `usage`, `stream`, `tools`, `response_format`).
- **Fallback tự động**: cooldown theo model/nhà, phát hiện câu trả lời rỗng/lỗi giấu trong HTTP 200, `AllProvidersFailed` kèm báo cáo từng lần thử.
- **Danh mục đã kiểm chứng**: chỉ giữ model trả lời ≥ 2 lần thật với tỉ lệ ≥ 75 %; model khác vẫn dùng được bằng `provider/model`.
- **Lịch sử sống/chết**: `llmf-js models` hiện `alive 7/7`, `flaky 2/3`, `dead 0/3`; model kém tự bị đẩy xuống cuối.
- **Định tuyến theo tải**: giới hạn đồng thời mỗi nhà, request dư tự chuyển sang nhà khác; `race: N` lấy câu trả lời nhanh nhất.
- **Proxy HTTP/HTTPS/SOCKS** (chỉ proxy của bạn) và **transport giống trình duyệt** tuỳ chọn qua `curl-impersonate`.
- **`llmf-js serve`**: server chuẩn OpenAI; có thể mở ra internet an toàn, kèm web chat, Cloudflare tunnel, anti-bot.

## Dùng nhanh

```js
import { LLMF } from "llmf";
const llm = new LLMF();
const r = await llm.chat.completions.create({ model: "best", messages: [{ role: "user", content: "Xin chào" }] });
console.log(r.choices[0].message.content, r.model);     // r.model cho biết nhà/model thật đã trả lời
```
```js
await llmf.chat("hi", { provider: "ovh", proxy: "socks5h://127.0.0.1:1080" });
for await (const piece of llmf.stream("Đếm từ 1 đến 5")) process.stdout.write(piece);
const s = llmf.session("Ngắn gọn"); await s.chat("Tên tôi là An"); await s.chat("Tên tôi là gì?");
```
Chọn model: `fast | best | code | vision | reasoning`, `"ovh/Qwen3.5-397B-A17B"`, tên gần đúng `"qwen"`, hoặc danh sách `["best", "fast"]`.

Cấu hình: `new LLMF({ timeout: 30, deadline: 120, proxy, routing: "adaptive", race: 2, exclude: [...], transport: "auto", maxInflight: 6 })`.
Biến môi trường: `LLMF_MODEL`, `LLMF_TIMEOUT`, `LLMF_PROXY`, `LLMF_ROUTING`, `LLMF_TRANSPORT`, `LLMF_CACHE_DIR`, `LLMF_NO_CACHE=1`.

## Tốc độ

- Kết nối tới mỗi host được **giữ và tái dùng**, nên các lệnh gọi lặp lại (chat nhiều lượt, `serve`, `doctor`) bỏ qua bước bắt tay TCP và TLS; kết nối bị server đóng sẽ tự thử lại một lần. Kết quả DNS được nhớ 2 phút, ưu tiên IPv4. `LLMF_NO_KEEPALIVE=1` để tắt.
- `llmf-js doctor` kiểm tra 2 model của cùng nhà cùng lúc (`--jobs N`, `--jobs 1` = từng cái một); nhà có giãn cách tối thiểu hoặc giới hạn đồng thời vẫn được giữ nhịp.
- Các lệnh không cần mạng (`version`, `-h`, `models`, `providers`) không nạp phần mạng khi khởi động.
- Độ trễ chủ yếu do các endpoint miễn phí (cùng một model có lúc 1 s, lúc 7 s), nên muốn so sánh hai công cụ hãy chạy xen kẽ, đừng chạy cái này rồi mới tới cái kia.

## Dòng lệnh

```bash
llmf-js "Giải thích event loop"
cat code.js | llmf-js "Review đoạn này" -m code
llmf-js chat
llmf-js models | doctor | providers | health | serve | version
llmf-js doctor --all --include-non-chat --include-limited     # kiểm tra thật mọi thứ
```
Kết quả `doctor` lưu ở `~/.cache/llmf/` (cùng định dạng với bản Python).

## `llmf-js serve`

```bash
llmf-js serve                                                    # http://127.0.0.1:8000/v1, chỉ cục bộ
llmf-js serve --cloudflare --ui                                  # web chat công khai (cần `cloudflared`: Termux `pkg install cloudflared`)
llmf-js serve --app "node main.js" --app-port 3000 --cloudflare  # chạy dự án Node của bạn + AI
llmf-js serve --html /sdcard/download/index.html --ui --public   # chỉ phục vụ đúng 1 file html
llmf-js serve --public --api-keys-file keys.txt --tls-cert c.pem --tls-key k.pem --allow-ip 203.0.113.0/24
```

Endpoint: `POST /v1/chat/completions` (stream), `GET /v1/models`, `GET /health`. Model lạ như `gpt-4o` = "tự động".

| Cờ | Tác dụng |
|---|---|
| `--public` | Hồ sơ internet: bind `0.0.0.0`, **bắt buộc API key** (tự sinh và in ra nếu bạn không đặt), giới hạn tốc độ, cấm IP, giới hạn body/token, anti-bot |
| `--cloudflare`, `--tunnel-token T` | Tunnel qua `cloudflared` của bạn; ngầm bật `--public` + `--trust-proxy` |
| `--ui` | Trang chat dựng sẵn (stream, lưu lịch sử, hiển thị an toàn) |
| `--html PATH` / `--web PATH` | 1 file (chỉ file đó) hoặc thư mục tĩnh (chặn `..`, file ẩn, symlink) |
| `--app "CMD"`, `--app-port`, `--app-dir` | Chạy dự án của bạn (nhận `$PORT`, `$OPENAI_BASE_URL`, `$OPENAI_API_KEY`) và reverse-proxy |
| `--api-key` (lặp được), `--api-keys-file` | Khoá Bearer |
| `--rate`, `--ip-rate`, `--session-rate` | Số request/phút theo key / IP / khách web |
| `--allow-ip`, `--deny-ip` | Danh sách CIDR |
| `--trust-proxy` | Lấy IP thật từ `CF-Connecting-IP`/`X-Forwarded-For`, **chỉ khi kết nối đến từ loopback** |
| `--cors`, `--cors-origin` | Mọi origin hoặc danh sách cho phép |
| `--max-body`, `--max-tokens-cap`, `--max-concurrent` | Giới hạn kích thước / tải |
| `--tls-cert`, `--tls-key` | HTTPS (TLS ≥ 1.2) + HSTS |
| `--antibot pow\|turnstile\|off` | Kiểm tra khách web (mặc định `pow` khi public) |
| `--log-file`, `--csp` | Log JSON (không có prompt/key); header CSP |

Trong trang web của bạn:
```html
<script src="/_llmf/client.js"></script>
<script>await llmf.stream([{role:"user",content:"Xin chào"}], {onDelta: (t, full) => out.textContent = full});</script>
```
Script tự giải proof-of-work và giữ token phiên ngắn hạn: **API key không bao giờ xuống trình duyệt**.

### Bảo mật: làm gì và không làm gì

- Upstream không đáng tin: redirect sang origin khác bỏ mọi header chứa thông tin đăng nhập, không hạ https xuống http, không đi từ host công khai vào địa chỉ nội bộ (chống SSRF), không tới URL không phải http(s); stream chỉ gửi keep-alive bị cắt sau thời gian timeout; giới hạn kích thước (kể cả sau gzip), dòng và thời gian.
- An toàn terminal: lệnh `llmf-js` lọc ký tự điều khiển/escape trong câu trả lời trước khi in, nên endpoint xấu không đổi được tiêu đề terminal, xoá màn hình hay ghi clipboard (`--json` giữ nguyên văn bản, đã được JSON escape).
- Bí mật: token tunnel truyền cho `cloudflared` qua biến môi trường, không nằm trên dòng lệnh; file log tạo với quyền `0600`; mật khẩu proxy bị che trong mọi thông báo. Trên máy dùng chung nên dùng `--api-keys-file` thay `--api-key` (tham số dòng lệnh hiện trong `ps`).
- Có: so khớp key thời gian hằng, key không vào log, cấm IP sau nhiều lần sai (15 phút), giới hạn theo key/IP/khách, trần số kết nối, giới hạn body/`max_tokens`, PoW ký HMAC dùng một lần gắn với IP (Turnstile xác thực phía server, lỗi thì chặn), header bảo mật + CSP, không chèn HTML, lỗi chung chung (không lộ stack trace), gỡ thông tin đăng nhập llmf trước khi proxy sang `--app`, header proxy chỉ tin từ loopback, request sai định dạng nhận lỗi JSON ngắn.
- **Không có**: đây không phải WAF/chống DDoS (hãy đặt Cloudflare phía trước); URL quick tunnel đổi mỗi lần chạy; chưa proxy WebSocket tới `--app`; `--app` chạy đúng lệnh bạn đưa; PoW chỉ làm tăng chi phí lạm dụng chứ không ngăn tuyệt đối; thông lượng thật vẫn bị các endpoint miễn phí chặn.
- Phát hiện lỗ hổng? Hãy mở *private security advisory* trên GitHub thay vì issue công khai.

## Nhà cung cấp

Thứ tự fallback: `ch-at → rewind-ai → ovh → kilo-openrouter → freeai → chatjimmy → kilo-gateway → pollinations → llm7 → blockrun → chatai` (`nottrack`, `notrack-ai`, `apifreellm` chỉ khi chỉ định). Xem bảng chi tiết ở [README.md](README.md#providers) hoặc chạy `llmf-js providers` / `llmf-js models`.

## Phát triển

```bash
git clone https://github.com/MoonLite-Br/llmfree && cd llmfree
node bin/llmf-js.js --help
```
Xem [CHANGELOG.md](CHANGELOG.md). MIT © 2026 Html / MoonLite-Br
