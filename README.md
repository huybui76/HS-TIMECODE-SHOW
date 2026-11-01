# HS TIMECODE

Ứng dụng timecode trên **macOS** để **ghi lại OSC từ Resolume Arena** thành cue theo timecode — bạn gõ MIDI vào Resolume, mọi clip được kích hoạt sẽ được app ghi lại đúng thời điểm, sau đó phát lại tự động theo timecode.

## Tính năng

- **Đồng hồ timecode** HH:MM:SS:FF (24/25/30/60 fps), chạy theo nhạc nạp vào app hoặc tự do.
- **Nghe OSC từ Resolume** (UDP) và **ghi cue** theo timecode khi bật REC — mỗi clip bạn kích hoạt bằng MIDI trong Resolume thành 1 cue.
- **Bộ lọc ghi**: chỉ ghi `/connect` (khuyên dùng), connect + cột, tất cả trừ phản hồi tần suất cao, hoặc regex tuỳ chỉnh.
- **Chế độ ghi**: *Ghi thêm* (overdub) hoặc *Ghi đè* (xóa cue từ vị trí phát rồi ghi lại).
- **Phát lại cue**: gửi OSC đúng timecode về Resolume (tự động bật clip đúng lúc), có chế độ lặp, tốc độ 0.5×–2×.
- **Danh sách cue + timeline** nhiều lane (V1, V2… theo layer Resolume), sửa timecode, nudge ±1 frame.
- **Monitor OSC** xem trực tiếp mọi message Resolume gửi ra.
- **Gửi thử OSC** để kiểm tra kết nối Resolume.
- Lưu/mở dự án (⌘S / ⌘O), tự động lưu phiên làm việc.

## Cách chạy

Cần Node.js (đã có trên máy). Trong thư mục dự án:

```bash
npm start
```

Đóng gói thành app macOS (kết quả ở `dist/mac-arm64/HS TIMECODE.app`):

```bash
npm run dist
```

Test không cần mở Resolume (giả lập Resolume gửi connect + nhiễu):

```bash
npm run sim          # mặc định app nghe :7000, gửi về :7001
npm run sim 7100 7101  # nếu app nghe cổng khác
```

## Thiết lập Resolume Arena (quan trọng)

Trên máy này Resolume đang được cấu hình sẵn (app mặc định khớp luôn):

| Thiết bị | Cổng |
|---|---|
| HS TIMECODE **nghe** (Resolume OSC **Output** gửi về) | `7000` |
| HS TIMECODE **gửi lệnh** (Resolume OSC **Input**) | `7001` |

Trong Resolume: **Arena → Preferences → OSC**:
1. **Input** port: `7001` (mặc định của Resolume).
2. **Output**: bật lên, địa chỉ `127.0.0.1`, cổng `7000` — trỏ về HS TIMECODE.

> Nếu cổng 7000 báo "bận": đang có app khác chiếm (ví dụ 404TimeCode). Tắt app đó rồi bấm **Áp dụng** ở ô Cổng nghe, hoặc đổi sang cổng khác **và** đổi Output port trong Resolume cho khớp.

## Quy trình làm timecode cho show

1. **Chọn nhạc** (NGUỒN = Nhạc) hoặc để Tự do nếu đã có nhạc chạy nơi khác.
2. Bật **● REC** (phím `R`).
3. Bấm **▶** (Space) — đồng hồ chạy theo bài nhạc.
4. **Gõ MIDI** vào Resolume như biểu diễn bình thường — mỗi clip bật ra thành 1 cue trong DANH SÁCH CUE và trên timeline.
5. Bấm ■ để dừng. Muốn ghi thêm đoạn giữa: nhảy tới vị trí, chọn *Ghi thêm*; muốn ghi lại đoạn: chọn *Ghi đè*.
6. **Phát lại**: tắt REC, đưa về đầu, bấm ▶ — app tự gửi OSC đúng timecode, Resolume bật clip đúng lúc như đã diễn.

## Phím tắt

| Phím | Chức năng |
|---|---|
| `Space` | Phát / tạm dừng |
| `R` | Bật/tắt REC |
| `S` | Dừng, về đầu |
| `L` | Lặp |
| `Home` | Về đầu |
| `←` / `→` | Tua ±1 frame (`Shift` = ±1 giây) |
| `Delete` | Xóa cue đang chọn |
| `⌘S` / `⌘O` | Lưu / mở dự án |

## Cấu trúc dự án

```
main.js             – tiến trình chính: OSC UDP nghe/gửi, lưu/mở file, cửa sổ
preload.js          – cầu nối bảo mật main ↔ renderer
renderer/           – giao diện + đồng hồ timecode + ghi/phát cue + timeline
  index.html / style.css / app.js
tools/
  resolume-sim.js   – giả lập Resolume để test
  loopback-test.js  – test thư viện OSC
```

Cue được lưu dạng JSON: `{ frame, address, args, lane }` — frame ở fps hiện tại, address là địa chỉ OSC gốc Resolume gửi ra.
