// Builds the catalogue HTML (same layout/content as the desktop PDF). Pounds only.
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nf = x => Math.round(x).toLocaleString('en-GB');

const PDF_CSS = `
*{box-sizing:border-box}
body{margin:0;font-family:Arial,Helvetica,sans-serif;color:#111}
.page{width:210mm;height:297mm;position:relative;overflow:hidden;background:#fff}
.cover{background:#0a0a0a;color:#fff;text-align:center}
.cover img.logo{width:166mm;margin-top:38mm}
.cover .bar{width:28mm;height:1.2mm;background:#c0272d;margin:14mm auto 6mm}
.cover h1{font-size:34pt;margin:0}.cover h2{font-weight:400;font-size:15pt;margin:4mm 0}
.cover .msg{width:150mm;margin:10mm auto 0;padding:5mm;border:.3mm solid #c0272d;font-size:13pt}
.cover .contact{position:absolute;bottom:18mm;width:100%;font-size:12pt;color:#ddd;line-height:1.7}
.hdr{background:#111;border-bottom:1.2mm solid #c0272d;height:23mm;display:flex;align-items:center;color:#fff;padding-right:12mm}
.hdr img{height:23mm;margin-right:8mm}.hdr .l{flex:1}.hdr b{font-size:15pt}.hdr small{display:block;color:#bbb;font-size:9pt;margin-top:1mm}
.hdr .r{text-align:right;font-size:9pt;color:#bbb}.hdr .r b{display:block;color:#fff;font-size:9.5pt}
.body{padding:5mm 12mm}
h3{font-size:25pt;margin:6mm 0 5mm;display:inline-block}
h3:after,h4:after{content:"";display:block;width:12mm;height:1mm;background:#c0272d;margin-top:2mm}
h4{font-size:17pt;margin:6mm 0 3mm}
.main{width:100%;height:150mm;object-fit:cover;border:.3mm solid #ccc;display:block}
.th{display:grid;grid-template-columns:repeat(3,1fr);gap:3mm;margin-top:4mm}
.th div{font-size:8pt;color:#555}.th img{width:100%;height:42mm;object-fit:cover;border:.3mm solid #ccc;display:block}
table.s{width:100%;border-collapse:collapse;font-size:10.5pt}.s td{padding:2.2mm 4mm}.s tr:nth-child(odd){background:#f3f3f3}.s td:first-child{font-weight:700;width:60mm}
.f{display:grid;grid-template-columns:1fr 1fr;font-size:10.5pt;list-style:none;padding:0;margin:0}.f li{padding:1.2mm 0 1.2mm 5mm;position:relative}
.f li:before{content:"";position:absolute;left:0;top:2.6mm;width:2mm;height:2mm;border-radius:50%;background:#c0272d}
.note{background:#f3f3f3;border-left:1.2mm solid #c0272d;padding:3mm 4mm;font-size:10pt;margin-top:4mm;white-space:pre-wrap}
.ph{display:flex;justify-content:space-between;align-items:flex-end;margin-top:6mm}.ph b{font-size:12pt}.ph span{font-size:9.5pt;font-weight:700}
table.p{width:100%;border-collapse:collapse;font-size:10pt;margin-top:2mm}.p td{padding:1.8mm 4mm}.p td:last-child{text-align:right;font-weight:700}
.p tr:nth-child(odd){background:#f3f3f3}.p tr.t td{background:#111;color:#fff;font-size:12pt;padding:3mm 4mm}
.ft{position:absolute;bottom:10mm;left:12mm;right:12mm;border-top:.3mm solid #ccc;padding-top:2mm;font-size:9pt;color:#555;display:flex;justify-content:space-between}
`;

// src(key) -> data URL. Only c.images (clean photos) are ever printed; c.docs (raw screenshots) never are.
function buildPdfHtml({ cars, opts, rate, logo, src }) {
  let pg = 1;
  const ft = () => `<div class="ft"><span>Sajraw Motors Ltd</span><span>Page ${pg}</span></div>`;
  const title = c => c.title || [c.year, c.make, c.model, c.grade].filter(Boolean).join(' ');
  const hdr = c => `<div class="hdr"><img src="${logo}"><div class="l"><b>SAJRAW MOTORS LTD</b><small>Trade Price Catalogue | ${esc(opts.name)}</small></div>
    <div class="r"><b>${esc(title(c))}</b>${esc(c.stockId)}</div></div>`;

  let html = `<div class="page cover"><img class="logo" src="${logo}"><div class="bar"></div>
    <h1>${esc(opts.name || 'TRADE PRICE CATALOGUE').toUpperCase()}</h1><h2>${esc(opts.subtitle || '')}</h2>
    ${opts.incMessage && opts.message ? `<div class="msg">${esc(opts.message).replace(/\n/g, '<br>')}</div>` : ''}
    <div class="contact">${opts.incPhone && opts.phone ? 'Tel: ' + esc(opts.phone) + '<br>' : ''}${opts.incEmail && opts.email ? esc(opts.email) : ''}</div></div>`;

  for (const c of cars) {
    pg++;
    const imgs = (c.images || []).map(src).filter(Boolean);
    const th = imgs.slice(1, 10);
    html += `<div class="page">${hdr(c)}<div class="body"><h3>${esc(title(c))}</h3>
      ${imgs[0] ? `<img class="main" src="${imgs[0]}">` : ''}
      <div class="th">${th.map((s, i) => `<div><img src="${s}">Photo ${i + 2}</div>`).join('')}</div></div>${ft()}</div>`;
    pg++;
    const mi = c.mileageMi ? `${nf(c.mileageMi)} miles (${nf(c.mileageKm)} km)` : '';
    const rows = [['Make', c.make], ['Model', c.model], ['Grade', c.grade], ['Body Type', c.bodyType], ['Colour', c.colour],
      ['Year', c.year], ['Mileage', mi], ['Engine', c.engine && c.engine + ' cc'], ['Fuel', c.fuel], ['Transmission', c.transmission],
      ['Steering', c.steering], ['Chassis / VIN', c.vin || 'To be confirmed'], ['Stock ID', c.stockId]].filter(r => r[1]);
    const pr = Pricing.calc(c, rate);
    html += `<div class="page">${hdr(c)}<div class="body"><h4>Vehicle Specifications</h4>
      <table class="s">${rows.map(r => `<tr><td>${r[0]}</td><td>${esc(r[1])}</td></tr>`).join('')}</table>
      ${c.features?.length ? `<h4>Features &amp; Options</h4><ul class="f">${c.features.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
      ${c.notes ? `<div class="note"><b>Inspector notes</b>\n${esc(c.notes)}</div>` : ''}
      <div class="ph"><b>TRADE PRICE</b><span>Estimated delivery: 2 - 4 weeks</span></div>
      <table class="p">${pr.lines.map(l => `<tr><td>${esc(l[0])}</td><td>£${nf(l[1])}</td></tr>`).join('')}
      <tr class="t"><td>TRADE PRICE</td><td>£${nf(pr.total)}</td></tr></table>
      </div>${ft()}</div>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>${PDF_CSS}</style></head><body>${html}</body></html>`;
}
