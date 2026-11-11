/**
 * LIXIL製品 在庫管理 Webアプリ（軽量版）＋受発注の消し込み
 *
 * 速さの工夫
 *  - 画面はGitHub Pages、Apps ScriptはデータAPI専用
 *  - 起動時は前回データで即表示し、裏で最新を1回だけ取得
 *  - 製品マスタは1回の getValues で一括取得
 *  - 登録時は該当行のセルと履歴1行だけ書き込む（消し込みは対象行だけ）
 *  - 現在在庫数（H列）は登録のたびに更新するので、履歴を毎回集計しない
 *
 * 受発注との連動
 *  - 入庫「外注入荷」…外注指示の未入荷分を入荷予定日の早い順に消し込む（入荷済数 J列・状態 G列・入荷日 F列）
 *  - 出庫「受注出荷」…受注明細の在庫引当・未出荷（新規を含む）分を納期の早い順に消し込む（出荷済数 J列・状態 G列）
 *  - 入出庫履歴の H列に区分、I列に消し込んだ行（例 R12:3,R15:2）を残す
 *  - 変更依頼の承認で数量が変わったときは、消し込みも差分だけ直す
 *
 * 棚卸モード（2026-10-30〜）
 *  - 「棚卸開始」で全端末が棚卸モード。入力は「棚卸記録」に1回1行（置き場：倉庫／工場）、同じ品番は足し算
 *  - 棚卸モード中（実施中）は入庫・出庫・調整をサーバー側で止め、Google Chatに通知
 *  - 端末ごとに「この端末は終了」で棚卸の画面を抜けられる（全体は棚卸中のまま。もう一度「棚卸に戻る」で続き）
 *  - 「全体を完了」で確認待ち。数えていない品番は確定しても帳簿のまま（在庫ありの未棚卸は確認画面とChatで知らせる）
 *  - バックオフィスがPINで「確定」すると製品マスタH列へ反映。
 *    確定後の在庫 ＝ 棚卸数 ＋ その品番を最後に数えた時刻より後の入出庫（完了〜確定の間の出荷など）
 *  - 誤って始めたときは、バックオフィスがPINで「中止」（在庫は変えずに棚卸モードを終わらせる）
 *  - 確定時に受注明細の在庫引当（未出荷）で在庫が足りなくなった行をChatに通知（受注明細L列にも「不足」表示）
 *
 * 報告・通知（2026-10-30〜）
 *  - 「報告」で現場からテキストを送ると「報告」シートに記録し、Google Chatに通知
 *  - 変更依頼・棚卸の開始／完了／確定・棚卸中の入出庫の試み・在庫マイナス・受注残超えの出荷・エラーもChatに通知
 *
 * まとめて出荷（2026-11-11〜）
 *  - 出荷リストのタブでチェックした受注を1回でまとめて出庫（紙のリストでピッキングした後に事務所から登録する用）
 *  - 1件でも出庫できない行（出荷済み・残り超え・行の変更など）があれば、1件も出庫せずに理由を返す
 *  - 入出庫履歴は受注1行につき1行（QR出荷と同じ形。備考は「まとめて出荷 納期m/d」）
 *
 * 出荷リスト・QR出荷（2026-11-05〜）
 *  - 出荷リスト（shukka.html）：受注明細の 引当「在庫」・状態「新規／未出荷」・残り（数量−出荷済数）がある行をQR付きで印刷
 *  - QRの中身：在庫アプリのURL ＋ ?ship=納期yyyymmdd-製品ID（例 ...index.html?ship=20261106-38）
 *  - QRを読むと 注文・出荷済・残り を表示し、数量の初期値は残り。出庫を押すとその行だけを消し込む
 *  - 分納：残りより少ない数で出庫すると「未出荷」のまま、残り0で「出荷済」
 *  - 出荷済み・残り超え・棚卸中は出庫できない
 */

/* ===== 書き込み先：テストは改修版、本番は元のスプシのIDにする ===== */
// const SS_ID = '1S5kzOKJc5SILpnvY_y3qjTT50fDK8j7dnKUMTuTBiSs';  // 改修版（テスト）
const SS_ID = '19a-c_afxv_Ab0xfYPzxxmj0vxfP336KA0wiRZCJnZ5I'; // 本番（2026-10-27〜）
/* ================================================================ */

const SH_MASTER = '製品マスタ';
const SH_LOG = '入出庫履歴';
const SH_INV = '棚卸履歴';   // 無ければ自動で作成
const SH_REQ = '変更依頼';   // 無ければ自動で作成
const SH_ORDER = '受注明細';
const SH_PO = '外注指示';
const SH_TK = '棚卸';         // 棚卸ごとの記録（無ければ自動で作成）
const SH_TKREC = '棚卸記録';  // 棚卸モードでの入力1件ずつ（無ければ自動で作成）
const SH_RPT = '報告';        // 現場からの報告（無ければ自動で作成）
const ADMIN_PIN = '0000';    // 承認用の管理者PIN（必ず変更する）
const STAFF = ['池戸', '山田', '佐藤']; // 担当者リスト（ここを編集）
const LOCS = ['倉庫', '工場']; // 棚卸の置き場（ここを編集）

/* ===== Google Chat 通知 =====
 * WebhookのURLはコードに書かず、Apps Scriptの「プロジェクトの設定 → スクリプト プロパティ」に
 * プロパティ名 CHAT_WEBHOOK で保存する（GitHubなどにURLが残らないように）。未設定なら通知しない。
 * ============================ */
const chatWebhook_ = () => PropertiesService.getScriptProperties().getProperty('CHAT_WEBHOOK') || '';

const PROP_TK = 'TK_STATE';   // 棚卸モードの状態（スクリプトプロパティ）
const TK_AUTO = '（自動0）';   // 旧仕様で完了時に在庫0の未棚卸を0で記録したときの置き場名（差し戻しで取り消す）

// 製品マスタの列番号（1始まり）
const COL = { ID: 1, HB: 2, CAT: 3, W: 4, H: 5, PRICE: 6, INIT: 7, STOCK: 8, TARGET: 9, JUDGE: 10,
  ORD: 14, PO: 15 };

// 入出庫の区分
const SUBS = { '入庫': ['通常', '外注入荷'], '出庫': ['受注出荷', 'その他'] };
const SUB_DEFAULT = { '入庫': '通常', '出庫': 'その他' };

// 簡易キー（index.html の API_KEY と同じ文字列にする）
const API_KEY = 'yasumoku-zaiko';

/** 読み込み：?action=boot | history&id=○ | shipList | shipInfo&k=○ */
function doGet(e) {
  try {
    const p = e.parameter || {};
    checkKey_(p.key);
    const action = p.action || 'boot';
    if (action === 'boot') return raw_('{"ok":true,"data":' + getBootJson_(p.fresh === '1') +
      ',"tk":' + JSON.stringify(tkView_()) + '}');
    if (action === 'history') return json_({ ok: true, data: getHistory(p.id) });
    if (action === 'requests') return json_({ ok: true, data: listRequests() });
    if (action === 'inbox') return json_({ ok: true, data: inbox_() });
    if (action === 'tk') return json_({ ok: true, data: tkView_() });
    if (action === 'tkEntries') return json_({ ok: true, data: tkEntries_(p.id) });
    if (action === 'shipList') return json_({ ok: true, data: shipList() });
    if (action === 'shipInfo') return json_({ ok: true, data: shipInfo(p.k) });
    throw new Error('不明な操作です: ' + action);
  } catch (err) {
    return json_({ ok: false, error: err.message });
  }
}

/** 書き込み：入庫・出庫・調整・棚卸モード・報告・QR出荷 */
function doPost(e) {
  let p = {};
  try {
    p = JSON.parse(e.postData.contents);
    checkKey_(p.key);
    const action = p.action || 'register';
    if (action === 'register') return json_({ ok: true, data: register(p) });
    if (action === 'request') return json_({ ok: true, data: createRequest(p) });
    if (action === 'approve') return json_({ ok: true, data: processRequest(p) });
    if (action === 'report') return json_({ ok: true, data: createReport(p) });
    if (action === 'reports') return json_({ ok: true, data: listReports(p) });
    if (action === 'reportDone') return json_({ ok: true, data: reportDone(p) });
    if (action === 'tkStart') return json_({ ok: true, data: tkStart(p) });
    if (action === 'tkCount') return json_({ ok: true, data: tkCount(p) });
    if (action === 'tkCancel') return json_({ ok: true, data: tkCancel(p) });
    if (action === 'tkFinish') return json_({ ok: true, data: tkFinish(p) });
    if (action === 'tkReview') return json_({ ok: true, data: tkReview(p) });
    if (action === 'tkConfirm') return json_({ ok: true, data: tkConfirm(p) });
    if (action === 'tkReturn') return json_({ ok: true, data: tkReturn(p) });
    if (action === 'tkAbort') return json_({ ok: true, data: tkAbort(p) });
    if (action === 'ship') return json_({ ok: true, data: ship(p) });
    if (action === 'shipBatch') return json_({ ok: true, data: shipBatch(p) });
    throw new Error('不明な操作です: ' + action);
  } catch (err) {
    if (!err.quiet) notify_('⚠️ エラー：' + err.message + '（操作 ' + (p.action || 'register') +
      (p.staff ? '・' + p.staff : '') + '）');
    return json_({ ok: false, error: err.message });
  }
}

/** 入力ミスなど、Chatに通知しないエラー */
function fail_(msg) {
  const e = new Error(msg);
  e.quiet = true;
  return e;
}

function checkKey_(k) {
  if (k !== API_KEY) throw new Error('キーが一致しません');
}

function raw_(s) {
  return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.JSON);
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/** 起動時データ（キャッシュ優先：シートを開かずに返すので速い） */
const CACHE_KEY = 'boot_v2';
const CACHE_SEC = 21600; // 6時間（上限）

function getBootJson_(fresh) {
  const cache = CacheService.getScriptCache();
  if (!fresh) {
    const hit = cache.get(CACHE_KEY);
    if (hit) return hit;
  }
  const s = JSON.stringify({ items: getMaster(), staff: STAFF });
  cache.put(CACHE_KEY, s, CACHE_SEC);
  return s;
}

/** 登録後、キャッシュ内の在庫数・受注残・発注残だけ書き換える */
function updateCache_(id, stock, dOrd, dPo) {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(CACHE_KEY);
  if (!hit) return;
  const d = JSON.parse(hit);
  const it = d.items.find(x => x.id === String(id));
  if (!it) return;
  it.stock = stock;
  if (dOrd) it.ord = Math.max(0, (it.ord || 0) + dOrd);
  if (dPo) it.po = Math.max(0, (it.po || 0) + dPo);
  cache.put(CACHE_KEY, JSON.stringify(d), CACHE_SEC);
}

/** トリガー用：10分ごとにシートから読み直してキャッシュを最新に保つ */
function warmCache() {
  getBootJson_(true);
}

/** 製品マスタを一括取得（受注残 N列・発注残 O列も） */
function getMaster() {
  const sh = SpreadsheetApp.openById(SS_ID).getSheetByName(SH_MASTER);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, COL.PO).getValues()
    .filter(r => r[0] !== '' && r[1] !== '')
    .map(r => ({
      id: String(r[0]),
      hb: String(r[1]),
      cat: String(r[2]),
      w: r[3],
      h: r[4],
      stock: r[7] === '' ? (Number(r[6]) || 0) : Number(r[7]),
      target: r[8] === '' ? null : Number(r[8]),
      ord: Number(r[COL.ORD - 1]) || 0,
      po: Number(r[COL.PO - 1]) || 0
    }));
}

/** 入庫・出庫・調整・棚卸を登録 */
function register(p) {
  const types = ['入庫', '出庫', '調整', '棚卸'];
  const qty = Math.trunc(Number(p.qty));
  if (!p.id || types.indexOf(p.type) < 0 || isNaN(qty)) throw new Error('入力内容が正しくありません');
  if (p.type === '棚卸' && qty < 0) throw new Error('棚卸数量は0以上で入力してください');
  if ((p.type === '入庫' || p.type === '出庫') && qty < 1) throw new Error('入庫・出庫の数量は1以上で入力してください');
  if (p.type === '調整' && qty === 0) throw new Error('調整数量を入力してください');

  let sub = '';
  if (SUBS[p.type]) {
    sub = p.sub || SUB_DEFAULT[p.type];
    if (SUBS[p.type].indexOf(sub) < 0) throw new Error('区分が正しくありません: ' + sub);
  }

  // 棚卸モード中は止める（実施中は入出庫すべて、確認待ちは1品番ずつの棚卸だけ）
  const tk = getTk_();
  if (tk && (tk.status === '実施中' || p.type === '棚卸')) {
    const it = findItem_(p.id);
    notify_('⛔ 棚卸中のため登録できませんでした：' + (it ? it.hb : 'ID ' + p.id) + '　' +
      (sub && sub !== '通常' && sub !== 'その他' ? sub : p.type) + ' ' + qty + '（' + (p.staff || '') + '）');
    throw fail_(tk.status === '実施中'
      ? '棚卸中のため入出庫できません（棚卸の完了後に登録してください）'
      : '棚卸の確認待ちのため、1品番ずつの棚卸はできません');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss = SpreadsheetApp.openById(SS_ID);
    const m = ss.getSheetByName(SH_MASTER);

    const hit = m.getRange(2, COL.ID, m.getLastRow() - 1, 1)
      .createTextFinder(String(p.id)).matchEntireCell(true).findNext();
    if (!hit) throw new Error('製品ID ' + p.id + ' がマスタにありません');
    const row = hit.getRow();

    // A:J を1回で読む
    const r = m.getRange(row, 1, 1, COL.JUDGE).getValues()[0];
    const pid = r[COL.ID - 1], hb = r[COL.HB - 1];
    const init = r[COL.INIT - 1], cur = r[COL.STOCK - 1], target = r[COL.TARGET - 1];
    const before = cur === '' ? (Number(init) || 0) : Number(cur);
    const now = new Date();

    if (p.type === '棚卸') {
      const after = qty;
      m.getRange(row, COL.INIT).setValue(before);   // 変更前の在庫をG列へ
      m.getRange(row, COL.STOCK).setValue(after);
      m.getRange(row, COL.JUDGE).setValue(judge_(after, target));

      const inv = invSheet_(ss);
      inv.appendRow([
        'INV-' + String(inv.getLastRow()).padStart(4, '0'),
        now, pid, hb, before, after, after - before, p.staff || '', p.note || ''
      ]);
      updateCache_(p.id, after);
      return { id: String(p.id), stock: after };
    }

    const after = before + (p.type === '出庫' ? -qty : qty);
    m.getRange(row, COL.STOCK).setValue(after);
    m.getRange(row, COL.JUDGE).setValue(judge_(after, target));

    const log = ss.getSheetByName(SH_LOG);
    const recId = 'LOG-' + String(log.getLastRow()).padStart(3, '0');

    // 受発注の消し込み
    let res = { list: [], done: 0 }, kind = '';
    if (sub === '外注入荷') { kind = 'po'; res = consume_(ss, kind, pid, qty, recId, now); }
    if (sub === '受注出荷') { kind = 'ord'; res = consume_(ss, kind, pid, qty, recId, now); }

    log.appendRow([recId, now, pid, p.type, qty, p.staff || '', p.note || '', sub, fmtAlloc_(res.list)]);
    updateCache_(p.id, after, kind === 'ord' ? -res.done : 0, kind === 'po' ? -res.done : 0);

    // おかしなことはChatへ
    const who = '（' + (p.staff || '') + '・' + recId + '）';
    if (after < 0) notify_('⚠️ 在庫がマイナスになりました：' + hb + '　' + before + ' → ' + after + who);
    if (kind === 'ord' && qty > res.done) notify_('⚠️ 在庫から出す未出荷の受注を超えて出荷：' + hb + '　出荷 ' + qty +
      '、消し込み ' + res.done + who);
    if (kind === 'po' && qty > res.done) notify_('⚠️ 未入荷の発注を超えて入荷：' + hb + '　入荷 ' + qty +
      '、消し込み ' + res.done + who);
    return { id: String(p.id), stock: after, sub: sub, matched: res.done, extra: qty - res.done };
  } finally {
    lock.releaseLock();
  }
}

/* ================= 受発注の消し込み ================= */

/**
 * 消し込みの対象シートの設定（列番号は1始まり）
 *  ord: 受注明細  A納期 B製品ID D数量 F引当 G状態 J出荷済数 K出荷記録（2026-10-26 列変更）
 *       状態は 新規／未出荷／指示済み／出荷済（2026-10-27〜）。在庫引当の 新規・未出荷 を消し込む
 *  po : 外注指示  A指示日 C製品ID D数量 E入荷予定日 F入荷日 G状態 J入荷済数 K入荷記録
 */
const CONSUME = {
  ord: { sheet: SH_ORDER, width: 11, id: 2, qty: 4, done: 10, status: 7, rec: 11, sort: [1],
    open: r => r[5] === '在庫' && (r[6] === '未出荷' || r[6] === '新規'),
    after: (done, total) => ({ status: done >= total ? '出荷済' : '未出荷' }) },
  po: { sheet: SH_PO, width: 11, id: 3, qty: 4, done: 10, status: 7, rec: 11, sort: [5, 1], arrived: 6,
    open: r => r[6] !== '入荷済',
    after: (done, total) => ({ status: done >= total ? '入荷済' : (done > 0 ? '一部入荷' : '指示済') }) }
};

/** 古い順に qty だけ消し込み、{ list:[{row,n}], done } を返す */
function consume_(ss, kind, pid, qty, recId, now) {
  const c = CONSUME[kind];
  const sh = ss.getSheetByName(c.sheet);
  const last = sh.getLastRow();
  if (last < 2 || qty <= 0) return { list: [], done: 0 };
  const vals = sh.getRange(2, 1, last - 1, c.width).getValues();

  const rows = [];
  vals.forEach((r, i) => {
    if (String(r[c.id - 1]) !== String(pid) || !c.open(r)) return;
    const total = Number(r[c.qty - 1]) || 0, done = Number(r[c.done - 1]) || 0;
    if (total - done > 0) rows.push({ row: i + 2, r: r, total: total, done: done });
  });
  const key = x => c.sort.map(k => { const v = x.r[k - 1]; return v instanceof Date ? v.getTime() : (Number(v) || 9e15); });
  rows.sort((a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return a.row - b.row;
  });

  let left = qty;
  const list = [];
  for (const x of rows) {
    if (left <= 0) break;
    const n = Math.min(left, x.total - x.done);
    left -= n;
    list.push({ row: x.row, n: n });
    writeConsumed_(sh, c, x.row, x.done + n, x.total, x.r[c.rec - 1], recId, now);
  }
  return { list: list, done: qty - left };
}

/** 1行分の消し込み結果を書く（済数・状態・記録、外注は入荷日も） */
function writeConsumed_(sh, c, row, done, total, oldRec, recId, now) {
  const st = c.after(done, total).status;
  sh.getRange(row, c.done).setValue(done);
  sh.getRange(row, c.status).setValue(st);
  if (recId) {
    const recs = String(oldRec || '').split(',').filter(s => s);
    if (recs.indexOf(recId) < 0) recs.push(recId);
    sh.getRange(row, c.rec).setValue(recs.join(','));
  }
  if (c.arrived) sh.getRange(row, c.arrived).setValue(st === '入荷済' ? now : '');
}

/** 消し込んだ数を戻す（変更依頼で数量が減ったとき）。新しく消し込んだ行から戻す */
function release_(ss, kind, pid, list, n) {
  const c = CONSUME[kind];
  const sh = ss.getSheetByName(c.sheet);
  let left = n;
  const out = list.map(a => ({ row: a.row, n: a.n }));
  for (let i = out.length - 1; i >= 0 && left > 0; i--) {
    const a = out[i];
    const r = sh.getRange(a.row, 1, 1, c.width).getValues()[0];
    if (String(r[c.id - 1]) !== String(pid)) continue;   // 行がずれていたら触らない
    const total = Number(r[c.qty - 1]) || 0, done = Number(r[c.done - 1]) || 0;
    const back = Math.min(left, a.n, done);
    if (back <= 0) continue;
    left -= back;
    a.n -= back;
    writeConsumed_(sh, c, a.row, done - back, total, r[c.rec - 1], '', null);
  }
  return { list: out.filter(a => a.n > 0), back: n - left };
}

function fmtAlloc_(list) {
  return list.map(a => 'R' + a.row + ':' + a.n).join(',');
}

function parseAlloc_(s) {
  return String(s || '').split(',').map(t => {
    const m = /^R(\d+):(\d+)$/.exec(t.trim());
    return m ? { row: Number(m[1]), n: Number(m[2]) } : null;
  }).filter(a => a);
}

/** 区分から消し込み先の種類を返す */
function kindOf_(sub) {
  return sub === '外注入荷' ? 'po' : sub === '受注出荷' ? 'ord' : '';
}

/** 棚卸履歴シート（無ければ作成） */
function invSheet_(ss) {
  let sh = ss.getSheetByName(SH_INV);
  if (!sh) {
    sh = ss.insertSheet(SH_INV);
    sh.appendRow(['棚卸ID', '日時', '製品ID', '品番', '変更前在庫', '棚卸数量', '差異', '担当者', '備考']);
    sh.getRange('B:B').setNumberFormat('yyyy/MM/dd HH:mm');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** 製品ごとの最近の履歴（入出庫＋棚卸を新しい順に最大20件） */
function getHistory(id) {
  const ss = SpreadsheetApp.openById(SS_ID);
  const tz = Session.getScriptTimeZone();
  const fmt = d => d instanceof Date ? Utilities.formatDate(d, tz, 'MM/dd HH:mm') : String(d);
  const ts = d => d instanceof Date ? d.getTime() : 0;
  const pend = new Set(tail_(ss.getSheetByName(SH_REQ), 11, 500)
    .filter(r => r[10] === '未処理').map(r => String(r[2])));
  const out = [];

  tail_(ss.getSheetByName(SH_LOG), 8, 500).forEach(r => {
    if (String(r[2]) !== String(id)) return;
    const sub = String(r[7] || '');
    const label = sub === '外注入荷' ? '外注入荷' : sub === '受注出荷' ? '受注出荷' : r[3];
    out.push({ ts: ts(r[1]), rec: String(r[0]), d: fmt(r[1]), t: label, q: r[4], qr: r[4], s: r[5], n: r[6] });
  });
  tail_(ss.getSheetByName(SH_INV), 9, 300).forEach(r => {
    if (String(r[2]) !== String(id)) return;
    const diff = Number(r[6]) || 0;
    out.push({ ts: ts(r[1]), rec: String(r[0]), d: fmt(r[1]), t: '棚卸',
      q: r[5] + '（' + (diff > 0 ? '+' : '') + diff + '）', qr: r[5], s: r[7], n: r[8] });
  });

  return out.sort((a, b) => b.ts - a.ts).slice(0, 20).map(x => ({
    rec: x.rec, d: x.d, t: x.t, q: x.q, qr: x.qr, s: x.s, n: x.n, pend: pend.has(x.rec)
  }));
}

/* ================= 変更依頼 ================= */

function reqSheet_(ss) {
  let sh = ss.getSheetByName(SH_REQ);
  if (!sh) {
    sh = ss.insertSheet(SH_REQ);
    sh.appendRow(['依頼ID', '依頼日時', '対象ID', '製品ID', '品番', '区分', '元の数量', '修正後数量',
      '理由', '依頼者', '状態', '処理日時', '処理者', '反映後在庫']);
    sh.getRange('B:B').setNumberFormat('yyyy/MM/dd HH:mm');
    sh.getRange('L:L').setNumberFormat('yyyy/MM/dd HH:mm');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** A列でIDを探して行番号を返す（無ければ0） */
function findRow_(sh, id) {
  if (!sh || sh.getLastRow() < 2) return 0;
  const hit = sh.getRange(2, 1, sh.getLastRow() - 1, 1)
    .createTextFinder(String(id)).matchEntireCell(true).findNext();
  return hit ? hit.getRow() : 0;
}

/** 変更依頼を出す */
function createRequest(p) {
  const newQty = Math.trunc(Number(p.newQty));
  const reason = String(p.reason || '').trim();
  if (!p.recId || p.newQty === '' || isNaN(newQty)) throw new Error('正しい数量を入力してください');
  if (!reason) throw new Error('理由を入力してください');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss = SpreadsheetApp.openById(SS_ID);
    const isInv = String(p.recId).indexOf('INV-') === 0;
    const src = ss.getSheetByName(isInv ? SH_INV : SH_LOG);
    const row = findRow_(src, p.recId);
    if (!row) throw new Error('対象の記録 ' + p.recId + ' が見つかりません');

    let pid, hb, kind, oldQty;
    if (isInv) {
      const r = src.getRange(row, 1, 1, 9).getValues()[0];
      pid = r[2]; hb = r[3]; kind = '棚卸'; oldQty = Number(r[5]);
    } else {
      const r = src.getRange(row, 1, 1, 7).getValues()[0];
      pid = r[2]; kind = r[3]; oldQty = Number(r[4]);
      const it = JSON.parse(getBootJson_(false)).items.find(x => x.id === String(pid));
      hb = it ? it.hb : '';
    }
    if (kind !== '調整' && newQty < 0) throw new Error('数量は0以上で入力してください');
    if (newQty === oldQty) throw new Error('元の数量と同じです');

    const rq = reqSheet_(ss);
    const dup = tail_(rq, 11, 500).some(r => String(r[2]) === String(p.recId) && r[10] === '未処理');
    if (dup) throw new Error('この記録にはすでに未処理の依頼があります');

    const reqId = 'REQ-' + String(rq.getLastRow()).padStart(4, '0');
    rq.appendRow([reqId, new Date(), p.recId, pid, hb, kind, oldQty, newQty, reason, p.staff || '', '未処理', '', '', '']);
    notify_('✏️ 変更依頼 ' + reqId + '：' + hb + '　' + kind + ' ' + oldQty + ' → ' + newQty +
      '　理由：' + reason + '（' + (p.staff || '') + '）');
    return { reqId: reqId };
  } finally {
    lock.releaseLock();
  }
}

/** 未処理の依頼一覧 */
function listRequests() {
  const ss = SpreadsheetApp.openById(SS_ID);
  const tz = Session.getScriptTimeZone();
  return tail_(ss.getSheetByName(SH_REQ), 11, 1000)
    .filter(r => r[10] === '未処理')
    .map(r => ({
      reqId: r[0],
      d: r[1] instanceof Date ? Utilities.formatDate(r[1], tz, 'MM/dd HH:mm') : String(r[1]),
      recId: r[2], id: String(r[3]), hb: r[4], t: r[5], from: r[6], to: r[7], reason: r[8], by: r[9]
    }));
}

/** 依頼を承認・却下する（管理者PIN必須） */
function processRequest(p) {
  if (String(p.pin) !== ADMIN_PIN) throw new Error('管理者PINが違います');
  if (p.decision !== '承認' && p.decision !== '却下') throw new Error('承認か却下を選んでください');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss = SpreadsheetApp.openById(SS_ID);
    const rq = ss.getSheetByName(SH_REQ);
    const row = findRow_(rq, p.reqId);
    if (!row) throw new Error('依頼 ' + p.reqId + ' が見つかりません');
    const r = rq.getRange(row, 1, 1, 14).getValues()[0];
    if (r[10] !== '未処理') throw new Error('この依頼はすでに処理済みです');
    const now = new Date();

    if (p.decision === '却下') {
      rq.getRange(row, 11, 1, 3).setValues([['却下', now, p.staff || '']]);
      return { reqId: p.reqId };
    }

    const recId = String(r[2]), pid = r[3], kind = r[5];
    const from = Number(r[6]), to = Number(r[7]);
    const isInv = recId.indexOf('INV-') === 0;
    const mark = '［修正 ' + from + '→' + to + ' ' + p.reqId + '］';

    // 元の記録を書き換え（備考に修正の印を残す）
    const src = ss.getSheetByName(isInv ? SH_INV : SH_LOG);
    const srow = findRow_(src, recId);
    if (!srow) throw new Error('対象の記録 ' + recId + ' が見つかりません');
    const diff = to - from;
    let dOrd = 0, dPo = 0;
    if (isInv) {
      const before = Number(src.getRange(srow, 5).getValue()) || 0;
      src.getRange(srow, 6, 1, 2).setValues([[to, to - before]]);
      const nc = src.getRange(srow, 9); nc.setValue(String(nc.getValue()) + mark);
    } else {
      const lr = src.getRange(srow, 1, 1, 9).getValues()[0];
      src.getRange(srow, 5).setValue(to);
      const nc = src.getRange(srow, 7); nc.setValue(String(nc.getValue()) + mark);

      // 外注入荷・受注出荷は消し込みも差分だけ直す
      const ck = kindOf_(String(lr[7] || ''));
      if (ck) {
        let list = parseAlloc_(lr[8]);
        let moved = 0;
        if (diff > 0) {
          const add = consume_(ss, ck, pid, diff, recId, now);
          add.list.forEach(a => {
            const same = list.find(x => x.row === a.row);
            if (same) same.n += a.n; else list.push(a);
          });
          moved = -add.done;
        } else if (diff < 0) {
          const rel = release_(ss, ck, pid, list, -diff);
          list = rel.list;
          moved = rel.back;
        }
        src.getRange(srow, 9).setValue(fmtAlloc_(list));
        if (ck === 'ord') dOrd = moved; else dPo = moved;
      }
    }

    // 在庫を差分だけ動かす（その後の入出庫はそのまま活きる）
    const delta = kind === '出庫' ? -diff : diff;
    const m = ss.getSheetByName(SH_MASTER);
    const mrow = findRow_(m, pid);
    if (!mrow) throw new Error('製品ID ' + pid + ' がマスタにありません');
    const v = m.getRange(mrow, COL.INIT, 1, 3).getValues()[0];
    const cur = v[1] === '' ? (Number(v[0]) || 0) : Number(v[1]);
    const after = cur + delta;
    m.getRange(mrow, COL.STOCK).setValue(after);
    m.getRange(mrow, COL.JUDGE).setValue(judge_(after, v[2]));

    rq.getRange(row, 11, 1, 4).setValues([['承認', now, p.staff || '', after]]);
    updateCache_(pid, after, dOrd, dPo);
    return { reqId: p.reqId, id: String(pid), stock: after };
  } finally {
    lock.releaseLock();
  }
}

/* ================= 棚卸モード ================= */

function getTk_() {
  const s = PropertiesService.getScriptProperties().getProperty(PROP_TK);
  return s ? JSON.parse(s) : null;
}

function setTk_(tk) {
  const pr = PropertiesService.getScriptProperties();
  if (tk) pr.setProperty(PROP_TK, JSON.stringify(tk)); else pr.deleteProperty(PROP_TK);
}

function checkPin_(pin) {
  if (String(pin) !== ADMIN_PIN) throw new Error('管理者PINが違います');
}

function fmtTs_(ms) {
  return ms ? Utilities.formatDate(new Date(ms), Session.getScriptTimeZone(), 'MM/dd HH:mm') : '';
}

/** 起動データ（キャッシュ）から品番を引く */
function findItem_(id) {
  return JSON.parse(getBootJson_(false)).items.find(x => x.id === String(id)) || null;
}

function newSheet_(ss, name, head, dateCols) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(head);
    (dateCols || []).forEach(c => sh.getRange(c + ':' + c).setNumberFormat('yyyy/MM/dd HH:mm'));
    sh.setFrozenRows(1);
  }
  return sh;
}
const tkSheet_ = ss => newSheet_(ss, SH_TK, ['棚卸ID', '開始日時', '開始者', '完了日時', '完了者', '確定日時', '確認者',
  '状態', '品番数', '差異のある品番', '差異合計（絶対値）', 'メモ'], ['B', 'D', 'F']);
const tkRecSheet_ = ss => newSheet_(ss, SH_TKREC, ['記録ID', '棚卸ID', '日時', '製品ID', '品番', '置き場', '数量',
  '担当者', '状態', '取消日時'], ['C', 'J']);
const rptSheet_ = ss => newSheet_(ss, SH_RPT, ['報告ID', '日時', '担当者', '製品ID', '品番', '内容', '状態',
  '確認日時', '確認者'], ['B', 'H']);

/** 棚卸シートの行を書き換える（patch は {列番号: 値}） */
function tkSession_(ss, tkId, patch) {
  const sh = tkSheet_(ss);
  const row = findRow_(sh, tkId);
  if (!row) return;
  Object.keys(patch).forEach(c => sh.getRange(row, Number(c)).setValue(patch[c]));
}

/** 今の棚卸の有効な入力（取消を除く） */
function tkEntriesAll_(ss, tkId) {
  const sh = ss.getSheetByName(SH_TKREC);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 10).getValues()
    .map((r, i) => ({ row: i + 2, rec: String(r[0]), tk: String(r[1]), ts: r[2] instanceof Date ? r[2].getTime() : 0,
      pid: String(r[3]), hb: String(r[4]), loc: String(r[5]), qty: Number(r[6]) || 0, staff: String(r[7]), st: String(r[8]) }))
    .filter(x => x.tk === tkId && x.st === '有効');
}

/** 品番ごとの合計 { pid: { t: 合計, l: {置き場: 数}, last: 最後に数えた時刻, by: [担当者] } } */
function tkCounts_(entries) {
  const out = {};
  entries.forEach(x => {
    const c = out[x.pid] || (out[x.pid] = { t: 0, l: {}, last: 0, by: [] });
    c.t += x.qty;
    c.l[x.loc] = (c.l[x.loc] || 0) + x.qty;
    c.last = Math.max(c.last, x.ts);
    if (x.staff && c.by.indexOf(x.staff) < 0) c.by.push(x.staff);
  });
  return out;
}

/** 画面用の棚卸の状態（棚卸していなければ status は空） */
function tkView_() {
  const tk = getTk_();
  if (!tk) return { status: '', locs: LOCS };
  const counts = tkCounts_(tkEntriesAll_(SpreadsheetApp.openById(SS_ID), tk.id));
  const c = {};
  Object.keys(counts).forEach(k => c[k] = { t: counts[k].t, l: counts[k].l });
  return { id: tk.id, status: tk.status, start: fmtTs_(tk.start), startBy: tk.startBy,
    end: fmtTs_(tk.end), endBy: tk.endBy || '', locs: LOCS, counts: c };
}

/** 1品番の入力一覧（新しい順） */
function tkEntries_(id) {
  const tk = getTk_();
  if (!tk) return [];
  return tkEntriesAll_(SpreadsheetApp.openById(SS_ID), tk.id)
    .filter(x => x.pid === String(id))
    .sort((a, b) => b.ts - a.ts)
    .map(x => ({ rec: x.rec, d: fmtTs_(x.ts), loc: x.loc, qty: x.qty, staff: x.staff }));
}

/** 棚卸を始める */
function tkStart(p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (getTk_()) throw fail_('すでに棚卸中です');
    const ss = SpreadsheetApp.openById(SS_ID);
    const now = new Date();
    const id = 'TK-' + Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyyMMdd-HHmm');
    tkSheet_(ss).appendRow([id, now, p.staff || '', '', '', '', '', '実施中', '', '', '', '']);
    setTk_({ id: id, status: '実施中', start: now.getTime(), startBy: p.staff || '' });
    notify_('📋 棚卸を開始しました ' + id + '（' + (p.staff || '') + '）。完了するまで入出庫はできません');
    return tkView_();
  } finally {
    lock.releaseLock();
  }
}

/** 棚卸数を1件入れる（同じ品番は足し算） */
function tkCount(p) {
  const qty = Math.trunc(Number(p.qty));
  if (!p.id || p.qty === '' || isNaN(qty) || qty < 0) throw fail_('数量は0以上で入力してください');
  if (LOCS.indexOf(p.loc) < 0) throw fail_('置き場を選んでください');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const tk = getTk_();
    if (!tk || tk.status !== '実施中') throw fail_('棚卸は実施中ではありません（画面を更新してください）');
    const ss = SpreadsheetApp.openById(SS_ID);
    const m = ss.getSheetByName(SH_MASTER);
    const mrow = findRow_(m, p.id);
    if (!mrow) throw new Error('製品ID ' + p.id + ' がマスタにありません');
    const hb = m.getRange(mrow, COL.HB).getValue();
    const sh = tkRecSheet_(ss);
    const rec = 'TC-' + String(sh.getLastRow()).padStart(5, '0');
    sh.appendRow([rec, tk.id, new Date(), String(p.id), hb, p.loc, qty, p.staff || '', '有効', '']);
    const list = tkEntries_(p.id);
    return { id: String(p.id), total: list.reduce((s, x) => s + x.qty, 0), list: list };
  } finally {
    lock.releaseLock();
  }
}

/** 棚卸の入力を取り消す */
function tkCancel(p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const tk = getTk_();
    if (!tk || tk.status !== '実施中') throw fail_('棚卸は実施中ではありません（画面を更新してください）');
    const ss = SpreadsheetApp.openById(SS_ID);
    const sh = tkRecSheet_(ss);
    const row = findRow_(sh, p.rec);
    if (!row) throw new Error('記録 ' + p.rec + ' が見つかりません');
    const r = sh.getRange(row, 1, 1, 10).getValues()[0];
    if (String(r[1]) !== tk.id) throw fail_('今の棚卸の記録ではありません');
    sh.getRange(row, 9, 1, 2).setValues([['取消' + (p.staff ? '（' + p.staff + '）' : ''), new Date()]]);
    const list = tkEntries_(r[3]);
    return { id: String(r[3]), total: list.reduce((s, x) => s + x.qty, 0), list: list };
  } finally {
    lock.releaseLock();
  }
}

/** 棚卸を完了して確認待ちにする */
function tkFinish(p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const tk = getTk_();
    if (!tk || tk.status !== '実施中') throw fail_('棚卸は実施中ではありません（画面を更新してください）');
    const ss = SpreadsheetApp.openById(SS_ID);
    const counts = tkCounts_(tkEntriesAll_(ss, tk.id));
    const items = getMaster();
    // 数えていない品番は自動で0にしない（確定しても帳簿のまま）
    const now = new Date();
    const done = items.filter(it => counts[it.id]).length;
    const todoS = items.filter(it => it.stock > 0 && !counts[it.id]);
    tk.status = '確認待ち';
    tk.end = now.getTime();
    tk.endBy = p.staff || '';
    setTk_(tk);
    tkSession_(ss, tk.id, { 4: now, 5: p.staff || '', 8: '確認待ち', 9: items.length });
    notify_('✅ 棚卸が完了しました ' + tk.id + '（' + (p.staff || '') + '）。入出庫を再開できます。\n' +
      '棚卸した品番 ' + done + '／' + items.length +
      (todoS.length ? '\n⚠️ 在庫ありで未棚卸 ' + todoS.length + ' 品番（確定しても帳簿のまま）：' +
        todoS.slice(0, 10).map(it => it.hb + '(' + it.stock + ')').join('、') + (todoS.length > 10 ? ' ほか' : '') : '') +
      '\nバックオフィスで「確認・確定」してください');
    return tkView_();
  } finally {
    lock.releaseLock();
  }
}

/**
 * 確定したときの在庫を計算する
 * 確定後の在庫 ＝ 棚卸数 ＋ その品番を最後に数えた時刻より後の入出庫（入庫＋、出庫−、調整±）
 */
function tkCalc_(ss, tk) {
  const counts = tkCounts_(tkEntriesAll_(ss, tk.id));
  const m = ss.getSheetByName(SH_MASTER);
  const n = m.getLastRow() - 1;
  const mv = m.getRange(2, 1, n, COL.JUDGE).getValues();

  const post = {};
  tail_(ss.getSheetByName(SH_LOG), 5, 3000).forEach(r => {
    const ts = r[1] instanceof Date ? r[1].getTime() : 0;
    const pid = String(r[2]);
    const c = counts[pid];
    if (!c || ts <= c.last) return;
    const q = Number(r[4]) || 0;
    post[pid] = (post[pid] || 0) + (r[3] === '出庫' ? -q : q);
  });

  const rows = [];
  mv.forEach((r, i) => {
    const pid = String(r[0]);
    if (r[0] === '' || r[1] === '' || !counts[pid]) return;
    const now = r[COL.STOCK - 1] === '' ? (Number(r[COL.INIT - 1]) || 0) : Number(r[COL.STOCK - 1]);
    const ps = post[pid] || 0;
    const c = counts[pid];
    const book = now - ps;   // 数えた時点の帳簿
    rows.push({ i: i, id: pid, hb: String(r[1]), target: r[COL.TARGET - 1], now: now, book: book,
      cnt: c.t, l: c.l, by: c.by, post: ps, diff: c.t - book, after: c.t + ps });
  });
  return { m: m, n: n, mv: mv, rows: rows, counts: counts };
}

/** 受注明細の在庫引当（未出荷）が在庫で足りない行 */
function shortages_(ss, stockOf) {
  const sh = ss.getSheetByName(SH_ORDER);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const tz = Session.getScriptTimeZone();
  const by = {};
  sh.getRange(2, 1, last - 1, 10).getValues().forEach((r, i) => {
    if (r[1] === '' || r[6] !== '未出荷' || r[5] !== '在庫') return;
    const rem = (Number(r[3]) || 0) - (Number(r[9]) || 0);
    if (rem <= 0) return;
    (by[String(r[1])] = by[String(r[1])] || []).push({ row: i + 2, d: r[0], hb: String(r[2]), rem: rem });
  });
  const out = [];
  Object.keys(by).forEach(pid => {
    const stock = stockOf(pid);
    if (stock == null) return;
    let cum = 0;
    by[pid].sort((a, b) => ((a.d instanceof Date ? a.d.getTime() : 9e15) - (b.d instanceof Date ? b.d.getTime() : 9e15)) || a.row - b.row)
      .forEach(x => {
        cum += x.rem;
        if (cum > stock) out.push({ row: x.row, d: x.d instanceof Date ? Utilities.formatDate(x.d, tz, 'M/d') : String(x.d),
          hb: x.hb, qty: x.rem, lack: Math.min(x.rem, cum - stock) });
      });
  });
  return out.sort((a, b) => a.row - b.row);
}

/** バックオフィスの確認画面のデータ */
function tkReview(p) {
  checkPin_(p.pin);
  const tk = getTk_();
  if (!tk) return { status: '' };
  const ss = SpreadsheetApp.openById(SS_ID);
  const c = tkCalc_(ss, tk);
  const map = {};
  c.rows.forEach(x => map[x.id] = x.after);
  const diffs = c.rows.filter(x => x.diff !== 0 || x.post !== 0)
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))
    .map(x => ({ id: x.id, hb: x.hb, book: x.book, cnt: x.cnt, l: x.l, diff: x.diff, post: x.post, after: x.after }));
  return {
    id: tk.id, status: tk.status, start: fmtTs_(tk.start), startBy: tk.startBy, end: fmtTs_(tk.end), endBy: tk.endBy || '',
    n: c.rows.length, diffN: c.rows.filter(x => x.diff !== 0).length,
    plus: c.rows.reduce((s, x) => s + Math.max(0, x.diff), 0), minus: c.rows.reduce((s, x) => s + Math.min(0, x.diff), 0),
    todo: (() => { const out = []; c.mv.forEach(r => { const id = String(r[0]); if (r[0] === '' || c.counts[id]) return;
      const st = r[COL.STOCK - 1] === '' ? (Number(r[COL.INIT - 1]) || 0) : Number(r[COL.STOCK - 1]);
      if (st > 0) out.push({ hb: String(r[1]), stock: st }); }); return out; })(),
    diffs: diffs, short: tk.status === '確認待ち' ? shortages_(ss, pid => map[pid] == null ? null : map[pid]) : []
  };
}

/** 確定：製品マスタの在庫に反映し、棚卸履歴に残す */
function tkConfirm(p) {
  checkPin_(p.pin);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const tk = getTk_();
    if (!tk || tk.status !== '確認待ち') throw fail_('確認待ちの棚卸がありません（画面を更新してください）');
    const ss = SpreadsheetApp.openById(SS_ID);
    const c = tkCalc_(ss, tk);
    const now = new Date();

    // 棚卸履歴（品番ごとに1行）
    const inv = invSheet_(ss);
    const base = inv.getLastRow();
    if (c.rows.length) {
      inv.getRange(base + 1, 1, c.rows.length, 9).setValues(c.rows.map((x, k) => [
        'INV-' + String(base + k).padStart(4, '0'), now, x.id, x.hb, x.book, x.cnt, x.diff, x.by.join('・'),
        tk.id + ' ' + Object.keys(x.l).map(l => l + x.l[l]).join(' ') +
        (x.post ? '／確定前の入出庫 ' + (x.post > 0 ? '+' : '') + x.post + '→在庫 ' + x.after : '') +
        '／確認 ' + (p.staff || '')
      ]));
    }

    // 製品マスタ H列（現在在庫）・J列（判定）
    const H = c.mv.map(r => [r[COL.STOCK - 1]]);
    const J = c.mv.map(r => [r[COL.JUDGE - 1]]);
    c.rows.forEach(x => { H[x.i][0] = x.after; J[x.i][0] = judge_(x.after, x.target); });
    c.m.getRange(2, COL.STOCK, c.n, 1).setValues(H);
    c.m.getRange(2, COL.JUDGE, c.n, 1).setValues(J);

    const diffN = c.rows.filter(x => x.diff !== 0).length;
    const abs = c.rows.reduce((s, x) => s + Math.abs(x.diff), 0);
    tkSession_(ss, tk.id, { 6: now, 7: p.staff || '', 8: '確定', 10: diffN, 11: abs });
    setTk_(null);
    CacheService.getScriptCache().remove(CACHE_KEY);
    SpreadsheetApp.flush();

    const map = {};
    c.rows.forEach(x => map[x.id] = x.after);
    const short = shortages_(ss, pid => map[pid] == null ? null : map[pid]);
    let msg = '📦 棚卸を確定しました ' + tk.id + '（確認 ' + (p.staff || '') + '）\n' +
      '棚卸した品番 ' + c.rows.length + '（数えていない品番は帳簿のまま）、差異のある品番 ' + diffN + '、差異合計 ' + abs;
    const top = c.rows.filter(x => x.diff !== 0).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).slice(0, 10);
    if (top.length) msg += '\n差異の大きい品番：\n' + top.map(x => '・' + x.hb + '　' + x.book + ' → ' + x.cnt +
      '（' + (x.diff > 0 ? '+' : '') + x.diff + '）').join('\n');
    if (short.length) msg += '\n\n🔴 在庫引当の受注で在庫が足りなくなりました（生産の手配が必要）：\n' +
      short.slice(0, 15).map(s => '・納期 ' + s.d + '　' + s.hb + '　' + s.qty + '枚のうち ' + s.lack + ' 不足（受注明細 ' + s.row + '行目）').join('\n') +
      (short.length > 15 ? '\nほか ' + (short.length - 15) + ' 件' : '');
    notify_(msg);
    return { id: tk.id, n: c.rows.length, diffN: diffN, short: short };
  } finally {
    lock.releaseLock();
  }
}

/** 差し戻し：確認待ち → 実施中（完了時に自動で入れた0は取り消す） */
function tkReturn(p) {
  checkPin_(p.pin);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const tk = getTk_();
    if (!tk || tk.status !== '確認待ち') throw fail_('確認待ちの棚卸がありません（画面を更新してください）');
    const ss = SpreadsheetApp.openById(SS_ID);
    const sh = tkRecSheet_(ss);
    const now = new Date();
    tkEntriesAll_(ss, tk.id).filter(x => x.loc === TK_AUTO)
      .forEach(x => sh.getRange(x.row, 9, 1, 2).setValues([['取消（差し戻し）', now]]));
    tk.status = '実施中';
    tk.end = 0;
    tk.endBy = '';
    setTk_(tk);
    tkSession_(ss, tk.id, { 4: '', 5: '', 8: '実施中', 12: '差し戻し ' + fmtTs_(now.getTime()) + ' ' + (p.staff || '') +
      (p.reason ? '：' + p.reason : '') });
    notify_('↩️ 棚卸を差し戻しました ' + tk.id + '（' + (p.staff || '') + '）' + (p.reason ? '：' + p.reason : '') +
      '。もう一度棚卸中になり、入出庫は止まります');
    return tkView_();
  } finally {
    lock.releaseLock();
  }
}

/** 中止：誤って始めたときなど。在庫は変えずに棚卸モードを終わらせる（入力は「棚卸記録」に残す） */
function tkAbort(p) {
  checkPin_(p.pin);
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const tk = getTk_();
    if (!tk) throw fail_('棚卸は行われていません（画面を更新してください）');
    const ss = SpreadsheetApp.openById(SS_ID);
    const n = tkEntriesAll_(ss, tk.id).length;
    const now = new Date();
    setTk_(null);
    tkSession_(ss, tk.id, { 6: now, 7: p.staff || '', 8: '中止', 12: '中止 ' + fmtTs_(now.getTime()) + ' ' + (p.staff || '') +
      (p.reason ? '：' + p.reason : '') + '（入力 ' + n + ' 件は反映せず）' });
    notify_('🛑 棚卸を中止しました ' + tk.id + '（' + (p.staff || '') + '）' + (p.reason ? '：' + p.reason : '') +
      '。在庫は変えていません。入出庫を再開できます');
    return tkView_();
  } finally {
    lock.releaseLock();
  }
}

/* ================= 報告 ================= */

function createReport(p) {
  const text = String(p.text || '').trim().slice(0, 1000);
  if (!text) throw fail_('報告の内容を入力してください');
  const ss = SpreadsheetApp.openById(SS_ID);
  const sh = rptSheet_(ss);
  const it = p.id ? findItem_(p.id) : null;
  const id = 'RPT-' + String(sh.getLastRow()).padStart(4, '0');
  sh.appendRow([id, new Date(), p.staff || '', it ? it.id : '', it ? it.hb : '', text, '未確認', '', '']);
  notify_('📝 報告 ' + id + '（' + (p.staff || '') + '）' + (it ? '　品番 ' + it.hb : '') + '\n' + text);
  return { rptId: id };
}

/** 報告の一覧（未確認すべて＋確認済みの新しい10件） */
function listReports(p) {
  checkPin_(p.pin);
  const tz = Session.getScriptTimeZone();
  const rows = tail_(SpreadsheetApp.openById(SS_ID).getSheetByName(SH_RPT), 9, 500).reverse();
  const map = r => ({ rptId: r[0], d: r[1] instanceof Date ? Utilities.formatDate(r[1], tz, 'MM/dd HH:mm') : String(r[1]),
    by: r[2], hb: r[4], text: r[5], st: r[6] });
  return rows.filter(r => r[6] === '未確認').map(map).concat(rows.filter(r => r[6] !== '未確認').slice(0, 10).map(map));
}

function reportDone(p) {
  checkPin_(p.pin);
  const sh = SpreadsheetApp.openById(SS_ID).getSheetByName(SH_RPT);
  const row = findRow_(sh, p.rptId);
  if (!row) throw new Error('報告 ' + p.rptId + ' が見つかりません');
  sh.getRange(row, 7, 1, 3).setValues([['確認済', new Date(), p.staff || '']]);
  return { rptId: p.rptId };
}

/** ヘッダーの件数（未処理の変更依頼・未確認の報告・棚卸の状態） */
function inbox_() {
  const ss = SpreadsheetApp.openById(SS_ID);
  const tk = getTk_();
  return {
    requests: tail_(ss.getSheetByName(SH_REQ), 11, 1000).filter(r => r[10] === '未処理').length,
    reports: tail_(ss.getSheetByName(SH_RPT), 9, 500).filter(r => r[6] === '未確認').length,
    tk: tk ? tk.status : ''
  };
}


/* ================= 出荷リスト・QR出荷（2026-11-05〜） ================= */

const SHIP_OPEN = ['新規', '未出荷'];   // 出荷できる状態

/** 受注明細を読み、1行ずつの形にする（A納期 B製品ID C品番 D数量 E在庫数 F引当 G状態 H登録日 I備考 J出荷済数 K出荷記録） */
function shipRows_(ss) {
  const sh = ss.getSheetByName(SH_ORDER);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const tz = Session.getScriptTimeZone();
  return sh.getRange(2, 1, last - 1, 11).getValues().map((r, i) => {
    const d = r[0] instanceof Date ? r[0] : null;
    const qty = Number(r[3]) || 0, done = Number(r[9]) || 0;
    return {
      row: i + 2,
      k: d && r[1] !== '' ? Utilities.formatDate(d, tz, 'yyyyMMdd') + '-' + String(r[1]) : '',
      ts: d ? d.getTime() : 9e15,
      nouki: d ? Utilities.formatDate(d, tz, 'M/d') : String(r[0]),
      id: String(r[1]), hb: String(r[2]), qty: qty, done: done, rem: qty - done,
      hk: String(r[5]), st: String(r[6]), note: String(r[8]), rec: String(r[10])
    };
  });
}

/** 製品マスタの現在在庫（H列。空なら初期在庫G列） */
function stockOf_(ss, pid) {
  const m = ss.getSheetByName(SH_MASTER);
  const row = findRow_(m, pid);
  if (!row) return null;
  const v = m.getRange(row, COL.INIT, 1, 2).getValues()[0];
  return v[1] === '' ? (Number(v[0]) || 0) : Number(v[1]);
}

/** 出荷リスト（在庫から出す、未出荷の受注） */
function shipList() {
  const ss = SpreadsheetApp.openById(SS_ID);
  const items = JSON.parse(getBootJson_(false)).items;
  const stock = {};
  items.forEach(it => stock[it.id] = it.stock);
  return shipRows_(ss)
    .filter(x => x.k && x.hk === '在庫' && SHIP_OPEN.indexOf(x.st) >= 0 && x.rem > 0)
    .sort((a, b) => a.ts - b.ts || a.row - b.row)
    .map(x => ({ k: x.k, row: x.row, nouki: x.nouki, id: x.id, hb: x.hb, qty: x.qty, done: x.done, rem: x.rem,
      st: x.st, stock: stock[x.id] == null ? null : stock[x.id] }));
}

/** QRのキーに当たる行を探す（同じキーが複数あれば、残りのある最初の行） */
function shipFind_(rows, k, row) {
  const hits = rows.filter(x => x.k === String(k || ''));
  if (!hits.length) return null;
  if (row) {
    const same = hits.find(x => x.row === Number(row));
    if (same) return same;
  }
  return hits.find(x => x.rem > 0 && x.st !== '出荷済') || hits[0];
}

/** QRを読んだときの表示用 */
function shipInfo(k) {
  const ss = SpreadsheetApp.openById(SS_ID);
  const x = shipFind_(shipRows_(ss), k);
  if (!x) throw fail_('この出荷QRの受注が見つかりません（' + k + '）。受注明細から消えたか、納期・品番が変わった可能性があります');

  // これまでの出荷（入出庫履歴のうち、この行を消し込んだもの）
  const recs = x.rec.split(',').map(s => s.trim()).filter(s => s);
  const tz = Session.getScriptTimeZone();
  const hist = [];
  if (recs.length) {
    tail_(ss.getSheetByName(SH_LOG), 9, 3000).forEach(r => {
      if (recs.indexOf(String(r[0])) < 0) return;
      const a = parseAlloc_(r[8]).find(a => a.row === x.row);
      if (!a) return;
      hist.push({ rec: String(r[0]), d: r[1] instanceof Date ? Utilities.formatDate(r[1], tz, 'M/d HH:mm') : String(r[1]),
        n: a.n, s: String(r[5] || '') });
    });
  }
  return {
    k: x.k, row: x.row, nouki: x.nouki, id: x.id, hb: x.hb, qty: x.qty, done: x.done, rem: Math.max(0, x.rem),
    st: x.st, hk: x.hk, stock: stockOf_(ss, x.id),
    shipped: x.st === '出荷済' || x.rem <= 0,
    open: SHIP_OPEN.indexOf(x.st) >= 0 && x.rem > 0,
    hist: hist
  };
}

/** QRの受注を出庫する */
function ship(p) {
  const qty = Math.trunc(Number(p.qty));
  if (!p.k || isNaN(qty) || qty < 1) throw fail_('出庫する数を1以上で入力してください');

  const tk = getTk_();
  if (tk && tk.status === '実施中') {
    notify_('⛔ 棚卸中のため出荷できませんでした：QR ' + p.k + '　' + qty + '（' + (p.staff || '') + '）');
    throw fail_('棚卸中のため出庫できません（棚卸の完了後に登録してください）');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss = SpreadsheetApp.openById(SS_ID);
    const x = shipFind_(shipRows_(ss), p.k, p.row);
    if (!x) throw fail_('この出荷QRの受注が見つかりません（' + p.k + '）');
    if (x.st === '出荷済' || x.rem <= 0) throw fail_('この受注は出荷済みです（' + x.hb + '　納期 ' + x.nouki + '）');
    if (SHIP_OPEN.indexOf(x.st) < 0) throw fail_('この受注は状態が「' + x.st + '」のため出庫できません');
    if (qty > x.rem) throw fail_('残り ' + x.rem + ' を超えています（入力 ' + qty + '）');

    // 製品マスタの在庫を減らす
    const m = ss.getSheetByName(SH_MASTER);
    const mrow = findRow_(m, x.id);
    if (!mrow) throw new Error('製品ID ' + x.id + ' がマスタにありません');
    const v = m.getRange(mrow, COL.INIT, 1, 4).getValues()[0];   // G初期 H現在 I適正 J判定
    const before = v[1] === '' ? (Number(v[0]) || 0) : Number(v[1]);
    const after = before - qty;
    m.getRange(mrow, COL.STOCK).setValue(after);
    m.getRange(mrow, COL.JUDGE).setValue(judge_(after, v[2]));

    // 入出庫履歴（受注出荷。消し込んだのはこの行だけ）
    const now = new Date();
    const log = ss.getSheetByName(SH_LOG);
    const recId = 'LOG-' + String(log.getLastRow()).padStart(3, '0');
    const note = 'QR出荷 納期' + x.nouki + (p.note ? ' ' + String(p.note).trim() : '');
    log.appendRow([recId, now, x.id, '出庫', qty, p.staff || '', note, '受注出荷', fmtAlloc_([{ row: x.row, n: qty }])]);

    // 受注明細（出荷済数・状態・出荷記録）
    const done = x.done + qty;
    writeConsumed_(ss.getSheetByName(SH_ORDER), CONSUME.ord, x.row, done, x.qty, x.rec, recId, now);
    updateCache_(x.id, after, -qty, 0);

    const who = '（' + (p.staff || '') + '・' + recId + '）';
    if (after < 0) notify_('⚠️ 在庫がマイナスになりました：' + x.hb + '　' + before + ' → ' + after + who);
    if (x.hk !== '在庫') notify_('⚠️ 引当「' + x.hk + '」の受注をQRで出荷：' + x.hb + '　納期 ' + x.nouki + '　' + qty + who);

    return { k: x.k, row: x.row, id: x.id, hb: x.hb, stock: after, qty: x.qty, done: done,
      rem: x.qty - done, st: done >= x.qty ? '出荷済' : '未出荷', rec: recId };
  } finally {
    lock.releaseLock();
  }
}

/**
 * まとめて出荷（2026-11-11〜）
 * p.items = [{ k: 'yyyyMMdd-製品ID', row: 受注明細の行, qty: 出庫数 }, ...]
 * 先に全部を確かめ、1件でもだめなら何も書かずにエラーを返す（一部だけ出庫されることはない）
 */
function shipBatch(p) {
  const list = Array.isArray(p.items) ? p.items : [];
  if (!list.length) throw fail_('出荷する受注を選んでください');
  if (list.length > 200) throw fail_('一度に出荷できるのは200件までです');

  const tk = getTk_();
  if (tk && tk.status === '実施中') {
    notify_('⛔ 棚卸中のためまとめて出荷できませんでした：' + list.length + '件（' + (p.staff || '') + '）');
    throw fail_('棚卸中のため出庫できません（棚卸の完了後に登録してください）');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const ss = SpreadsheetApp.openById(SS_ID);
    const rows = shipRows_(ss);
    const byRow = {};
    rows.forEach(x => byRow[x.row] = x);

    // 1) 全部を確かめる
    const errs = [], todo = [], seen = {};
    list.forEach(it => {
      const qty = Math.trunc(Number(it.qty));
      const x = byRow[Number(it.row)];
      const name = x ? x.hb + '（納期 ' + x.nouki + '）' : String(it.k);
      if (!x || x.k !== String(it.k || '')) { errs.push(name + '：受注明細の行が変わっています。更新してください'); return; }
      if (seen[x.row]) { errs.push(name + '：同じ受注が2回選ばれています'); return; }
      seen[x.row] = 1;
      if (isNaN(qty) || qty < 1) { errs.push(name + '：出庫する数を1以上にしてください'); return; }
      if (x.st === '出荷済' || x.rem <= 0) { errs.push(name + '：すでに出荷済みです'); return; }
      if (SHIP_OPEN.indexOf(x.st) < 0) { errs.push(name + '：状態が「' + x.st + '」のため出庫できません'); return; }
      if (qty > x.rem) { errs.push(name + '：残り ' + x.rem + ' を超えています（' + qty + '）'); return; }
      todo.push({ x: x, qty: qty });
    });
    if (errs.length) throw fail_('出庫しませんでした（' + errs.length + '件に問題があります）\n' +
      errs.slice(0, 10).join('\n') + (errs.length > 10 ? '\nほか ' + (errs.length - 10) + '件' : ''));

    // 2) 製品マスタ（1回で読む）
    const m = ss.getSheetByName(SH_MASTER);
    const mv = m.getRange(2, 1, m.getLastRow() - 1, COL.JUDGE).getValues();
    const mi = {};
    mv.forEach((r, i) => { if (r[0] !== '') mi[String(r[0])] = i; });
    const stock = {}, before = {}, hb = {};
    todo.forEach(t => {
      const i = mi[t.x.id];
      if (i == null) throw new Error('製品ID ' + t.x.id + ' がマスタにありません（' + t.x.hb + '）');
      if (stock[t.x.id] == null) {
        const r = mv[i];
        stock[t.x.id] = before[t.x.id] = r[COL.STOCK - 1] === '' ? (Number(r[COL.INIT - 1]) || 0) : Number(r[COL.STOCK - 1]);
        hb[t.x.id] = t.x.hb;
      }
      stock[t.x.id] -= t.qty;
    });

    // 3) 入出庫履歴（受注1行につき1行をまとめて書く）
    const now = new Date();
    const log = ss.getSheetByName(SH_LOG);
    const base = log.getLastRow();
    const extra = p.note ? ' ' + String(p.note).trim() : '';
    todo.forEach((t, j) => t.rec = 'LOG-' + String(base + j).padStart(3, '0'));
    log.getRange(base + 1, 1, todo.length, 9).setValues(todo.map(t => [
      t.rec, now, t.x.id, '出庫', t.qty, p.staff || '', 'まとめて出荷 納期' + t.x.nouki + extra, '受注出荷',
      fmtAlloc_([{ row: t.x.row, n: t.qty }])
    ]));

    // 4) 製品マスタの在庫・判定
    Object.keys(stock).forEach(id => {
      const i = mi[id], row = i + 2;
      m.getRange(row, COL.STOCK).setValue(stock[id]);
      m.getRange(row, COL.JUDGE).setValue(judge_(stock[id], mv[i][COL.TARGET - 1]));
    });

    // 5) 受注明細（出荷済数・状態・出荷記録）
    const osh = ss.getSheetByName(SH_ORDER);
    todo.forEach(t => {
      t.done = t.x.done + t.qty;
      writeConsumed_(osh, CONSUME.ord, t.x.row, t.done, t.x.qty, t.x.rec, t.rec, now);
    });

    // 6) キャッシュ（在庫・受注残）
    const dOrd = {};
    todo.forEach(t => dOrd[t.x.id] = (dOrd[t.x.id] || 0) + t.qty);
    Object.keys(stock).forEach(id => updateCache_(id, stock[id], -dOrd[id], 0));
    SpreadsheetApp.flush();

    // 7) 通知
    const total = todo.reduce((s, t) => s + t.qty, 0);
    const days = [...new Set(todo.map(t => t.x.nouki))].join('・');
    let msg = '🚚 まとめて出荷：納期 ' + days + '　' + todo.length + '件・計 ' + total + '枚（' + (p.staff || '') + '）';
    const neg = Object.keys(stock).filter(id => stock[id] < 0);
    if (neg.length) msg += '\n⚠️ 在庫がマイナスになった品番：' + neg.map(id => hb[id] + ' ' + before[id] + '→' + stock[id]).join('、');
    const part = todo.filter(t => t.done < t.x.qty);
    if (part.length) msg += '\n分納（残りあり）：' + part.map(t => t.x.hb + ' 残り' + (t.x.qty - t.done)).join('、');
    notify_(msg);

    return {
      n: todo.length, total: total, stocks: stock,
      results: todo.map(t => ({ k: t.x.k, row: t.x.row, id: t.x.id, hb: t.x.hb, qty: t.qty, done: t.done,
        rem: t.x.qty - t.done, st: t.done >= t.x.qty ? '出荷済' : '未出荷', rec: t.rec }))
    };
  } finally {
    lock.releaseLock();
  }
}

/* ================= Google Chat 通知 ================= */

function notify_(text) {
  const url = chatWebhook_();
  if (!url) return;
  try {
    UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json; charset=UTF-8',
      payload: JSON.stringify({ text: '【LIXIL在庫】' + text }), muteHttpExceptions: true
    });
  } catch (e) {
    console.error('Chat通知に失敗: ' + e.message);
  }
}

/** 動作確認用：エディタから実行してChatに届くか見る */
function testNotify() {
  notify_('通知のテストです');
}

/**
 * 受注明細に「在庫不足」列（L列）を作り、不足の行を赤くする（2026-10-30 本番に設定済み。消えたときの作り直し用）
 *  - LAMBDA の引数に R・C など1文字の名前を使うと #N/A になるので長い名前にしている
 *  - 状態「未出荷」・引当「在庫」の行を、同じ品番で納期の早い順に足していき、現在在庫を超えたら「不足 n」
 */
function setupShortageColumn() {
  const ss = SpreadsheetApp.openById(SS_ID);
  const sh = ss.getSheetByName(SH_ORDER);
  if (sh.getMaxColumns() < 12) sh.insertColumnsAfter(sh.getMaxColumns(), 12 - sh.getMaxColumns());
  sh.getRange('L1').setFormula(
    '=VSTACK("在庫不足",LET(id,B2:B,st,G2:G,hk,F2:F,nk,A2:A,rem,ARRAYFORMULA(IFERROR(D2:D*1,0)-IFERROR(J2:J*1,0)),' +
    'rw,ARRAYFORMULA(ROW(A2:A)),okk,ARRAYFORMULA((id<>"")*(st="未出荷")*(hk="在庫")),' +
    'MAP(id,st,hk,nk,rem,rw,LAMBDA(pid,sts,hik,nki,rmn,rno,IF(OR(pid="",sts<>"未出荷",hik<>"在庫"),"",' +
    'LET(zk,N(XLOOKUP(pid,\'製品マスタ\'!$A$2:$A$175,\'製品マスタ\'!$H$2:$H$175,0)),' +
    'cum,SUMPRODUCT(okk,--(id=pid),(nk<nki)+(nk=nki)*(rw<=rno),rem),' +
    'IF(cum>zk,"不足 "&MIN(rmn,cum-zk),"")))))))');
  sh.getRange('L1').setFontWeight('bold');
  const rule = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=LEFT($L2,2)="不足"')
    .setBackground('#F6C9C1').setFontColor('#9C1C0C').setBold(true)
    .setRanges([sh.getRange('A2:L')]).build();
  const rules = sh.getConditionalFormatRules().filter(r =>
    !r.getBooleanCondition() || String(r.getBooleanCondition().getCriteriaValues()[0]).indexOf('$L2') < 0);
  rules.unshift(rule);
  sh.setConditionalFormatRules(rules);
}

/** シートの末尾 n 行を取得 */
function tail_(sh, cols, n) {
  if (!sh) return [];
  const last = sh.getLastRow();
  if (last < 2) return [];
  const k = Math.min(n, last - 1);
  return sh.getRange(last - k + 1, 1, k, cols).getValues();
}

function judge_(stock, target) {
  if (target === '' || target === null) return stock <= 0 ? '欠品' : '';
  if (stock <= 0) return '欠品';
  return stock < Number(target) ? '不足' : '適正';
}

/**
 * 運用開始前に1回だけ手動実行（棚卸を始めた後は実行しないこと）：
 * 現在在庫数（H列）＝ 初期在庫 ＋ 履歴の合計 で埋め、判定（J列）も更新する
 */
function setup() {
  const ss = SpreadsheetApp.openById(SS_ID);
  const m = ss.getSheetByName(SH_MASTER);
  const log = ss.getSheetByName(SH_LOG);

  log.getRange('B:B').setNumberFormat('yyyy/MM/dd HH:mm');

  const sum = {};
  if (log.getLastRow() > 1) {
    log.getRange(2, 1, log.getLastRow() - 1, 5).getValues().forEach(r => {
      const q = Number(r[4]) || 0;
      const d = r[3] === '出庫' ? -q : q;
      const id = String(r[2]);
      sum[id] = (sum[id] || 0) + d;
    });
  }

  const n = m.getLastRow() - 1;
  const vals = m.getRange(2, 1, n, COL.TARGET).getValues();
  const ids = new Set(vals.map(r => String(r[0])));
  const stock = vals.map(r => [(Number(r[6]) || 0) + (sum[String(r[0])] || 0)]);
  const judge = vals.map((r, i) => [judge_(stock[i][0], r[8])]);

  m.getRange(2, COL.STOCK, n, 1).setValues(stock);
  m.getRange(2, COL.JUDGE, n, 1).setValues(judge);

  CacheService.getScriptCache().remove(CACHE_KEY);

  const orphan = Object.keys(sum).filter(id => !ids.has(id));
  if (orphan.length) Logger.log('マスタに無い製品IDの履歴: ' + orphan.join(', '));
}
