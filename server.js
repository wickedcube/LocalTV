#!/usr/bin/env node
// TVUtils: stream videos from this PC to a TV browser, controlled from a phone.
// Usage: node server.js [media-folder]     (env: PORT, MEDIA_DIR)
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// The media folder is shared with the menu bar app through this file (a command-line argument still wins).
const CONFIG = path.join(os.homedir(), 'Library', 'Application Support', 'TVUtils', 'config.json');
const readConfig = () => { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; } };
const saveConfig = (patch) => {
  try { fs.mkdirSync(path.dirname(CONFIG), { recursive: true }); fs.writeFileSync(CONFIG, JSON.stringify({ ...readConfig(), ...patch })); } catch (e) { log('could not save config: ' + e.message); }
};
// Ending the cast session sends the TV back to its home screen, which some TVs answer by switching inputs / waking HDMI devices.
let endOnStop = !!readConfig().endOnStop;
// Compatibility switches for finding what upsets a particular TV (both on by default).
let castArtwork = readConfig().castArtwork !== false;
let castSubs = readConfig().castSubs !== false;
let castPoll = readConfig().castPoll !== false; // ask the TV for its playback position every few seconds
let ROOT = path.resolve(process.argv[2] || process.env.MEDIA_DIR || readConfig().root || path.join(os.homedir(), 'Movies'));
const PORT = Number(process.env.PORT) || 8080;
const PUBLIC = path.join(__dirname, 'public');

const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.ogv': 'video/ogg',
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
};
const isVideo = (name) => ['.mp4', '.m4v', '.webm', '.mkv', '.mov', '.avi', '.ogv'].includes(path.extname(name).toLowerCase());

// ---- state -----------------------------------------------------------------
const state = { path: null, title: '', paused: true, time: 0, duration: 0, volume: 0.25, error: null, target: null, devices: [], tracks: { audio: [], subs: [] }, audio: 0, sub: -1 };
const prefs = { audioLang: 'jpn', subLang: 'eng' }; // remembered across episodes; subLang '' = subtitles off
let queue = [];
let qi = -1;
const clients = new Set(); // { res, role }
// Log lines are kept in memory for the phone's log panel and appended to a file, so they survive restarts.
const LOG_FILE = path.join(os.homedir(), 'Library', 'Logs', 'TVUtils', 'server.log');
const logs = [];
try {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2e6) fs.renameSync(LOG_FILE, LOG_FILE + '.old');
  if (fs.existsSync(LOG_FILE)) logs.push(...fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).slice(-150));
} catch {}
function log(msg) {
  const line = new Date().toTimeString().slice(0, 8) + '  ' + msg;
  logs.push(line); if (logs.length > 300) logs.shift();
  console.log(line);
  fs.appendFile(LOG_FILE, line + '\n', () => {});
}
log('─── server started ───');

const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const toTv = (cmd) => { for (const c of clients) if (c.role === 'tv') sse(c.res, 'cmd', cmd); };
function publish() {
  const snap = { ...state, tv: [...clients].some((c) => c.role === 'tv'), index: qi, count: queue.length };
  for (const c of clients) sse(c.res, 'state', snap);
}


// ---- chromecast ------------------------------------------------------------
// state.target === null → the /tv browser page plays; otherwise a Chromecast / Google TV by name.
const devices = new Map(); // friendlyName → Device
let castGen = 0;
let castFails = 0;
let castSig = '';

function lanIP() {
  const all = Object.entries(os.networkInterfaces()).flatMap(([n, l]) => l.map((i) => ({ n, ...i })))
    .filter((i) => i.family === 'IPv4' && !i.internal);
  return (all.find((i) => i.n === 'en0') || all[0] || {}).address || 'localhost';
}
const castDevice = () => (state.target ? devices.get(state.target) : null);
const mediaUrl = () => `http://${lanIP()}:${PORT}/media/` + state.path.split('/').map(encodeURIComponent).join('/');
const castErr = (what) => (err) => { if (err) { log(`cast ${what} ERROR: ` + (err.message || err.code || JSON.stringify(err))); state.error = `Cast ${what} failed: ${err.message || err}`; publish(); } };

function addDevice(name, friendlyName, host) {
  if (devices.has(friendlyName)) return;
  // .local names can resolve to an unusable IPv6 link-local address, so pin to IPv4.
  require('dns').lookup(host, { family: 4 }, (err, ip) => {
    if (err || devices.has(friendlyName)) return;
    const Device = require('chromecast-api/lib/device');
    devices.set(friendlyName, new Device({ name, friendlyName, host: ip }));
    log(`found cast device "${friendlyName}" at ${ip}`);
    state.devices = [...devices.keys()].sort();
    publish();
  });
}

// Discovery: macOS's own mDNS tool (works under Local Network privacy rules); library as fallback.
function discover() {
  const { spawn } = require('child_process');
  let p;
  try { p = spawn('dns-sd', ['-Z', '_googlecast._tcp', 'local.']); } catch { return discoverFallback(); }
  p.on('error', discoverFallback);
  p.on('exit', () => setTimeout(discover, 5000)); // keep browsing if it ever dies
  const srv = {}; let buf = '';
  p.stdout.on('data', (d) => {
    buf += d; const lines = buf.split('\n'); buf = lines.pop();
    for (const l of lines) {
      let m = /^(\S+)\._googlecast\._tcp\s+SRV\s+\d+ \d+ \d+ (\S+)/.exec(l);
      if (m) { srv[m[1]] = m[2].replace(/\.$/, ''); continue; }
      m = /^(\S+)\._googlecast\._tcp\s+TXT\s+(.*)$/.exec(l);
      if (m && srv[m[1]]) { const fn = /"fn=([^"]*)"/.exec(m[2]); addDevice(m[1], fn ? fn[1] : m[1], srv[m[1]]); }
    }
  });
}
function discoverFallback() {
  try {
    const finder = new (require('chromecast-api'))();
    finder.on('device', (d) => addDevice(d.name, d.friendlyName, d.host));
    setInterval(() => finder.update(), 30000);
  } catch (e) { console.error('Chromecast discovery unavailable:', e.message); }
}
discover();


// ---- transcoding (for files a Chromecast can't play directly) ---------------
const findBin = (n) => ['/opt/homebrew/bin/', '/usr/local/bin/', '/usr/bin/'].map((d) => d + n).find((f) => fs.existsSync(f));
const FFMPEG = findBin('ffmpeg'), FFPROBE = findBin('ffprobe');
const probeCache = new Map();
let trackKey = null;
let castOffset = 0;      // seconds into the file where the current cast stream begins (transcoded streams only)
let castTranscode = false;

const BITMAP_SUBS = ['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle'];
function probe(full, cb) {
  if (probeCache.has(full)) return cb(probeCache.get(full));
  if (!FFPROBE) return cb(null);
  require('child_process').execFile(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,pix_fmt,channels:stream_tags=language,title:stream_disposition=forced', '-of', 'json', full], (e, out) => {
    let info = null;
    try {
      const j = JSON.parse(out);
      const mk = (t) => j.streams.filter((x) => x.codec_type === t).map((x) => ({
        codec: x.codec_name, bitmap: BITMAP_SUBS.includes(x.codec_name), lang: (x.tags && x.tags.language) || '', title: (x.tags && x.tags.title) || '',
        forced: !!(x.disposition && x.disposition.forced), ch: x.channels,
      }));
      info = { duration: Number(j.format.duration) || 0, v: j.streams.find((x) => x.codec_type === 'video'), a: j.streams.find((x) => x.codec_type === 'audio'), audio: mk('audio'), subs: mk('subtitle') };
    } catch {}
    if (info) probeCache.set(full, info);
    cb(info);
  });
}
const trackLabel = (t) => [t.lang.toUpperCase() || '?', t.title, t.forced ? '(forced)' : ''].filter(Boolean).join(' · ');
// Pick tracks matching remembered language preferences.
function pickTracks(info) {
  const aud = info.audio.findIndex((t) => t.lang === prefs.audioLang && !/commentary/i.test(t.title));
  const audio = aud >= 0 ? aud : Math.max(0, info.audio.findIndex((t) => !/commentary/i.test(t.title)));
  const find = (f) => info.subs.findIndex((t) => t.lang === prefs.subLang && f(t));
  let sub = prefs.subLang ? find((t) => !t.forced && !/sign|song|sdh|commentary/i.test(t.title)) : -1;
  if (sub < 0 && prefs.subLang) sub = find((t) => !t.forced);
  if (sub < 0 && prefs.subLang) sub = find(() => true);
  return { audio, sub };
}
function chooseTracks(info) {
  const t = pickTracks(info);
  state.audio = t.audio; state.sub = t.sub;
  state.tracks = { audio: info.audio.map(trackLabel), subs: info.subs.map(trackLabel) };
}
// Directly playable on a Chromecast: H.264 8-bit + AAC/MP3 in MP4, or WebM.
function directPlayable(info, full) {
  const ext = path.extname(full).toLowerCase();
  if (ext === '.webm') return true;
  if (!info || !['.mp4', '.m4v'].includes(ext)) return !info && ['.mp4', '.m4v'].includes(ext);
  return info.v && info.v.codec_name === 'h264' && info.v.pix_fmt === 'yuv420p' && (!info.a || ['aac', 'mp3'].includes(info.a.codec_name));
}
const transcodeUrl = (start) => `http://${lanIP()}:${PORT}/transcode/` + state.path.split('/').map(encodeURIComponent).join('/') + `?start=${Math.floor(start)}&a=${state.audio}&s=${state.sub}`;

// Shared ffmpeg arguments for converted playback (video copied or re-encoded, subtitles drawn in, audio → AAC).
function convertArgs(full, info, start, ai, si) {
  const h264 = info && info.v && info.v.codec_name === 'h264' && info.v.pix_fmt === 'yuv420p';
  const sub = info && si >= 0 ? info.subs[si] : null;
  const args = ['-v', 'error', '-ss', String(start), '-i', full];
  const encode = ['-c:v', 'h264_videotoolbox', '-b:v', '4M', '-maxrate', '5M', '-bufsize', '8M', '-g', '48', '-pix_fmt', 'yuv420p'];
  const link = null;
  if (sub && sub.bitmap) { // image subtitles (Blu-ray PGS) must be drawn onto the picture
    args.push('-filter_complex', `[0:v:0][0:s:${si}]overlay=format=auto,format=yuv420p[v]`, '-map', '[v]', ...encode);
  } else { // text subtitles are delivered separately as WebVTT (see /api/sub)
    args.push('-map', '0:v:0', ...(h264 ? ['-c:v', 'copy'] : encode));
  }
  args.push('-map', `0:a:${Math.max(0, ai)}?`, '-sn', '-dn', '-map_chapters', '-1', '-map_metadata', '-1', '-c:a', 'aac', '-b:a', '192k', '-ac', '2');
  return { args, link, sub };
}

// A streamed fragmented MP4 normally declares duration 0, which makes players (and the TV's cast receiver) treat it as a
// live stream. Patch the real remaining duration into the header boxes as it goes out so it looks like an ordinary video.
function patchDuration(buf, seconds) {
  const u32 = (o) => buf.readUInt32BE(o), set = (o, v) => buf.writeUInt32BE(Math.max(0, Math.min(0xffffffff, Math.round(v))), o);
  const boxes = (type) => { const out = []; let i = -1; while ((i = buf.indexOf(type, i + 1)) !== -1) if (i >= 4 && buf[i + 4] === 0) out.push(i - 4); return out; }; // version 0 only
  const mv = boxes('mvhd')[0];
  if (mv === undefined) return buf;
  const movieTs = u32(mv + 20);
  set(mv + 24, seconds * movieTs);
  for (const o of boxes('tkhd')) set(o + 28, seconds * movieTs);
  for (const o of boxes('mdhd')) set(o + 24, seconds * u32(o + 20));
  return buf;
}

function serveTranscode(req, res, full, start, ai, si) {
  probe(full, (info) => {
    const { args, link, sub } = convertArgs(full, info, start, ai, si);
    args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-write_tmcd', '0', '-f', 'mp4', 'pipe:1');
    log(`transcode ${path.basename(full)} from ${start}s, audio #${ai}${sub ? ', subtitles #' + si + ' (' + sub.codec + ')' : ', no subtitles'}`);
    const ff = require('child_process').spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let errTxt = '';
    ff.stderr.on('data', (d) => { errTxt = (errTxt + d).slice(-400); });
    ff.on('exit', (code) => { if (code) log(`ffmpeg exited ${code}: ${errTxt.trim()}`); if (link) fs.unlink(link, () => {}); });
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' });
    const remaining = info && info.duration ? Math.max(1, info.duration - start) : 0;
    if (!remaining) { ff.stdout.pipe(res); }
    else { // hold back the header (everything before the first fragment) just long enough to patch the duration into it
      let head = Buffer.alloc(0), patched = false;
      ff.stdout.on('data', (chunk) => {
        if (patched) return res.write(chunk);
        head = Buffer.concat([head, chunk]);
        const m = head.indexOf('moof');
        if (m === -1 && head.length < 1e6) return;
        patched = true;
        const cut = m === -1 ? head.length : m - 4;
        res.write(Buffer.concat([patchDuration(head.subarray(0, cut), remaining), head.subarray(cut)]));
      });
      ff.stdout.on('end', () => res.end());
    }
    res.on('close', () => ff.kill('SIGKILL'));
  });
}

// ---- HLS sessions (for playing converted video in a phone's browser) ----------
const HLS_DIR = path.join(os.tmpdir(), 'tvutils-hls');
const hls = new Map(); // id → { ff, dir, last }
fs.rmSync(HLS_DIR, { recursive: true, force: true });
fs.mkdirSync(HLS_DIR, { recursive: true });

function stopHls(id) {
  const h = hls.get(id);
  if (!h) return;
  hls.delete(id);
  try { h.ff.kill('SIGKILL'); } catch {}
  if (h.link) fs.unlink(h.link, () => {});
  fs.rm(h.dir, { recursive: true, force: true }, () => {});
}
function startHls(full, start, ai, si, cb) {
  probe(full, (info) => {
    const id = require('crypto').randomBytes(8).toString('hex');
    const dir = path.join(HLS_DIR, id);
    fs.mkdirSync(dir);
    const { args, link, sub } = convertArgs(full, info, start, ai, si);
    args.push('-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_playlist_type', 'event',
      '-hls_flags', 'independent_segments', '-hls_segment_filename', path.join(dir, 's%05d.ts'), path.join(dir, 'index.m3u8'));
    log(`phone stream ${path.basename(full)} from ${start}s, audio #${ai}${sub ? ', subtitles #' + si : ', no subtitles'}`);
    const ff = require('child_process').spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let errTxt = '';
    ff.stderr.on('data', (d) => { errTxt = (errTxt + d).slice(-400); });
    ff.on('exit', (code, sig) => { if (code) log(`ffmpeg (phone) exited ${code}: ${errTxt.trim()}`); });
    hls.set(id, { ff, dir, link, last: Date.now() });
    // Wait until the first segment exists before telling the phone where to look.
    const t0 = Date.now();
    (function wait() {
      const pl = path.join(dir, 'index.m3u8');
      if (fs.existsSync(pl) && /\.ts/.test(fs.readFileSync(pl, 'utf8'))) return cb(null, id);
      if (Date.now() - t0 > 20000 || ff.exitCode) { stopHls(id); return cb(new Error('conversion did not start: ' + errTxt.trim())); }
      setTimeout(wait, 200);
    })();
  });
}
setInterval(() => { for (const [id, h] of hls) if (Date.now() - h.last > 10 * 60 * 1000) stopHls(id); }, 30000);
process.on('exit', () => { for (const id of [...hls.keys()]) stopHls(id); });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  const d = castDevice();
  setTimeout(() => process.exit(0), 2500); // never hang on the way out
  if (d && state.path) { if (endOnStop) endCast(d, () => process.exit(0)); else { try { d.stop(() => process.exit(0)); } catch { process.exit(0); } } } else process.exit(0);
});

// Stop every app session running on the TV (not just ours), so the next cast starts from a clean screen.
let castFresh = false; // set after a full end-of-session (only when that option is on); the next cast then starts a fresh one
function endCast(d, cb) {
  d._connect((err) => {
    if (err) { log('endCast: connect failed: ' + (err.message || err.code)); return cb && cb(err); }
    d.client.getSessions((e, sessions) => {
      sessions = sessions || [];
      log(`endCast: ${sessions.length} session(s) on ${d.friendlyName}` + (sessions.length ? ': ' + sessions.map((x) => x.displayName || x.appId).join(', ') : ''));
      let left = sessions.length;
      const done = () => { try { d.client.close(); } catch {} d.client = null; setTimeout(() => cb && cb(), 700); };
      if (!left) return done();
      sessions.forEach((x) => d.client.receiver.stop(x.sessionId, () => { if (--left === 0) done(); }));
    });
  });
}
const prettyTitle = (rel) => { const b = path.basename(rel).replace(/\.[^.]+$/, ''); return /\s/.test(b) ? b : b.replace(/[._]+/g, ' '); };

// Run at most two thumbnail jobs at a time (a library page can ask for dozens at once).
let thumbBusy = 0; const thumbWaiting = [];
function thumbLimit(job) {
  const run = () => { thumbBusy++; job(() => { thumbBusy--; const next = thumbWaiting.shift(); if (next) run2(next); }); };
  const run2 = (j) => { thumbBusy++; j(() => { thumbBusy--; const n = thumbWaiting.shift(); if (n) run2(n); }); };
  if (thumbBusy < 2) run(); else thumbWaiting.push(job);
}

function castLoad() {
  const d = castDevice();
  if (!d) return;
  const gen = ++castGen;
  castFails = 0; castSig = '';
  d.removeAllListeners('finished');
  d.once('finished', () => { if (gen === castGen) { log('cast: finished'); endOfMedia(); } });
  if (castFresh) {
    castFresh = false;
    log('clearing any old session on ' + state.target + ' before starting');
    return endCast(d, () => { if (gen === castGen) castLoad(); });
  }
  const full = safeResolve(state.path);
  probe(full, (info) => {
    if (gen !== castGen) return;
    const direct = !FFMPEG || directPlayable(info, full);
    castTranscode = !direct;
    if (info && !direct) { if (!state.tracks.audio.length || trackKey !== state.path) { chooseTracks(info); trackKey = state.path; } }
    else { state.tracks = { audio: [], subs: [] }; }
    castOffset = direct ? 0 : Math.floor(state.time);
    if (info && info.duration) state.duration = info.duration;
    const url = direct ? mediaUrl() : transcodeUrl(state.time);
    log(`cast → ${state.target}: ${direct ? 'direct' : 'converted'} ${url} (start ${Math.round(state.time)}s)`);
    // Probe the TV's cast port first so a blocked/asleep TV gives a clear error instead of a silent hang.
    const sock = require('net').connect({ host: d.host, port: 8009, timeout: 5000 });
    const bad = (why) => { sock.destroy(); if (gen !== castGen) return; log(`tcp to ${d.host}:8009 FAILED: ${why}`);
      state.error = `Can't reach ${state.target} (${why}). Check the TV is on, and that macOS Settings → Privacy & Security → Local Network allows TVUtils.`; publish(); };
    sock.on('connect', () => {
      sock.destroy();
      if (gen !== castGen) return;
      const media = castArtwork ? { url, cover: { title: prettyTitle(state.path), url: `http://${lanIP()}:${PORT}/api/thumb?path=${encodeURIComponent(state.path)}` } } : { url };
      const sub = !direct && info && state.sub >= 0 ? info.subs[state.sub] : null;
      if (castSubs && sub && !sub.bitmap) media.subtitles = [{ language: sub.lang || 'en', name: sub.title || 'Subtitles',
        url: `http://${lanIP()}:${PORT}/api/sub?path=${encodeURIComponent(state.path)}&s=${state.sub}&start=${castOffset}` }];
      d.play(media, { startTime: direct ? state.time : 0 }, (err, status) => {
        if (gen !== castGen) return;
        if (err) { log('cast load ERROR: ' + (err.message || err.code || JSON.stringify(err))); return castErr('load')(err); }
        log('cast load accepted, state=' + (status && status.playerState));
        if (state.paused) d.pause(castErr('pause'));
        // Don't set the TV's volume when a video starts: with an HDMI audio device attached, changing it wakes that device.
        // Just read the current level so the phone's slider matches.
        d.getVolume((e, v) => { if (!e && v && typeof v.level === 'number') { state.volume = v.level; publish(); log('TV volume is ' + Math.round(v.level * 100) + '%'); } });
      });
    });
    sock.on('error', (e) => bad(e.code || e.message));
    sock.on('timeout', () => bad('timed out'));
  });
}

// Mirror the Chromecast's position/pause state into ours. Ask the TV only every few seconds
// (frequent polling is needless load on it) and advance the clock locally in between.
let castTick = 0, castPlaying = false;
setInterval(() => {
  const d = castDevice();
  if (!d || !state.path || !d.client) return;
  if (!castPoll || ++castTick % 4 !== 0) {
    if (castPlaying && !state.paused) { state.time = Math.min(state.time + 1, state.duration || Infinity); publish(); }
    return;
  }
  d.getStatus((err, s) => {
    if (err || !s) { if (++castFails === 3) { log('lost contact with ' + state.target + ': ' + (err && (err.message || err.code))); state.error = 'Lost contact with ' + state.target; publish(); } return; }
    castFails = 0;
    castPlaying = s.playerState === 'PLAYING';
    const sig = s.playerState + '/' + (s.idleReason || '');
    if (sig !== castSig) {
      castSig = sig; log('cast status: ' + s.playerState + (s.idleReason ? ' (' + s.idleReason + ')' : ''));
      if (s.idleReason === 'ERROR') state.error = 'The TV could not play this file (unsupported video/audio format?)';
    }
    if (s.playerState === 'BUFFERING' && state.time === 0 && !s.currentTime) return;
    state.time = castOffset + (s.currentTime || 0);
    state.paused = s.playerState === 'PAUSED';
    if (!castTranscode && s.media && s.media.duration) state.duration = s.media.duration;
    publish();
  });
}, 1000);

function endOfMedia() { if (qi + 1 < queue.length) loadIndex(qi + 1); else command({ type: 'stop' }); }

// Send a playback action to whichever output is active.
function output(action, arg) {
  const d = castDevice();
  if (!d) return toTv(action === 'pause' ? { type: 'pause' } : action === 'resume' ? { type: 'play' }
    : action === 'seek' ? { type: 'seek', time: arg } : action === 'volume' ? { type: 'volume', value: arg } : { type: 'stop' });
  const done = castErr(action);
  try {
    if (action === 'pause') d.pause(done);
    else if (action === 'resume') d.resume(done);
    else if (action === 'seek') d.seekTo(arg, done);
    else if (action === 'volume') d.setVolume(arg, done);
    else if (action === 'stop') {
      castGen++;
      if (endOnStop) { castFresh = true; endCast(d); }
      else d.stop((e) => { if (e) log('cast stop (media only): ' + (e.message || e)); else log('cast stopped; TV left on its cast screen'); });
    }
  } catch (e) { done(e); }
}

const naturalSort = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

// Resolve a media-relative path, refusing anything outside ROOT.
function browsable(p) {
  let r; try { r = fs.realpathSync(p); } catch { return null; }
  const home = os.homedir();
  return r === home || r.startsWith(home + path.sep) || r.startsWith('/Volumes/') ? r : null;
}
// Searchable index of every video and folder under the media folder (rebuilt at most every two minutes).
const normName = (x) => x.toLowerCase().replace(/[._\-\[\]()+,]+/g, ' ').replace(/\s+/g, ' ').trim();
const indexCache = { root: null, at: 0, items: null, pending: null };
function getIndex() {
  if (indexCache.root === ROOT && indexCache.items && Date.now() - indexCache.at < 120000) return Promise.resolve(indexCache.items);
  if (indexCache.root === ROOT && indexCache.pending) return indexCache.pending;
  const root = ROOT;
  indexCache.root = root; indexCache.items = null;
  indexCache.pending = (async () => {
    const items = [], stack = [['', 0]];
    while (stack.length && items.length < 60000) {
      const [rel, depth] = stack.pop();
      let ents;
      try { ents = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        if (e.name.startsWith('.') || e.name.startsWith('$') || e.name === 'System Volume Information') continue;
        const r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) { items.push({ r, d: true, n: normName(r), b: normName(e.name) }); if (depth < 7) stack.push([r, depth + 1]); }
        else if (isVideo(e.name)) items.push({ r, d: false, n: normName(r), b: normName(e.name) });
      }
    }
    indexCache.items = items; indexCache.at = Date.now(); indexCache.pending = null;
    log(`indexed ${items.length} items under ${path.basename(root)} for search`);
    return items;
  })();
  return indexCache.pending;
}

function safeResolve(rel) {
  const full = path.resolve(ROOT, '.' + path.sep + (rel || ''));
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return null;
  return full;
}
const relOf = (full) => path.relative(ROOT, full).split(path.sep).join('/');

function loadIndex(i) {
  qi = i;
  const rel = queue[qi];
  Object.assign(state, { path: rel, title: path.basename(rel), paused: false, time: 0, duration: 0, error: null });
  trackKey = null;
  castDevice() ? castLoad() : toTv(loadCmd());
  publish();
}
const loadCmd = () => ({
  type: 'load',
  src: '/media/' + state.path.split('/').map(encodeURIComponent).join('/'),
  title: state.title, time: state.time, paused: state.paused, volume: state.volume,
});

function playPath(rel) {
  const full = safeResolve(rel);
  if (!full || !fs.existsSync(full) || !isVideo(full)) return false;
  const dir = path.dirname(full);
  queue = fs.readdirSync(dir).filter((n) => !n.startsWith('.') && isVideo(n)).sort(naturalSort)
    .map((n) => relOf(path.join(dir, n)));
  loadIndex(Math.max(0, queue.indexOf(relOf(full))));
  return true;
}

function command(c) {
  log('cmd ' + JSON.stringify(c));
  switch (c.type) {
    case 'play': return playPath(c.path);
    case 'pause': state.paused = true; output('pause'); break;
    case 'resume': state.paused = false; output('resume'); break;
    case 'toggle': return command({ type: state.paused ? 'resume' : 'pause' });
    case 'seek': {
      const t = c.to !== undefined ? Number(c.to) : state.time + Number(c.delta || 0);
      state.time = Math.max(0, state.duration ? Math.min(t, state.duration) : t);
      if (castDevice() && castTranscode) castLoad(); else output('seek', state.time);
      break;
    }
    case 'next': if (qi + 1 < queue.length) loadIndex(qi + 1); break;
    case 'prev': if (state.time > 5 || qi <= 0) return command({ type: 'seek', to: 0 }); loadIndex(qi - 1); break;
    case 'volume': state.volume = Math.max(0, Math.min(1, Number(c.value))); output('volume', state.volume); break;
    case 'stop': Object.assign(state, { path: null, title: '', paused: true, time: 0, duration: 0 }); queue = []; qi = -1; output('stop'); break;
    case 'track': {
      if (c.audio !== undefined) { state.audio = Number(c.audio); const t = state.tracks.audio; prefs.audioLang = (probeCache.get(safeResolve(state.path))?.audio[state.audio] || {}).lang || prefs.audioLang; }
      if (c.sub !== undefined) { state.sub = Number(c.sub); prefs.subLang = state.sub < 0 ? '' : (probeCache.get(safeResolve(state.path))?.subs[state.sub] || {}).lang || prefs.subLang; }
      if (castDevice() && castTranscode) castLoad();
      break;
    }
    case 'target': {
      const name = c.name && devices.has(c.name) ? c.name : null;
      if (name === state.target) break;
      if (state.path) output('stop');
      state.target = name; state.error = null;
      if (state.path) { state.paused = false; castDevice() ? castLoad() : toTv(loadCmd()); }
      break;
    }
    default: return false;
  }
  publish();
  return true;
}

// ---- http ------------------------------------------------------------------
function readJson(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
  });
}
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

function serveFile(req, res, full, extraHeaders = {}) {
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    const headers = { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes', ...extraHeaders };
    let start = 0, end = st.size - 1, code = 200;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), end); }
      else { start = Math.max(0, st.size - Number(m[2])); }
      if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      code = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(code, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(full, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);

  if (p === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const client = { res, role: url.searchParams.get('role') === 'tv' ? 'tv' : 'remote' };
    clients.add(client);
    req.on('close', () => { clients.delete(client); publish(); });
    if (client.role === 'tv' && state.path) sse(res, 'cmd', loadCmd());
    publish();
    return;
  }

  if (p === '/api/list') {
    const full = safeResolve(url.searchParams.get('path') || '');
    if (!full) return json(res, 403, { error: 'forbidden' });
    let entries;
    try { entries = fs.readdirSync(full, { withFileTypes: true }); } catch { return json(res, 404, { error: 'not found' }); }
    entries = entries.filter((e) => !e.name.startsWith('.'));
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort(naturalSort);
    const files = entries.filter((e) => e.isFile() && isVideo(e.name)).map((e) => e.name).sort(naturalSort);
    const rel = full === ROOT ? '' : relOf(full);
    return json(res, 200, { path: rel, dirs, files, rootName: path.basename(ROOT) });
  }

  if (p === '/api/cmd' && req.method === 'POST') {
    return json(res, 200, { ok: command(await readJson(req)) });
  }

  if (p === '/api/report' && req.method === 'POST') {
    const r = await readJson(req);
    if (state.target) return json(res, 200, {}); // the TV page is idle while casting
    if (r.ended) { endOfMedia(); return json(res, 200, {}); }
    if (r.error) state.error = String(r.error);
    for (const k of ['time', 'duration', 'paused', 'volume']) if (r[k] !== undefined) state[k] = r[k];
    publish();
    return json(res, 200, {});
  }

  if (p.startsWith('/media/')) {
    const full = safeResolve(p.slice('/media/'.length));
    if (!full || !isVideo(full)) { res.writeHead(403); return res.end(); }
    log(`media ${req.method} ${path.basename(full)} range=${req.headers.range || '-'} from ${req.socket.remoteAddress.replace('::ffff:', '')}`);
    return serveFile(req, res, full);
  }

  if (p.startsWith('/transcode/')) {
    const full = safeResolve(p.slice('/transcode/'.length));
    if (!full || !isVideo(full) || !FFMPEG) { res.writeHead(403); return res.end(); }
    return serveTranscode(req, res, full, Math.max(0, Number(url.searchParams.get('start')) || 0), Number(url.searchParams.get('a') || 0), Number(url.searchParams.get('s') ?? -1));
  }

  if (p === '/api/info') {
    const full = safeResolve(url.searchParams.get('path') || '');
    if (!full || !isVideo(full)) return json(res, 404, { error: 'not found' });
    return probe(full, (info) => {
      if (!info) return json(res, 200, { direct: true, duration: 0, audio: [], subs: [], a: 0, s: -1, convert: !!FFMPEG });
      const t = pickTracks(info);
      json(res, 200, { direct: directPlayable(info, full) || !FFMPEG, duration: info.duration, audio: info.audio.map(trackLabel), subs: info.subs.map(trackLabel), subKinds: info.subs.map((x) => (x.bitmap ? 'bitmap' : 'text')), a: t.audio, s: t.sub });
    });
  }

  if (p === '/api/thumb') { // a poster frame for the cast screen and library, cached on disk (max 2 ffmpeg at once)
    const full = safeResolve(url.searchParams.get('path') || '');
    if (!full || !isVideo(full) || !FFMPEG) { res.writeHead(400); return res.end(); }
    const dirT = path.join(os.tmpdir(), 'tvutils-thumbs'); fs.mkdirSync(dirT, { recursive: true });
    const out = path.join(dirT, require('crypto').createHash('md5').update(full).digest('hex') + '.jpg');
    const send = () => serveFile(req, res, out, { 'Content-Type': 'image/jpeg', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'max-age=86400' });
    if (fs.existsSync(out)) return send();
    let gone = false; res.on('close', () => { gone = true; });
    return thumbLimit((done) => {
      if (gone || fs.existsSync(out)) { done(); return fs.existsSync(out) && !gone ? send() : undefined; }
      probe(full, (info) => {
        const at = Math.max(1, Math.min(600, (info && info.duration ? info.duration : 100) * 0.3)); // past the opening titles
        require('child_process').execFile(FFMPEG, ['-v', 'error', '-ss', String(at), '-i', full, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '5', '-y', out], () => {
          done();
          if (gone) return;
          fs.existsSync(out) ? send() : (res.writeHead(404), res.end());
        });
      });
    });
  }

  if (p === '/api/sub') { // one text subtitle track as WebVTT, timed from `start` (matches a converted stream begun there)
    const full = safeResolve(url.searchParams.get('path') || '');
    const idx = Number(url.searchParams.get('s'));
    if (!full || !isVideo(full) || !FFMPEG || !(idx >= 0)) { res.writeHead(400); return res.end(); }
    const ff = require('child_process').spawn(FFMPEG, ['-v', 'error', '-ss', String(Math.max(0, Number(url.searchParams.get('start')) || 0)), '-i', full, '-map', `0:s:${idx}`, '-f', 'webvtt', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
    res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    ff.stdout.pipe(res);
    res.on('close', () => ff.kill('SIGKILL'));
    return;
  }

  if (p === '/api/hls' && req.method === 'POST') {
    const b = await readJson(req);
    const full = safeResolve(b.path || '');
    if (!full || !isVideo(full) || !FFMPEG) return json(res, 400, { error: 'unavailable' });
    if (b.prev) stopHls(String(b.prev));
    return startHls(full, Math.max(0, Number(b.start) || 0), Number(b.a) || 0, b.s === undefined ? -1 : Number(b.s), (err, id) =>
      err ? json(res, 500, { error: err.message }) : json(res, 200, { sid: id, url: `/hls/${id}/index.m3u8` }));
  }
  if (p === '/api/hls/stop' && req.method === 'POST') { stopHls(String((await readJson(req)).sid || '')); return json(res, 200, {}); }

  const hm = /^\/hls\/([a-f0-9]{16})\/(index\.m3u8|s\d{5}\.ts)$/.exec(p);
  if (hm) {
    const h = hls.get(hm[1]);
    if (!h) { res.writeHead(404); return res.end(); }
    h.last = Date.now();
    const type = hm[2].endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t';
    return serveFile(req, res, path.join(h.dir, hm[2]), { 'Content-Type': type, 'Cache-Control': 'no-store' });
  }

  // Folder picker: only the home folder and external drives can be browsed, and only folder names are listed.
  if (p === '/api/search') {
    const terms = normName(url.searchParams.get('q') || '').split(' ').filter(Boolean);
    if (!terms.length) return json(res, 200, { dirs: [], files: [], total: 0 });
    const items = await getIndex();
    const hits = items.filter((it) => terms.every((t) => it.n.includes(t)));
    // Names that match on the file/folder name itself rank above ones matching only through a parent folder.
    const score = (it) => (terms.every((t) => it.b.includes(t)) ? 0 : 1);
    hits.sort((a, b) => score(a) - score(b) || naturalSort(a.r, b.r));
    const cap = 150;
    return json(res, 200, {
      dirs: hits.filter((i) => i.d).slice(0, 40).map((i) => ({ path: i.r, name: path.basename(i.r) })),
      files: hits.filter((i) => !i.d).slice(0, cap).map((i) => ({ path: i.r, name: path.basename(i.r), dir: path.dirname(i.r) === '.' ? '' : path.dirname(i.r) })),
      total: hits.length, truncated: hits.length > cap,
    });
  }

  if (p === '/api/settings') {
    if (req.method === 'POST') {
      const b = await readJson(req);
      if (b.endOnStop !== undefined) { endOnStop = !!b.endOnStop; saveConfig({ endOnStop }); log('setting: close TV cast screen on stop = ' + endOnStop); }
      if (b.castArtwork !== undefined) { castArtwork = !!b.castArtwork; saveConfig({ castArtwork }); log('setting: send poster image to TV = ' + castArtwork + ' (applies to the next video)'); }
      if (b.castPoll !== undefined) { castPoll = !!b.castPoll; saveConfig({ castPoll }); log('setting: poll TV status = ' + castPoll); }
      if (b.castSubs !== undefined) { castSubs = !!b.castSubs; saveConfig({ castSubs }); log('setting: send text subtitles to TV = ' + castSubs + ' (applies to the next video)'); }
    }
    return json(res, 200, { endOnStop, castArtwork, castSubs, castPoll });
  }

  if (p === '/api/dirs') {
    const want = url.searchParams.get('path') || '';
    if (!want) {
      const vols = fs.existsSync('/Volumes') ? fs.readdirSync('/Volumes').filter((n) => !n.startsWith('.')).map((n) => ({ name: n, path: path.join('/Volumes', n) }))
        .filter((v) => browsable(v.path)) : [];
      return json(res, 200, { path: '', parent: null, root: ROOT, dirs: [{ name: 'Home', path: os.homedir() }, ...vols], videos: 0 });
    }
    const r = browsable(want);
    if (!r) return json(res, 403, { error: 'not allowed' });
    let entries = [];
    try { entries = fs.readdirSync(r, { withFileTypes: true }); } catch { return json(res, 403, { error: 'cannot read this folder (macOS may need permission for TVUtils)' }); }
    const dirs = entries.filter((e) => !e.name.startsWith('.') && (e.isDirectory() || (e.isSymbolicLink() && (() => { try { return fs.statSync(path.join(r, e.name)).isDirectory(); } catch { return false; } })())))
      .map((e) => e.name).sort(naturalSort).map((n) => ({ name: n, path: path.join(r, n) }));
    const top = r === os.homedir() || path.dirname(r) === '/Volumes';
    return json(res, 200, { path: r, parent: top ? '' : path.dirname(r), root: ROOT, dirs, videos: entries.filter((e) => e.isFile() && isVideo(e.name)).length });
  }
  if (p === '/api/root' && req.method === 'POST') {
    const r = browsable((await readJson(req)).path || '');
    if (!r || !fs.existsSync(r) || !fs.statSync(r).isDirectory()) return json(res, 400, { error: 'not a usable folder' });
    command({ type: 'stop' });
    ROOT = r; probeCache.clear(); indexCache.items = null; indexCache.pending = null;
    saveConfig({ root: ROOT });
    log('media folder → ' + ROOT);
    return json(res, 200, { root: ROOT });
  }

  if (p === '/api/logs') return json(res, 200, { logs });

  const pages = { '/': 'remote.html', '/remote': 'remote.html', '/tv': 'tv.html', '/hls.min.js': 'hls.min.js' };
  if (pages[p]) return serveFile(req, res, path.join(PUBLIC, pages[p]), { 'Cache-Control': 'no-cache' });
  res.writeHead(404); res.end('Not found');
});

process.on('uncaughtException', (e) => console.error('uncaught:', e.message));
setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 15000);

// When launched by the menu bar app, exit if it goes away so no orphan keeps the port.
if (process.env.TVUTILS_PARENT) {
  setInterval(() => { try { process.kill(Number(process.env.TVUTILS_PARENT), 0); } catch { process.exit(0); } }, 2000);
}

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log(`Media folder: ${ROOT}\n`);
  for (const ip of ips) console.log(`  Phone       → http://${ip}:${PORT}/\n  TV browser  → http://${ip}:${PORT}/tv  (fallback if you can't cast)\n`);
});
