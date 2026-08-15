/* 日本の畜産動物はいま — グラフ描画（依存ライブラリなし・SVG手描き） */
(function () {
  "use strict";

  var css = getComputedStyle(document.documentElement);
  function v(name) { return css.getPropertyValue(name).trim(); }
  function colors() {
    css = getComputedStyle(document.documentElement);
    return {
      layers: v("--layers"), layers2: v("--layers-2"), broilers: v("--broilers"),
      pigs: v("--pigs"), sows: v("--sows"), population: v("--population"),
      dogcat: v("--dogcat"), dairy: v("--dairy"), beef: v("--beef"),
      rule: v("--rule"), rule2: v("--rule-2"), sheet: v("--sheet"),
      ink: v("--ink"), ink2: v("--ink-2"), muted: v("--muted")
    };
  }

  /* 塗りの上に載せる文字色は、白と墨のうちコントラストが高い方を選ぶ
     （ライト/ダークで塗りの明るさが変わるため、固定できない） */
  function relLum(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return 0;
    var n = parseInt(m[1], 16);
    var ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(function (c) {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }
  function onFill(hex) {
    var l = relLum(hex);
    var vsWhite = 1.05 / (l + 0.05);
    var vsInk = (l + 0.05) / (relLum("#14150f") + 0.05);
    return vsWhite >= vsInk ? "#fffdf7" : "#14150f";
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  /* ---------- 数値フォーマット（値は「千」単位で持っている） ---------- */
  function fmtCount(thousand, unit) { // unit: "羽","頭","人"
    var n = thousand * 1000;
    if (n >= 1e8) return trim((n / 1e8).toFixed(2)) + "億" + unit;
    if (n >= 1e4) return trim((n / 1e4).toFixed(0)).replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "万" + unit;
    return Math.round(n).toLocaleString("ja-JP") + unit;
  }
  function trim(s) { return s.indexOf(".") >= 0 ? s.replace(/\.?0+$/, "") : s; }
  function fmtPlain(x) { return Math.round(x).toLocaleString("ja-JP"); }

  /* 軸ラベル用: 実数（1羽・1頭・1人単位）を億・万の日本語表記にする。
     引数は「百万」単位（飼養数チャートの内部スケール）。 */
  function axisCount(million) {
    var n = million * 1e6;
    if (n === 0) return "0";
    if (n >= 1e8) return trim((n / 1e8).toFixed(1)) + "億";
    return trim((n / 1e4).toFixed(0)) + "万";
  }

  function last(series) { return series[series.length - 1]; }
  function atYear(series, year) {
    for (var i = 0; i < series.length; i++) if (series[i][0] === year) return series[i][1];
    return null;
  }

  /* ---------- 目盛り ---------- */
  function niceTicks(max, count) {
    var raw = max / count, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var steps = [1, 2, 2.5, 5, 10], step = steps[steps.length - 1] * mag;
    for (var i = 0; i < steps.length; i++) {
      if (raw <= steps[i] * mag) { step = steps[i] * mag; break; }
    }
    var ticks = [], t = 0;
    while (true) { // 最後の目盛りが必ず最大値を覆うようにする
      ticks.push(t);
      if (t >= max) break;
      t += step;
    }
    return ticks;
  }

  var NS = "http://www.w3.org/2000/svg";
  function el(tag, attrs) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  /* 目盛りラベルの実寸を測る。軸の余白をラベルの長さから決めるため
     （「5000万」「1,000」など、系列によって必要な幅が大きく変わる）。 */
  var measSvg, measText;
  function textWidth(str, size) {
    if (!measSvg) {
      measSvg = el("svg", { width: "0", height: "0", "aria-hidden": "true",
        style: "position:absolute;left:-9999px;top:0;visibility:hidden" });
      measText = el("text", {});
      measSvg.appendChild(measText);
      document.body.appendChild(measSvg);
    }
    measText.setAttribute("font-size", size);
    measText.textContent = str;
    return measText.getComputedTextLength();
  }
  function widest(strings, size) {
    return strings.reduce(function (m, s) { return Math.max(m, textWidth(s, size)); }, 0);
  }

  /* ---------- 折れ線グラフ ----------
     opts: { series: [{name, color, data:[[year,val]], context?}],
             height?, yFmt, tipFmt, area?, ariaLabel } */
  function lineChart(container, opts) {
    container.innerHTML = "";
    var C = colors();
    // viewBox の1単位 = 画面の1px にする。こうすると文字は画面幅に関係なく
    // 同じ大きさで出る（縮小されて読めなくなるのを避ける）。
    var cw = Math.round(container.clientWidth) || 720;
    var W = Math.max(300, Math.min(cw, 980));
    var narrow = W < 520;
    var H = narrow ? Math.max(210, Math.round((opts.height || 330) * 0.72)) : (opts.height || 330);
    var AXIS_SIZE = 12.5, LABEL_SIZE = 13;

    var series = opts.series.filter(function (s) { return s.data.length; });
    var years = [], maxV = 0;
    series.forEach(function (s) {
      s.data.forEach(function (p) {
        if (years.indexOf(p[0]) < 0) years.push(p[0]);
        if (p[1] > maxV) maxV = p[1];
      });
    });
    years.sort(function (a, b) { return a - b; });
    var x0 = years[0], x1 = years[years.length - 1];
    var ticks = niceTicks(maxV * 1.05, 4);
    var yMax = ticks[ticks.length - 1];

    // 左右の余白は、実際に描くラベルの実寸から決める（切れないように）
    var tickLabels = ticks.map(function (t) { return opts.yFmt ? opts.yFmt(t) : fmtPlain(t); });
    var endLabels = series.map(function (s) { return s.name; });
    var pad = {
      l: Math.max(38, Math.round(widest(tickLabels, AXIS_SIZE)) + 14),
      // 狭い画面では終端ラベルを置く余白がないので、凡例に任せる
      r: narrow ? 14 : Math.max(28, Math.round(widest(endLabels, LABEL_SIZE)) + 20),
      t: 16, b: 32
    };

    function X(year) { return pad.l + (year - x0) / (x1 - x0) * (W - pad.l - pad.r); }
    function Y(val) { return pad.t + (1 - val / yMax) * (H - pad.t - pad.b); }

    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img",
      "aria-label": opts.ariaLabel || "折れ線グラフ" });

    // 罫（横線）と目盛りラベル。0の基線だけ濃くする。
    ticks.forEach(function (t, i) {
      svg.appendChild(el("line", { x1: pad.l, x2: W - pad.r, y1: Y(t), y2: Y(t),
        stroke: t === 0 ? C.rule2 : C.rule, "stroke-width": 1 }));
      var lbl = el("text", { x: pad.l - 10, y: Y(t) + 4, "text-anchor": "end",
        "font-size": AXIS_SIZE, fill: C.muted, style: "font-variant-numeric: tabular-nums" });
      lbl.textContent = tickLabels[i];
      svg.appendChild(lbl);
    });
    // X軸目盛り。ラベルが重ならない最小の刻みを選ぶ。
    var span = x1 - x0;
    var maxLabels = Math.max(2, Math.floor((W - pad.l - pad.r) / 46));
    var stepChoices = [1, 2, 5, 10, 20, 25, 50], stepX = 50;
    for (var si = 0; si < stepChoices.length; si++) {
      if (Math.floor(span / stepChoices[si]) + 1 <= maxLabels) { stepX = stepChoices[si]; break; }
    }
    for (var yr = Math.ceil(x0 / stepX) * stepX; yr <= x1; yr += stepX) {
      var xl = el("text", { x: X(yr), y: H - 8, "text-anchor": "middle",
        "font-size": AXIS_SIZE, fill: C.muted, style: "font-variant-numeric: tabular-nums" });
      xl.textContent = yr;
      svg.appendChild(xl);
    }

    // 面ワッシュ（単一系列のみ）
    if (series.length === 1 && opts.area) {
      var s0 = series[0], d = "M" + X(s0.data[0][0]) + " " + Y(0);
      s0.data.forEach(function (p) { d += " L" + X(p[0]) + " " + Y(p[1]); });
      d += " L" + X(last(s0.data)[0]) + " " + Y(0) + " Z";
      svg.appendChild(el("path", { d: d, fill: s0.color, opacity: 0.12 }));
    }

    // 線・終端ドット。文脈系列（人口）は破線にして、主役の系列と役割を分ける。
    series.forEach(function (s) {
      var dd = "";
      s.data.forEach(function (p, i) { dd += (i ? " L" : "M") + X(p[0]) + " " + Y(p[1]); });
      svg.appendChild(el("path", { d: dd, fill: "none", stroke: s.color,
        "stroke-width": s.context ? 1.75 : 2.25,
        "stroke-linejoin": "round", "stroke-linecap": "round",
        "stroke-dasharray": s.context ? "7 5" : "" }));
      var lp = last(s.data);
      svg.appendChild(el("circle", { cx: X(lp[0]), cy: Y(lp[1]), r: 6, fill: C.sheet }));
      svg.appendChild(el("circle", { cx: X(lp[0]), cy: Y(lp[1]), r: 3.5, fill: s.color }));
    });

    // 終端の直接ラベル。重なる場合は消さずに上下へずらして、必ず全系列を出す。
    var labels = narrow ? [] : series.map(function (s) {
      var lp = last(s.data);
      return { name: s.name, y: Y(lp[1]), x: X(lp[0]) + 11,
               fill: s.context ? C.ink2 : s.color };
    }).sort(function (a, b) { return a.y - b.y; });
    var GAP = 16;
    for (var i = 1; i < labels.length; i++) {
      if (labels[i].y - labels[i - 1].y < GAP) labels[i].y = labels[i - 1].y + GAP;
    }
    var overflow = labels.length ? labels[labels.length - 1].y - (H - pad.b) : 0;
    if (overflow > 0) labels.forEach(function (l) { l.y -= overflow; });
    labels.forEach(function (l) {
      var t = el("text", { x: l.x, y: l.y + 4, "font-size": LABEL_SIZE, fill: l.fill });
      t.textContent = l.name;
      svg.appendChild(t);
    });

    // クロスヘア＋ツールチップ
    var cross = el("line", { y1: pad.t, y2: H - pad.b, stroke: C.rule2,
      "stroke-width": 1, visibility: "hidden" });
    svg.appendChild(cross);
    var hoverDots = series.map(function (s) {
      var g = el("g", { visibility: "hidden" });
      g.appendChild(el("circle", { r: 6, fill: C.sheet }));
      g.appendChild(el("circle", { r: 3.5, fill: s.color }));
      svg.appendChild(g);
      return g;
    });

    var tip = document.createElement("div");
    tip.className = "tooltip";
    container.appendChild(svg);
    container.appendChild(tip);
    container.tabIndex = 0;
    container.setAttribute("role", "application");
    container.setAttribute("aria-label",
      (opts.ariaLabel || "グラフ") + "。左右矢印キーで年ごとの値を読み上げます。下の「データを表で見る」にも同じ値があります。");

    var activeIdx = -1;
    function showAt(idx) {
      activeIdx = idx;
      var year = years[idx];
      var px = X(year);
      cross.setAttribute("x1", px); cross.setAttribute("x2", px);
      cross.setAttribute("visibility", "visible");
      var html = '<div class="t-year">' + year + "年</div>";
      series.forEach(function (s, i) {
        var val = atYear(s.data, year);
        var g = hoverDots[i];
        if (val == null) { g.setAttribute("visibility", "hidden"); return; }
        g.setAttribute("transform", "translate(" + X(year) + "," + Y(val) + ")");
        g.setAttribute("visibility", "visible");
        html += '<div class="t-row"><span class="t-name"><span class="dot" style="background:' +
          s.color + '"></span>' + esc(s.name) + '</span><span class="t-val">' +
          opts.tipFmt(val, s) + "</span></div>";
      });
      tip.innerHTML = html;
      tip.style.display = "block";
      var rect = container.getBoundingClientRect();
      var sx = rect.width / W;
      var left = px * sx + 14;
      if (left + tip.offsetWidth > rect.width) left = px * sx - tip.offsetWidth - 14;
      tip.style.left = Math.max(0, left) + "px";
      tip.style.top = pad.t * (rect.height / H) + "px";
      container.setAttribute("aria-valuetext", tip.textContent);
    }
    function hide() {
      activeIdx = -1;
      cross.setAttribute("visibility", "hidden");
      hoverDots.forEach(function (g) { g.setAttribute("visibility", "hidden"); });
      tip.style.display = "none";
    }
    svg.addEventListener("pointermove", function (ev) {
      var rect = svg.getBoundingClientRect();
      var vx = (ev.clientX - rect.left) * (W / rect.width);
      var t = x0 + (vx - pad.l) / (W - pad.l - pad.r) * (x1 - x0);
      var best = 0, bd = Infinity;
      years.forEach(function (yv, i) {
        var dd2 = Math.abs(yv - t);
        if (dd2 < bd) { bd = dd2; best = i; }
      });
      showAt(best);
    });
    svg.addEventListener("pointerleave", hide);
    container.addEventListener("keydown", function (ev) {
      if (ev.key === "ArrowRight") { showAt(Math.min(years.length - 1, activeIdx < 0 ? years.length - 1 : activeIdx + 1)); ev.preventDefault(); }
      else if (ev.key === "ArrowLeft") { showAt(Math.max(0, activeIdx < 0 ? years.length - 1 : activeIdx - 1)); ev.preventDefault(); }
      else if (ev.key === "Escape") hide();
    });
    container.addEventListener("blur", hide);

    // 凡例（2系列以上のとき必ず表示）
    if (series.length >= 2) {
      var lg = document.createElement("div");
      lg.className = "legend";
      series.forEach(function (s) {
        var item = document.createElement("span");
        item.className = "item";
        item.innerHTML = '<span class="swatch' + (s.context ? " dash" : "") +
          '" style="' + (s.context ? "color:" : "background:") + s.color + '"></span>' + esc(s.name);
        lg.appendChild(item);
      });
      container.appendChild(lg);
    }

    // 表ビュー（アクセシブルな双子）
    var det = document.createElement("details");
    det.className = "table-view";
    var head = "<tr><th>年</th>" + series.map(function (s) { return "<th>" + esc(s.name) + "</th>"; }).join("") + "</tr>";
    var body = years.map(function (year) {
      return "<tr><td>" + year + "</td>" + series.map(function (s) {
        var val = atYear(s.data, year);
        return "<td>" + (val == null ? "—" : opts.tipFmt(val, s)) + "</td>";
      }).join("") + "</tr>";
    }).join("");
    det.innerHTML = "<summary>データを表で見る</summary><table><thead>" + head + "</thead><tbody>" + body + "</tbody></table>";
    container.appendChild(det);
  }

  /* ---------- 数値タイル ---------- */
  function tile(parent, opts) {
    var d = document.createElement("div");
    d.className = "tile";
    d.innerHTML =
      '<div class="label">' + (opts.color ? '<span class="key" style="background:' + opts.color + '"></span>' : "") +
      opts.label + "</div>" +
      '<div class="value">' + opts.value + "</div>" +
      '<div class="sub">' + (opts.sub || "") + "</div>";
    parent.appendChild(d);
  }

  /* ---------- 種別の年間屠殺・殺処分数の比較（面積比） ----------
     1枚の長方形を、実数どおりの面積で分割する。最大の種類が上段の全幅を
     占め、残りが下段を面積比で分ける。どちらの段も「幅×高さ」が実数比。
     犬猫は面積比0.001%未満で長方形として描けないため、引き出し線で位置を示す。 */
  function speciesItems(d, C) {
    var sl = d.slaughter || {}, eu = d.euthanasia || {};
    function latest(s) { return s && s.length ? last(s) : null; }
    var b = latest(sl.broilers), l = latest(sl.layers_culled),
        p = latest(sl.pigs), dc = latest(eu.total);
    var items = [], est = null;
    if (b) items.push({ name: "ブロイラー", color: C.broilers, year: b[0], animals: b[1] * 1000, unit: "羽" });
    if (l) items.push({ name: "廃鶏（採卵鶏）", short: "廃鶏", color: C.layers, year: l[0], animals: l[1] * 1000, unit: "羽" });
    // 採卵鶏由来の雄ひよこ。孵化場での性判別後、卵を産まない雄は生後すぐに
    // 殺処分される。公式統計がないため、雌雛と概ね同数孵化する前提で概算する。
    var maleChicks = latest(sl.layer_male_chicks);
    if (l) {
      var mc = maleChicks
        ? { animals: maleChicks[1] * 1000, year: maleChicks[0], estimated: false }
        : { animals: l[1] * 1000, year: l[0], estimated: true };
      est = mc.estimated;
      items.push({
        name: "雄ひよこ（採卵鶏由来" + (mc.estimated ? "・推定" : "") + "）",
        short: "雄ひよこ" + (mc.estimated ? "（推定）" : ""),
        color: C.layers2, year: mc.year, animals: mc.animals, unit: "羽"
      });
    }
    if (p) items.push({ name: "豚", color: C.pigs, year: p[0], animals: p[1] * 1000, unit: "頭" });
    if (dc) items.push({ name: "犬猫（殺処分）", short: "犬猫", color: C.dogcat, year: dc[0], animals: dc[1], unit: "頭" });
    items.sort(function (a, b2) { return b2.animals - a.animals; });
    return { items: items, estimated: est, dogcat: dc, broiler: b, pig: p };
  }

  function renderSpecies(d, C) {
    var host = document.getElementById("chart-species");
    var noteEl = document.getElementById("species-note");
    var subEl = document.getElementById("species-sub");
    if (!host) return;

    var got = speciesItems(d, C), items = got.items;
    if (!items.length) {
      host.innerHTML = '<p class="empty-note">データを取得中です。</p>';
      if (noteEl) noteEl.textContent = "";
      return;
    }

    var total = items.reduce(function (a, it) { return a + it.animals; }, 0);
    var years = items.map(function (it) { return it.year; });
    var minY = Math.min.apply(null, years), maxY = Math.max.apply(null, years);
    if (subEl) subEl.textContent =
      "各種の最新確報年（" + (minY === maxY ? maxY + "年" : minY + "〜" + maxY + "年") +
      "）・面積は実数に比例 / 出典: 畜産物流通調査（と畜・食鳥流通統計）・環境省";

    // 画面上の見え方を一定に保つため、実表示幅から縮尺を取り、
    // 文字サイズ・引き出し線の太さは「表示ピクセル」で指定する。
    var W = 720, H = 360;
    var shown = host.clientWidth || 720;
    var k = shown / W;              // 1 viewBox単位 = k ピクセル
    function u(px) { return px / k; } // 表示pxを viewBox単位に
    var gap = u(3);
    var svg = "";

    var tiny = [];
    function block(it, x, y, w, h, share) {
      var ww = Math.max(w - gap, 0), hh = Math.max(h - gap, 0);
      if (ww * k < 2) { tiny.push({ it: it, x: x, y: y, share: share }); return ""; }
      var s = '<g class="blk"><title>' + esc(it.name) + "：" +
        fmtCount(it.animals / 1000, it.unit) + "（" + trim(share.toFixed(2)) + "%）</title>" +
        '<rect x="' + x.toFixed(2) + '" y="' + y.toFixed(2) + '" width="' + ww.toFixed(2) +
        '" height="' + hh.toFixed(2) + '" fill="' + it.color + '" rx="' + u(2).toFixed(2) + '"></rect>';
      var fg = onFill(it.color);
      var big = ww * k > 210 && hh * k > 96;
      var narrow = ww * k < 78;
      var nameSize = big ? 27 : (narrow ? 13 : 16), shareSize = big ? 20 : 13;
      if (ww * k > 40 && hh * k > 30) {
        var tx = x + u(narrow ? 7 : 13), ty = y + u(big ? 34 : 24);
        s += '<text x="' + tx.toFixed(2) + '" y="' + ty.toFixed(2) + '" font-size="' + u(nameSize).toFixed(2) +
          '" font-weight="700" fill="' + fg + '">' + esc(it.short || it.name) + "</text>";
        if (hh * k > (big ? 66 : 46) && !narrow) {
          s += '<text x="' + tx.toFixed(2) + '" y="' + (ty + u(big ? 30 : 20)).toFixed(2) +
            '" font-size="' + u(shareSize).toFixed(2) + '" fill="' + fg + '" opacity="0.85">' +
            trim(share.toFixed(share < 1 ? 2 : 1)) + "%</text>";
        }
      }
      return s + "</g>";
    }

    var first = items[0];
    var h1 = total ? (first.animals / total) * H : 0;
    svg += block(first, 0, 0, W, h1, first.animals / total * 100);

    var rest = items.slice(1);
    var restTotal = rest.reduce(function (a, it) { return a + it.animals; }, 0);
    var rx = 0;
    rest.forEach(function (it) {
      var w = restTotal ? (it.animals / restTotal) * W : 0;
      svg += block(it, rx, h1, w, H - h1, it.animals / total * 100);
      rx += w;
    });

    // 描けない大きさの種類は、引き出し線でその位置を示す（面積は誇張しない）
    var callout = 26; // 引き出し線の下に必要な高さ（表示px）
    tiny.forEach(function (t) {
      var x = Math.min(Math.max(t.x, u(6)), W - u(6));
      var anchor = x > W / 2 ? "end" : "start";
      var tx = x > W / 2 ? W : 0;
      var head = t.it.name + " " + fmtCount(t.it.animals / 1000, t.it.unit);
      var shareTxt = "全体の" + (t.share < 0.01 ? "0.001%未満" : trim(t.share.toFixed(2)) + "%");
      // 表示幅に収まらなければ2行に折る
      var oneLine = shareTxt + "。この図では描ける幅がありません";
      var subs = textWidth(oneLine, 12) <= shown - 4
        ? [oneLine] : [shareTxt, "この図では描ける幅がありません"];

      svg += '<line x1="' + x.toFixed(2) + '" y1="' + t.y.toFixed(2) +
        '" x2="' + x.toFixed(2) + '" y2="' + (H + u(13)).toFixed(2) +
        '" stroke="' + t.it.color + '" stroke-width="' + u(1.5).toFixed(2) + '"></line>';
      svg += '<path d="M' + (x - u(4.5)).toFixed(2) + " " + (H + u(13)).toFixed(2) +
        "L" + (x + u(4.5)).toFixed(2) + " " + (H + u(13)).toFixed(2) +
        "L" + x.toFixed(2) + " " + (H + u(4)).toFixed(2) +
        'Z" fill="' + t.it.color + '"></path>';
      svg += '<text x="' + tx + '" y="' + (H + u(36)).toFixed(2) + '" text-anchor="' + anchor +
        '" font-size="' + u(13.5).toFixed(2) + '" font-weight="700" fill="' + t.it.color + '">' +
        esc(head) + "</text>";
      subs.forEach(function (line, i) {
        svg += '<text x="' + tx + '" y="' + (H + u(56 + i * 17)).toFixed(2) + '" text-anchor="' + anchor +
          '" font-size="' + u(12).toFixed(2) + '" fill="' + C.muted + '">' + esc(line) + "</text>";
      });
      callout = Math.max(callout, 62 + subs.length * 17);
    });

    svg = '<svg viewBox="0 0 ' + W + " " + (H + u(tiny.length ? callout : 4)).toFixed(1) +
      '" role="img" aria-label="種類別の年間屠殺・殺処分数を面積比で表した図">' + svg + "</svg>";

    // 凡例は表組みにして、実数と割合を縦に揃える
    var lg = '<div class="species-key">';
    items.forEach(function (it) {
      var share = it.animals / total * 100;
      var shareTxt = share < 0.01 ? "0.001%未満" : trim(share.toFixed(share < 1 ? 2 : 1)) + "%";
      lg += '<span class="k-sw" style="background:' + it.color + '"></span>' +
        '<span class="k-name">' + esc(it.name) + ' <span class="k-year">' + it.year + "年</span></span>" +
        '<span class="k-num">' + fmtCount(it.animals / 1000, it.unit) + "</span>" +
        '<span class="k-share">' + shareTxt + "</span>";
    });
    lg += "</div>";

    // 表ビュー
    var tbl = '<details class="table-view"><summary>データを表で見る</summary><table><thead>' +
      "<tr><th>種類</th><th>年</th><th>数</th><th>割合</th></tr></thead><tbody>";
    items.forEach(function (it) {
      var share = it.animals / total * 100;
      tbl += "<tr><td>" + esc(it.name) + "</td><td>" + it.year + "</td><td>" +
        fmtCount(it.animals / 1000, it.unit) + "</td><td>" +
        (share < 0.01 ? "0.001%未満" : trim(share.toFixed(2)) + "%") + "</td></tr>";
    });
    tbl += "</tbody></table></details>";

    host.innerHTML = svg + lg + tbl;

    if (noteEl) {
      var note = "", dc = got.dogcat, b = got.broiler;
      if (dc && b) {
        var ratio = (b[1] * 1000) / dc[1];
        var ratioTxt = ratio >= 10000 ? "約" + fmtPlain(Math.round(ratio / 10000)) + "万倍"
          : "約" + fmtPlain(Math.round(ratio)) + "倍";
        note = "社会的な関心が集まる犬猫の殺処分（" + fmtCount(dc[1] / 1000, "頭") + "・" + dc[0] +
          "年度）に対し、ブロイラー1種だけでその" + ratioTxt +
          "が1年間に殺されています。面積比では図に描ける幅がないため、引き出し線で位置だけを示しました。";
      } else if (!got.pig) {
        note = "豚のと畜頭数は確報値を取得中のため、集計に含めていません。";
      }
      if (got.estimated) {
        note += (note ? " " : "") + "雄ひよこの殺処分数は公式統計が存在しないため、" +
          "雌雛（廃鶏として入れ替わる年間羽数）と概ね同数孵化するという前提での概算値です。";
      }
      noteEl.textContent = note;
    }
  }

  /* ---------- 労働力（FTE）当たり飼養頭数・羽数 ---------- */
  function renderFte(d, C) {
    var host = document.getElementById("fte-cards");
    if (!host) return;
    var fte = d.fte || {};
    var species = [
      { key: "layer", name: "採卵養鶏", color: C.layers, unit: "羽" },
      { key: "broiler", name: "ブロイラー養鶏", color: C.broilers, unit: "羽" },
      { key: "pig", name: "養豚", color: C.pigs, unit: "頭" },
      { key: "dairy", name: "酪農", color: C.dairy, unit: "頭" },
      { key: "beef", name: "肉用牛（肥育牛）", color: C.beef, unit: "頭" }
    ];
    host.innerHTML = "";
    species.forEach(function (s) {
      var rec = fte[s.key];
      if (!rec || !rec["2010"] || !rec["2022"]) return;
      var y0 = rec["2010"], y1 = rec["2022"];
      var maxV = Math.max(y0.per_fte, y1.per_fte);
      var ratio = y1.per_fte / y0.per_fte;

      var card = document.createElement("div");
      card.className = "tile fte-card";
      function bar(year, rec2) {
        var pct = maxV ? (rec2.per_fte / maxV * 100) : 0;
        return '<div class="fte-bar-row"><span class="fte-bar-year">' + year + "年</span>" +
          '<div class="fte-bar-track"><div class="fte-bar-fill" style="width:' + pct.toFixed(1) +
          "%;background:" + s.color + '"></div></div>' +
          '<span class="fte-bar-val">' + fmtPlain(Math.round(rec2.per_fte)) + s.unit + "</span></div>";
      }
      card.innerHTML =
        '<div class="label"><span class="key" style="background:' + s.color + '"></span>' + s.name + "</div>" +
        '<div class="fte-bars">' + bar(2010, y0) + bar(2022, y1) + "</div>" +
        '<div class="sub">1FTE（年間2,080時間）当たり・' + ratio.toFixed(1) + "倍に増加</div>";
      host.appendChild(card);
    });
  }

  /* ---------- 柱（縦組みの索引）の現在地表示 ---------- */
  function initRail() {
    var rail = document.getElementById("rail");
    if (!rail) return;
    var links = [].slice.call(rail.querySelectorAll("a"));
    var targets = links.map(function (a) { return document.querySelector(a.getAttribute("href")); });
    var ticking = false;
    function update() {
      ticking = false;
      var line = window.innerHeight * 0.32;
      var cur = 0;
      targets.forEach(function (t, i) {
        if (t && t.getBoundingClientRect().top <= line) cur = i;
      });
      links.forEach(function (a, i) {
        if (i === cur) a.setAttribute("aria-current", "true");
        else a.removeAttribute("aria-current");
      });
    }
    window.addEventListener("scroll", function () {
      if (!ticking) { ticking = true; requestAnimationFrame(update); }
    }, { passive: true });
    window.addEventListener("resize", update);
    update();
  }

  var DATA = null;

  function render() {
    var d = DATA, C = colors();
    var inv = d.inventory, sl = d.slaughter;

    /* データ注記: 確報のみ・未取得年は空欄 */
    if (d.meta && d.meta.generated_at) {
      var dt = new Date(d.meta.generated_at);
      var upd = document.getElementById("meta-updated");
      if (upd && !isNaN(dt)) {
        upd.textContent = dt.getFullYear() + "年" + (dt.getMonth() + 1) + "月" + dt.getDate() + "日";
      }
    }
    if (d.meta && d.meta.provisional) {
      document.getElementById("provisional-notice").hidden = false;
      document.getElementById("meta-note").textContent =
        "確報値のみを掲載しています。未取得・未公表の年次は空欄です（推計値では補完していません）。";
    } else if (d.meta && d.meta.generated_at) {
      document.getElementById("meta-note").textContent =
        "データ取得日時: " + d.meta.generated_at + "（e-Stat API）";
    }

    /* 主張: 年間屠殺数の合計 vs 人口 */
    var slYear = last(sl.broilers)[0];
    var slTotal = last(sl.broilers)[1] + (atYear(sl.layers_culled, slYear) || 0) +
      (atYear(sl.pigs, slYear) || 0); // 千
    var pop = last(inv.population)[1]; // 千人
    var ratio = slTotal / pop;
    document.getElementById("hero-figure").innerHTML =
      '1年間に<span class="hero-num">' + trim((slTotal / 1e5).toFixed(1)) +
      "億</span>の鶏と豚が屠殺されています。";
    document.getElementById("hero-caption").innerHTML =
      slYear + "年のブロイラー・廃鶏（採卵鶏）・豚の処理数の合計。日本の人口（<span class=\"nw\">" +
      fmtCount(pop, "人") + "</span>）の<span class=\"nw\">約" + ratio.toFixed(1) + "倍</span>にあたります。";

    /* 飼養数チャート — 鶏（羽）と豚（頭）は単位・規模が大きく異なるため別グラフに
       分ける。軸・ツールチップは実数（1羽・1頭・1人単位）で表記してスケールを
       直感的に伝える。内部のスケール計算は百万単位で行う（値は千 → /1000）。 */
    function toMillion(series) { return series.map(function (p) { return [p[0], p[1] / 1000]; }); }
    function countTip(val, s) { return fmtCount(val * 1000, (s && s.unit) || ""); }

    lineChart(document.getElementById("chart-inventory-birds"), {
      ariaLabel: "採卵鶏・ブロイラーの飼養数と日本の人口の推移",
      series: [
        { name: "採卵鶏", color: C.layers, unit: "羽", data: toMillion(inv.layers) },
        { name: "ブロイラー", color: C.broilers, unit: "羽", data: toMillion(inv.broilers) },
        { name: "日本の人口", color: C.population, unit: "人", data: toMillion(inv.population), context: true }
      ],
      yFmt: axisCount, tipFmt: countTip
    });
    // 豚は頭数が人口よりずっと小さく、対比しても差が伝わりにくいため単独で表示
    lineChart(document.getElementById("chart-inventory-pigs"), {
      ariaLabel: "豚の飼養頭数の推移", area: true, height: 280,
      series: [{ name: "豚", color: C.pigs, unit: "頭", data: toMillion(inv.pigs) }],
      yFmt: axisCount, tipFmt: countTip
    });

    /* 母豚チャート（万頭） */
    lineChart(document.getElementById("chart-sows"), {
      ariaLabel: "子取り用めす豚（母豚）の飼養頭数の推移",
      series: [{ name: "母豚", color: C.sows, data: inv.sows.map(function (p) { return [p[0], p[1] / 10]; }) }],
      area: true, height: 260,
      yFmt: function (t) { return fmtPlain(t); },
      tipFmt: function (val) { return trim(val.toFixed(1)) + "万頭"; }
    });

    /* 種別の屠殺数比較（面積比） */
    renderSpecies(d, C);

    /* 1戸当たり飼養数 — 単位が異なる鶏（羽/戸）と豚（頭/戸）を別グラフに分ける */
    var pf = d.per_farm;
    function per10k(t) { return t >= 10000 ? trim((t / 10000).toFixed(1)) + "万" : fmtPlain(t); }
    lineChart(document.getElementById("chart-perfarm-birds"), {
      ariaLabel: "鶏の1戸当たり飼養羽数の推移",
      series: [
        { name: "採卵鶏", color: C.layers, unit: "羽", data: pf.layers },
        { name: "ブロイラー", color: C.broilers, unit: "羽", data: pf.broilers }
      ],
      yFmt: per10k,
      tipFmt: function (val) { return fmtPlain(Math.round(val)) + "羽/戸"; }
    });
    lineChart(document.getElementById("chart-perfarm-pigs"), {
      ariaLabel: "豚の1戸当たり飼養頭数の推移", area: true, height: 280,
      series: [{ name: "豚", color: C.pigs, unit: "頭", data: pf.pigs }],
      yFmt: fmtPlain,
      tipFmt: function (val) { return fmtPlain(Math.round(val)) + "頭/戸"; }
    });

    /* 労働力（FTE）当たり飼養頭数・羽数 */
    renderFte(d, C);

    var pt = document.getElementById("perfarm-tiles");
    pt.innerHTML = "";
    [
      { name: "採卵鶏", color: C.layers, series: pf.layers, unit: "羽" },
      { name: "ブロイラー", color: C.broilers, series: pf.broilers, unit: "羽" },
      { name: "豚", color: C.pigs, series: pf.pigs, unit: "頭" }
    ].forEach(function (s) {
      if (!s.series.length) return;
      var lp = last(s.series), base = s.series[0];
      tile(pt, {
        label: s.name + " 1戸当たり", color: s.color,
        value: fmtPlain(lp[1]) + s.unit,
        sub: lp[0] + "年・" + base[0] + "年の" + (lp[1] / base[1]).toFixed(1) + "倍"
      });
    });
  }

  fetch("data/data.json")
    .then(function (r) {
      if (!r.ok) throw new Error("data.json の読み込みに失敗（" + r.status + "）");
      return r.json();
    })
    .then(function (d) {
      DATA = d;
      render();
      initRail();
      // 軸の余白は文字の実寸から決めているため、Webフォント確定後に引き直す
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(function () { if (DATA) render(); });
      }
    })
    .catch(function (e) {
      document.getElementById("hero-figure").textContent = "データを読み込めませんでした。";
      document.getElementById("hero-caption").textContent =
        e.message + " 時間をおいて再読み込みしてください。";
    });

  // ダーク/ライト切り替え時に再描画（色はCSS変数から都度読む）
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
      if (DATA) render();
    });
  }

  // 幅が変わったら引き直す（グラフは画面幅に合わせて実寸で描いているため）
  var rt, lastW = window.innerWidth;
  window.addEventListener("resize", function () {
    if (window.innerWidth === lastW) return; // モバイルのURLバー開閉などは無視
    lastW = window.innerWidth;
    clearTimeout(rt);
    rt = setTimeout(function () { if (DATA) render(); }, 160);
  });
})();
