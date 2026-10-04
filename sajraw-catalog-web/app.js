const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- Supabase cloud storage (database + image bucket) ---------- */
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const BUCKET = 'car-images';
let UID = null;
const IMG = {};              // image key -> data URL (in-memory cache; images live in Supabase Storage)
const pending = {}, FAILED = new Set();
const src = k => IMG[k] || '';
const imgPath = k => `${UID}/${k}.jpg`;
const blobToData = b => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); });
async function putImg(k, dataUrl) {
  IMG[k] = dataUrl; // available instantly for OCR/preview, then uploaded
  const blob = await (await fetch(dataUrl)).blob();
  const { error } = await sb.storage.from(BUCKET).upload(imgPath(k), blob, { contentType: 'image/jpeg', upsert: true });
  if (error) throw error;
}
function getImg(k) {
  if (IMG[k] || FAILED.has(k)) return Promise.resolve();
  return pending[k] ||= sb.storage.from(BUCKET).download(imgPath(k)).then(async ({ data, error }) => {
    if (error || !data) FAILED.add(k); else IMG[k] = await blobToData(data);
    delete pending[k];
  });
}
const getImgs = keys => Promise.all(keys.map(getImg));
const delImg = k => { delete IMG[k]; return sb.storage.from(BUCKET).remove([imgPath(k)]); };

const cloudErr = (what, error) => { if (error) say(`Cloud ${what} failed: ${error.message}`); };
async function saveCar(c) { cloudErr('save', (await sb.from('cars').upsert({ id: c.id, user_id: UID, data: c, updated_at: new Date().toISOString() })).error); }
async function saveCars(cs) { if (cs.length) cloudErr('save', (await sb.from('cars').upsert(cs.map(c => ({ id: c.id, user_id: UID, data: c, updated_at: new Date().toISOString() })))).error); }
async function deleteCarRow(id) { cloudErr('delete', (await sb.from('cars').delete().eq('id', id)).error); }
let setTimer;
const persistSettings = () => { clearTimeout(setTimer); setTimer = setTimeout(async () => {
  cloudErr('settings save', (await sb.from('settings').upsert({ user_id: UID, data: db.settings, updated_at: new Date().toISOString() })).error); }, 600); };

let db = { cars: [], settings: { rate: 208.7 } }, cur = null, lastPdf = null;
const S = () => db.settings, rate = () => +S().rate || 208.7;
const say = t => $('#status').textContent = t;
const gbp = n => '£' + Math.round(n).toLocaleString('en-GB');

/* ---------- Image import (iPhone library / camera) ---------- */
async function shrink(file, max = 1800) {
  const bm = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bm.width, bm.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bm.width * k); c.height = Math.round(bm.height * k);
  c.getContext('2d').drawImage(bm, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}
async function importFiles(files, perCar) {
  const keys = [];
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    const k = 'i' + Date.now() + Math.random().toString(36).slice(2, 7);
    try { await putImg(k, await shrink(f)); keys.push(k); } catch (e) { say('Could not save ' + f.name + ': ' + e.message); }
  }
  return perCar ? keys.map(k => [k]) : (keys.length ? [keys] : []);
}
let worker;
async function ocrKeys(keys) {
  worker = worker || await Tesseract.createWorker('eng');
  const texts = [];
  for (const k of keys) texts.push((await worker.recognize(IMG[k])).data.text);
  return texts; // one string per image
}

/* ---------- OCR text -> car (unchanged from desktop) ---------- */
const FEATS={'Power windows':/power\s*window|\bP\/?W\b/i,'Power steering':/power\s*steering|\bP\/?S\b/i,'Alloy wheels':/alloy|\bAW\b/i,'Airbags':/air\s*bag|\bSRS\b/i,
 'Navigation':/navigation|\bnavi\b/i,'TV':/\bTV\b/,'Rear view camera':/rear\s*(view)?\s*camera|back\s*camera/i,'Cruise control':/cruise/i,'Leather seats':/leather/i,
 'Start button':/start\s*(button|stop)|push\s*start/i,'Smart key':/smart\s*key/i,'Xenon headlights':/xenon|\bHID\b/i,'LED headlights':/\bLED\b/,'Sunroof':/sun\s*roof|moon\s*roof/i,
 'Parking sensors':/clearance\s*sonar|park(ing)?\s*(distance|sensor)/i,'Blind spot monitor':/blind\s*spot/i,'Paddle shifters':/paddle/i,'Air conditioning':/air\s*con|\bA\/?C\b/i,'Drive recorder':/drive\s*recorder/i,'ETC':/\bETC\b/};
const MAKES=['Volkswagen','Honda','Nissan','Toyota','Mazda','Suzuki','Subaru','Mitsubishi','Lexus','BMW','Mercedes','Audi','Mini','Daihatsu','Ford','Peugeot'];
const COLOURS=['White','Black','Silver','Grey','Gray','Blue','Red','Green','Yellow','Orange','Brown','Beige','Pearl','Gold','Purple'];
const num=s=>+String(s).replace(/[^\d.]/g,'');
function parse(text){
  // normalise common OCR confusions inside numbers (O->0, l/I->1) before matching
  const T=text.replace(/\r/g,'').replace(/(?<=\d)[Oo](?=[\d,.\s]|$)|(?<=[\d,.])[Oo](?=\d)/g,'0').replace(/(?<=\d)[lI|](?=\d)/g,'1');
  const g=re=>(T.match(re)||[])[1]?.trim()||'';
  const year=+g(/\b(20[0-2]\d|199\d)\b/)||new Date().getFullYear();
  let km=0,mi=0;
  const mm=T.match(/(\d{1,3}(?:[,. ]\d{3})+|\d{2,6})\s*(k\s?[mn]|kin|krn|miles?|mi)\b/i)||T.match(/(?:mileage|odometer|odo|走行)\D{0,15}(\d{1,3}(?:[,. ]\d{3})+|\d{2,6})/i);
  if(mm){let v=+mm[1].replace(/[,.\s]/g,'');const u=(mm[2]||'km').toLowerCase();
    if(/^mi/.test(u)){mi=v;km=Math.round(v/0.621371);}else{if(v<1000)v*=1000;km=v;mi=Math.round(v*0.621371);}}
  // prices: £8,200 (OCR may read £ as E/f), also yen
  const pm=T.match(/(?<![A-Za-z])[£Ef]\s?(\d{1,2}\s?[,.]?\s?\d{3})(?!\d)/)||T.match(/(?:price|cost|total)\D{0,12}(\d{1,2}[,.]\d{3})(?!\d)/i);
  let gbpP=pm?+pm[1].replace(/\D/g,''):0;if(gbpP<500||gbpP>99999)gbpP=0;
  const mk=MAKES.find(m=>new RegExp('\\b'+m+'\\b','i').test(T))||'';
  const model=mk?g(new RegExp(mk+'\\s+([A-Za-z0-9\\-]+)','i')):'';
  const pt=g(/[¥￥]\s?([\d,]{6,9})/);
  const trans=g(/\b(CVT|AT|MT|DCT|FAT|IAT|automatic|manual)\b/i).toLowerCase();
  const fuel=g(/\b(petrol|gasoline|hybrid|diesel|electric)\b/i);
  const notesLines=T.split('\n').filter(l=>/(note|remark|inspector|scratch|dent|repair|accident|flood|rust|chip)/i.test(l)&&l.trim().length>6);
  const c={id:Date.now()+Math.random().toString(36).slice(2,6),selected:true,make:mk,model,grade:g(/\b(TSI[\w ]{0,20}|GTI[\w ]{0,15}|Highline|Comfortline[\w ]{0,10}|Hybrid[\w ]{0,8})/),
   year,colour:COLOURS.find(x=>new RegExp('\\b'+x+'\\b','i').test(T))||'',bodyType:g(/\b(hatchback|sedan|wagon|SUV|minivan|coupe|convertible)\b/i),
   mileageKm:km,mileageMi:mi,engine:g(/(\d{3,4})\s*cc/i),fuel:fuel?(/gasoline/i.test(fuel)?'Petrol':fuel[0].toUpperCase()+fuel.slice(1)):'Petrol',
   transmission:/mt|manual/.test(trans)?'Manual':'Automatic',steering:/\bLHD\b/i.test(T)?'Left-hand drive':'Right-hand drive',
   vin:g(/\b([A-HJ-NPR-Z0-9]{17})\b/)||g(/\b([A-Z0-9]{2,6}-\d{5,8})\b/),
   stockId:'STK-'+String(Date.now()).slice(-10),features:Object.keys(FEATS).filter(k=>FEATS[k].test(T)),notes:notesLines.join('\n'),
   priceType:gbpP?'Cleared':'FOB',baseYen:num(pt)||0,basePound:gbpP,incRoad:true,incIva:true,incAdmin:true,docs:[]};
  Object.assign(c,Pricing.defaults(c.priceType,c.year));return c;
}
const isDoc=t=>((t||'').match(/[A-Za-z]{3,}/g)||[]).length>=25;
async function ingest(files){
  if(!files.length)return;
  say('Importing images...');const groups=await importFiles(files,$('#perCar').checked);
  let i=0;for(const gp of groups){i++;say(`Reading car ${i}/${groups.length} with OCR (first run downloads language data - needs internet)...`);
    let car,texts=[];try{texts=await ocrKeys(gp);car=parse(texts.join('\n'));}catch(e){car=parse('');say('OCR failed: '+e.message);}
    // text-heavy screenshots (cards, spec sheets, inspector notes) are kept as reference docs and never printed in the PDF
    car.images=gp.filter((_,k)=>!isDoc(texts[k]));car.docs=gp.filter((_,k)=>isDoc(texts[k]));db.cars.push(car);render();await saveCar(car);}
  say(`Done - ${groups.length} car(s) added. Tap EDIT to check the extracted details.`);
}

/* ---------- Library ---------- */
function render(){
  const r=rate();
  $('#list').innerHTML=db.cars.map(c=>{const p=Pricing.calc(c,r),th=c.images?.[0]||c.docs?.[0];return `<div class="car"><input type="checkbox" data-sel="${c.id}" ${c.selected?'checked':''}>
   ${th?`<img src="${src(th)}">`:'<div class="noimg"></div>'}
   <div class="i"><b>${esc([c.year,c.make,c.model,c.grade].filter(Boolean).join(' '))}</b><small>${esc(c.mileageMi.toLocaleString())} miles · ${esc(c.colour)}</small><span class="pr">${gbp(p.total)}</span></div>
   <div class="acts"><button data-edit="${c.id}">✎ EDIT</button><button data-del="${c.id}">🗑 DELETE</button></div></div>`}).join('')||'<p style="text-align:center;color:#888">No cars yet - add screenshots or photos above.</p>';
  const n=db.cars.filter(c=>c.selected).length,t=`TOTAL CARS SELECTED: <b>${n}</b><br>ESTIMATED PAGES: <b>${n?1+2*n:0}</b>`;
  $('#sumBox').innerHTML=t;$('#sum').innerHTML=`<b>${n}</b> car${n===1?'':'s'}<br>${n?1+2*n:0} pages`;
  const miss=db.cars.map(c=>c.images?.[0]||c.docs?.[0]).filter(k=>k&&!IMG[k]&&!FAILED.has(k));
  if(miss.length)Promise.all(miss.map(getImg)).then(render); // thumbnails stream in from the cloud
}
$('#list').onclick=e=>{const d=e.target.dataset;
  if(d.edit)openEditor(db.cars.find(c=>c.id===d.edit));
  if(d.del&&confirm('Delete this car from the library?')){const c=db.cars.find(x=>x.id===d.del);[...(c.images||[]),...(c.docs||[])].forEach(delImg);
    db.cars=db.cars.filter(x=>x.id!==d.del);render();deleteCarRow(d.del);}};
$('#list').onchange=e=>{const id=e.target.dataset.sel;if(id){const c=db.cars.find(c=>c.id===id);c.selected=e.target.checked;render();saveCar(c);}};
$('#all').onclick=()=>{db.cars.forEach(c=>c.selected=true);render();saveCars(db.cars);};
$('#none').onclick=()=>{db.cars.forEach(c=>c.selected=false);render();saveCars(db.cars);};

/* ---------- Upload & Button Handlers ---------- */
const dz=$('#drop');
dz.ondragover=e=>{e.preventDefault();dz.classList.add('over')};dz.ondragleave=()=>dz.classList.remove('over');
dz.ondrop=e=>{e.preventDefault();dz.classList.remove('over');ingest([...e.dataTransfer.files]);};

// Connected click triggers for file inputs
$('#upF').onclick = () => $('#fileIn').click();
$('#upC').onclick = () => $('#camIn').click();

for(const id of ['#fileIn','#camIn'])$(id).onchange=e=>{const f=[...e.target.files];e.target.value='';ingest(f);};

/* ---------- Editor ---------- */
const F=[['year','Year','number'],['make','Make'],['model','Model'],['grade','Grade'],['bodyType','Body type'],['colour','Colour'],['mileageKm','Mileage (km)','number'],
 ['mileageMi','Mileage (miles) - auto','number'],['engine','Engine (cc)'],['fuel','Fuel'],['transmission','Transmission'],['steering','Steering'],['vin','Chassis / VIN'],['stockId','Stock ID'],
 ['priceType','Price type','sel'],['baseYen','Car price (¥) - FOB','number'],['basePound','Car price (£) - Cleared','number']];
function openEditor(c){
  cur=JSON.parse(JSON.stringify(c));$('#mt').textContent='EDIT CAR';
  $('#form').innerHTML=F.map(([k,l,t])=>`<div data-w="${k}"><label>${l}</label>`+(t==='sel'?`<select data-k="${k}"><option>FOB</option><option>Cleared</option></select>`:`<input data-k="${k}" type="${t==='number'?'number':'text'}" ${t==='number'?'inputmode="decimal"':''} value="${esc(cur[k])}">`)+'</div>').join('');
  $('#form [data-k=priceType]').value=cur.priceType;$('#feat').value=(cur.features\vert{}\vert{}[]).join('\n');$('#notes').value=cur.notes||'';
  cur.docs=cur.docs||[];if(cur.basePound===undefined)cur.basePound=cur.priceType==='Cleared'?Math.round((cur.baseYen||0)/rate()):0;
  $('#form [data-k=basePound]').value=cur.basePound;
  $('#fees').innerHTML=[['incRoad','roadPrep','Road prep'],['incIva','iva','IVA test'],['incAdmin','admin','Administration fee']].map(([f,a,l])=>
   `<label class="fee"><input type="checkbox" data-k="${f}" ${cur[f]!==false?'checked':''}><span>${l} £</span><input data-k="${a}" type="number" inputmode="decimal" value="${cur[a]??0}"></label>`).join('')+'<div id="feeNote"></div>';
  vis();phs();calcLine();$('#modal').style.display='flex';$('#modal .card').scrollTop=0;document.body.style.overflow='hidden';
  getImgs([...cur.images,...cur.docs]).then(()=>cur&&phs());
}
function vis(){const fob=cur.priceType!=='Cleared',old=+cur.year<2017;
  $('#form [data-w=baseYen]').style.display=fob?'':'none';$('#form [data-w=basePound]').style.display=fob?'none':'';
  ['incRoad','incIva'].forEach(k=>$(`#fees [data-k=${k}]`).disabled=old);
  $('#feeNote').textContent=old?'Pre-2017: only the car price + administration fee apply (road prep & IVA omitted automatically).':'2017+: car price + ticked fees.';}
function calcLine(){const p=Pricing.calc(cur,rate());$('#pcalc').textContent=`Pricing rule: +${gbp(p.markup)} (${cur.year<2017?'pre-2017':'2017+'}) · Trade price ${gbp(p.total)}`;}
$('#modal').oninput=e=>{const k=e.target.dataset.k;if(!k)return;cur[k]=e.target.type==='checkbox'?e.target.checked:e.target.type==='number'?+e.target.value:e.target.value;
  if(k==='mileageKm'){cur.mileageMi=Math.round(cur.mileageKm*0.621371);$('#form [data-k=mileageMi]').value=cur.mileageMi;}
  if(k==='priceType'){Object.assign(cur,Pricing.defaults(cur.priceType,cur.year));['roadPrep','iva','admin'].forEach(x=>$(`#fees [data-k=${x}]`).value=cur[x]);}
  vis();calcLine();};
function phs(){
  $('#phs').innerHTML=cur.images.map((p,i)=>`<div class="${i?'':'main'}"><img src="${src(p)}"><button data-rm="${i}">×</button>${i?`<button class="m" data-main="${i}">★</button>`:''}<button class="b" title="Move to reference docs (not printed)" data-todoc="${i}">⇄</button></div>`).join('')||'<small style="color:#888">none</small>';
  $('#docs').innerHTML=cur.docs.map((p,i)=>`<div><img src="${src(p)}"><button data-rmd="${i}">×</button><button class="b" title="Use as PDF photo" data-topdf="${i}">⇄</button></div>`).join('')||'<small style="color:#888">none</small>';}
$('#modal').onclick=e=>{const d=e.target.dataset;
  if(d.rm!==undefined)cur.images.splice(+d.rm,1);
  if(d.main!==undefined)cur.images.unshift(...cur.images.splice(+d.main,1));
  if(d.todoc!==undefined)cur.docs.push(...cur.images.splice(+d.todoc,1));
  if(d.rmd!==undefined)cur.docs.splice(+d.rmd,1);
  if(d.topdf!==undefined)cur.images.push(...cur.docs.splice(+d.topdf,1));
  if(['rm','main','todoc','rmd','topdf'].some(k=>d[k]!==undefined))phs();};
$('#addPh').onclick=async()=>{const g=await importFiles(await pickFiles(),false);if(g[0])cur.images.push(...g[0]);phs();};
const closeEd=()=>{$('#modal').style.display='none';document.body.style.overflow='';};
$('#cancel').onclick=closeEd;
$('#ok').onclick=()=>{cur.features=$('#feat').value.split('\n').map(s=>s.trim()).filter(Boolean);cur.notes=$('#notes').value;
  const i=db.cars.findIndex(c=>c.id===cur.id);db.cars[i]=cur;render();closeEd();saveCar(cur);};

/* ---------- Catalog generator ---------- */
const FIELDS=['catName','phone','email','message','subtitle','rate'],CHK=['incPhone','incEmail','incMessage'];
function saveSettings(){FIELDS.forEach(k=>S()[k]=$('#'+k).value);CHK.forEach(k=>S()[k]=$('#'+k).checked);persistSettings();render();}
[...FIELDS,...CHK].forEach(k=>$('#'+k).addEventListener('input',saveSettings));

let logoData;
async function logo(){if(logoData)return logoData;const b=await (await fetch('assets/logo.png')).blob();
  return logoData=await new Promise(r=>{const f=new FileReader();f.onload=()=>r(f.result);f.readAsDataURL(b);});}

async function makePdf(payload){
  const html=buildPdfHtml({...payload,logo:await logo(),src});
  const fr=document.createElement('iframe');fr.style.cssText='position:fixed;left:-10000px;top:0;width:794px;height:1123px;border:0';
  document.body.appendChild(fr);await new Promise(r=>{fr.onload=r;fr.srcdoc=html;});
  const d=fr.contentDocument;await Promise.all([...d.images].map(i=>i.decode().catch(()=>{})));
  fr.style.height=d.documentElement.scrollHeight+'px';
  const pages=[...d.querySelectorAll('.page')],pdf=new window.jspdf.jsPDF({unit:'mm',format:'a4',compress:true});
  for(let i=0;i<pages.length;i++){say(`Building PDF: page ${i+1} of ${pages.length}...`);
    const cv=await html2canvas(pages[i],{scale:2,useCORS:true,backgroundColor:'#ffffff'});
    if(i)pdf.addPage();pdf.addImage(cv.toDataURL('image/jpeg',0.9),'JPEG',0,0,210,297);
    cv.width=cv.height=0;await new Promise(r=>setTimeout(r));}
  fr.remove();return pdf.output('blob');
}
$('#gen').onclick=async()=>{
  const cars=db.cars.filter(c=>c.selected);if(!cars.length)return alert('Tick at least one car first.');
  const s=S();const opts={name:s.catName||'Trade Price Catalogue',subtitle:s.subtitle,phone:s.phone,email:s.email,message:s.message,incPhone:s.incPhone,incEmail:s.incEmail,incMessage:s.incMessage};
  const btn=$('#gen');btn.disabled=true;$('#done').style.display='none';
  try{say('Loading photos...');await getImgs(cars.flatMap(c=>c.images||[]));const blob=await makePdf({cars,opts,rate:rate()});
    const name=(opts.name.replace(/[^\w\- ]+/g,'').trim()||'Catalogue')+'.pdf';lastPdf={blob,name};
    say('PDF ready.');$('#doneMsg').textContent=`${name} is ready (${(blob.size/1048576).toFixed(1)} MB)`;
    $('#shareBtn').style.display=navigator.canShare?'':'none';$('#done').style.display='block';
  }catch(e){say('PDF failed: '+e.message);alert('PDF failed: '+e.message);}
  btn.disabled=false;
};
function download(){const a=document.createElement('a');a.href=URL.createObjectURL(lastPdf.blob);a.download=lastPdf.name;document.body.appendChild(a);a.click();
  setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},4000);}
$('#dlBtn').onclick=()=>lastPdf&&download();
$('#shareBtn').onclick=async()=>{if(!lastPdf)return;const f=new File([lastPdf.blob],lastPdf.name,{type:'application/pdf'});
  try{if(navigator.canShare&&navigator.canShare({files:[f]}))await navigator.share({files:[f],title:lastPdf.name});else download();}
  catch(e){if(e.name!=='AbortError')download();}};
$('#closeDone').onclick=()=>$('#done').style.display='none';

/* ---------- Start / login ---------- */
const FIELDS_DEFAULT={rate:208.7,incPhone:true,incEmail:true,incMessage:true};
function showLogin(msg){$('#login').style.display='flex';$('#lerr').textContent=msg||'';}
async function boot(user){
  UID=user.id;navigator.storage?.persist?.();say('Loading your library...');
  
  // Safe load supporting tables whether created_at exists or not
  const [st,cars]=await Promise.all([
    sb.from('settings').select('data').maybeSingle(),
    sb.from('cars').select('data, updated_at').order('updated_at', { ascending: false }).catch(() => sb.from('cars').select('data'))
  ]);
  
  cloudErr('load',cars.error||st.error);
  db.cars=(cars.data||[]).map(r=>r.data);
  db.settings=Object.assign({},FIELDS_DEFAULT,st.data?.data||{});
  FIELDS.forEach(k=>$('#'+k).value=S()[k]??'');CHK.forEach(k=>$('#'+k).checked=!!S()[k]);
  $('#login').style.display='none';render();say('');
}
$('#lgo').onclick=async()=>{$('#lerr').textContent='Signing in...';
  const {data,error}=await sb.auth.signInWithPassword({email:$('#lem').value.trim(),password:$('#lpw').value});
  if(error)return showLogin(error.message);await boot(data.user);};
$('#lpw').onkeydown=e=>{if(e.key==='Enter')$('#lgo').click();};
$('#out').onclick=async()=>{await sb.auth.signOut();location.reload();};
(async()=>{
  if('serviceWorker' in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});
  if(/YOUR-/.test(SUPABASE_URL+SUPABASE_ANON_KEY))return showLogin('Put your Supabase URL and anon key into config.js first.');
  const {data:{session}}=await sb.auth.getSession();
  session?await boot(session.user):showLogin();
})();
