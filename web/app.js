/* Madrid — Urban Nature Map. React 18 + htm, no build step.
   Data: data/{trees,osm,buildings}.json (scripts/trees.py, osm.py, buildings.py),
         data/cases.json and media/ (scripts/build_archive.py, from db/archivo_fotografias.xlsx + db/fotografias),
         data/places.json (scripts/places.py),
         tiles/1956 (scripts/ortho1956.py). The map frame constants match scripts/frame.py. */
'use strict';
const {useState,useEffect,useLayoutEffect,useRef,useCallback}=React;
const html=htm.bind(React.createElement);
const KM=1000, STEPS=[1000,500,250,100,50], PHOTO_PX=110, ROTATE=8000;
const FONT='"Courier Prime","Courier New",Courier,monospace'; // one typewriter face for everything, canvas included
const REDUCED=matchMedia('(prefers-reduced-motion: reduce)').matches;
const TOUCH=matchMedia('(hover: none)').matches;   // phones and tablets: no hover, taps and gestures instead
const TAP=TOUCH?'Toca':'Haz clic en';
const MOBILE=TOUCH;   // phone behaviour: the map stays inside its frame, a pinned square shows one file at a time, the explorer compares with a seam
// the page itself never zooms (iOS ignores user-scalable=no): pinching is the map's
if(TOUCH)for(const ev of ['gesturestart','gesturechange'])document.addEventListener(ev,e=>e.preventDefault(),{passive:false});
// two fingers on screen: their midpoint and spread (client px)
const pinchOf=ps=>{const [a,b]=[...ps.values()];return {cx:(a.x+b.x)/2,cy:(a.y+b.y)/2,d:Math.max(1,Math.hypot(a.x-b.x,a.y-b.y))}};
// grid refines as you zoom: the coarsest step whose square is no bigger than ~2 photo footprints
const stepFor=s=>STEPS.find(st=>st*s<=PHOTO_PX*1.25)||STEPS[STEPS.length-1];
// the squares that hold cases: n x n grid steps, about one photo footprint on screen; the size must divide the frame
// on both axes, so no row or column of squares spills over its edge (12 x 14 km: at most 2 km)
const gridFor=(s,D)=>{const st=stepFor(s),t=Math.max(1,Math.round(PHOTO_PX/(st*s)));let n=1;
  for(let k=1;k<=t;k++)if((2*D.W)%(k*st)===0&&(2*D.H)%(k*st)===0)n=k;return {st,B:n*st}};

/* ---------- data ---------- */
const b64=(s,T)=>{const b=atob(s),u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return new T(u.buffer)};
async function loadData(){
  const get=u=>fetch(u).then(r=>{if(!r.ok)throw new Error(u+' '+r.status);return r.json()});
  const [t,o,bu,pl]=await Promise.all([get('data/trees.json'),get('data/osm.json'),get('data/buildings.json'),get('data/places.json').catch(()=>({places:[]}))]);
  const x=b64(t.x,Int16Array),y=b64(t.y,Int16Array),h=b64(t.h_quarter_m,Uint8Array);
  const r=new Float32Array(x.length);for(let i=0;i<r.length;i++)r[i]=1.2+h[i]/4*.28; // crown radius (m) from height
  const paths={};
  for(const k of ['water','green']){const p=new Path2D();for(const d of o.layers[k]||[]){let px=0,py=0;for(let i=0;i<d.length;i+=2){px+=d[i];py+=d[i+1];i?p.lineTo(px,py):p.moveTo(px,py)}p.closePath()}paths[k]=p}
  // buildings: one Path2D per 2000 rings. A single path for a class (~1M points) takes tens of seconds to build in Chromium,
  // since appending slows down as a path grows; chunks keep the whole load under a second.
  const bld=bu.rings.map(c=>{const L=b64(c.len,Uint16Array),d=b64(c.d,Int16Array),ps=[];let j=0,p=null;
    for(let k=0;k<L.length;k++){if(k%2000===0)ps.push(p=new Path2D());let px=0,py=0;for(let i=0;i<L[k];i++,j+=2){px+=d[j];py+=d[j+1];i?p.lineTo(px,py):p.moveTo(px,py)}p.closePath()}return ps});
  return {W:t.frame[0],H:t.frame[1],origin:t.origin,n:x.length,x,y,r,paths,bld,places:pl.places};
}
/* a square's name: the nearest place of a level that suits its size (districts for 2 km and up, barrios down to 500 m,
   then plazas and neighbourhoods), found within about the square's size of its centre; else the nearest barrio */
const PLACE_LEVELS=size=>size>=2000?['suburb']:size>=500?['quarter','suburb']:['square','neighbourhood','quarter'];
const nameCache=new Map();
function squareName(D,T){const k=T.x0+','+T.y0+','+T.size;if(nameCache.has(k))return nameCache.get(k);
  const cx=T.x0+T.size/2,cy=T.y0+T.size/2,d=p=>Math.hypot(p[2]-cx,p[3]-cy),near=ps=>ps.reduce((a,p)=>!a||d(p)<d(a)?p:a,null);
  let best=null;for(const t of PLACE_LEVELS(T.size)){const p=near(D.places.filter(p=>p[1]===t&&d(p)<=T.size*.9));if(p){best=p;break}}
  if(!best)best=near(D.places.filter(p=>p[1]==='quarter'));
  const name=best?best[0]:'';nameCache.set(k,name);return name}
const toLocal=(D,lon,lat)=>[(lon-D.origin[0])*111320*Math.cos(D.origin[1]*Math.PI/180),(lat-D.origin[1])*110574];

/* ---------- orthophotos ----------
   1956: Vuelo Americano Serie B, cut into our own tiles aligned to the map frame (scripts/ortho1956.py):
         level L = 0.5*2^L m/px, 512 px tiles, column from the west edge, row from the south edge.
   hoy:  PNOA, IGN's pre-rendered Web Mercator tiles (fast, cached at IGN), placed by their corner coordinates. */
const T56={res:.5,tile:512,top:4,pad:2048,url:(L,c,r)=>`tiles/1956/${L}/${c}_${r}.jpg`};
const PNOA=(z,x,y)=>`https://www.ign.es/wmts/pnoa-ma?service=WMTS&request=GetTile&version=1.0.0&layer=OI.OrthoimageCoverage&style=default&tilematrixset=GoogleMapsCompatible&tilematrix=${z}&tilerow=${y}&tilecol=${x}&format=image/jpeg`;
const toLL=(D,x,y)=>[D.origin[0]+x/(111320*Math.cos(D.origin[1]*Math.PI/180)),D.origin[1]+y/110574];
const imgs=new Map();
const getImg=u=>{let q=imgs.get(u);if(!q){q=new Promise(res=>{const im=new Image();im.onload=()=>res(im);im.onerror=()=>res(null);im.src=u});imgs.set(u,q);
  if(imgs.size>800)imgs.delete(imgs.keys().next().value)}return q};
// paint the map rectangle b = {x0,y0,w,h} (metres) into canvas c at pw x ph pixels; tiles land as they arrive
function paintOrtho(c,D,b,which,pw,ph){
  const tok=c._tok=(c._tok||0)+1;if(c.width!==pw)c.width=pw;if(c.height!==ph)c.height=ph;const g=c.getContext('2d');g.fillStyle=col('--b1');g.fillRect(0,0,pw,ph);
  const k=pw/b.w,X=x=>(x-b.x0)*k,Y=y=>(b.y0+b.h-y)*k,put=(u,x0,y0,x1,y1)=>getImg(u).then(im=>{if(im&&c._tok===tok)g.drawImage(im,X(x0),Y(y1),X(x1)-X(x0)+.6,Y(y0)-Y(y1)+.6)});
  const need=b.w/pw,xa=b.x0,xb=b.x0+b.w,ya=b.y0,yb=b.y0+b.h; // metres per pixel wanted
  if(which==='before'){
    const L=Math.max(0,Math.min(T56.top,Math.floor(Math.log2(need/T56.res)))),T=T56.tile*T56.res*2**L;
    const P=T56.pad;for(let cc=Math.floor((Math.max(xa,-D.W-P)+D.W)/T);cc*T-D.W<Math.min(xb,D.W+P);cc++)for(let rr=Math.floor((Math.max(ya,-D.H-P)+D.H)/T);rr*T-D.H<Math.min(yb,D.H+P);rr++)
      put(T56.url(L,cc,rr),cc*T-D.W,rr*T-D.H,(cc+1)*T-D.W,(rr+1)*T-D.H);
  }else{
    const lat0=D.origin[1]*Math.PI/180,z=Math.max(10,Math.min(19,Math.ceil(Math.log2(156543.034*Math.cos(lat0)/need)))),n=2**z;
    const tx=lon=>(lon+180)/360*n,ty=lat=>{const f=lat*Math.PI/180;return(1-Math.log(Math.tan(f)+1/Math.cos(f))/Math.PI)/2*n};
    const lon=t=>t/n*360-180,lat=t=>Math.atan(Math.sinh(Math.PI*(1-2*t/n)))*180/Math.PI,loc=(lo,la)=>[(lo-D.origin[0])*111320*Math.cos(lat0),(la-D.origin[1])*110574];
    const [lo0,la0]=toLL(D,xa,ya),[lo1,la1]=toLL(D,xb,yb);
    for(let i=Math.floor(tx(lo0));i<=Math.floor(tx(lo1));i++)for(let j=Math.floor(ty(la1));j<=Math.floor(ty(la0));j++){
      const [x0,y1]=loc(lon(i),lat(j)),[x1,y0]=loc(lon(i+1),lat(j+1));put(PNOA(z,i,j),x0,y0,x1,y1)}
  }
}
// a canvas showing one year of orthophoto for square b; resolution follows its on-screen size (rounded up to a power of two)
function Ortho({D,b,which,size,cls}){
  const cv=useRef(),px=Math.min(2048,2**Math.ceil(Math.log2(Math.max(64,size*(devicePixelRatio||1)))));
  useEffect(()=>{paintOrtho(cv.current,D,{x0:b.x0,y0:b.y0,w:b.size,h:b.size},which,px,px)},[b.x0,b.y0,b.size,which,px]);
  return html`<canvas ref=${cv} class=${cls} aria-hidden="true"></canvas>`}

/* ---------- the archive: cases ----------
   A case is one geolocated record: exact (a point) or approximate (a point and a radius r in metres), holding any number of items:
   versions {photos:[{src,label}...]} · photo {src,label} · text {body,label} · audio {src,label} · file {src,label}. Source: data/cases.json.
*/
const leadIndex=c=>{for(const t of ['versions','photo','audio','text','file']){const i=c.items.findIndex(it=>it.type===t);if(i>=0)return i}return 0};
const catNo=c=>'Nº '+String(c.n).padStart(3,'0');
const where=c=>c.loc==='estimate'?'±'+c.r+' m, estimada':c.loc==='gps'?'GPS de la foto':c.r?'±'+c.r+' m':'exacta';
const mapLink=c=>c.lat!=null&&`https://www.google.com/maps?q=${c.lat},${c.lon}`;
const itemName=it=>it.type==='versions'?it.photos.map(p=>p.v).join(' · '):it.label||(it.type==='text'?it.body.slice(0,40):it.type==='photo'?'Foto':it.src.split('/').pop());
const ext=s=>(s.split('.').pop()||'').toLowerCase();
const firstSrc=it=>it.type==='versions'?it.photos[0].src:it.type==='photo'?it.src:null;


/* matched black and white: neutral grey (removes sepia and yellowing), levels stretched to the 1st-99th percentile,
   then a gamma that puts the median at mid-grey, so a pair's two photos compare on equal terms. Cached per source. */
const eqCache=new Map();
function equalize(src){let q=eqCache.get(src);if(q)return q;
  q=new Promise(res=>{const im=new Image();im.onerror=()=>res(src);im.onload=()=>{try{
    const k=Math.min(1,1400/Math.max(im.width,im.height)),c=document.createElement('canvas');c.width=Math.round(im.width*k);c.height=Math.round(im.height*k);
    const g=c.getContext('2d');g.drawImage(im,0,0,c.width,c.height);const d=g.getImageData(0,0,c.width,c.height),a=d.data,n=a.length/4,L=new Uint8ClampedArray(n),h=new Uint32Array(256);
    for(let i=0;i<n;i++){L[i]=.2126*a[4*i]+.7152*a[4*i+1]+.0722*a[4*i+2];h[L[i]]++}
    let lo=0,hi=255,acc=0,med=0;for(;lo<254&&(acc+=h[lo])<n*.01;lo++);acc=0;for(;hi>lo+1&&(acc+=h[hi])<n*.01;hi--);
    acc=0;for(;med<255&&(acc+=h[med])<n/2;med++);
    const m=Math.min(.95,Math.max(.05,(med-lo)/(hi-lo))),gam=Math.min(1.6,Math.max(.6,Math.log(.5)/Math.log(m))),lut=new Uint8ClampedArray(256);
    for(let v=0;v<256;v++)lut[v]=255*Math.pow(Math.min(1,Math.max(0,(v-lo)/(hi-lo))),gam);
    for(let i=0;i<n;i++)a[4*i]=a[4*i+1]=a[4*i+2]=lut[L[i]];
    g.putImageData(d,0,0);res(c.toDataURL('image/jpeg',.88))}catch(e){res(src)}};im.src=src});
  eqCache.set(src,q);return q}
// a photo that switches to its matched black-and-white version when eq is on
function Pic({src,eq,cls,alt,style}){const [out,setOut]=useState(null);
  useEffect(()=>{let live=true;setOut(null);if(eq)equalize(src).then(u=>live&&setOut(u));return()=>{live=false}},[src,eq]);
  return html`<img src=${eq&&out?out:src} class=${cls} style=${style} alt=${alt||''} draggable="false"/>`}
// a card's versions: the first shows; while the card is lit they take turns, cross-fading
const yearTag=p=>html`<span class="yr">${p.year||'s/f'}</span>`;   // every photo shows its year ("sin fecha" if unknown)
function Cycle({photos,eq,on}){const [k,setK]=useState(0);
  useEffect(()=>{if(!on){setK(0);return}if(!TOUCH)setK(1%photos.length);const iv=setInterval(()=>setK(x=>(x+1)%photos.length),TOUCH?1900:1300);return()=>clearInterval(iv)},[on,photos.length]);
  return html`${photos.map((p,i)=>html`<${Pic} key=${p.src} cls=${'v'+(i===k?' on':'')} src=${p.src} eq=${eq}/>`)}${yearTag(photos[k])}`}

/* sound: one plays at a time; the waveform is the file's own, decoded once */
const peaksCache=new Map();let playing=null;
const peaksOf=(src,n)=>{const k=src+'|'+n;let q=peaksCache.get(k);if(!q){q=fetch(src).then(r=>r.arrayBuffer()).then(b=>new OfflineAudioContext(1,1,22050).decodeAudioData(b)).then(a=>{
  const d=a.getChannelData(0),w=Math.floor(d.length/n),o=[];for(let i=0;i<n;i++){let m=0;for(let j=i*w;j<(i+1)*w;j+=4)m=Math.max(m,Math.abs(d[j]));o.push(m)}
  const M=Math.max(...o)||1;return o.map(x=>x/M)}).catch(()=>null);peaksCache.set(k,q)}return q};
function Sound({src,label,variant}){ // variant: 'dot' (play button only), 'mini' (card), 'big' (stage)
  const a=useRef(),n=variant==='big'?96:variant==='mini'?22:48,[pk,setPk]=useState(null),[t,setT]=useState(0),[on,setOn]=useState(false);
  useEffect(()=>{let live=true;if(variant!=='dot')peaksOf(src,n).then(p=>live&&setPk(p));return()=>{live=false;a.current&&a.current.pause()}},[src,n]);
  const stop=e=>e.stopPropagation();
  const toggle=e=>{stop(e);const el=a.current;if(el.paused){if(playing&&playing!==el)playing.pause();playing=el;el.play()}else el.pause()};
  const seek=e=>{stop(e);const el=a.current,b=e.currentTarget.getBoundingClientRect();if(el.duration){el.currentTime=(e.clientX-b.left)/b.width*el.duration;if(el.paused)toggle(e)}};
  const btn=html`<button class=${variant==='dot'?'dot':'play'} aria-label=${(on?'Pausa ':'Reproducir ')+(label||'audio')} onClick=${toggle} onPointerDown=${stop} onPointerUp=${stop}>${on?'❚❚':'▶'}</button>`;
  const el=html`<audio ref=${a} src=${src} preload="metadata" onPlay=${()=>setOn(true)} onPause=${()=>setOn(false)} onEnded=${()=>{setOn(false);setT(0)}} onTimeUpdate=${e=>setT(e.target.currentTime/(e.target.duration||1))}/>`;
  if(variant==='dot')return html`${el}${btn}`;
  return html`<div class=${'sound '+(variant||'')+(on?' on':'')}>${el}${btn}
    <div class="wave" onClick=${seek} onPointerDown=${stop} onPointerUp=${stop}>${(pk||Array(n).fill(.12)).map((h,i)=>html`<i key=${i} class=${(i+.5)/n<=t?'done':''} style=${{height:Math.max(6,h*100)+'%'}}></i>`)}</div></div>`}

/* canvas can't read light-dark() variables: resolve them through a probe element */
const probe=document.createElement('i');probe.style.display='none';document.body.appendChild(probe);
const col=n=>{probe.style.color=`var(${n})`;return getComputedStyle(probe).color};

/* squares: every grid square (of the zoom's size) that holds at least one case. An approximate case is shown only while its
   uncertainty (2r) fits in a square: zoomed in further, the archive cannot say which square it belongs to, so it is left out. */
const tileOf=(D,B,x,y)=>[Math.floor((x+D.W)/B),Math.floor((y+D.H)/B)];
function tilesFor(D,cases,B){const t={};
  for(const c of Object.values(cases)){if(2*c.r>B)continue;const [i,j]=tileOf(D,B,c.x,c.y),k=i+','+j;
    (t[k]||(t[k]={key:k,x0:-D.W+i*B,y0:-D.H+j*B,size:B,ids:[]})).ids.push(c.id)}
  for(const q of Object.values(t))q.ids.sort((a,b)=>cases[a].n-cases[b].n);return t}
const hash=s=>{let h=2166136261;for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),16777619);return (h>>>0)/4294967296};
/* ---------- laying out cards ----------
   A card takes w x h grid squares chosen from its content, inset by a small gutter. Each is packed near its anchor square,
   outside a blocked zone, nearest first and spread round the compass (a card in a crowded direction costs more). */
const aspects=new Map(); // photo src -> width/height, filled as images load
const preloadAspects=(cases,done)=>{for(const c of Object.values(cases))for(const it of c.items){const src=firstSrc(it);
  if(src&&!aspects.has(src)){aspects.set(src,null);getImg(src).then(im=>{aspects.set(src,im?im.naturalWidth/im.naturalHeight:1.33);done()})}}};
function shapes(it,big){
  if(firstSrc(it)){const r=aspects.get(firstSrc(it))||1.33;
    if(r>=1.2)return big?[[3,2],[2,1],[1,1]]:[[2,1],[1,1]];
    if(r<=.83)return big?[[2,3],[1,2],[1,1]]:[[1,2],[1,1]];
    return big?[[2,2],[1,1]]:[[1,1]]}
  if(it.type==='text')return big?[[2,2],[2,1],[1,1]]:[[2,1],[1,1]];
  if(it.type==='audio')return [[2,1],[1,1]];
  return [[1,1]]}
const GUT=5;
// ctx: {U (square side, m), ox,oy (grid origin, m), v, bw,bh, avoid, blocked(i,j), reach, occ:Set, dirs:Map, air (keep a square free around each card)}
function packOne(L,ctx){const {U,ox,oy,v,bw,bh,avoid,blocked,reach,occ,dirs}=ctx;
  for(const [w,h] of L.shapes){let best=null;
    for(let i=L.ai-reach-w+1;i<=L.ai+reach;i++)for(let j=L.aj-reach-h+1;j<=L.aj+reach;j++){
      let ok=true;for(let a=0;a<w&&ok;a++)for(let b=0;b<h&&ok;b++)if(occ.has((i+a)+','+(j+b))||blocked(i+a,j+b))ok=false;if(!ok)continue;
      const left=v.tx+(ox+i*U)*v.s+GUT,top=v.ty-(oy+(j+h)*U)*v.s+GUT,W=w*U*v.s-2*GUT,H=h*U*v.s-2*GUT;
      if(left<10||top<10||left+W>bw-10||top+H>bh-10)continue;
      if(avoid.some(r=>left<r.right+6&&left+W>r.left-6&&top<r.bottom+6&&top+H>r.top-6))continue;
      const cx=i+w/2-(L.ai+.5),cy=j+h/2-(L.aj+.5),oct=(Math.round(Math.atan2(cy,cx)/(Math.PI/4))+8)%8;
      const sc=Math.hypot(cx,cy)+1.1*(dirs.get(L.anchorKey+oct)||0)+.6*hash(L.key+'|'+i+','+j);
      if(!best||sc<best.sc)best={sc,i,j,w,h,left,top,W,H,oct}}
    if(best){const m=ctx.air?1:0;for(let a=-m;a<best.w+m;a++)for(let b=-m;b<best.h+m;b++)occ.add((best.i+a)+','+(best.j+b));
      dirs.set(L.anchorKey+best.oct,(dirs.get(L.anchorKey+best.oct)||0)+1);return {...L,...best}}}
  return null}
// the hairline from a card to a point (screen px): it leaves the card at the edge point nearest to it
const leaderTo=(r,px,py)=>[Math.min(r.left+r.W,Math.max(r.left,px)),Math.min(r.top+r.H,Math.max(r.top,py)),px,py];

/* ---------- map ---------- */
function MapView({D,layers,cases,onOpen,paused,pick,onPick,mark,fly,children}){
  const box=useRef(),cv=useRef(),under=useRef(),over=useRef(),view=useRef(null),[tick,setTick]=useState(0),[hover,setHover]=useState(null),[wipe,setWipe]=useState(.5),[intro,setIntro]=useState(false),drag=useRef(null);
  const [pin,setPin]=useState(null),[page,setPage]=useState(0),entering=useRef(false),lastW=useRef(.5),anim=useRef(),sweep=useRef();
  const [lit,setLit]=useState(null),avoid=useRef({s:'',a:[]});
  const [cards,setCards]=useState([]),recent=useRef([]),unplaced=useRef([]),noRoom=useRef({tick:-1,ids:new Set()});
  /* The base map is expensive to draw (every building), so it is drawn only once the view settles: while panning or zooming,
     the last drawing is moved and scaled with a CSS transform. Moves are batched to one per frame, and the floating cards
     step aside while the map moves and return after a pause. */
  const [drawTick,setDrawTick]=useState(0),[moving,setMoving]=useState(false),drawn=useRef(null),raf=useRef(0),settle=useRef();
  /* phones: the frame never leaves the screen. Zoomed in, its edges stop at a margin from the screen's; zoomed out, it stays whole */
  const clampView=()=>{const v=view.current;if(!MOBILE||!v||!box.current)return;const b=box.current.getBoundingClientRect(),m=36;
    const ax=(t,len,half)=>{const a=len-m-half,c=m+half;return Math.min(Math.max(a,c),Math.max(Math.min(a,c),t))};
    v.tx=ax(v.tx,b.width,D.W*v.s);v.ty=ax(v.ty,b.height,D.H*v.s)};
  const kick=()=>{clampView();if(!raf.current)raf.current=requestAnimationFrame(()=>{raf.current=0;setTick(t=>t+1)});
    setMoving(true);clearTimeout(settle.current);settle.current=setTimeout(()=>setMoving(false),650)};
  useEffect(()=>{const t=setTimeout(()=>setDrawTick(x=>x+1),120);return()=>clearTimeout(t)},[tick]);
  useLayoutEffect(()=>{const d=drawn.current,v=view.current;if(!d||!v)return;const k=v.s/d.s;
    cv.current.style.transform=k===1&&v.tx===d.tx&&v.ty===d.ty?'':`translate(${v.tx-d.tx*k}px,${v.ty-d.ty*k}px) scale(${k})`});
  // fit the frame to the screen, below the title and its introduction (the frame's top labels need ~40 px above it)
  const fit=useCallback(()=>{const b=box.current.getBoundingClientRect(),m=46,ti=box.current.querySelector('.title'),top=Math.max(m,ti?ti.getBoundingClientRect().bottom-b.top+44:m);
    const s=Math.min((b.width-2*m)/(2*D.W),(b.height-top-m)/(2*D.H));view.current={s,tx:b.width/2,ty:top+(b.height-top-m)/2,min:s*.7,max:s*60};setTick(t=>t+1)},[D]);
  useEffect(()=>{document.fonts&&document.fonts.ready.then(()=>setTick(t=>t+1))},[]);
  useEffect(()=>{fit();const ro=new ResizeObserver(()=>fit());ro.observe(box.current);const mo=new MutationObserver(()=>setTick(t=>t+1));mo.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
    const mq=matchMedia('(prefers-color-scheme: dark)'),f=()=>setTick(t=>t+1);mq.addEventListener('change',f);return()=>{ro.disconnect();mo.disconnect();mq.removeEventListener('change',f)}},[fit]);

  useEffect(()=>{ // draw
    const v=view.current;if(!v)return;const c=cv.current,b=box.current.getBoundingClientRect(),dpr=devicePixelRatio||1;drawn.current={s:v.s,tx:v.tx,ty:v.ty};c.style.transform='';
    c.width=b.width*dpr;c.height=b.height*dpr;const g=c.getContext('2d');
    const {s,tx,ty}=v,W=D.W,H=D.H,sx=x=>tx+x*s,sy=y=>ty-y*s,st=stepFor(s);
    g.setTransform(dpr,0,0,dpr,0,0);g.save();g.beginPath();g.rect(sx(-W),sy(H),2*W*s,2*H*s);g.clip();g.fillStyle=col('--bg');g.fill();
    g.setTransform(dpr*s,0,0,-dpr*s,dpr*tx,dpr*ty);
    if(layers.green){g.fillStyle=col('--green');g.fill(D.paths.green)}
    if(layers.buildings){D.bld.forEach((ps,i)=>{g.fillStyle=col('--b'+i);for(const p of ps)g.fill(p,'evenodd')})}
    // water courses lead: drawn above buildings, with a 2 px outline so the river stays a continuous ribbon
    if(layers.water){g.fillStyle=g.strokeStyle=col('--water');g.fill(D.paths.water);g.lineJoin='round';g.lineWidth=2/s;g.stroke(D.paths.water)}
    g.setTransform(dpr,0,0,dpr,0,0);
    if(layers.trees){ // trees in screen space, culled to the view
      const x0=-tx/s,x1=(b.width-tx)/s,y1=ty/s,y0=(ty-b.height)/s,big=s>.35,zf=Math.min(2.2,1+s*1.5);
      g.fillStyle=col('--tree');g.globalAlpha=big?.32:.07+Math.min(.14,s*.3);if(big)g.beginPath();
      for(let i=0;i<D.n;i++){const x=D.x[i],y=D.y[i];if(x<x0-20||x>x1+20||y<y0-20||y>y1+20)continue;const X=tx+x*s,Y=ty-y*s;
        if(big){const r=Math.max(1.6,D.r[i]*s);g.moveTo(X+r,Y);g.arc(X,Y,r,0,6.2832)}else{const z=.85*zf;g.fillRect(X-z/2,Y-z/2,z,z)}}
      if(big)g.fill();g.globalAlpha=1;
    }
    g.restore();
  },[drawTick,D,layers.green,layers.water,layers.buildings,layers.trees]);
  /* Cheap layers redrawn on every move, so the grid is always there while the base map catches up:
     under it, the frame's ground (the paper texture shows outside); over it, the grid, the frame and its labels. */
  useLayoutEffect(()=>{const v=view.current;if(!v)return;const b=box.current.getBoundingClientRect(),dpr=devicePixelRatio||1,{s,tx,ty}=v,W=D.W,H=D.H,sx=x=>tx+x*s,sy=y=>ty-y*s;
    const prep=c=>{const w=Math.round(b.width*dpr),h=Math.round(b.height*dpr);if(c.width!==w)c.width=w;if(c.height!==h)c.height=h;const g=c.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,b.width,b.height);return g};
    box.current.style.backgroundPosition=`${tx}px ${ty}px`; // the paper outside the frame moves with the map
    let g=prep(under.current);g.fillStyle=col('--bg');g.fillRect(sx(-W),sy(H),2*W*s,2*H*s);
    g=prep(over.current);g.save();g.beginPath();g.rect(sx(-W),sy(H),2*W*s,2*H*s);g.clip();
    const line=(stp,css)=>{g.strokeStyle=col(css);g.lineWidth=1;g.beginPath();   // grid: fine steps light, kilometres stronger
      const xa=Math.max(-W,-tx/s),xb=Math.min(W,(b.width-tx)/s),ya=Math.max(-H,(ty-b.height)/s),yb=Math.min(H,ty/s);
      for(let x=Math.ceil((xa+W)/stp)*stp-W;x<=xb;x+=stp){const X=Math.round(sx(x))+.5;g.moveTo(X,sy(H));g.lineTo(X,sy(-H))}
      for(let y=Math.ceil((ya+H)/stp)*stp-H;y<=yb;y+=stp){const Y=Math.round(sy(y))+.5;g.moveTo(sx(-W),Y);g.lineTo(sx(W),Y)}g.stroke()};
    const st=stepFor(s);if(st<KM)line(st,'--grid');line(KM,'--gridk');g.restore();
    g.strokeStyle=col('--frame');g.lineWidth=1;g.strokeRect(sx(-W)+.5,sy(H)+.5,2*W*s,2*H*s);
    g.fillStyle=col('--mute');g.font='11px '+FONT;g.textBaseline='middle';
    const L=Math.max(4,sx(-W)-6);g.textAlign='right';
    const nH=2*H/KM,nW=2*W/KM,ev=Math.ceil(26/(KM*s)),lab=(k,n)=>k===n||(k%ev===0&&n-k>=ev);   // axes: kilometres from the south-west corner, "km" only on the last label; thinned out when they crowd
    for(let k=1;k<=nH;k++){const Y=sy(-H+k*KM);if(Y<8||Y>b.height-8||!lab(k,nH))continue;g.fillText(k===nH?k+' km':''+k,L-6,Y)}
    g.textAlign='center';const B=Math.min(b.height-12,sy(-H)+16);
    for(let c=1;c<=nW;c++){const X=sx(-W+c*KM);if(X>12&&X<b.width-12&&lab(c,nW))g.fillText(c===nW?c+' km':''+c,X,B)}
    g.fillStyle=col('--ink');g.font='700 18px '+FONT;const T=sy(H)-18;if(T>14)g.fillText('N',sx(0),T);
    g.textAlign='left';g.textBaseline='alphabetic';g.font='700 15px '+FONT;const MY=sy(H)-8;if(MY>12)g.fillText('Madrid',Math.max(8,sx(-W)),MY)});

  const v=view.current,G=v&&gridFor(v.s,D),tiles=v?tilesFor(D,cases,G.B):{};
  const toM=e=>{const b=box.current.getBoundingClientRect(),v=view.current;return [(e.clientX-b.left-v.tx)/v.s,(v.ty-(e.clientY-b.top))/v.s]};
  const inside=(T,[x,y])=>x>=T.x0&&x<T.x0+T.size&&y>=T.y0&&y<T.y0+T.size;
  const hit=e=>{const m=toM(e);return Object.values(tiles).find(k=>inside(k,m))||null};
  const rect=k=>({left:v.tx+k.x0*v.s,top:v.ty-(k.y0+k.size)*v.s,width:k.size*v.s,height:k.size*v.s});
  const zoomAt=(px,py,f)=>{const v=view.current,ns=Math.min(v.max,Math.max(v.min,v.s*f)),k=ns/v.s;v.tx=px-(px-v.tx)*k;v.ty=py-(py-v.ty)*k;v.s=ns;kick()};
  useEffect(()=>{const el=box.current,h=e=>{if(e.target.closest('.legend'))return;e.preventDefault();cancelAnimationFrame(anim.current);const b=el.getBoundingClientRect();zoomAt(e.clientX-b.left,e.clientY-b.top,Math.exp(-e.deltaY*.0015))};el.addEventListener('wheel',h,{passive:false});return()=>el.removeEventListener('wheel',h)},[]);
  const glide=to=>{cancelAnimationFrame(anim.current);const v=view.current,a={tx:v.tx,ty:v.ty},t0=performance.now(),T=REDUCED?1:650;
    const f=t=>{const k=Math.min(1,(t-t0)/T),e=1-Math.pow(1-k,3);v.tx=a.tx+(to.tx-a.tx)*e;v.ty=a.ty+(to.ty-a.ty)*e;kick();if(k<1)anim.current=requestAnimationFrame(f)};anim.current=requestAnimationFrame(f)};

  /* a place chosen in the contribute form: fly there (to scale s, so its uncertainty circle fits), centred in the part of the map the form leaves free */
  useEffect(()=>{const v=view.current;if(!fly||!v)return;const b=box.current.getBoundingClientRect(),pr=document.querySelector('.propose');
    let fx=b.width/2,fy=b.height/2;if(pr){const r=pr.getBoundingClientRect();if(r.width<b.width*.7)fx=(r.left-b.left)/2;else fy=(r.top-b.top)/2}
    const s1=Math.min(v.max,Math.max(v.min,fly.s||.5)),a={s:v.s,X:v.tx+fly.x*v.s,Y:v.ty-fly.y*v.s},t0=performance.now(),T=REDUCED?1:850;
    cancelAnimationFrame(anim.current);
    const f=t=>{const k=Math.min(1,(t-t0)/T),e=1-Math.pow(1-k,3),s=a.s*Math.pow(s1/a.s,e),X=a.X+(fx-a.X)*e,Y=a.Y+(fy-a.Y)*e;   // the point slides to the centre as the scale grows
      v.s=s;v.tx=X-fly.x*s;v.ty=Y+fly.y*s;kick();if(k<1)anim.current=requestAnimationFrame(f)};
    anim.current=requestAnimationFrame(f)},[fly]);

  /* ---- hover and pin ---- */
  const F=pin||(!pick&&hover&&tiles[hover])||null,focus=!!F;
  const enter=g=>{setHover(g?g.key:null);if(!g)return;setIntro(true);setWipe(1);entering.current=true; // the old photo sweeps open from the right to the pointer
    requestAnimationFrame(()=>requestAnimationFrame(()=>{entering.current=false;setWipe(lastW.current)}));clearTimeout(enter.t);enter.t=setTimeout(()=>setIntro(false),600)};
  const doPin=g=>{const P={key:'pin',x0:g.x0,y0:g.y0,size:g.size,ids:g.ids};setPin(P);setPage(0);setHover(null);setLit(null);setIntro(false);
    if(MOBILE){clearTimeout(sweep.current);setWipe(0);   // phones: today's orthophoto first, then 1956 sweeps across the square and stays
      sweep.current=setTimeout(()=>{setIntro(true);setWipe(1);sweep.current=setTimeout(()=>setIntro(false),650)},REDUCED?0:600)}
    const b=box.current.getBoundingClientRect(),v=view.current;glide({tx:b.width/2-(g.x0+g.size/2)*v.s,ty:b.height/2+(g.y0+g.size/2)*v.s})};
  const openTile=(T,id,item,from)=>onOpen({tile:{x0:T.x0,y0:T.y0,size:T.size,ids:T.ids},id:id||(T.ids.length===1?T.ids[0]:null),item:item==null?null:item,from:from||rect(T)});
  const openItem=(id,item,el)=>{const c=cases[id];if(!c)return;let T=pin&&pin.ids.includes(id)?pin:null;
    if(!T){const [i,j]=tileOf(D,G.B,c.x,c.y);T=tiles[i+','+j]}if(!T)return;
    const bb=box.current.getBoundingClientRect(),r=el.getBoundingClientRect();setLit(null);
    openTile(T,id,item==null?leadIndex(c):item,{left:r.left-bb.left,top:r.top-bb.top,width:r.width,height:r.height})};

  /* ---- floating cards: a few photos from the cases in view, filed near their squares, one replaced every ROTATE ms.
     Only cases that have a square at this zoom take part; the cards step aside while a square is hovered or pinned. ---- */
  const wanted=()=>{const w=box.current.getBoundingClientRect().width;return w<640?1:w<1100?2:3};
  const shown=new Set(Object.values(tiles).flatMap(t=>t.ids));
  const inView=()=>{const v=view.current,b=box.current.getBoundingClientRect();
    return [...shown].filter(id=>{const c=cases[id],X=v.tx+c.x*v.s,Y=v.ty-c.y*v.s;return X>24&&X<b.width-24&&Y>24&&Y<b.height-24})};
  const cardKey=cards.map(c=>c.id+(c.out?'~':'')).join();
  useEffect(()=>{ // keep a few cards for cases in view: drop those that left (or found no room), draw new ones at random
    if(!view.current||drag.current||moving)return;
    if(noRoom.current.tick!==tick)noRoom.current={tick,ids:new Set()};for(const id of unplaced.current)noRoom.current.ids.add(id);
    const vis=new Set(inView()),K=wanted(),bad=noRoom.current.ids;
    setCards(cs=>{let n=cs.filter(c=>vis.has(c.id)&&!(bad.has(c.id)&&!c.out));const have=new Set(n.map(c=>c.id));
      const pool=[...vis].filter(id=>!have.has(id)&&!bad.has(id)),fresh=pool.filter(id=>!recent.current.includes(id)),src=fresh.length?fresh:pool;
      let k=0;while(n.filter(c=>!c.out).length<K&&src.length){const id=src.splice(Math.floor(Math.random()*src.length),1)[0];n=[...n,{id,t:Date.now(),d:k++*.18}]}
      while(n.filter(c=>!c.out).length>K){const i=n.findIndex(c=>!c.out);n=n.filter((_,j)=>j!==i)}
      return n.map(c=>c.id).join()===cs.map(c=>c.id).join()?cs:n});
  },[tick,cases,cardKey,moving]);
  const retire=()=>{setCards(cs=>{const live=cs.filter(c=>!c.out);if(!live.length)return cs;const go=live.reduce((a,b)=>a.t<b.t?a:b);
      recent.current=[go.id,...recent.current].slice(0,8);return cs.map(c=>c===go?{...c,out:true}:c)});
    setTimeout(()=>setCards(cs=>cs.filter(c=>!c.out)),520)};
  const hold=useRef();hold.current=paused||focus||lit||moving||drag.current||(playing&&!playing.paused);
  useEffect(()=>{if(REDUCED)return;const iv=setInterval(()=>{if(!document.hidden&&!hold.current)retire()},ROTATE);return()=>clearInterval(iv)},[]);
  // the controls: cards keep clear of them (re-measured after each render, re-laid out if they moved)
  useLayoutEffect(()=>{const bb=box.current.getBoundingClientRect();
    const a=[...box.current.querySelectorAll('.legend,.tools,.title')].map(el=>{const r=el.getBoundingClientRect();return {left:r.left-bb.left,top:r.top-bb.top,right:r.right-bb.left,bottom:r.bottom-bb.top}});
    const s=JSON.stringify(a.map(o=>[o.left,o.top,o.right,o.bottom].map(Math.round)));if(s!==avoid.current.s){avoid.current={s,a};setTick(t=>t+1)}});
  // keys while a square is pinned: ← → pages, Enter opens, Esc lets go
  useEffect(()=>{if(!pin||paused)return;const h=e=>{if(e.target.closest('input'))return;
      if(e.key==='Escape')setPin(null);else if(e.key==='ArrowRight')setPage(p=>p+1);else if(e.key==='ArrowLeft')setPage(p=>p-1);else if(e.key==='Enter'&&!e.target.closest('.card,button'))openTile(pin)};
    addEventListener('keydown',h);return()=>removeEventListener('keydown',h)});

  /* ---- layout ---- */
  const bsz=v&&box.current.getBoundingClientRect(),base=v&&{v,bw:bsz.width,bh:bsz.height,avoid:avoid.current.a};
  const idle=[];
  if(v&&!moving){const B=G.B,ctx={...base,U:B,ox:-D.W,oy:-D.H,occ:new Set(),dirs:new Map(),air:true,reach:3,
      blocked:(i,j)=>!!tiles[i+','+j]||i<0||j<0||(i+1)*B>2*D.W||(j+1)*B>2*D.H};   // off the squares, inside the grid
    for(const cd of cards){const c=cases[cd.id];if(!c)continue;const [ai,aj]=tileOf(D,B,c.x,c.y),li=leadIndex(c);
      const f=MOBILE?Math.max(1,Math.round(PHOTO_PX*.8/(B*v.s))):1;   // phones: small squares, so a card spans more of them
      const r=packOne({key:cd.id,ai,aj,anchorKey:cd.id,shapes:shapes(c.items[li],false).map(([w,h])=>[w*f,h*f]),id:c.id,item:li},ctx);
      if(r)idle.push({...r,cd})}}
  if(!moving)unplaced.current=cards.filter(c=>!c.out&&!idle.some(r=>r.id===c.id)).map(c=>c.id);
  // a pinned square lays out all its files around it, a page at a time, a square of air around it and never outside the frame
  let plot=[],pages=1,pg=0;
  if(v&&pin){const F=pin,all=[];const cs=F.ids.map(id=>cases[id]).filter(Boolean),li=cs.map(leadIndex);
    cs.forEach((c,k)=>all.push([c.id,li[k]]));cs.forEach((c,k)=>c.items.forEach((_,i)=>{if(i!==li[k])all.push([c.id,i])}));
    const U=F.size,outside=(i,j)=>F.x0+i*U< -D.W||F.x0+(i+1)*U>D.W||F.y0+j*U< -D.H||F.y0+(j+1)*U>D.H;
    const run=(st,max,big)=>{const ctx={...base,U,ox:F.x0,oy:F.y0,occ:new Set(),dirs:new Map(),reach:4,blocked:(i,j)=>Math.abs(i)<=1&&Math.abs(j)<=1||outside(i,j)},out=[];
      for(let k=st;k<all.length&&out.length<max;k++){const [id,ii]=all[k],key='f'+id+'.'+ii;
        const r=packOne({key,ai:0,aj:0,anchorKey:'',shapes:shapes(cases[id].items[ii],big&&(!out.length||hash(key)<.3)),id,item:ii},ctx);if(!r)break;out.push(r)}return out};
    if(MOBILE){   // phones: one file at a time, as large as the free band above or below the square allows (swipe or the arrows for the next)
      pages=Math.max(1,all.length);pg=((page%pages)+pages)%pages;const [id,ii]=all[pg]||[];
      if(id!=null){const it=cases[id].items[ii],src=firstSrc(it),a=src?aspects.get(src)||1.33:it.type==='text'?1.5:it.type==='audio'?2.4:1.2;
        const R=rect(pin),bot=R.top+R.height,gap=14,pgH=pages>1?54:0,av=base.avoid;
        const topLim=Math.max(52,...av.filter(r=>r.bottom<=R.top).map(r=>r.bottom+8)),botLim=Math.min(base.bh-12,...av.filter(r=>r.top>=bot).map(r=>r.top-8));
        const upH=R.top-gap-topLim,dnH=botLim-bot-gap-pgH,below=dnH>upH,Hm=Math.max(70,below?dnH:upH);
        let W=Math.min(base.bw-24,Hm*a),H=W/a;if(H>Hm){H=Hm;W=H*a}
        plot=[{key:'f'+id+'.'+ii,id,item:ii,left:(base.bw-W)/2,top:below?bot+gap+pgH:R.top-gap-H,W,H}]}}
    else{const P=[];for(let st=0;st<all.length&&P.length<40;){const o=run(st,99,true);P.push(o);st+=Math.max(1,o.length)}
      pages=Math.max(1,P.length);pg=((page%pages)+pages)%pages;plot=P[pg]||[]}}

  /* ---- pointer ----
     Mouse: drag pans, the wheel zooms, hovering a square shows 1956 and today. Touch: one finger pans, two pinch-zoom (and pan),
     a double tap on the open map zooms in; a tap pins a square, and a finger dragged inside the pinned square moves the 1956 seam. */
  const ptrs=useRef(new Map()),lastTap=useRef(null);
  const wipeAt=m=>{lastW.current=Math.min(1,Math.max(0,(m[0]-pin.x0)/pin.size));setWipe(lastW.current)};
  const down=e=>{if(e.target.closest&&e.target.closest('.pager'))return;box.current.setPointerCapture(e.pointerId);cancelAnimationFrame(anim.current);
    ptrs.current.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(ptrs.current.size>=2){drag.current={pinch:pinchOf(ptrs.current),moved:99};return}   // a second finger: pinch, never a tap
    const cd=e.target.closest&&e.target.closest('.card'),touch=e.pointerType!=='mouse',m=toM(e),w=!MOBILE&&touch&&!pick&&!cd&&pin&&inside(pin,m);
    drag.current={x:e.clientX,y:e.clientY,x0:e.clientX,y0:e.clientY,moved:0,touch,wipe:w,swipe:MOBILE&&touch&&!pick&&!!pin,card:cd&&{id:cd.dataset.id,item:cd.dataset.item!=null?+cd.dataset.item:null,el:cd}}};
  const move=e=>{const P=ptrs.current.get(e.pointerId);if(P){P.x=e.clientX;P.y=e.clientY}
    const d=drag.current;
    if(d&&d.pinch){if(ptrs.current.size<2)return;const q=pinchOf(ptrs.current),b=box.current.getBoundingClientRect(),v=view.current;
      v.tx+=q.cx-d.pinch.cx;v.ty+=q.cy-d.pinch.cy;zoomAt(q.cx-b.left,q.cy-b.top,q.d/d.pinch.d);d.pinch=q;return}
    if(d){d.moved+=Math.abs(e.clientX-d.x)+Math.abs(e.clientY-d.y);
      if(d.wipe){wipeAt(toM(e));d.x=e.clientX;d.y=e.clientY;return}
      if(d.swipe){d.x=e.clientX;d.y=e.clientY;return}   // a pinned square holds the map still: a sideways swipe turns its files
      const v=view.current;v.tx+=e.clientX-d.x;v.ty+=e.clientY-d.y;d.x=e.clientX;d.y=e.clientY;kick();return}
    if(e.pointerType!=='mouse')return;   // hover is a mouse thing
    const m=toM(e);
    if(pin){if(inside(pin,m))wipeAt(m);return}
    if(e.target.closest&&e.target.closest('.card'))return;
    const g=hit(e);if(g)lastW.current=(m[0]-g.x0)/g.size;
    if((g&&g.key)!==hover)enter(g);else if(g&&!entering.current)setWipe(lastW.current)};
  const cancel=e=>{ptrs.current.delete(e.pointerId);const d=drag.current;
    if(d&&d.pinch&&ptrs.current.size===1){const [r]=ptrs.current.values();drag.current={x:r.x,y:r.y,moved:99};return true}   // one finger lifted: keep panning with the other
    if(!ptrs.current.size)drag.current=null;if(d&&d.moved>=4)setTick(t=>t+1);return !!(d&&d.pinch)};
  const up=e=>{const d=drag.current;if(cancel(e)||!d)return;
    if(d.swipe&&d.moved>=10){const dx=e.clientX-d.x0,dy=e.clientY-d.y0;if(Math.abs(dx)>40&&Math.abs(dx)>1.3*Math.abs(dy))setPage(p=>p+(dx<0?1:-1));return}
    if(d.moved>=(d.touch?10:4)){if(!d.wipe)setTick(t=>t+1);return}const m=toM(e);
    if(pick){if(Math.abs(m[0])<=D.W&&Math.abs(m[1])<=D.H)onPick(m);return}  // proposing a case: the click places it
    if(d.card){openItem(d.card.id,d.card.item,d.card.el);return}
    if(pin&&inside(pin,m)){openTile(pin);return}
    const g=!(MOBILE&&pin)&&hit(e);if(g){lastTap.current=null;doPin(g);return}   // phones: with a square pinned the others are hidden, so a tap away only lets go
    if(d.touch){const t=performance.now(),L=lastTap.current;   // double tap on the open map: zoom in there
      if(L&&t-L.t<320&&Math.hypot(L.x-e.clientX,L.y-e.clientY)<40){lastTap.current=null;const b=box.current.getBoundingClientRect();zoomAt(e.clientX-b.left,e.clientY-b.top,2);return}
      lastTap.current={t,x:e.clientX,y:e.clientY}}
    if(pin)setPin(null)};


  /* ---- render ---- */
  const tileEl=(g,on,isPin)=>{const z=g.size*v.s,b={x0:g.x0,y0:g.y0,size:g.size},n=g.ids.length;
    return html`<div key=${isPin?'pin':g.key} class=${'blk'+(on?' on':'')+(isPin?' pin':'')+(on&&intro&&(!isPin||MOBILE)?' intro':'')+(MOBILE&&isPin&&!intro&&(wipe<=0||wipe>=1)?' swept':'')} style=${{...rect(g),'--w':(on?wipe:.5)*100+'%'}}>
      <i class="lift"></i>
      ${on&&html`<div class="orth"><${Ortho} D=${D} b=${b} which="after" size=${z} cls="now"/><${Ortho} D=${D} b=${b} which="before" size=${z} cls="bf"/><i class="seam"></i>
        ${on&&z>150&&html`<span class="tg" style=${{left:4}}>orto. 1956</span><span class="tg" style=${{right:4}}>orto. hoy</span>`}</div>`}
      <div class="mark"></div><span class="count" style=${{fontSize:Math.max(15,Math.min(40,z*.24))}} aria-label=${n+(n>1?' casos':' caso')}>${n}</span>
      ${isPin&&html`<span class="corners" aria-hidden="true"><i></i><i></i><i></i><i></i></span>`}
      ${on&&html`<div class=${'tab'+(box.current&&rect(g).left+z/2>box.current.clientWidth/2?' rt':'')}>${squareName(D,g)}</div>`}</div>`};
  const media=(c,it,on)=>{const snd=it.type!=='audio'&&c.items.find(x=>x.type==='audio');
    return firstSrc(it)?html`<div class="media">${it.type==='versions'?html`<${Cycle} photos=${it.photos} eq=${layers.bw} on=${on}/>`:html`<${Pic} src=${it.src} eq=${layers.bw}/>${yearTag(it)}`}${snd&&html`<${Sound} src=${snd.src} label=${snd.label} variant="dot"/>`}</div>`
      :it.type==='audio'?html`<div class="media snd"><${Sound} src=${it.src} label=${it.label} variant="mini"/></div>`
      :it.type==='text'?html`<div class="media txt"><p>${it.body}</p></div>`
      :html`<div class="media file"><b>▤</b>${ext(it.src)}</div>`};
  const cardEl=(r,cls,d,label,item)=>{const c=cases[r.id],it=c.items[r.item];
    return html`<div key=${r.key} data-id=${c.id} data-item=${item} class=${'card '+cls+(lit===r.key?' lit':'')} style=${{left:r.left,top:r.top,width:r.W,height:r.H,'--d':d+'s'}}
        role="button" tabIndex="0" aria-label=${catNo(c)+', '+c.title+', '+label} onPointerEnter=${()=>setLit(r.key)} onPointerLeave=${()=>setLit(null)}
        onFocus=${()=>setLit(r.key)} onBlur=${()=>setLit(null)} onKeyDown=${e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();openItem(c.id,item,e.currentTarget)}}}>
      <div class="sheet">${media(c,it,lit===r.key||MOBILE)}</div><span class="lab"><i>${catNo(c)}</i>${c.title}</span></div>`};
  const FR=F&&rect(F);
  return html`<div ref=${box} class=${'map'+(drag.current?' drag':'')+(pick?' picking':hover||pin?' over':'')+(focus?' focus':'')} onPointerDown=${down} onPointerMove=${move} onPointerUp=${up}
      onPointerCancel=${cancel} onPointerLeave=${e=>{if(e.pointerType==='mouse')setHover(null)}}>
    <canvas ref=${under} class="under"></canvas><canvas ref=${cv}></canvas><canvas ref=${over} class="over"></canvas>
    <div class="title">Laboratorio Naturaleza Urbana<p>Un mapa para documentar la naturaleza urbana de Madrid. Crece con aportaciones: fotos antiguas y la misma vista hoy, audios y textos, cada uno situado en su lugar.</p></div>
    ${v&&Object.values(tiles).filter(g=>!(pin&&g.x0<pin.x0+pin.size&&g.x0+g.size>pin.x0&&g.y0<pin.y0+pin.size&&g.y0+g.size>pin.y0)).map(g=>tileEl(g,!pin&&hover===g.key,false))}
    ${v&&pin&&tileEl(pin,true,true)}
    ${v&&html`<svg class="leads" aria-hidden="true">
      ${idle.map(r=>{const c=cases[r.id],[x1,y1,x2,y2]=leaderTo(r,v.tx+c.x*v.s,v.ty-c.y*v.s);return html`<g key=${'i'+r.key} class=${'idle'+(r.cd.out?' out':'')+(lit===r.key?' lit':'')} style=${{'--d':r.cd.d+'s'}}><line pathLength="1" x1=${x1} y1=${y1} x2=${x2} y2=${y2}/></g>`})}
      ${plot.map((r,k)=>{const c=cases[r.id],[x1,y1,x2,y2]=leaderTo(r,v.tx+c.x*v.s,v.ty-c.y*v.s);return html`<g key=${'p'+r.key} class=${lit==='p'+r.key?'lit':''} style=${{'--d':.25+k*.07+'s'}}><line pathLength="1" x1=${x1} y1=${y1} x2=${x2} y2=${y2}/></g>`})}
      ${pin&&pin.ids.map(id=>{const c=cases[id];if(!c)return null;const on=lit&&lit.slice(1).startsWith('f'+id+'.'),X=v.tx+c.x*v.s,Y=v.ty-c.y*v.s;
        return html`<g key=${'d'+id}>${c.r>0&&html`<circle class="unc" cx=${X} cy=${Y} r=${c.r*v.s}/>`}<circle class=${'dot'+(on?' lit':'')} cx=${X} cy=${Y} r="3.5"/></g>`})}
      ${mark&&(()=>{const X=v.tx+mark.x*v.s,Y=v.ty-mark.y*v.s;return html`<g class="mark">${mark.r>0&&html`<circle class="unc" cx=${X} cy=${Y} r=${mark.r*v.s}/>`}<circle class="pm" cx=${X} cy=${Y} r="6"/></g>`})()}</svg>`}
    ${idle.map(r=>cardEl(r,'idle'+(r.cd.out?' out':''),r.cd.d,itemName(cases[r.id].items[r.item]),r.item))}
    ${plot.map((r,k)=>cardEl({...r,key:'p'+r.key},'',.25+k*.07,itemName(cases[r.id].items[r.item]),r.item))}
    ${pin&&pages>1&&html`<div class="pager" style=${{left:MOBILE?Math.min(base.bw-80,Math.max(80,FR.left+FR.width/2)):FR.left+FR.width/2,top:FR.top+FR.height+12}} onPointerDown=${e=>e.stopPropagation()} onPointerUp=${e=>e.stopPropagation()}>
      <button aria-label="Anteriores" onClick=${()=>setPage(p=>p-1)}>‹</button><span>${pg+1} / ${pages}</span><button aria-label="Siguientes" onClick=${()=>setPage(p=>p+1)}>›</button></div>`}
    ${v&&!pick&&!pin&&html`<${Hint} id="map" cls="low"><span class="pinch" aria-hidden="true"></span>Pellizca para acercar · toca un cuadro para verlo<//>`}
    ${v&&pin&&pages>1&&html`<${Hint} id="pin" cls="low"><span class="sw" aria-hidden="true">‹ ›</span>Desliza para ver más · toca el cuadro para abrirlo<//>`}
    <div class="tools" onPointerDown=${e=>e.stopPropagation()}>
      <button aria-label="Acercar" onClick=${()=>{const b=box.current.getBoundingClientRect();zoomAt(b.width/2,b.height/2,1.6)}}>+</button>
      <button aria-label="Alejar" onClick=${()=>{const b=box.current.getBoundingClientRect();zoomAt(b.width/2,b.height/2,1/1.6)}}>−</button>
      <button aria-label="Ver todo" onClick=${fit}>⤢</button>
    </div>${typeof children==='function'?children(G&&G.st):children}</div>`;
}


/* ---------- explorer: a square opened to the whole screen ---------- */
// today's orthophoto, pannable and zoomable, with 1956 inside a lens of radius rad (metres) around the pointer, or the chosen case when the pointer is away
function LensMap({D,cases,tile,sel,aside}){
  const el=useRef(),now=useRef(),old=useRef(),ptrs=useRef(new Map()),[size,setSize]=useState(null),[vw,setVw0]=useState(null),sz=useRef(),[seam,setSeam]=useState(1),[ptr,setPtr]=useState(null),[glide,setGlide]=useState(false),drag=useRef(null);
  const c0=sel&&cases[sel],[rad,setRad]=useState(()=>Math.round(c0&&c0.r?c0.r:Math.max(60,Math.min(400,tile.size*.18))));
  /* phones: the view never leaves the map frame (and never shows more than the frame) */
  sz.current=size;
  const clampV=v=>{const s=sz.current;if(!MOBILE||!v||!s)return v;const m=Math.min(v.mpp,2*D.W/s.w,2*D.H/s.h),hw=s.w*m/2,hh=s.h*m/2;
    return {mpp:m,cx:Math.min(D.W-hw,Math.max(-D.W+hw,v.cx)),cy:Math.min(D.H-hh,Math.max(-D.H+hh,v.cy))}};
  const setVw=f=>setVw0(v=>clampV(typeof f==='function'?f(v):f));
  useEffect(()=>{const ro=new ResizeObserver(([e])=>setSize({w:e.contentRect.width,h:e.contentRect.height}));ro.observe(el.current);return()=>ro.disconnect()},[]);
  // phones: 1956 covers the stage, then its seam slides back to the middle
  useEffect(()=>{if(!MOBILE||!vw)return;const t=setTimeout(()=>{glideOn();setSeam(.5)},REDUCED?0:450);return()=>clearTimeout(t)},[vw&&1]);
  useEffect(()=>{if(size&&!vw){const c=c0||{x:tile.x0+tile.size/2,y:tile.y0+tile.size/2};setVw({cx:c.x,cy:c.y,mpp:tile.size/(Math.min(size.w,size.h)*.62)})}},[size]);
  /* Choosing a case glides the view and the lens to it (an approximate case sets the lens to its radius). With a file open,
     the square moves to the left fifth of the stage, scaled to fit there, so the floating file sits beside it, not over it. */
  useEffect(()=>{if(!vw||(!sel&&!aside))return;const c=sel&&cases[sel];if(c&&c.r)setRad(c.r);glideOn();const a={...vw},t0=performance.now();
    let to={mpp:a.mpp,cx:c?c.x:a.cx,cy:c?c.y:a.cy};
    if(aside&&!MOBILE){const m=Math.max(a.mpp,tile.size/(.3*size.w));to={mpp:m,cx:tile.x0+tile.size/2+(.5-.19)*size.w*m,cy:tile.y0+tile.size/2}}
    let raf;const f=t=>{const k=Math.min(1,(t-t0)/550),e=1-Math.pow(1-k,3);setVw({mpp:a.mpp+(to.mpp-a.mpp)*e,cx:a.cx+(to.cx-a.cx)*e,cy:a.cy+(to.cy-a.cy)*e});if(k<1)raf=requestAnimationFrame(f)};
    raf=requestAnimationFrame(f);return()=>cancelAnimationFrame(raf)},[sel,aside]);
  useEffect(()=>{if(vw)setPtr(null)},[sel]);   // a newly chosen case brings the lens back to it
  const glideOn=()=>{setGlide(true);clearTimeout(glideOn.t);glideOn.t=setTimeout(()=>setGlide(false),520)};
  const box=size&&vw&&{x0:vw.cx-size.w*vw.mpp/2,y0:vw.cy-size.h*vw.mpp/2,w:size.w*vw.mpp,h:size.h*vw.mpp};
  useEffect(()=>{if(!box)return;const dpr=Math.min(2,devicePixelRatio||1),pw=Math.round(size.w*dpr),ph=Math.round(size.h*dpr);
    paintOrtho(now.current,D,box,'after',pw,ph);paintOrtho(old.current,D,box,'before',pw,ph)},[vw,size]);
  useEffect(()=>{const h=e=>{e.preventDefault();if(!vw)return;const b=el.current.getBoundingClientRect(),px=e.clientX-b.left,py=e.clientY-b.top,f=Math.exp(e.deltaY*.0015);
      setVw(v=>{const m=Math.min(20,Math.max(.12,v.mpp*f)),k=m/v.mpp;return {mpp:m,cx:v.cx+(px-size.w/2)*v.mpp*(1-k),cy:v.cy-(py-size.h/2)*v.mpp*(1-k)}})};
    const n=el.current;n.addEventListener('wheel',h,{passive:false});return()=>n.removeEventListener('wheel',h)},[vw&&1,size]);
  if(!box)return html`<div class="lensmap" ref=${el}><canvas ref=${now}/><canvas ref=${old}/></div>`;
  const S=(x,y)=>[(x-box.x0)/vw.mpp,(box.y0+box.h-y)/vw.mpp],toM=e=>{const b=el.current.getBoundingClientRect();return [box.x0+(e.clientX-b.left)*vw.mpp,box.y0+box.h-(e.clientY-b.top)*vw.mpp]};
  const at=ptr||(c0?[c0.x,c0.y]:[tile.x0+tile.size/2,tile.y0+tile.size/2]),[lx,ly]=S(at[0],at[1]),lr=rad/vw.mpp;
  /* mouse: the lens follows the pointer, dragging pans. Touch: a finger that starts on the lens moves it, elsewhere it pans; two fingers pinch-zoom */
  const lift=e=>{ptrs.current.delete(e.pointerId);const d=drag.current;
    if(d&&d.pinch&&ptrs.current.size===1){const [r]=ptrs.current.values();drag.current={x:r.x,y:r.y,moved:99}}else if(!ptrs.current.size)drag.current=null};
  /* phones: no lens. 1956 lies left of a seam across the whole stage; a finger near the seam drags it, elsewhere it pans; two fingers pinch-zoom */
  const sx=seam*size.w;
  return html`<div class=${'lensmap'+(MOBILE?' cmp':'')+(drag.current&&drag.current.moved>3?' drag':'')+(glide?' glide':'')} ref=${el} style=${{'--x':lx+'px','--y':ly+'px','--r':lr+'px','--sx':sx+'px'}}
      onPointerDown=${e=>{el.current.setPointerCapture(e.pointerId);ptrs.current.set(e.pointerId,{x:e.clientX,y:e.clientY});
        if(ptrs.current.size>=2){drag.current={pinch:pinchOf(ptrs.current),moved:99};return}
        const b=el.current.getBoundingClientRect();
        if(MOBILE){const near=Math.abs(e.clientX-b.left-sx)<=30;drag.current={x:e.clientX,y:e.clientY,moved:0,seam:near};if(near)setSeam(Math.min(1,Math.max(0,(e.clientX-b.left)/size.w)));return}
        const lens=e.pointerType!=='mouse'&&Math.hypot(e.clientX-b.left-lx,e.clientY-b.top-ly)<=Math.max(lr,24)+16;
        drag.current={x:e.clientX,y:e.clientY,moved:0,lens};if(lens)setPtr(toM(e))}}
      onPointerMove=${e=>{const P=ptrs.current.get(e.pointerId);if(P){P.x=e.clientX;P.y=e.clientY}const d=drag.current;
        if(d&&d.pinch){if(ptrs.current.size<2)return;const q=pinchOf(ptrs.current),b=el.current.getBoundingClientRect(),px=q.cx-b.left,py=q.cy-b.top,f=d.pinch.d/q.d,dx=q.cx-d.pinch.cx,dy=q.cy-d.pinch.cy;d.pinch=q;
          setVw(v=>{const cx=v.cx-dx*v.mpp,cy=v.cy+dy*v.mpp,m=Math.min(20,Math.max(.12,v.mpp*f)),k=m/v.mpp;return {mpp:m,cx:cx+(px-size.w/2)*v.mpp*(1-k),cy:cy-(py-size.h/2)*v.mpp*(1-k)}});return}
        if(d&&d.lens){setPtr(toM(e));return}
        if(d&&d.seam){const b=el.current.getBoundingClientRect();setSeam(Math.min(1,Math.max(0,(e.clientX-b.left)/size.w)));return}
        if(d){const dx=e.clientX-d.x,dy=e.clientY-d.y;d.moved+=Math.abs(dx)+Math.abs(dy);d.x=e.clientX;d.y=e.clientY;setVw(v=>({...v,cx:v.cx-dx*v.mpp,cy:v.cy+dy*v.mpp}))}
        if(e.pointerType==='mouse')setPtr(toM(e))}}
      onPointerUp=${lift} onPointerCancel=${lift}
      onPointerLeave=${e=>{if(e.pointerType==='mouse'){setPtr(null);glideOn()}}}>
    <canvas ref=${now} class="now" aria-hidden="true"/><canvas ref=${old} class="old" aria-hidden="true"/>
    <svg aria-hidden="true">
      ${(()=>{const [X,Y]=S(tile.x0,tile.y0+tile.size);return html`<rect class="sq" x=${X} y=${Y} width=${tile.size/vw.mpp} height=${tile.size/vw.mpp}/>`})()}
      ${c0&&(()=>{const [X,Y]=S(c0.x,c0.y);return html`${c0.r>0&&html`<circle class="unc" cx=${X} cy=${Y} r=${c0.r/vw.mpp}/>`}<circle class="cs" cx=${X} cy=${Y} r="4.5"/>`})()}
      ${!MOBILE&&html`<circle class="lring" cx=${lx} cy=${ly} r=${lr}/>`}</svg>
    ${MOBILE?html`<div class="seamv" style=${{left:sx}} aria-hidden="true"><i>‹ ›</i></div>
        <${Hint} id="seam" cls="mid"><span class="sw" aria-hidden="true">‹ ›</span>Arrastra la barra: 1956 a la izquierda, hoy a la derecha<//>
        <span class="stg" style=${{left:8,opacity:seam>.12?1:0}}>1956–57</span><span class="stg" style=${{right:8,opacity:seam<.88?1:0}}>hoy</span>`
      :html`<span class="ltag" style=${{left:lx,top:ly-lr}}>ortofoto 1956–57</span>`}
    ${c0&&(()=>{const [X,Y]=S(c0.x,c0.y);return html`<span class="cname" style=${{left:X+10,top:Y}}>${c0.title}</span>`})()}
    ${!MOBILE&&html`<div class="bar"><span class="chip note">Fondo: ortofoto actual · lente: 1956–57. No coinciden necesariamente con el año de las fotos.</span>
      <label class="chip">1956 <input type="range" min="40" max="1200" step="10" value=${rad} aria-label="Tamaño de la lente de 1956" onInput=${e=>setRad(+e.target.value)} onPointerDown=${e=>e.stopPropagation()}/></label></div>`}</div>`}

// one item on the stage, floating over the map: a photo, its versions (one card each), a text, a sound or a file
const photoCap=p=>html`<span>${p.v&&html`<b>${p.v}</b> `}${p.label}${p.credit&&html` <i>· ${p.credit}</i>`}${p.link&&html` <a href=${p.link} target="_blank" rel="noopener" title="Original">↗</a>`}</span>`;
/* phones: a short hint on how to use what just appeared (swipe, pinch, drag). It fades in, stays a few seconds and goes;
   each hint is shown at most HINT_MAX times on this device, so it never nags */
const HINT_MAX=3,hintSeen=new Set();
function Hint({id,children,cls}){const [show]=useState(()=>{if(!MOBILE||hintSeen.has(id))return false;hintSeen.add(id);
    const k='lnu-hint-'+id,n=+(localStorage.getItem(k)||0);if(n>=HINT_MAX)return false;localStorage.setItem(k,n+1);return true});
  return show?html`<div class=${'hint '+(cls||'')} role="status">${children}</div>`:null}
/* phones: a case's versions (a, b, c…) fill the stage in the arrangement that shows them largest: stacked, side by side or a grid */
// each caption is shown whole, under its photo, across its card: its height (11 px typewriter, 6.6 px a letter, some slack for
// wrapping at word ends) is taken from the photo's height. Columns narrower than 150 px are never used: captions would turn to towers
const capText=p=>[p.v,p.label,p.credit&&'· '+p.credit].filter(Boolean).join(' ')+(p.link?' ↗':'');
const capH=(p,W)=>Math.ceil(capText(p).length*6.6*1.18/Math.max(40,W-4))*15.4+9;
function fitVersions(photos,w,h){const n=photos.length,as=photos.map(p=>aspects.get(p.src)||1.33);let best=null;
  for(let cols=1;cols<=n;cols++){const rows=Math.ceil(n/cols),cw=(w-8*(cols-1))/cols-12,cell=(h-8*(rows-1))/rows-12;if((cols>1&&cw<150)||cell<80)continue;
    const fit=photos.map((p,i)=>{const H=Math.min(cw/as[i],cell-capH(p,cw));return {W:H*as[i],H}});
    const area=fit.reduce((t,f)=>t+Math.max(0,f.W*f.H),0);if(fit.every(f=>f.H>50)&&(!best||area>best.area))best={area,fit,cw}}
  if(!best){const cw=w-12;best={cw,fit:photos.map((p,i)=>({W:cw,H:cw/as[i]}))}}   // no room at all: one column, and the stage scrolls
  return best}
function Viewer({c,it,eq,dir,onClose,onStep}){
  /* touch: a sideways swipe goes to the next (or previous) file; on phones the file covers the stage, and a tap beside it closes it */
  const sw=useRef(null),swipe={onPointerDown:e=>{sw.current=e.pointerType==='mouse'?null:{x:e.clientX,y:e.clientY,t:performance.now()}},onPointerCancel:()=>{sw.current=null},
    onPointerUp:e=>{const s=sw.current;sw.current=null;if(!s)return;const dx=e.clientX-s.x,dy=e.clientY-s.y;if(Math.abs(dx)>50&&Math.abs(dx)>1.5*Math.abs(dy)&&performance.now()-s.t<700)onStep(dx<0?1:-1);
      else if(MOBILE&&Math.hypot(dx,dy)<10&&(e.target===e.currentTarget||e.target.classList.contains('vgrid')))onClose()}};
  const vr=useRef(),[room,setRoom]=useState(null);
  useEffect(()=>{if(!MOBILE)return;const ro=new ResizeObserver(([e])=>setRoom({w:e.contentRect.width,h:e.contentRect.height}));ro.observe(vr.current);return()=>ro.disconnect()},[]);
  const head=html`<figcaption>${catNo(c)} · ${c.title}<button class="x" aria-label="Cerrar" onClick=${onClose}>×</button></figcaption>`;
  let body;
  if(it.type==='versions'){const n=it.photos.length;   // each version in its own card, sized to the free space: 2 across, as many rows as needed
    const fv=MOBILE&&room&&fitVersions(it.photos,room.w-20,room.h-20-44),ist=i=>fv?{maxWidth:fv.fit[i].W+'px',maxHeight:fv.fit[i].H+'px'}:undefined;
    return html`<div ref=${vr} class="viewer multi" ...${swipe} style=${{'--cols':Math.min(2,n),'--rows':Math.ceil(n/2),'--dir':dir||0}}>
      <${Hint} id="viewer" cls="low"><span class="sw" aria-hidden="true">‹ ›</span>Desliza para el siguiente · toca fuera para cerrar<//>
      <div class="vhead">${catNo(c)} · ${c.title}<button class="x" aria-label="Cerrar" onClick=${onClose}>×</button></div>
      <div class="vgrid" key=${it.photos[0].src}>${it.photos.map((p,i)=>html`<figure class="float ver" key=${p.src} style=${fv?{width:fv.cw+12+'px'}:undefined}><div class="pic"><${Pic} src=${p.src} eq=${eq} style=${ist(i)} alt=${c.title+', '+p.label}/>${yearTag(p)}</div>
        <figcaption>${photoCap(p)}</figcaption></figure>`)}</div></div>`}
  else if(it.type==='photo')body=html`${head}<div class="pic"><${Pic} src=${it.src} eq=${eq} alt=${c.title+(it.label?', '+it.label:'')}/>${yearTag(it)}</div><div class="cap"><p>${photoCap(it)}</p></div>`;
  else if(it.type==='text')body=html`${head}<blockquote class="text"><small>${it.label||'Texto'}</small>${it.body}</blockquote>`;
  else if(it.type==='audio')body=html`${head}<div class="aud"><${Sound} src=${it.src} label=${it.label} variant="big"/><p>${it.label}</p></div>`;
  else body=html`${head}<div class="doc">${['txt','pdf','html','md'].includes(ext(it.src))&&html`<iframe src=${it.src} title=${it.label||'Documento'}></iframe>`}
    <a href=${it.src} target="_blank" rel="noopener">Abrir ${it.label||it.src.split('/').pop()} ↗</a></div>`;
  return html`<div ref=${vr} class="viewer" ...${swipe} style=${{'--dir':dir||0}}><${Hint} id="viewer" cls="low"><span class="sw" aria-hidden="true">‹ ›</span>Desliza para el siguiente · toca fuera para cerrar<//><figure class="float" key=${firstSrc(it)||it.src||it.body}>${body}</figure></div>`}

function Explore({D,cases,open,eq,onClose}){
  const [info,setInfo]=useState(false),{tile}=open,[sel,setSel]=useState({id:open.id,item:open.item}),[dir,setDir]=useState(0),[shown,setShown]=useState(false),[closing,setClosing]=useState(false),root=useRef();
  useLayoutEffect(()=>{requestAnimationFrame(()=>requestAnimationFrame(()=>setShown(true)))},[]);
  // the browser's (or phone's) back button closes the explorer too: opening it adds a history entry, closing it takes the entry away
  const done=useRef(false),close=()=>{if(done.current)return;done.current=true;setClosing(true);setShown(false);setTimeout(onClose,REDUCED?0:560);
    if(history.state&&history.state.lnuExplore)history.back()};
  useEffect(()=>{history.pushState({lnuExplore:1},'');const h=()=>close();addEventListener('popstate',h);return()=>removeEventListener('popstate',h)},[]);
  const cs=tile.ids.map(id=>cases[id]).filter(Boolean),flat=[];for(const c of cs)c.items.forEach((_,i)=>flat.push([c.id,i]));
  const c=sel.id&&cases[sel.id],it=c&&sel.item!=null?c.items[sel.item]:null;
  const step=d=>{if(!flat.length)return;const k=flat.findIndex(([id,i])=>id===sel.id&&i===sel.item),n=flat[k<0?(d>0?0:flat.length-1):(k+d+flat.length)%flat.length];setDir(d);setSel({id:n[0],item:n[1]})};
  useEffect(()=>{const h=e=>{if(e.key==='Escape'){if(it)setSel(s=>({...s,item:null}));else close()}
      if((e.key==='ArrowDown'||e.key==='ArrowUp'||e.key==='ArrowRight'||e.key==='ArrowLeft')&&!e.target.closest('input,[role=slider]')&&flat.length){e.preventDefault();
        step(e.key==='ArrowDown'||e.key==='ArrowRight'?1:-1)}};
    addEventListener('keydown',h);return()=>removeEventListener('keydown',h)});
  useEffect(()=>{const r=root.current&&root.current.querySelector('.row.sel');r&&r.scrollIntoView({block:'nearest'})},[sel]);
  const b=document.querySelector('.app').getBoundingClientRect(),f=open.from;
  const thumb=it=>firstSrc(it)?html`<span class="th"><${Pic} src=${firstSrc(it)} eq=${eq}/></span>`:html`<span class="th">${{text:'¶',audio:'♪',file:'▤'}[it.type]}</span>`;
  return html`<div ref=${root} class=${'explore'+(shown?' open':'')+(it?' item':'')} role="dialog" aria-modal="true" aria-label=${squareName(D,tile)}
      style=${{'--from':`inset(${f.top}px ${b.width-f.left-f.width}px ${b.height-f.top-f.height}px ${f.left}px)`}}>
    <div class="stage">
      <${LensMap} D=${D} cases=${cases} tile=${tile} sel=${sel.id} aside=${!!it}/>
      ${it&&html`<${Viewer} c=${c} it=${it} eq=${eq} dir=${dir} onStep=${step} onClose=${()=>setSel(s=>({...s,item:null}))}/>`}
    </div>
    <aside class="files">
      <header><h2>${squareName(D,tile)}</h2><button class="close" aria-label="Cerrar" onClick=${close}>×</button></header>
      ${cs.map(c=>html`<section key=${c.id} class=${c.id===sel.id?'cur':''}>
        <button class="ch" onClick=${()=>setSel({id:c.id,item:null})}><span class="no">${catNo(c)}</span><b>${c.title}</b></button>
        <small class="meta">${where(c)}${mapLink(c)&&html` <a href=${mapLink(c)} target="_blank" rel="noopener" title="Ver en Google Maps">↗</a>`}</small>
        ${c.items.map((x,i)=>html`<button key=${i} class=${'row'+(c.id===sel.id&&i===sel.item?' sel':'')} onClick=${()=>{setDir(0);setSel({id:c.id,item:i})}}>${thumb(x)}<span>${itemName(x)}</span></button>`)}
      </section>`)}
      <div class="info"><button class="i" aria-expanded=${info} aria-label="Información" onClick=${()=>setInfo(o=>!o)}>i</button>
        ${info&&html`<p>${TOUCH?'Arrastra para moverte y pellizca para acercar; arrastra la lente para moverla; desliza un archivo a los lados para pasar al siguiente.':'Arrastra y usa la rueda para moverte; ↑ ↓ cambian de archivo; Esc vuelve.'}<br/>Lente: vuelo de 1956–57. Fondo: PNOA, hoy. © IGN (CC BY 4.0)</p>`}</div>
    </aside></div>`}

/* ---------- proposing a case ----------
   The visitor picks what they bring (photos, an audio or a text), taps where it belongs and fills a short form.
   Photos are shrunk here (JPEG, 1600 px, under ~1 MB each) so the request stays within the function's 4.5 MB limit.
   An audio (recorded here or picked from a file, up to 40 MB) goes first, in pieces of 2.5 MB to api/proponer-parte;
   then the proposal itself goes to api/proponer, which queues it for the team's review (scripts/propuestas.mjs). */
const MAX_FOTOS=4,MAX_AUDIO=40*1024*1024,PART=2.5*1024*1024,MAX_REC_S=20*60;
const toJpeg=file=>new Promise((res,rej)=>{const u=URL.createObjectURL(file),im=new Image();im.onerror=()=>{URL.revokeObjectURL(u);rej(new Error(file.name))};
  im.onload=()=>{const k=Math.min(1,1600/Math.max(im.width,im.height)),c=document.createElement('canvas');c.width=Math.round(im.width*k);c.height=Math.round(im.height*k);
    c.getContext('2d').drawImage(im,0,0,c.width,c.height);URL.revokeObjectURL(u);let q=.84,d=c.toDataURL('image/jpeg',q);while(d.length>1.35e6&&q>.4){q-=.1;d=c.toDataURL('image/jpeg',q)}res(d)};im.src=u});
const toB64=blob=>new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(String(r.result).split(',')[1]||'');r.onerror=()=>rej(r.error);r.readAsDataURL(blob)});
const AUDIO_EXT=['webm','ogg','opus','m4a','mp4','mp3','wav','aac','amr','3gp','caf','flac'];
const audioExt=(name,type)=>{const e=(name||'').split('.').pop().toLowerCase();if(name&&AUDIO_EXT.includes(e))return e;
  const t=(type||'').split(';')[0];return {'audio/webm':'webm','audio/ogg':'ogg','audio/mp4':'m4a','audio/x-m4a':'m4a','audio/aac':'aac','audio/mpeg':'mp3','audio/wav':'wav','audio/x-wav':'wav','audio/amr':'amr','audio/3gpp':'3gp','audio/flac':'flac'}[t]||null};
const REC_TYPE=window.MediaRecorder&&['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus','audio/webm'].find(t=>MediaRecorder.isTypeSupported(t));
const CAN_REC=!!(REC_TYPE&&navigator.mediaDevices&&navigator.mediaDevices.getUserMedia);
const mmss=s=>Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0');
const mb=n=>(n/1048576).toFixed(n<10485760?1:0)+' MB';
// POST JSON; a dropped connection or a server error is retried (tries times in all), a refusal (4xx) is not
const post=async(url,body,tries=3)=>{for(let k=1;;k++){let r;
  try{r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})}
  catch(e){if(k>=tries)throw new Error('No se pudo enviar. Revisa la conexión e inténtalo otra vez.');await new Promise(w=>setTimeout(w,800*k));continue}
  const j=await r.json().catch(()=>({}));if(r.ok)return j;if(r.status<500||k>=tries)throw new Error(j.error||'Error '+r.status);await new Promise(w=>setTimeout(w,800*k))}};
// one audio: record it here, or pick a file (a voice note saved from a messaging app, a recording...)
function AudioPick({audio,setAudio,setErr}){
  const [rec,setRec]=useState(null),[t,setT]=useState(0),[src,setSrc]=useState(null);
  useEffect(()=>()=>{if(rec&&rec.state!=='inactive')rec.stop()},[rec]);   // leaving the form stops the microphone
  useEffect(()=>{if(!audio){setSrc(null);return}const u=URL.createObjectURL(audio.blob);setSrc(u);return()=>URL.revokeObjectURL(u)},[audio]);
  const take=(blob,name)=>{const ext=audioExt(name,blob.type);
    if(!ext)return setErr('Ese archivo no parece un audio.');if(blob.size>MAX_AUDIO)return setErr('El audio pasa de 40 MB: recórtalo o grábalo más corto.');
    setErr(null);setAudio({blob,ext,name:name||'grabación.'+ext})};
  const start=async()=>{try{const st=await navigator.mediaDevices.getUserMedia({audio:true}),mr=new MediaRecorder(st,{mimeType:REC_TYPE}),parts=[],t0=Date.now();
      mr.ondataavailable=e=>e.data.size&&parts.push(e.data);
      const iv=setInterval(()=>{const s=(Date.now()-t0)/1000;setT(s);if(s>=MAX_REC_S&&mr.state==='recording')mr.stop()},250);
      mr.onstop=()=>{clearInterval(iv);st.getTracks().forEach(x=>x.stop());setRec(null);const b=new Blob(parts,{type:REC_TYPE.split(';')[0]});if(b.size)take(b,null)};
      mr.start(1000);setRec(mr);setErr(null)}
    catch(e){setErr('No se pudo usar el micrófono'+(e&&e.name==='NotAllowedError'?': permiso denegado.':'.'))}};
  if(rec)return html`<div class="audiopick rec"><span class="live" aria-hidden="true"></span><span>Grabando ${mmss(t)}</span>
    <button type="button" onClick=${()=>rec.stop()}>■ Parar</button></div>`;
  if(audio)return html`<div class="audiopick has"><audio controls src=${src} preload="metadata"></audio>
    <span class="nm">${audio.name} · ${mb(audio.blob.size)}</span><button type="button" aria-label="Quitar audio" onClick=${()=>setAudio(null)}>×</button></div>`;
  return html`<div class="audiopick">${CAN_REC&&html`<button type="button" onClick=${start}>● Grabar</button>`}
    <label class="addf wide">Elegir archivo<input type="file" accept="audio/*,.opus,.m4a,.amr" onChange=${e=>{const f=e.target.files[0];e.target.value='';if(f)take(f,f.name)}}/></label></div>`}
const KINDS=[['foto','Foto','▣'],['audio','Audio','♪'],['texto','Texto','¶']];
/* place search: OpenStreetMap's Nominatim, limited to the map frame. One request per search (on Enter or the button,
   never while typing), as its usage policy asks; the results credit OpenStreetMap. */
const shortName=r=>{const a=r.address||{},first=r.name||(r.display_name||'').split(',')[0];
  const near=a.quarter||a.neighbourhood||a.suburb||a.city_district||'';return {name:first,where:near&&near!==first?near:''}};
async function searchPlaces(D,q){const [w,s]=toLL(D,-D.W,-D.H),[e,n]=toLL(D,D.W,D.H);
  const u='https://nominatim.openstreetmap.org/search?'+new URLSearchParams({q,format:'jsonv2',addressdetails:1,limit:6,countrycodes:'es','accept-language':'es',viewbox:[w,n,e,s].join(','),bounded:1});
  const r=await fetch(u);if(!r.ok)throw new Error('La búsqueda no responde ahora. Toca el mapa para marcar el punto.');return r.json()}
// a found place's size, as an uncertainty radius: a long street or a park is not one point
const extentOf=(D,r)=>{const b=(r.boundingbox||[]).map(Number);if(b.length<4)return 0;const [x0,y0]=toLocal(D,b[2],b[0]),[x1,y1]=toLocal(D,b[3],b[1]);return Math.hypot(x1-x0,y1-y0)/2};
function PlaceSearch({D,onPick}){
  const [q,setQ]=useState(''),[res,setRes]=useState(null),[busy,setBusy]=useState(false),[err,setErr]=useState(null);
  const go=async()=>{const t=q.trim();if(t.length<3||busy)return;setBusy(true);setErr(null);
    try{const r=await searchPlaces(D,t);setRes(r)}catch(e){setErr(e.message||'Sin conexión.');setRes(null)}setBusy(false)};
  return html`<div class="search">
    <div class="sbox"><input type="search" enterkeyhint="search" placeholder="Busca una calle, plaza o lugar" value=${q} onInput=${e=>setQ(e.target.value)}
      onKeyDown=${e=>{if(e.key==='Enter'){e.preventDefault();go()}}} aria-label="Buscar un lugar"/>
      <button type="button" onClick=${go} disabled=${busy}>${busy?'…':'Buscar'}</button></div>
    ${err&&html`<p class="err">${err}</p>`}
    ${res&&(res.length?html`<ul class="res">${res.map(r=>{const s=shortName(r);return html`<li key=${r.place_id}><button type="button" onClick=${()=>{setRes(null);
        const [x,y]=toLocal(D,+r.lon,+r.lat);onPick({x,y,label:s.name+(s.where?', '+s.where:''),name:s.name,extent:extentOf(D,r)})}}>${s.name}${s.where&&html` <i>${s.where}</i>`}</button></li>`})}
      <li class="osm">Búsqueda: © OpenStreetMap</li></ul>`:html`<p class="step">No aparece en el mapa. Prueba con otro nombre o toca el mapa.</p>`)}</div>`}
const NOW_Y=String(new Date().getFullYear());
function Propose({D,at,setAt,setR,onFly,onClose}){
  const [tipo,setTipo]=useState(null),[pares,setPares]=useState(false);
  const [f,setF]=useState({titulo:'',fecha:'',descripcion:'',texto:'',fuente:'',nombre:'',web:''}),[aprox,setAprox]=useState(false),[radio,setRadio]=useState(200);
  const [fotos,setFotos]=useState([]),[par,setPar]=useState([null,null]),[anos,setAnos]=useState(['',NOW_Y]),[audio,setAudio]=useState(null),[state,setState]=useState(null);
  useEffect(()=>setR(aprox?radio:0),[aprox,radio]);
  const set=k=>e=>setF(o=>({...o,[k]:e.target.value}));
  const read=async files=>{try{return await Promise.all([...files].filter(x=>x.type.startsWith('image/')).map(toJpeg))}catch(err){setState({error:'No se pudo leer '+err.message});return []}};
  const add=async e=>{const fs=[...e.target.files].slice(0,MAX_FOTOS-fotos.length);e.target.value='';const d=await read(fs);setFotos(o=>[...o,...d].slice(0,MAX_FOTOS))};
  const addPar=i=>async e=>{const fs=[...e.target.files].slice(0,1);e.target.value='';const [d]=await read(fs);if(d)setPar(p=>p.map((x,j)=>j===i?d:x))};
  const pick=p=>{setAt({x:p.x,y:p.y,label:p.label});setState(null);
    if(p.extent>120){const r=Math.min(2000,Math.max(50,Math.round(p.extent/50)*50));setAprox(true);setRadio(r);onFly({x:p.x,y:p.y,s:Math.min(.5,90/r)})}
    else{setAprox(false);onFly({x:p.x,y:p.y,s:.6})}
    if(p.name&&!f.titulo)setF(o=>({...o,titulo:p.name}))};
  const place=at&&(at.label||squareName(D,{x0:at.x-200,y0:at.y-200,size:400}));
  const busy=state&&state.sending;
  const send=async e=>{e.preventDefault();if(busy)return;
    if(tipo==='foto'&&!pares&&!fotos.length)return setState({error:'Añade al menos una foto.'});
    if(tipo==='foto'&&pares&&!(par[0]&&par[1]))return setState({error:'Añade la foto de antes y la de ahora.'});
    if(tipo==='audio'&&!audio)return setState({error:'Graba o elige un audio.'});
    if(!at)return setState({error:'Marca la ubicación: búscala o '+TAP.toLowerCase()+' el mapa.'});
    setState({sending:'Enviando…'});const [lon,lat]=toLL(D,at.x,at.y);
    const body={tipo,titulo:f.titulo,fecha:pares&&tipo==='foto'?anos[0]:f.fecha,fuente:f.fuente,nombre:f.nombre,web:f.web,lat,lon,radio:aprox?radio:0};
    try{
      if(tipo==='foto')Object.assign(body,{descripcion:f.descripcion},pares?{fotos:par,vinculadas:true,anos}:{fotos});
      else if(tipo==='texto')body.texto=f.texto;
      else{const hex=[...crypto.getRandomValues(new Uint8Array(8))].map(x=>x.toString(16).padStart(2,'0')).join('');
        const id=new Date().toISOString().slice(0,10)+'-'+hex,n=Math.max(1,Math.ceil(audio.blob.size/PART));
        for(let i=0;i<n;i++){setState({sending:`Enviando audio… ${Math.round(i/n*100)} %`});
          await post('api/proponer-parte',{id,i,n,data:await toB64(audio.blob.slice(i*PART,(i+1)*PART))})}
        setState({sending:'Enviando…'});Object.assign(body,{descripcion:f.descripcion,audio:{id,partes:n,ext:audio.ext}})}
      await post('api/proponer',body,1);setState({done:true})}
    catch(err){setState({error:err.message||'No se pudo enviar.'})}};
  const head=html`<header><h2>Contribuir al archivo</h2><button type="button" class="close" aria-label="Cerrar" onClick=${onClose}>×</button></header>`;
  if(state&&state.done)return html`<aside class="propose">${head}<p>Gracias. Hemos recibido tu aportación: el equipo la revisará antes de añadirla al mapa.</p><button onClick=${onClose}>Cerrar</button></aside>`;
  const kinds=html`<div class=${'kinds'+(tipo?'':' big')} role="radiogroup" aria-label="Qué quieres aportar">${KINDS.map(([k,l,g])=>html`<button type="button" key=${k} role="radio" aria-checked=${tipo===k} disabled=${busy}
      onClick=${()=>{setTipo(k);setState(null)}}><b aria-hidden="true">${g}</b><span>${l}</span></button>`)}</div>`;
  if(!tipo)return html`<form class="propose" onPointerDown=${e=>e.stopPropagation()}>${head}<p class="lead">Envía una foto, un audio o un texto. Revisaremos cada aportación y la añadiremos al mapa.</p>${kinds}</form>`;
  const sec=(n,t)=>html`<h3><span class="no">${n}</span>${t}</h3>`;
  const slot=(i,label)=>html`<div class="slot"><span class="lb">${label}</span>
    ${par[i]?html`<span class="ph"><img src=${par[i]} alt=${label}/><button type="button" aria-label=${'Quitar foto de '+label.toLowerCase()} onClick=${()=>setPar(p=>p.map((x,j)=>j===i?null:x))}>×</button></span>`
      :html`<label class="addf">+ Foto<input type="file" accept="image/*" onChange=${addPar(i)}/></label>`}
    <input aria-label=${'Año de la foto de '+label.toLowerCase()} maxlength="40" placeholder=${i?'Año':'Año (1960, años 70…)'} value=${anos[i]} onInput=${e=>{const v=e.target.value;setAnos(a=>a.map((x,j)=>j===i?v:x))}}/></div>`;
  return html`<form class="propose" onSubmit=${send} onPointerDown=${e=>e.stopPropagation()}>
    ${head}${kinds}
    <section>${sec(1,tipo==='foto'?'Las fotos':tipo==='audio'?'El audio':'El texto')}
      ${tipo==='foto'&&html`<div class="seg" role="radiogroup" aria-label="Tipo de fotos">
          <button type="button" role="radio" aria-checked=${!pares} onClick=${()=>setPares(false)}>Una o varias</button>
          <button type="button" role="radio" aria-checked=${pares} onClick=${()=>setPares(true)}>Antes y ahora</button></div>
        ${pares?html`<div class="pair">${slot(0,'Antes')}${slot(1,'Ahora')}</div><p class="note">La misma vista en dos momentos: en el mapa se verán juntas.</p>`
          :html`<div class="fotos">${fotos.map((d,i)=>html`<span key=${i}><img src=${d} alt=""/><button type="button" aria-label="Quitar foto" onClick=${()=>setFotos(o=>o.filter((_,j)=>j!==i))}>×</button></span>`)}
            ${fotos.length<MAX_FOTOS&&html`<label class="addf">+ Foto<input type="file" accept="image/*" multiple onChange=${add}/></label>`}</div>`}`}
      ${tipo==='audio'&&html`<${AudioPick} audio=${audio} setAudio=${setAudio} setErr=${m=>setState(m&&{error:m})}/>`}
      ${tipo==='texto'&&html`<textarea aria-label="Tu texto" required maxlength="8000" rows="7" value=${f.texto} onInput=${set('texto')} placeholder="Un recuerdo, una historia del lugar…"></textarea>`}</section>
    <section>${sec(2,'Ubicación')}
      <${PlaceSearch} D=${D} onPick=${pick}/>
      <p class=${'where'+(at?' on':'')}>${at?html`<b>●</b> ${place?(at.label?place:'Cerca de '+place):'Punto marcado'}. <span>${TAP} otro punto del mapa para moverlo.</span>`
        :html`…o ${TAP.toLowerCase()} el mapa donde ${tipo==='foto'?'se tomó la foto':tipo==='audio'?'se grabó, o el lugar del que habla':'ocurre lo que cuentas'}.`}</p>
      <div class="seg" role="radiogroup" aria-label="Precisión de la ubicación">
        <button type="button" role="radio" aria-checked=${!aprox} onClick=${()=>setAprox(false)}>Exacta</button>
        <button type="button" role="radio" aria-checked=${aprox} onClick=${()=>setAprox(true)}>Aproximada</button></div>
      ${aprox&&html`<label class="inline">± ${radio} m<input type="range" min="50" max="2000" step="50" value=${radio} onInput=${e=>setRadio(+e.target.value)} aria-label="Radio de la zona"/></label>`}</section>
    <section>${sec(3,'Datos')}
      <label>Título<input required maxlength="140" value=${f.titulo} onInput=${set('titulo')} placeholder="Lugar o calle"/></label>
      ${!(tipo==='foto'&&pares)&&html`<label>Año o fecha<input maxlength="40" value=${f.fecha} onInput=${set('fecha')} placeholder="1960, años 70…"/></label>`}
      ${tipo==='foto'&&html`<label>Descripción<textarea required maxlength="2000" rows="3" value=${f.descripcion} onInput=${set('descripcion')} placeholder="Qué se ve, quién la hizo, qué ha cambiado…"></textarea></label>`}
      ${tipo==='audio'&&html`<label>Qué se oye <small>(opcional)</small><textarea maxlength="2000" rows="2" value=${f.descripcion} onInput=${set('descripcion')}></textarea></label>`}
      <label>Fuente<input maxlength="200" value=${f.fuente} onInput=${set('fuente')} placeholder=${tipo==='foto'?'Archivo, libro, álbum familiar…':tipo==='audio'?'Grabación propia, entrevista…':'Recuerdo propio, libro…'}/></label>
      <label>Tu nombre <small>(opcional, para el crédito)</small><input maxlength="80" value=${f.nombre} onInput=${set('nombre')}/></label></section>
    <input class="hp" tabIndex="-1" autoComplete="off" aria-hidden="true" value=${f.web} onInput=${set('web')} name="web"/>
    ${state&&state.error&&html`<p class="err">${state.error}</p>`}
    <button type="submit" class="send" disabled=${busy}>${busy?state.sending:'Enviar'}</button>
    <p class="note">El equipo revisa cada aportación antes de publicarla. No compartas fotos, audios ni textos de otras personas sin su permiso.</p></form>`}

function App(){
  const [D,setD]=useState(null),[err,setErr]=useState(null),[layers,setLayers]=useState(()=>({buildings:true,trees:true,water:true,green:true,bw:localStorage.getItem('lnu-bw')==='1'}));
  const [cases,setCases]=useState({}),[open,setOpen]=useState(null),[info,setInfo]=useState(false),[,setAsp]=useState(0);
  const [proposing,setProposing]=useState(false),[at,setAt]=useState(null),[atR,setAtR]=useState(0),[fly,setFly]=useState(null);
  useEffect(()=>preloadAspects(cases,()=>setAsp(x=>x+1)),[cases]); // photo shapes decide card shapes
  useEffect(()=>{Promise.all([loadData(),fetch('data/cases.json').then(r=>r.ok?r.json():{cases:[]}).catch(()=>({cases:[]}))]).then(([d,cj])=>{
    const all={};for(const c of cj.cases){const [x,y]=toLocal(d,c.lon,c.lat);all[c.id]={...c,x,y,r:c.r||0}}
    setCases(all);setD(d)}).catch(e=>setErr(String(e)))},[]);
  if(err)return html`<div class="load">No se pudieron cargar los datos del mapa: ${err}</div>`;
  if(!D)return html`<div class="load">Cargando el mapa…</div>`;
  const tog=k=>setLayers(l=>{const n={...l,[k]:!l[k]};if(k==='bw')localStorage.setItem('lnu-bw',n.bw?'1':'0');return n});
  const LAYERS=[['trees','Árboles','var(--tree)'],['buildings','Edificios','var(--b2)'],['green','Parques','var(--green)'],['water','Agua','var(--water)']];
  const legend=html`<div class="legend" onPointerDown=${e=>e.stopPropagation()} onPointerUp=${e=>e.stopPropagation()}>
    <div class="row">${LAYERS.map(([k,l,sw])=>html`<button key=${k} class="ly" aria-pressed=${layers[k]} title=${(layers[k]?'Ocultar ':'Mostrar ')+l.toLowerCase()} onClick=${()=>tog(k)}><i style=${{'--sw':sw}}></i>${l}</button>`)}
      <button class="ly bwt" aria-pressed=${layers.bw} title="Fotos y ortofotos en blanco y negro" onClick=${()=>tog('bw')}><i></i>Fotos en b/n</button>
      <button class="i" aria-expanded=${info} aria-label="Información y fuentes" onClick=${()=>setInfo(o=>!o)}>i</button></div>
    ${info&&html`<p>${TOUCH?'Toca un cuadro para fijarlo (1956 y hoy: arrastra dentro para comparar); otro toque lo abre. Pellizca o toca dos veces para acercar.':'Pasa por un cuadro: 1956 y hoy. Clic: fijarlo; otro clic: abrirlo.'}<br/>Datos: Ayto. de Madrid · Catastro · © OpenStreetMap · © IGN (CC BY 4.0)</p>`}</div>`;
  return html`<div class=${"app"+(layers.bw?" bw":"")}>
    <${MapView} D=${D} layers=${layers} cases=${cases} onOpen=${setOpen} paused=${!!open||proposing} pick=${proposing}
      onPick=${([x,y])=>setAt({x,y})} mark=${proposing&&at&&{...at,r:atR}} fly=${fly}>${legend}<//>
    ${!proposing&&html`<button class="propbtn" onClick=${()=>{setAt(null);setProposing(true)}}>Contribuir al archivo</button>`}
    ${proposing&&html`<${Propose} D=${D} at=${at} setAt=${setAt} setR=${setAtR} onFly=${p=>setFly({...p,t:Date.now()})} onClose=${()=>{setProposing(false);setAt(null)}}/>`}
    ${open&&html`<${Explore} key=${open.tile.x0+','+open.tile.y0} D=${D} cases=${cases} open=${open} eq=${layers.bw} onClose=${()=>setOpen(null)}/>`}
  </div>`;
}
ReactDOM.createRoot(document.getElementById('root')).render(html`<${App}/>`);
