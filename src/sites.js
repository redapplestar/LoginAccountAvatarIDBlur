/*
 * 対象サイトの定義と、コンテンツスクリプト／ポップアップ共通のユーティリティ。
 *
 * 各サイトの DOM 構造は予告なく変わるため、サイト固有のセレクタは「ヒント」として
 * 使い、最終的にはヘッダー領域の汎用ヒューリスティックで自アカウントを検出する。
 * 検出に失敗した場合でも、ポップアップの「要素を選択してぼかす」で手動登録できる。
 */

const LAB_SETTINGS_KEY = 'settings';
const LAB_DEFAULT_SETTINGS = Object.freeze({
  enabled: true,   // ぼかし全体の ON/OFF
  blurPx: 8,       // ぼかしの強さ (px)
  autoLearn: true, // ヘッダーから自アカウントを自動検出する
  deeplDark: true, // DeepL 翻訳をダークモードで表示する
});

const LAB_SITES = {
  crowdworks: {
    label: 'クラウドワークス',
    host: /(^|\.)crowdworks\.jp$/i,
    containerSelectors: ['#header', '.header', '[class*="GlobalHeader"]', '[class*="global-header"]'],
    avatarSelectors: [
      'header [class*="user" i] img',
      'header img[class*="avatar" i]',
      '[class*="GlobalHeader"] img[class*="avatar" i]',
    ],
    nameSelectors: [
      'header [class*="user_name" i]',
      'header [class*="userName"]',
      'header [class*="user-name" i]',
    ],
    // ユーザー公開ページ: /public/employees/123456 /public/employers/123456
    profileLinkPatterns: [/\/public\/(?:employees|employers)\/(\d+)/i],
  },
  lancers: {
    label: 'ランサーズ',
    host: /(^|\.)lancers\.jp$/i,
    containerSelectors: ['.c-header', '.p-header', '#header', '[class*="Header_"]'],
    avatarSelectors: [
      'header [class*="avatar" i] img',
      'header img[class*="avatar" i]',
      '.c-header img[class*="user" i]',
    ],
    nameSelectors: [
      'header [class*="user-name" i]',
      'header [class*="username" i]',
      '.c-header [class*="name" i]',
    ],
    // プロフィール: /profile/{username}
    profileLinkPatterns: [/\/profile\/([A-Za-z0-9_-]{2,})/i],
  },
  coconala: {
    label: 'ココナラ',
    host: /(^|\.)coconala\.com$/i,
    // ココナラの共通ヘッダーは #coconala-header に読み込まれる Lit の Web Components
    // （<buyer-header> / <provider-header> → <user-menu> …）で、中身は Shadow DOM 内にある。
    // セレクタは shadow root ごとに評価されるため、Shadow DOM をまたぐ子孫セレクタは使わない。
    containerSelectors: ['#coconala-header', 'buyer-header', 'provider-header', '.c-header', '#header'],
    avatarSelectors: [
      'img.userMenu_iconImage',          // ヘッダー右上のアイコン（<user-menu> 内）
      'img.userMenuListUser_icon',       // ユーザーメニュー内のアイコン
      'img.spBuyerSidebar_userIcon',     // スマホ用サイドバー（購入者）
      'img.spProviderSidebar_userIcon',  // スマホ用サイドバー（出品者）
      'header [class*="user" i] img',
    ],
    nameSelectors: [
      '.userMenuListUser_name',
      '.spBuyerSidebar_userName',
      '.spProviderSidebar_userName',
      'header [class*="userName"]',
    ],
    // ユーザーページ: /users/123456
    profileLinkPatterns: [/\/users\/(\d+)/i],
  },
  workana: {
    label: 'Workana',
    host: /(^|\.)workana\.com$/i,
    containerSelectors: ['.navbar', '#header', '[class*="navbar"]'],
    avatarSelectors: [
      'header img[class*="avatar" i]',
      '.navbar img[class*="avatar" i]',
      '.navbar [class*="user" i] img',
    ],
    nameSelectors: [
      '.navbar [class*="user-name" i]',
      'header [class*="user-name" i]',
      '.navbar [class*="username" i]',
    ],
    // プロフィール: /freelancer/{slug}
    profileLinkPatterns: [/\/freelancer\/([A-Za-z0-9_-]{2,})/i],
  },
};

function labGetSiteKey(hostname) {
  for (const [key, site] of Object.entries(LAB_SITES)) {
    if (site.host.test(hostname)) return key;
  }
  return null;
}

function labSiteStoreKey(siteKey) {
  return 'site:' + siteKey;
}

function labEmptySiteData() {
  return {
    autoNames: [],    // 自動検出したユーザー名・ID
    autoAvatars: [],  // 自動検出したアバター画像 URL
    manualNames: [],  // 手動登録したユーザー名・ID
    manualAvatars: [] // 手動登録したアバター画像 URL
  };
}

/**
 * アバター画像 URL から、同一画像を指す src を CSS 属性セレクタで
 * 照合するためのキーを作る。サイズ違い（_100x100 等）やクエリ違いでも一致させる。
 */
function labAvatarKeys(url) {
  try {
    const u = new URL(url, location.href);
    if (!/^https?:$/.test(u.protocol)) return [];
    const keys = [];
    const path = u.pathname;
    if (path.length >= 8) keys.push(path);
    else keys.push(path + u.search);

    const seg = path.split('/').filter(Boolean).pop() || '';
    const base = seg
      .replace(/\.(jpe?g|png|gif|webp|avif|svg|bmp)$/i, '')
      .replace(/([_-]?\d{2,4}x\d{2,4}|@\dx|[_-](?:thumb|thumbnail|small|medium|large|original|[sml]))$/i, '');
    // ハッシュ風の十分長いファイル名のみ（短い名前は他画像と誤一致しやすい）
    if (base.length >= 12 && !keys.includes(base)) keys.push(base);
    return keys;
  } catch {
    return [];
  }
}

/** ユーザー名・ID のリストから照合用の正規表現を作る（長い順・空白ゆれ許容）。 */
function labBuildNameRegex(names) {
  const uniq = [...new Set(names.map((n) => String(n || '').trim()).filter((n) => n.length >= 2))]
    .sort((a, b) => b.length - a.length);
  if (!uniq.length) return null;
  const parts = uniq.map((n) => {
    let p = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\s\u3000]+/g, '[\\s\\u3000]*');
    // 英数字で始まる/終わる ID は単語境界を付けて、他の単語の一部に誤一致しないようにする
    if (/^[A-Za-z0-9_]/.test(n)) p = '(?<![A-Za-z0-9_])' + p;
    if (/[A-Za-z0-9_]$/.test(n)) p = p + '(?![A-Za-z0-9_])';
    return p;
  });
  return new RegExp(parts.join('|'), 'gi');
}
