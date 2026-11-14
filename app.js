/*
 * app.js — 화면 부분. 파일을 읽고, 처방을 보여 주고, 결과와 내려받기를 맡는다.
 * 계산은 clean.js 가 한다. 파일 내용은 어디로도 보내지 않는다.
 * 네트워크는 같은 사이트의 처방 파일(rules/<파일 이름>.json)을 읽을 때만 쓴다.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var ACTION_LABEL = {
    normalize_date: '날짜 모양 통일',
    strip_suffix: '끝 글자 지움',
    fill_from_key: '빈칸 채움',
    fix_from_key: '맞춰 고침',
    to_number: '숫자로 통일',
    flag: '표시 (고치지 않음)',
    dedupe: '같은 줄 하나만'
  };

  var state = { fileName: '', baseName: '', wb: null, csv: false, table: null, rules: null, rulesSource: '', result: null };

  /* ---------- 공통 ---------- */

  function showEl(id, on) { $(id).hidden = !on; }

  function setError(id, msg) {
    $(id).textContent = msg || '';
    showEl(id, !!msg);
  }

  function readBuffer(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsArrayBuffer(file);
    });
  }

  function td(text, cls) {
    var el = document.createElement('td');
    el.textContent = text === null || text === undefined ? '' : String(text);
    if (cls) el.className = cls;
    return el;
  }

  function fillBody(tbodyId, rows) {
    var body = $(tbodyId);
    body.textContent = '';
    var frag = document.createDocumentFragment();
    rows.forEach(function (cells) {
      var tr = document.createElement('tr');
      cells.forEach(function (c) { tr.appendChild(c instanceof Node ? c : td(c)); });
      frag.appendChild(tr);
    });
    body.appendChild(frag);
  }

  function download(XLSXwb, name) {
    var bytes = XLSX.write(XLSXwb, { type: 'array', bookType: 'xlsx', compression: true });
    var blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function resetAfterFile() {
    state.rules = null; state.result = null; state.table = null;
    ['step-info', 'step-rules', 'step-result', 'step-compare', 'rules-missing', 'rules-view', 'compare-view'].forEach(function (id) { showEl(id, false); });
    setError('rules-error', ''); setError('answer-error', '');
  }

  /* ---------- 1. 파일 넣기 ---------- */

  function handleFile(file) {
    if (!file) return;
    setError('file-error', '');
    resetAfterFile();
    state.fileName = file.name.normalize('NFC');
    state.baseName = state.fileName.replace(/\.[^.]+$/, '');
    readBuffer(file).then(function (buf) {
      var r = Cleaner.readWorkbook(XLSX, buf, state.fileName);
      state.wb = r.wb; state.csv = r.csv;
      pickSheet();
      return loadRulesFromSite(state.baseName);
    }).catch(function (e) {
      setError('file-error', '파일을 읽지 못했습니다. 엑셀(.xlsx · .xls) 또는 .csv 파일인지 확인해 주세요.\n(' + e.message + ')');
    });
  }

  /* 처방 파일에 적힌 시트가 있으면 그 시트를, 없으면 첫 시트를 쓴다. */
  function pickSheet() {
    var names = state.wb.SheetNames;
    var want = state.rules && state.rules.sheet;
    var name = want && names.indexOf(want) >= 0 ? want : names[0];
    state.sheetName = name;
    state.table = Cleaner.sheetToTable(XLSX, state.wb.Sheets[name], state.csv);
    renderInfo();
  }

  function renderInfo() {
    var t = state.table;
    $('info-name').textContent = state.fileName;
    $('info-sheet').textContent = state.sheetName + (state.wb.SheetNames.length > 1 ? ' (전체 ' + state.wb.SheetNames.length + '개 중)' : '');
    $('info-rows').textContent = t.rows.length.toLocaleString('ko-KR') + '줄 (머리글 빼고)';
    $('info-cols').textContent = t.headers.length + '칸';
    $('info-headers').textContent = '칸 이름: ' + t.headers.join(' · ');
    $('info-skipped').textContent = t.skippedBlank ? '완전히 빈 줄 ' + t.skippedBlank + '개는 읽지 않았습니다.' : '';
    showEl('info-skipped', t.skippedBlank > 0);
    showEl('step-info', true);
  }

  /* ---------- 2. 처방 ---------- */

  function loadRulesFromSite(base) {
    showEl('step-rules', true);
    var path = 'rules/' + encodeURIComponent(base) + '.json';
    return fetch(path, { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('없음');
      return res.json();
    }).then(function (rules) {
      useRules(rules, 'rules/' + base + '.json');
    }).catch(function () {
      $('rules-missing-detail').textContent = '«rules/' + base + '.json» 을 찾지 못했습니다. 처방 파일을 직접 골라 주세요.';
      showEl('rules-missing', true);
      showEl('rules-view', false);
    });
  }

  function useRules(rules, source) {
    state.rules = rules;
    state.rulesSource = source;
    state.result = null;
    showEl('step-result', false);
    showEl('step-compare', false);
    pickSheet();
    var problems = Cleaner.validate(state.table.headers, rules);
    if (problems.length) {
      setError('rules-error', '처방 파일이 이 엑셀과 맞지 않습니다.\n' + problems.join('\n'));
      showEl('rules-view', false);
      showEl('rules-missing', true);
      $('rules-missing-detail').textContent = '«' + source + '» 을 읽었지만 쓸 수 없습니다. 맞는 처방 파일을 골라 주세요.';
      return;
    }
    setError('rules-error', '');
    showEl('rules-missing', false);
    renderRules();
  }

  function renderRules() {
    var r = state.rules;
    $('rules-source').textContent = '처방 파일: ' + state.rulesSource + (r.updated ? ' · 고친 날 ' + r.updated : '') + ' · 처방 ' + r.rules.length + '개 (위에서부터 차례로 적용)';
    fillBody('rules-body', r.rules.map(function (rule) {
      var cols = rule.action === 'dedupe' ? '(전체 행)' : [].concat(rule.column).join(', ');
      return [td(rule.id, 'nowrap'), td(cols, 'nowrap'), td(ACTION_LABEL[rule.action] || rule.action, 'nowrap'),
        rule.detail || '', rule.why || '', td(rule.owner || '', 'nowrap')];
    }));
    showEl('rules-view', true);
  }

  /* ---------- 3. 정리 ---------- */

  function run() {
    try {
      var result = Cleaner.clean(state.table, state.rules);
      var twice = Cleaner.checkTwice(XLSX, result, state.table, state.rules);
      state.result = result;
      renderResult(result, twice);
    } catch (e) {
      setError('rules-error', '정리하지 못했습니다.\n' + e.message);
    }
  }

  function renderResult(res, twice) {
    var s = res.stats;
    $('st-rows').textContent = s.rowsBefore + ' → ' + s.rowsAfter;
    $('st-deleted').textContent = s.deleted;
    $('st-fixed').textContent = s.fixed;
    $('st-flagged').textContent = s.flaggedRows;
    var tw = $('st-twice');
    tw.textContent = twice.same ? '예 ✓' : '아니오 ✗';
    tw.className = 'value ' + (twice.same ? 'ok' : 'bad');
    tw.title = twice.same ? '정리본을 다시 정리해도 바뀌는 값이 없습니다.' :
      '정리본을 다시 정리하면 고친 값 ' + twice.fixed + '개, 지운 행 ' + twice.deleted + '개가 또 나옵니다.';

    fillBody('per-rule-body', state.rules.rules.map(function (rule) {
      var t = res.perRule[rule.id] || { fixed: 0, flagged: 0, deleted: 0 };
      var cols = rule.action === 'dedupe' ? '(전체 행)' : [].concat(rule.column).join(', ');
      return [rule.id, cols, t.fixed, t.flagged, t.deleted];
    }));

    var LIMIT = 500;
    var KIND = { '고침': 'fix', '표시': 'flag', '삭제': 'del' };
    $('log-count').textContent = '(' + res.log.length + '건' + (res.log.length > LIMIT ? ', 처음 ' + LIMIT + '건만 보임 — 전부는 내려받은 파일에' : '') + ')';
    fillBody('log-body', res.log.slice(0, LIMIT).map(function (e) {
      var tag = document.createElement('td');
      var span = document.createElement('span');
      span.className = 'tag ' + KIND[e.kind];
      span.textContent = e.kind;
      tag.appendChild(span);
      return [tag, e.rule, e.row, td(e.column, 'nowrap'), e.before, e.after, e.note || e.why];
    }));

    showEl('step-result', true);
    showEl('step-compare', true);
    showEl('compare-view', false);
    setError('answer-error', '');
    $('step-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------- 4. 정답과 대조 ---------- */

  function handleAnswer(file) {
    if (!file || !state.result) return;
    setError('answer-error', '');
    var name = file.name.normalize('NFC');
    readBuffer(file).then(function (buf) {
      var r = Cleaner.readWorkbook(XLSX, buf, name);
      var want = state.rules.sheet;
      var sheet = want && r.wb.SheetNames.indexOf(want) >= 0 ? want : r.wb.SheetNames[0];
      var answer = Cleaner.sheetToTable(XLSX, r.wb.Sheets[sheet], r.csv);
      var cols = state.rules.columns || state.result.headers;
      var cp = Cleaner.compare(state.result, answer, cols);
      if (!cp.columns.length) throw new Error('정답 파일에 같은 이름의 칸이 하나도 없습니다.');
      renderCompare(cp, name, sheet);
    }).catch(function (e) {
      setError('answer-error', '정답 파일을 대조하지 못했습니다.\n' + e.message);
    });
  }

  function renderCompare(cp, name, sheet) {
    $('cp-answer').textContent = cp.answerRows;
    $('cp-clean').textContent = cp.cleanRows;
    $('cp-exact').textContent = cp.exact;
    var d = $('cp-diffs');
    d.textContent = cp.diffs.length;
    d.className = 'value ' + (cp.diffs.length === 0 && cp.onlyAnswer.length === 0 && cp.onlyClean.length === 0 ? 'ok' : 'bad');

    var notes = ['정답 파일: ' + name + ' (시트 ' + sheet + ')', '대조한 칸: ' + cp.columns.join(' · ')];
    if (cp.missingCols.length) notes.push('정답에 없는 칸이라 대조하지 못함: ' + cp.missingCols.join(', '));
    if (cp.diffs.length) notes.push('어긋난 칸이 있는 행: ' + cp.diffRows + '줄');
    if (cp.onlyAnswer.length) notes.push('정답에만 있는 행 (정답 행 번호): ' + cp.onlyAnswer.join(', '));
    if (cp.onlyClean.length) notes.push('정리본에만 있는 행 (정리본 행 번호): ' + cp.onlyClean.join(', '));
    notes.push('_표시 칸은 대조하지 않습니다.');
    $('cp-note').textContent = notes.join('\n');
    $('cp-note').style.whiteSpace = 'pre-line';

    fillBody('cp-body', cp.diffs.slice(0, 1000).map(function (x) {
      return [x.answerRow, x.cleanRow, td(x.column, 'nowrap'), x.clean, x.answer];
    }));
    showEl('compare-view', true);
  }

  /* ---------- 연결 ---------- */

  var drop = $('drop');
  ['dragenter', 'dragover'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
  });
  drop.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });
  // 끌어다 놓기가 칸 밖에 떨어져도 브라우저가 파일을 열어 버리지 않게 한다.
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });

  $('file-input').addEventListener('change', function (e) { handleFile(e.target.files[0]); e.target.value = ''; });

  $('rules-input').addEventListener('change', function (e) {
    var f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    f.text().then(function (text) {
      var rules;
      try { rules = JSON.parse(text.replace(/^﻿/, '')); }
      catch (err) { throw new Error('JSON 형식이 아닙니다. (' + err.message + ')'); }
      useRules(rules, f.name.normalize('NFC') + ' (직접 고름)');
    }).catch(function (err) {
      setError('rules-error', '처방 파일을 읽지 못했습니다.\n' + err.message);
    });
  });

  $('run').addEventListener('click', run);

  $('dl-clean').addEventListener('click', function () {
    if (!state.result) return;
    download(Cleaner.cleanWorkbook(XLSX, state.result, state.table, state.rules), state.baseName + '_정리본.xlsx');
  });
  $('dl-log').addEventListener('click', function () {
    if (!state.result) return;
    download(Cleaner.logWorkbook(XLSX, state.result, state.rules), state.baseName + '_바꾼기록.xlsx');
  });

  $('answer-input').addEventListener('change', function (e) { handleAnswer(e.target.files[0]); e.target.value = ''; });

  document.body.setAttribute('data-ready', 'yes');
})();
