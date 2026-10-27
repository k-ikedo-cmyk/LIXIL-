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
const ADMIN_PIN = '0000';    // 承認用の管理者PIN（必ず変更する）
const STAFF = ['池戸', '山田', '佐藤']; // 担当者リスト（ここを編集）

// 製品マスタの列番号（1始まり）
const COL = { ID: 1, HB: 2, CAT: 3, W: 4, H: 5, PRICE: 6, INIT: 7, STOCK: 8, TARGET: 9, JUDGE: 10,
  ORD: 14, PO: 15 };

// 入出庫の区分
const SUBS = { '入庫': ['通常', '外注入荷'], '出庫': ['受注出荷', 'その他'] };
const SUB_DEFAULT = { '入庫': '通常', '出庫': 'その他' };

// 簡易キー（index.html の API_KEY と同じ文字列にする）
const API_KEY = 'yasumoku-zaiko';

/** 読み込み：?action=boot | history&id=○ */
function doGet(e) {
  try {
    const p = e.parameter || {};
    checkKey_(p.key);
    const action = p.action || 'boot';
    if (action === 'boot') return raw_('{"ok":true,"data":' + getBootJson_(p.fresh === '1') + '}');
    if (action === 'history') return json_({ ok: true, data: getHistory(p.id) });
    if (action === 'requests') return json_({ ok: true, data: listRequests() });
    throw new Error('不明な操作です: ' + action);
  } catch (err) {
    return json_({ ok: false, error: err.message });
  }
}

/** 書き込み：入庫・出庫・調整 */
function doPost(e) {
  try {
    const p = JSON.parse(e.postData.contents);
    checkKey_(p.key);
    const action = p.action || 'register';
    if (action === 'register') return json_({ ok: true, data: register(p) });
    if (action === 'request') return json_({ ok: true, data: createRequest(p) });
    if (action === 'approve') return json_({ ok: true, data: processRequest(p) });
    throw new Error('不明な操作です: ' + action);
  } catch (err) {
    return json_({ ok: false, error: err.message });
  }
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
