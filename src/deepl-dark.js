/*
 * DeepL 翻訳（例: https://www.deepl.com/en/translator）をダークモードで表示するコンテンツスクリプト。
 *
 * DeepL のクラス名は頻繁に変わるため、個別の要素に色を指定するのではなく、
 * ページ全体の色を反転（invert + hue-rotate）して暗くし、画像・動画などは
 * もう一度反転して元の色に戻す方式にしている。
 * 設定（ポップアップの「DeepL をダークモードにする」）は chrome.storage.local の settings.deeplDark。
 */
(() => {
  'use strict';
  if (window.__labDeeplDarkLoaded) return;
  window.__labDeeplDarkLoaded = true;

  const STYLE_ID = 'lab-deepl-dark';
  const CSS = `
    html {
      background-color: #fff !important;  /* 反転後に暗い背景になる */
      filter: invert(0.9) hue-rotate(180deg) !important;
      color-scheme: light !important;
    }
    /* 写真・動画・キャンバス等は再反転して本来の色で表示する */
    img, picture, video, canvas, iframe, embed, object,
    [style*="background-image"] {
      filter: invert(1) hue-rotate(180deg) !important;
    }
    /* 二重に反転しないように */
    picture img, [style*="background-image"] img {
      filter: none !important;
    }
    /* 反転後のスクロールバーを目立たなくする */
    ::-webkit-scrollbar { background-color: #f0f0f0; }
    ::-webkit-scrollbar-thumb { background-color: #c8c8c8; border-radius: 6px; }
    ::selection { background-color: #9cc7ff; }
  `;

  let enabled = true; // 既定は ON（設定読み込み前のちらつきを防ぐため先に適用する）

  function apply() {
    let el = document.getElementById(STYLE_ID);
    if (!enabled) {
      el?.remove();
      return;
    }
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
      el.textContent = CSS;
    }
    // <head> の差し替えや SPA の再描画で外れた場合も付け直す
    const parent = document.head || document.documentElement;
    if (el.parentNode !== parent || parent.lastElementChild !== el) parent.appendChild(el);
  }

  apply();

  const alive = () => {
    try { return !!chrome.runtime?.id; } catch { return false; }
  };

  function load() {
    if (!alive()) return;
    chrome.storage.local.get(LAB_SETTINGS_KEY).then((res) => {
      const s = { ...LAB_DEFAULT_SETTINGS, ...(res[LAB_SETTINGS_KEY] || {}) };
      enabled = !!s.deeplDark;
      apply();
    }).catch(() => {});
  }

  load();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[LAB_SETTINGS_KEY]) load();
  });

  // <head> が後から作られる・置き換えられる場合に備えて監視
  let timer = 0;
  const obs = new MutationObserver(() => {
    if (!alive()) { obs.disconnect(); return; }
    if (timer) return;
    timer = setTimeout(() => {
      timer = 0;
      const el = document.getElementById(STYLE_ID);
      if (enabled && (!el || !el.isConnected)) apply();
    }, 100);
  });
  obs.observe(document.documentElement, { childList: true, subtree: false });
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    if (document.head) obs.observe(document.head, { childList: true });
  }, { once: true });
})();
