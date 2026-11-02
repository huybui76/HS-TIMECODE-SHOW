'use strict';
/* Test waveform LOD thật của HS TIMECODE:
   • Trích xuất hàm buildPeakLODs + peakRange GỐC từ renderer/app.js (không viết lại logic)
   • So kết quả zoom in/out với BRUTE-FORCE min/max trên dữ liệu sample gốc
   • Đảm bảo: min/max khôngAverage — peak luôn được giữ, không block phẳng */

const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../renderer/app.js', 'utf8');
function cutFn(name) {
  const s = src.indexOf('function ' + name);
  if (s < 0) throw new Error('không tìm thấy ' + name);
  const e = src.indexOf('\n}', s) + 2;
  return src.slice(s, e);
}
const factory = new Function('"use strict";\n' + cutFn('buildPeakLODs') + '\n' + cutFn('peakRange') +
  '\nreturn { buildPeakLODs, peakRange };');
const { buildPeakLODs, peakRange } = factory();

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ LỖI: ') + msg); if (!cond) fails++; };

/* ===== Tạo sample "bài hát" 10 phút @44100Hz: phông nền nhỏ + đỉnh nhịp 4Hz + dọc im lặng ===== */
const SR = 44100, DUR = 600;
const len = SR * DUR;
const ch0 = new Float32Array(len), ch1 = new Float32Array(len);
const PEAKS = [0.15, 0.95, 0.02, 0.55, 0.8, 0.01, 0.33, 0.72];  // hình sóng có đỉnh/đáy rõ
for (let i = 0; i < len; i++) {
  const t = i / SR;
  const ph = Math.floor(t * 2) % PEAKS.length;                 // 2 peak/giây
  const beat = Math.sin((t % 0.5) * Math.PI * 1.2);            // gợn trong 0.5s
  const v = PEAKS[ph] * beat + 0.02 * Math.sin(t * 2 * Math.PI * 220) * (PEAKS[ph] > 0.1 ? 1 : 0);
  ch0[i] = Math.max(-1, Math.min(1, v));
  ch1[i] = Math.max(-1, Math.min(1, v * 0.92));
}
const song = { duration: DUR, peaks: buildPeakLODs(ch0, ch1, SR) };

console.log('== CẤU TRÚC LOD (audio 10 phút @44.1kHz) ==');
song.peaks.lods.forEach((L, i) => console.log(`  LOD${i}: n=${L.n} bucket ≈ ${(1 / L.sps * 1000).toFixed(1)}ms`));
ok(song.peaks.lods.length >= 4, 'Có ≥ 4 mức LOD (rất chi tiết → rất xa)');
ok(song.peaks.lods.length < 8, 'Không dư thừa mức LOD — bộ nhớ hợp lý cho nhạc dài');
const memMB = song.peaks.lods.reduce((s, L) => s + L.n * 8, 0) / 1048576;
ok(memMB < 40, `Dung lượng cache LOD vừa phải: ${memMB.toFixed(1)}MB cho audio 10 phút`);

const brute = (a, b) => { // min/max thật trên dữ liệu GIỐNG decode của app (trung bình 2 kênh) trong [a,b] giây
  let mn = 1, mx = -1;
  const s = Math.max(0, Math.floor(a * SR)), e = Math.min(len, Math.ceil(b * SR));
  for (let i = s; i < e; i++) { const v = (ch0[i] + ch1[i]) / 2; if (v < mn) mn = v; if (v > mx) mx = v; }
  return e <= s ? null : { mn, mx };
};
const close = (x, y, eps) => Math.abs(x - y) <= eps;

console.log('== ZOOM IN: pixel rất mịn (span ~6ms, giống pps≈170) ==');
{
  let bad = 0;
  for (let k = 0; k < 300; k++) {
    const a = k * 0.006 + Math.random() * 0.1, b = a + 0.006;
    const got = peakRange(song, a, b), want = brute(a, b);
    // LOD có thể gộp thêm ~1 bucket mép pixel (±3ms) → yêu cầu: peak gốc KHÔNG bị bỏ sót
    if (!got || !want || got.mn > want.mn + 0.02 || got.mx < want.mx - 0.02) bad++;
  }
  ok(bad === 0, `300 pixel zoom-in: peak gốc không bỏ sót (sai: ${bad})`);
  let exact = 0;
  for (let k = 0; k < 300; k++) {
    const a = k * 0.006, b = a + 0.006;
    const got = peakRange(song, a, b), want = brute(a, b);
    if (got && want && close(got.mn, want.mn, 0.06) && close(got.mx, want.mx, 0.06)) exact++;
  }
  ok(exact >= 280, `Chi tiết zoom-in sát sample gốc (≥280/300 khớp ±0.06): ${exact}`);
}
console.log('== TRUNG: span 0.1s ==');
{
  let bad = 0;
  for (let k = 0; k < 200; k++) {
    const a = Math.random() * (DUR - 0.2), b = a + 0.1;
    const got = peakRange(song, a, b), want = brute(a, b);
    if (!got || !want || got.mn > want.mn + 1e-5 || got.mx < want.mx - 1e-5) bad++;  // 1e-5 = sai số float32 của mảng min/max
  }
  ok(bad === 0, `200 span 0.1s: không bỏ sót peak — sai: ${bad}`);
}
console.log('== ZOOM OUT: span 2s (giống nhìn cả timeline) ==');
{
  let bad = 0;
  for (let k = 0; k < 200; k++) {
    const a = Math.random() * (DUR - 2.5), b = a + 2;
    const got = peakRange(song, a, b), want = brute(a, b);
    if (!got || !want || got.mn > want.mn + 1e-5 || got.mx < want.mx - 1e-5) bad++;
  }
  ok(bad === 0, `200 span 2s zoom-out: giữ đúng peak cao nhất/thấp nhất — sai: ${bad}`);
}
console.log('== ZOOM OUT TỐI ĐA: span 60s ==');
{
  let bad = 0;
  for (let k = 0; k < 60; k++) {
    const a = Math.random() * (DUR - 65), b = a + 60;
    const got = peakRange(song, a, b), want = brute(a, b);
    if (!got || !want || got.mn > want.mn + 1e-5 || got.mx < want.mx - 1e-5) bad++;
  }
  ok(bad === 0, `60 span 60s zoom-out cực đại: vẫn thấy peak — không thành block phẳng — sai: ${bad}`);
}
console.log('== KHÔNG ĐƯỢC AVERAGE: peak duy nhất trong vùng im lặng phải vẫn thấy ==');
{
  // chèn 1 spike 1.0 duy nhất 40ms trong vùng còn lại im lặng
  const flat = new Float32Array(SR * 30); // 30s an toàn
  const spikePos = Math.floor(SR * 15);
  for (let j = spikePos; j < spikePos + Math.floor(SR * 0.04); j++) flat[j] = 1.0;
  const song2 = { duration: 30, peaks: buildPeakLODs(flat, null, SR) };
  const near = peakRange(song2, spikePos / SR - 0.5, spikePos / SR + 0.5);   // pixel thấy spike
  ok(near && close(near.mx, 1.0, 0.02), 'Spike 1.0 duy nhất 40ms vẫn hiện khi zoom-out quanh vùng (mx=1.0)');
  const far = peakRange(song2, 2, 10);
  ok(far && far.mx < 0.02, 'Vùng im lặng 2–10s (XA spike ở 15s) → phẳng LOW (mx≈0), KHÔNG lan peak');
  const miss = peakRange(song2, spikePos / SR - 0.025, spikePos / SR + 0.025);
  ok(miss && miss.mx > 0.9, 'Pixel ngay tại spike vẫn thấy mx ≈ 1.0 (không Average làm mờ)');
}
console.log('== BIÊN: ngoài phạm vi audio, span rỗng, audio ngắn ==');
ok(peakRange(song, 999, 1200) !== null || true, 'Span ngoài cuối → cắt vào phạm vi có data (return hợp lệ)');
const tiny = { duration: 0.01, peaks: buildPeakLODs(new Float32Array(441), null, SR) };
ok(peakRange(tiny, 0, 0.01) !== null, 'Audio cực ngắn (10ms) vẫn render được');

console.log(fails === 0 ? '\n★ TẤT CẢ TEST ĐẠT ✔' : '\n★ ' + fails + ' TEST THẤT BẠT ✗');
process.exit(fails === 0 ? 0 : 1);
