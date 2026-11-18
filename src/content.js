/*
 * ログイン中アカウントのアバターと ID/ユーザー名にだけぼかしをかけるコンテンツスクリプト。
 *
 * 仕組み:
 *  1. 検出: ページ上部のヘッダー領域から「自分」のアバター画像とユーザー名/ID を見つけ、
 *     サイトごとに chrome.storage.local へ保存する（ヘッダーには自分の情報しか出ない前提）。
 *  2. 画像: 保存したアバター URL のキーで img[src*=...] 等の CSS ルールを生成してぼかす。
 *     CSS で効かせるため、後から追加・再描画された画像にも即座に適用される。
 *  3. テキスト: ページ内のテキストからユーザー名/ID を探し、
 *     - 要素のテキストがほぼその名前だけなら、その要素に filter: blur を適用
 *     - 文中に含まれる場合は CSS Custom Highlight API で該当箇所だけを伏せる
 *     DOM のテキストノードを書き換えないので、React/Vue などのページを壊さない。
 *  4. Shadow DOM: ココナラのヘッダーのように Web Components（Lit 等）の Shadow DOM 内に
 *     アバター/名前がある場合に備え、検出・テキスト走査・変更監視は shadow root の中まで辿り、
 *     ぼかし用 CSS は各 shadow root にも挿入する（document の CSS は Shadow DOM に届かないため）。
 */
(() => {
  'use strict';
  if (window.__labBlurLoaded) return;
  window.__labBlurLoaded = true;

  const siteKey = labGetSiteKey(location.hostname);
  if (!siteKey) return;
  const site = LAB_SITES[siteKey];
  const SITE_STORE = labSiteStoreKey(siteKey);
  const ATTR = 'data-lab-blur';
  const HL_NAME = 'lab-blur-text';
  const IS_TOP = window === window.top;
  const HAS_HL = typeof Highlight === 'function' && typeof CSS !== 'undefined' && !!CSS.highlights;
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'SELECT', 'OPTION', 'IFRAME']);
  const UI_CLASS = 'lab-ui';
  const MAX_LIST = 8;
  const DETECT_FAST_MS = 20000; // 読み込み直後はこまめに検出（SPA のヘッダー描画待ち）

  let settings = { ...LAB_DEFAULT_SETTINGS };
  let data = labEmptySiteData();
  let nameRe = null;
  let styleEl = null;
  let shadowCss = '';
  let shadowRoots = [];               // 現在ページ内にある shadow root
  const shadowStyles = new WeakMap(); // shadow root -> 挿入した <style>
  let observer = null;
  // src の変更も監視する（ココナラはヘッダー描画後にデフォルト画像から本人の画像へ差し替える）
  const OBSERVE_OPTS = { childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['src', 'srcset'] };
  let scanTimer = 0;
  let detectTimer = 0;
  let lastDetect = 0;
  let domReady = false;
  const startedAt = Date.now();

  const alive = () => {
    try { return !!chrome.runtime?.id; } catch { return false; }
  };

  // ------------------------------------------------------------------ storage

  async function load() {
    if (!alive()) return;
    const res = await chrome.storage.local.get([LAB_SETTINGS_KEY, SITE_STORE]);
    settings = { ...LAB_DEFAULT_SETTINGS, ...(res[LAB_SETTINGS_KEY] || {}) };
    data = { ...labEmptySiteData(), ...(res[SITE_STORE] || {}) };
    nameRe = labBuildNameRegex([...data.autoNames, ...data.manualNames]);
    applyStyle();
    if (domReady) scheduleScan(0);
  }

  function save() {
    if (!alive()) return;
    chrome.storage.local.set({ [SITE_STORE]: data }).catch(() => {});
  }

  /** 新しい項目を先頭に追加。既存にすべて含まれていれば変更なし(false)。 */
  function mergeInto(listName, items) {
    const fresh = items.filter((x) => x && !data[listName].includes(x));
    if (!fresh.length) return false;
    data[listName] = [...fresh, ...data[listName]].slice(0, MAX_LIST);
    return true;
  }

  // ------------------------------------------------------------------ style

  const cssStr = (s) => String(s).replace(/["\\]/g, '\\$&').replace(/[\r\n]/g, '');

  function applyStyle() {
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'lab-blur-style';
    }
    if (!styleEl.isConnected) (document.head || document.documentElement).appendChild(styleEl);

    const px = Math.max(1, Number(settings.blurPx) || LAB_DEFAULT_SETTINGS.blurPx);
    const f = `filter: blur(${px}px) !important;`;
    const rules = [];

    if (settings.enabled) {
      rules.push(`[${ATTR}] { ${f} }`);
      const keys = new Set();
      for (const url of [...data.autoAvatars, ...data.manualAvatars]) {
        for (const k of labAvatarKeys(url)) keys.add(k);
      }
      for (const k of keys) {
        const v = cssStr(k);
        rules.push(`img[src*="${v}"], img[srcset*="${v}"], image[href*="${v}"], [style*="${v}"] { ${f} }`);
        rules.push(`picture:has(source[srcset*="${v}"]) > img { ${f} }`);
      }
      rules.push(`::highlight(${HL_NAME}) { color: transparent; background-color: rgba(128,128,128,.4); ` +
        `text-shadow: 0 0 ${Math.max(4, px)}px rgba(0,0,0,.6); }`);
    }

    // Shadow DOM 内にも同じぼかしルールを適用する
    shadowCss = rules.join('\n');
    for (const sr of shadowRoots) ensureShadowStyle(sr);

    // 要素選択モード・トースト用 UI
    rules.push(`
      .${UI_CLASS} { all: initial; position: fixed; z-index: 2147483647; font: 13px/1.5 system-ui, sans-serif; }
      .lab-pick-box { pointer-events: none; border: 2px solid #e8590c; background: rgba(232,89,12,.15);
        border-radius: 3px; transition: all .05s; }
      .lab-pick-tip, .lab-toast { pointer-events: none; left: 50%; transform: translateX(-50%); top: 12px;
        background: #212529; color: #fff; padding: 8px 14px; border-radius: 6px; box-shadow: 0 4px 16px rgba(0,0,0,.3); }
    `);
    styleEl.textContent = rules.join('\n');
  }

  // ------------------------------------------------------------------ shadow DOM

  /** 開いた shadow root（コンテンツスクリプトでは閉じた shadow root も取得できる） */
  function shadowOf(el) {
    if (el.shadowRoot) return el.shadowRoot;
    if (el.localName && el.localName.includes('-') && chrome.dom?.openOrClosedShadowRoot) {
      try { return chrome.dom.openOrClosedShadowRoot(el) || null; } catch { return null; }
    }
    return null;
  }

  /** Shadow DOM の境界を越えた親要素 */
  function composedParent(n) {
    if (n.parentElement) return n.parentElement;
    const p = n.parentNode;
    return p instanceof ShadowRoot ? p.host : null;
  }

  /** a が b を（Shadow DOM 越しに）含むか */
  function deepContains(a, b) {
    for (let n = b; n; n = n.parentNode instanceof ShadowRoot ? n.parentNode.host : n.parentNode) {
      if (n === a) return true;
    }
    return false;
  }

  /** scope 以下（入れ子の Shadow DOM を含む）で selector に一致する要素 */
  function deepAll(scope, sel) {
    const out = [];
    const visit = (root) => {
      try { out.push(...root.querySelectorAll(sel)); } catch { return; }
      for (const el of root.querySelectorAll('*')) {
        const sr = shadowOf(el);
        if (sr) visit(sr);
      }
    };
    const own = scope instanceof Element ? shadowOf(scope) : null;
    visit(scope);
    if (own) visit(own);
    return out;
  }

  /** document と、把握済みの全 shadow root から selector に一致する要素 */
  function queryAllRoots(sel) {
    const out = [];
    for (const root of [document, ...shadowRoots]) {
      try { out.push(...root.querySelectorAll(sel)); } catch { return out; }
    }
    return out;
  }

  function ensureShadowStyle(sr) {
    let st = shadowStyles.get(sr);
    if (!st) {
      st = document.createElement('style');
      st.className = 'lab-blur-style';
      shadowStyles.set(sr, st);
      if (observer) observer.observe(sr, OBSERVE_OPTS);
    }
    if (st.textContent !== shadowCss) st.textContent = shadowCss;
    if (st.parentNode !== sr) sr.appendChild(st);
  }

  /** ページ内の shadow root を列挙し、ぼかし CSS と変更監視を取り付ける */
  function refreshShadowRoots() {
    const out = [];
    const visit = (root) => {
      for (const el of root.querySelectorAll('*')) {
        const sr = shadowOf(el);
        if (sr) { out.push(sr); visit(sr); }
      }
    };
    visit(document);
    shadowRoots = out;
    for (const sr of out) ensureShadowStyle(sr);
    return out;
  }

  // ------------------------------------------------------------------ text scan

  function scheduleScan(delay = 150) {
    if (scanTimer) return;
    scanTimer = setTimeout(scan, delay);
  }

  function scan() {
    scanTimer = 0;
    if (!document.body || !alive()) return;
    if (!styleEl || !styleEl.isConnected) applyStyle();
    refreshShadowRoots();

    const blurEls = new Set();
    const ranges = [];

    if (settings.enabled && nameRe) {
      const filter = {
        acceptNode(n) {
          const p = n.parentElement;
          if (!p || SKIP_TAGS.has(p.tagName) || p.closest('.' + UI_CLASS)) return NodeFilter.FILTER_REJECT;
          return n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
      };
      // document.body と各 shadow root のテキストを走査（TreeWalker は Shadow DOM に入らない）
      const textNodes = [];
      for (const root of [document.body, ...shadowRoots]) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, filter);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) textNodes.push(n);
      }

      for (const node of textNodes) {
        const text = node.nodeValue;
        nameRe.lastIndex = 0;
        if (!nameRe.test(text)) continue;
        nameRe.lastIndex = 0;

        const found = [];
        let matched = 0;
        let m;
        while ((m = nameRe.exec(text))) {
          if (!m[0]) { nameRe.lastIndex++; continue; }
          found.push([m.index, m.index + m[0].length]);
          matched += m[0].length;
        }
        if (!found.length) continue;

        const parent = node.parentElement;
        const whole = (parent.textContent || '').replace(/\s+/g, '').length;
        // 要素のテキストがほぼ名前だけ（「さん」等の敬称程度）なら要素ごとぼかす
        if (!HAS_HL || (parent !== document.body && whole <= matched + 4)) {
          blurEls.add(parent);
        } else {
          for (const [s, e] of found) {
            const r = new Range();
            r.setStart(node, s);
            r.setEnd(node, e);
            ranges.push(r);
          }
        }
      }

      // フォームに入力済みの ID 等
      for (const el of queryAllRoots('input:not([type=hidden]):not([type=password]), textarea')) {
        nameRe.lastIndex = 0;
        if (el.value && nameRe.test(el.value)) blurEls.add(el);
      }
    }

    for (const el of queryAllRoots(`[${ATTR}="t"]`)) {
      if (!blurEls.has(el)) el.removeAttribute(ATTR);
    }
    for (const el of blurEls) {
      if (!el.hasAttribute(ATTR)) el.setAttribute(ATTR, 't');
    }
    if (HAS_HL) {
      if (ranges.length) CSS.highlights.set(HL_NAME, new Highlight(...ranges));
      else CSS.highlights.delete(HL_NAME);
    }
  }

  // ------------------------------------------------------------------ detection

  const HEADER_SEL = 'header, [role="banner"], #header, [id*="header" i], [class*="header" i], nav';
  const AVATAR_HINT = /avatar|user|profile|icon|thumb|account|mypage|member|face|photo|self/i;
  const LOGO_HINT = /logo|brand|banner|sprite|badge|flag|emoji|award|rank/i;
  const DEFAULT_IMG = /no[_-]?image|noimage|no[_-]?photo|default|dummy|placeholder|blank|guest|anonymous/i;
  const NAME_CLASS = /user[-_]?name|nick[-_]?name|account[-_]?name|display[-_]?name|login[-_]?name|member[-_]?name|screen[-_]?name|user[-_]?id/i;
  const GENERIC_TEXT = new RegExp(
    '^(マイページ|プロフィール|profile|my ?page|アカウント|account|ログイン|ログアウト|log ?in|log ?out|' +
    'sign ?in|sign ?out|sign ?up|会員登録|設定|settings?|メニュー|menu|avatar|icon|user|ユーザー|image|' +
    'メッセージ|messages?|通知|お知らせ|notifications?|ヘルプ|help|ホーム|home|検索|search|' +
    '.*(画像|アイコン|写真|サムネイル))$', 'i');

  function scheduleDetect() {
    if (!settings.autoLearn || !domReady || detectTimer) return;
    const interval = Date.now() - startedAt < DETECT_FAST_MS ? 800 : 10000;
    const wait = Math.max(0, lastDetect + interval - Date.now());
    detectTimer = setTimeout(() => {
      detectTimer = 0;
      lastDetect = Date.now();
      try { detect(); } catch (e) { /* DOM 変化中の例外は無視 */ }
    }, wait);
  }

  const docTop = (r) => r.top + window.scrollY;
  const visible = (r) => r.width > 0 && r.height > 0;

  /** ページ最上部にある、横幅の広いヘッダー的な要素 */
  function headerContainers() {
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const sel = [HEADER_SEL, ...site.containerSelectors].join(',');
    let list = queryAllRoots(sel);
    if (!list.length) list = queryAllRoots(HEADER_SEL);
    const hits = [];
    for (const el of new Set(list)) {
      const r = el.getBoundingClientRect();
      if (!visible(r) || docTop(r) > 100 || r.height > 260 || r.width < vw * 0.5) continue;
      hits.push(el);
    }
    // 他の候補に（Shadow DOM 越しに）含まれるものは除く
    return hits.filter((el) => !hits.some((c) => c !== el && deepContains(c, el)));
  }

  function bgUrl(el) {
    const bg = getComputedStyle(el).backgroundImage;
    const m = bg && bg.match(/url\(["']?(.*?)["']?\)/);
    return m ? m[1] : null;
  }

  function imageUrlOf(el) {
    if (el.tagName === 'IMG') return el.currentSrc || el.src || null;
    if (el.tagName === 'image') return el.getAttribute('href') || el.getAttribute('xlink:href');
    return bgUrl(el);
  }

  function hintOf(el) {
    const p = composedParent(el);
    const gp = p && composedParent(p);
    return [el.className, el.id, el.getAttribute('alt'), el.getAttribute('title'),
      el.getAttribute('src'), p && p.className, gp && gp.className]
      .map((v) => (typeof v === 'string' ? v : (v && v.baseVal) || '')).join(' ');
  }

  function isRound(el, r) {
    for (const e of [el, composedParent(el)]) {
      if (!e) continue;
      const br = getComputedStyle(e).borderTopLeftRadius;
      if (br.endsWith('%') ? parseFloat(br) >= 30 : parseFloat(br) >= Math.min(r.width, r.height) / 3) return true;
    }
    return false;
  }

  function cleanName(s) {
    if (!s) return null;
    let t = String(s).replace(/[\s\u3000]+/g, ' ').trim()
      .replace(/^@/, '').replace(/\s*(さん|様|さま)$/, '').trim();
    if (t.length < 2 || t.length > 40) return null;
    if (GENERIC_TEXT.test(t)) return null;
    if (!/[A-Za-z\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f]/.test(t)) return null; // 数字・記号だけ（通知件数など）は除外
    return t;
  }

  /** 正規表現に一致したプロフィールリンクから ID を取り出す（数値 ID は画面に出ないので除外） */
  function idFromLink(a) {
    const href = a.getAttribute('href') || '';
    for (const re of site.profileLinkPatterns) {
      const m = href.match(re);
      if (m) return /^\d+$/.test(m[1]) ? '' : m[1];
    }
    return null;
  }

  /** アバターを含む「ユーザーメニュー」相当の小さな祖先要素 */
  function userGroupOf(el) {
    let group = composedParent(el) || el;
    for (let i = 0; i < 5; i++) {
      const next = composedParent(group);
      if (!next || next === document.body || next === document.documentElement) break;
      if (deepAll(next, 'img').length > 3 || deepAll(next, 'a').length > 25) break;
      group = next;
    }
    return group;
  }

  function detect() {
    if (!document.body) return;
    refreshShadowRoots();
    const containers = headerContainers();
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const inHeader = (el) => containers.some((c) => deepContains(c, el));

    // ---- アバター候補（Shadow DOM 内も含む）
    const cands = new Set();
    for (const c of containers) {
      for (const el of deepAll(c, 'img, image, [style*="background"], span, div, a, i, button')) cands.add(el);
    }
    const strong = new Set();
    for (const sel of site.avatarSelectors) {
      for (const el of queryAllRoots(sel)) { cands.add(el); strong.add(el); }
    }

    const scored = [];
    for (const el of cands) {
      if (el.closest('.' + UI_CLASS)) continue;
      const r = el.getBoundingClientRect();
      if (!visible(r) || r.width < 16 || r.width > 96 || r.height > 96) continue;
      if (Math.abs(r.width - r.height) > Math.max(r.width, r.height) * 0.25) continue;
      const header = inHeader(el);
      if (!(header ? docTop(r) < 160 : docTop(r) < 80)) continue;
      const url = imageUrlOf(el);
      if (!url || /^(data|blob):/.test(url) || DEFAULT_IMG.test(url)) continue;
      const hint = hintOf(el);
      if (LOGO_HINT.test(hint)) continue;

      let score = 0;
      if (strong.has(el)) score += 5;
      if (AVATAR_HINT.test(hint)) score += 2;
      if (isRound(el, r)) score += 2;
      if (r.left > vw / 2) score += 1; // ユーザーメニューは右上にあることが多い
      if (score >= 3) scored.push({ el, url, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const avatars = scored.slice(0, 2);

    // ---- ユーザー名 / ID 候補
    const names = new Set();
    const addName = (s) => { const t = cleanName(s); if (t) names.add(t); };

    for (const { el } of avatars) {
      addName(el.getAttribute('alt'));
      addName(el.getAttribute('title'));
      // ユーザーメニュー内は非表示（ドロップダウン）でも自分の情報とみなす
      const group = userGroupOf(el);
      for (const n of deepAll(group, '*')) {
        const cls = typeof n.className === 'string' ? n.className : '';
        if (NAME_CLASS.test(cls + ' ' + n.id) && n.children.length <= 2) addName(n.textContent);
      }
      for (const a of deepAll(group, 'a[href]')) {
        const id = idFromLink(a);
        if (id === null) continue;
        if (id) addName(id);
        if (!a.querySelector('img')) addName(a.textContent);
      }
    }

    // ヘッダー内で「表示されている」ユーザー名要素・プロフィールリンク
    for (const c of containers) {
      for (const n of deepAll(c, '*')) {
        const cls = typeof n.className === 'string' ? n.className : '';
        const r = n.getBoundingClientRect();
        if (!visible(r)) continue;
        if (NAME_CLASS.test(cls + ' ' + n.id) && n.children.length <= 2) addName(n.textContent);
        if (n.tagName === 'A') {
          const id = idFromLink(n);
          if (id) addName(id);
          if (id !== null && !n.querySelector('img')) addName(n.textContent);
        }
      }
    }
    for (const sel of site.nameSelectors) {
      for (const n of queryAllRoots(sel)) {
        if (n.children.length <= 2 && (avatars.length || visible(n.getBoundingClientRect()))) addName(n.textContent);
      }
    }

    // ---- 反映
    for (const { el } of avatars) if (!el.hasAttribute(ATTR)) el.setAttribute(ATTR, 'd');
    // 名前はアバターが見つかった（=ログイン中）ときだけ学習する
    if (!avatars.length) return;
    const changedA = mergeInto('autoAvatars', avatars.map((a) => new URL(a.url, location.href).href));
    const changedN = mergeInto('autoNames', [...names]);
    if (changedA || changedN) save();
  }

  // ------------------------------------------------------------------ pick mode

  let picking = false;
  let pickBox = null;
  let pickTip = null;
  let pickTarget = null;

  function uiEl(cls, text) {
    const el = document.createElement('div');
    el.className = `${UI_CLASS} ${cls}`;
    if (text) el.textContent = text;
    document.documentElement.appendChild(el);
    return el;
  }

  function toast(msg) {
    const t = uiEl('lab-toast', msg);
    setTimeout(() => t.remove(), 2500);
  }

  const blockEvent = (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  };

  /** Shadow DOM 内の要素は e.target がホストに付け替えられるため、実際の要素を取る */
  const realTarget = (e) => (e.composedPath && e.composedPath()[0]) || e.target;

  function onPickMove(e) {
    const t = realTarget(e);
    if (!(t instanceof Element) || t.closest('.' + UI_CLASS)) return;
    pickTarget = t;
    const r = t.getBoundingClientRect();
    Object.assign(pickBox.style, {
      left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px',
    });
  }

  function onPickClick(e) {
    blockEvent(e);
    const t = pickTarget || realTarget(e);
    stopPick();
    if (t instanceof Element) handlePicked(t);
  }

  function onPickKey(e) {
    if (e.key === 'Escape') { blockEvent(e); stopPick(); toast('選択をキャンセルしました'); }
  }

  const PICK_EVENTS = [['mousemove', onPickMove], ['click', onPickClick], ['mousedown', blockEvent],
    ['mouseup', blockEvent], ['pointerdown', blockEvent], ['pointerup', blockEvent], ['keydown', onPickKey]];

  function startPick() {
    if (picking || !IS_TOP) return;
    picking = true;
    pickBox = uiEl('lab-pick-box');
    pickTip = uiEl('lab-pick-tip', 'ぼかしたいアバター画像または ID/名前をクリック（Esc でキャンセル）');
    for (const [type, fn] of PICK_EVENTS) window.addEventListener(type, fn, true);
  }

  function stopPick() {
    picking = false;
    for (const [type, fn] of PICK_EVENTS) window.removeEventListener(type, fn, true);
    pickBox?.remove();
    pickTip?.remove();
    pickBox = pickTip = pickTarget = null;
  }

  function findImage(t) {
    const direct = imageUrlOf(t);
    if (direct && !/^(data|blob):/.test(direct)) return direct;
    const r = t.getBoundingClientRect();
    if (r.width <= 160 && r.height <= 160) {
      const img = deepAll(t, 'img')[0];
      if (img && (img.currentSrc || img.src)) return img.currentSrc || img.src;
      for (const c of deepAll(t, '*')) {
        const u = bgUrl(c);
        if (u && !/^(data|blob):/.test(u)) return u;
      }
    }
    return null;
  }

  function handlePicked(t) {
    const url = findImage(t);
    if (url) {
      const abs = new URL(url, location.href).href;
      if (!data.manualAvatars.includes(abs)) data.manualAvatars = [abs, ...data.manualAvatars];
      save();
      toast('アバター画像を登録しました');
      return;
    }
    const text = (t.innerText || t.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const input = window.prompt('ぼかす ID / ユーザー名を確認してください（不要な部分は削除できます）', text);
    const name = input && input.trim();
    if (!name || name.length < 2) {
      if (input !== null) toast('2文字以上で入力してください');
      return;
    }
    if (!data.manualNames.includes(name)) data.manualNames = [name, ...data.manualNames];
    save();
    toast(`「${name}」をぼかし対象に登録しました`);
  }

  // ------------------------------------------------------------------ wiring

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !IS_TOP) return;
    if (msg.type === 'lab:getSite') {
      sendResponse({ siteKey, label: site.label });
    } else if (msg.type === 'lab:pick') {
      startPick();
      sendResponse({ ok: true });
    } else if (msg.type === 'lab:detect') {
      lastDetect = Date.now();
      try { detect(); } catch {}
      sendResponse({ ok: true });
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes[LAB_SETTINGS_KEY] || changes[SITE_STORE])) load();
  });

  function onDomReady() {
    domReady = true;
    observer = new MutationObserver(() => {
      if (!alive()) { observer.disconnect(); return; }
      scheduleScan();
      scheduleDetect();
    });
    observer.observe(document.documentElement, OBSERVE_OPTS);
    // 既に見つかっている shadow root も監視（以降に見つかったものは ensureShadowStyle で追加）
    for (const sr of shadowRoots) observer.observe(sr, OBSERVE_OPTS);
    document.addEventListener('input', () => scheduleScan(), true);
    // 画像読み込み完了でサイズが確定してから再検出
    document.addEventListener('load', (e) => {
      const t = realTarget(e);
      if (t && t.tagName === 'IMG') scheduleDetect();
    }, true);
    window.addEventListener('load', () => scheduleDetect(), { once: true });
    scheduleScan(0);
    scheduleDetect();
  }

  load().catch(() => {}).finally(() => {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onDomReady, { once: true });
    else onDomReady();
  });
})();
