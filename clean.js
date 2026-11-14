/*
 * clean.js — 처방 파일(rules/*.json)을 읽어 표를 정리하는 계산 부분.
 * 화면(DOM)은 건드리지 않는다. 파일 내용을 어디로도 보내지 않는다.
 * 무엇을 고칠지는 처방 파일에만 있다. 여기에는 "처방 종류(action)별로 어떻게 하는지"만 있다.
 */
(function (global) {
  'use strict';

  /* ---------- 작은 도구들 ---------- */

  function isBlank(v) {
    return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function isRealDate(y, m, d) {
    if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
    if (m < 1 || m > 12 || d < 1) return false;
    return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
  }

  function isoDate(y, m, d) {
    return y + '-' + pad2(m) + '-' + pad2(d);
  }

  var ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

  function isIsoDate(v) {
    if (typeof v !== 'string') return false;
    var m = v.match(ISO_RE);
    return !!m && isRealDate(+m[1], +m[2], +m[3]);
  }

  var SLASH_RE = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/;

  /* 한 칸 안의 "앞/뒤/연도" 날짜가 월/일 순서인지 일/월 순서인지, 칸 전체를 보고 정한다.
     13 이상인 자리가 있어야 순서를 알 수 있다. 모르면 null (고치지 않는다). */
  function slashOrder(values) {
    var monthFirst = false, dayFirst = false;
    values.forEach(function (v) {
      if (typeof v !== 'string') return;
      var m = v.match(SLASH_RE);
      if (!m) return;
      if (+m[1] > 12) dayFirst = true;
      if (+m[2] > 12) monthFirst = true;
    });
    if (monthFirst && !dayFirst) return 'MD';
    if (dayFirst && !monthFirst) return 'DM';
    return null;
  }

  /* 글자로 적힌 날짜를 YYYY-MM-DD 로 읽는다. 읽을 수 없으면 null. */
  function parseDateText(v, opts) {
    if (typeof v !== 'string') return null;
    var s = v.trim();
    var m, y, mo, d;
    if ((m = s.match(/^(\d{4})[.\-\/](\d{1,2})[.\-\/](\d{1,2})\.?$/))) {
      y = +m[1]; mo = +m[2]; d = +m[3];
    } else if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) {
      y = +m[1]; mo = +m[2]; d = +m[3];
    } else if ((m = s.match(/^(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일$/))) {
      y = +m[1]; mo = +m[2]; d = +m[3];
    } else if ((m = s.match(/^(\d{2})\.(\d{1,2})\.(\d{1,2})$/))) {
      y = 2000 + +m[1]; mo = +m[2]; d = +m[3];
    } else if ((m = s.match(SLASH_RE))) {
      if (opts.slashOrder === 'MD') { mo = +m[1]; d = +m[2]; }
      else if (opts.slashOrder === 'DM') { d = +m[1]; mo = +m[2]; }
      else return null;
      y = +m[3];
    } else if ((m = s.match(/^(\d{1,2})\s*월\s*(\d{1,2})\s*일$/))) {
      if (!Number.isInteger(opts.defaultYear)) return null;
      y = opts.defaultYear; mo = +m[1]; d = +m[2];
    } else {
      return null;
    }
    return isRealDate(y, mo, d) ? isoDate(y, mo, d) : null;
  }

  /* "96개", "1,200", " 48 " 같은 값을 숫자로 읽는다. 읽을 수 없으면 null. */
  function parseNumberText(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v !== 'string') return null;
    var m = v.trim().match(/^(-?(?:\d{1,3}(?:,\d{3})+|\d+))(\.\d+)?\s*[가-힣A-Za-z]*$/);
    if (!m) return null;
    return Number((m[1] + (m[2] || '')).replace(/,/g, ''));
  }

  /* 가장 많이 나온 값. 1등이 둘 이상이면 undefined (모른다). */
  function majority(counter) {
    var best, bestCount = 0, tie = false;
    counter.forEach(function (count, key) {
      if (count > bestCount) { best = key; bestCount = count; tie = false; }
      else if (count === bestCount) { tie = true; }
    });
    return tie ? undefined : best;
  }

  function countBy(rows, keyIdx, valIdx) {
    var groups = new Map();
    rows.forEach(function (r) {
      var k = r.values[keyIdx], v = r.values[valIdx];
      if (isBlank(k) || isBlank(v)) return;
      if (!groups.has(k)) groups.set(k, new Map());
      var c = groups.get(k);
      c.set(v, (c.get(v) || 0) + 1);
    });
    return groups;
  }

  function show(v) {
    if (v === null || v === undefined) return '';
    return v;
  }

  /* ---------- 처방 확인 ---------- */

  var KNOWN_ACTIONS = ['normalize_date', 'flag', 'strip_suffix', 'fill_from_key', 'fix_from_key', 'to_number', 'dedupe'];
  var KNOWN_CHECKS = ['blank', 'blank_or_not_date', 'number_gt', 'number_lte', 'not_majority_of_key'];

  function ruleColumns(rule) {
    if (rule.action === 'dedupe') return [];
    return Array.isArray(rule.column) ? rule.column : [rule.column];
  }

  /* 처방 파일과 표가 맞는지 본다. 문제를 글로 돌려준다(없으면 빈 배열). */
  function validate(headers, rules) {
    var problems = [];
    if (!rules || !Array.isArray(rules.rules)) {
      return ['처방 파일에 rules 목록이 없습니다.'];
    }
    var need = new Set(rules.columns || []);
    rules.rules.forEach(function (r) {
      ruleColumns(r).forEach(function (c) { need.add(c); });
      if (r.key) need.add(r.key);
      if (r.check && r.check.key) need.add(r.check.key);
      if (KNOWN_ACTIONS.indexOf(r.action) < 0) {
        problems.push((r.id || '?') + ': 모르는 처방 종류 «' + r.action + '»');
      }
      if (r.action === 'flag' && (!r.check || KNOWN_CHECKS.indexOf(r.check.type) < 0)) {
        problems.push((r.id || '?') + ': 표시 조건(check)이 없거나 모르는 조건입니다.');
      }
    });
    var missing = Array.from(need).filter(function (c) { return headers.indexOf(c) < 0; });
    if (missing.length) problems.push('파일에 없는 칸: ' + missing.join(', '));
    return problems;
  }

  /* ---------- 정리 ---------- */

  /*
   * table: { headers: [...], rows: [{ row: 원래 행 번호, values: [...] }] }
   * 돌려주는 것: { headers, rows: [{row, values, flags}], log: [...], stats, perRule }
   */
  function clean(table, rules) {
    var problems = validate(table.headers, rules);
    if (problems.length) {
      var err = new Error(problems.join('\n'));
      err.problems = problems;
      throw err;
    }

    var headers = table.headers.slice();
    var col = function (name) { return headers.indexOf(name); };
    var rows = table.rows.map(function (r) {
      return { row: r.row, values: r.values.slice(), flags: [] };
    });
    var log = [];
    var perRule = {};

    function tally(rule, kind) {
      var t = perRule[rule.id] || (perRule[rule.id] = { fixed: 0, flagged: 0, deleted: 0 });
      t[kind] += 1;
    }

    function fix(rule, r, column, before, after) {
      r.values[col(column)] = after;
      log.push({ kind: '고침', rule: rule.id, row: r.row, column: column, before: show(before), after: show(after), why: rule.why || '', note: '' });
      tally(rule, 'fixed');
    }

    function flag(rule, r, column, value) {
      var text = rule.flag_text || '확인 필요';
      if (Array.isArray(rule.column)) text = column + ': ' + text;
      var tag = '[' + rule.id + '] ' + text;
      if (r.flags.indexOf(tag) >= 0) return;
      r.flags.push(tag);
      log.push({ kind: '표시', rule: rule.id, row: r.row, column: column, before: show(value), after: '', why: rule.why || '', note: text });
      tally(rule, 'flagged');
    }

    rules.rules.forEach(function (rule) {
      var cols = ruleColumns(rule);

      switch (rule.action) {
        case 'normalize_date': cols.forEach(function (c) {
          var i = col(c);
          var opts = { defaultYear: rule.default_year, slashOrder: slashOrder(rows.map(function (r) { return r.values[i]; })) };
          rows.forEach(function (r) {
            var v = r.values[i];
            if (isBlank(v) || isIsoDate(v)) return;
            var iso = parseDateText(v, opts);
            if (iso !== null && iso !== v) fix(rule, r, c, v, iso);
          });
        }); break;

        case 'strip_suffix': cols.forEach(function (c) {
          var i = col(c), suf = String(rule.suffix || '');
          if (!suf) return;
          rows.forEach(function (r) {
            var v = r.values[i];
            if (typeof v === 'string' && v.length > suf.length && v.endsWith(suf)) {
              fix(rule, r, c, v, v.slice(0, -suf.length));
            }
          });
        }); break;

        case 'fill_from_key': cols.forEach(function (c) {
          var i = col(c), groups = countBy(rows, col(rule.key), i);
          rows.forEach(function (r) {
            if (!isBlank(r.values[i])) return;
            var g = groups.get(r.values[col(rule.key)]);
            if (g && g.size === 1) fix(rule, r, c, r.values[i], g.keys().next().value);
            else flag(rule, r, c, r.values[i]);
          });
        }); break;

        case 'fix_from_key': cols.forEach(function (c) {
          var i = col(c), groups = countBy(rows, col(rule.key), i);
          rows.forEach(function (r) {
            var v = r.values[i];
            if (isBlank(v)) return;
            var g = groups.get(r.values[col(rule.key)]);
            if (!g || g.size < 2) return;
            var top = majority(g);
            if (top === undefined) flag(rule, r, c, v);
            else if (v !== top) fix(rule, r, c, v, top);
          });
        }); break;

        case 'to_number': cols.forEach(function (c) {
          var i = col(c);
          rows.forEach(function (r) {
            var v = r.values[i];
            if (isBlank(v) || typeof v === 'number') return;
            var n = parseNumberText(v);
            if (n === null) flag(rule, r, c, v);
            else fix(rule, r, c, v, n);
          });
        }); break;

        case 'flag': cols.forEach(function (c) {
          var i = col(c), chk = rule.check, groups = null;
          if (chk.type === 'not_majority_of_key') groups = countBy(rows, col(chk.key), i);
          rows.forEach(function (r) {
            var v = r.values[i], hit = false;
            switch (chk.type) {
              case 'blank': hit = isBlank(v); break;
              case 'blank_or_not_date': hit = isBlank(v) || !isIsoDate(v); break;
              case 'number_gt': hit = typeof v === 'number' && v > chk.value; break;
              case 'number_lte': hit = typeof v === 'number' && v <= chk.value; break;
              case 'not_majority_of_key':
                if (!isBlank(v)) {
                  var g = groups.get(r.values[col(chk.key)]);
                  hit = !!g && g.size > 1 && v !== majority(g);
                }
                break;
            }
            if (hit) flag(rule, r, c, v);
          });
        }); break;

        case 'dedupe': {
          var seen = new Map();
          rows = rows.filter(function (r) {
            var key = JSON.stringify(r.values);
            if (seen.has(key)) {
              log.push({ kind: '삭제', rule: rule.id, row: r.row, column: '(전체 행)', before: '', after: '', why: rule.why || '', note: seen.get(key) + '행과 같은 줄' });
              tally(rule, 'deleted');
              return false;
            }
            seen.set(key, r.row);
            return true;
          });
        } break;
      }
    });

    var stats = {
      rowsBefore: table.rows.length,
      rowsAfter: rows.length,
      deleted: log.filter(function (e) { return e.kind === '삭제'; }).length,
      fixed: log.filter(function (e) { return e.kind === '고침'; }).length,
      flaggedRows: rows.filter(function (r) { return r.flags.length > 0; }).length
    };
    return { headers: headers, rows: rows, log: log, stats: stats, perRule: perRule };
  }

  /* ---------- 엑셀 읽기 · 쓰기 (SheetJS) ---------- */

  function decodeText(buf) {
    var bytes = new Uint8Array(buf);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
    } catch (e) {
      return new TextDecoder('euc-kr').decode(bytes); // 엑셀이 만든 한글 CSV
    }
  }

  function readWorkbook(XLSX, buf, fileName) {
    if (/\.(csv|txt)$/i.test(fileName || '')) {
      return { wb: XLSX.read(decodeText(buf), { type: 'string', raw: true }), csv: true };
    }
    return { wb: XLSX.read(new Uint8Array(buf), { type: 'array', cellDates: false, cellNF: true }), csv: false };
  }

  function cellValue(XLSX, cell, csv, isDate) {
    if (!cell || cell.t === 'z') return null;
    if (cell.t === 'e') return cell.w || '#오류';
    if (cell.t === 'd') {
      var dt = cell.v;
      return isoDate(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
    }
    if (cell.t === 'n' && cell.z && XLSX.SSF.is_date(cell.z)) {
      isDate.hit = true;
      var p = XLSX.SSF.parse_date_code(cell.v);
      if (!p) return cell.v;
      var s = isoDate(p.y, p.m, p.d);
      if (p.H || p.M || p.S) s += ' ' + pad2(p.H) + ':' + pad2(p.M);
      return s;
    }
    if (cell.t === 's' && csv) {
      // CSV 는 모두 글자로 들어오므로, 순수한 숫자만 숫자로 읽는다 (앞자리 0이 있으면 글자로 둔다).
      var t = cell.v;
      if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(t)) return Number(t);
      return t === '' ? null : t;
    }
    return cell.v;
  }

  /* 시트 → 표. 머리글은 첫 줄. 행 번호는 엑셀 행 번호(머리글 = 1행). 완전히 빈 줄은 읽지 않고 센다. */
  function sheetToTable(XLSX, ws, csv) {
    if (!ws || !ws['!ref']) return { headers: [], rows: [], dateCols: [], skippedBlank: 0 };
    var range = XLSX.utils.decode_range(ws['!ref']);
    var headers = [];
    for (var c = range.s.c; c <= range.e.c; c++) {
      var h = ws[XLSX.utils.encode_cell({ r: range.s.r, c: c })];
      headers.push(h ? String(h.w !== undefined && h.t !== 's' ? h.w : h.v).trim() : '');
    }
    while (headers.length && headers[headers.length - 1] === '') headers.pop();
    var dateHits = headers.map(function () { return { hit: false }; });
    var rows = [], skipped = 0;
    for (var r = range.s.r + 1; r <= range.e.r; r++) {
      var values = [];
      for (var k = 0; k < headers.length; k++) {
        values.push(cellValue(XLSX, ws[XLSX.utils.encode_cell({ r: r, c: range.s.c + k })], csv, dateHits[k]));
      }
      if (values.every(isBlank)) { skipped++; continue; }
      rows.push({ row: r + 1, values: values });
    }
    var dateCols = headers.filter(function (h, i) { return dateHits[i].hit; });
    return { headers: headers, rows: rows, dateCols: dateCols, skippedBlank: skipped };
  }

  function excelSerial(iso) {
    var m = iso.match(ISO_RE);
    return (Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400000;
  }

  /* 표 → 시트. dateCols 칸의 YYYY-MM-DD 값은 엑셀 날짜로 쓴다. */
  function tableToSheet(XLSX, headers, valueRows, dateCols) {
    var ws = XLSX.utils.aoa_to_sheet([headers].concat(valueRows));
    var dateIdx = headers.map(function (h, i) { return dateCols.indexOf(h) >= 0 ? i : -1; }).filter(function (i) { return i >= 0; });
    valueRows.forEach(function (vals, r) {
      dateIdx.forEach(function (i) {
        if (isIsoDate(vals[i])) {
          ws[XLSX.utils.encode_cell({ r: r + 1, c: i })] = { t: 'n', v: excelSerial(vals[i]), z: 'yyyy-mm-dd' };
        }
      });
    });
    ws['!cols'] = headers.map(function (h, i) {
      var w = String(h).length * 2;
      valueRows.slice(0, 300).forEach(function (vals) {
        var s = String(show(vals[i]));
        var len = 0;
        for (var j = 0; j < s.length; j++) len += s.charCodeAt(j) > 255 ? 2 : 1;
        if (len > w) w = len;
      });
      return { wch: Math.min(Math.max(w + 2, 8), 60) };
    });
    return ws;
  }

  function dateColumnsFor(table, rules) {
    var set = new Set(table.dateCols || []);
    rules.rules.forEach(function (r) {
      if (r.action === 'normalize_date') ruleColumns(r).forEach(function (c) { set.add(c); });
    });
    return Array.from(set);
  }

  function cleanWorkbook(XLSX, result, table, rules) {
    var flagCol = rules.flag_column || '_표시';
    var headers = result.headers.concat([flagCol]);
    var rowsOut = result.rows.map(function (r) { return r.values.concat([r.flags.join(' / ')]); });
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, tableToSheet(XLSX, headers, rowsOut, dateColumnsFor(table, rules)), String(rules.sheet || '정리본').slice(0, 31));
    return wb;
  }

  function logWorkbook(XLSX, result, rules) {
    var headers = ['구분', '처방', '행', '칸', '원래 값', '바뀐 값', '이유', '메모'];
    var rowsOut = result.log.map(function (e) {
      return [e.kind, e.rule, e.row, e.column, e.before, e.after, e.why, e.note];
    });
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, tableToSheet(XLSX, headers, rowsOut, []), '바꾼기록');
    return wb;
  }

  /* 정리본을 실제 엑셀로 만들었다가 다시 읽어 한 번 더 정리한다.
     고친 값 0 · 지운 행 0 · 결과가 똑같으면 "두 번 돌려도 같은 결과". */
  function checkTwice(XLSX, result, table, rules) {
    var bytes = XLSX.write(cleanWorkbook(XLSX, result, table, rules), { type: 'array', bookType: 'xlsx' });
    var wb2 = XLSX.read(bytes, { type: 'array', cellDates: false, cellNF: true });
    var t2 = sheetToTable(XLSX, wb2.Sheets[wb2.SheetNames[0]], false);
    var flagCol = rules.flag_column || '_표시';
    var fi = t2.headers.indexOf(flagCol);
    if (fi >= 0) {
      t2.headers.splice(fi, 1);
      t2.rows.forEach(function (r) { r.values.splice(fi, 1); });
    }
    var second = clean(t2, rules);
    var same = second.stats.fixed === 0 && second.stats.deleted === 0 &&
      second.rows.length === result.rows.length &&
      second.rows.every(function (r, i) {
        return JSON.stringify(r.values) === JSON.stringify(result.rows[i].values) &&
          JSON.stringify(r.flags) === JSON.stringify(result.rows[i].flags);
      });
    return { same: same, fixed: second.stats.fixed, deleted: second.stats.deleted };
  }

  /* ---------- 정답과 대조 ---------- */

  function norm(v) {
    if (v === null || v === undefined) return '';
    return String(v).trim();
  }

  /* 같은 줄끼리 먼저 짝짓고, 남은 줄은 가장 많이 같은 줄과 짝지어 어긋난 칸을 찾는다. */
  function compare(result, answer, columns) {
    var cols = columns.filter(function (c) { return answer.headers.indexOf(c) >= 0 && result.headers.indexOf(c) >= 0; });
    var missingCols = columns.filter(function (c) { return answer.headers.indexOf(c) < 0; });
    var aIdx = cols.map(function (c) { return answer.headers.indexOf(c); });
    var cIdx = cols.map(function (c) { return result.headers.indexOf(c); });

    var cleanRows = result.rows.map(function (r, i) {
      return { at: i + 2, vals: cIdx.map(function (k) { return norm(r.values[k]); }) };
    });
    var ansRows = answer.rows.map(function (r) {
      return { at: r.row, vals: aIdx.map(function (k) { return norm(r.values[k]); }) };
    });

    var pool = new Map();
    cleanRows.forEach(function (r) {
      var key = JSON.stringify(r.vals);
      if (!pool.has(key)) pool.set(key, []);
      pool.get(key).push(r);
    });
    var exact = 0, restAns = [], used = new Set();
    ansRows.forEach(function (a) {
      var list = pool.get(JSON.stringify(a.vals));
      if (list && list.length) { used.add(list.shift()); exact++; }
      else restAns.push(a);
    });
    var restClean = cleanRows.filter(function (r) { return !used.has(r); });

    var diffs = [], onlyAnswer = [], half = Math.ceil(cols.length / 2);
    restAns.forEach(function (a) {
      var best = null, bestScore = -1;
      restClean.forEach(function (c) {
        var s = 0;
        for (var k = 0; k < cols.length; k++) if (c.vals[k] === a.vals[k]) s++;
        if (s > bestScore) { best = c; bestScore = s; }
      });
      if (best && bestScore >= half) {
        restClean.splice(restClean.indexOf(best), 1);
        for (var k = 0; k < cols.length; k++) {
          if (best.vals[k] !== a.vals[k]) {
            diffs.push({ answerRow: a.at, cleanRow: best.at, column: cols[k], clean: best.vals[k], answer: a.vals[k] });
          }
        }
      } else {
        onlyAnswer.push(a.at);
      }
    });

    return {
      columns: cols,
      missingCols: missingCols,
      answerRows: ansRows.length,
      cleanRows: cleanRows.length,
      exact: exact,
      diffs: diffs,
      diffRows: new Set(diffs.map(function (d) { return d.answerRow; })).size,
      onlyAnswer: onlyAnswer,
      onlyClean: restClean.map(function (r) { return r.at; })
    };
  }

  global.Cleaner = {
    clean: clean,
    validate: validate,
    readWorkbook: readWorkbook,
    sheetToTable: sheetToTable,
    cleanWorkbook: cleanWorkbook,
    logWorkbook: logWorkbook,
    checkTwice: checkTwice,
    compare: compare,
    _parseDateText: parseDateText,
    _parseNumberText: parseNumberText
  };
})(window);
