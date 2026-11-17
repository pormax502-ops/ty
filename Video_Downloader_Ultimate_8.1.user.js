// ==UserScript==
// @name         Video Downloader Ultimate 8.1
// @namespace    local.video.downloader.ultimate
// @version      8.1.0
// @description  Safari 网页媒体扫描与 HLS 分片下载管理器
// @match        *://*/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';
  if (window.top !== window.self || document.getElementById('vdu81-host')) return;

  const VERSION = '8.1.0';
  const MAX_WORKERS = 3;
  const RETRIES = 3;
  const MAX_PLAYLIST = 8 * 1024 * 1024;
  const MAX_SEGMENTS = 12000;
  const media = new Map();
  const jobs = new Map();
  let activeTab = 'media';
  let renderTimer = 0;
  let scanTimer = 0;

  const fmtBytes = n => {
    if (!Number.isFinite(n) || n < 0) return '未知大小';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i ? 2 : 0)} ${units[i]}`;
  };
  const fmtTime = ms => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const safeName = s => String(s || 'video').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120);
  const ext = url => { try { return new URL(url).pathname.split('.').pop().toLowerCase(); } catch { return ''; } };
  const resolve = (url, base = location.href) => { try { return new URL(url, base).href; } catch { return ''; } };
  const isHls = (url, mime = '') => /\.m3u8(?:$|[?#])/i.test(url) || /mpegurl/i.test(mime);
  const isVideo = (url, mime = '') => isHls(url, mime) || /\.(mp4|m4v|mov|webm|mpd)(?:$|[?#])/i.test(url) || /^video\//i.test(mime);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

  function addMedia(url, mime = '', source = '页面资源') {
    url = resolve(url);
    if (!url || !/^https?:/i.test(url) || !isVideo(url, mime)) return;
    const old = media.get(url);
    media.set(url, { url, mime: mime || old?.mime || '', type: isHls(url, mime) ? 'HLS' : '视频', source, seen: Date.now() });
    scheduleRender();
  }

  function scanPage() {
    document.querySelectorAll('video, audio, source').forEach(el => {
      if (el.currentSrc) addMedia(el.currentSrc, el.type, '播放器');
      if (el.src) addMedia(el.src, el.type, '页面播放器');
      if (el.getAttribute('src')) addMedia(el.getAttribute('src'), el.type, '媒体元素');
    });
    try {
      performance.getEntriesByType('resource').forEach(entry => addMedia(entry.name, entry.initiatorType, '网络资源'));
    } catch (_) {}
  }

  const observer = new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanPage, 500);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  scanPage();
  setInterval(scanPage, 2500);

  async function fetchResponse(url, options = {}, retries = RETRIES) {
    let last;
    for (let i = 0; i <= retries; i++) {
      try {
        const response = await fetch(url, { credentials: 'include', ...options });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response;
      } catch (e) {
        last = e;
        if (options.signal?.aborted || i === retries) throw e;
        await new Promise(r => setTimeout(r, Math.min(4000, 400 * (i + 1))));
      }
    }
    throw last;
  }

  async function fetchText(url, signal) {
    const response = await fetchResponse(url, { signal });
    const text = await response.text();
    if (text.length > MAX_PLAYLIST) throw new Error('播放列表超过大小限制');
    if (!/^\uFEFF?\s*#EXTM3U/.test(text)) throw new Error('不是有效的 M3U8 播放列表');
    return text;
  }

  function parseAttrs(line) {
    const result = {};
    const re = /([A-Z0-9-]+)=("(?:[^"\\]|\\.)*"|[^,]*)/gi;
    let m;
    while ((m = re.exec(line.slice(line.indexOf(':') + 1)))) result[m[1].toUpperCase()] = m[2].replace(/^"|"$/g, '');
    return result;
  }

  function parseMaster(text, base) {
    const lines = text.split(/\r?\n/).map(x => x.trim());
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      if (!/^#EXT-X-STREAM-INF:/i.test(lines[i])) continue;
      const a = parseAttrs(lines[i]);
      let j = i + 1;
      while (j < lines.length && (!lines[j] || lines[j][0] === '#')) j++;
      if (j >= lines.length) continue;
      const resolution = (a.RESOLUTION || '').match(/^(\d+)x(\d+)$/i);
      variants.push({
        url: resolve(lines[j], base),
        height: resolution ? Number(resolution[2]) : 0,
        width: resolution ? Number(resolution[1]) : 0,
        bandwidth: Number(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH || 0),
        codecs: a.CODECS || ''
      });
    }
    return variants.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  }

  function parseMediaPlaylist(text, base) {
    const lines = text.split(/\r?\n/).map(x => x.trim());
    const segments = [];
    let duration = 0;
    let key = null;
    let map = null;
    let range = null;
    let previousRangeEnd = 0;
    let sequence = Number((text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/i) || [])[1] || 0);
    let totalDuration = 0;
    for (const line of lines) {
      if (!line) continue;
      if (line.startsWith('#EXT-X-KEY:')) {
        const a = parseAttrs(line);
        if (a.METHOD === 'NONE') key = null;
        else if (a.METHOD === 'AES-128') key = { method: a.METHOD, url: resolve(a.URI, base), iv: a.IV || '' };
        else throw new Error(`暂不支持加密方式：${a.METHOD || '未知'}`);
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const a = parseAttrs(line);
        map = { url: resolve(a.URI, base), range: a.BYTERANGE || '' };
      } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
        range = line.split(':').slice(1).join(':');
      } else if (line.startsWith('#EXTINF:')) {
        duration = Number((line.slice(8).split(',')[0] || '0')) || 0;
      } else if (line[0] !== '#') {
        let byteRange = null;
        if (range) {
          const m = range.match(/^(\d+)(?:@(\d+))?$/);
          if (!m) throw new Error('无法解析分片 BYTERANGE');
          const length = Number(m[1]);
          const start = m[2] ? Number(m[2]) : previousRangeEnd;
          byteRange = { start, end: start + length - 1 };
          previousRangeEnd = start + length;
          range = null;
        }
        segments.push({ url: resolve(line, base), duration, key, map, range: byteRange, sequence: sequence++ });
        totalDuration += duration;
        duration = 0;
        if (segments.length > MAX_SEGMENTS) throw new Error('分片数量超过安全上限');
      }
    }
    return { segments, duration: totalDuration, live: !/#EXT-X-ENDLIST/i.test(text) };
  }

  function ivFrom(value, sequence) {
    const out = new Uint8Array(16);
    if (value) {
      const hex = value.replace(/^0x/i, '').padStart(32, '0').slice(-32);
      for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16) || 0;
    } else {
      let n = BigInt(sequence);
      for (let i = 15; i >= 0; i--) { out[i] = Number(n & 255n); n >>= 8n; }
    }
    return out;
  }

  const keyCache = new Map();
  async function decryptAes128(data, keyInfo, sequence, signal) {
    if (!keyInfo) return data;
    const cacheKey = keyInfo.url;
    let cryptoKey = keyCache.get(cacheKey);
    if (!cryptoKey) {
      const response = await fetchResponse(keyInfo.url, { signal });
      const raw = await response.arrayBuffer();
      if (raw.byteLength !== 16) throw new Error('AES-128 密钥长度不是 16 字节');
      cryptoKey = await crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['decrypt']);
      keyCache.set(cacheKey, cryptoKey);
    }
    const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivFrom(keyInfo.iv, sequence) }, cryptoKey, data);
    return plain;
  }

  async function fetchBinary(item, signal) {
    const headers = {};
    if (item.range) headers.Range = `bytes=${item.range.start}-${item.range.end}`;
    const response = await fetchResponse(item.url, { headers, signal });
    let data = await response.arrayBuffer();
    if (item.key) data = await decryptAes128(data, item.key, item.sequence, signal);
    return data;
  }

  async function mapLimit(items, limit, worker, signal, onProgress) {
    let cursor = 0;
    let completed = 0;
    const results = new Array(items.length);
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        if (signal.aborted) throw new DOMException('已取消', 'AbortError');
        const index = cursor++;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
        completed++;
        onProgress?.(completed, items.length);
      }
    });
    await Promise.all(runners);
    return results;
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 60000);
  }

  function createJob(item) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const job = {
      id, item, name: safeName(decodeURIComponent((() => { try { return new URL(item.url).pathname.split('/').pop(); } catch { return 'video'; } })()).replace(/\.(m3u8|mp4).*$/i, '')) || 'video',
      status: '等待中', progress: 0, total: 0, downloaded: 0, started: 0, elapsed: 0,
      size: 0, error: '', controller: new AbortController(), speed: 0, cancel: false
    };
    jobs.set(id, job);
    render();
    runJob(job);
    return job;
  }

  async function runJob(job) {
    const signal = job.controller.signal;
    const started = performance.now();
    job.started = started;
    job.status = '准备中';
    try {
      const source = job.item.url;
      let blob;
      let filename;
      if (!isHls(source, job.item.mime)) {
        job.status = '下载中';
        const response = await fetchResponse(source, { signal });
        const data = await response.arrayBuffer();
        job.size = data.byteLength;
        job.downloaded = data.byteLength;
        job.progress = 100;
        const mime = response.headers.get('content-type') || 'video/mp4';
        blob = new Blob([data], { type: mime });
        filename = safeName(job.name || 'video') + (ext(source) ? '.' + ext(source) : '.mp4');
      } else {
        job.status = '读取播放列表';
        let text = await fetchText(source, signal);
        let variants = parseMaster(text, source);
        if (variants.length) {
          const selected = variants[0];
          job.name = safeName(job.name || 'video');
          job.status = `选择 ${selected.height ? selected.height + 'P' : '最高画质'}`;
          text = await fetchText(selected.url, signal);
          job.variant = selected;
        }
        const playlist = parseMediaPlaylist(text, variants.length ? variants[0].url : source);
        if (!playlist.segments.length) throw new Error('播放列表没有可下载分片');
        if (playlist.live) throw new Error('这是实时直播流（没有 EXT-X-ENDLIST），暂不自动录制');
        job.total = playlist.segments.length;
        job.status = '下载分片中';
        let mapData = null;
        const mapItem = playlist.segments.find(s => s.map)?.map;
        if (mapItem) {
          const m = await fetchBinary({ url: mapItem.url, range: null, key: null, sequence: 0 }, signal);
          mapData = m;
        }
        const chunks = await mapLimit(playlist.segments, MAX_WORKERS, async (segment, index) => {
          const data = await fetchBinary(segment, signal);
          job.downloaded += data.byteLength;
          job.size = job.downloaded;
          job.progress = Math.round((index + 1) / playlist.segments.length * 100);
          job.elapsed = performance.now() - started;
          job.speed = job.elapsed > 0 ? job.downloaded / (job.elapsed / 1000) : 0;
          scheduleRender();
          return data;
        }, signal, (done, total) => {
          job.status = `下载分片 ${done}/${total}`;
        });
        const parts = [];
        if (mapData) parts.push(mapData);
        parts.push(...chunks);
        const looksFmp4 = !!mapData || playlist.segments.some(s => /\.m4s(?:$|[?#])/i.test(s.url));
        blob = new Blob(parts, { type: looksFmp4 ? 'video/mp4' : 'video/mp2t' });
        filename = safeName(job.name || 'video') + (looksFmp4 ? '.mp4' : '.ts');
      }
      if (!blob || !blob.size) throw new Error('下载结果为空');
      job.size = blob.size;
      job.progress = 100;
      job.status = '已完成';
      job.elapsed = performance.now() - started;
      job.blob = blob;
      job.filename = filename;
      job.save = () => saveBlob(job.blob, job.filename);
    } catch (error) {
      job.elapsed = performance.now() - started;
      job.error = error?.name === 'AbortError' ? '已取消' : (error?.message || '下载失败');
      job.status = error?.name === 'AbortError' ? '已取消' : '失败';
    }
    render();
  }

  function cancelJob(job) {
    job.cancel = true;
    job.controller.abort();
    if (job.status !== '已完成') job.status = '已取消';
    render();
  }

  // UI is kept closed until the user taps the small floating icon.
  const host = document.createElement('div');
  host.id = 'vdu81-host';
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:14px;bottom:110px;';
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host{all:initial;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display",sans-serif;color:#f5f5f7}
      *{box-sizing:border-box}
      #launcher{width:26px;height:26px;border:0;border-radius:50%;background:#19b65b;color:white;display:grid;place-items:center;padding:0;box-shadow:0 2px 12px #0005;cursor:pointer}
      #launcher svg{width:15px;height:15px}
      #panel{display:none;position:fixed;right:10px;bottom:148px;width:min(360px,calc(100vw - 20px));max-height:min(72vh,620px);overflow:hidden;background:rgba(23,25,30,.97);border:1px solid #ffffff20;border-radius:18px;box-shadow:0 12px 45px #0008;backdrop-filter:blur(22px);color:#f5f5f7}
      #panel.open{display:flex;flex-direction:column}
      header{padding:14px 15px 10px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #ffffff16}
      .brand{font-size:14px;font-weight:700;letter-spacing:.2px}.sub{font-size:10px;color:#9298a4;margin-top:3px}
      button{font:inherit;cursor:pointer} .close{border:0;background:#ffffff12;color:#ddd;border-radius:10px;width:30px;height:30px;font-size:18px}
      nav{display:flex;gap:6px;padding:10px 12px;border-bottom:1px solid #ffffff12}
      nav button{flex:1;border:0;border-radius:9px;background:#ffffff0b;color:#aeb4bf;padding:8px 4px;font-size:12px}
      nav button.active{background:#174d32;color:#69e69a}
      #content{overflow:auto;padding:10px 12px 14px;min-height:120px}
      .item{padding:11px;margin-bottom:8px;border:1px solid #ffffff12;border-radius:12px;background:#ffffff08}
      .name{font-size:12px;font-weight:650;overflow-wrap:anywhere;line-height:1.4}
      .meta{font-size:10px;color:#9da4b0;margin-top:5px;line-height:1.5;overflow-wrap:anywhere}
      .actions{display:flex;gap:6px;margin-top:9px;flex-wrap:wrap}
      .act{border:0;border-radius:8px;padding:7px 10px;font-size:11px;background:#ffffff13;color:#eee}
      .green{background:#147a40;color:#fff}.red{background:#6d3030;color:#fff}
      .empty{text-align:center;padding:28px 8px;color:#9da4b0;font-size:12px;line-height:1.7}
      .bar{height:5px;background:#ffffff16;border-radius:9px;overflow:hidden;margin-top:8px}.fill{height:100%;background:#20c568;width:0;transition:width .2s}
      .status{font-size:11px;color:#b8c0ca;margin-top:7px;display:flex;justify-content:space-between;gap:8px}
      .hint{font-size:10px;color:#858d99;line-height:1.55;margin:8px 2px}
      .topline{display:flex;align-items:center;justify-content:space-between;gap:8px}
      .pill{font-size:9px;color:#72e5a0;background:#16452e;padding:3px 7px;border-radius:20px;white-space:nowrap}
    </style>
    <button id="launcher" title="打开视频下载器" aria-label="打开视频下载器"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m-5-5 5 5 5-5M5 20h14"/></svg></button>
    <section id="panel" aria-label="Video Downloader">
      <header><div><div class="brand">VIDEO DOWNLOADER</div><div class="sub">ULTIMATE ${VERSION} · Safari</div></div><button class="close" id="close">×</button></header>
      <nav><button data-tab="media" class="active">资源 <span id="media-count">0</span></button><button data-tab="jobs">下载任务 <span id="job-count">0</span></button></nav>
      <div id="content"></div>
    </section>`;

  const q = selector => shadow.querySelector(selector);
  q('#launcher').addEventListener('click', () => { q('#panel').classList.toggle('open'); render(); });
  q('#close').addEventListener('click', () => q('#panel').classList.remove('open'));
  shadow.querySelectorAll('nav button').forEach(button => button.addEventListener('click', () => {
    activeTab = button.dataset.tab;
    shadow.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b === button));
    render();
  }));

  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 180);
  }

  function render() {
    q('#media-count').textContent = media.size;
    q('#job-count').textContent = jobs.size;
    if (!q('#panel').classList.contains('open')) return;
    const content = q('#content');
    if (activeTab === 'media') {
      if (!media.size) {
        content.innerHTML = '<div class="empty">暂未发现视频资源<br>播放网页视频后会自动静默扫描</div>';
        return;
      }
      content.innerHTML = [...media.values()].sort((a,b) => b.seen-a.seen).map((item, index) => `
        <article class="item"><div class="topline"><div class="name">${esc(item.url.split('/').pop().split('?')[0] || '网页视频')}</div><span class="pill">${esc(item.type)}</span></div>
        <div class="meta">来源：${esc(item.source)}<br>${esc(new URL(item.url).host)}</div>
        <div class="actions"><button class="act green" data-download="${index}">下载</button><button class="act" data-copy="${index}">复制地址</button></div></article>`).join('');
      const list = [...media.values()].sort((a,b) => b.seen-a.seen);
      content.querySelectorAll('[data-download]').forEach(btn => btn.addEventListener('click', () => createJob(list[Number(btn.dataset.download)])));
      content.querySelectorAll('[data-copy]').forEach(btn => btn.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(list[Number(btn.dataset.copy)].url); btn.textContent = '已复制'; }
        catch (_) { btn.textContent = '复制失败'; }
      }));
    } else {
      if (!jobs.size) {
        content.innerHTML = '<div class="empty">暂无下载任务<br>在「资源」中选择视频开始下载</div>';
        return;
      }
      content.innerHTML = [...jobs.values()].reverse().map(job => `
        <article class="item"><div class="topline"><div class="name">${esc(job.name)}</div><span class="pill">${esc(job.status)}</span></div>
        <div class="bar"><div class="fill" style="width:${Math.max(0,Math.min(100,job.progress))}%"></div></div>
        <div class="status"><span>${job.progress}% · ${fmtBytes(job.size)}</span><span>${fmtTime(job.elapsed)}${job.speed ? ' · '+fmtBytes(job.speed)+'/s' : ''}</span></div>
        ${job.error ? `<div class="meta">${esc(job.error)}</div>` : ''}
        <div class="actions">${job.status === '已完成' ? '<button class="act green" data-save="'+esc(job.id)+'">保存视频</button>' : ''}${['等待中','准备中','读取播放列表','下载分片中','下载中'].includes(job.status) ? '<button class="act red" data-cancel="'+esc(job.id)+'">取消</button>' : ''}<button class="act" data-remove="${esc(job.id)}">移除</button></div></article>`).join('');
      content.querySelectorAll('[data-save]').forEach(btn => btn.addEventListener('click', () => jobs.get(btn.dataset.save)?.save?.()));
      content.querySelectorAll('[data-cancel]').forEach(btn => btn.addEventListener('click', () => cancelJob(jobs.get(btn.dataset.cancel))));
      content.querySelectorAll('[data-remove]').forEach(btn => btn.addEventListener('click', () => { const job = jobs.get(btn.dataset.remove); if (job && !['已完成','失败','已取消'].includes(job.status)) cancelJob(job); jobs.delete(btn.dataset.remove); render(); }));
    }
    if (activeTab === 'jobs') {
      const note = document.createElement('div');
      note.className = 'hint';
      note.textContent = '提示：iOS 的实际保存位置由 Safari 和系统下载设置决定。若浏览器显示预览，请使用分享菜单存储到“文件”。';
      content.appendChild(note);
    }
  }

  // Do not auto-open the panel when a page or video is opened.
  // Only the 26 × 26 green launcher remains visible until tapped.
  render();
})();
