/* Panda continuous reader — supports e-hentai.org and exhentai.org */
(function () {
  'use strict';

  if (window.__pandaReader) {
    var current = document.getElementById('panda-panel');
    if (current) current.scrollIntoView({ behavior: 'smooth' });
    return;
  }
  window.__pandaReader = true;

  var match = location.pathname.match(/^\/g\/(\d+)\/([\da-z]+)\/?/i);
  var grid = document.getElementById('gdt');
  if (!/(^|\.)(e-hentai\.org|exhentai\.org)$/i.test(location.hostname) || !match || !grid) {
    alert('请在 e-hentai.org 或 exhentai.org 的画廊缩略图页面运行 Panda。');
    return;
  }

  var state = {
    gid: match[1], token: match[2], total: 0, all: [], selected: [],
    failed: [], loaded: 0, running: false, stopped: false, controller: null
  };
  var CONCURRENCY = 3;
  var REQUEST_DELAY = 180;
  var RETRIES = 3;

  function make(tag, attrs, text) {
    var item = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      if (key === 'className') item.className = attrs[key];
      else if (key === 'checked' || key === 'disabled') item[key] = attrs[key];
      else item.setAttribute(key, attrs[key]);
    });
    if (text != null) item.textContent = text;
    return item;
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function setStatus(text) {
    document.getElementById('panda-status').textContent = text;
  }

  function totalFrom(doc) {
    var texts = doc.querySelectorAll('.gpc');
    for (var i = 0; i < texts.length; i += 1) {
      var found = texts[i].textContent.match(/of\s+([\d,]+)\s+images/i);
      if (found) return Number(found[1].replace(/,/g, ''));
    }
    var rows = doc.querySelectorAll('#gdd tr');
    for (var j = 0; j < rows.length; j += 1) {
      var fallback = rows[j].textContent.match(/Length:\s*([\d,]+)\s+pages/i);
      if (fallback) return Number(fallback[1].replace(/,/g, ''));
    }
    return 0;
  }

  function galleryLinks(doc) {
    var unique = new Map();
    Array.prototype.forEach.call(doc.querySelectorAll('#gdt a[href*="/s/"]'), function (anchor) {
      var url;
      try {
        url = new URL(anchor.getAttribute('href'), location.origin);
      } catch (_) {
        return;
      }
      var parts = url.pathname.match(/^\/s\/([\da-z]+)\/(\d+)-(\d+)/i);
      if (!parts || parts[2] !== state.gid) return;
      var number = Number(parts[3]);
      unique.set(number, { number: number, pageUrl: url.href });
    });
    return Array.from(unique.values()).sort(function (a, b) { return a.number - b.number; });
  }

  function imageUrlFrom(html, pageUrl, preferOriginal) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var image = doc.querySelector('img#img');
    var original = doc.querySelector('a[href*="/fullimg/"],a[href*="/fullimg.php"]');
    var source = preferOriginal && original
      ? original.getAttribute('href')
      : image && image.getAttribute('src');
    if (!source && original) source = original.getAttribute('href');
    if (!source) throw new Error('图片页中找不到 #img 或原图链接');
    return new URL(source, pageUrl).href;
  }

  async function request(url, attempt) {
    attempt = attempt || 1;
    try {
      var response = await fetch(url, {
        credentials: 'same-origin',
        cache: 'no-store',
        signal: state.controller.signal,
        headers: { Accept: 'text/html,application/xhtml+xml' }
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var html = await response.text();
      if (!html || /temporarily banned/i.test(html)) throw new Error('站点返回限制页面');
      return html;
    } catch (error) {
      if (error.name === 'AbortError' || attempt >= RETRIES) throw error;
      await sleep(700 * attempt);
      return request(url, attempt + 1);
    }
  }

  async function pool(items, concurrency, worker) {
    var cursor = 0;
    async function consume() {
      while (cursor < items.length && !state.stopped) {
        var index = cursor;
        cursor += 1;
        await worker(items[index], index);
      }
    }
    var workers = [];
    for (var i = 0; i < Math.min(concurrency, items.length); i += 1) workers.push(consume());
    await Promise.all(workers);
  }

  function hideOriginalGrid() {
    var hidden = document.getElementById('panda-hide').checked;
    grid.style.display = hidden ? 'none' : '';
    Array.prototype.forEach.call(document.querySelectorAll('.gtb'), function (item) {
      item.style.display = hidden ? 'none' : '';
    });
  }

  function setControls(running) {
    state.running = running;
    document.getElementById('panda-start').disabled = running;
    document.getElementById('panda-stop').disabled = !running;
    ['panda-from', 'panda-to', 'panda-original'].forEach(function (id) {
      document.getElementById(id).disabled = running;
    });
  }

  function buildUi() {
    var style = make('style', { id: 'panda-style' });
    style.textContent =
      '#panda-panel{box-sizing:border-box;position:sticky;top:0;z-index:9999;margin:10px auto;' +
      'padding:10px 14px;max-width:980px;border:1px solid #77675d;border-radius:7px;' +
      'background:#34302d;color:#eee;box-shadow:0 2px 10px #0008;font:14px/1.5 Arial,sans-serif}' +
      '#panda-panel .row{display:flex;align-items:center;gap:9px;flex-wrap:wrap}' +
      '#panda-panel input[type=number]{width:65px;padding:3px}#panda-panel button{padding:5px 11px}' +
      '#panda-status{margin-top:6px;min-height:21px}#panda-progress{width:100%;height:12px}' +
      '#panda-list{margin:12px auto;max-width:1280px;text-align:center}' +
      '.panda-card{position:relative;margin:0 auto 12px;min-height:100px}' +
      '.panda-card img{display:block;margin:auto;max-width:100%;height:auto;min-width:80px;' +
      'min-height:80px;background:#111}.panda-no{position:absolute;left:8px;top:8px;padding:2px 7px;' +
      'border-radius:3px;background:#000b;color:#fff;font:13px Arial}' +
      '.panda-error{box-sizing:border-box;margin:auto;padding:45px 12px;max-width:720px;' +
      'border:1px dashed #b66;background:#2a2020;color:#f2b5b5}' +
      '@media(max-width:600px){#panda-panel{position:relative;margin:6px;padding:8px}.panda-card{margin-bottom:6px}}';
    document.head.appendChild(style);

    var panel = make('div', { id: 'panda-panel' });
    var row = make('div', { className: 'row' });
    row.appendChild(make('strong', {}, 'Panda 连续阅读'));
    row.appendChild(make('label', { for: 'panda-from' }, '范围'));
    row.appendChild(make('input', { id: 'panda-from', type: 'number', min: '1', value: '1' }));
    row.appendChild(make('span', {}, '—'));
    row.appendChild(make('input', { id: 'panda-to', type: 'number', min: '1', value: '1' }));

    var originalLabel = make('label');
    originalLabel.appendChild(make('input', { id: 'panda-original', type: 'checkbox' }));
    originalLabel.appendChild(document.createTextNode(' 优先原图'));
    row.appendChild(originalLabel);

    var hideLabel = make('label');
    hideLabel.appendChild(make('input', { id: 'panda-hide', type: 'checkbox', checked: true }));
    hideLabel.appendChild(document.createTextNode(' 隐藏缩略图'));
    row.appendChild(hideLabel);

    row.appendChild(make('button', { id: 'panda-start', type: 'button' }, '开始加载'));
    row.appendChild(make('button', { id: 'panda-stop', type: 'button', disabled: true }, '停止'));
    row.appendChild(make('button', { id: 'panda-retry', type: 'button', disabled: true }, '重试失败'));
    panel.appendChild(row);
    panel.appendChild(make('div', { id: 'panda-status' }, '正在分析画廊…'));
    panel.appendChild(make('progress', { id: 'panda-progress', value: '0', max: '1' }));

    grid.parentNode.insertBefore(panel, grid);
    grid.parentNode.insertBefore(make('div', { id: 'panda-list' }), grid.nextSibling);
    document.getElementById('panda-hide').addEventListener('change', hideOriginalGrid);
    document.getElementById('panda-start').addEventListener('click', start);
    document.getElementById('panda-stop').addEventListener('click', stop);
    document.getElementById('panda-retry').addEventListener('click', retryFailed);
  }

  async function collectAllLinks() {
    var first = galleryLinks(document);
    state.total = totalFrom(document);
    if (!state.total || !first.length) throw new Error('无法识别图片总数或缩略图链接');

    var maxPage = 0;
    Array.prototype.forEach.call(document.querySelectorAll('.ptt a[href],.ptb a[href]'), function (anchor) {
      try {
        var value = Number(new URL(anchor.getAttribute('href'), location.origin).searchParams.get('p') || 0);
        if (value > maxPage) maxPage = value;
      } catch (_) {}
    });
    var pageCount = Math.max(maxPage + 1, Math.ceil(state.total / first.length));
    var currentPage = Number(new URL(location.href).searchParams.get('p') || 0);
    var all = new Map(first.map(function (entry) { return [entry.number, entry]; }));
    var pages = [];
    for (var p = 0; p < pageCount; p += 1) if (p !== currentPage) pages.push(p);

    var complete = 1;
    setStatus('正在读取缩略图分页：1/' + pageCount);
    await pool(pages, Math.min(3, CONCURRENCY), async function (page) {
      var url = new URL('/g/' + state.gid + '/' + state.token + '/', location.origin);
      if (page) url.searchParams.set('p', String(page));
      var doc = new DOMParser().parseFromString(await request(url.href), 'text/html');
      galleryLinks(doc).forEach(function (entry) { all.set(entry.number, entry); });
      complete += 1;
      setStatus('正在读取缩略图分页：' + complete + '/' + pageCount);
      await sleep(REQUEST_DELAY);
    });

    var entries = Array.from(all.values()).sort(function (a, b) { return a.number - b.number; });
    if (entries.length !== state.total) {
      throw new Error('应找到 ' + state.total + ' 个图片页，实际找到 ' + entries.length + ' 个');
    }
    return entries;
  }

  function createCards(entries) {
    var list = document.getElementById('panda-list');
    list.innerHTML = '';
    entries.forEach(function (entry) {
      var card = make('div', { className: 'panda-card', id: 'panda-page-' + entry.number });
      var link = make('a', { href: entry.pageUrl, target: '_blank', rel: 'noopener' });
      link.appendChild(make('img', {
        alt: '第 ' + entry.number + ' 页（等待加载）',
        loading: 'lazy',
        decoding: 'async'
      }));
      card.appendChild(link);
      card.appendChild(make('span', { className: 'panda-no' }, String(entry.number)));
      list.appendChild(card);
    });
  }

  function showFailure(entry, error) {
    var card = document.getElementById('panda-page-' + entry.number);
    if (!card) return;
    var image = card.querySelector('img');
    if (image) image.remove();
    var old = card.querySelector('.panda-error');
    if (old) old.remove();
    card.querySelector('a').appendChild(make('div', { className: 'panda-error' },
      '第 ' + entry.number + ' 页加载失败：' + (error.message || error) + '（点击打开图片页）'));
  }

  function updateProgress() {
    var progress = document.getElementById('panda-progress');
    progress.max = Math.max(1, state.selected.length);
    progress.value = Math.min(state.loaded, state.selected.length);
    setStatus('已解析 ' + state.loaded + '/' + state.selected.length +
      (state.failed.length ? '，失败 ' + state.failed.length + ' 张' : ''));
  }

  async function loadOne(entry, preferOriginal) {
    try {
      var source = imageUrlFrom(await request(entry.pageUrl), entry.pageUrl, preferOriginal);
      var image = document.querySelector('#panda-page-' + entry.number + ' img');
      if (image) {
        image.alt = '第 ' + entry.number + ' 页';
        image.src = source;
      }
    } catch (error) {
      if (error.name !== 'AbortError') {
        state.failed.push(entry);
        showFailure(entry, error);
      }
    } finally {
      state.loaded += 1;
      updateProgress();
      await sleep(REQUEST_DELAY);
    }
  }

  function requestedRange() {
    var from = Math.max(1, Number(document.getElementById('panda-from').value) || 1);
    var to = Math.min(state.total, Number(document.getElementById('panda-to').value) || state.total);
    if (from > to) throw new Error('起始页不能大于结束页');
    return { from: from, to: to };
  }

  async function start() {
    if (state.running) return;
    state.stopped = false;
    state.failed = [];
    state.loaded = 0;
    state.controller = new AbortController();
    setControls(true);
    document.getElementById('panda-retry').disabled = true;
    hideOriginalGrid();

    try {
      if (!state.all.length) state.all = await collectAllLinks();
      var range = requestedRange();
      state.selected = state.all.filter(function (entry) {
        return entry.number >= range.from && entry.number <= range.to;
      });
      createCards(state.selected);
      var preferOriginal = document.getElementById('panda-original').checked;
      setStatus('找到 ' + state.selected.length + ' 张，开始解析图片页…');
      await pool(state.selected, CONCURRENCY, function (entry) {
        return loadOne(entry, preferOriginal);
      });
      if (state.stopped) setStatus('已停止：完成 ' + state.loaded + '/' + state.selected.length);
      else if (state.failed.length) {
        setStatus('加载完成，失败 ' + state.failed.length + ' 张，可点击“重试失败”');
      } else setStatus('加载完成：' + state.selected.length + ' 张');
    } catch (error) {
      if (error.name !== 'AbortError') {
        setStatus('运行失败：' + (error.message || error));
        console.error('[Panda]', error);
      }
    } finally {
      setControls(false);
      document.getElementById('panda-retry').disabled = !state.failed.length;
    }
  }

  function stop() {
    state.stopped = true;
    if (state.controller) state.controller.abort();
    setStatus('正在停止…');
  }

  async function retryFailed() {
    if (state.running || !state.failed.length) return;
    var retry = state.failed.slice();
    state.failed = [];
    state.selected = retry;
    state.loaded = 0;
    state.stopped = false;
    state.controller = new AbortController();
    setControls(true);
    retry.forEach(function (entry) {
      var card = document.getElementById('panda-page-' + entry.number);
      var error = card && card.querySelector('.panda-error');
      if (error) {
        error.remove();
        card.querySelector('a').appendChild(make('img', {
          alt: '第 ' + entry.number + ' 页（重试中）', loading: 'lazy', decoding: 'async'
        }));
      }
    });
    await pool(retry, CONCURRENCY, function (entry) {
      return loadOne(entry, document.getElementById('panda-original').checked);
    });
    setControls(false);
    document.getElementById('panda-retry').disabled = !state.failed.length;
    setStatus(state.failed.length ? '重试后仍失败 ' + state.failed.length + ' 张' : '重试完成，全部成功');
  }

  buildUi();
  state.total = totalFrom(document);
  ['panda-from', 'panda-to'].forEach(function (id) {
    document.getElementById(id).max = state.total || 1;
  });
  document.getElementById('panda-to').value = state.total || 1;
  hideOriginalGrid();
  setStatus(state.total ? '检测到 ' + state.total + ' 张图片，即将自动加载…' : '准备加载…');
  setTimeout(start, 300);
}());
