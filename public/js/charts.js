// Column charts in plain HTML: one or two series (this year / last year),
// a shared baseline, recessive gridlines, a tooltip on hover and keyboard
// focus, and a legend when there are two series. Values are always also
// shown in a table next to the chart, so nothing depends on hovering.

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}

/**
 * @param {HTMLElement} el
 * @param {object} o
 * @param {Array<{label: string, values: number[], tip?: string}>} o.data  one entry per column group
 * @param {string[]} o.series  series names (1 or 2)
 * @param {number} [o.max]  fixed top of the scale (e.g. 100 for percentages)
 * @param {(v:number)=>string} [o.format]  tick and tooltip formatting
 * @param {number} [o.labelEvery]  show every nth x label
 */
function columnChart(el, { data, series, max, format = (v) => String(v), labelEvery = 1 }) {
  const top = max ?? niceMax(Math.max(0, ...data.flatMap((d) => d.values)));
  const ticks = [0, 0.5, 1].map((f) => top * f);
  const legend = series.length > 1
    ? `<div class="chart-legend">${series.map((s, i) => `<span><i class="key s${i + 1}"></i>${esc(s)}</span>`).join('')}</div>`
    : '';
  const cols = data.map((d, i) => {
    const tip = d.tip || `<strong>${d.values.map(format).join(' / ')}</strong><br>${esc(d.label)}`;
    const bars = d.values.map((v, s) => {
      const h = top ? Math.max(0, Math.min(100, (v / top) * 100)) : 0;
      return `<span class="bar s${s + 1}" data-h="${h}"></span>`;
    }).join('');
    const label = i % labelEvery === 0 ? esc(d.label) : '';
    return `<div class="col" tabindex="0" data-tip="${esc(tip)}" aria-label="${esc(d.label)}: ${esc(d.values.map(format).join(', '))}">
      <div class="bars">${bars}</div><span class="xl">${label}</span></div>`;
  }).join('');
  el.innerHTML = `${legend}
    <div class="plot">
      <div class="yaxis">${ticks.slice().reverse().map((t) => `<span>${esc(format(t))}</span>`).join('')}</div>
      <div class="area">
        ${ticks.map((t) => `<i class="gridline" data-y="${(t / top) * 100}"></i>`).join('')}
        <div class="cols">${cols}</div>
      </div>
    </div>`;
  applySizes(el);
}

/**
 * The page's Content-Security-Policy forbids inline style attributes, so
 * sizes travel as data-h / data-y / data-w and are set through the CSSOM.
 */
function applySizes(root) {
  for (const b of root.querySelectorAll('[data-h]')) b.style.setProperty('--h', `${b.dataset.h}%`);
  for (const g of root.querySelectorAll('[data-y]')) g.style.setProperty('--y', String(Number(g.dataset.y) / 100));
  for (const w of root.querySelectorAll('[data-w]')) w.style.setProperty('--w', `${w.dataset.w}%`);
}
