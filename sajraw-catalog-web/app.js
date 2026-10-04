// Safe DOM selector helper
function $(s) { return document.querySelector(s); }
const esc = function(s) { return String(s || '').replace(/[&<>"]/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };

/* ---------- Supabase cloud storage (database + image bucket) ---------- */
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const BUCKET = 'car-images';
let UID = null;
const IMG = {};              // image key -> data URL (in-memory cache; images live in Supabase Storage)
const pending = {}, FAILED = new Set();
const src = function(k) { return IMG[k] || ''; };
const imgPath = function(k) { return UID + '/' + k + '.jpg'; };
const blobToData = function(b) { return new Promise(function(r) { var f = new FileReader(); f.onload = function() { r(f.result); }; f.readAsDataURL(b); }); };
async function putImg(k, dataUrl) {
  IMG[k] = dataUrl; // available instantly for OCR/preview, then uploaded
  var res = await fetch(dataUrl);
  var blob = await res.blob();
  var uploadRes = await sb.storage.from(BUCKET).upload(imgPath(k), blob, { contentType: 'image/jpeg', upsert: true });
  if (uploadRes.error) throw uploadRes.error;
}
function getImg(k) {
  if (IMG[k] || FAILED.has(k)) return Promise.resolve();
  if (pending[k]) return pending[k];
  return pending[k] = sb.storage.from(BUCKET).download(imgPath(k)).then(async function(res) {
    if (res.error || !res.data) {
      FAILED.add(k);
    } else {
      IMG[k] = await blobToData(res.data);
    }
    delete pending[k];
  });
}
var getImgs = function(keys) { return Promise.all(keys.map(getImg)); };
var delImg = function(k) { delete IMG[k]; return sb.storage.from(BUCKET).remove([imgPath(k)]); };

var cloudErr = function(what, error) { if (error) say('Cloud ' + what + ' failed: ' + error.message); };
async function saveCar(c) { 
  var res = await sb.from('cars').upsert({ id: c.id, user_id: UID, data: c, updated_at: new Date().toISOString() });
  cloudErr('save', res.error); 
}
async function saveCars(cs) { 
  if (cs.length) {
    var mapped = cs.map(function(c) { return { id: c.id, user_id: UID, data: c, updated_at: new Date().toISOString() }; });
    var res = await sb.from('cars').upsert(mapped);
    cloudErr('save', res.error);
  }
}
async function deleteCarRow(id) { 
  var res = await sb.from('cars').delete().eq('id', id);
  cloudErr('delete', res.error); 
}
let setTimer;
var persistSettings = function() { 
  clearTimeout(setTimer); 
  setTimer = setTimeout(async function() {
    var res = await sb.from('settings').upsert({ user_id: UID, data: db.settings, updated_at: new Date().toISOString() });
    cloudErr('settings save', res.error); 
  }, 600); 
};

let db = { cars: [], settings: { rate: 208.7 } }, cur = null, lastPdf = null;
var S = function() { return db.settings; }, rate = function() { return +S().rate || 208.7; };
var say = function(t) { $('#status').textContent = t; };
var gbp = function(n) { return '£' + Math.round(n).toLocaleString('en-GB'); };

/* ---------- Image import (iPhone library / camera) ---------- */
async function shrink(file, max) {
  if (max === undefined) max = 1800;
  var bm = await createImageBitmap(file);
  var k = Math.min(1, max / Math.max(bm.width, bm.height));
  var c = document.createElement('canvas');
  c.width = Math.round(bm.width * k); c.height = Math.round(bm.height * k);
  c.getContext('2d').drawImage(bm, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}
async function importFiles(files, perCar) {
  var keys = [];
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    if (!f.type.startsWith('image/')) continue;
    var k = 'i' + Date.now() + Math.random().toString(36).slice(2, 7);
    try { 
      var shrunk = await shrink(f);
      await putImg(k, shrunk); 
      keys.push(k); 
    } catch (e) { 
      say('Could not save ' + f.name + ': ' + e.message); 
    }
  }
  return perCar ? keys.map(function(k) { return [k]; }) : (keys.length ? [keys] : []);
}
let worker;
async function ocrKeys(keys) {
  if (!worker) {
    worker = await Tesseract.createWorker('eng');
  }
  var texts = [];
  for (var i = 0; i < keys.length; i++) {
    var rec = await worker.recognize(IMG[keys[i]]);
    texts.push(rec.data.text);
  }
  return texts;
}

/* ---------- OCR text -> car ---------- */
const FEATS={'Power windows':/power\s*window|\bP\/?W\b/i,'Power steering':/power\s*steering|\bP\/?S\b/i,'Alloy wheels':/alloy|\bAW\b/i,'Airbags':/air\s*bag|\bSRS\b/i,
 'Navigation':/navigation|\bnavi\b/i,'TV':/\bTV\b/,'Rear view camera':/rear\s*(view)?\s*camera|back\s*camera/i,'Cruise control':/cruise/i,'Leather seats':/leather/i,
 'Start button':/start\s*(button|stop)|push\s*start/i,'Smart key':/smart\s*key/i,'Xenon headlights':/xenon|\bHID\b/i,'LED headlights':/\bLED\b/,'Sunroof':/sun\s*roof|moon\s*roof/i,
 'Parking sensors':/clearance\s*sonar|park(ing)?\s*(distance|sensor)/i,'Blind spot monitor':/blind\s*spot/i,'Paddle shifters':/paddle/i,'Air conditioning':/air\s*con|\bA\/?C\b/i,'Drive recorder':/drive\s*recorder/i,'ETC':/\bETC\b/};
const MAKES=['Volkswagen','Honda','Nissan','Toyota','Mazda','Suzuki','Subaru','Mitsubishi','Lexus','BMW','Mercedes','Audi','Mini','Daihatsu','Ford','Peugeot'];
const COLOURS=['White','Black','Silver','Grey','Gray','Blue','Red','Green','Yellow','Orange','Brown','Beige','Pearl','Gold','Purple'];
var num = function(s) { return +String(s).replace(/[^\d.]/g,''); };
function parse(text){
  var T=text.replace(/\r/g,'').replace(/(?<=\d)[Oo](?=[\d,.\s]|$)|(?<=[\d,.])[Oo](?=\d)/g,'0').replace(/(?<=\d)[lI|](?=\d)/g,'1');
  var g = function(re) { var m = T.match(re); return m && m[1] ? m[1].trim() : ''; };
  var year=+g(/\b(20[0-2]\d|199\d)\b/)||new Date().getFullYear();
  let km=0,mi=0;
  var mm=T.match(/(\d{1,3}(?:[,. ]\d{3})+|\d{2,6})\s*(k\s?[mn]|kin|krn|miles?|mi)\b/i)||T.match(/(?:mileage|odometer|odo|走行)\D{0,15}(\d{1,3}(?:[,. ]\d{3})+|\d{2,6})/i);
  if(mm){let v=+mm[1].replace(/[,.\s]/g,'');const u=(mm[2]||'km').toLowerCase();
    if(/^mi/.test(u)){mi=v;km=Math.round(v/0.621371);}else{if(v<1000)v*=1000;km=v;mi=Math.round(v*0.621371);}}
  var pm=T.match(/(?<![A-Za-z])[£Ef]\s?(\d{1,2}\s?[,.]?\s?\d{3})(?!\d)/)||T.match(/(?:price|cost|total)\D{0,12}(\d{1,2}[,.]\d{3})(?!\d)/i);
  let gbpP=pm?+pm[1].replace(/\D/g,''):0;if(gbpP<500||gbpP>99999)gbpP=0;
  var mk=MAKES.find(function(m){return new RegExp('\\b'+m+'\\b','i').test(T);})||'';
  var model=mk?g(new RegExp(mk+'\\s+([A-Za-z0-9\\-]+)','i')):'';
  var pt=g(/[¥￥]\s?([\d,]{6,9})/);
  var trans=g(/\b(CVT|AT|MT|DCT|FAT|IAT|automatic|manual)\b/i).toLowerCase();
  var fuel=g(/\b(petrol|gasoline|hybrid|diesel|electric)\b/i);
  var notesLines=T.split('\n').filter(function(l){return /(note|remark|inspector|scratch|dent|repair|accident|flood|rust|chip)/i.test(l)&&l.trim().length>6;});
  var c={id:Date.now()+Math.random().toString(36).slice(2,6),selected:true,make:mk,model,grade:g(/\b(TSI[\w ]{0,20}|GTI[\w ]{0,15}|Highline|Comfortline[\w ]{0,10}|Hybrid[\w ]{0,8})/),
   year,colour:COLOURS.find(function(x){return new RegExp('\\b'+x+'\\b','i').test(T);})||'',bodyType:g(/\b(hatchback|sedan|wagon|SUV|minivan|coupe|convertible)\b/i),
   mileageKm:km,mileageMi:mi,engine:g(/(\d{3,4})\s*cc/i),fuel:fuel?(/gasoline/i.test(fuel)?'Petrol':fuel[0].toUpperCase()+fuel.slice(1)):'Petrol',
   transmission:/mt|manual/.test(trans)?'Manual':'Automatic',steering:/\bLHD\b/i.test(T)?'Left-hand drive':'Right-hand drive',
   vin:g(/\b([A-HJ-NPR-Z0-9]{17})\b/)||g(/\b([A-Z0-9]{2,6}-\d{5,8})\b/),
   stockId:'STK-'+String(Date.now()).slice(-10),features:Object.keys(FEATS).filter(function(k){return FEATS[k].test(T);}),notes:notesLines.join('\n'),
   priceType:gbpP?'Cleared':'FOB',baseYen:num(pt)||0,basePound:gbpP,incRoad:true,incIva:true,incAdmin:true,docs:[]};
  Object.assign(c,Pricing.defaults(c.priceType,c.year));return c;
}
var isDoc = function(t) { return ((t || '').match(/[A-Za-z]{3,}/g) || []).length >= 25; };
async function ingest(files){
  if(!files.length)return;
  say('Importing images...');
  var groups=await importFiles(files,$('#perCar').checked);
  let i=0;
  for(const gp of groups){
    i++;
    say('Reading car ' + i + '/' + groups.length + ' with OCR...');
    let car,texts=[];
    try{
      texts=await ocrKeys(gp);
      car=parse(texts.join('\n'));
    }catch(e){
      car=parse('');
      say('OCR failed: '+e.message);
    }
    car.images=gp.filter(function(_,k){ return !isDoc(texts[k]); });
    car.docs=gp.filter(function(_,k){ return isDoc(texts[k]); });
    db.cars.push(car);
    render();
    await saveCar(car);
  }
  say('Done - ' + groups.length + ' car(s) added. Tap EDIT to check details.');
}

/* ---------- Library ---------- */
function render(){
  var r=rate();
  $('#list').innerHTML=db.cars.map(function(c){
    var p=Pricing.calc(c,r),th=(c.images && c.images[0]) || (c.docs && c.docs[0]);
    return '<div class="car"><input type="checkbox" data-sel="'+c.id+'" '+(c.selected?'checked':'')+'>'+
     (th?'<img src="'+src(th)+'">':'<div class="noimg"></div>')+
     '<div class="i"><b>'+esc([c.year,c.make,c.model,c.grade].filter(Boolean).join(' '))+'</b><small>'+esc(c.mileageMi.toLocaleString())+' miles · '+esc(c.colour)+'</small><span class="pr">'+gbp(p.total)+'</span></div>'+
     '<div class="acts"><button data-edit="'+c.id+'">✎ EDIT</button><button data-del="'+c.id+'">🗑 DELETE</button></div></div>';
  }).join('')||'<p style="text-align:center;color:#888">No cars yet - add screenshots or photos above.</p>';
  var n=db.cars.filter(function(c){return c.selected;}).length,t='TOTAL CARS SELECTED: <b>'+n+'</b><br>ESTIMATED PAGES: <b>'+(n?1+2*n:0)+'</b>';
  $('#sumBox').innerHTML=t;$('#sum').innerHTML='<b>'+n+'</b> car'+(n===1?'':'s')+'<br>'+(n?1+2*n:0)+' pages';
  var miss=db.cars.map(function(c){return (c.images && c.images[0]) || (c.docs && c.docs[0]);}).filter(function(k){return k&&!IMG[k]&&!FAILED.has(k);});
  if(miss.length)Promise.all(miss.map(getImg)).then(render);
}
$('#list').onclick=function(e){
  var d=e.target.dataset;
  if(d.edit)openEditor(db.cars.find(function(c){return c.id===d.edit;}));
  if(d.del&&confirm('Delete this car from the library?')){
    var c=db.cars.find(function(x){return x.id===d.del;});
    [].concat(c.images||[],c.docs||[]).forEach(delImg);
    db.cars=db.cars.filter(function(x){return x.id!==d.del;});render();deleteCarRow(d.del);
  }
};
$('#list').onchange=function(e){
  var id=e.target.dataset.sel;
  if(id){
    var c=db.cars.find(function(c){return c.id===id;});
    c.selected=e.target.checked;render();saveCar(c);
  }
};
$('#all').onclick=function(){db.cars.forEach(function(c){c.selected=true;});render();saveCars(db.cars);};
$('#none').onclick=function(){db.cars.forEach(function(c){c.selected=false;});render();saveCars(db.cars);};

/* ---------- Dynamic Upload Handlers ---------- */
var dz = $('#drop');
if (dz) {
  dz.ondragover = function(e) { e.preventDefault(); dz.classList.add('over'); };
  dz.ondragleave = function() { dz.classList.remove('over'); };
  dz.ondrop = function(e) { e.preventDefault(); dz.classList.remove('over'); ingest([].slice.call(e.dataTransfer.files)); };
}

function triggerFilePicker(captureMode) {
  return new Promise(function(resolve) {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    if (captureMode) {
      input.capture = 'environment';
    } else {
      input.multiple = true;
    }
    input.onchange = function(e) {
      var files = [].slice.call(e.target.files);
      input.remove();
      resolve(files);
    };
    document.body.appendChild(input);
    input.click();
  });
}

document.addEventListener('click', async function(e) {
  if (e.target.id === 'upF' || e.target.closest('#upF')) {
    e.preventDefault();
    var files = await triggerFilePicker(false);
    if (files.length) ingest(files);
  }
  if (e.target.id === 'upC' || e.target.closest('#upC')) {
    e.preventDefault();
    var files = await triggerFilePicker(true);
    if (files.length) ingest(files);
  }
});

/* ---------- Editor ---------- */
const F=[['year','Year','number'],['make','Make'],['model','Model'],['grade','Grade'],['bodyType','Body type'],['colour','Colour'],['mileageKm','Mileage (km)','number'],
 ['mileageMi','Mileage (miles) - auto','number'],['engine','Engine (cc)'],['fuel','Fuel'],['transmission','Transmission'],['steering','Steering'],['vin','Chassis / VIN'],['stockId','Stock ID'],
 ['priceType','Price type','sel'],['baseYen','Car price (Yen) - FOB','number'],['basePound','Car price (GBP) - Cleared','number']];
function openEditor(c){
  cur=JSON.parse(JSON.stringify(c));$('#mt').textContent='EDIT CAR';
  $('#form').innerHTML=F.map(function(item){
    var k=item[0], l=item[1], t=item[2];
    return '<div data-w="' + k + '"><label>' + l + '</label>' + (t==='sel' ? '<select data-k="' + k + '"><option>FOB</option><option>Cleared</option></select>' : '<input data-k="' + k + '" type="' + (t==='number'?'number':'text') + '" ' + (t==='number'?'inputmode="decimal"':'') + ' value="' + esc(cur[k]) + '">') + '</div>';
  }).join('');
  $('#form [data-k=priceType]').value=cur.priceType;$('#feat').value=(cur.features||[]).join('\n');$('#notes').value=cur.notes||'';
  cur.docs=cur.docs||[];if(cur.basePound===undefined)cur.basePound=cur.priceType==='Cleared'?Math.round((cur.baseYen||0)/rate()):0;
  $('#form [data-k=basePound]').value=cur.basePound;
  $('#fees').innerHTML=[['incRoad','roadPrep','Road prep'],['incIva','iva','IVA test'],['incAdmin','admin','Administration fee']].map(function(item){
    var f=item[0], a=item[1], l=item[2];
    return '<label class="fee"><input type="checkbox" data-k="'+f+'" '+(cur[f]!==false?'checked':'')+'><span>'+l+' GBP</span><input data-k="'+a+'" type="number" inputmode="decimal" value="'+(cur[a] || 0)+'"></label>';
  }).join('')+'<div id="feeNote"></div>';
  vis();phs();calcLine();$('#modal').style.display='flex';$('#modal .card').scrollTop=0;document.body.style.overflow='hidden';
  getImgs(cur.images.concat(cur.docs)).then(function(){if(cur)phs();});
}
function vis(){
  var fob=cur.priceType!=='Cleared',old=+cur.year<2017;
  $('#form [data-w=baseYen]').style.display=fob?'':'none';$('#form [data-w=basePound]').style.display=fob?'none':'';
  ['incRoad','incIva'].forEach(function(k){ $('#fees [data-k='+k+']').disabled=old; });
  $('#feeNote').textContent=old?'Pre-2017: only car price + admin fee apply.':'2017+: car price + ticked fees.';
}
function calcLine(){var p=Pricing.calc(cur,rate());$('#pcalc').textContent='Pricing rule: +'+gbp(p.markup)+' · Trade price '+gbp(p.total);}
$('#modal').oninput=function(e){
  var k=e.target.dataset.k;if(!k)return;
  cur[k]=e.target.type==='checkbox'?e.target.checked:e.target.type==='number'?+e.target.value:e.target.value;
  if(k==='mileageKm'){cur.mileageMi=Math.round(cur.mileageKm*0.621371);$('#form [data-k=mileageMi]').value=cur.mileageMi;}
  if(k==='priceType'){Object.assign(cur,Pricing.defaults(cur.priceType,cur.year));['roadPrep','iva','admin'].forEach(function(x){$('#fees [data-k='+x+']').value=cur[x];});}
  vis();calcLine();
};
function phs(){
  $('#phs').innerHTML=cur.images.map(function(p,i){
    return '<div class="'+(i?'':'main')+'"><img src="'+src(p)+'"><button data-rm="'+i+'">×</button>'+(i?'<button class="m" data-main="'+i+'">★</button>':'')+'<button class="b" title="Move to reference docs" data-todoc="'+i+'">⇄</button></div>';
  }).join('')||'<small style="color:#888">none</small>';
  $('#docs').innerHTML=cur.docs.map(function(p,i){
    return '<div><img src="'+src(p)+'"><button data-rmd="'+i+'">×</button><button class="b" title="Use as PDF photo" data-topdf="'+i+'">⇄</button></div>';
  }).join('')||'<small style="color:#888">none</small>';
}
$('#modal').onclick=function(e){
  var d=e.target.dataset;
  if(d.rm!==undefined)cur.images.splice(+d.rm,1);
  if(d.main!==undefined)cur.images.unshift.apply(cur.images,cur.images.splice(+d.main,1));
  if(d.todoc!==undefined)cur.docs.push.apply(cur.docs,cur.images.splice(+d.todoc,1));
  if(d.rmd!==undefined)cur.docs.splice(+d.rmd,1);
  if(d.topdf!==undefined)cur.images.push.apply(cur.images,cur.docs.splice(+d.topdf,1));
  if(['rm','main','todoc','rmd','topdf'].some(function(k){return d[k]!==undefined;}))phs();
};
$('#addPh').onclick=async function(){
  var files=await triggerFilePicker(false);
  if(files.length){
    var g=await importFiles(files,false);
    if(g[0])cur.images.push.apply(cur.images,g[0]);
    phs();
  }
};
var closeEd=function(){$('#modal').style.display='none';document.body.style.overflow='';};
$('#cancel').onclick=closeEd;
$('#ok').onclick=function(){
  cur.features=$('#feat'].value.split('\n').map(function(s){return s.trim();}).filter(Boolean);
  cur.notes=$('#notes'].value;
  var i=db.cars.findIndex(function(c){return c.id===cur.id;});
  db.cars[i]=cur;render();closeEd();saveCar(cur);
};

/* ---------- Catalog generator ---------- */
const FIELDS=['catName','phone','email','message','subtitle','rate'],CHK=['incPhone','incEmail','incMessage'];
var saveSettings = function() {
  FIELDS.forEach(function(k){ S()[k]=$('#'+k).value; });
  CHK.forEach(function(k){ S()[k]=$('#'+k).checked; });
  persistSettings();render();
};
FIELDS.concat(CHK).forEach(function(k){ $('#'+k).addEventListener('input',saveSettings); });

let logoData;
async function logo(){
  if(logoData)return logoData;
  var res = await fetch('assets/logo.png');
  var b=await res.blob();
  return logoData=await new Promise(function(r){var f=new FileReader();f.onload=function(){r(f.result);};f.readAsDataURL(b);});
}

async function makePdf(payload){
  var l = await logo();
  var html=buildPdfHtml(Object.assign({}, payload, { logo: l, src: src }));
  var fr=document.createElement('iframe');fr.style.cssText='position:fixed;left:-10000px;top:0;width:794px;height:1123px;border:0';
  document.body.appendChild(fr);
  await new Promise(function(r){fr.onload=r;fr.srcdoc=html;});
  var d=fr.contentDocument;
  var imgs = [].slice.call(d.images);
  await Promise.all(imgs.map(function(i){return i.decode().catch(function(){});}));
  fr.style.height=d.documentElement.scrollHeight+'px';
  var pages=[].slice.call(d.querySelectorAll('.page')),pdf=new window.jspdf.jsPDF({unit:'mm',format:'a4',compress:true});
  for(let i=0;i<pages.length;i++){
    say('Building PDF: page '+(i+1)+' of '+pages.length+'...');
    var cv=await html2canvas(pages[i],{scale:2,useCORS:true,backgroundColor:'#ffffff'});
    if(i)pdf.addPage();
    pdf.addImage(cv.toDataURL('image/jpeg',0.9),'JPEG',0,0,210,297);
    cv.width=cv.height=0;
    await new Promise(function(r){setTimeout(r);});
  }
  fr.remove();return pdf.output('blob');
}
$('#gen').onclick=async function(){
  var cars=db.cars.filter(function(c){return c.selected;});
  if(!cars.length)return alert('Tick at least one car first.');
  var s=S();
  var opts={name:s.catName||'Trade Price Catalogue',subtitle:s.subtitle,phone:s.phone,email:s.email,message:s.message,incPhone:s.incPhone,incEmail:s.incEmail,incMessage:s.incMessage};
  var btn=$('#gen');btn.disabled=true;$('#done').style.display='none';
  try{
    say('Loading photos...');
    await getImgs(cars.flatMap(function(c){return c.images||[];}));
    var blob=await makePdf({cars,opts,rate:rate()});
    var name=(opts.name.replace(/[^\w\- ]+/g,'').trim()||'Catalogue')+'.pdf';
    lastPdf={blob,name};
    say('PDF ready.');
    $('#doneMsg').textContent=name+' is ready ('+(blob.size/1048576).toFixed(1)+' MB)';
    $('#shareBtn').style.display=navigator.canShare?'':'none';
    $('#done').style.display='block';
  }catch(e){
    say('PDF failed: '+e.message);
    alert('PDF failed: '+e.message);
  }
  btn.disabled=false;
};
var download = function(){
  var a=document.createElement('a');
  a.href=URL.createObjectURL(lastPdf.blob);
  a.download=lastPdf.name;
  document.body.appendChild(a);
  a.click();
  setTimeout(function(){URL.revokeObjectURL(a.href);a.remove();},4000);
};
$('#dlBtn').onclick=function(){if(lastPdf)download();};
$('#shareBtn').onclick=async function(){
  if(!lastPdf)return;
  var f=new File([lastPdf.blob],lastPdf.name,{type:'application/pdf'});
  try{
    if(navigator.canShare&&navigator.canShare({files:[f]})) await navigator.share({files:[f],title:lastPdf.name});
    else download();
  }catch(e){
    if(e.name!=='AbortError')download();
  }
};
$('#closeDone').onclick=function(){$('#done').style.display='none';};

/* ---------- Start / login ---------- */
const FIELDS_DEFAULT={rate:208.7,incPhone:true,incEmail:true,incMessage:true};
function showLogin(msg){$('#login').style.display='flex';$('#lerr').textContent=msg||'';}
async function boot(user){
  UID=user.id;
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  say('Loading your library...');
  
  var settingsPromise = sb.from('settings').select('data').maybeSingle();
  var carsPromise = sb.from('cars').select('data, updated_at').order('updated_at', { ascending: false }).catch(function() { return sb.from('cars').select('data'); });
  
  var results = await Promise.all([settingsPromise, carsPromise]);
  var st = results[0];
  var cars = results[1];
  
  cloudErr('load', cars.error || st.error);
  db.cars=(cars.data||[]).map(function(r){return r.data;});
  
  var stData = (st.data && st.data.data) ? st.data.data : {};
  db.settings=Object.assign({},FIELDS_DEFAULT,stData);
  
  FIELDS.forEach(function(k){ $('#'+k).value = S()[k] || ''; });
  CHK.forEach(function(k){ $('#'+k).checked = !!S()[k]; });
  
  $('#login').style.display='none';
  render();
  say('');
}
$('#lgo').onclick=async function(){
  $('#lerr').textContent='Signing in...';
  var authRes = await sb.auth.signInWithPassword({email:$('#lem').value.trim(),password:$('#lpw').value});
  if(authRes.error)return showLogin(authRes.error.message);
  await boot(authRes.data.user);
};
$('#lpw').onkeydown=function(e){if(e.key==='Enter')$('#lgo').click();};
$('#out').onclick=async function(){await sb.auth.signOut();location.reload();};
(async function(){
  if('serviceWorker' in navigator)navigator.serviceWorker.register('sw.js').catch(function(){});
  if(/YOUR-/.test(SUPABASE_URL+SUPABASE_ANON_KEY))return showLogin('Put your Supabase URL and anon key into config.js first.');
  var sessionRes = await sb.auth.getSession();
  var session = sessionRes.data.session;
  session?await boot(session.user):showLogin();
})();
