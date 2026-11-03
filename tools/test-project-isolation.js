'use strict';
/* ===== ACCEPTANCE TEST — ĐỘC LẬP PROJECT (mỗi Bài = project riêng) =====
   Chạy trên app Electron thật qua CDP. Yêu cầu app mở với --remote-debugging-port=9333. */
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
        this.logs.push('[EXCEPTION] ' + msg.params.exceptionDetails.text + ' ' + ((msg.params.exceptionDetails.exception || {}).description || ''));
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
  const targets = await getTargets();
  const main = new Page(targets.find((t) => t.title === 'HS TIMECODE').webSocketDebuggerUrl);
  await main.ready();
  await main.send('Runtime.enable', {});
  await main.send('Page.enable', {});
  await main.send('Page.reload', {});
  await sleep(2500);

  /* ================= SETUP: Bài 1 (2 audio + 5 cue), Bài 2 (3 audio + 8 cue) ================= */
  console.log('== SETUP: Bài 1 = 2 audio + 5 cue · Bài 2 = 3 audio + 8 cue ==');
  const setup = await main.ev(`
    (async () => {
      try {
      window.__tlog = [];
      const log = (m) => window.__tlog.push(m);
      window.confirm = () => true;                       // không mở dialog khi tạo dự án mới
      localStorage.removeItem('hs-timecode-autosave');   // môi trường sạch
      newProjectDialog();
      log('newProject: folders=' + state.folders.length + ' lanes=' + state.lanes.length);
      // ---- BÀI 1: 2 audio + 5 cue ----
      const f1 = curFolder();
      addSongFile('/tmp/hs-audio-test/A-tone-8s.wav');
      addSongFile('/tmp/hs-audio-test/B-tone-12s.wav');
      for (let i = 0; i < 40; i++) {
        if (state.songs.length >= 2 && state.songs.every(s => s.duration > 0)) break;
        await new Promise(r => setTimeout(r, 250));
      }
      const laneA = state.lanes.find(l => l.kind === 'A');
      log('laneA=' + !!laneA);
      addAudioInstance(state.songs[0], laneA.id, 0);
      log('inst1 ok');
      addAudioInstance(state.songs[1], laneA.id, 10);
      log('inst2 ok');
      for (let i = 0; i < 5; i++) {
        const d = makeDef('/p1/cue' + (i + 1), [1]); d.name = 'P1-Cue' + (i + 1);
        f1.cues.push(d);
        insertCue(f1, makePlacement(i * 30, d.id));
      }
      // ---- BÀI 2: 3 audio + 8 cue ----
      addFolder('Bài 2');
      const f2 = curFolder();
      log('folder2: ' + f2.name + ' songs=' + state.songs.length);
      addSongFile('/tmp/hs-audio-test/A-tone-8s.wav');
      addSongFile('/tmp/hs-audio-test/B-tone-12s.wav');
      addSongFile('/tmp/hs-audio-test/test-tone.wav');
      for (let i = 0; i < 40; i++) {
        if (state.songs.length >= 3 && state.songs.every(s => s.duration > 0)) break;
        await new Promise(r => setTimeout(r, 250));
      }
      const laneA2 = state.lanes.find(l => l.kind === 'A');
      addAudioInstance(state.songs[0], laneA2.id, 0);
      addAudioInstance(state.songs[1], laneA2.id, 9);
      addAudioInstance(state.songs[2], laneA2.id, 20);
      for (let i = 0; i < 8; i++) {
        const d = makeDef('/p2/cue' + (i + 1), [2]); d.name = 'P2-Cue' + (i + 1);
        f2.cues.push(d);
        insertCue(f2, makePlacement(i * 60, d.id));
      }
      log('done');
      return { f1: { id: f1.id, cues: f1.events.length }, f2: { id: f2.id, cues: f2.events.length }, songs: state.songs.length, clips: state.audioClips.length };
      } catch (e) { window.__tlog.push('ERR: ' + e.message); return { threw2: e.message }; }
    })()
  `);
  console.log('setup kicked off');
  // LƯU Ý CDP: với replMode, evaluate KHÔNG đợi async IIFE (trả về Promise serialize {})
  // → POLL tới khi setup hoàn tất trong page rồi mới đọc id/đếm
  let ids = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const r = await main.ev(`(() => { const t = window.__tlog || []; const f2 = state.folders[state.folders.length - 1];
      return { t: t, done: t.includes('done'), f1: state.folders[0] ? { id: state.folders[0].id, cues: state.folders[0].events.length } : null,
               f2: { id: f2.id, cues: f2.events.length, songs: (f2.songs || []).length, clips: (f2.audioClips || []).length }, songs: state.songs.length }; })()`);
    if (r.done && r.f2.cues === 8 && r.f2.clips === 3) { ids = r; break; }
  }
  if (!ids) { console.log('SETUP TIMEOUT', JSON.stringify(await main.ev(`({tlog: window.__tlog, folders: state.folders.map(f => f.name)})`))); process.exit(1); }
  console.log('ids:', JSON.stringify(ids));
  if (!ids.f2 || !ids.f1 || ids.f1.id === ids.f2.id) { console.log('SETUP FAIL'); process.exit(1); }
  ok(ids.f2.songs === 3 && ids.f2.clips === 3 && ids.f2.cues === 8, 'Bài 2 đang mở: 3 audio, 3 instance, 8 cue');

  /* ================= TEST 1-3: chuyển qua lại nhiều lần — không trộn dữ liệu ================= */
  console.log('\n== TEST 1-3: chuyển Bài 1 ↔ Bài 2 nhiều lần ==');
  const p1Id = ids.f1.id, p2Id = ids.f2.id;
  for (let round = 0; round < 3; round++) {
    const s1 = await main.ev(`switchProject(${p1Id}); ({ cur: curFolder().name, songs: state.songs.length, clips: state.audioClips.length, cues: curFolder().events.length, playing: state.playing, laneN: state.lanes.length })`);
    ok(s1.songs === 2 && s1.clips === 2 && s1.cues === 5, `Vòng ${round + 1} → Bài 1: đúng 2 audio, 2 instance, 5 cue (không dính của Bài 2)`);
    const s2 = await main.ev(`switchProject(${p2Id}); ({ cur: curFolder().name, songs: state.songs.length, clips: state.audioClips.length, cues: curFolder().events.length, playing: state.playing })`);
    ok(s2.songs === 3 && s2.clips === 3 && s2.cues === 8, `Vòng ${round + 1} → Bài 2: đúng 3 audio, 3 instance, 8 cue (không dính của Bài 1)`);
    ok(!s1.playing && !s2.playing, `Vòng ${round + 1}: chuyển bài không tự phát (an toàn)`);
  }
  const leak = await main.ev(`
    (() => {
      switchProject(${p1Id});
      const p1Paths = state.songs.map(s => s.path.split('/').pop());
      const f2 = state.folders.find(f => f.id === ${p2Id});
      return { p1: p1Paths, f2StoredSongs: (f2.songs || []).length, f2StoredCues: f2.events.length };
    })()
  `);
  ok(leak.p1.length === 2 && !leak.p1.includes('test-tone.wav'), `Bài 1 KHÔNG thấy audio của Bài 2 (${leak.p1.join(', ')})`);
  ok(leak.f2StoredSongs === 3 && leak.f2StoredCues === 8, 'Dữ liệu Bài 2 vẫn nguyên vẹn sau khi chơi lưng bridging Bài 1');

  /* ================= TEST 4: phát audio ở Bài 1 → chuyển Bài 2 phải im ngay ================= */
  console.log('\n== TEST 4: đang phát audio Bài 1 → chuyển Bài 2 = không phát chéo ==');
  await main.ev(`(function () { setFrame(0); state.playbackIdx = 0; document.getElementById('btnPlay').click(); return true; })()`);
  await sleep(600);
  const play1 = await main.ev(`({ playing: state.playing, paused: audio.paused, cur: +audio.currentTime.toFixed(2) })`);
  ok(play1.playing && !play1.paused, 'Bài 1 đang phát audio');
  await main.ev(`(function () { switchProject(${p2Id}); return true; })()`);
  const sw = await main.ev(`({ playing: state.playing, paused: audio.paused, cur: curFolder().name, songs: state.songs.length })`);
  ok(!sw.playing && sw.paused, 'Chuyển bài khi đang phát → playback DỪNG ngay, không phát chéo sang Bài 2');
  await sleep(400);
  const stillPaused = await main.ev(`({ playing: state.playing, paused: audio.paused })`);
  ok(!stillPaused.playing && stillPaused.paused, 'Bài 2 KHÔNG tự phát sau khi chuyển');

  /* ================= TEST 5-6: Save (serialize) → Page reload = đóng/mở lại app ================= */
  console.log('\n== TEST 5-6: Save cả 2 bài → nạp lại (reload = đóng/mở app, đọc từ autosave) ==');
  await main.ev(`(function () { scheduleAutosave(); return true; })()`);
  await sleep(1200);   // chờ autosave debounce 800ms ghi localStorage
  const saved = await main.ev(`
    (() => {
      const data = JSON.parse(localStorage.getItem('hs-timecode-autosave'));
      if (!data) return { err: 'autosave missing' };
      const f1 = data.folders.find(f => f.id === ${p1Id});
      const f2 = data.folders.find(f => f.id === ${p2Id});
      return {
        version: data.version,
        f1: { songs: f1.songs.length, clips: f1.audioClips.length, cues: f1.events.length, lanes: f1.lanes.length },
        f2: { songs: f2.songs.length, clips: f2.audioClips.length, cues: f2.events.length, lanes: f2.lanes.length }
      };
    })()
  `);
  console.log('saved:', JSON.stringify(saved));
  ok(saved.version === 9, 'Project lưu dưới dạng v9 (per-folder data)');
  ok(saved.f1.songs === 2 && saved.f1.clips === 2 && saved.f1.cues === 5, 'Đĩa: Bài 1 = 2 audio + 2 instance + 5 cue');
  ok(saved.f2.songs === 3 && saved.f2.clips === 3 && saved.f2.cues === 8, 'Đĩa: Bài 2 = 3 audio + 3 instance + 8 cue');
  await main.send('Page.reload', {});
  await sleep(3000);
  const restored = await main.ev(`
    (() => {
      const f1 = state.folders.find(f => f.id === ${p1Id});
      const f2 = state.folders.find(f => f.id === ${p2Id});
      switchProject(f1.id);
      const inP1 = { cur: curFolder().name, songs: state.songs.map(s => s.path.split('/').pop()), clips: state.audioClips.length, cues: curFolder().events.length };
      switchProject(f2.id);
      const inP2 = { cur: curFolder().name, songs: state.songs.map(s => s.path.split('/').pop()), clips: state.audioClips.length, cues: curFolder().events.length };
      return { active: curFolder().id === f2.id, inP1, inP2 };
    })()
  `);
  console.log('restored:', JSON.stringify(restored));
  ok(restored.inP1.songs.length === 2 && restored.inP1.clips === 2 && restored.inP1.cues === 5, `Mở lại: Bài 1 nguyên vẹn (${restored.inP1.songs.join(', ')}, ${restored.inP1.cues} cue)`);
  ok(restored.inP2.songs.length === 3 && restored.inP2.clips === 3 && restored.inP2.cues === 8, `Mở lại: Bài 2 nguyên vẹn (${restored.inP2.songs.join(', ')}, ${restored.inP2.cues} cue)`);
  ok(restored.inP1.songs.every(p => !p.includes('test-tone')), 'Sau restore Bài 1 vẫn KHÔNG có audio của Bài 2');
  ok(restored.active, 'Bài đang mở sau restore đúng như lúc lưu');

  console.log('\n---- exceptions ----');
  main.logs.forEach((l) => console.log(l));
  if (main.logs.length) fails++;
  main.close();
  console.log(fails === 0 ? '\n★ PROJECT ISOLATION TESTS: TẤT CẢ ĐẠT ✔' : `\n★ ${fails} TEST THẤT BẠI ✗`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('DRIVER ERROR', e); process.exit(1); });
