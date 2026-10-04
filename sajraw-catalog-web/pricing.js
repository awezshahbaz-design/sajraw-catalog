// Sajraw trade pricing rules - identical logic to the desktop app (single source of truth)
const Pricing = (() => {
  const markup = y => (+y < 2017 ? 1400 : 1800); // pre-2017: +£1,400 | 2017+: +£1,800

  function defaults(type, year) {
    return type === 'Cleared'
      ? { roadPrep: 600, admin: 400, iva: 400 }
      : { roadPrep: 1800, admin: 300, iva: 400 };
  }

  // FOB: car price typed in yen (converted to £). Cleared: typed directly in £.
  function carPounds(c, rate) {
    if (c.priceType === 'Cleared') return c.basePound ?? (+c.baseYen || 0) / rate; // fallback for older saved cars
    return (+c.baseYen || 0) / rate;
  }

  function calc(c, rate = 208.7) {
    const mk = markup(c.year);
    const base = Math.round(carPounds(c, rate));
    const cleared = c.priceType === 'Cleared';
    const modern = +c.year >= 2017;
    const lines = [[cleared ? 'Cleared price (incl. clearance)' : 'Car price', base + mk]];
    // 2017+: ticked fees. Pre-2017: admin fee only (road prep & IVA omitted automatically)
    if (modern && c.incRoad !== false && +c.roadPrep)
      lines.push([cleared ? 'Road prep & transportation' : 'UK road prep, pre-shipping, transport, checks, reg & MOT', +c.roadPrep]);
    if (modern && c.incIva !== false && +c.iva) lines.push(['IVA test', +c.iva]);
    if (c.incAdmin !== false && +c.admin) lines.push(['Administration fee', +c.admin]);
    return { lines, total: lines.reduce((s, l) => s + l[1], 0), markup: mk, base };
  }
  return { calc, markup, defaults };
})();
