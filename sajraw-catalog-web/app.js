/* ---------- Upload & Button Handlers ---------- */
const dz = $('#drop');
if (dz) {
  dz.ondragover = e => { e.preventDefault(); dz.classList.add('over'); };
  dz.ondragleave = () => dz.classList.remove('over');
  dz.ondrop = e => { e.preventDefault(); dz.classList.remove('over'); ingest([...e.dataTransfer.files]); };
}

// Safe click triggers for file inputs
document.addEventListener('DOMContentLoaded', () => {
  const upF = $('#upF');
  const upC = $('#upC');
  if (upF) upF.onclick = () => $('#fileIn')?.click();
  if (upC) upC.onclick = () => $('#camIn')?.click();
});

// Fallback direct bind in case DOM is already loaded
if ($('#upF')) $('#upF').onclick = () => $('#fileIn')?.click();
if ($('#upC')) $('#upC').onclick = () => $('#camIn')?.click();

for(const id of ['#fileIn', '#camIn']) {
  const el = $(id);
  if (el) el.onchange = e => { const f = [...e.target.files]; e.target.value = ''; ingest(f); };
}
