/* =====================================================================
   HS TIMECODE · ConversionManager — Batch Audio Converter (FFmpeg)
   Chạy DUY NHẤT trong main process. Renderer chỉ gửi lệnh + nhận tiến trình.
   Không chạy gì khi tool đóng. Không đụng Timecode/MIDI/OSC.
   ===================================================================== */
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const AUDIO_EXT = new Set([
  '.mp3', '.wav', '.flac', '.m4a', '.aac', '.aiff', '.aif', '.ogg', '.oga', '.opus', '.wma', '.alac'
]);

const FORMAT_EXT = { wav: 'wav', mp3: 'mp3', flac: 'flac', m4a: 'm4a', ogg: 'ogg', aiff: 'aiff', opus: 'opus' };

let cachedBins = null;

function findBin(name) {
  const candidates = [
    name,
    '/opt/homebrew/bin/' + name,
    '/usr/local/bin/' + name,
    '/usr/bin/' + name
  ];
  return new Promise((resolve) => {
    let i = 0;
    const tryNext = () => {
      if (i >= candidates.length) return resolve(null);
      const bin = candidates[i++];
      execFile(bin, ['-version'], { timeout: 8000 }, (err, stdout) => {
        if (!err && /version/i.test(String(stdout))) return resolve(bin);
        tryNext();
      });
    };
    tryNext();
  });
}

function resolveBins() {
  if (!cachedBins) {
    cachedBins = Promise.all([findBin('ffmpeg'), findBin('ffprobe')]).then(([ffmpeg, ffprobe]) => ({ ffmpeg, ffprobe }));
  }
  return cachedBins;
}

function probeDuration(ffprobe, file) {
  return new Promise((resolve) => {
    if (!ffprobe) return resolve(0);
    execFile(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { timeout: 20000 }, (err, stdout) => {
      if (err) return resolve(0);
      const d = parseFloat(String(stdout).trim());
      resolve(isFinite(d) && d > 0 ? d : 0);
    });
  });
}

function walk(dir, base, deep, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (deep) walk(full, base, deep, out);
    } else if (AUDIO_EXT.has(path.extname(ent.name).toLowerCase())) {
      let size = 0;
      try { size = fs.statSync(full).size; } catch (_) { /* bỏ qua */ }
      out.push({ path: full, rel: path.relative(base, path.dirname(full)), size });
    }
  }
  return out;
}

function uniqueOutPath(dir, base, ext, dup) {
  let target = path.join(dir, `${base}.${ext}`);
  if (!fs.existsSync(target)) return target;
  if (dup === 'overwrite') return target;
  if (dup === 'skip') return null;
  let i = 1;
  while (fs.existsSync(path.join(dir, `${base} (${i}).${ext}`))) i++;
  return path.join(dir, `${base} (${i}).${ext}`);
}

/* Tham số ffmpeg theo format + chất lượng */
const MUXER = { wav: 'wav', aiff: 'aiff', mp3: 'mp3', flac: 'flac', m4a: 'ipod', ogg: 'ogg', opus: 'opus' };

function buildArgs(input, output, opts) {
  const a = ['-y', '-hide_banner', '-loglevel', 'error', '-i', input];
  if (opts.meta) a.push('-map_metadata', '0');
  a.push('-map', '0:a');
  const fmt = opts.format;
  const artOk = ['mp3', 'flac', 'm4a'].includes(fmt);
  if (opts.meta && artOk) a.push('-map', '0:v?', '-c:v', 'copy');
  else a.push('-vn');

  if (fmt === 'wav' || fmt === 'aiff') {
    const sr = opts.sampleRate;          // '' = source
    const bd = opts.bitDepth;            // '' | '16' | '24' | '32f'
    const ch = opts.channels;            // '' | '1' | '2'
    if (sr) a.push('-ar', String(sr));
    if (ch) a.push('-ac', String(ch));
    if (fmt === 'wav') {
      a.push('-c:a', bd === '16' ? 'pcm_s16le' : bd === '32f' ? 'pcm_f32le' : bd === '24' ? 'pcm_s24le' : 'pcm_s24le');
    } else {
      a.push('-c:a', bd === '16' ? 'pcm_s16be' : bd === '32f' ? 'pcm_s32be' : bd === '24' ? 'pcm_s24be' : 'pcm_s24be');
    }
  } else if (fmt === 'mp3') {
    a.push('-c:a', 'libmp3lame');
    if (opts.mp3Mode === 'vbr') a.push('-q:a', '0');
    else a.push('-b:a', `${opts.bitrate || 320}k`);
  } else if (fmt === 'flac') {
    const bd = opts.bitDepth;            // '' | '16' | '24'
    if (opts.sampleRate) a.push('-ar', String(opts.sampleRate));
    if (bd === '16') a.push('-sample_fmt', 's16');
    else if (bd === '24') a.push('-sample_fmt', 's32');
    a.push('-c:a', 'flac');
  } else if (fmt === 'm4a') {
    a.push('-c:a', 'aac', '-b:a', `${opts.bitrate || 256}k`);
  } else if (fmt === 'ogg') {
    a.push('-c:a', 'libvorbis', '-b:a', `${opts.bitrate || 256}k`);
  } else if (fmt === 'opus') {
    a.push('-c:a', 'libopus', '-b:a', `${opts.bitrate || 256}k`);
  }

  a.push('-progress', 'pipe:1', '-nostats', '-f', MUXER[fmt] || fmt, output);
  return a;
}

class ConversionManager {
  constructor(sendEvent) {
    this.send = sendEvent;          // (channel, payload) => void
    this.child = null;
    this.cancelFlag = false;
    this.paused = false;
    this.running = false;
    this.queue = [];
    this.idx = -1;
    this.counts = { done: 0, failed: 0, skipped: 0 };
    this.outDir = '';
    this.tempFile = null;
  }

  bins() { return resolveBins(); }

  async probe(paths) {
    const { ffprobe } = await resolveBins();
    const out = [];
    for (const p of paths) out.push(await probeDuration(ffprobe, p));
    return out;
  }

  async scanFolder(dir, deep) {
    const files = walk(dir, dir, !!deep, []);
    const { ffprobe } = await resolveBins();
    const out = [];
    for (const f of files) {
      out.push({ path: f.path, rel: f.rel, size: f.size, duration: await probeDuration(ffprobe, f.path) });
    }
    return out;
  }

  pause() {
    if (!this.running || this.paused) return;
    this.paused = true;
    if (this.child && this.child.pid) { try { process.kill(this.child.pid, 'SIGSTOP'); } catch (_) {} }
    this.send('conv-state', { running: true, paused: true });
  }

  resume() {
    if (!this.running || !this.paused) return;
    this.paused = false;
    if (this.child && this.child.pid) { try { process.kill(this.child.pid, 'SIGCONT'); } catch (_) {} }
    this.send('conv-state', { running: true, paused: false });
  }

  cancel() {
    if (!this.running) return;
    this.cancelFlag = true;
    this.paused = false;
    if (this.child && this.child.pid) {
      try { process.kill(this.child.pid, 'SIGCONT'); } catch (_) {}
      try { this.child.kill('SIGKILL'); } catch (_) {}
    }
  }

  cleanupTemp() {
    if (this.tempFile) {
      try { fs.unlinkSync(this.tempFile); } catch (_) {}
      this.tempFile = null;
    }
  }

  async start({ files, opts }) {
    if (this.running) throw new Error('Đang có tiến trình convert khác chạy.');
    const { ffmpeg } = await resolveBins();
    if (!ffmpeg) throw new Error('Chưa tìm thấy FFmpeg trên máy. Cài bằng: brew install ffmpeg');

    if (!Array.isArray(files) || !files.length) throw new Error('Chưa có file nào trong hàng đợi.');
    if (!opts || !opts.outDir) throw new Error('Chưa chọn thư mục lưu.');
    if (!FORMAT_EXT[opts.format]) throw new Error('Format ra không được hỗ trợ.');

    try {
      fs.mkdirSync(opts.outDir, { recursive: true });
      fs.accessSync(opts.outDir, fs.constants.W_OK);
    } catch (e) {
      throw new Error('Không ghi được vào thư mục lưu: ' + opts.outDir);
    }

    this.running = true;
    this.cancelFlag = false;
    this.paused = false;
    this.counts = { done: 0, failed: 0, skipped: 0 };
    this.outDir = opts.outDir;
    this.queue = [];
    this.idx = -1;

    // chuẩn bị danh sách task + output path (xử lý trùng tên + cấu trúc thư mục)
    for (const f of files) {
      const ext = FORMAT_EXT[opts.format];
      const base = path.basename(f.path).replace(/\.[^.]+$/, '');
      const relDir = opts.keepTree && f.rel ? f.rel : '';
      const dir = path.join(opts.outDir, relDir);
      try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
      const target = uniqueOutPath(dir, base, ext, opts.dup || 'auto');
      this.queue.push({ in: f.path, out: target, duration: f.duration || 0 });
    }

    this.send('conv-state', { running: true, paused: false, total: this.queue.length });
    this.loop(ffmpeg, opts);
    return { total: this.queue.length };
  }

  async loop(ffmpeg, opts) {
    for (let i = 0; i < this.queue.length; i++) {
      if (this.cancelFlag) break;
      this.idx = i;
      const task = this.queue[i];
      if (!task.out) {
        this.counts.skipped++;
        this.send('conv-item', { i, status: 'skipped' });
        continue;
      }
      this.send('conv-item', { i, status: 'converting', out: path.basename(task.out) });
      const ok = await this.runOne(ffmpeg, task, opts, i);
      if (this.cancelFlag) {
        this.send('conv-item', { i, status: 'cancelled' });
        break;
      }
      if (ok) this.counts.done++;
      else this.counts.failed++;
    }

    const cancelled = this.cancelFlag;
    this.running = false;
    this.cancelFlag = false;
    this.paused = false;
    this.cleanupTemp();
    this.send('conv-done', {
      done: this.counts.done,
      failed: this.counts.failed,
      skipped: this.counts.skipped,
      cancelled,
      outDir: this.outDir
    });
  }

  runOne(ffmpeg, task, opts, index) {
    return new Promise((resolve) => {
      const temp = task.out + '.hs-part';
      this.tempFile = temp;
      try { fs.unlinkSync(temp); } catch (_) {}

      const args = buildArgs(task.in, temp, opts);
      const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;

      let errBuf = '';
      let outBuf = '';
      let lastPct = -1;
      const dur = task.duration || 0;

      child.stdout.on('data', (chunk) => {
        outBuf += chunk.toString();
        const lines = outBuf.split('\n');
        outBuf = lines.pop() || '';
        for (const line of lines) {
          const m = /^out_time_us=(\d+)/.exec(line);
          if (m && dur > 0) {
            const pct = Math.min(99.5, (Number(m[1]) / 1e6) / dur * 100);
            if (pct - lastPct >= 0.5) {
              lastPct = pct;
              this.send('conv-item', { i: index, pct });
            }
          }
          const s = /^speed=\s*([\d.]+)x/.exec(line);
          if (s) this.send('conv-item', { i: index, speed: Number(s[1]) });
        }
      });

      child.stderr.on('data', (c) => {
        errBuf += c.toString();
        if (errBuf.length > 8000) errBuf = errBuf.slice(-8000);
      });

      child.on('error', (e) => {
        this.cleanupTemp();
        this.send('conv-item', { i: index, status: 'failed', error: e.message });
        resolve(false);
      });

      child.on('close', (code) => {
        this.child = null;
        if (this.cancelFlag) { this.cleanupTemp(); resolve(false); return; }
        if (code === 0) {
          try {
            fs.renameSync(temp, task.out);
            this.tempFile = null;
            this.send('conv-item', { i: index, status: 'done', pct: 100 });
            resolve(true);
          } catch (e) {
            this.cleanupTemp();
            this.send('conv-item', { i: index, status: 'failed', error: 'Không ghi được file ra: ' + e.message });
            resolve(false);
          }
        } else {
          this.cleanupTemp();
          this.send('conv-item', { i: index, status: 'failed', error: (errBuf.trim().split('\n').pop() || `ffmpeg exit ${code}`) });
          resolve(false);
        }
      });
    });
  }
}

module.exports = { ConversionManager, AUDIO_EXT };
