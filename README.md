# jsjiami-deobf-api

API gỡ code obfuscate bằng jsjiami, dùng cho tab Deobfuscate của trang `obfuscate-js.html`.
Gói cả 3 script của bạn (`decrypt_v1.js`, `decrypt_v2.js`, `decrypt_v3.js`) lại thành một API cùng kiểu với API obfuscate: gửi JSON, nhận kết quả.

## Chạy trên máy bạn

```bash
npm install
npm start          # http://127.0.0.1:3000/api/deobfuscate
npm test           # 11 test, không cần file nào ngoài thư mục này
```

Mở trang, chuyển sang tab Deobfuscate, bấm "Kiểm tra kết nối". Địa chỉ mặc định của trang đã trỏ sẵn tới địa chỉ trên.
Chạy trên máy bạn là cách nên dùng cho file lớn (xem phần Giới hạn).

## Deploy lên Vercel

```bash
npx vercel          # lần đầu sẽ hỏi đăng nhập
npx vercel --prod
```

Sau đó dán địa chỉ dạng `https://ten-du-an.vercel.app/api/deobfuscate` vào ô "Địa chỉ API" của trang. Muốn đặt làm mặc định thì sửa hằng `DEFAULT_DEOBF_URL` ở đầu phần `<script>` trong `obfuscate-js.html`.

Mình chưa deploy thử lên Vercel (không có tài khoản ở đây), nên bước này bạn nên thử bằng một file nhỏ trước. `vercel.json` đã đặt `maxDuration: 60` và `includeFiles: "lib/**"` để worker được đóng gói kèm.

## Gọi API

```bash
curl -X POST http://127.0.0.1:3000/api/deobfuscate \
  -H "Content-Type: application/json" \
  -d '{"code": "...", "method": "jsjiami", "version": "auto"}'
```

| Trường | Ý nghĩa |
|---|---|
| `code` | Code cần gỡ (chuỗi). |
| `files` | Thay cho `code`: `[{ "name": "app.js", "code": "..." }, ...]`. Chỉ dùng với v2, để nối import giữa các chunk webpack. Trang web hiện chỉ gửi một file. |
| `method` | Hiện chỉ có `"jsjiami"`. |
| `version` | `"auto"` (mặc định), `"v1"`, `"v2"`, `"v3"`. |

Trả về `{ ok, version, code, notes, log, stats }`. `notes` là các cảnh báo tiếng Việt (ví dụ "không tìm thấy bộ giải mã chuỗi"), `log` là log gốc của script. Lỗi trả về `{ ok: false, error }` với mã 400 (đầu vào sai), 413 (quá lớn), 422 (code sai cú pháp), 504 (quá thời gian).

## 3 bộ gỡ

| | Dùng cho | Làm gì |
|---|---|---|
| v1 | jsjiami v6 (`var _0x... = 'jsjiami.com.v6'`, mảng chuỗi + vòng xoay + decoder RC4) | Thay chuỗi thật vào code rồi dọn từ điển, hàm và hằng số rác. |
| v2 | Bundle webpack bị obfuscate | Gỡ chuỗi rồi tách module webpack cho dễ đọc, nối import giữa các file nếu gửi nhiều file. |
| v3 | Code có bộ giải mã chuỗi dùng chung (tên kiểu `a0_0x...`) | Gỡ chuỗi, control flow flattening và bẫy chống format. |

`auto` chọn v1 khi thấy chuỗi `jsjiami.com.v6`, còn lại chọn v3. Muốn dùng v2 thì chọn tay. Đây là đoán theo dấu hiệu, không phải đảm bảo.

## Khác với script gốc

Các bước xử lý giữ nguyên. Chỉ đổi những chỗ phụ thuộc Node, ghi rõ ở đầu mỗi file trong `lib/`:

1. **Đọc/ghi file** thay bằng nhận và trả chuỗi (v2: danh sách file trong bộ nhớ).
2. **`new Function(...)` chạy decoder** thay bằng `vm` có giới hạn thời gian, chạy trong worker thread có giới hạn bộ nhớ.
3. **v1 không còn chép cứng** mảng chuỗi và tên hàm `_0x1e77` của một file. Giờ nó tự tìm mảng, vòng xoay và decoder trong file đầu vào.

Một thay đổi ảnh hưởng tới kết quả: decoder của một số file (ví dụ `2.js`) có bẫy chống format. Nó kiểm tra mã nguồn của chính hàm đó, và nếu có xuống dòng đúng vị trí thì trả số đếm thay cho ký tự giải mã. `decrypt_v3.js` gốc tạo lại hàm bằng Babel (đã format), nên bẫy kích hoạt và ký tự thứ 9 của mọi chuỗi dài bị thay bằng `12` (`prototype` thành `prototyp12`). Lỗi này làm hỏng cả bước gỡ control flow flattening ở một số hàm, vì chuỗi thứ tự `"1|2|0|3|4"` cũng bị đổi. Sandbox ở đây chuẩn hoá `toString()` nên bẫy không kích hoạt. File `v2-deobf-source/2.js` trong repo gốc mang lỗi này. Mình chỉ thấy lỗi ở `2.js` khi chạy v3. Kết quả v2 và v3 trên các file còn lại (`4.js`, `intro.js`, `crypto.js`, `core.js`, `vue-runtime.js`, `chunk-vendors.js`, `element-ui.js`, `videoPlayer.js`) khớp với repo gốc.

## Giới hạn

- Body tối đa 4 MB mỗi lần (Vercel chặn ở 4,5 MB).
- Thời gian tối đa 55 giây (đổi bằng biến môi trường `DEOBF_TIMEOUT_MS`), bộ nhớ worker 1200 MB (`DEOBF_MAX_MB`). Trên Vercel còn bị giới hạn theo gói. File vài trăm KB mất vài giây, file vài MB có thể mất cả phút, nên file lớn hãy chạy bằng `npm start`.
- Chỉ gỡ jsjiami. Code từ công cụ khác (obfuscator.io thường, JS-Confuser...) thường không gỡ được.
- Bộ decoder lấy từ chính file bạn gửi nên được chạy thử trên server. Có giới hạn thời gian và bộ nhớ, nhưng `vm` không phải ranh giới bảo mật tuyệt đối. Chỉ gỡ code bạn tin cậy, và đừng mở API này công khai cho người lạ. Nếu deploy, đặt biến môi trường `ALLOWED_ORIGIN` thành địa chỉ trang của bạn để chỉ trang đó gọi được từ trình duyệt.
