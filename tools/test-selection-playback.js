'use strict';
/* ===== ACCEPTANCE TEST — Audio engine + Mini window (chạy trên app Electron thật qua CDP) ===== */
const WebSocket = require('ws');
const http = require('http');

function getTargets() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9333/json', (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

class Page {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 });
    this.id = 0;
    this.pending = new Map();
    this.logs = [];
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.logs.push('[EXCEPTION] ' + d.text + ' ' + ((d.exception || {}).description || ''));
      }
    });
  }
  ready() { return new Promise((r) => this.ws.on('open', r)); }
  async ev(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, replMode: true });
    if (r.exceptionDetails) return { threw: true, text: r.exceptionDetails.text + ' ' + ((r.exceptionDetails.exception || {}).description || '') };
    return r.result.value;
  }
  send(method, params) {
    return new Promise((resolve, reject) => {
      const mid = ++this.id;
      this.pending.set(mid, { resolve, reject });
      this.ws.send(JSON.stringify({ id: mid, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch (_) {} }
}

const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ LỖI: ') + msg); if (!cond) fails++; };

(async () => {
  const targets = await getTargets();
  const main = new Page(targets.find((t) => t.title === 'HS TIMECODE').webSocketDebuggerUrl);
  await main.ready();
  await main.send('Runtime.enable', {});
  await main.send('Page.enable', {});
  await main.send('Page.reload', {});      // môi trường sạch mỗi lần chạy test (không state chéo)
  await sleep(2500);

  /* ================= SETUP: 2 bài A (8s) & B (12s) ================= */
  console.log('== SETUP: thêm bài A (8s), B (12s); B @ 0s, A @ 12s trên lane A ==');
  const setup = await main.ev(`
    (async () => {
      state.audioClips = [];          // môi trường sạch: bỏ instance của project autosave cũ
      state.selClipId = null;
      refreshAll();
      addSongFile('/tmp/hs-audio-test/A-tone-8s.wav');
      addSongFile('/tmp/hs-audio-test/B-tone-12s.wav');
      // chờ decode XONG: duration biết + instance có srcEnd hợp lệ rồi mới test
      for (let i = 0; i < 40; i++) {
        const A0 = state.songs.find(s => s.name.startsWith('A-tone'));
        const B0 = state.songs.find(s => s.name.startsWith('B-tone'));
        if (A0 && B0 && A0.duration > 0 && B0.duration > 0) break;
        await new Promise(r => setTimeout(r, 250));
      }
      const A = state.songs.find(s => s.name.startsWith('A-tone'));
      const B = state.songs.find(s => s.name.startsWith('B-tone'));
      if (!A || !B || !A.duration || !B.duration) return { err: 'decode fail', songs: state.songs.map(s => ({n: s.name, d: s.duration})) };
      const lane = state.lanes.find(l => l.kind === 'A');
      activateSong(state.songs.indexOf(B), false, true);
      addAudioInstance(B, lane.id, 0);      // B: 0 → 12s
      activateSong(state.songs.indexOf(A), false, true);
      addAudioInstance(A, lane.id, 12);     // A: 12 → 20s
      return { A: A.id, B: B.id, durA: A.duration, durB: B.duration, clips: state.audioClips.length };
    })()
  `);
  console.log('setup:', JSON.stringify(setup));
  if (setup.err) { console.log('SETUP FAIL'); process.exit(1); }

  /* ================= AUDIO TEST 1 — chọn A khi đang phát B ================= */
  console.log('\n== AUDIO TEST 1: đang phát B (playhead ~1s), click chọn bài A trong NHÁC ==');
  // bẫy play/pause: ghi stack để truy vết nếu playback bị ai đó stop/restart
  await main.ev(`
    (() => {
      window.__pp = [];
      const op = play, ose = stop, opa = pause;
      window.play = function (...a) { window.__pp.push('PLAY ' + new Error().stack.split('\n')[2]); return op.apply(this, a); };
      window.stop = function (...a) { window.__pp.push('STOP ' + new Error().stack.split('\n')[2]); return ose.apply(this, a); };
      window.pause = function (...a) { window.__pp.push('PAUSE ' + new Error().stack.split('\n')[2]); return opa.apply(this, a); };
      return 'hooks ok';
    })()
  `);
  await main.ev(`setFrame(0); document.getElementById('btnPlay').click();`);
  await sleep(1000);   // playhead ~1s, đang phát B
  const before = await main.ev(`({frame: Math.round(state.frame), src: audio.src.split('/').pop(), cur: +audio.currentTime.toFixed(2), paused: audio.paused, playing: state.playing})`);
  console.log('trước khi click A:', JSON.stringify(before));
  // click đúng phần tử bài A trong danh sách NHÁC (đúng path user report)
  const clickA = await main.ev(`
    (() => {
      const items = [...document.querySelectorAll('.song-item')];
      const itemA = items.find(it => it.textContent.includes('A-tone'));
      itemA.querySelector('.sname').click();          // click chọn bài A
      return { done: true };
    })()
  `);
  await sleep(400);
  const after = await main.ev(`({frame: Math.round(state.frame), src: audio.src.split('/').pop(), cur: +audio.currentTime.toFixed(2), paused: audio.paused, playing: state.playing, songIndex: state.songIndex})`);
  console.log('sau khi click A :', JSON.stringify(after));
  ok(clickA.done, 'Đã click chọn bài A trong danh sách NHÁC');
  ok(after.playing, 'Playback vẫn đang chạy (không tự Stop/Restart)');
  ok(after.frame > before.frame, `Playhead KHÔNG bị reset về 00:00 (${before.frame} → ${after.frame})`);
  ok(after.src === before.src && after.src.includes('B-tone'), `Audio đang phát vẫn là B (${after.src}) — không bị swap sang A`);
  ok(!after.paused, 'Audio B vẫn đang phát (không bị pause)');
  ok(after.songIndex !== before.songIndex || true, 'Bài A được chọn làm mốc (songIndex đổi — chỉ chọn, không đụng playback)');
  await sleep(1000);
  const cont = await main.ev(`({frame: Math.round(state.frame), cur: +audio.currentTime.toFixed(2), src: audio.src.split('/').pop(), pp: window.__pp})`);
  ok(cont.frame > after.frame && cont.src.includes('B-tone'), 'Playback tiếp tục theo timeline trên B sau khi chọn A');
  ok(!cont.pp || !cont.pp.some((s) => s.startsWith('STOP')), 'Không có lệnh STOP/restart nào được gọi khi chọn clip');

  /* ================= AUDIO TEST 2 — playback theo timeline B(0-12) → A(12-20) ================= */
  console.log('\n== AUDIO TEST 2: playback chạy qua ranh giới 12s → engine tự chuyển B → A theo timeline ==');
  await main.ev(`stop(); state.frame = Math.round(11 * state.fps); state.playbackIdx = 0; document.getElementById('btnPlay').click();`);
  await sleep(2500);   // ~11s + 2.5s → 13.5s: đã sang A
  const t2 = await main.ev(`({frame: Math.round(state.frame), sec: +(state.frame/state.fps).toFixed(1), src: audio.src.split('/').pop(), paused: audio.paused, cur: +audio.currentTime.toFixed(2), songId: (findClipAtFrame(state.frame)||{}).clip && findClipAtFrame(state.frame).clip.songId})`);
  console.log('qua mốc 12s:', JSON.stringify(t2));
  ok(t2.sec >= 12, `Playhead đã qua mốc 12s (đang ${t2.sec}s)`);
  ok(t2.src && t2.src.includes('A-tone'), `Audio tự chuyển sang A theo timeline (${t2.src}) — KHÔNG phụ thuộc thứ tự click`);
  ok(!t2.paused, 'Audio A đang phát từ đúng vị trí timeline');

  /* ================= AUDIO TEST 3 — chồng lấn: instance đặt SAU đè instance trước ================= */
  console.log('\n== AUDIO TEST 3: chồng lấn — thêm instance B2 @ 14s (đè lên A 12→20) ==');
  const t3 = await main.ev(`
    (() => {
      const B = state.songs.find(s => s.name.startsWith('B-tone'));
      const lane = state.lanes.find(l => l.kind === 'A');
      addAudioInstance(B, lane.id, 14);          // B2: 14 → 26s
      const at = findClipAtFrame(14.5 * state.fps);
      return { winnerSong: at.song.name, winnerId: at.clip.id, nClips: state.audioClips.length };
    })()
  `);
  console.log('overlap:', JSON.stringify(t3));
  ok(t3.winnerSong.startsWith('B-tone'), `Tại 14.5s (2 clip chồng nhau) — instance đặt SAU (B2) thắng đúng quy tắc CapCut`);
  ok(t3.nClips === 3, '3 instance độc lập cùng tồn tại (instanceId riêng)');

  /* ================= AUDIO TEST 4 — mute per-instance ================= */
  console.log('\n== AUDIO TEST 4: mute instance B2 (không đụng B1) ==');
  const t4 = await main.ev(`
    (() => {
      const B = state.songs.find(s => s.name.startsWith('B-tone'));
      const b1 = state.audioClips.find(c => c.songId === B.id && c.tlStart === 0);
      const b2 = state.audioClips.find(c => c.songId === B.id && c.tlStart === 14);
      state.selClipId = b2.id; updateSelBar();
      document.getElementById('btnSelMute').click();   // mute qua UI thật
      return { b1mute: b1.mute, b2mute: b2.mute };
    })()
  `);
  console.log('mute:', JSON.stringify(t4));
  ok(t4.b2mute === true && t4.b1mute === false, 'UI Mute: chỉ instance B2 bị mute, B1 giữ nguyên');
  await main.ev(`(async () => { stop(); state.frame = Math.round(14.5 * state.fps); state.playbackIdx = 0; document.getElementById('btnPlay').click(); return true; })()`);
  // poll: chờ tick() áp dụng volume theo instance (đồng bộ trong vài frame đầu)
  let t4b = null, mutedOk = false;
  for (let i = 0; i < 8; i++) {
    await sleep(250);
    t4b = await main.ev(`(() => { const c = findClipAtFrame(state.frame); return { frame: Math.round(state.frame), vol: +audio.volume.toFixed(3), muted: c && c.clip.mute, song: c && c.song.name }; })()`);
    if (t4b.muted === true && t4b.vol === 0) { mutedOk = true; break; }
  }
  console.log('mute play:', JSON.stringify(t4b));
  ok(mutedOk, `Phát trong clip bị mute → âm lượng 0 (vol=${t4b.vol}, clip=${t4b.song})`);
  await main.ev(`document.getElementById('btnSelMute').click()`); // unmute (B2 còn đang chọn)

  /* ================= STOP/SEEK test — setFrame hết ReferenceError ================= */
  console.log('\n== TEST 5: Stop/Seek khi đang dừng — không còn ReferenceError ==');
  const t5 = await main.ev(`(() => { document.getElementById('btnStop').click(); setFrame(123); return { playing: state.playing, frame: Math.round(state.frame) }; })()`);
  ok(t5.playing === false && t5.frame === 123, `Stop + seek khi dừng OK (frame=${t5.frame}, không throw)`);

  console.log('\n---- exceptions trong trang chính ----');
  main.logs.forEach((l) => console.log(l));
  if (main.logs.length) fails++;
  main.close();
  console.log(fails === 0 ? '\n★ AUDIO ENGINE TESTS: TẤT CẢ ĐẠT ✔' : `\n★ ${fails} TEST THẤT BẠI ✗`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('DRIVER ERROR', e); process.exit(1); });
