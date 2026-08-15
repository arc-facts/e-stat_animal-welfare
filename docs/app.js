/* データで見る日本のアニマルウェルフェア — グラフ描画（依存ライブラリなし・SVG手描き） */
(function () {
  "use strict";

  var css = getComputedStyle(document.documentElement);
  function v(name) { return css.getPropertyValue(name).trim(); }
  function colors() {
    css = getComputedStyle(document.documentElement);
    return {
      layers: v("--layers"), layers2: v("--layers-2"), layers3: v("--layers-3"),
      broilers: v("--broilers"),
      pigs: v("--pigs"), sows: v("--sows"), population: v("--population"),
      dogcat: v("--dogcat"), dairy: v("--dairy"), beef: v("--beef"),
      rule: v("--rule"), rule2: v("--rule-2"),
      sheet: v("--sheet"), sheet2: v("--sheet-2"),
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

  /* 実数を「1億2,973万」のように、桁を落とさず日本語表記にする */
  function fmtOkuMan(n) {
    n = Math.round(n);
    if (n >= 1e8) {
      var oku = Math.floor(n / 1e8), man = Math.round((n % 1e8) / 1e4);
      return oku + "億" + (man ? man.toLocaleString("ja-JP") + "万" : "");
    }
    if (n >= 1e4) return Math.round(n / 1e4).toLocaleString("ja-JP") + "万";
    return n.toLocaleString("ja-JP");
  }
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

  /* ---------- ケージフリーの割合 ----------
     政府統計にケージフリーの系列が存在しないため確定値がない。出典ごとに
     数え方も対象範囲も違うので、1つの数字に丸めず、主たる推計を1,000マスの
     升目で示したうえで、推計の幅と数え方を表で併記する。 */
  var CF_SOURCE = {
    arc: "アニマルライツセンター",
    azabu: "麻布大学（大木茂）",
    weo: "World Egg Organization"
  };
  var CF_TYPE = { barn: "平飼い", aviary: "エイビアリー", free_range: "放牧" };

  function renderCagefree(d, C) {
    var host = document.getElementById("chart-cagefree");
    if (!host) return;
    var cf = d.cagefree || {};
    var est = (cf.estimates || []).slice();
    if (!est.length) { host.innerHTML = '<p class="empty-note">データを取得中です。</p>'; return; }

    // 主たる推計 = 全国推計のうち最新のもの（現状はARC）
    var main = est.filter(function (e) { return e.scope === "national" && e.birds; })
      .sort(function (a, b) { return b.year - a.year; })[0] || est[0];
    // 推計の幅は「出典ごとの最新値」で取る。古い年次（WEOの5.9%など）は
    // その出典自身が後に更新しているので、幅の上限には使わない。
    var latest = {};
    est.forEach(function (e) {
      if (!latest[e.source] || e.year > latest[e.source].year) latest[e.source] = e;
    });
    var maxShare = Object.keys(latest).reduce(function (m, k) {
      return Math.max(m, latest[k].share);
    }, 0);
    function pct(x) { return trim(x.toFixed(2)) + "%"; }

    /* --- 1,000マスの升目（1マス = 全体の0.1%） --- */
    var CELLS = 1000, GAP = 2;
    var W = Math.max(280, Math.round(host.clientWidth) || 720);
    var cols = W < 520 ? 25 : 50;
    var rows = CELLS / cols;
    var size = (W - (cols - 1) * GAP) / cols;
    var H = rows * (size + GAP) - GAP;
    var filled = main.share / 100 * CELLS;      // 14.83 マス
    var rangeCells = maxShare / 100 * CELLS;    // 35 マス

    var svg = '<svg viewBox="0 0 ' + W.toFixed(1) + " " + H.toFixed(1) + '" role="img" aria-label="' +
      "採卵鶏1,000羽あたりに換算した飼い方の内訳。1マスが全体の0.1%にあたり、" +
      "ケージフリーは" + main.share + "%（" + Math.round(filled * 10) / 10 + "マス分）" + '">';
    for (var i = 0; i < CELLS; i++) {
      var x = (i % cols) * (size + GAP), y = Math.floor(i / cols) * (size + GAP);
      var base = i < rangeCells ? C.layers : C.rule;
      var op = i < Math.floor(filled) ? 1 : (i < rangeCells ? 0.18 : 1);
      svg += '<rect x="' + x.toFixed(2) + '" y="' + y.toFixed(2) + '" width="' + size.toFixed(2) +
        '" height="' + size.toFixed(2) + '" fill="' + base + '" opacity="' + op + '"></rect>';
      // 端数のマスは、実数どおりの幅だけ塗る
      if (i === Math.floor(filled)) {
        svg += '<rect x="' + x.toFixed(2) + '" y="' + y.toFixed(2) + '" width="' +
          (size * (filled - Math.floor(filled))).toFixed(2) + '" height="' + size.toFixed(2) +
          '" fill="' + C.layers + '"></rect>';
      }
    }
    svg += "</svg>";

    var lg = '<div class="legend">' +
      '<span class="item"><span class="swatch sq" style="background:' + C.layers + '"></span>' +
      "ケージフリー " + pct(main.share) + "（" + fmtPlain(main.birds) + "羽・" + main.year + "年）</span>" +
      '<span class="item"><span class="swatch sq" style="background:' + C.layers + ';opacity:.18"></span>' +
      "他の推計ではこのあたりまで（最大 " + pct(maxShare) + "）</span>" +
      '<span class="item"><span class="swatch sq" style="background:' + C.rule + '"></span>' +
      "ケージ飼育</span></div>";

    host.innerHTML = svg + lg;

    var subEl = document.getElementById("cagefree-sub");
    if (subEl && main.total) {
      subEl.textContent = "1マス＝全体の0.1%（約" + fmtOkuMan(main.total / CELLS) + "羽）。" +
        "1,000マスで採卵鶏 " + fmtOkuMan(main.total) + "羽（畜産統計） / 出典: " +
        CF_SOURCE[main.source] + "（" + main.year + "年調査）";
    }
    var noteEl = document.getElementById("cagefree-note");
    if (noteEl) {
      noteEl.textContent = "淡いマスはすべてケージ飼育です。ケージフリーの数え方は出典によって違いますが、" +
        "最も多く見積もった推計でも" + pct(maxShare) + "にとどまります。";
    }

    /* --- 飼養形態別の内訳（一行の注として添える） --- */
    var typeHost = document.getElementById("cagefree-types");
    var types = (cf.types || []).filter(function (t) { return t.source === main.source; });
    if (typeHost && types.length) {
      var tTotal = types.reduce(function (a, t) { return a + t.birds; }, 0);
      typeHost.innerHTML = "内訳は " + types.map(function (t) {
        return "<strong>" + esc(CF_TYPE[t.type] || t.type) + "</strong> " +
          fmtPlain(t.birds) + "羽（" + (t.birds / tTotal * 100).toFixed(1) + "%・" +
          t.farms + "農場）";
      }).join("、") + "。";
    }

    /* --- 推計の一覧（数え方が違うことが要点なので表で示す） --- */
    var estHost = document.getElementById("cagefree-estimates");
    if (estHost) {
      // 新しい年次を上に、同じ年なら全国推計を先に置く
      var rowsHtml = est.slice().sort(function (a, b) {
        return b.year - a.year ||
          (a.scope === b.scope ? b.share - a.share : (a.scope === "national" ? -1 : 1));
      }).map(function (e) {
        return "<tr><td>" + esc(CF_SOURCE[e.source] || e.source) + "</td><td>" + e.year + "年</td><td><strong>" +
          pct(e.share) + "</strong></td><td>" +
          (e.scope === "sample" ? "調査回答内" : "全国") + "</td><td>" + esc(e.note || "") + "</td></tr>";
      }).join("");
      estHost.innerHTML = '<div class="table-wrap"><table class="datatable">' +
        "<thead><tr><th>出典</th><th>年</th><th>割合</th><th>対象</th><th>数え方</th></tr></thead>" +
        "<tbody>" + rowsHtml + "</tbody></table></div>";
    }
  }

  /* ---------- 各国のケージフリー割合（横棒） ---------- */
  function renderCagefreeWorld(d, C) {
    var host = document.getElementById("chart-cagefree-world");
    if (!host) return;
    var all = d.cagefree_world || [];
    var rows = all.filter(function (c) { return c.show; });
    if (!rows.length) { host.innerHTML = '<p class="empty-note">データを取得中です。</p>'; return; }
    host.innerHTML = "";

    var W = Math.max(280, Math.round(host.clientWidth) || 720);
    var narrow = W < 520;
    var BAR = narrow ? 17 : 20, GAP = narrow ? 9 : 10;
    var nameSize = narrow ? 11 : 13;
    var names = rows.map(function (c) { return c.country; });
    var labelW = Math.min(narrow ? 108 : 150, Math.round(widest(names, nameSize)) + 12);
    var valueW = narrow ? 42 : 94;
    var track = Math.max(60, W - labelW - valueW - 12);
    var H = rows.length * (BAR + GAP) - GAP;

    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img",
      "aria-label": "各国の採卵鶏に占めるケージフリーの割合" });

    rows.forEach(function (c, i) {
      var y = i * (BAR + GAP);
      var jp = c.code === "JPN";
      var lb = el("text", { x: labelW - 8, y: y + BAR * 0.5 + 4.5, "text-anchor": "end",
        "font-size": nameSize, fill: jp ? C.ink : C.ink2,
        "font-weight": jp ? 700 : 400 });
      lb.textContent = c.country;
      svg.appendChild(lb);

      svg.appendChild(el("rect", { x: labelW, y: y, width: track, height: BAR,
        fill: C.rule, rx: 2 }));
      svg.appendChild(el("rect", { x: labelW, y: y, width: Math.max(1.5, track * c.share / 100),
        height: BAR, fill: C.layers, opacity: jp ? 1 : 0.45, rx: 2 }));

      var vt = el("text", { x: labelW + track + 8, y: y + BAR * 0.5 + 4.5,
        "font-size": nameSize, fill: jp ? C.ink : C.ink2,
        "font-weight": jp ? 700 : 400, style: "font-variant-numeric: tabular-nums" });
      vt.textContent = trim(c.share.toFixed(1)) + "%" + (narrow ? "" : "  " + c.year);
      svg.appendChild(vt);
    });
    host.appendChild(svg);

    var lg = document.createElement("div");
    lg.className = "legend";
    lg.innerHTML = '<span class="item"><span class="swatch sq" style="background:' + C.layers +
      '"></span>日本</span><span class="item"><span class="swatch sq" style="background:' +
      C.layers + ';opacity:.45"></span>その他の国</span>';
    host.appendChild(lg);

    // 表ビューには掲載していない国も含めて全件、出典の区分つきで出す
    var det = document.createElement("details");
    det.className = "table-view";
    det.innerHTML = "<summary>データを表で見る（全" + all.length + "件・出典つき）</summary><table><thead>" +
      "<tr><th>国</th><th>年</th><th>割合</th><th>一次出典</th></tr></thead><tbody>" +
      all.map(function (c) {
        return "<tr><td>" + esc(c.country) + "</td><td>" + c.year + "</td><td>" +
          trim(c.share.toFixed(1)) + "%</td><td>" + esc(CF_BASIS[c.basis] || "—") + "</td></tr>";
      }).join("") + "</tbody></table></details>";
    host.appendChild(det);

    var sub = document.getElementById("cfworld-sub");
    if (sub) {
      var yrs = rows.map(function (c) { return c.year; });
      sub.textContent = "羽数ベース。国によって年が異なります（" +
        Math.min.apply(null, yrs) + "〜" + Math.max.apply(null, yrs) + "年）";
    }
  }

  /* 各国の値がどの一次資料に由来するかの区分。OWIDは集約元であって
     一次出典ではないため、国ごとの出所を表に出す。 */
  var CF_BASIS = {
    official_ec: "欧州委員会「Laying hens by way of keeping」",
    official_defra: "英国 Defra「UK egg statistics」",
    official_usda: "米国 USDA「Egg Markets Overview」",
    compilation_wfi: "Welfare Footprint Institute「Global hen inventory」(2022)",
    arc: "アニマルライツセンター「ケージフリー羽数調査」(2025)"
  };

  /* ---------- アジア各国のケージフリー率 ----------
     出典（GCAW）が日本を8%としており、国内調査の1.48%と大きく食い違う。
     数値はそのまま出したうえで、その食い違いを図の中でも示す。 */
  function renderCagefreeAsia(d, C) {
    var host = document.getElementById("cagefree-asia");
    if (!host) return;
    var rows = d.cagefree_asia || [];
    if (!rows.length) { host.innerHTML = ""; return; }
    rows = rows.slice().sort(function (a, b) { return b.share_pct - a.share_pct; });

    var W = Math.max(280, Math.round(host.clientWidth) || 720);
    var narrow = W < 520;
    var BAR = narrow ? 16 : 19, GAP = narrow ? 8 : 9;
    var nameSize = narrow ? 11.5 : 13;
    var labelW = Math.min(narrow ? 92 : 130,
      Math.round(widest(rows.map(function (r) { return r.country; }), nameSize)) + 12);
    var valueW = narrow ? 40 : 48;
    var track = Math.max(60, W - labelW - valueW - 10);
    var maxV = 20;
    var H = rows.length * (BAR + GAP) - GAP;

    var svg = '<svg viewBox="0 0 ' + W + " " + H +
      '" role="img" aria-label="アジア各国の採卵鶏に占めるケージフリーの割合">';
    rows.forEach(function (r, i) {
      var y = i * (BAR + GAP), jp = r.code === "JPN";
      svg += '<text x="' + (labelW - 8) + '" y="' + (y + BAR * 0.5 + 4.5) + '" text-anchor="end" font-size="' +
        nameSize + '" font-weight="' + (jp ? 700 : 400) + '" fill="' + (jp ? C.ink : C.ink2) + '">' +
        esc(r.country) + "</text>";
      svg += '<rect x="' + labelW + '" y="' + y + '" width="' + track + '" height="' + BAR +
        '" fill="' + C.rule + '" rx="2"></rect>';
      svg += '<rect x="' + labelW + '" y="' + y + '" width="' +
        Math.max(1.5, track * r.share_pct / maxV).toFixed(1) + '" height="' + BAR + '" fill="' +
        C.layers + '" opacity="' + (jp ? 1 : 0.45) + '" rx="2"></rect>';
      svg += '<text x="' + (labelW + track + 8) + '" y="' + (y + BAR * 0.5 + 4.5) + '" font-size="' +
        nameSize + '" font-weight="' + (jp ? 700 : 400) + '" fill="' + (jp ? C.ink : C.ink2) +
        '" style="font-variant-numeric: tabular-nums">' + trim(r.share_pct.toFixed(1)) + "%</text>";
    });
    svg += "</svg>";
    host.innerHTML = svg;
  }

  /* ---------- 1羽が使える面積（実面積比で描く） ----------
     すべて同じ縮尺（cm→px）で並べるので、図形の大小がそのまま面積の差になる。
     ケージフリーは載せない。平均面積を四角で描くと、その広さを1羽が
     動き回れるかのように読めてしまい、実態を取り違えさせるため。 */
  function renderSpace(d, C) {
    var host = document.getElementById("chart-space");
    if (!host) return;
    var items = (d.space_per_hen || []).filter(function (it) { return it.cm2; });
    if (!items.length) { host.innerHTML = ""; return; }
    var W = Math.max(280, Math.round(host.clientWidth) || 720);
    var cols = W < 560 ? 2 : items.length;
    var rows = Math.ceil(items.length / cols);
    var maxCm = 0;
    items.forEach(function (it) {
      maxCm = Math.max(maxCm, it.height_cm || Math.sqrt(it.cm2), it.width_cm || Math.sqrt(it.cm2));
    });
    var cellW = W / cols;
    var scale = (cellW - 22) / maxCm;      // px / cm
    var shapeH = maxCm * scale;
    var LABEL = 52;
    var rowH = shapeH + LABEL;
    var H = rows * rowH;

    var svg = '<svg viewBox="0 0 ' + W.toFixed(1) + " " + H.toFixed(1) +
      '" role="img" aria-label="飼育方式ごとの1羽当たり面積を実面積比で比べた図">';
    items.forEach(function (it, i) {
      var cx = (i % cols) * cellW + cellW / 2;
      var baseY = Math.floor(i / cols) * rowH + shapeH;
      var w = (it.width_cm || Math.sqrt(it.cm2)) * scale;
      var h = (it.height_cm || Math.sqrt(it.cm2)) * scale;
      var x = cx - w / 2, y = baseY - h;
      if (!it.outline) {
        svg += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + w.toFixed(1) +
          '" height="' + h.toFixed(1) + '" fill="' + C.layers + '" opacity="0.85" rx="2"></rect>';
      } else {
        svg += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + w.toFixed(1) +
          '" height="' + h.toFixed(1) + '" fill="none" stroke="' + C.ink2 +
          '" stroke-width="1.5" stroke-dasharray="5 4" rx="2"></rect>';
      }
      svg += '<text x="' + cx.toFixed(1) + '" y="' + (baseY + 20).toFixed(1) +
        '" text-anchor="middle" font-size="12.5" font-weight="700" fill="' + C.ink + '">' +
        esc(it.name) + "</text>";
      svg += '<text x="' + cx.toFixed(1) + '" y="' + (baseY + 37).toFixed(1) +
        '" text-anchor="middle" font-size="12" fill="' + C.ink2 +
        '" style="font-variant-numeric: tabular-nums">' +
        trim(it.cm2.toFixed(1)).replace(/\B(?=(\d{3})+(?!\d))/, ",") + "cm²</text>";
      svg += '<text x="' + cx.toFixed(1) + '" y="' + (baseY + 51).toFixed(1) +
        '" text-anchor="middle" font-size="11" fill="' + C.muted + '">' + esc(it.note) + "</text>";
    });
    svg += "</svg>";
    host.innerHTML = svg;
  }

  /* ---------- ケージフリーへの移行で減る痛みの時間 ----------
     出典: Welfare Footprint Institute。エンリッチドケージとの比較では
     Disabling の推定値が示されていないため、その棒は描かない。 */
  function renderPain(d, C) {
    var host = document.getElementById("chart-pain");
    if (!host) return;
    var rowsP = d.pain_hours || [];
    if (!rowsP.length) { host.innerHTML = ""; return; }
    var W = Math.max(280, Math.round(host.clientWidth) || 720);
    var maxV = rowsP.reduce(function (m, r) {
      return Math.max(m, r.vs_conventional || 0, r.vs_enriched || 0);
    }, 1);
    var BAR = 18, GAPB = 6, HEAD = 22, BLOCK = HEAD + BAR * 2 + GAPB + 20;
    var valueW = 74;
    var track = Math.max(60, W - valueW - 6);
    var H = rowsP.length * BLOCK;

    var svg = '<svg viewBox="0 0 ' + W.toFixed(1) + " " + H.toFixed(1) +
      '" role="img" aria-label="ケージフリーへの移行で減る痛みの時間">';
    rowsP.forEach(function (r, i) {
      var top = i * BLOCK;
      svg += '<text x="0" y="' + (top + 13) + '" font-size="12.5" font-weight="700" fill="' +
        C.ink + '">' + esc(r.name) + '<tspan font-size="11" font-weight="400" fill="' +
        C.muted + '">  ' + esc(r.name_en) + "</tspan></text>";
      [{ v: r.vs_conventional, op: 1 },
       { v: r.vs_enriched, op: 0.45 }].forEach(function (b, j) {
        var y = top + HEAD + j * (BAR + GAPB);
        if (b.v == null) {
          svg += '<text x="0" y="' + (y + BAR * 0.5 + 4) + '" font-size="11.5" fill="' +
            C.muted + '">エンリッチドケージとの比較は推定値の公表なし</text>';
          return;
        }
        svg += '<rect x="0" y="' + y + '" width="' + (track * b.v / maxV).toFixed(1) +
          '" height="' + BAR + '" fill="' + C.layers + '" opacity="' + b.op + '" rx="2"></rect>';
        svg += '<text x="' + (track + 8) + '" y="' + (y + BAR * 0.5 + 4.5) +
          '" font-size="12.5" fill="' + C.ink2 +
          '" style="font-variant-numeric: tabular-nums">' + fmtPlain(b.v) + "時間</text>";
      });
    });
    svg += "</svg>";

    host.innerHTML = svg +
      '<div class="legend"><span class="item"><span class="swatch sq" style="background:' +
      C.layers + '"></span>従来型（バタリー）ケージと比べて</span>' +
      '<span class="item"><span class="swatch sq" style="background:' + C.layers +
      ';opacity:.45"></span>エンリッチドケージと比べて</span></div>';
  }

  /* ---------- ブロイラーの飼養密度 ----------
     羽数で比べると体重差が隠れて「大差ない」ように見えるため、
     規制でも使われる kg/m² で並べる。日本には上限そのものがない。 */
  function renderBroilerDensity(d, C) {
    var host = document.getElementById("chart-broiler-density");
    if (!host) return;
    var rows = d.broiler_density || [];
    if (!rows.length) { host.innerHTML = ""; return; }

    var W = Math.max(280, Math.round(host.clientWidth) || 720);
    var narrow = W < 520;
    var maxV = rows.reduce(function (m, r) { return Math.max(m, r.kg_per_m2); }, 1);
    var BAR = narrow ? 26 : 32, GAP = narrow ? 30 : 34;
    var labelW = Math.min(narrow ? 118 : 176,
      Math.round(widest(rows.map(function (r) { return r.label; }), narrow ? 12 : 13)) + 12);
    var valueW = narrow ? 74 : 92;
    var track = Math.max(60, W - labelW - valueW - 10);
    var H = rows.length * (BAR + GAP) - GAP + 4;

    var svg = '<svg viewBox="0 0 ' + W + " " + H +
      '" role="img" aria-label="ブロイラーの飼養密度の比較（1平方メートル当たりのキログラム）">';
    rows.forEach(function (r, i) {
      var y = i * (BAR + GAP);
      var jp = r.key.indexOf("japan") === 0;
      var lb = el("text", {});
      svg += '<text x="' + (labelW - 8) + '" y="' + (y + BAR * 0.5 + 5) + '" text-anchor="end" font-size="' +
        (narrow ? 12 : 13) + '" font-weight="' + (jp ? 700 : 400) + '" fill="' +
        (jp ? C.ink : C.ink2) + '">' + esc(r.label) + "</text>";
      svg += '<rect x="' + labelW + '" y="' + y + '" width="' + track + '" height="' + BAR +
        '" fill="' + C.rule + '" rx="2"></rect>';
      svg += '<rect x="' + labelW + '" y="' + y + '" width="' + (track * r.kg_per_m2 / maxV).toFixed(1) +
        '" height="' + BAR + '" fill="' + C.broilers + '" opacity="' + (jp ? 1 : 0.45) + '" rx="2"></rect>';
      svg += '<text x="' + (labelW + track + 8) + '" y="' + (y + BAR * 0.5 + 6) + '" font-size="' +
        (narrow ? 14 : 16) + '" font-weight="700" fill="' + (jp ? C.ink : C.ink2) +
        '" style="font-variant-numeric: tabular-nums">' + trim(r.kg_per_m2.toFixed(2)) + "</text>";
      svg += '<text x="' + labelW + '" y="' + (y + BAR + 15) + '" font-size="11" fill="' + C.muted + '">' +
        (r.birds_per_m2 ? "1m²あたり " + trim(r.birds_per_m2.toFixed(2)) + "羽・" : "") +
        esc(r.note) + "</text>";
    });
    svg += "</svg>";

    var jaAvg = rows.filter(function (r) { return r.key === "japan_avg"; })[0];
    var bcc = rows.filter(function (r) { return r.key === "bcc"; })[0];
    var lead = "";
    if (jaAvg && bcc) {
      lead = '<p class="breakdown">日本の<strong>平均</strong>は、ベターチキンコミットメントが求める上限の<strong>' +
        (jaAvg.kg_per_m2 / bcc.kg_per_m2).toFixed(2) + "倍</strong>、EUの上限の<strong>" +
        (jaAvg.kg_per_m2 / 33).toFixed(2) + "倍</strong>です。</p>";
    }
    host.innerHTML = svg + '<p class="sub" style="margin-top:8px">単位はkg/m²（1m²あたりの体重の合計）</p>' + lead;
  }

  /* ---------- 母豚の一生（横から見たコイル） ----------
     時間は左から右へ進み、1巻き＝1回の繁殖サイクル（159日）。
     手前に来る半周を太く濃く、奥へ回る半周を細く淡く描いて立体に見せる。
     巻きどうしを重ねることで、同じ輪を何度もくぐらされる感じを出す。 */
  function renderSowLife(d, C) {
    var host = document.getElementById("chart-sow-life");
    if (!host) return;
    var s = d.sow_cycle || {};
    if (!s.cull_age_days) { host.innerHTML = '<p class="empty-note">データを取得中です。</p>'; return; }

    var mate = s.first_mating_age_days, preg = s.gestation_days,
        lact = s.lactation_days, fi = s.farrowing_interval_days,
        nc = s.breeding_cycles, end = s.cull_age_days;
    var dry = fi - preg - lact;

    var W = Math.max(280, Math.round(host.clientWidth) || 720);
    var narrowH = W < 520;
    var LEAD = W * 0.08, RIGHT = narrowH ? 10 : 16;
    var coilW = W - LEAD - RIGHT;
    var advance = coilW / nc;
    var A = Math.min(narrowH ? 58 : 124, advance * 0.95);
    var TOP = narrowH ? 30 : 34;
    var cy = TOP + A + 4;
    var H = cy + A + 26;
    var BW = narrowH ? 9 : 13;

    /* 弧の長さが日数に比例するように、角度を取り直す。
       角度を時間に正比例させると、輪の上下（動きが遅いところ）と
       中間（速いところ）で同じ日数でも線の長さが変わってしまい、
       妊娠と授乳の比が目で読めなくなるため。
       1巻きの形はどの巻きでも同じなので、1巻き分の対応表を作れば足りる。 */
    var LUT = (function () {
      var N = 720, ths = [0], lens = [0], acc = 0;
      var px = 0, py = -A;
      for (var i = 1; i <= N; i++) {
        var th = i / N * Math.PI * 2;
        var qx = advance * th / (Math.PI * 2), qy = -A * Math.cos(th);
        acc += Math.sqrt((qx - px) * (qx - px) + (qy - py) * (qy - py));
        px = qx; py = qy; ths.push(th); lens.push(acc);
      }
      return { ths: ths, lens: lens, total: acc };
    })();
    function thetaAt(u) {                 // u: 1巻きのなかの時間の割合 0〜1
      var target = u * LUT.total, lo = 0, hi = LUT.lens.length - 1;
      while (lo < hi - 1) {
        var mid = (lo + hi) >> 1;
        if (LUT.lens[mid] <= target) lo = mid; else hi = mid;
      }
      var seg = LUT.lens[hi] - LUT.lens[lo];
      var f = seg > 0 ? (target - LUT.lens[lo]) / seg : 0;
      return LUT.ths[lo] + (LUT.ths[hi] - LUT.ths[lo]) * f;
    }
    function pos(day) {
      var t = (day - mate) / fi;
      var turn = Math.min(Math.floor(t), nc - 1);
      var th = thetaAt(Math.min(Math.max(t - turn, 0), 1));
      return {
        x: LEAD + turn * advance + advance * th / (Math.PI * 2),
        y: cy - A * Math.cos(th),
        front: Math.sin(th) >= 0
      };
    }
    function phaseOf(day) {
      var t = (day - mate) % fi;
      return t < preg ? "preg" : (t < preg + lact ? "lact" : "dry");
    }
    var PHASE = { preg: [C.sows, 1], lact: [C.pigs, 1], dry: [C.pigs, 0.32] };

    var runs = [], cur = null;
    for (var day = mate; day <= end; day += 0.5) {
      var q = pos(day), ph = phaseOf(Math.min(day, end - 0.25));
      if (!cur || cur.ph !== ph || cur.front !== q.front) {
        if (cur) { cur.pts.push(q); runs.push(cur); }
        cur = { ph: ph, front: q.front, pts: [q] };
      } else { cur.pts.push(q); }
    }
    if (cur) runs.push(cur);
    function dOf(r) {
      return r.pts.map(function (q, i) {
        return (i ? "L" : "M") + q.x.toFixed(2) + " " + q.y.toFixed(2);
      }).join("");
    }

    var svg = '<svg viewBox="0 0 ' + W.toFixed(1) + " " + H.toFixed(1) +
      '" role="img" aria-label="' + "母豚の一生。" + mate + "日齢の初回交配から" + fi +
      "日ごとに" + nc + "回の妊娠と出産を繰り返し、" + end + '日齢で屠殺される">';

    svg += '<path d="M0 ' + (cy - A).toFixed(2) + "L" + LEAD.toFixed(2) + " " + (cy - A).toFixed(2) +
      '" fill="none" stroke="' + C.rule + '" stroke-width="' + BW + '"></path>';

    [false, true].forEach(function (isFront) {
      runs.filter(function (r) { return r.front === isFront; }).forEach(function (r) {
        var st = PHASE[r.ph];
        // 色は凡例と完全に一致させ、奥行きは線の太さと重なり順だけで示す
        svg += '<path d="' + dOf(r) + '" fill="none" stroke="' + st[0] +
          '" stroke-width="' + (isFront ? BW : BW * 0.66).toFixed(1) +
          '" stroke-opacity="' + st[1] +
          '" stroke-linecap="butt"></path>';
      });
    });

    for (var k = 0; k < nc; k++) {
      var q2 = pos(mate + k * fi + preg);
      svg += '<circle cx="' + q2.x.toFixed(2) + '" cy="' + q2.y.toFixed(2) + '" r="' +
        (BW * 0.3).toFixed(1) + '" fill="' + C.sheet + '"></circle>';
    }

    var pe = pos(end);
    svg += '<line x1="' + pe.x.toFixed(2) + '" y1="' + (TOP - 6) + '" x2="' + pe.x.toFixed(2) +
      '" y2="' + pe.y.toFixed(2) + '" stroke="' + C.ink + '" stroke-width="1.5"></line>';
    svg += '<text x="' + W + '" y="' + (TOP - 11) +
      '" text-anchor="end" font-size="12" font-weight="700" fill="' + C.ink + '">屠殺 ' +
      fmtPlain(end) + "日齢</text>";
    svg += '<text x="0" y="' + (H - 6) + '" font-size="11" fill="' + C.muted +
      '">交配前 ' + mate + "日齢</text>";
    svg += '<text x="' + W + '" y="' + (H - 6) + '" text-anchor="end" font-size="11" fill="' +
      C.muted + '">1巻き＝繁殖サイクル ' + fi + "日 × " + nc + "回</text>";
    svg += "</svg>";

    var lg = '<div class="legend">' +
      '<span class="item"><span class="swatch sq" style="background:' + C.sows +
      '"></span>妊娠 ' + preg + "日（妊娠ストール）</span>" +
      '<span class="item"><span class="swatch sq" style="background:' + C.pigs +
      '"></span>授乳 ' + lact + "日（分娩ストール）</span>" +
      '<span class="item"><span class="swatch sq" style="background:' + C.pigs +
      ';opacity:.32"></span>離乳から次の受胎まで ' + dry + "日</span></div>";
    host.innerHTML = svg + lg;

    var breeding = end - mate, confined = nc * (preg + lact);
    var note = document.getElementById("sowlife-note");
    if (note) {
      note.innerHTML = "ひと巻きが1回の妊娠・出産です。初回交配の" + mate + "日齢から" + fi +
        "日ごとに同じことが" + nc + "回繰り返され、" + fmtPlain(end) + "日齢（約" +
        (end / 365).toFixed(1) + "歳）で屠殺されます。" +
        "繁殖に使われる" + fmtPlain(breeding) + "日のうち、妊娠か授乳にあたる期間が<strong>" +
        fmtPlain(confined) + "日（" + Math.round(confined / breeding * 100) + "%）</strong>。" +
        "日本では妊娠中の母豚の約9割が妊娠ストールに、授乳期は分娩ストールに入れられるため、" +
        "この期間の大半で母豚は向きを変えることができません。" +
        "淘汰された母豚は廃用母豚として食肉になります。" +
        "豚の寿命は10〜15年とされますが、その3分の1にも満たない年齢です。";
    }
    var sub = document.getElementById("sowlife-sub");
    if (sub) {
      sub.textContent = "1巻き＝1回の繁殖サイクル（" + fi +
        "日）/ 出典: 広岡博之（2018）日本畜産学会報 89(4) のベース条件（生産現場への聞き取りによる）";
    }
  }

  /* ---------- 品種別の成長（Zuidhof 2014 の体重を自前の図に起こす） ----------
     原論文の図は写真で、著作権は Poultry Science Association にある。
     体重の数値は事実なので、円の面積を体重に比例させた図として描き直す。 */
  function renderBroilerGrowth(d, C) {
    var host = document.getElementById("chart-broiler-growth");
    if (!host) return;
    var rows = d.broiler_growth || [];
    if (!rows.length) { host.innerHTML = ""; return; }

    var strains = [], days = [];
    rows.forEach(function (r) {
      if (strains.indexOf(r.strain) < 0) strains.push(r.strain);
      if (days.indexOf(r.day) < 0) days.push(r.day);
    });
    strains.sort(function (a, b) { return a - b; });
    days.sort(function (a, b) { return a - b; });
    function wOf(st, dy) {
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].strain === st && rows[i].day === dy) return rows[i].body_weight_g;
      }
      return 0;
    }
    var maxW = rows.reduce(function (m, r) { return Math.max(m, r.body_weight_g); }, 1);

    var W = Math.max(280, Math.round(host.clientWidth) || 720);
    var GUT = W < 480 ? 40 : 56;          // 日齢を書く左の余白
    var HEAD = 22;                         // 品種名の行
    var cellW = (W - GUT) / strains.length;
    var Rmax = Math.min(cellW / 2 - (W < 480 ? 4 : 10), 130);
    function radius(w) { return Rmax * Math.sqrt(w / maxW); }

    var rowH = days.map(function (dy) {
      var r = Math.max.apply(null, strains.map(function (st) { return radius(wOf(st, dy)); }));
      return Math.max(2 * r, 10) + 30;
    });
    var H = HEAD + rowH.reduce(function (a, b) { return a + b; }, 0);

    var svg = '<svg viewBox="0 0 ' + W.toFixed(1) + " " + H.toFixed(1) +
      '" role="img" aria-label="1957年・1978年・2005年の品種を同じ条件で育てたときの体重の違い">';
    strains.forEach(function (st, i) {
      svg += '<text x="' + (GUT + cellW * (i + 0.5)).toFixed(1) + '" y="14" text-anchor="middle" ' +
        'font-size="12.5" font-weight="700" fill="' + C.ink + '">' + st + "年</text>";
    });
    var y = HEAD;
    days.forEach(function (dy, j) {
      var cy = y + rowH[j] / 2 - 8;
      svg += '<text x="0" y="' + (cy + 4).toFixed(1) + '" font-size="12" fill="' + C.ink2 +
        '" style="font-variant-numeric: tabular-nums">' + dy + "日齢</text>";
      strains.forEach(function (st, i) {
        var w = wOf(st, dy), r = radius(w);
        var cx = GUT + cellW * (i + 0.5);
        svg += '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="' + r.toFixed(1) +
          '" fill="' + C.broilers + '" opacity="' + (st === strains[strains.length - 1] ? 0.95 : 0.55) + '"></circle>';
        svg += '<text x="' + cx.toFixed(1) + '" y="' + (cy + r + 16).toFixed(1) +
          '" text-anchor="middle" font-size="11.5" fill="' + C.ink2 +
          '" style="font-variant-numeric: tabular-nums">' + fmtPlain(w) + "g</text>";
      });
      y += rowH[j];
    });
    svg += "</svg>";
    host.innerHTML = svg;
  }

  /* ---------- 一生の年表 ----------
     出来事の数が多く説明も要るため、帯ではなく縦の年表で組む。
     日齢は各項目に書くので、横方向の目盛りは置かない。 */
  function renderTimeline(hostId, rows, C) {
    var host = document.getElementById(hostId);
    if (!host) return;
    if (!rows || !rows.length) { host.innerHTML = '<p class="empty-note">データを取得中です。</p>'; return; }
    var items = rows.slice().sort(function (a, b) { return a.day - b.day; });

    var list = '<ol class="tl">';
    items.forEach(function (it) {
      var src = it.source_url
        ? ' <a class="tl-src" href="' + esc(it.source_url) + '">出典</a>'
        : ' <span class="tl-src tl-src--none">出典未特定</span>';
      list += '<li><span class="tl-day">' + esc(it.day_label) + "</span>" +
        '<div class="tl-body"><b class="tl-event">' + esc(it.event) + "</b>" +
        '<p class="tl-detail">' + esc(it.detail) + src + "</p></div></li>";
    });
    list += "</ol>";

    host.innerHTML = list;
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

    /* ケージフリーの割合と、各国との比較 */
    renderCagefree(d, C);
    renderCagefreeWorld(d, C);
    renderCagefreeAsia(d, C);

    /* ケージとケージフリーで鶏の一生はどう変わるか（Our World in Data の内容） */
    renderSpace(d, C);
    renderPain(d, C);
    renderBroilerDensity(d, C);

    /* 一生の年表 */
    renderTimeline("chart-hen-life", d.hen_timeline, C);
    renderTimeline("chart-broiler-life", d.broiler_timeline, C);
    renderBroilerGrowth(d, C);

    /* 母豚の一生 */
    renderSowLife(d, C);

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

  // 幅が変わったら引き直す（グラフは画面幅に合わせて実寸で描いているため）
  var rt, lastW = window.innerWidth;
  window.addEventListener("resize", function () {
    if (window.innerWidth === lastW) return; // モバイルのURLバー開閉などは無視
    lastW = window.innerWidth;
    clearTimeout(rt);
    rt = setTimeout(function () { if (DATA) render(); }, 160);
  });
})();
