/**
 * 주식 차트분석 앱 — 알림 메일 릴레이 (Google Apps Script)
 *
 * 배경: Cloudflare Workers 에는 메일 발송 기능이 없고 MailChannels 무료 연동도 종료되었다(명세 §7).
 *       이미 운영 중인 Apps Script 메일 파이프라인을 재사용한다.
 *
 * 흐름
 *   1. Worker 가 알림 발생 시 mail_queue 에 status='PENDING' 으로 INSERT
 *   2. 이 스크립트가 5분 간격 트리거로 GET /internal/mail/pending 호출
 *   3. MailApp.sendEmail() 로 발송
 *   4. POST /internal/mail/:id/sent 호출 → status='SENT'
 *      실패 시 최대 3회 재시도 후 POST /internal/mail/:id/failed → status='FAILED' + 관리자 통지
 *
 * ── 설치 절차 ─────────────────────────────────────────────────────────
 *  1) script.google.com 에서 새 프로젝트 생성 후 이 파일 내용을 붙여넣는다.
 *  2) 프로젝트 설정 → 스크립트 속성에 다음을 등록한다.
 *       WORKER_BASE_URL : https://kr-stock-worker.<계정>.workers.dev
 *       RELAY_TOKEN     : wrangler secret put RELAY_TOKEN 으로 넣은 값과 동일
 *       ADMIN_EMAIL     : 실패 통지를 받을 주소
 *  3) setupTrigger() 를 1회 실행해 5분 트리거를 생성한다.
 *  4) relayPendingMails() 를 수동 1회 실행해 권한 승인(MailApp, UrlFetchApp)을 마친다.
 *
 *  주의: /internal/* 는 Cloudflare Access 정책에서 **제외**해야 한다(§6).
 *        제외하지 않으면 Apps Script 요청이 Access 로그인 페이지로 리다이렉트된다.
 */

var MAX_ATTEMPTS = 3;
var BATCH_SIZE = 10;
var RETRY_BACKOFF_MS = [1000, 3000, 8000];

function props_() {
  return PropertiesService.getScriptProperties();
}

function cfg_(key, required) {
  var v = props_().getProperty(key);
  if (required && !v) throw new Error('스크립트 속성 ' + key + ' 가 설정되지 않았습니다.');
  return v;
}

function authHeaders_() {
  return { Authorization: 'Bearer ' + cfg_('RELAY_TOKEN', true) };
}

/** 5분 간격 트리거 생성 (중복 생성 방지) */
function setupTrigger() {
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'relayPendingMails') {
      Logger.log('이미 트리거가 존재합니다. 새로 만들지 않습니다.');
      return;
    }
  }
  ScriptApp.newTrigger('relayPendingMails').timeBased().everyMinutes(5).create();
  Logger.log('5분 간격 트리거를 생성했습니다.');
}

function removeTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'relayPendingMails') ScriptApp.deleteTrigger(triggers[i]);
  }
  Logger.log('트리거를 제거했습니다.');
}

/** 메인 — 5분마다 실행된다. */
function relayPendingMails() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    Logger.log('이전 실행이 아직 진행 중입니다. 이번 회차를 건너뜁니다.');
    return;
  }
  try {
    var items = fetchPending_();
    if (!items.length) return;
    Logger.log('대기 메일 ' + items.length + '건');

    for (var i = 0; i < items.length; i++) {
      var mail = items[i];
      var ok = false;
      var lastError = '';

      for (var attempt = 1; attempt <= MAX_ATTEMPTS && !ok; attempt++) {
        try {
          MailApp.sendEmail({
            to: mail.to_addr,
            subject: mail.subject,
            htmlBody: mail.html_body,
            name: '주식 차트분석 알림'
          });
          ok = true;
        } catch (e) {
          lastError = String(e);
          Logger.log('발송 실패 (' + mail.mail_id + ', ' + attempt + '/' + MAX_ATTEMPTS + '): ' + lastError);
          if (attempt < MAX_ATTEMPTS) Utilities.sleep(RETRY_BACKOFF_MS[attempt - 1] || 5000);
        }
      }

      if (ok) markSent_(mail.mail_id);
      else {
        markFailed_(mail.mail_id, lastError);
        notifyAdmin_(mail, lastError);
      }
    }
  } finally {
    lock.releaseLock();
  }
}

function fetchPending_() {
  var url = cfg_('WORKER_BASE_URL', true) + '/internal/mail/pending?limit=' + BATCH_SIZE;
  var res = UrlFetchApp.fetch(url, { headers: authHeaders_(), muteHttpExceptions: true });
  var code = res.getResponseCode();
  if (code !== 200) {
    Logger.log('대기 목록 조회 실패 HTTP ' + code + ': ' + res.getContentText().slice(0, 300));
    return [];
  }
  var body = JSON.parse(res.getContentText());
  if (!body.ok) {
    Logger.log('대기 목록 응답 오류: ' + JSON.stringify(body.error));
    return [];
  }
  return body.data.items || [];
}

function markSent_(mailId) {
  post_('/internal/mail/' + encodeURIComponent(mailId) + '/sent', {});
}

function markFailed_(mailId, reason) {
  post_('/internal/mail/' + encodeURIComponent(mailId) + '/failed', { reason: String(reason).slice(0, 300) });
}

function post_(path, payload) {
  var url = cfg_('WORKER_BASE_URL', true) + path;
  var headers = authHeaders_();
  headers['Content-Type'] = 'application/json';
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: headers,
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    Logger.log('상태 갱신 실패 ' + path + ' HTTP ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  }
}

/** 3회 재시도 후에도 실패하면 관리자에게 통지한다. */
function notifyAdmin_(mail, lastError) {
  var admin = cfg_('ADMIN_EMAIL', false);
  if (!admin) {
    Logger.log('ADMIN_EMAIL 이 없어 실패 통지를 건너뜁니다: ' + mail.mail_id);
    return;
  }
  try {
    MailApp.sendEmail({
      to: admin,
      subject: '[주식앱] 알림 메일 발송 실패 (' + mail.mail_id + ')',
      htmlBody:
        '<h3>알림 메일 발송이 ' + MAX_ATTEMPTS + '회 모두 실패했습니다.</h3>' +
        '<table border="1" cellpadding="6" cellspacing="0">' +
        '<tr><th align="left">mail_id</th><td>' + escapeHtml_(mail.mail_id) + '</td></tr>' +
        '<tr><th align="left">수신자</th><td>' + escapeHtml_(mail.to_addr) + '</td></tr>' +
        '<tr><th align="left">제목</th><td>' + escapeHtml_(mail.subject) + '</td></tr>' +
        '<tr><th align="left">마지막 오류</th><td><pre>' + escapeHtml_(String(lastError).slice(0, 500)) + '</pre></td></tr>' +
        '</table>' +
        '<p>해당 레코드는 status=FAILED 로 표시되었습니다. 원인 제거 후 D1 에서 PENDING 으로 되돌리면 재발송됩니다.</p>',
      name: '주식 차트분석 알림'
    });
  } catch (e) {
    Logger.log('관리자 통지 실패: ' + e);
  }
}

function escapeHtml_(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 설치 점검용 — 연결과 인증만 확인한다(메일은 보내지 않는다). */
function testConnection() {
  var items = fetchPending_();
  Logger.log('연결 성공. 대기 메일 ' + items.length + '건');
}
