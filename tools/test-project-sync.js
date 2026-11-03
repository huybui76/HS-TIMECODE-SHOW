'use strict';
/* ===== ACCEPTANCE TEST — SMALL (Mini) chọn bài + đồng bộ 2 chiều với cửa sổ chính =====
   Cần app mở với --remote-debugging-port=9333. Chạy sau test-project-isolation.js (có sẵn 2 bài trong autosave). */
const WebSocket = require('ws');
const http = require('http');

function getTargets() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9333/json', (res) => {
      let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}
class Page {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 });
    this.id = 0; this.pending = new Map(); this.logs = [];
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id); this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        this.logs.push('[EXCEPTION] ' + msg.params.exceptionDetails.text);
      }
    });
  }
  ready() { return new Promise((r) => this.ws.on('open', r)); }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, replMode: true });
    if (r.exceptionDetails) return { threw: true, text: r.exceptionDetails.text };
    return r.result.value;
  }
  send(method, params) {
    return new Promise((resolve, reject) => {
      const mid = ++this.id; this.pending.set(mid, { resolve, reject });
      this.ws.send(JSON.stringify({ id: mid, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch (_) {} }
}
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ LỖI: ') + msg); if (!cond) fails++; };

(async () => {
  let targets = await getTargets();
  const main = new Page(targets.find((t) => t.title === 'HS TIMECODE').webSocketDebuggerUrl);
  await main.ready();
  await main.send('Runtime.enable', {});
  await main.send('Page.enable', {});
  await main.send('Page.reload', {});
  await sleep(3000);

  // state: từ autosave của test isolation — 2 bài (Bài 1, Bài 2). Nếu thiếu → tự tạo.
  const prep = await main.ev(`
    (function () {
      if (state.folders.length >= 2) return { folders: state.folders.map(f => ({ id: f.id, name: f.name })) };
      const f = state.folders[0]; f.name = 'Bài 1';
      addFolder('Bài 2');
      for (let i = 0; i < 5; i++) { const d = makeDef('/s/cue' + i, [1]); d.name = 'Cue' + i; f.cues.push(d); insertCue(f, makePlacement(i * 30, d.id)); }
      return { folders: state.folders.map(x => ({ id: x.id, name: x.name })) };
    })()
  `);
  console.log('projects:', JSON.stringify(prep));
  await main.ev(`(function(){ switchProject(state.folders[0].id); return true; })()`);
  await sleep(300);

  /* mở SMALL bằng nút trên toolbar */
  console.log('\n== SYNC TEST 7: SMALL hiển thị danh sách bài, highlight đúng bài đang mở ==');
  await main.ev(`document.getElementById('btnMini').click()`);
  await sleep(2000);
  targets = await getTargets();
  const miniT = targets.find((t) => t.title === 'HS TIMECODE · Mini');
  if (!miniT) { console.log('KHÔNG MỞ ĐƯỢC MINI'); process.exit(1); }
  const mini = new Page(miniT.webSocketDebuggerUrl);
  await mini.ready();
  await mini.send('Runtime.enable', {});
  await sleep(800);
  const list1 = await mini.ev(`
    (() => {
      const rows = [...document.querySelectorAll('.proj-row')];
      return { names: rows.map(r => r.querySelector('.pname').textContent),
               openIdx: rows.findIndex(r => r.classList.contains('open')),
               noTimeline: !document.querySelector('#timeline') && !document.querySelector('canvas'),
               hasPlayPauseStop: !!document.getElementById('mPlay') && !!document.getElementById('mPause') && !!document.getElementById('mStop') };
    })()
  `);
  console.log('mini list:', JSON.stringify(list1));
  ok(list1.names.length >= 2, `SMALL liệt kê đủ các bài (${list1.names.join(', ')})`);
  ok(list1.openIdx === 0, 'SMALL highlight đúng bài đang mở ở cửa sổ chính (Bài 1)');
  ok(list1.noTimeline, 'SMALL KHÔNG có timeline/waveform (chỉ chọn bài + playback)');
  ok(list1.hasPlayPauseStop, 'SMALL có đủ nút PLAY / PAUSE / STOP');

  /* Trường hợp 1: chọn bài trong SMALL → cửa sổ chính chuyển theo */
  console.log('\n== SYNC TEST 7b: click Bài 2 trong SMALL → cửa sổ chính mở Bài 2 ==');
  const f2id = prep.folders[1].id;
  await mini.ev(`
    (() => {
      const rows = [...document.querySelectorAll('.proj-row')];
      rows[1].click();
      return true;
    })()
  `);
  await sleep(800);
  const m7 = await main.ev(`({ cur: curFolder().name, curId: curFolder().id, songs: state.songs.length })`);
  const s7 = await mini.ev(`
    (() => { const rows = [...document.querySelectorAll('.proj-row')]; return { openIdx: rows.findIndex(r => r.classList.contains('open')), running: rows.findIndex(r => r.classList.contains('running')) }; })()
  `);
  ok(m7.curId === f2id && m7.cur === 'Bài 2', `Cửa sổ chính tự chuyển sang Bài 2 (đang mở: ${m7.cur})`);
  ok(s7.openIdx === 1, 'SMALL highlight chuyển theo (Bài 2)');

  /* Trường hợp 2: chọn bài trong cửa sổ chính → SMALL cập nhật */
  console.log('\n== SYNC TEST 8: chọn Bài 1 ở cửa sổ chính → SMALL cập nhật highlight ==');
  await main.ev(`
    (function () {
      const heads = [...document.querySelectorAll('.folder .fhead')];
      const h = heads[0];
      h.click();               // click bài đầu tiên = switchProject + collapse toggle
      return true;
    })()
  `);
  await sleep(800);
  const m8 = await main.ev(`({ cur: curFolder().name })`);
  const s8 = await mini.ev(`(() => { const rows = [...document.querySelectorAll('.proj-row')]; return rows.findIndex(r => r.classList.contains('open')); })()`);
  ok(m8.cur === 'Bài 1' && s8 === 0, `Chọn Bài 1 ở chính → SMALL highlight Bài 1 (openIdx=${s8})`);

  /* Trường hợp 3: PLAY/PAUSE từ SMALL → engine chính */
  console.log('\n== SYNC TEST 9: PLAY/PAUSE ở SMALL điều khiển engine chính ==');
  await mini.ev(`document.getElementById('mPlay').click()`);
  await sleep(700);
  const m9 = await main.ev(`({ playing: state.playing, frame: Math.round(state.frame) })`);
  ok(m9.playing === true, 'PLAY ở SMALL → cửa sổ chính đang phát (1 engine duy nhất)');
  await sleep(500);
  const badge = await mini.ev(`(() => { const rows = [...document.querySelectorAll('.proj-row')]; return { run: rows.findIndex(r => r.classList.contains('running')), st: document.getElementById('miniStatus').textContent }; })()`);
  ok(badge.run === s8 && badge.st.includes('PHÁT'), `SMALL hiện "● ĐANG CHẠY" trên bài đúng (${badge.st})`);
  await mini.ev(`document.getElementById('mPause').click()`);
  await sleep(500);
  const m9b = await main.ev(`({ playing: state.playing })`);
  ok(m9b.playing === false, 'PAUSE ở SMALL → engine chính dừng');
  // STOP từ cửa sổ chính → SMALL phản chiếu
  await main.ev(`document.getElementById('btnPlay').click()`);   // phát lại từ chính
  await sleep(400);
  await main.ev(`document.getElementById('btnStop').click()`);   // stop từ chính
  await sleep(600);
  const s9c = await mini.ev(`document.getElementById('miniStatus').textContent`);
  ok(!s9c.includes('ĐANG PHÁT'), 'STOP ở cửa sổ chính → SMALL phản chiếu trạng thái dừng');

  /* TEST 10: đóng SMALL → cửa sổ chính vẫn hoạt động bình thường */
  console.log('\n== SYNC TEST 10: đóng SMALL → cửa sổ chính vẫn chạy tốt ==');
  // đóng ĐÚNG cửa sổ SMALL: Page.close phải gửi trên kết nối CDP của MINI
  // (gửi trên kết nối của main sẽ đóng nhầm cửa sổ chính!)
  try { await mini.send('Page.close', {}); } catch (_) {}
  try { await mini.close(); } catch (_) {}
  await sleep(1500);
  targets = await getTargets();
  ok(!targets.some((t) => t.title === 'HS TIMECODE · Mini'), 'Cửa sổ SMALL đã đóng');
  ok(targets.some((t) => t.title === 'HS TIMECODE'), 'Cửa sổ chính vẫn mở');
  const m10 = await main.ev(`(function () { setFrame(0); state.playbackIdx = 0; document.getElementById('btnPlay').click(); return true; })()`);
  await sleep(700);
  const m10b = await main.ev(`({ playing: state.playing, frame: Math.round(state.frame) })`);
  ok(m10b.playing && m10b.frame > 0, 'Sau khi đóng SMALL, playback ở cửa sổ chính vẫn hoạt động bình thường');

  console.log('\n---- exceptions ----');
  main.logs.forEach((l) => console.log(l));
  if (main.logs.length) fails++;
  main.close();
  console.log(fails === 0 ? '\n★ PROJECT SYNC (SMALL) TESTS: TẤT CẢ ĐẠT ✔' : `\n★ ${fails} TEST THẤT BẠI ✗`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('DRIVER ERROR', e); process.exit(1); });
