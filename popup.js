// SEO Inspector — Popup Script

document.addEventListener('DOMContentLoaded', () => {
  // ──── DOM refs ────
  const statusEl = document.getElementById('status');
  const refreshBtn = document.getElementById('refresh');
  const actionBtn = document.getElementById('tab-action');

  const popoutBtn = document.getElementById('popout');
  const contentFieldsEl = document.getElementById('content-fields');
  const indexabilityFieldsEl = document.getElementById('indexability-fields');
  const schemaListEl = document.getElementById('schema-list');
  const linksListEl = document.getElementById('links-list');
  const linksStartEl = document.getElementById('links-start');
  const linksToolbarEl = document.getElementById('links-toolbar');
  const linksSummaryEl = document.getElementById('links-summary');
  const visitsSummaryEl = document.getElementById('visits-summary');
  const visitsListEl = document.getElementById('visits-list');

  // Tab state
  let currentTab = 'content';
  let pageData = null; // { url, title, description, h1s, canonicalRaw, canonicalRendered, robots, hreflangs, schemas, links }
  let dataLoaded = false;

  // Link-check state
  let linkResults = null;
  let linkRunning = false;
  let linkProgress = { done: 0, total: 0 };
  let linkSnapshotStats = null;
  let linkScanMode = 'standard';
  let linkFilter = 'all';
  let navigationRecord = null;
  let visitsLoading = false;

  // ──── Tab Switching ────
  document.querySelectorAll('.tabs-sidebar .tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tabs-sidebar .tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      currentTab = tab.dataset.tab;
      document.getElementById(`tab-${currentTab}`).classList.add('active');
      updateActionButton();
      if (currentTab === 'links') renderLinksTab();
      if (currentTab === 'visits') loadNavigationHistory();
    });
  });

  // ──── Link filter buttons ────
  document.querySelectorAll('.links-filters .filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.links-filters .filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      linkFilter = btn.dataset.filter;
      if (linkResults) renderLinkResults();
    });
  });

  // ──── Pop-out Button ────
  popoutBtn.addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return;
      const popupUrl = chrome.runtime.getURL('popup.html') + '?tabId=' + tab.id;
      await chrome.windows.create({
        url: popupUrl,
        type: 'popup',
        width: 860,
        height: 640,
        left: 100,
        top: 100
      });
      window.close();
    } catch (e) {
      console.error('Popout failed:', e);
    }
  });

  // ──── Initial Load ────
  loadAllData();

  refreshBtn.addEventListener('click', () => {
    if (currentTab === 'visits') loadNavigationHistory();
    else loadAllData();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'session' || !changes.navigationRecords) return;
    if (currentTab === 'visits' && !visitsLoading) loadNavigationHistory();
  });
  actionBtn.addEventListener('click', handleActionClick);

  // ──── Main Load ────
  async function loadAllData() {
    showStatus('正在提取页面数据...', 'loading');
    dataLoaded = false;
    contentFieldsEl.innerHTML = '';
    indexabilityFieldsEl.innerHTML = '';
    schemaListEl.innerHTML = '';
    linksStartEl.innerHTML = '';
    linksStartEl.style.display = 'none';
    linksListEl.innerHTML = '';
    linksToolbarEl.style.display = 'none';
    linkResults = null;
    linkRunning = false;
    linkProgress = { done: 0, total: 0 };
    linkSnapshotStats = null;
    linkScanMode = 'standard';

    try {
      const tab = await getTargetTab();
      if (!tab) {
        showStatus('无法获取当前标签页', 'error');
        return;
      }

      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        function: extractAllSeoData
      });

      pageData = results[0].result;
      dataLoaded = true;

      renderContentTab(pageData);
      renderIndexabilityTab(pageData);
      renderSchemaTab(pageData.schemas);

      showStatus('数据已加载', 'success');
      updateActionButton();

      if (currentTab === 'links') renderLinksTab();

    } catch (error) {
      console.error('Error:', error);
      showStatus(`提取失败: ${error.message}`, 'error');
    }
  }

  async function loadNavigationHistory() {
    if (visitsLoading) return;
    visitsLoading = true;
    visitsListEl.innerHTML = '<div class="visit-empty">正在读取浏览器访问记录…</div>';

    try {
      const tab = await getTargetTab();
      if (!tab) throw new Error('无法识别当前标签页');
      const response = await chrome.runtime.sendMessage({ type: 'get-navigation-history', tabId: tab.id });
      if (response && response.error) throw new Error(response.error);
      navigationRecord = (response && response.record) || null;
      renderNavigationHistory();
    } catch (error) {
      visitsSummaryEl.textContent = '';
      visitsListEl.innerHTML = `<div class="visit-empty">读取访问记录失败：${escHtml(error.message || '')}</div>`;
    } finally {
      visitsLoading = false;
    }
  }

  function renderNavigationHistory() {
    const record = navigationRecord;
    visitsSummaryEl.innerHTML = '<span>当前标签页最近一次主页面访问</span><span>再次访问同一标签页时会覆盖结果</span>';

    if (!record) {
      visitsListEl.innerHTML = `
        <div class="visit-empty">
          <div class="icon">🧭</div>
          <p>当前标签页还没有可显示的访问结果</p>
          <p class="hint">Reload 扩展后访问或刷新页面，结果会显示在这里。</p>
        </div>
      `;
      return;
    }

    const statusText = record.finalStatus != null
      ? String(record.finalStatus)
      : (record.state === 'error' ? 'ERR' : (record.state === 'loading' ? '进行中' : '—'));
    const statusClass = record.state === 'error'
      ? 'visit-status-error'
      : (record.finalStatus >= 200 && record.finalStatus < 400 ? 'visit-status-ok' : (record.finalStatus != null ? 'visit-status-error' : 'visit-status-unknown'));
    const dateText = new Date(record.startedAt).toLocaleString();
    const redirectSteps = (record.redirects || []).map(hop => `
        <div class="visit-hop">
          <span class="visit-hop-code">${escHtml(String(hop.statusCode))}</span>
          <span class="visit-hop-url">${escHtml(hop.redirectUrl || '')}</span>
        </div>
      `).join('');
    const finalStep = record.redirects && record.redirects.length
      ? `<div class="visit-hop visit-final-hop"><span class="visit-hop-code ${statusClass}">${escHtml(statusText)}</span><span class="visit-hop-url">${escHtml(record.finalUrl || '')}</span></div>`
      : '';
    const errorText = record.error ? `<div class="visit-error">${escHtml(record.error)}</div>` : '';
    const qualifier = (record.transitionQualifiers || []).includes('client_redirect')
      ? '<span class="visit-qualifier">页面脚本跳转</span>'
      : '';

    visitsListEl.innerHTML = `
        <article class="visit-item">
          <div class="visit-item-head">
            <span class="visit-status ${statusClass}">${escHtml(statusText)}</span>
            <span class="visit-time">${escHtml(dateText)} ${qualifier}</span>
          </div>
          <div class="visit-original-url">${escHtml(record.url || '')}</div>
          ${redirectSteps ? `<div class="visit-redirects">${redirectSteps}${finalStep}</div>` : ''}
          ${errorText}
        </article>
      `;
  }

  // ──── Page-level extraction function ────
  function extractAllSeoData() {
    // --- Content ---
    const url = location.href;
    const title = document.title || '';

    let description = '';
    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) description = metaDesc.getAttribute('content') || '';

    const headings = { h1: [], h2: [], h3: [], h4: [], h5: [], h6: [] };
    document.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(el => {
      const text = el.textContent.trim();
      if (text) headings[el.tagName.toLowerCase()].push(text);
    });

    // --- Indexability: Raw HTML (from original server response) ---
    // We fetch the page source and parse the original <link> / <meta> tags
    // This avoids JS-mutated values
    let canonicalRaw = '';
    let robotsRaw = '';
    const hreflangsRaw = [];

    // Synchronous-ish: use a synchronous XMLHttpRequest (same-origin only)
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', location.href, false); // synchronous
      xhr.overrideMimeType('text/html');
      xhr.send();
      if (xhr.status === 200) {
        const raw = xhr.responseText;
        // Parse canonical from raw HTML
        const canonMatch = raw.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*\/?>/i);
        if (canonMatch) canonicalRaw = canonMatch[1];
        // Fallback: href before rel
        if (!canonMatch) {
          const canonMatch2 = raw.match(/<link[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["'][^>]*\/?>/i);
          if (canonMatch2) canonicalRaw = canonMatch2[1];
        }
        // Parse robots from raw HTML
        const robotsMatch = raw.match(/<meta[^>]*name=["']robots["'][^>]*content=["']([^"']*)["'][^>]*\/?>/i);
        if (robotsMatch) robotsRaw = robotsMatch[1];
        // Parse hreflangs from raw HTML
        const hreflangRegex = /<link[^>]*rel=["']alternate["'][^>]*hreflang=["']([^"']+)["'][^>]*href=["']([^"']+)["'][^>]*\/?>/gi;
        let m;
        while ((m = hreflangRegex.exec(raw)) !== null) {
          hreflangsRaw.push({ hreflang: m[1], href: m[2] });
        }
      }
    } catch (e) {
      // Fallback: use current DOM if fetch fails
      console.warn('Raw HTML fetch failed, fallback to current DOM', e);
    }

    // Fallback: if fetch failed (e.g. CORS), fall back to current DOM
    if (!canonicalRaw) {
      const link = document.querySelector('link[rel="canonical"]');
      if (link) canonicalRaw = link.getAttribute('href') || '';
    }
    if (!robotsRaw) {
      const meta = document.querySelector('meta[name="robots"]');
      if (meta) robotsRaw = meta.getAttribute('content') || '';
    }

    // --- Indexability: Rendered HTML (after JS mutations) ---
    const canonicalRendered = (() => {
      const link = document.querySelector('link[rel="canonical"]');
      return link ? (link.getAttribute('href') || '') : '';
    })();

    // --- Hreflangs: from current DOM (rendered) ---
    const hreflangsRendered = [];
    document.querySelectorAll('link[rel="alternate"][hreflang]').forEach(link => {
      const hreflang = link.getAttribute('hreflang');
      const href = link.getAttribute('href');
      if (hreflang && href) {
        hreflangsRendered.push({ hreflang, href });
      }
    });

    // Merge: deduplicate by (hreflang, href), prefer raw first then add rendered
    const seen = new Set();
    const hreflangs = [];
    [...hreflangsRaw, ...hreflangsRendered].forEach(h => {
      const key = `${h.hreflang}|${h.href}`;
      if (seen.has(key)) return;
      seen.add(key);
      hreflangs.push(h);
    });

    // --- Schema Data ---
    const schemas = [];

    // 1. JSON-LD
    document.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
      try {
        const data = JSON.parse(script.textContent);
        const items = Array.isArray(data) ? data : [data];
        const extractTypes = (obj, depth = 0) => {
          if (depth > 5) return; // safety
          if (obj['@graph']) {
            if (Array.isArray(obj['@graph'])) {
              obj['@graph'].forEach(child => extractTypes(child, depth + 1));
            } else {
              extractTypes(obj['@graph'], depth + 1);
            }
          } else if (obj['@type']) {
            schemas.push({
              type: obj['@type'],
              format: 'JSON-LD',
              data: obj
            });
          }
        };
        items.forEach(item => extractTypes(item));
      } catch (e) { /* skip */ }
    });

    // 2. Microdata
    document.querySelectorAll('[itemscope]').forEach(item => {
      const type = item.getAttribute('itemtype')?.split('/').pop() || 'Unknown';
      const props = {};
      item.querySelectorAll('[itemprop]').forEach(prop => {
        const propName = prop.getAttribute('itemprop');
        const value = prop.getAttribute('content') ||
                      prop.getAttribute('href') ||
                      prop.textContent?.trim();
        if (propName && value) props[propName] = value;
      });
      if (Object.keys(props).length > 0) {
        schemas.push({ type, format: 'Microdata', data: { '@type': type, ...props } });
      }
    });

    // 3. RDFa
    document.querySelectorAll('[typeof]').forEach(item => {
      const type = item.getAttribute('typeof')?.split('/').pop() || 'Unknown';
      const props = {};
      item.querySelectorAll('[property]').forEach(prop => {
        const propName = prop.getAttribute('property');
        const value = prop.getAttribute('content') || prop.textContent?.trim();
        if (propName && value) props[propName] = value;
      });
      if (Object.keys(props).length > 0) {
        schemas.push({ type, format: 'RDFa', data: { '@type': type, ...props } });
      }
    });

    // --- Page Links (for HTTP status check) ---
    const links = [];
    const seenHref = new Set();
    document.querySelectorAll('a[href]').forEach(a => {
      const raw = a.getAttribute('href');
      if (!raw) return;
      // skip non-navigational schemes and pure anchors
      if (/^(mailto:|tel:|javascript:|data:|sms:|#)/i.test(raw.trim())) return;
      let abs;
      try { abs = new URL(raw, location.href).href; } catch (e) { return; }
      if (!/^https?:/i.test(abs)) return;
      if (seenHref.has(abs)) return;
      seenHref.add(abs);
      links.push({ url: abs, text: (a.textContent || '').trim().slice(0, 120) });
    });

    // --- Return all ---
    return {
      url,
      title,
      description,
      headings,
      canonicalRaw,
      canonicalRendered,
      robots: robotsRaw,
      hreflangs,
      schemas,
      links
    };
  }

  // ──── Render Content Tab ────
  function renderContentTab(data) {
    contentFieldsEl.innerHTML = '';

    const fields = [
      { label: 'Title', value: data.title, icon: '📌' },
      { label: 'Description', value: data.description, icon: '📝' },
    ];

    fields.forEach(f => {
      const group = document.createElement('div');
      group.className = 'field-group';
      group.innerHTML = `
        <div class="field-group-title"><span class="icon">${f.icon}</span>${f.label}</div>
        <div class="field-row">
          <div class="field-value ${f.value ? '' : 'empty'}">${escHtml(f.value) || '（空）'}</div>
        </div>
      `;
      contentFieldsEl.appendChild(group);
    });

    // Append all heading levels (H1-H6)
    const headingGroup = document.createElement('div');
    headingGroup.className = 'field-group';
    headingGroup.innerHTML = '<div class="field-group-title">🔤 Headings</div>';
    ['h1','h2','h3','h4','h5','h6'].forEach(level => {
      const list = data.headings[level];
      const items = list.length > 0
        ? list.map(t => `<span class="heading-item heading-${level}">${escHtml(t)}</span>`).join('')
        : '<span class="no-data">—</span>';
      const row = document.createElement('div');
      row.className = 'field-row';
      row.innerHTML = `<span class="field-label heading-label">${level.toUpperCase()}</span><span class="field-value heading-value">${items}</span>`;
      headingGroup.appendChild(row);
    });
    contentFieldsEl.appendChild(headingGroup);
  }

  // ──── Render Indexability Tab ────
  function renderIndexabilityTab(data) {
    indexabilityFieldsEl.innerHTML = '';

    // --- Canonical URL ---
    const canonicalGroup = document.createElement('div');
    canonicalGroup.className = 'field-group';
    canonicalGroup.innerHTML = `
      <div class="field-group-title"><span class="icon">🔗</span>Canonical URL</div>
      <div class="field-row">
        <div class="field-label"><span class="tag tag-raw">Raw HTML</span></div>
        <div class="field-value ${data.canonicalRaw ? '' : 'empty'}">${escHtml(data.canonicalRaw) || '（未设置）'}</div>
      </div>
      <div class="field-row">
        <div class="field-label"><span class="tag tag-rendered">Rendered</span></div>
        <div class="field-value ${data.canonicalRendered ? '' : 'empty'}">${escHtml(data.canonicalRendered) || '（未设置）'}</div>
      </div>
    `;
    indexabilityFieldsEl.appendChild(canonicalGroup);

    // --- Robots Meta ---
    const robotsGroup = document.createElement('div');
    robotsGroup.className = 'field-group';
    robotsGroup.innerHTML = `
      <div class="field-group-title"><span class="icon">🤖</span>Robots Meta Tag</div>
      <div class="field-row">
        <div class="field-value ${data.robots ? '' : 'empty'}">${escHtml(data.robots) || '（未设置）'}</div>
      </div>
    `;
    indexabilityFieldsEl.appendChild(robotsGroup);

    // --- Hreflangs ---
    const hflangGroup = document.createElement('div');
    hflangGroup.className = 'field-group';
    let hflangHtml = `<div class="field-group-title"><span class="icon">🌐</span>Hreflangs (${data.hreflangs.length})</div>`;

    if (data.hreflangs.length > 0) {
      hflangHtml += '<div class="hreflang-list">';
      data.hreflangs.forEach(h => {
        const label = h.hreflang === 'x-default' ? 'x-default' : h.hreflang;
        hflangHtml += `<div class="hreflang-row">
          <span class="hreflang-code">${escHtml(label)}</span>
          <span class="hreflang-url">${escHtml(h.href)}</span>
        </div>`;
      });
      hflangHtml += '</div>';
    } else {
      hflangHtml += '<div class="hreflang-empty">（未设置 Hreflang）</div>';
    }

    hflangGroup.innerHTML = hflangHtml;
    indexabilityFieldsEl.appendChild(hflangGroup);
  }

  // ──── Render Schema Tab (from existing code) ────
  function renderSchemaTab(schemas) {
    schemaListEl.innerHTML = '';

    if (!schemas || schemas.length === 0) {
      schemaListEl.innerHTML = `
        <div class="empty-state">
          <div class="icon">📭</div>
          <p>未发现结构化数据</p>
          <p class="hint">当前页面可能没有 Schema.org 标记</p>
        </div>
      `;
      return;
    }

    schemas.forEach((schema, index) => {
      const item = document.createElement('div');
      item.className = 'schema-item';
      item.dataset.index = index;

      const typeIcon = getTypeIcon(schema.type);

      item.innerHTML = `
        <div class="schema-header">
          <div class="schema-type">
            <span class="icon">${typeIcon}</span>
            <span class="type-name">${escHtml(schema.type)}</span>
            <span style="font-size: 11px; opacity: 0.7; margin-left: 4px;">${schema.format}</span>
          </div>
          <span class="toggle-icon">▼</span>
        </div>
        <div class="schema-content">
          <div class="json-viewer">${formatJson(schema.data)}</div>
        </div>
        <div class="schema-actions">
          <button class="btn-small btn-small-copy" data-action="copy">📋 复制</button>
        </div>
      `;

      const header = item.querySelector('.schema-header');
      header.addEventListener('click', () => {
        item.classList.toggle('collapsed');
      });

      const copyBtn = item.querySelector('[data-action="copy"]');
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        copyToClipboard(JSON.stringify(schema.data, null, 2));
        copyBtn.textContent = '✅ 已复制';
        setTimeout(() => { copyBtn.textContent = '📋 复制'; }, 1500);
      });

      schemaListEl.appendChild(item);
    });
  }

  // ──── Render Links Tab ────
  function renderLinksTab() {
    if (!dataLoaded || !pageData) return;

    const links = pageData.links || [];

    if (links.length === 0) {
      linksStartEl.style.display = 'none';
      linksToolbarEl.style.display = 'none';
      linksListEl.innerHTML = `
        <div class="empty-state">
          <div class="icon">🔗</div>
          <p>未发现可检测的跳转链接</p>
          <p class="hint">当前页面没有 http(s) 形式的 &lt;a&gt; 链接</p>
        </div>
      `;
      return;
    }

    // Already have results → just re-render
    if (linkResults) {
      linksStartEl.style.display = 'none';
      renderLinkResults();
      return;
    }
    if (linkRunning) {
      linksStartEl.style.display = 'none';
      renderLinkProgress();
      return;
    }

    // Wait for an explicit user action before starting network requests.
    linksToolbarEl.style.display = 'none';
    linksStartEl.style.display = 'block';
    const isJjsHouse = /^https?:\/\/(?:www\.)?jjshouse\.com\//i.test(pageData.url || '');
    linksStartEl.innerHTML = `
      <div class="links-start-card">
        <div class="links-start-icon">🔗</div>
        <div class="links-start-title">准备检测页面链接</div>
        <div class="links-start-hint">当前快照有 ${links.length} 条可检测链接；点击后将重新读取页面最新链接，再检查状态码和跳转链。</div>
        <div class="links-start-actions">
          <button id="start-links" class="btn-start-links">▶ 常规检测</button>
          <button id="start-links-deep" class="btn-start-links btn-start-links-deep">🔎 深度扫描</button>
          ${isJjsHouse ? '<button id="start-links-jjs-nav" class="btn-start-links btn-start-links-jjs-nav">🧭 导航扫描</button>' : ''}
        </div>
        <div class="links-start-note">深度扫描不会自动滚动页面，会额外读取开放 Shadow DOM 和可访问 iframe。JJ's House 导航扫描会依次悬停顶级导航，但不会点击或跳转页面。</div>
      </div>
    `;
    linksStartEl.querySelector('#start-links').addEventListener('click', () => {
      linksStartEl.style.display = 'none';
      refreshLinksAndStartCheck('standard');
    });
    linksStartEl.querySelector('#start-links-deep').addEventListener('click', () => {
      linksStartEl.style.display = 'none';
      refreshLinksAndStartCheck('deep');
    });
    const jjsNavButton = linksStartEl.querySelector('#start-links-jjs-nav');
    if (jjsNavButton) {
      jjsNavButton.addEventListener('click', () => {
        linksStartEl.style.display = 'none';
        refreshLinksAndStartCheck('jjs-navigation');
      });
    }
  }

  // Resolve the inspected page for both the normal popup and the pop-out window.
  async function getTargetTab() {
    const params = new URLSearchParams(location.search);
    const targetTabId = parseInt(params.get('tabId'), 10);
    if (targetTabId) return chrome.tabs.get(targetTabId);

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  // SPA pages can append links after the popup first opens. Re-read the DOM
  // immediately before issuing HTTP checks instead of using the old snapshot.
  async function refreshLinksAndStartCheck(mode) {
    const isDeepScan = mode === 'deep';
    const isJjsNavigationScan = mode === 'jjs-navigation';
    linkScanMode = isJjsNavigationScan ? 'jjs-navigation' : (isDeepScan ? 'deep' : 'standard');
    linksToolbarEl.style.display = 'none';
    linksListEl.innerHTML = `
      <div class="links-progress">
        <div class="links-progress-label">${isJjsNavigationScan ? '正在逐个展开 JJ\'s House 导航并收集链接…' : (isDeepScan ? '正在进行深度扫描，等待动态链接稳定…' : '正在获取当前页面最新链接…')}</div>
        <div class="links-progress-bar"><div class="links-progress-fill" style="width:35%"></div></div>
      </div>
    `;

    try {
      const tab = await getTargetTab();
      if (!tab) throw new Error('无法获取当前标签页');

      const results = await chrome.scripting.executeScript({
        target: isDeepScan ? { tabId: tab.id, allFrames: true } : { tabId: tab.id },
        function: isJjsNavigationScan ? extractJjsNavigationLinks : (isDeepScan ? extractDeepPageLinks : extractPageLinks)
      });
      const snapshot = isDeepScan
        ? mergeLinkSnapshots(results.map(entry => entry.result).filter(Boolean))
        : (results[0].result || { links: [], stats: null });
      const links = snapshot.links || [];
      pageData.links = links;
      linkSnapshotStats = snapshot.stats;

      if (links.length === 0) {
        renderLinksTab();
        return;
      }

      startLinkCheck(links);
    } catch (error) {
      console.error('Link extraction error:', error);
      linksListEl.innerHTML = `
        <div class="empty-state">
          <div class="icon">⚠️</div>
          <p>获取链接失败</p>
          <p class="hint">${escHtml(error.message || '')}</p>
        </div>
      `;
    }
  }

  function mergeLinkSnapshots(snapshots) {
    const linksByUrl = new Map();
    const stats = {
      anchorCount: 0,
      httpAnchorCount: 0,
      uniqueUrlCount: 0,
      frameCount: snapshots.length,
      shadowRootCount: 0
    };

    snapshots.forEach(snapshot => {
      const frameStats = snapshot.stats || {};
      stats.anchorCount += frameStats.anchorCount || 0;
      stats.httpAnchorCount += frameStats.httpAnchorCount || 0;
      stats.shadowRootCount += frameStats.shadowRootCount || 0;
      (snapshot.links || []).forEach(link => {
        if (!linksByUrl.has(link.url)) linksByUrl.set(link.url, link);
      });
    });

    const links = [...linksByUrl.values()];
    stats.uniqueUrlCount = links.length;
    return { links, stats };
  }

  // Runs in the inspected page. Wait until the link set stays unchanged for
  // a short period, because SPA pages can append navigation/product links
  // after the popup opens.
  async function extractPageLinks() {
    function collect() {
      const links = [];
      const seenHref = new Set();
      let httpAnchorCount = 0;
      const anchorCount = document.querySelectorAll('a[href]').length;

      document.querySelectorAll('a[href]').forEach(a => {
        const raw = a.getAttribute('href');
        if (!raw) return;
        if (/^(mailto:|tel:|javascript:|data:|sms:|#)/i.test(raw.trim())) return;

        let abs;
        try { abs = new URL(raw, location.href).href; } catch (e) { return; }
        if (!/^https?:/i.test(abs)) return;

        httpAnchorCount++;
        if (seenHref.has(abs)) return;
        seenHref.add(abs);
        links.push({ url: abs, text: (a.textContent || '').trim().slice(0, 120) });
      });

      return {
        links,
        stats: { anchorCount, httpAnchorCount, uniqueUrlCount: links.length }
      };
    }

    const startedAt = Date.now();
    const maxWaitMs = 7000;
    const stableForMs = 1200;
    const pollMs = 250;
    let snapshot = collect();
    let signature = snapshot.links.map(link => link.url).join('\n');
    let lastChangedAt = Date.now();

    while (Date.now() - startedAt < maxWaitMs && Date.now() - lastChangedAt < stableForMs) {
      await new Promise(resolve => setTimeout(resolve, pollMs));
      const next = collect();
      const nextSignature = next.links.map(link => link.url).join('\n');

      snapshot = next;
      if (nextSignature !== signature) {
        signature = nextSignature;
        lastChangedAt = Date.now();
      }
    }

    return snapshot;
  }

  // Runs in every accessible frame for deep scans. It also walks open shadow
  // roots, which document.querySelectorAll cannot enter by itself.
  async function extractDeepPageLinks() {
    function collect() {
      const links = [];
      const seenHref = new Set();
      const visitedRoots = new Set();
      let anchorCount = 0;
      let httpAnchorCount = 0;
      let shadowRootCount = 0;

      function recordAnchor(a) {
        anchorCount++;
        const raw = a.getAttribute('href');
        if (!raw || /^(mailto:|tel:|javascript:|data:|sms:|#)/i.test(raw.trim())) return;

        let abs;
        try { abs = new URL(raw, location.href).href; } catch (e) { return; }
        if (!/^https?:/i.test(abs)) return;

        httpAnchorCount++;
        if (seenHref.has(abs)) return;
        seenHref.add(abs);
        links.push({ url: abs, text: (a.textContent || '').trim().slice(0, 120) });
      }

      function scanRoot(root) {
        if (!root || visitedRoots.has(root)) return;
        visitedRoots.add(root);
        root.querySelectorAll('a[href]').forEach(recordAnchor);
        root.querySelectorAll('*').forEach(element => {
          if (element.shadowRoot) {
            shadowRootCount++;
            scanRoot(element.shadowRoot);
          }
        });
      }

      scanRoot(document);
      return {
        links,
        stats: { anchorCount, httpAnchorCount, uniqueUrlCount: links.length, shadowRootCount }
      };
    }

    const startedAt = Date.now();
    const maxWaitMs = 7000;
    const stableForMs = 1200;
    const pollMs = 250;
    let snapshot = collect();
    let signature = snapshot.links.map(link => link.url).join('\n');
    let lastChangedAt = Date.now();

    while (Date.now() - startedAt < maxWaitMs && Date.now() - lastChangedAt < stableForMs) {
      await new Promise(resolve => setTimeout(resolve, pollMs));
      const next = collect();
      const nextSignature = next.links.map(link => link.url).join('\n');

      snapshot = next;
      if (nextSignature !== signature) {
        signature = nextSignature;
        lastChangedAt = Date.now();
      }
    }

    return snapshot;
  }

  // JJ's House product pages may create mega-menu links only when a top-level
  // navigation item receives a hover. This collector never clicks a link; it
  // hovers likely top-level triggers and accumulates the links exposed by each.
  async function extractJjsNavigationLinks() {
    function collectLinks() {
      const links = [];
      const seenHref = new Set();
      let anchorCount = 0;
      let httpAnchorCount = 0;

      document.querySelectorAll('a[href]').forEach(a => {
        anchorCount++;
        const raw = a.getAttribute('href');
        if (!raw || /^(mailto:|tel:|javascript:|data:|sms:|#)/i.test(raw.trim())) return;

        let abs;
        try { abs = new URL(raw, location.href).href; } catch (e) { return; }
        if (!/^https?:/i.test(abs)) return;

        httpAnchorCount++;
        if (seenHref.has(abs)) return;
        seenHref.add(abs);
        links.push({ url: abs, text: (a.textContent || '').trim().slice(0, 120) });
      });

      return { links, stats: { anchorCount, httpAnchorCount, uniqueUrlCount: links.length } };
    }

    function isVisible(element) {
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden';
    }

    function findNavigationTriggers() {
      const selector = [
        'header [aria-haspopup="true"]',
        'header [role="menuitem"]',
        'header [class*="nav-menu__item"]',
        'header [class*="nav-menu-item"]',
        'header [class*="navigation"] > a',
        'header [class*="navigation"] > button',
        '[class*="header"] [class*="nav-menu__item"]',
        '[class*="header"] [class*="nav-menu-item"]'
      ].join(',');

      const seen = new Set();
      return [...document.querySelectorAll(selector)]
        .filter(element => {
          if (seen.has(element) || !isVisible(element)) return false;
          const className = typeof element.className === 'string' ? element.className : '';
          if (/nav-sub-menu/i.test(className)) return false;
          const text = (element.textContent || '').trim();
          if (!text || text.length > 80) return false;
          seen.add(element);
          return true;
        })
        .slice(0, 30);
    }

    function hover(element) {
      const options = { bubbles: true, cancelable: true, view: window };
      const PointerEventCtor = window.PointerEvent || MouseEvent;
      ['pointerover', 'pointerenter'].forEach(type => {
        element.dispatchEvent(new PointerEventCtor(type, options));
      });
      ['mouseover', 'mouseenter'].forEach(type => {
        element.dispatchEvent(new MouseEvent(type, options));
      });
    }

    const linksByUrl = new Map();
    const initial = collectLinks();
    initial.links.forEach(link => linksByUrl.set(link.url, link));
    let maxAnchorCount = initial.stats.anchorCount;
    let maxHttpAnchorCount = initial.stats.httpAnchorCount;

    const triggers = findNavigationTriggers();
    for (const trigger of triggers) {
      hover(trigger);
      await new Promise(resolve => setTimeout(resolve, 350));
      const snapshot = collectLinks();
      maxAnchorCount = Math.max(maxAnchorCount, snapshot.stats.anchorCount);
      maxHttpAnchorCount = Math.max(maxHttpAnchorCount, snapshot.stats.httpAnchorCount);
      snapshot.links.forEach(link => {
        if (!linksByUrl.has(link.url)) linksByUrl.set(link.url, link);
      });
    }

    await new Promise(resolve => setTimeout(resolve, 500));
    const finalSnapshot = collectLinks();
    maxAnchorCount = Math.max(maxAnchorCount, finalSnapshot.stats.anchorCount);
    maxHttpAnchorCount = Math.max(maxHttpAnchorCount, finalSnapshot.stats.httpAnchorCount);
    finalSnapshot.links.forEach(link => {
      if (!linksByUrl.has(link.url)) linksByUrl.set(link.url, link);
    });

    const links = [...linksByUrl.values()];
    return {
      links,
      stats: {
        anchorCount: maxAnchorCount,
        httpAnchorCount: maxHttpAnchorCount,
        uniqueUrlCount: links.length,
        navigationTriggerCount: triggers.length
      }
    };
  }

  function renderLinkProgress() {
    linksToolbarEl.style.display = 'none';
    const { done, total } = linkProgress;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const snapshotText = linkSnapshotStats
      ? `${linkScanMode === 'deep' ? `深度扫描已读取 ${linkSnapshotStats.frameCount} 个 frame、${linkSnapshotStats.shadowRootCount} 个开放 Shadow DOM；` : ''}${linkScanMode === 'jjs-navigation' ? `已依次悬停 ${linkSnapshotStats.navigationTriggerCount} 个顶级导航；` : ''}已读取 ${linkSnapshotStats.anchorCount} 个 &lt;a&gt;，${linkSnapshotStats.httpAnchorCount} 个 HTTP 链接，去重后检测 ${linkSnapshotStats.uniqueUrlCount} 个 URL。`
      : '';
    linksListEl.innerHTML = `
      <div class="links-progress">
        <div class="links-progress-label">${snapshotText}正在检测链接状态码… ${done} / ${total}</div>
        <div class="links-progress-bar"><div class="links-progress-fill" style="width:${pct}%"></div></div>
      </div>
    `;
  }

  function startLinkCheck(links) {
    const urls = links.map(l => l.url);
    linkRunning = true;
    linkProgress = { done: 0, total: urls.length };

    // Preserve display text for each url
    const textByUrl = new Map(links.map(l => [l.url, l.text]));

    let port;
    try {
      port = chrome.runtime.connect({ name: 'link-check' });
    } catch (e) {
      linkRunning = false;
      linksListEl.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><p>无法连接后台服务</p><p class="hint">${escHtml(e.message)}</p></div>`;
      return;
    }

    renderLinkProgress();

    let readyTimer = setTimeout(() => {
      if (!linkRunning) return;
      linkRunning = false;
      linksListEl.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><p>后台服务无响应</p><p class="hint">请到 chrome://extensions 重新加载扩展后再试</p></div>`;
      try { port.disconnect(); } catch (e) {}
    }, 5000);

    port.onMessage.addListener((msg) => {
      if (msg.type === 'ready') {
        clearTimeout(readyTimer);
        port.postMessage({ type: 'start', urls });
      } else if (msg.type === 'progress') {
        linkProgress = { done: msg.done, total: msg.total };
        renderLinkProgress();
      } else if (msg.type === 'done') {
        clearTimeout(readyTimer);
        linkRunning = false;
        linkResults = (msg.results || []).map(r => ({
          ...r,
          text: textByUrl.get(r.url) || ''
        }));
        renderLinkResults();
        try { port.disconnect(); } catch (e) {}
      } else if (msg.type === 'error') {
        clearTimeout(readyTimer);
        linkRunning = false;
        linksListEl.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><p>检测失败</p><p class="hint">${escHtml(msg.error || '')}</p></div>`;
        try { port.disconnect(); } catch (e) {}
      }
    });

    port.onDisconnect.addListener(() => {
      clearTimeout(readyTimer);
      // If the worker died before delivering results, surface it instead of
      // leaving the UI stuck at 0.
      if (linkRunning) {
        linkRunning = false;
        linksListEl.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><p>后台服务已断开</p><p class="hint">请重新加载扩展后重试</p></div>`;
      }
    });
  }

  // category: 'ok' | 'redirect' | 'error'
  function classifyResult(r) {
    if (r.error) return 'error';
    const s = r.finalStatus;
    if (s == null) return 'error';
    if (s >= 200 && s < 300) return (r.chain && r.chain.length > 0) ? 'redirect' : 'ok';
    if (s >= 300 && s < 400) return 'redirect';
    return 'error';
  }

  function renderLinkResults() {
    if (!linkResults) return;

    const all = linkResults;
    const okCount = all.filter(r => classifyResult(r) === 'ok').length;
    const redirCount = all.filter(r => classifyResult(r) === 'redirect').length;
    const errCount = all.filter(r => classifyResult(r) === 'error').length;

    // Toolbar
    linksToolbarEl.style.display = 'flex';
    linksSummaryEl.innerHTML =
      `<span class="sum-total">共 ${all.length} 条</span>` +
      `<span class="sum-ok">✅ ${okCount}</span>` +
      `<span class="sum-redirect">↪️ ${redirCount}</span>` +
      `<span class="sum-error">❌ ${errCount}</span>`;

    // Filtered list
    let list = all;
    if (linkFilter === 'error') list = all.filter(r => classifyResult(r) === 'error');
    else if (linkFilter === 'redirect') list = all.filter(r => classifyResult(r) === 'redirect');

    if (list.length === 0) {
      linksListEl.innerHTML = `<div class="empty-state"><div class="icon">🔍</div><p>没有符合筛选条件的链接</p></div>`;
      return;
    }

    let html = '<div class="link-items">';
    list.forEach(r => {
      const cat = classifyResult(r);
      const badge = r.error ? 'ERR' : (r.finalStatus == null ? '???' : r.finalStatus);
      const chainStr = (r.chain && r.chain.length > 0)
        ? r.chain.map(h => `${h.status} → `).join('') + (r.finalStatus != null ? r.finalStatus : '')
        : '';
      const chainHtml = chainStr
        ? `<div class="link-chain" title="跳转链">${escHtml(chainStr)}</div>`
        : (r.error ? `<div class="link-chain link-chain-err">${escHtml(r.error)}</div>` : '');

      html += `
        <div class="link-item status-${cat}">
          <span class="link-badge badge-${cat}">${escHtml(String(badge))}</span>
          <div class="link-body">
            <div class="link-url" title="${escHtml(r.url)}">${escHtml(shortenUrl(r.url))}</div>
            ${r.text ? `<div class="link-text">${escHtml(r.text)}</div>` : ''}
            ${chainHtml}
          </div>
        </div>`;
    });
    html += '</div>';
    linksListEl.innerHTML = html;
  }

  function shortenUrl(u) {
    try {
      const url = new URL(u);
      let s = url.protocol + '//' + url.host + url.pathname + url.search;
      if (s.length > 90) s = s.slice(0, 88) + '…';
      return s;
    } catch (e) {
      return u.length > 90 ? u.slice(0, 88) + '…' : u;
    }
  }

  // ──── Format JSON with syntax highlighting ────
  function formatJson(obj, indent = 0) {
    const spaces = '  '.repeat(indent);
    const nextSpaces = '  '.repeat(indent + 1);

    if (obj === null) return '<span class="null">null</span>';
    if (typeof obj === 'boolean') return `<span class="boolean">${obj}</span>`;
    if (typeof obj === 'number') return `<span class="number">${obj}</span>`;
    if (typeof obj === 'string') {
      const s = escHtml(obj);
      return `<span class="string">"${s}"</span>`;
    }
    if (Array.isArray(obj)) {
      if (obj.length === 0) return '[]';
      const items = obj.map(item => nextSpaces + formatJson(item, indent + 1)).join(',\n');
      return `[\n${items}\n${spaces}]`;
    }
    if (typeof obj === 'object') {
      const keys = Object.keys(obj);
      if (keys.length === 0) return '{}';
      const items = keys.map(key => {
        const k = escHtml(key);
        return `${nextSpaces}<span class="key">"${k}"</span>: ${formatJson(obj[key], indent + 1)}`;
      }).join(',\n');
      return `{\n${items}\n${spaces}}`;
    }
    return escHtml(String(obj));
  }

  // ──── Utility: HTML escape ────
  function escHtml(str) {
    if (typeof str !== 'string') return String(str || '');
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ──── Schema type icon ────
  function getTypeIcon(type) {
    const icons = {
      'Article': '📄', 'NewsArticle': '📰', 'BlogPosting': '📝',
      'Product': '🛍️', 'Offer': '💰', 'Person': '👤', 'Organization': '🏢',
      'LocalBusiness': '🏪', 'Restaurant': '🍽️', 'Event': '📅',
      'Movie': '🎬', 'Book': '📚', 'Recipe': '🍳', 'Review': '⭐',
      'FAQPage': '❓', 'HowTo': '📋', 'BreadcrumbList': '🧭',
      'WebPage': '🌐', 'WebSite': '🔗', 'VideoObject': '🎥',
      'ImageObject': '🖼️', 'AudioObject': '🎵'
    };
    return icons[type] || '📦';
  }

  // ──── Action button (copies current tab data) ────
  function updateActionButton() {
    if (currentTab === 'visits') {
      actionBtn.classList.add('hidden');
      return;
    }

    if (!dataLoaded || !pageData) {
      actionBtn.classList.add('hidden');
      return;
    }

    actionBtn.classList.remove('hidden');

    if (currentTab === 'content') {
      actionBtn.textContent = '📋 复制 Content';
    } else if (currentTab === 'indexability') {
      actionBtn.textContent = '📋 复制 Indexability';
    } else if (currentTab === 'links') {
      if (linkResults && linkResults.length) {
        actionBtn.textContent = `📋 复制 ${linkResults.length} 条链接`;
      } else {
        actionBtn.textContent = '📋 复制链接';
      }
    } else {
      const count = (pageData.schemas || []).length;
      if (count === 0) {
        actionBtn.textContent = '📋 复制全部';
      } else {
        actionBtn.textContent = `📋 复制 ${count} 个 Schema`;
      }
    }
  }

  function handleActionClick() {
    if (currentTab === 'visits') return;
    if (!dataLoaded || !pageData) return;

    let text = '';

    if (currentTab === 'content') {
      text = `Title: ${pageData.title}\nDescription: ${pageData.description}\n` +
        ['h1','h2','h3','h4','h5','h6'].map(l => {
          const list = pageData.headings[l];
          return `${l.toUpperCase()}: ${list.length > 0 ? list.join(' / ') : '—'}`;
        }).join('\n');
    } else if (currentTab === 'indexability') {
      text = `Canonical URL (Raw HTML): ${pageData.canonicalRaw || '(not set)'}\n`;
      text += `Canonical URL (Rendered): ${pageData.canonicalRendered || '(not set)'}\n`;
      text += `Robots Meta: ${pageData.robots || '(not set)'}\n\n`;
      if (pageData.hreflangs.length > 0) {
        text += 'Hreflangs:\n';
        pageData.hreflangs.forEach(h => {
          text += `  ${h.hreflang} → ${h.href}\n`;
        });
      } else {
        text += 'Hreflangs: (none)\n';
      }
    } else if (currentTab === 'links') {
      if (!linkResults || !linkResults.length) return;
      text = linkResults.map(r => {
        const cat = classifyResult(r);
        const code = r.error ? `ERR(${r.error})` : (r.finalStatus != null ? r.finalStatus : '???');
        const chain = (r.chain && r.chain.length)
          ? ' [' + r.chain.map(h => h.status).join('→') + ']'
          : '';
        return `${code}${chain}\t${r.url}`;
      }).join('\n');
    } else {
      const allData = pageData.schemas.map(s => s.data);
      text = JSON.stringify(allData, null, 2);
    }

    copyToClipboard(text);

    const original = actionBtn.textContent;
    actionBtn.textContent = '✅ 已复制';
    setTimeout(() => { actionBtn.textContent = original; }, 1500);
  }

  // ──── Status ────
  function showStatus(message, type) {
    statusEl.textContent = message;
    statusEl.className = `status ${type || ''}`;
  }

  // ──── Clipboard ────
  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
  }
});
