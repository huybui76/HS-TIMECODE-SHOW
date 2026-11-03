#!/usr/bin/env node
/* ============================================================
   Test vòng đời OSC HỆ THỐNG CHÍNH — chạy thật qua Chrome DevTools Protocol
   (bấm nút thật trong UI, không mock).

   Chạy app trước:
     npx electron . --remote-debugging-port=9222
   Rồi chạy:
     node tools/test-osc-lifecycle.js
   ============================================================ */
const { execSync } = require('child_process');
const dgram = require('dgram');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passCount = 0, failCount = 0;
function check(name, ok, detail) {
  console.log(`${ok ? '✓ PASS' : '✗ FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  ok ? passCount++ : failCount++;
}

/* ---------- CDP client ---------- */
let ws, msgId = 0;
const pending = new Map();
async function connectCdp() {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url)) || list.find((t) => t.type === 'page');
  if (!page) throw new Error('Không tìm thấy cửa sổ app (index.html)');
  await new Promise((res, rej) => {
    ws = new WebSocket(page.webSocketDebuggerUrl);
    ws.onopen = res;
    ws.onerror = () => rej(new Error('Kết nối CDP lỗi'));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
  });
}
async function evalJs(expr, timeoutMs = 15000) {
  return new Promise((res, rej) => {
    const id = ++msgId;
    const to = setTimeout(() => { pending.delete(id); rej(new Error('evalJs timeout: ' + expr.slice(0, 80))); }, timeoutMs);
    pending.set(id, (m) => {
      clearTimeout(to);
      if (m.result && m.result.exceptionDetails) {
        rej(new Error(m.result.exceptionDetails.exception && m.result.exceptionDetails.exception.description || 'JS lỗi'));
      } else {
        res(m.result && m.result.result ? m.result.result.value : undefined);
      }
    });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });
}

/* ---------- helpers ---------- */
function electronPids() {
  try {
    return execSync('ps -axo pid=,command=', { shell: '/bin/bash' }).toString()
      .split('\n').filter((l) => l.includes('HS TIMECODE/node_modules/electron'))
      .map((l) => parseInt(l.trim(), 10)).filter(Boolean);
  } catch (_) { return []; }
}
function cputimeSeconds() {
  // tổng CPU time (giây) của mọi process Electron của app
  let total = 0;
  for (const pid of electronPids()) {
    try {
      const t = execSync(`ps -o time= -p ${pid}`, { shell: '/bin/bash' }).toString().trim();
      // format: [[dd-]hh:]mm:ss hoặc m:ss.cc
      const parts = t.split(':').map((x) => parseFloat(x) || 0);
      if (parts.length === 3) total += parts[0] * 60 + parts[1] + parts[2] / 100;
      else if (parts.length === 4) total += (parts[0] * 24 + parts[1]) * 3600 + parts[2] * 60 + parts[3];
      else if (parts.length === 2) total += parts[0] * 60 + parts[1];
    } catch (_) { /* process chết giữa chừng */ }
  }
  return total;
}
function udp7000Bound() {
  try {
    const out = execSync('lsof -nP -iUDP:7000', { shell: '/bin/bash' }).toString();
    // chỉ tính socket BIND LOCAL :7000 — bỏ qua socket gửi của app khác (name dạng 'x->y:7000')
    return out.split('\n').some((l) => /UDP/.test(l) && /:7000(\s|$)/.test(l) && !l.includes('->'));
  } catch (_) { return false; }   // lsof exit 1 = không có socket nào
}
function electronUdpSockets() {
  try {
    const pids = electronPids().join(',');
    if (!pids) return '';
    // -a: AND giữa -iUDP và -p (không có -a thì lsof OR mọi thứ và trả cả hệ thống)
    return execSync(`lsof -a -nP -iUDP -p ${pids}`, { shell: '/bin/bash' }).toString();
  } catch (_) { return ''; }
}

/* Mã hoá OSC tối thiểu: address + args (int/float/string) */
function oscMsg(address, args = []) {
  const encStr = (s) => {
    const b = Buffer.from(s, 'utf8');
    return Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]);
  };
  let tags = ',', argBufs = [];
  for (const a of args) {
    if (typeof a === 'number' && Number.isInteger(a)) { tags += 'i'; const b = Buffer.alloc(4); b.writeInt32BE(a); argBufs.push(b); }
    else if (typeof a === 'number') { tags += 'f'; const b = Buffer.alloc(4); b.writeFloatBE(a); argBufs.push(b); }
    else { tags += 's'; argBufs.push(encStr(String(a))); }
  }
  return Buffer.concat([encStr(address), encStr(tags), ...argBufs]);
}
function sendUdp(port, buf) {
  const s = dgram.createSocket('udp4');
  s.send(buf, port, '127.0.0.1', () => s.close());
}

/* ============================================================ */
(async () => {
  await connectCdp();
  await sleep(1200);   // chờ did-finish-load push trạng thái lần đầu

  /* ---- TEST 1: mở app → Main OSC = OFF, không listener ---- */
  const pill1 = await evalJs(`document.getElementById('oscStatus').textContent`);
  const flag1 = await evalJs(`!!window.__oscListening`);
  check('T1: Mở app → OSC TẮT (pill + cờ + không bind :7000)',
    pill1 === 'TẮT' && flag1 === false && !udp7000Bound(),
    `pill="${pill1}" flag=${flag1} bind7000=${udp7000Bound()}`);

  /* ---- TEST 2: đứng yên 10s → không có socket/timer OSC nào chạy nền ---- */
  const cpu0 = cputimeSeconds();
  await sleep(10000);
  const cpuDelta = cputimeSeconds() - cpu0;
  // Assert cấu trúc: KHÔNG có socket UDP nào của app (OSC đóng hoàn toàn, không polling).
  // CPU chỉ mang tính thông tin: app idle vẫn có render loop canvas (không phải OSC);
  // app cũ trước khi sửa đốt 8.33s/10s vì phải xử lý ~7k packet/giây từ Resolume.
  check('T2: Idle 10s → không có socket UDP nào của app',
    electronUdpSockets().trim() === '',
    `CPU dùng thêm ${cpuDelta.toFixed(2)}s/10s (thông tin — render nền; app cũ: 8.33s/10s kèm xử lý OSC)`);

  /* ---- TEST 2b: port-set khi TẮT KHÔNG tự mở cổng (nạp project không bật OSC) ---- */
  await evalJs(`window.hs.setListenPort(7100)`);
  await sleep(400);
  const pill2b = await evalJs(`document.getElementById('oscStatus').textContent`);
  check('T2b: setListenPort khi TẮT → vẫn TẮT, không bind', !udp7000Bound() && pill2b === 'TẮT', `pill="${pill2b}"`);
  await evalJs(`window.hs.setListenPort(7000)`);

  /* ---- TEST 3: bấm "Bật OSC" → bind :7000, nghe thật ---- */
  await evalJs(`document.getElementById('btnOscToggle').click()`);
  await sleep(900);
  const pill3 = await evalJs(`document.getElementById('oscStatus').textContent`);
  check('T3: Bật OSC → ĐANG NGHE :7000, socket bind', pill3 === 'ĐANG NGHE :7000' && udp7000Bound(), `pill="${pill3}"`);

  /* ---- TEST 3b: gửi OSC vào 7000 → app nhận (OSC_SEEN chống race với flood Resolume) ---- */
  sendUdp(7000, oscMsg('/test/lifecycle', [42]));
  await sleep(700);
  const seen = await evalJs(`(() => { const it = OSC_SEEN.get('/test/lifecycle'); return it ? it.count : 0; })()`);
  check('T3b: OSC gửi tới :7000 được nhận', seen >= 1, `OSC_SEEN[/test/lifecycle].count = ${seen}`);

  /* ---- TEST 4: Tắt OSC → nhả cổng; gửi khi TẮT vẫn đi qua cổng riêng ---- */
  await evalJs(`document.getElementById('btnOscToggle').click()`);
  await sleep(500);
  const pill4 = await evalJs(`document.getElementById('oscStatus').textContent`);
  check('T4: Tắt OSC → TẮT, nhả :7000', pill4 === 'TẮT' && !udp7000Bound(), `pill="${pill4}"`);

  // Arena đã bind :7001 (Resolume Input) → test gửi tới cổng đích tạm 7177 rồi trả lại
  const TEST_RX_PORT = 7177;
  await evalJs(`(() => { const tp = document.getElementById('targetPort'); tp.value = ${TEST_RX_PORT}; tp.dispatchEvent(new Event('change')); })()`);
  await evalJs(`document.getElementById('testAddr').value = '/test/sendoff'`);
  await evalJs(`document.getElementById('testArgs').value = '1'`);
  // receiver phải SỐNG SÓT đến lúc gói tin tới: bind trước, bấm gửi trong lúc đang lắng nghe
  const got = await new Promise(async (res) => {
    const r = dgram.createSocket('udp4');
    const to = setTimeout(() => { r.close(); res(null); }, 3000);
    r.on('message', (m) => { clearTimeout(to); r.close(); res(m.toString('latin1')); });
    r.bind(TEST_RX_PORT);
    await sleep(300);   // chắc chắn bind xong rồi mới gửi
    await evalJs(`document.getElementById('btnTestSend').click()`);
  });
  await evalJs(`(() => { const tp = document.getElementById('targetPort'); tp.value = 7001; tp.dispatchEvent(new Event('change')); })()`);
  check('T4b: OSC TẮT vẫn gửi được (cổng riêng, không bind :7000)',
    !!got && got.includes('/test/sendoff') && !udp7000Bound(), `nhận: ${got ? got.split('\u0000')[0] : '(không)'}`);

  /* ---- TEST 5: Tool Test OSC — hoạt động như cũ, tự bật nghe khi bấm "Bắt đầu nhận" ---- */
  await evalJs(`openTestOsc()`);
  await sleep(200);
  // Một tick JS duy nhất: bấm "Bắt đầu nhận" → đọc trạng thái → đóng modal.
  // (Renderer bị Resolume flood ~7k packet/s khi modal mở — mỗi packet render lại bảng,
  //  nên phải thoát pha nghẽn trong 1 lần evaluate; logic tool không đổi.)
  const t5 = await evalJs(`(() => {
    TEST_OSC.max = 1000000;   // chống flood: giữ nguyên packet test khỏi bị shift() mất (chỉ dữ liệu test)
    document.getElementById('toStart').click();
    const st = { display: document.getElementById('testOscModal').style.display, on: TEST_OSC.on };
    document.getElementById('toClose').click();   // tool vẫn nhận (rows tích lũy), chỉ ẩn bảng
    return st;
  })()`);
  await sleep(900);
  check('T5: Mở Tool Test OSC + Bắt đầu nhận → cổng nghe bật (hành động người dùng)',
    t5.display === 'flex' && t5.on === true && udp7000Bound(), `modal=${t5.display} on=${t5.on}`);

  sendUdp(7000, oscMsg('/test/tool', ['abc']));
  await sleep(700);
  const rowsHas = await evalJs(`TEST_OSC.rows.some((r) => r.address === '/test/tool')`);
  check('T5b: Test OSC nhận đúng packet (logic cũ giữ nguyên)', rowsHas === true, `rows có /test/tool: ${rowsHas}`);

  await evalJs(`document.getElementById('toStop').click()`);
  await evalJs(`(() => { TEST_OSC.rows = TEST_OSC.rows.slice(-500); TEST_OSC.max = 500; })()`);
  await sleep(300);
  const toOff = await evalJs(`TEST_OSC.on`);
  check('T5c: Dừng Test OSC → tool tắt nhưng Main OSC vẫn ON (lifecycle độc lập)',
    toOff === false && udp7000Bound(), `on=${toOff} bind7000=${udp7000Bound()}`);

  /* ---- TEST 6: Main OSC OFF + Test OSC OFF → không còn listener nào ---- */
  await evalJs(`document.getElementById('btnOscToggle').click()`);
  await sleep(500);
  const pill6 = await evalJs(`document.getElementById('oscStatus').textContent`);
  check('T6: Tắt hết → không còn listener :7000', pill6 === 'TẮT' && !udp7000Bound(), `pill="${pill6}"`);

  /* ---- TEST 7: Đóng app → mọi socket OSC được cleanup ---- */
  for (const pid of electronPids()) { try { process.kill(pid, 'SIGTERM'); } catch (_) {} }
  await sleep(1500);
  check('T7: Đóng app → app thoát, không còn UDP socket',
    electronPids().length === 0 && !udp7000Bound(), `pids=${electronPids().length}`);

  console.log(`\n===== KẾT QUẢ: ${passCount} pass, ${failCount} fail =====`);
  process.exit(failCount ? 1 : 0);
})().catch((e) => { console.error('LỖI TEST:', e.message); process.exit(2); });
