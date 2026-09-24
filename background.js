// SEO Inspector — Background Service Worker
// Batch-checks HTTP status codes for a list of URLs and captures the full
// redirect chain via chrome.webRequest (fetch alone cannot expose the
// intermediate 301/302 hops, and `redirect:'manual'` yields an opaque response).

// ──── Redirect / completion capture ────
// Keyed by normalized URL so concurrent checks don't collide.
const ENTRY_TTL = 60 * 1000; // drop stale entries after 60s
const redirectMap = new Map();   // url -> { status, to, ts }
let navigationRecords = [];
let navigationQueue = Promise.resolve();
const navigationReady = chrome.storage.session.get('navigationRecords').then(({ navigationRecords: saved }) => {
  navigationRecords = Array.isArray(saved) ? saved : [];
});

function updateNavigationHistory(updater) {
  navigationQueue = navigationQueue
    .then(() => navigationReady)
    .then(async () => {
      updater(navigationRecords);
      navigationRecords = navigationRecords
        .sort((a, b) => b.startedAt - a.startedAt)
        .filter((item, index, records) => records.findIndex((candidate) => candidate.tabId === item.tabId) === index);
      await chrome.storage.session.set({ navigationRecords });
    })
    .catch((error) => console.error('[SEO Inspector] navigation history update failed', error));
  return navigationQueue;
}

function norm(u) {
  try { return new URL(u).href; } catch (e) { return u; }
}

// details.url = the resource that answered; statusCode = the 3xx code;
// redirectUrl = the next hop. This is enough to rebuild the whole chain.
chrome.webRequest.onBeforeRedirect.addListener(
  (details) => {
    redirectMap.set(details.url, {
      status: details.statusCode,
      to: details.redirectUrl,
      ts: Date.now()
    });
  },
  { urls: ["<all_urls>"] }
);

// ──── Browser main-frame navigation history ────
// Record only real top-level document requests from browser tabs. Background
// link-check fetches have tabId -1 and are excluded from this history.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0 || details.frameId !== 0) return;
    if (!/^https?:/i.test(details.url)) return;

    const record = {
      id: details.requestId,
      tabId: details.tabId,
      url: details.url,
      currentUrl: details.url,
      finalUrl: details.url,
      startedAt: details.timeStamp || Date.now(),
      completedAt: null,
      finalStatus: null,
      redirects: [],
      state: 'loading',
      error: null,
      transitionType: null,
      transitionQualifiers: []
    };

    updateNavigationHistory((records) => {
      const existing = records.find((item) => item.id === record.id);
      if (existing) {
        // Chrome may emit another onBeforeRequest for the redirected URL using
        // the same requestId. Keep the first URL and all redirect hops.
        existing.currentUrl = details.url;
        existing.finalUrl = details.url;
        existing.state = 'loading';
        return;
      }
      records.unshift(record);
    });
  },
  { urls: ['<all_urls>'], types: ['main_frame'] }
);

chrome.webRequest.onBeforeRedirect.addListener(
  (details) => {
    if (details.tabId < 0 || details.frameId !== 0) return;

    updateNavigationHistory((records) => {
      const record = records.find((item) => item.id === details.requestId);
      if (!record) return;
      record.redirects.push({
        url: details.url,
        statusCode: details.statusCode,
        redirectUrl: details.redirectUrl
      });
      record.currentUrl = details.redirectUrl;
      record.finalUrl = details.redirectUrl;
    });
  },
  { urls: ['<all_urls>'], types: ['main_frame'] }
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.tabId < 0 || details.frameId !== 0) return;

    updateNavigationHistory((records) => {
      const record = records.find((item) => item.id === details.requestId);
      if (!record) return;
      record.currentUrl = details.url;
      record.finalUrl = details.url;
      record.finalStatus = details.statusCode;
      record.completedAt = details.timeStamp || Date.now();
      record.state = 'complete';
    });
  },
  { urls: ['<all_urls>'], types: ['main_frame'] }
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    if (details.tabId < 0 || details.frameId !== 0) return;

    updateNavigationHistory((records) => {
      const record = records.find((item) => item.id === details.requestId);
      if (!record) return;
      record.currentUrl = details.url;
      record.finalUrl = details.url;
      record.completedAt = details.timeStamp || Date.now();
      record.state = 'error';
      record.error = details.error || 'Navigation failed';
    });
  },
  { urls: ['<all_urls>'], types: ['main_frame'] }
);

// webNavigation includes commits served from cache where a network response
// status may not be available. Match commits to their request record when
// possible, otherwise retain the visit with an unknown HTTP status.
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.tabId < 0 || details.frameId !== 0) return;
  if (!/^https?:/i.test(details.url)) return;

  updateNavigationHistory((records) => {
    const committedAt = details.timeStamp || Date.now();
    const matchingRecord = records
      .filter((item) => item.tabId === details.tabId && (item.state === 'loading' || (item.completedAt && Math.abs(committedAt - item.completedAt) < 3000)))
      .sort((a, b) => Math.abs(committedAt - a.startedAt) - Math.abs(committedAt - b.startedAt))
      .find((item) => item.finalUrl === details.url || item.url === details.url || item.redirects.some((hop) => hop.redirectUrl === details.url));

    if (matchingRecord) {
      matchingRecord.transitionType = details.transitionType || null;
      matchingRecord.transitionQualifiers = details.transitionQualifiers || [];
      matchingRecord.committedAt = committedAt;
      return;
    }

    // For history/BFCache commits without an observable HTTP request, store
    // the visit but leave its HTTP status blank instead of guessing.
    records.unshift({
      id: `commit-${details.tabId}-${committedAt}-${Math.random().toString(36).slice(2, 8)}`,
      tabId: details.tabId,
      url: details.url,
      finalUrl: details.url,
      startedAt: committedAt,
      completedAt: committedAt,
      finalStatus: null,
      redirects: [],
      state: 'committed',
      error: null,
      transitionType: details.transitionType || null,
      transitionQualifiers: details.transitionQualifiers || []
    });
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  updateNavigationHistory((records) => {
    const index = records.findIndex((item) => item.tabId === tabId);
    if (index >= 0) records.splice(index, 1);
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'get-navigation-history') return undefined;
  navigationQueue
    .then(() => navigationReady)
    .then(() => sendResponse({ record: navigationRecords.find((item) => item.tabId === message.tabId) || null }))
    .catch((error) => sendResponse({ error: error.message || 'Unable to load navigation history' }));
  return true;
});

function pruneStale() {
  const now = Date.now();
  for (const [k, v] of redirectMap) {
    if (now - v.ts > ENTRY_TTL) redirectMap.delete(k);
  }
}
setInterval(pruneStale, 30000);

// ──── HTTP check ────
function fetchWithTimeout(url, ms, method) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, {
    method,
    redirect: 'follow',
    cache: 'no-store',
    credentials: 'omit',
    signal: controller.signal,
    headers: { 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' }
  }).finally(() => clearTimeout(timer));
}

// Rebuild redirect chain for a start URL from captured webRequest hops.
function buildChain(startUrl) {
  const chain = [];
  let cur = startUrl;
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    const r = redirectMap.get(cur);
    if (!r || seen.has(cur)) break;
    seen.add(cur);
    chain.push({ from: cur, status: r.status, to: r.to });
    cur = r.to;
  }
  return chain;
}

async function checkOne(url) {
  const start = norm(url);
  let finalStatus = null;
  let finalUrl = null;
  let method = 'HEAD';
  let error = null;

  const attempt = (m) => fetchWithTimeout(url, 8000, m);

  try {
    let res = await attempt('HEAD');
    // Some servers reject HEAD outright — retry with GET.
    if ([403, 405, 501, 400].includes(res.status)) {
      method = 'GET';
      res = await attempt('GET');
    }
    finalStatus = res.status;
    finalUrl = res.url || url;
  } catch (e) {
    if (e && e.name === 'AbortError') {
      error = 'Timeout';
    } else {
      // Network failure on HEAD — try once with GET before giving up.
      try {
        method = 'GET';
        const res = await attempt('GET');
        finalStatus = res.status;
        finalUrl = res.url || url;
      } catch (e2) {
        error = (e2 && e2.name === 'AbortError') ? 'Timeout'
              : (e2 && e2.message) ? e2.message
              : 'Network error';
      }
    }
  }

  const chain = buildChain(start);

  return {
    url,
    finalUrl: finalUrl || (chain.length ? chain[chain.length - 1].to : url),
    finalStatus,
    chain,
    method,
    error
  };
}

// ──── Concurrency pool ────
async function runPool(items, worker, concurrency, onDone) {
  const results = new Array(items.length);
  let cursor = 0;
  let completed = 0;

  async function next() {
    while (cursor < items.length) {
      const idx = cursor++;
      try {
        results[idx] = await worker(items[idx]);
      } catch (e) {
        results[idx] = {
          url: items[idx], finalUrl: items[idx], finalStatus: null,
          chain: [], method: 'HEAD', error: (e && e.message) || 'Unknown error'
        };
      }
      completed++;
      if (onDone) onDone(completed, items.length);
    }
  }

  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: n }, next));
  return results;
}

// ──── Long-lived port handler (progress + results) ────
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'link-check') return;
  console.log('[SEO Inspector] link-check port connected');

  let aborted = false;
  let started = false;

  port.onDisconnect.addListener(() => {
    aborted = true;
    console.log('[SEO Inspector] link-check port disconnected');
  });

  // Handshake: the popup waits for this `ready` before sending work, so a
  // cold-started service worker never drops the initial `start` message.
  try { port.postMessage({ type: 'ready' }); } catch (e) { /* popup gone */ }

  port.onMessage.addListener(async (msg) => {
    if (!msg || msg.type !== 'start' || started) return;
    started = true;

    const urls = Array.isArray(msg.urls) ? msg.urls : [];
    console.log('[SEO Inspector] link-check received', urls.length, 'urls');

    try {
      const results = await runPool(urls, checkOne, 6, (done, total) => {
        if (!aborted) {
          try { port.postMessage({ type: 'progress', done, total }); } catch (e) { aborted = true; }
        }
      });
      if (!aborted) {
        try { port.postMessage({ type: 'done', results }); } catch (e) { /* popup closed */ }
      }
    } catch (e) {
      console.error('[SEO Inspector] link-check error', e);
      if (!aborted) {
        try { port.postMessage({ type: 'error', error: (e && e.message) || 'Unknown error' }); } catch (e2) {}
      }
    }
  });
});
