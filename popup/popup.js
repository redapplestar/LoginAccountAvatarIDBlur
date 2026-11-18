'use strict';

const $ = (sel) => document.querySelector(sel);

let settings = { ...LAB_DEFAULT_SETTINGS };
let siteKey = null;
let tabId = null;
let data = labEmptySiteData();

async function init() {
  const res = await chrome.storage.local.get(LAB_SETTINGS_KEY);
  settings = { ...LAB_DEFAULT_SETTINGS, ...(res[LAB_SETTINGS_KEY] || {}) };
  renderSettings();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab && tab.id;
  let info = null;
  if (tabId != null) {
    try {
      info = await chrome.tabs.sendMessage(tabId, { type: 'lab:getSite' }, { frameId: 0 });
    } catch {
      info = null; // 対象外サイト、または拡張機能の導入前から開いていたタブ
    }
  }

  if (!info || !info.siteKey) {
    $('#notSupported').hidden = false;
    return;
  }
  siteKey = info.siteKey;
  $('#siteLabel').textContent = info.label;
  $('#siteSection').hidden = false;
  await loadSite();
}

async function loadSite() {
  const key = labSiteStoreKey(siteKey);
  const res = await chrome.storage.local.get(key);
  data = { ...labEmptySiteData(), ...(res[key] || {}) };
  renderSite();
}

function saveSettings() {
  return chrome.storage.local.set({ [LAB_SETTINGS_KEY]: settings });
}

function saveSite() {
  return chrome.storage.local.set({ [labSiteStoreKey(siteKey)]: data });
}

function renderSettings() {
  $('#enabled').checked = settings.enabled;
  $('#autoLearn').checked = settings.autoLearn;
  $('#deeplDark').checked = settings.deeplDark;
  $('#blurPx').value = settings.blurPx;
  $('#blurPxValue').textContent = settings.blurPx + 'px';
}

function chip({ text, tag, img, onRemove }) {
  const li = document.createElement('li');
  if (img) {
    const im = document.createElement('img');
    im.src = img;
    im.alt = '';
    im.referrerPolicy = 'no-referrer';
    li.title = img;
    li.appendChild(im);
  }
  if (text) {
    const s = document.createElement('span');
    s.className = 'text';
    s.textContent = text;
    li.title = li.title || text;
    li.appendChild(s);
  }
  const t = document.createElement('span');
  t.className = 'tag';
  t.textContent = tag;
  li.appendChild(t);
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = '×';
  b.title = '削除';
  b.addEventListener('click', onRemove);
  li.appendChild(b);
  return li;
}

function renderList(ul, autoKey, manualKey, isAvatar) {
  ul.replaceChildren();
  const items = [
    ...data[manualKey].map((v) => ({ v, key: manualKey, tag: '手動' })),
    ...data[autoKey].map((v) => ({ v, key: autoKey, tag: '自動' })),
  ];
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = isAvatar ? '未検出' : '未検出（ログイン後のページで自動検出されます）';
    ul.appendChild(li);
    return;
  }
  for (const { v, key, tag } of items) {
    ul.appendChild(chip({
      text: isAvatar ? null : v,
      img: isAvatar ? v : null,
      tag,
      onRemove: async () => {
        data[key] = data[key].filter((x) => x !== v);
        await saveSite();
        renderSite();
      },
    }));
  }
}

function renderSite() {
  renderList($('#avatarList'), 'autoAvatars', 'manualAvatars', true);
  renderList($('#nameList'), 'autoNames', 'manualNames', false);
}

// ---- events

$('#enabled').addEventListener('change', (e) => {
  settings.enabled = e.target.checked;
  saveSettings();
});
$('#autoLearn').addEventListener('change', (e) => {
  settings.autoLearn = e.target.checked;
  saveSettings();
});
$('#deeplDark').addEventListener('change', (e) => {
  settings.deeplDark = e.target.checked;
  saveSettings();
});
$('#blurPx').addEventListener('input', (e) => {
  settings.blurPx = Number(e.target.value);
  $('#blurPxValue').textContent = settings.blurPx + 'px';
});
$('#blurPx').addEventListener('change', saveSettings);

$('#pickBtn').addEventListener('click', async () => {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'lab:pick' }, { frameId: 0 });
    window.close();
  } catch {
    alert('ページと通信できませんでした。ページを再読み込みしてから再度お試しください。');
  }
});

$('#detectBtn').addEventListener('click', async () => {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'lab:detect' }, { frameId: 0 });
    setTimeout(loadSite, 300);
  } catch {}
});

$('#addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = $('#addInput').value.trim();
  if (v.length < 2) return;
  const key = /^https?:\/\//i.test(v) ? 'manualAvatars' : 'manualNames';
  if (!data[key].includes(v)) data[key] = [v, ...data[key]];
  $('#addInput').value = '';
  await saveSite();
  renderSite();
});

$('#resetBtn').addEventListener('click', async () => {
  if (!confirm('このサイトで検出・登録したアバターと ID/名前をすべて削除しますか？')) return;
  data = labEmptySiteData();
  await saveSite();
  renderSite();
});

// コンテンツスクリプト側で自動検出・手動登録された変更を反映
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && siteKey && changes[labSiteStoreKey(siteKey)]) loadSite();
});

init();
