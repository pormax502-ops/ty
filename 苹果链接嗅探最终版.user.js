// ==UserScript==
// @name         链接嗅探
// @namespace    video-sniffer
// @version      4.0
// @description  自动检测视频地址，点击小图标一键复制
// @match        *://*/*
// @run-at       document-idle
// @grant        GM_setClipboard
// ==/UserScript==

(function () {
  'use strict';

  if (window.__linkSnifferV4) return;
  window.__linkSnifferV4 = true;

  const seen = new Set();
  let currentURL = '';
  let button = null;
  let observer = null;
  let timer = null;

  const style = `
    position:fixed;
    right:12px;
    bottom:115px;
    width:30px;
    height:30px;
    padding:0;
    border:0;
    border-radius:50%;
    background:rgba(25,25,25,.48);
    display:flex;
    align-items:center;
    justify-content:center;
    opacity:.68;
    z-index:2147483647;
    -webkit-tap-highlight-color:transparent;
  `;

  function icon(success = false) {
    return success
      ? `<svg viewBox="0 0 24 24" width="15" height="15"
          fill="none" stroke="white" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round">
          <path d="m5 12 4 4L19 6"/></svg>`
      : `<svg viewBox="0 0 24 24" width="15" height="15"
          fill="none" stroke="white" stroke-width="1.8"
          stroke-linecap="round" stroke-linejoin="round">
          <rect x="8" y="8" width="12" height="12" rx="2"/>
          <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>
        </svg>`;
  }

  function getURLs() {
    const urls = [];

    document.querySelectorAll('video').forEach(video => {
      const url = video.currentSrc || video.src;
      if (url && /^https?:\/\//i.test(url)) urls.push(url);

      video.querySelectorAll('source').forEach(source => {
        if (source.src && /^https?:\/\//i.test(source.src)) {
          urls.push(source.src);
        }
      });
    });

    document.querySelectorAll(
      'a[href$=".mp4"],a[href$=".m3u8"],a[href$=".webm"],a[href$=".mpd"]'
    ).forEach(a => urls.push(a.href));

    return [...new Set(urls)];
  }

  function getPreferredURL(urls) {
    const videos = [...document.querySelectorAll('video')];
    const playing = videos.find(v => !v.paused && v.currentSrc);
    const active = playing || videos.find(v => v.currentSrc);
    if (active?.currentSrc) return active.currentSrc;
    return urls[0] || '';
  }

  function createButton() {
    if (button) return;
    button = document.createElement('button');
    button.type = 'button';
    button.innerHTML = icon();
    button.style.cssText = style;
    button.title = 'Copy video URL';

    button.addEventListener('click', () => {
      const url = currentURL;
      if (!url) return;

      try {
        if (typeof GM_setClipboard === 'function') {
          GM_setClipboard(url);
          showSuccess();
        } else if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(url).then(showSuccess);
        }
      } catch (error) {
        console.error('Copy failed', error);
      }
    });

    (document.body || document.documentElement).appendChild(button);
  }

  function showSuccess() {
    if (!button) return;
    button.innerHTML = icon(true);
    setTimeout(() => {
      if (button?.isConnected) button.innerHTML = icon();
    }, 900);
  }

  function scan() {
    const urls = getURLs();
    const preferred = getPreferredURL(urls);

    if (!preferred) {
      if (button) button.remove();
      button = null;
      currentURL = '';
      return;
    }

    currentURL = preferred;
    urls.forEach(url => seen.add(url));
    createButton();
  }

  function start() {
    scan();

    if (observer) observer.disconnect();
    observer = new MutationObserver(scan);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src']
    });

    clearInterval(timer);
    timer = setInterval(scan, 2000);
  }

  start();

  document.addEventListener('play', scan, true);
  document.addEventListener('loadedmetadata', scan, true);

  window.addEventListener('pageshow', start);
})();
