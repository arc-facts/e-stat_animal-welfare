/* 日本の畜産動物はいま — グラフ描画（依存ライブラリなし・SVG手描き） */
(function () {
  "use strict";

  var css = getComputedStyle(document.documentElement);
  function v(name) { return css.getPropertyValue(name).trim(); }
  function colors() {
    css = getComputedStyle(document.documentElement);
    return {
      layers: v("--layers"), broilers: v("--broilers"), pigs: v("--pigs"),
      sows: v("--sows"), population: v("--population"),
      grid: v("--grid"), axis: v("--axis"), surface: v("--surface"),
      ink: v("--ink"), ink2: v("--ink-2"), muted: v("--muted")
    };
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

  function last(series) { return series[series.length - 1]; }
  function prev(series) { return series[series.length - 2]; }
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

  /* ---------- 折れ線グラフ ----------
     opts: { series: [{name, color, data:[[year,val]], context?}],
             height?, yFmt, tipFmt, unitLabel, legend? } */
  function lineChart(container, opts) {
    container.innerHTML = "";
    var C = colors();
    var W = opts.width || 720, H = opts.height || 340;
    var pad = { l: 46, r: 84, t: 14, b: 30 };
    if (opts.compact) { pad.r = 20; pad.l = 62; }

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

    function X(year) { return pad.l + (year - x0) / (x1 - x0) * (W - pad.l - pad.r); }
    function Y(val) { return pad.t + (1 - val / yMax) * (H - pad.t - pad.b); }

    var svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img",
      "aria-label": opts.ariaLabel || "折れ線グラフ" });

    // グリッド（横線・ヘアライン）と目盛りラベル
    ticks.forEach(function (t) {
      svg.appendChild(el("line", { x1: pad.l, x2: W - pad.r, y1: Y(t), y2: Y(t),
        stroke: t === 0 ? C.axis : C.grid, "stroke-width": 1 }));
      var lbl = el("text", { x: pad.l - 8, y: Y(t) + 4, "text-anchor": "end",
        "font-size": 11, fill: C.muted, style: "font-variant-numeric: tabular-nums" });
      lbl.textContent = opts.yFmt ? opts.yFmt(t) : fmtPlain(t);
      svg.appendChild(lbl);
    });
    // X軸目盛り
    var span = x1 - x0, stepX = span > 18 ? 5 : (span > 8 ? 5 : 2);
    for (var yr = Math.ceil(x0 / stepX) * stepX; yr <= x1; yr += stepX) {
      var xl = el("text", { x: X(yr), y: H - 8, "text-anchor": "middle",
        "font-size": 11, fill: C.muted, style: "font-variant-numeric: tabular-nums" });
      xl.textContent = yr;
      svg.appendChild(xl);
    }

    // 面ワッシュ（単一系列のみ）
    if (series.length === 1 && opts.area) {
      var s0 = series[0], d = "M" + X(s0.data[0][0]) + " " + Y(0);
      s0.data.forEach(function (p) { d += " L" + X(p[0]) + " " + Y(p[1]); });
      d += " L" + X(last(s0.data)[0]) + " " + Y(0) + " Z";
      svg.appendChild(el("path", { d: d, fill: s0.color, opacity: 0.1 }));
    }

    // 線・終端ドット
    series.forEach(function (s) {
      var d = "";
      s.data.forEach(function (p, i) { d += (i ? " L" : "M") + X(p[0]) + " " + Y(p[1]); });
      svg.appendChild(el("path", { d: d, fill: "none", stroke: s.color,
        "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round",
        "stroke-dasharray": s.context ? "" : "" }));
      var lp = last(s.data);
      svg.appendChild(el("circle", { cx: X(lp[0]), cy: Y(lp[1]), r: 6, fill: C.surface }));
      svg.appendChild(el("circle", { cx: X(lp[0]), cy: Y(lp[1]), r: 4, fill: s.color }));
    });

    // 終端の直接ラベル（重なるものは省略 → 凡例とツールチップが担う）
    if (!opts.compact) {
      var placed = [];
      series.forEach(function (s) {
        var lp = last(s.data), y = Y(lp[1]);
        var collide = placed.some(function (py) { return Math.abs(py - y) < 15; });
        if (collide) return;
        placed.push(y);
        var t = el("text", { x: X(lp[0]) + 10, y: y + 4, "font-size": 11.5, fill: C.ink2 });
        t.textContent = s.name;
        svg.appendChild(t);
      });
    }

    // クロスヘア＋ツールチップ
    var cross = el("line", { y1: pad.t, y2: H - pad.b, stroke: C.axis,
      "stroke-width": 1, visibility: "hidden" });
    svg.appendChild(cross);
    var hoverDots = series.map(function (s) {
      var g = el("g", { visibility: "hidden" });
      g.appendChild(el("circle", { r: 6, fill: C.surface }));
      g.appendChild(el("circle", { r: 4, fill: s.color }));
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
      var html = '<div class="t-year">' + year + '年</div>';
      series.forEach(function (s, i) {
        var val = atYear(s.data, year);
        var g = hoverDots[i];
        if (val == null) { g.setAttribute("visibility", "hidden"); return; }
        g.setAttribute("transform", "translate(" + X(year) + "," + Y(val) + ")");
        g.setAttribute("visibility", "visible");
        html += '<div class="t-row"><span class="t-name"><span class="dot" style="background:' +
          s.color + '"></span>' + s.name + '</span><span class="t-val">' +
          opts.tipFmt(val) + "</span></div>";
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
      var year = x0 + (ev.clientX - rect.left) / rect.width * W / 1 ;
      // 画面座標 → viewBox座標 → 最近傍の年
      var vx = (ev.clientX - rect.left) * (W / rect.width);
      var t = x0 + (vx - pad.l) / (W - pad.l - pad.r) * (x1 - x0);
      var best = 0, bd = Infinity;
      years.forEach(function (yv, i) {
        var dd = Math.abs(yv - t);
        if (dd < bd) { bd = dd; best = i; }
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
        item.innerHTML = '<span class="swatch" style="background:' + s.color + '"></span>' + s.name;
        lg.appendChild(item);
      });
      container.appendChild(lg);
    }

    // 表ビュー（アクセシブルな双子）
    var det = document.createElement("details");
    det.className = "table-view";
    var head = "<tr><th>年</th>" + series.map(function (s) { return "<th>" + s.name + "</th>"; }).join("") + "</tr>";
    var body = years.map(function (year) {
      return "<tr><td>" + year + "</td>" + series.map(function (s) {
        var val = atYear(s.data, year);
        return "<td>" + (val == null ? "—" : opts.tipFmt(val)) + "</td>";
      }).join("") + "</tr>";
    }).join("");
    det.innerHTML = "<summary>データを表で見る</summary><table><thead>" + head + "</thead><tbody>" + body + "</tbody></table>";
    container.appendChild(det);
  }

  /* ---------- ページ構築 ---------- */
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

  var DATA = null;

  function render() {
    var d = DATA, C = colors();
    var inv = d.inventory, sl = d.slaughter;

    /* 暫定データ注記 */
    if (d.meta && d.meta.provisional) {
      document.getElementById("provisional-notice").hidden = false;
      document.getElementById("meta-note").textContent =
        "現在のグラフは公表資料から整理した暫定値を含みます。e-Stat APIによる確定値取得後に自動で置き換わります。";
    } else if (d.meta && d.meta.generated_at) {
      document.getElementById("meta-note").textContent =
        "データ取得日時: " + d.meta.generated_at + "（e-Stat API）";
    }

    /* ヒーロー: 年間屠殺数の合計 vs 人口 */
    var slYear = last(sl.broilers)[0];
    var slTotal = last(sl.broilers)[1] + (atYear(sl.layers_culled, slYear) || 0) +
      (atYear(sl.pigs, slYear) || 0); // 千
    var pop = last(inv.population)[1]; // 千人
    var ratio = slTotal / pop;
    document.getElementById("hero-figure").innerHTML =
      "年間 " + trim((slTotal / 1e5).toFixed(1)) + "億<small> の鶏と豚が屠殺されています</small>";
    document.getElementById("hero-caption").textContent =
      slYear + "年のブロイラー・廃鶏（採卵鶏）・豚の処理数の合計。日本の人口（" +
      fmtCount(pop, "人") + "）の約" + ratio.toFixed(1) + "倍にあたります。";

    /* KPIタイル */
    var tiles = document.getElementById("kpi-tiles");
    tiles.innerHTML = "";
    function kpi(name, series, unit, color, subExtra) {
      var lp = last(series), pp = prev(series);
      var delta = pp ? ((lp[1] - pp[1]) / pp[1] * 100) : null;
      tile(tiles, {
        label: name, color: color,
        value: fmtCount(lp[1], unit),
        sub: lp[0] + "年" + (delta != null ? "・前回比 " + (delta >= 0 ? "+" : "") + delta.toFixed(1) + "%" : "") +
          (subExtra ? "・" + subExtra : "")
      });
    }
    kpi("採卵鶏（種鶏を除く成鶏めす）", inv.layers, "羽", C.layers);
    kpi("ブロイラー（肉用鶏）", inv.broilers, "羽", C.broilers);
    kpi("豚", inv.pigs, "頭", C.pigs, "うち母豚 " + fmtCount(last(inv.sows)[1], "頭"));
    kpi("日本の人口", inv.population, "人", C.population);

    /* 飼養数チャート（百万単位）— 鶏（羽）と豚（頭）は単位・規模が大きく
       異なるため別グラフに分け、両方に人口を対比の基準線として表示する */
    function toMillion(series) { return series.map(function (p) { return [p[0], p[1] / 1000]; }); }
    lineChart(document.getElementById("chart-inventory-birds"), {
      ariaLabel: "採卵鶏・ブロイラーの飼養数と日本の人口の推移",
      series: [
        { name: "採卵鶏", color: C.layers, data: toMillion(inv.layers) },
        { name: "ブロイラー", color: C.broilers, data: toMillion(inv.broilers) },
        { name: "日本の人口", color: C.population, data: toMillion(inv.population), context: true }
      ],
      yFmt: function (t) { return fmtPlain(t); },
      tipFmt: function (val) { return trim(val.toFixed(1)) + "百万"; }
    });
    lineChart(document.getElementById("chart-inventory-pigs"), {
      ariaLabel: "豚の飼養頭数と日本の人口の推移",
      series: [
        { name: "豚", color: C.pigs, data: toMillion(inv.pigs) },
        { name: "日本の人口", color: C.population, data: toMillion(inv.population), context: true }
      ],
      yFmt: function (t) { return fmtPlain(t); },
      tipFmt: function (val) { return trim(val.toFixed(1)) + "百万"; }
    });

    /* 母豚チャート（万頭） */
    lineChart(document.getElementById("chart-sows"), {
      ariaLabel: "子取り用めす豚（母豚）の飼養頭数の推移",
      series: [{ name: "母豚", color: C.sows, data: inv.sows.map(function (p) { return [p[0], p[1] / 10]; }) }],
      area: true, height: 260,
      yFmt: function (t) { return fmtPlain(t); },
      tipFmt: function (val) { return trim(val.toFixed(1)) + "万頭"; }
    });

    /* 屠殺数 — スモールマルチプル */
    var sm = document.getElementById("chart-slaughter");
    sm.innerHTML = "";
    [
      { id: "broilers", name: "ブロイラー", color: C.broilers, unit: "羽",
        note: "生後約50日で屠殺", data: sl.broilers },
      { id: "layers_culled", name: "廃鶏（採卵鶏など成鶏）", color: C.layers, unit: "羽",
        note: "産卵率が落ちた鶏", data: sl.layers_culled },
      { id: "pigs", name: "豚", color: C.pigs, unit: "頭",
        note: "生後約6か月で屠殺", data: sl.pigs }
    ].forEach(function (spec) {
      var card = document.createElement("div");
      card.className = "card";
      card.innerHTML = "<h3>" + spec.name + "</h3><p class='sub'>年間処理数・" + spec.note + "</p>";
      var chart = document.createElement("div");
      chart.className = "chart";
      card.appendChild(chart);
      sm.appendChild(card);
      lineChart(chart, {
        ariaLabel: spec.name + "の年間処理数の推移",
        compact: true, width: 340, height: 200, area: true,
        series: [{ name: spec.name, color: spec.color, data: spec.data }],
        yFmt: function (t) { return t >= 100000 ? trim((t / 100000).toFixed(1)) + "億" : (t >= 10 ? fmtPlain(t / 10) + "万" : t); },
        tipFmt: function (val) { return fmtCount(val, spec.unit); }
      });
    });

    /* 1戸当たり（2000年=100の指数） */
    function indexed(series) {
      var base = series.length ? series[0][1] : 1;
      return series.map(function (p) { return [p[0], p[1] / base * 100]; });
    }
    var pf = d.per_farm;
    lineChart(document.getElementById("chart-perfarm"), {
      ariaLabel: "1戸当たり飼養数の伸び（2000年を100とした指数）",
      series: [
        { name: "採卵鶏", color: C.layers, data: indexed(pf.layers) },
        { name: "ブロイラー", color: C.broilers, data: indexed(pf.broilers) },
        { name: "豚", color: C.pigs, data: indexed(pf.pigs) }
      ],
      yFmt: fmtPlain,
      tipFmt: function (val) { return fmtPlain(val) + "（2000年=100）"; }
    });

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
    .then(function (d) { DATA = d; render(); })
    .catch(function (e) {
      document.getElementById("hero-caption").textContent =
        "データの読み込みに失敗しました: " + e.message;
    });

  // ダーク/ライト切り替え時に再描画（色はCSS変数から都度読む）
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
      if (DATA) render();
    });
  }
})();
