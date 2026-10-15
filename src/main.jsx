import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { io } from 'socket.io-client';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import './styles.css';

const API = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:8787' : 'https://salmonrush.onrender.com');
const money = (x) => '$' + Math.round(Number(x || 0)).toLocaleString();
const PHASES = {
  SETUP:'Waiting to start', AUCTION_TRADE:'Auction & Trading',
  CONSTRUCTION_DEPLOYMENT:'Deploy Your Fleet', RESULTS:'Processing…',
  FINISHED:'Game Over', DEBRIEF:'Debrief',
};
const TEAM_COLORS = ['#38bdf8','#4ade80','#f97316','#f472b6','#a78bfa','#facc15','#34d399','#fb923c','#818cf8','#f87171'];

function secsLeft(g) {
  if (g.pausedAt != null && g.phaseRemainingSeconds != null) return Math.max(0, Math.ceil(g.phaseRemainingSeconds));
  return g.phaseEndsAt ? Math.max(0, Math.ceil((new Date(g.phaseEndsAt) - Date.now()) / 1000)) : null;
}

// ── Ocean animation ───────────────────────────────────────────────────────────
// Golden-hour coastline in split view: rim-lit silhouettes (headlands, boats, bear,
// angler) above the waterline; light shafts, kelp and salmon schools below it.
function OceanAnimation() {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas.getContext('2d');
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const TAU = Math.PI*2;
    const C = { sil:'#0f1626', rim:'#ffb26b', glass:'#ffd58a', water:'#15607a', haze:'#f2b98f' };

    // seeded RNG so the scenery stays put across reloads and resizes
    const rng = seed => () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const R = rng(20260517);
    const rnd = (a,b) => a + R()*(b-a);
    const lerp = (a,b,f) => a + (b-a)*f;
    const hex = h => [1,3,5].map(i => parseInt(h.slice(i,i+2),16));
    const mix = (a,b,f,al=1) => { const A=hex(a), B=hex(b); return `rgba(${A.map((v,i)=>Math.round(v+(B[i]-v)*f)).join(',')},${al})`; };
    const ridge = (seed, oct) => {
      const r = rng(seed);
      const c = Array.from({length:oct},(_,i)=>({ f:Math.pow(2.2,i)*(0.8+r()*0.4), a:Math.pow(0.52,i), p:r()*TAU }));
      const n = c.reduce((s,o)=>s+o.a,0);
      return u => 0.5 + 0.5*c.reduce((s,o)=>s+o.a*Math.sin(u*o.f*TAU+o.p),0)/n;
    };
    const farR=ridge(11,5), midR=ridge(23,5), headR=ridge(37,4), bedR=ridge(41,4);

    let W=0, H=0, S=0, k=1, sunX=0, sunY=0, raf=0, last=0;
    let top, bottom, vign, caus, cloudSprites=[];
    const layer = (w,h,d) => { const c=document.createElement('canvas'); c.width=Math.max(1,Math.ceil(w*d)); c.height=Math.max(1,Math.ceil(h*d)); const x=c.getContext('2d'); x.setTransform(d,0,0,d,0,0); return [c,x]; };
    const wave = (x,t) => S + (Math.sin(x*0.011+t*1.1)*3 + Math.sin(x*0.029-t*1.6)*1.4)*k;
    const bedY = x => H*0.885 + H*0.07*bedR(x/W*2.2);

    // closed polygon, always wound the same way so nonzero fills union cleanly
    const poly = (c, pts) => {
      let a=0; for(let i=0;i<pts.length;i++){ const [x1,y1]=pts[i], [x2,y2]=pts[(i+1)%pts.length]; a+=x1*y2-x2*y1; }
      if (a<0) pts=[...pts].reverse();
      c.moveTo(...pts[0]); for(const p of pts.slice(1)) c.lineTo(...p); c.closePath();
    };
    const el = (c,x,y,rx,ry,a=0) => { c.moveTo(x+rx*Math.cos(a), y+rx*Math.sin(a)); c.ellipse(x,y,rx,ry,a,0,TAU); };
    // silhouette with a warm rim: fill in rim colour, then the dark shape nudged away from the sun
    function rimFill(build, dx, dy, dark=C.sil) {
      ctx.fillStyle=C.rim; ctx.beginPath(); build(); ctx.fill();
      ctx.save(); ctx.translate(dx,dy); ctx.fillStyle=dark; ctx.beginPath(); build(); ctx.fill(); ctx.restore();
    }

    // ── scene objects (positions stored as fractions so they survive resizes) ──
    const clouds = Array.from({length:6},(_,i)=>({ xf:i/6+rnd(0,0.1), yf:rnd(0,1), sp:rnd(0.003,0.007) }));
    const gulls  = Array.from({length:5},()=>({ xf:R(), yf:rnd(0.2,0.5), sp:rnd(0.012,0.022)*(R()<0.5?-1:1), ph:rnd(0,TAU), s:rnd(5,9) }));
    // salmon gear: a purse seiner (deep encircling net + skiff) and a gillnetter (shallow drift net); a distant seiner on the horizon
    const boats  = [
      { kind:'seiner', xf:0.42, dir:-1, sp:0.0035, sc:0.42, ph:rnd(0,TAU), far:true },
      { kind:'seiner', xf:0.33, dir:1,  sp:0.0035, sc:1,    ph:rnd(0,TAU), net:{ len:2.6, depth:120 } },
      { kind:'gill',   xf:0.7,  dir:-1, sp:0.005,  sc:0.85, ph:rnd(0,TAU), net:{ len:2.4, depth:58 } },
    ];
    const HULL = { seiner:{ len:120, stern:58 }, gill:{ len:92, stern:45 } };
    const kelp   = Array.from({length:18},(_,i)=>{ const xf=(i+R()*0.8)/18; return { xf, h:rnd(0.16,0.34), ph:rnd(0,TAU), lean:rnd(-0.6,0.6), front:(xf<0.2||xf>0.8)&&R()<0.55 }; });
    const FISH = { back:'#24455a', flank:'#8aabb4', belly:'#eef1ea', belly2:'#c9d6d3', band:'#e07f86', fin:'#4c6d7c', spot:'#132a36', gill:'#3b5a66', eye:'#e9d9a8' };
    const fishCols = z => { const o={}; for (const key in FISH) o[key]=mix(FISH[key], C.water, (1-z)*0.72); return o; };
    const SPECK = Array.from({length:16},()=>[rnd(-0.32,0.3), rnd(-0.135,-0.045)]);
    const schools = [0.12,0.3,0.5,0.7,0.92].map(z=>({ z, xf:R(), yf:rnd(0.12,0.7), dir:R()<0.5?-1:1, sp:lerp(0.01,0.03,z), ph:rnd(0,TAU), col:fishCols(z),
      fish:Array.from({length:Math.round(rnd(5,9))},()=>({ dx:rnd(-1,1), dy:rnd(-1,1), ph:rnd(0,TAU), s:rnd(0.85,1.15) })) }));
    const leapCol = fishCols(1);
    const motes  = Array.from({length:70},()=>({ xf:R(), yf:R(), r:rnd(0.6,1.8), ph:rnd(0,TAU), sp:rnd(0.004,0.012) }));
    const glints = Array.from({length:48},()=>({ u:rnd(-1,1), dy:rnd(1,9), ph:rnd(0,TAU), len:rnd(4,14) }));
    const leaps=[], drops=[], ripples=[], bubbles=[];
    let nextLeap=2.5;
    const bear = { hold:0, next:4 };
    const fly = { n:28, px:[], py:[], ox:[], oy:[], len:0, init:false };

    // ── static layers, rebuilt on resize ──
    function buildTop(d) {
      const [c,x]=layer(W,H,d); top=c;
      const base=S+14*k;
      const sky=x.createLinearGradient(0,0,0,base);
      sky.addColorStop(0,'#0b2341'); sky.addColorStop(0.38,'#25507e'); sky.addColorStop(0.7,'#9c7f97'); sky.addColorStop(0.88,'#efa98a'); sky.addColorStop(1,'#fcd7a4');
      x.fillStyle=sky; x.fillRect(0,0,W,base);
      const sr=Math.max(18,Math.min(W,H)*0.042);
      let g=x.createRadialGradient(sunX,sunY,0,sunX,sunY,sr*9);
      g.addColorStop(0,'rgba(255,224,170,0.75)'); g.addColorStop(0.18,'rgba(255,190,130,0.35)'); g.addColorStop(1,'rgba(255,160,120,0)');
      x.fillStyle=g; x.fillRect(0,0,W,base);
      g=x.createRadialGradient(sunX,sunY-sr*0.2,0,sunX,sunY,sr);
      g.addColorStop(0,'#fffaf0'); g.addColorStop(0.7,'#ffe7b8'); g.addColorStop(1,'#ffcf8f');
      x.fillStyle=g; x.beginPath(); x.arc(sunX,sunY,sr,0,TAU); x.fill();
      // mountain ranges, hazier with distance, with a bay opening under the sun
      const bay = px => 1 - 0.75*Math.exp(-Math.pow((px-sunX)/(W*0.11),2));
      const range = (fn,lo,hi,sc,pw,col) => {
        x.beginPath(); x.moveTo(0,base);
        for(let px=0;px<=W+4;px+=4) x.lineTo(px, S-H*(lo+hi*Math.pow(fn(px/W*sc),pw))*bay(px));
        x.lineTo(W,base); x.closePath(); x.fillStyle=col; x.fill();
      };
      range(farR,0.035,0.15,1.3,1.7,mix('#55618a',C.haze,0.45));
      range(midR,0.015,0.085,2.4,1.5,mix('#2c3a5e',C.haze,0.22));
      headland(x,true); headland(x,false);
    }

    function headland(x,left) {
      const span=W*(left?0.3:0.19), x0=left?0:W-span, base=S+14*k;
      const hgt = px => { const e=left?1-(px-x0)/span:(px-x0)/span; const env=Math.pow(Math.max(0,Math.min(1,e)),0.75); return H*(0.11*env+0.03*env*headR(px/W*5+(left?0:3))); };
      const fir = (cx,by,h) => {
        for(let i=0;i<3;i++){ const ty=by-h+i*h*0.22, bb=by-h*0.5+i*h*0.22, hw=h*0.36*(0.5+i*0.25); poly(x,[[cx,ty],[cx+hw,bb],[cx-hw,bb]]); }
        x.rect(cx-h*0.04,by-h*0.1,h*0.08,h*0.12);
      };
      const build = () => {
        x.moveTo(x0,base); for(let px=x0;px<=x0+span+3;px+=3) x.lineTo(px,S-hgt(px)); x.lineTo(x0+span,base); x.closePath();
        const tr=rng(left?5:9);
        for(let px=x0+4;px<x0+span-4;px+=6*k+tr()*8*k){
          const h=hgt(px), th=(10+tr()*18)*k*Math.min(1,h/(H*0.06));
          if (h>H*0.012) fir(px,S-h+2*k,th);
        }
      };
      x.fillStyle=mix(C.rim,'#000000',0.2,0.85); x.beginPath(); build(); x.fill();
      x.save(); x.translate((left?-1:1)*1.6*k,1.6*k); x.fillStyle='#16203a'; x.beginPath(); build(); x.fill(); x.restore();
    }

    function buildBottom(d) {
      const [c,x]=layer(W,H,d); bottom=c;
      const y0=S-14*k;
      let g=x.createLinearGradient(0,y0,0,H);
      g.addColorStop(0,'#2f8fa2'); g.addColorStop(0.18,'#19677f'); g.addColorStop(0.55,'#0c3d5c'); g.addColorStop(1,'#041526');
      x.fillStyle=g; x.fillRect(0,y0,W,H-y0);
      g=x.createRadialGradient(sunX,S,0,sunX,S,W*0.45);
      g.addColorStop(0,'rgba(255,200,150,0.18)'); g.addColorStop(1,'rgba(255,200,150,0)');
      x.fillStyle=g; x.fillRect(0,y0,W,H-y0);
      x.beginPath(); x.moveTo(0,H); for(let px=0;px<=W+4;px+=4) x.lineTo(px,bedY(px)); x.lineTo(W,H); x.closePath();
      g=x.createLinearGradient(0,H*0.86,0,H); g.addColorStop(0,'#123c4f'); g.addColorStop(1,'#061a28');
      x.fillStyle=g; x.fill();
      const r=rng(77);
      for(let i=0;i<9;i++){ const bx=r()*W, br=(10+r()*26)*k; x.beginPath(); x.ellipse(bx,bedY(bx)+br*0.35,br*1.4,br,0,Math.PI,TAU); x.fillStyle=mix('#0e2c3d','#06141f',r()); x.fill(); }
    }

    function buildVignette(d) {
      const [c,x]=layer(W,H,d); vign=c;
      const g=x.createRadialGradient(W/2,H*0.48,Math.min(W,H)*0.3,W/2,H*0.5,Math.hypot(W,H)*0.62);
      g.addColorStop(0,'rgba(2,8,20,0)'); g.addColorStop(1,'rgba(2,8,20,0.5)');
      x.fillStyle=g; x.fillRect(0,0,W,H);
    }

    function buildClouds(d) {
      cloudSprites = clouds.map((_,i) => {
        const r=rng(100+i), cw=(240+r()*300)*k, ch=cw*0.3, [c,x]=layer(cw,ch,d);
        x.beginPath();
        const n=9+Math.floor(r()*6);
        for(let j=0;j<n;j++){
          const f=j/(n-1), ex=cw*(0.16+0.68*f), rx=cw*(0.07+r()*0.09)*(1-Math.abs(f-0.5)*0.8), ry=ch*(0.12+r()*0.18)*(1-Math.abs(f-0.5));
          el(x,ex,ch*0.62-ry*0.4,rx,ry);
        }
        const g=x.createLinearGradient(0,0,0,ch);
        g.addColorStop(0,'rgba(150,160,205,0.5)'); g.addColorStop(0.5,'rgba(244,190,170,0.6)'); g.addColorStop(0.8,'rgba(255,196,150,0.75)');
        x.fillStyle=g; x.fill();
        return { c, w:cw, h:ch };
      });
    }

    function resize() {
      const d=Math.min(window.devicePixelRatio||1,2);
      W=window.innerWidth; H=window.innerHeight; S=H*0.5;
      k=Math.max(0.55,Math.min(1.3,Math.min(W/1400,H/850)));
      sunX=W*0.7; sunY=S-H*0.075;
      canvas.width=Math.ceil(W*d); canvas.height=Math.ceil(H*d); ctx.setTransform(d,0,0,d,0,0);
      buildTop(d); buildBottom(d); buildVignette(d); buildClouds(d);
      caus=layer(W,H*0.24,1);
      fly.len=170*k; fly.init=false;
      if (still) draw(8);
    }

    // ── animated elements ──
    function drawFish(x,y,L,dir,t,ph,col,rot=0) {
      ctx.save(); ctx.translate(x,y); ctx.rotate(rot); ctx.scale(dir,1);
      const w=Math.sin(t*7+ph)*0.28, bend=Math.sin(t*7+ph-0.6)*0.03*L;
      ctx.save(); ctx.translate(-0.37*L,bend); ctx.rotate(w);
      ctx.beginPath(); ctx.moveTo(0.03*L,0); ctx.quadraticCurveTo(-0.08*L,-0.05*L,-0.2*L,-0.15*L); ctx.quadraticCurveTo(-0.14*L,0,-0.2*L,0.15*L); ctx.quadraticCurveTo(-0.08*L,0.05*L,0.03*L,0);
      ctx.fillStyle=col.fin; ctx.fill(); ctx.restore();
      ctx.beginPath(); ctx.moveTo(0.5*L,0.01*L);
      ctx.bezierCurveTo(0.46*L,-0.09*L,0.22*L,-0.15*L,0.02*L,-0.145*L);
      ctx.bezierCurveTo(-0.18*L,-0.13*L,-0.3*L,-0.06*L+bend*0.3,-0.39*L,-0.035*L+bend);
      ctx.lineTo(-0.39*L,0.035*L+bend);
      ctx.bezierCurveTo(-0.3*L,0.07*L+bend*0.3,-0.16*L,0.13*L,0.04*L,0.13*L);
      ctx.bezierCurveTo(0.26*L,0.13*L,0.46*L,0.09*L,0.5*L,0.01*L);
      ctx.closePath();
      const g=ctx.createLinearGradient(0,-0.15*L,0,0.13*L);
      g.addColorStop(0,col.back); g.addColorStop(0.42,col.flank); g.addColorStop(0.7,col.belly); g.addColorStop(1,col.belly2);
      ctx.fillStyle=g; ctx.fill();
      ctx.save(); ctx.clip();
      ctx.fillStyle=col.band; ctx.globalAlpha=0.55; ctx.beginPath(); ctx.ellipse(-0.02*L,0.012*L,0.36*L,0.034*L,0,0,TAU); ctx.fill(); ctx.globalAlpha=1;
      if (L>26) { ctx.fillStyle=col.spot; ctx.beginPath(); for(const [sx,sy] of SPECK) el(ctx,sx*L,sy*L,0.008*L+0.3,0.008*L+0.3); ctx.fill(); }
      ctx.restore();
      ctx.fillStyle=col.fin;
      ctx.beginPath(); ctx.moveTo(0.06*L,-0.14*L); ctx.quadraticCurveTo(-0.02*L,-0.26*L,-0.1*L,-0.24*L); ctx.lineTo(-0.1*L,-0.13*L); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.ellipse(-0.27*L,-0.095*L,0.03*L,0.014*L,-0.3,0,TAU); ctx.fill();
      ctx.beginPath(); ctx.moveTo(0.24*L,0.06*L); ctx.quadraticCurveTo(0.14*L,0.17*L,0.08*L,0.15*L); ctx.quadraticCurveTo(0.15*L,0.09*L,0.24*L,0.06*L); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-0.18*L,0.1*L); ctx.lineTo(-0.27*L,0.15*L); ctx.lineTo(-0.29*L,0.07*L); ctx.closePath(); ctx.fill();
      ctx.strokeStyle=col.gill; ctx.lineWidth=Math.max(0.6,0.012*L); ctx.beginPath(); ctx.arc(0.45*L,0,0.11*L,2.2,4.1); ctx.stroke();
      ctx.fillStyle=col.eye; ctx.beginPath(); ctx.arc(0.41*L,-0.025*L,0.026*L,0,TAU); ctx.fill();
      ctx.fillStyle='#0a1118'; ctx.beginPath(); ctx.arc(0.412*L,-0.025*L,0.017*L,0,TAU); ctx.fill();
      ctx.restore();
    }

    function drawKelp(kp,t,col) {
      const x0=kp.xf*W, y0=bedY(x0)+6*k, L=kp.h*H, n=14;
      let px=x0, py=y0;
      ctx.strokeStyle=col; ctx.fillStyle=col; ctx.lineCap='round';
      for(let j=1;j<=n;j++){
        const f=j/n, sway=Math.sin(t*0.6+kp.ph+f*2.4);
        const x=x0+kp.lean*f*L*0.2+sway*(6+26*f)*k*f, y=y0-f*L;
        ctx.lineWidth=lerp(4.5,1.5,f)*k; ctx.beginPath(); ctx.moveTo(px,py); ctx.lineTo(x,y); ctx.stroke();
        if (j>2) { const s=j%2?1:-1, bl=13*k*(1-f*0.4); ctx.beginPath(); ctx.ellipse(x+s*bl*0.8,y+4*k,bl,3.2*k,s*0.6+sway*0.3,0,TAU); ctx.fill(); }
        px=x; py=y;
      }
    }

    function moveBoat(b,dt) {
      const u=k*b.sc, L=HULL[b.kind].len*u, trail=(b.net?b.net.len*L:0)+L;
      b.xf+=b.dir*b.sp*dt;
      const x=b.xf*W;
      if (b.dir>0 && x-trail>W) b.xf=-L/W;
      if (b.dir<0 && x+trail<0) b.xf=1+L/W;
    }

    function drawBoat(b,t) {
      const x=b.xf*W, y=wave(x,t), u=k*b.sc;
      const tilt=Math.atan2(wave(x+12,t)-wave(x-12,t),24)+Math.sin(t*0.9+b.ph)*0.02;
      const side=Math.sign(x-sunX)||1, seiner=b.kind==='seiner';
      ctx.save(); ctx.translate(x,y+2*u); ctx.rotate(tilt); ctx.scale(u*b.dir,u);
      const build = seiner ? () => {
        ctx.moveTo(-58,-10); ctx.lineTo(40,-12); ctx.quadraticCurveTo(54,-14,62,-25); ctx.lineTo(58,-10);
        ctx.quadraticCurveTo(54,6,36,10); ctx.lineTo(-46,10); ctx.quadraticCurveTo(-56,8,-58,-10); ctx.closePath();
        ctx.rect(12,-38,34,27); ctx.rect(17,-49,24,12); ctx.rect(14,-51,30,3); ctx.rect(30,-61,1.4,11);
        ctx.rect(5,-88,2.4,77);                                   // mast
        poly(ctx,[[6,-74],[-50,-45],[-50,-42.5],[6,-71]]);        // boom
        poly(ctx,[[-54,-44],[-46,-44],[-50,-33]]); el(ctx,-50,-35,3.4,3.4); // power block
        ctx.moveTo(-57,-11); ctx.bezierCurveTo(-55,-23,-30,-25,-21,-11); ctx.closePath(); // net pile on the stern
      } : () => {
        ctx.moveTo(-45,-8); ctx.lineTo(30,-9); ctx.quadraticCurveTo(40,-11,47,-19); ctx.lineTo(43,-8);
        ctx.quadraticCurveTo(40,4,26,7); ctx.lineTo(-38,7); ctx.quadraticCurveTo(-45,5,-45,-8); ctx.closePath();
        ctx.rect(2,-30,26,22); ctx.rect(0,-32,30,3); ctx.rect(16,-52,2,21);
        el(ctx,-33,-20,10,10); ctx.rect(-36,-11,6,4);              // net drum
      };
      if (b.far) { ctx.fillStyle=mix('#2a3550',C.haze,0.35); ctx.beginPath(); build(); ctx.fill(); }
      else {
        rimFill(build, side*1.3*k/(u*b.dir), 1.3*k/u);
        ctx.strokeStyle='rgba(255,178,107,0.3)'; ctx.lineWidth=1.2;
        if (seiner) { ctx.beginPath(); ctx.moveTo(-54,-15); ctx.quadraticCurveTo(-40,-21,-26,-14); ctx.stroke(); }
        else { ctx.beginPath(); ctx.arc(-33,-20,6,0,TAU); ctx.stroke(); }
      }
      ctx.fillStyle=C.glass;
      (seiner ? [[16,-33,6,5],[25,-33,6,5],[34,-33,6,5],[20,-46,6,4],[29,-46,6,4]] : [[5,-26,5,5],[12,-26,5,5],[19,-26,5,5]]).forEach(([wx,wy,ww,wh])=>ctx.fillRect(wx,wy,ww,wh));
      ctx.globalCompositeOperation='lighter';
      const [gx,gy]=seiner?[28,-34]:[14,-22], [lx,ly]=seiner?[6,-89]:[17,-53];
      let g=ctx.createRadialGradient(gx,gy,0,gx,gy,24); g.addColorStop(0,'rgba(255,190,110,0.28)'); g.addColorStop(1,'rgba(255,190,110,0)');
      ctx.fillStyle=g; ctx.fillRect(gx-24,gy-24,48,48);
      g=ctx.createRadialGradient(lx,ly,0,lx,ly,9); g.addColorStop(0,'rgba(255,230,170,0.95)'); g.addColorStop(1,'rgba(255,230,170,0)');
      ctx.fillStyle=g; ctx.fillRect(lx-9,ly-9,18,18);
      ctx.restore();
    }

    // net trails astern: float line on the surface, mesh curtain below with a lead line at the foot
    function netSpan(b) {
      const u=k*b.sc, h=HULL[b.kind], x0=b.xf*W-b.dir*h.stern*u, len=b.net.len*h.len*u;
      return { x0, x1:x0-b.dir*len, a:Math.min(x0,x0-b.dir*len), z:Math.max(x0,x0-b.dir*len), depth:b.net.depth*u };
    }
    function drawNetCurtain(b,t) {
      const n=netSpan(b), seiner=b.kind==='seiner';
      const foot = x => { const f=Math.min(1,Math.max(0,(x-n.a)/(n.z-n.a))); return n.depth*Math.pow(Math.sin(Math.PI*f),seiner?0.5:0.25)*(0.94+0.06*Math.sin(t*0.7+x*0.02)); };
      const sway = x => Math.sin(t*0.6+x*0.012)*7*k;
      const edge = [];
      for(let x=n.z;x>=n.a-0.1;x-=6){ const d=foot(x); edge.push([x+sway(x)*d/n.depth, wave(x,t)+1+d]); }
      ctx.save(); ctx.beginPath(); ctx.moveTo(n.a,wave(n.a,t)+1);
      for(let x=n.a;x<=n.z;x+=6) ctx.lineTo(x,wave(x,t)+1);
      edge.forEach(([x,y])=>ctx.lineTo(x,y)); ctx.closePath();
      ctx.fillStyle='rgba(190,225,235,0.07)'; ctx.fill(); ctx.clip();
      const m=7*k*Math.max(0.7,b.sc), off=Math.sin(t*0.6)*4*k, d=n.depth;
      ctx.strokeStyle='rgba(205,235,240,0.24)'; ctx.lineWidth=0.7; ctx.beginPath();
      for(let x=n.a-d;x<=n.z+d;x+=m){ ctx.moveTo(x+off,S); ctx.lineTo(x+off+d*0.55,S+d*1.1); ctx.moveTo(x+off,S); ctx.lineTo(x+off-d*0.55,S+d*1.1); }
      ctx.stroke(); ctx.restore();
      ctx.strokeStyle='rgba(8,16,26,0.6)'; ctx.lineWidth=1.8*k; ctx.beginPath();
      edge.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y)); ctx.stroke();
    }
    function drawFloats(b,t) {
      const n=netSpan(b), step=10*k*Math.max(0.75,b.sc);
      ctx.fillStyle='#f3a03c';
      for(let x=n.a;x<=n.z;x+=step){ ctx.beginPath(); ctx.ellipse(x,wave(x,t)-0.5*k,2.6*k,1.7*k,0,0,TAU); ctx.fill(); }
      if (b.kind!=='seiner') return;
      // seine skiff holding the far end of the net
      const sx=n.x1, u=k*b.sc, side=Math.sign(sx-sunX)||1;
      ctx.save(); ctx.translate(sx,wave(sx,t)+1.5*u); ctx.rotate(Math.sin(t*1.2+b.ph)*0.04); ctx.scale(u*b.dir,u);
      rimFill(() => {
        ctx.moveTo(-14,-4); ctx.lineTo(10,-5); ctx.quadraticCurveTo(15,-6,17,-10); ctx.lineTo(15,-1); ctx.quadraticCurveTo(10,4,2,4); ctx.lineTo(-11,4); ctx.quadraticCurveTo(-14,2,-14,-4); ctx.closePath();
        ctx.rect(-2,-12,7,8); ctx.rect(-17,-9,3,11);
      }, side*1.2*k/(u*b.dir), 1.2*k/u);
      ctx.restore();
    }

    const CRAG = [[-1.35,0.75],[-1.18,0.12],[-1.02,-0.18],[-0.86,-0.3],[-0.7,-0.5],[-0.46,-0.58],[-0.22,-0.6],[0.05,-0.66],[0.3,-0.63],[0.5,-0.58],[0.66,-0.44],[0.8,-0.36],[0.96,-0.14],[1.1,0.1],[1.3,0.75]];
    const FACETS = [[[-0.7,-0.5],[-0.55,-0.2],[-0.62,0.05]],[[0.05,-0.66],[0.12,-0.35]],[[0.66,-0.44],[0.5,-0.12],[0.58,0.08]]];
    // craggy outcrop: rim-lit above the waterline, fading into the water below it
    function drawRock(cx,r0,flip,dx) {
      const f=flip?-1:1, P=([x,y])=>[cx+f*x*r0,S+y*r0];
      const build=()=>poly(ctx,CRAG.map(P));
      ctx.save(); ctx.beginPath(); ctx.rect(0,0,W,S+1); ctx.clip();
      rimFill(build, dx, 1.4*k, '#141c2e');
      ctx.strokeStyle='rgba(255,178,107,0.22)'; ctx.lineWidth=1*k;
      FACETS.forEach(fc=>{ ctx.beginPath(); fc.map(P).forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y)); ctx.stroke(); });
      ctx.restore();
      ctx.save(); ctx.beginPath(); ctx.rect(0,S,W,H); ctx.clip();
      const g=ctx.createLinearGradient(0,S,0,S+0.75*r0); g.addColorStop(0,'rgba(16,40,56,0.95)'); g.addColorStop(1,'rgba(16,40,56,0)');
      ctx.fillStyle=g; ctx.beginPath(); build(); ctx.fill();
      ctx.restore();
    }

    // limb as a thick segment with a rounded joint, for silhouette figures
    const limb = (a,b,w) => {
      const dx=b[0]-a[0], dy=b[1]-a[1], d=Math.hypot(dx,dy)||1, nx=-dy/d*w/2, ny=dx/d*w/2;
      poly(ctx,[[a[0]+nx,a[1]+ny],[b[0]+nx,b[1]+ny],[b[0]-nx,b[1]-ny],[a[0]-nx,a[1]-ny]]); el(ctx,b[0],b[1],w/2,w/2);
    };

    // ── grizzly on the left rock: watches the water, now and then snatches a leaping salmon ──
    const HEAD = { x:52, y:-80, a:0.32 };
    const bearGeom = () => { const bx=W*0.16, r0=74*k; return { bx, r0, s:0.56*k, gx:bx-0.05*r0, gy:S-0.61*r0 }; };
    function bearSnout() {
      const { s, gx, gy }=bearGeom(), a=HEAD.a;
      return [gx+s*(HEAD.x+46*Math.cos(a)-8*Math.sin(a)), gy+s*(HEAD.y+46*Math.sin(a)+8*Math.cos(a))];
    }
    function drawBear(t,dt) {
      const { bx, r0, s, gx, gy }=bearGeom();
      drawRock(bx,r0,false,-1.4*k);
      if (!still) {
        bear.hold=Math.max(0,bear.hold-dt); bear.next-=dt;
        if (bear.next<=0 && bear.hold===0 && !leaps.some(l=>l.catch)) {
          bear.next=9+Math.random()*6;
          const [sx,sy]=bearSnout(), x0=bx+2.3*r0;
          leaps.push({ x0, x1:sx, y1:sy, h:0.6*r0, dir:-1, age:0, dur:1.05, catch:true }); splash(x0);
        }
      }
      const lift = bear.hold>0 ? Math.min(1,(3.5-bear.hold)/0.4,bear.hold/0.6)*0.5 : 0;
      const ha = HEAD.a-lift+Math.sin(t*0.6)*0.03;
      ctx.save(); ctx.translate(gx,gy); ctx.scale(s,s*(1+Math.sin(t*1.4)*0.01));
      rimFill(() => {
        // body: rump, back, shoulder hump, chest, near legs
        ctx.moveTo(-84,-10);
        ctx.bezierCurveTo(-92,-40,-100,-70,-84,-88);
        ctx.bezierCurveTo(-70,-102,-30,-100,-5,-104);
        ctx.bezierCurveTo(10,-114,30,-116,42,-104);
        ctx.bezierCurveTo(52,-96,58,-86,60,-76);
        ctx.lineTo(56,-58);
        ctx.bezierCurveTo(50,-50,44,-46,40,-40);
        ctx.bezierCurveTo(38,-26,40,-12,44,-5);
        ctx.bezierCurveTo(48,-2,56,-2,60,0);
        ctx.lineTo(28,0);
        ctx.bezierCurveTo(28,-14,26,-26,22,-34);
        ctx.bezierCurveTo(0,-40,-30,-40,-50,-36);
        ctx.bezierCurveTo(-48,-24,-46,-10,-42,-3);
        ctx.lineTo(-40,0); ctx.lineTo(-74,0);
        ctx.bezierCurveTo(-78,-3,-80,-6,-84,-10); ctx.closePath();
        // far-side legs peeking between the near ones
        poly(ctx,[[14,-38],[30,-40],[36,0],[16,0]]); poly(ctx,[[-62,-40],[-46,-40],[-52,0],[-66,0]]);
        el(ctx,-92,-76,6,4.5);                                   // stubby tail
        ctx.save(); ctx.translate(HEAD.x,HEAD.y); ctx.rotate(ha);
        // head: broad skull, dished face, blunt muzzle
        ctx.moveTo(-8,-16); ctx.bezierCurveTo(4,-25,20,-24,28,-16);
        ctx.bezierCurveTo(34,-11,40,-8,48,-6);
        ctx.bezierCurveTo(55,-4,58,3,53,8);
        ctx.bezierCurveTo(45,12,36,12,28,12);
        ctx.bezierCurveTo(18,15,6,15,-4,11);
        ctx.bezierCurveTo(-12,5,-14,-8,-8,-16); ctx.closePath();
        el(ctx,4,-21,7,6.5); el(ctx,15,-22,5.5,5);              // rounded ears
        ctx.restore();
      }, -1.3*k/s, 1.3*k/s);
      ctx.save(); ctx.translate(HEAD.x,HEAD.y); ctx.rotate(ha);
      ctx.fillStyle='rgba(255,190,120,0.55)'; ctx.beginPath(); ctx.arc(30,-9,1.6,0,TAU); ctx.fill(); // eye glint
      if (bear.hold>0) drawFish(46,10,62,1,t*2.4,0,leapCol,1.2);
      ctx.restore();
      ctx.restore();
    }

    // ── fly fisher on the right rock: false-casts every few seconds; the fly line is a verlet rope ──
    const anglerGeom = () => { const ax=W*0.855, r0=58*k; return { ax, r0, s:0.4*k, gx:ax+0.1*r0, gy:S-0.6*r0 }; };
    const ease = x => x<0?0:x>1?1:x*x*(3-2*x);
    function castAngle(t) {
      const c=t%8;
      if (c<4.6) return -0.95+Math.sin(t*0.8)*0.03;
      if (c<5.3) return lerp(-0.95,0.4,ease((c-4.6)/0.7));
      if (c<5.6) return 0.4;
      if (c<6.2) return lerp(0.4,-0.7,ease((c-5.6)/0.6));
      return lerp(-0.7,-0.95,ease((c-6.2)/1.8));
    }
    function stepFly(tx,ty,dt,t) {
      const n=fly.n, seg=fly.len/n, P=fly.px, Q=fly.py, OX=fly.ox, OY=fly.oy;
      if (!fly.init) {
        for(let i=0;i<=n;i++){ const x=tx-i*seg*0.85; P[i]=OX[i]=x; Q[i]=OY[i]=Math.min(ty+i*seg*0.55,wave(x,t)); }
        fly.init=true;
      }
      const steps=Math.min(8,Math.max(1,Math.round(dt*120))), h=dt/steps, g=420*k;
      for(let st=0;st<steps;st++){
        P[0]=OX[0]=tx; Q[0]=OY[0]=ty;
        for(let i=1;i<=n;i++){ const vx=(P[i]-OX[i])*0.992, vy=(Q[i]-OY[i])*0.992; OX[i]=P[i]; OY[i]=Q[i]; P[i]+=vx; Q[i]+=vy+g*h*h; }
        for(let it=0;it<8;it++) for(let i=0;i<n;i++){
          const dx=P[i+1]-P[i], dy=Q[i+1]-Q[i], d=Math.hypot(dx,dy)||1e-6, diff=(d-seg)/d;
          if (i===0) { P[1]-=dx*diff; Q[1]-=dy*diff; }
          else { P[i]+=dx*diff*0.5; Q[i]+=dy*diff*0.5; P[i+1]-=dx*diff*0.5; Q[i+1]-=dy*diff*0.5; }
        }
        for(let i=1;i<=n;i++){ const wy=wave(P[i],t); if (Q[i]>wy) { Q[i]=OY[i]=wy; OX[i]=P[i]-(P[i]-OX[i])*0.7; } }
      }
    }
    function drawAngler(t,dt) {
      const { ax, r0, s, gx, gy }=anglerGeom();
      drawRock(ax,r0,true,1.4*k);
      const th=castAngle(t), f=(th+0.95)/1.35, bendRate=(th-castAngle(t-0.06))/0.06;
      const hand=[lerp(-30,8,f),lerp(-122,-170,f)], elbow=[lerp(-8,20,f),lerp(-118,-142,f)];
      const dir=[Math.sin(th),-Math.cos(th)], RL=250, tip=[hand[0]+dir[0]*RL,hand[1]+dir[1]*RL];
      const bend=Math.max(-40,Math.min(40,-bendRate*14)), mid=[hand[0]+dir[0]*RL*0.55-dir[1]*bend, hand[1]+dir[1]*RL*0.55+dir[0]*bend];
      ctx.save(); ctx.translate(gx,gy); ctx.scale(s,s);
      rimFill(() => {
        limb([-8,-96],[-17,-50],18); limb([-17,-50],[-13,-6],16);       // waders, knees soft
        limb([8,-96],[11,-50],18); limb([11,-50],[15,-6],16);
        ctx.roundRect(-30,-8,22,8,3); ctx.roundRect(2,-8,22,8,3);          // boots
        poly(ctx,[[-18,-150],[17,-153],[21,-120],[18,-90],[-17,-90],[-21,-122]]); // vest
        limb([16,-146],[27,-118],3.5);                                     // landing-net handle
        ctx.rect(-5,-160,9,12); el(ctx,-3,-168,11,12.5); el(ctx,-13,-166,3,2.6);  // neck, head, nose
        ctx.roundRect(-26,-180,44,4.5,2); poly(ctx,[[-13,-179],[10,-179],[8,-194],[-11,-194]]); // hat
        limb([-10,-144],[-22,-118],10); limb([-22,-118],[-32,-112],9);    // line hand
        limb([6,-146],elbow,11); limb(elbow,hand,10); el(ctx,hand[0],hand[1],5.5,5.5); // casting arm
      }, 1.3*k/s, 1.3*k/s);
      ctx.strokeStyle=C.sil; ctx.lineWidth=3; ctx.beginPath(); ctx.ellipse(30,-102,8,14,-0.25,0,TAU); ctx.stroke(); // net hoop
      ctx.strokeStyle='rgba(15,22,38,0.55)'; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(24,-92); ctx.quadraticCurveTo(30,-78,36,-92); ctx.stroke();
      ctx.strokeStyle=C.sil; ctx.lineCap='round'; ctx.lineWidth=3.2;
      ctx.beginPath(); ctx.moveTo(hand[0]-dir[0]*16,hand[1]-dir[1]*16); ctx.quadraticCurveTo(mid[0],mid[1],tip[0],tip[1]); ctx.stroke();
      ctx.restore();
      const tx=gx+tip[0]*s, ty=gy+tip[1]*s;
      if (!still || !fly.init) stepFly(tx,ty,dt,t);
      ctx.strokeStyle='rgba(250,238,200,0.8)'; ctx.lineWidth=1*k; ctx.lineJoin='round';
      ctx.beginPath(); ctx.moveTo(tx,ty);
      for(let i=1;i<=fly.n;i++) ctx.lineTo(fly.px[i],fly.py[i]);
      ctx.stroke();
      // line hand to reel: a short slack loop
      ctx.beginPath(); ctx.moveTo(gx-32*s,gy-112*s); ctx.quadraticCurveTo(gx-30*s,gy-80*s,gx+hand[0]*s,gy+hand[1]*s); ctx.stroke();
    }

    function splash(x) {
      ripples.push({ x, age:0 });
      for(let i=0;i<12;i++) drops.push({ x:x+(Math.random()-0.5)*10*k, y:S, vx:(Math.random()-0.5)*90*k, vy:-(80+Math.random()*120)*k });
    }
    function spawnLeap(x0,dir,span,h) { leaps.push({ x0, x1:x0+dir*span, y1:S, dir, h, age:0, dur:1.15 }); splash(x0); }

    function draw(t) {
      const dt=still?0:Math.min(0.05,Math.max(0,t-last)); last=t;
      ctx.globalCompositeOperation='source-over'; ctx.globalAlpha=1;
      ctx.drawImage(top,0,0,W,H);
      boats.forEach(b=>moveBoat(b,dt));

      clouds.forEach((cl,i)=>{
        cl.xf+=cl.sp*dt; const sp=cloudSprites[i], span=W+sp.w;
        ctx.drawImage(sp.c,((cl.xf*span)%span+span)%span-sp.w,lerp(H*0.06,S-H*0.24,cl.yf),sp.w,sp.h);
      });

      ctx.strokeStyle='rgba(20,28,48,0.75)'; ctx.lineCap='round'; ctx.lineJoin='round'; ctx.lineWidth=1.5*k;
      gulls.forEach(g=>{
        g.xf+=g.sp*dt; if(g.xf>1.1) g.xf=-0.1; if(g.xf<-0.1) g.xf=1.1;
        const x=g.xf*W, y=g.yf*S+Math.sin(t*0.6+g.ph)*6*k, s=g.s*k*1.3, f=Math.sin(t*5+g.ph);
        ctx.beginPath(); ctx.moveTo(x-s,y-f*s*0.45); ctx.quadraticCurveTo(x-s*0.45,y-s*0.5-f*s*0.2,x,y); ctx.quadraticCurveTo(x+s*0.45,y-s*0.5-f*s*0.2,x+s,y-f*s*0.45); ctx.stroke();
      });

      // ── underwater, clipped to below the moving waterline ──
      ctx.save();
      ctx.beginPath(); ctx.moveTo(0,H); for(let x=0;x<=W+6;x+=6) ctx.lineTo(x,wave(x,t)); ctx.lineTo(W,H); ctx.closePath(); ctx.clip();
      ctx.drawImage(bottom,0,0,W,H);

      ctx.globalCompositeOperation='lighter';
      for(let i=0;i<7;i++){
        const x0=W*(0.06+i*0.15)+Math.sin(t*0.15+i*1.7)*30*k, lean=(x0-sunX)*0.35, w0=(14+(i%3)*10)*k, w1=w0*3.2, L=H*0.5;
        const a=0.06+0.035*Math.sin(t*0.4+i*2.1);
        const g=ctx.createLinearGradient(0,S,0,S+L); g.addColorStop(0,`rgba(190,235,240,${a})`); g.addColorStop(1,'rgba(190,235,240,0)');
        ctx.fillStyle=g; ctx.beginPath(); ctx.moveTo(x0-w0,S); ctx.lineTo(x0+w0,S); ctx.lineTo(x0+lean+w1,S+L); ctx.lineTo(x0+lean-w1,S+L); ctx.closePath(); ctx.fill();
      }
      const [cc,cx]=caus, bh=H*0.24;
      cx.globalCompositeOperation='source-over'; cx.clearRect(0,0,W,bh);
      cx.strokeStyle='rgba(225,250,255,0.6)'; cx.lineWidth=1.3;
      for(let fam=0;fam<2;fam++) for(let i=0;i<12;i++){
        cx.beginPath();
        for(let x=0;x<=W+10;x+=10){ const y=i*bh/10+Math.sin(x*(fam?0.021:0.016)+t*(fam?0.9:-0.7)+i*1.9)*12+Math.sin(x*0.043+t*(fam?-1.3:1.3)+i)*4; x?cx.lineTo(x,y):cx.moveTo(x,y); }
        cx.stroke();
      }
      cx.globalCompositeOperation='destination-in';
      const gm=cx.createLinearGradient(0,0,0,bh); gm.addColorStop(0,'rgba(0,0,0,0.9)'); gm.addColorStop(1,'rgba(0,0,0,0)');
      cx.fillStyle=gm; cx.fillRect(0,0,W,bh);
      ctx.globalAlpha=0.16; ctx.drawImage(cc,0,S-4*k,W,bh); ctx.globalAlpha=1;
      ctx.globalCompositeOperation='source-over';

      const backKelp=mix('#2c5e4a',C.water,0.45), frontKelp='#15302d';
      kelp.forEach(kp=>{ if(!kp.front) drawKelp(kp,t,backKelp); });

      const floor=H*0.885;
      motes.forEach(m=>{
        m.yf-=m.sp*dt; if(m.yf<0) m.yf=1;
        const a=0.12+0.22*(0.5+0.5*Math.sin(t*1.3+m.ph));
        ctx.fillStyle=`rgba(210,240,240,${a})`; ctx.beginPath(); ctx.arc(m.xf*W+Math.sin(t*0.3+m.ph)*14*k,S+(floor-S)*m.yf,m.r*k,0,TAU); ctx.fill();
      });

      schools.forEach(sc=>{
        sc.xf+=sc.dir*sc.sp*dt; if(sc.xf>1.25) sc.xf=-0.25; if(sc.xf<-0.25) sc.xf=1.25;
        const cxp=sc.xf*W, cyp=S+(floor-S)*sc.yf+Math.sin(t*0.22+sc.ph)*14*k, L0=lerp(22,62,sc.z)*k, spread=lerp(0.6,1.3,sc.z)*k;
        sc.fish.forEach(f=>drawFish(cxp+f.dx*110*spread+Math.sin(t*0.5+f.ph)*10*k, cyp+f.dy*34*spread+Math.sin(t*0.8+f.ph*1.3)*5*k, L0*f.s, sc.dir, t*(1+sc.sp*20), f.ph, sc.col));
      });

      boats.forEach(b=>{ if (b.net) drawNetCurtain(b,t); });

      if (!still && Math.random()<dt*1.4) { const x=Math.random()*W; bubbles.push({ x, y:bedY(x), r:(1+Math.random()*2.5)*k, ph:Math.random()*TAU }); }
      ctx.lineWidth=0.9*k; ctx.strokeStyle='rgba(220,245,255,0.55)';
      for(let i=bubbles.length-1;i>=0;i--){
        const b=bubbles[i]; b.y-=(22+b.r*10)*k*dt;
        if (b.y<S+3*k) { bubbles.splice(i,1); continue; }
        const x=b.x+Math.sin(t*2+b.ph)*3*k; ctx.beginPath(); ctx.arc(x,b.y,b.r,0,TAU); ctx.stroke();
      }

      kelp.forEach(kp=>{ if(kp.front) drawKelp(kp,t,frontKelp); });
      ctx.restore();

      // ── leaping salmon & splashes ──
      if (!still) {
        nextLeap-=dt;
        if (nextLeap<=0) {
          nextLeap=3+Math.random()*4;
          const right=Math.random()<0.5, x0=W*(right?0.6+Math.random()*0.2:0.24+Math.random()*0.16);
          spawnLeap(x0,Math.random()<0.5?-1:1,(70+Math.random()*50)*k,(50+Math.random()*40)*k);
        }
      }
      for(let i=leaps.length-1;i>=0;i--){
        const l=leaps[i]; l.age+=dt; const p=l.age/l.dur;
        if (p>=1) { if (l.catch) bear.hold=3.5; else splash(l.x1); leaps.splice(i,1); continue; }
        const dx=l.x1-l.x0, dy=(l.y1-S)-l.h*4*(1-2*p);
        drawFish(lerp(l.x0,l.x1,p), lerp(S,l.y1,p)-l.h*4*p*(1-p), 46*k, l.dir, t*1.6, 0, leapCol, Math.atan2(l.dir*dy,l.dir*dx));
      }

      boats.forEach(b=>{ if (b.net) drawFloats(b,t); });
      boats.forEach(b=>drawBoat(b,t));
      drawBear(t,dt);
      drawAngler(t,dt);

      // ── water surface: film over submerged parts, highlight line, sun glitter ──
      ctx.save();
      ctx.beginPath(); ctx.moveTo(0,H); for(let x=0;x<=W+6;x+=6) ctx.lineTo(x,wave(x,t)); ctx.lineTo(W,H); ctx.closePath(); ctx.clip();
      const film=ctx.createLinearGradient(0,S-6*k,0,S+70*k); film.addColorStop(0,'rgba(60,150,170,0.55)'); film.addColorStop(1,'rgba(60,150,170,0)');
      ctx.fillStyle=film; ctx.fillRect(0,S-6*k,W,76*k);
      ctx.restore();

      const hl=ctx.createLinearGradient(0,0,W,0); const sf=sunX/W;
      hl.addColorStop(0,'rgba(190,225,240,0.45)'); hl.addColorStop(sf,'rgba(255,228,175,0.95)'); hl.addColorStop(1,'rgba(190,225,240,0.45)');
      ctx.strokeStyle=hl; ctx.lineWidth=1.5*k; ctx.beginPath();
      for(let x=0;x<=W+6;x+=6) x?ctx.lineTo(x,wave(x,t)):ctx.moveTo(x,wave(x,t));
      ctx.stroke();

      ctx.globalCompositeOperation='lighter'; ctx.lineWidth=1.2*k;
      glints.forEach(g=>{
        const a=Math.pow(Math.max(0,Math.sin(t*2.2+g.ph*3)),4)*(1-Math.abs(g.u));
        if (a<0.02) return;
        const x=sunX+g.u*W*0.2, y=wave(x,t)+g.dy*k;
        ctx.strokeStyle=`rgba(255,236,190,${a})`; ctx.beginPath(); ctx.moveTo(x-g.len*k/2,y); ctx.lineTo(x+g.len*k/2,y); ctx.stroke();
      });
      ctx.globalCompositeOperation='source-over';

      ctx.lineWidth=1.2*k;
      for(let i=ripples.length-1;i>=0;i--){
        const r=ripples[i]; r.age+=dt; if (r.age>1.4) { ripples.splice(i,1); continue; }
        const rx=8*k+r.age*55*k; ctx.strokeStyle=`rgba(230,245,255,${(1-r.age/1.4)*0.7})`;
        ctx.beginPath(); ctx.ellipse(r.x,wave(r.x,t),rx,rx*0.16,0,0,TAU); ctx.stroke();
      }
      ctx.fillStyle='rgba(225,242,255,0.85)';
      for(let i=drops.length-1;i>=0;i--){
        const d=drops[i]; d.vy+=380*k*dt; d.x+=d.vx*dt; d.y+=d.vy*dt;
        if (d.vy>0 && d.y>S+4*k) { drops.splice(i,1); continue; }
        ctx.beginPath(); ctx.arc(d.x,d.y,1.6*k,0,TAU); ctx.fill();
      }

      ctx.drawImage(vign,0,0,W,H);
    }

    function frame(ts) { draw(ts/1000); raf=requestAnimationFrame(frame); }
    resize();
    window.addEventListener('resize', resize);
    if (!still) raf=requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); };
  }, []);
  return <canvas ref={ref} aria-hidden="true" style={{position:'fixed',inset:0,width:'100%',height:'100%',zIndex:0,pointerEvents:'none'}} />;
}



// ── Login ────────────────────────────────────────────────────────────────────
function Login({ onLogin }) {
  const [code,setCode]     = useState('');
  const [role,setRole]     = useState('team-1');
  const [uname,setUname]   = useState('');
  const [pass,setPass]     = useState('');
  const [msg,setMsg]       = useState('');
  const [busy,setBusy]     = useState(false);
  const [serverOk,setServerOk] = useState(null);
  const isAdmin      = role === 'admin';
  const isSuperAdmin = role === 'superadmin';
  function pick(v){ setRole(v); setPass(''); setUname(''); setMsg(''); }

  useEffect(()=>{
    let cancelled = false;
    fetch(API+'/api/health',{signal:AbortSignal.timeout(5000)})
      .then(r=>r.ok?setServerOk(true):setServerOk(false))
      .catch(()=>{ if(!cancelled) setServerOk(false); });
    return ()=>{ cancelled=true; };
  },[]);

  async function call(url, body) {
    setBusy(true); setMsg('');
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const r = await fetch(API+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
        const j = await r.json(); setBusy(false); return j;
      } catch(e) {
        if (attempt < 3) {
          setMsg(`Server waking up… retrying (${attempt}/3)`);
          await new Promise(res => setTimeout(res, 10000));
        } else {
          setMsg('Cannot reach server. Check your connection or try again shortly.');
          setBusy(false); return null;
        }
      }
    }
  }
  async function login() {
    const body = isSuperAdmin
      ? {role:'superadmin', password:pass}
      : {instanceCode:code, role, username:uname, password:pass};
    const j = await call('/api/login', body);
    if (!j) return;
    if (j.error) { setMsg(j.error); return; }
    localStorage.setItem('salmonrushToken',j.token); onLogin(j.token);
  }
  return (
    <div className="login-wrap" style={{background:'transparent',justifyContent:'center'}}>
      <OceanAnimation />
      <div className="login-card">
        <div className="login-header">
          <svg className="login-logo" viewBox="0 0 64 40" aria-hidden="true">
            <defs>
              <linearGradient id="logo-salmon" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#1f4f66"/><stop offset=".48" stopColor="#7fb0bb"/><stop offset="1" stopColor="#f3efe6"/>
              </linearGradient>
            </defs>
            <path d="M29 10.5l5-7 5.5 6.5z" fill="#1f4f66"/>
            <path d="M60 20c-4-7-14-11-25-11C24 9 16 13 10 18L3 11l2 9-2 9 7-7c6 5 14 9 25 9 11 0 21-4 25-11z" fill="url(#logo-salmon)"/>
            <path d="M14 21.5c10 3 26 3 40-1" stroke="#e07f86" strokeWidth="2.4" fill="none" strokeLinecap="round" opacity=".85"/>
            <circle cx="51" cy="17.5" r="1.8" fill="#0f1626"/>
          </svg>
          <h1>SalmonRush</h1>
        </div>
        {!isSuperAdmin && (
          <label>Session code<input className="code-input" value={code} placeholder="Enter the provided session code" onChange={e=>setCode(e.target.value.toUpperCase())} onKeyDown={e=>e.key==='Enter'&&login()} /></label>
        )}
        <label>Role
          <select value={role} onChange={e=>pick(e.target.value)}>
            <option value="admin">Instructor</option>
            {['Group 1','Group 2','Group 3','Group 4','Group 5','Group 6','Group 7','Group 8','Group 9','Group 10'].map((n,i)=><option key={i} value={'team-'+(i+1)}>{n}</option>)}
            <option value="superadmin">— Super Admin —</option>
          </select>
        </label>
        {isAdmin && (
          <label>Username<input value={uname} placeholder="leave blank for master admin" onChange={e=>setUname(e.target.value)} onKeyDown={e=>e.key==='Enter'&&login()} /></label>
        )}
        <label>Password<input type="password" value={pass} onChange={e=>setPass(e.target.value)} onKeyDown={e=>e.key==='Enter'&&login()} /></label>
        {serverOk===false && <p className="flash">⚠ Server is starting up — this can take ~30 s on first load. Please wait.</p>}
        {serverOk===null  && <p className="hint">Checking server…</p>}
        <button className="btn primary wide" onClick={login} disabled={busy}>{busy?'Signing in…':'Sign In →'}</button>
        {msg && <p className="flash">{msg}</p>}
        <p style={{textAlign:'center',fontSize:'0.72rem',color:'var(--muted)',marginTop:4}}>A classroom fishing simulation</p>
        <p style={{textAlign:'center',fontSize:'0.72rem',marginTop:4}}><a href="mailto:atalay.atasu@gmail.com" style={{color:'var(--primary)'}}>Want to play? Contact us.</a></p>
      </div>
    </div>
  );
}

// ── Header ───────────────────────────────────────────────────────────────────
function Header({ state, tick, onLogout }) {
  const g = state.game;
  const t = secsLeft(g);
  const isPaused = !!g.pausedAt;
  return (
    <header className="app-header">
      <div style={{display:'flex',alignItems:'center',gap:12}}>
        <span className="logo">🐟 SalmonRush</span>
        <span className="session-name">{g.name}</span>
      </div>
      <div className="phase-bar">
        <span className="phase-label">{PHASES[g.phase]||g.phase}</span>
        <span className="year-badge">Year {g.currentYear} / 10</span>
        {t !== null && <span className={'timer'+(isPaused?' paused':t<30?' urgent':'')}>{isPaused?'⏸ ':''}{t}s</span>}
        {isPaused && <span style={{fontSize:'0.78rem',color:'var(--orange)'}}>PAUSED</span>}
      </div>
      <div style={{display:'flex',alignItems:'center',gap:10}}>
        <span className="user-badge">{state.user.role==='admin'?'Instructor':state.user.teamName}</span>
        <button className="btn-sm" onClick={onLogout}>Log out</button>
      </div>
    </header>
  );
}

// ── Leaderboard ──────────────────────────────────────────────────────────────
function Leaderboard({ teams, myId, shipValue }) {
  const sorted = [...teams].sort((a,b)=>b.investorValuation-a.investorValuation);
  return (
    <div className="card">
      <h3>📊 Investor Valuation Ranking <span style={{fontSize:'0.78rem',color:'var(--muted)',fontWeight:400}}>Ship value: {money(shipValue)}/unit</span></h3>
      <table className="lb-table">
        <thead><tr><th>#</th><th>Company</th><th>Valuation</th></tr></thead>
        <tbody>
          {sorted.map((t,i)=>(
            <tr key={t.id} className={t.id===myId?'my-row':''}>
              <td>{i===0?'🥇':i===1?'🥈':i===2?'🥉':i+1}</td>
              <td>{t.name}{t.id===myId?' ← you':''}</td>
              <td><strong>{money(t.investorValuation)}</strong></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── History charts ────────────────────────────────────────────────────────────
function HistoryCharts({ myResults }) {
  if (!myResults || myResults.length === 0) return null;
  const data = myResults.map(r => ({
    year: 'Y'+r.year,
    coastalCatch: Math.round(r.coastalCatch||0),
    deepCatch:   Math.round(r.deepCatch||0),
    cash:          Math.round(r.cashEnd||0),
    fleet:         r.shipsEnd||0,
    valuation:     Math.round(r.investorValuation||0),
  }));
  const tip = { contentStyle:{background:'#ffffff',border:'1px solid #bfdbfe',borderRadius:6}, labelStyle:{color:'#1e3a5f'} };
  const ax  = { stroke:'#4b6384', tick:{fontSize:10} };
  return (
    <div className="card">
      <h3>📈 Performance history</h3>
      <div className="chart-grid">
        <div className="chart-card">
          <h4>🐟 Catch by zone</h4>
          <ResponsiveContainer width="100%" height={150}>
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="#bfdbfe" />
              <XAxis dataKey="year" {...ax} /><YAxis {...ax} />
              <Tooltip {...tip} /><Legend wrapperStyle={{fontSize:11}} />
              <Line type="monotone" dataKey="coastalCatch" name="Coastal" stroke="#86efac" strokeWidth={2} dot={{r:2}} />
              <Line type="monotone" dataKey="deepCatch"   name="Deep Sea" stroke="#4ade80" strokeWidth={2} dot={{r:2}} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="chart-card">
          <h4>💰 Cash position ($)</h4>
          <ResponsiveContainer width="100%" height={150}>
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="#bfdbfe" />
              <XAxis dataKey="year" {...ax} /><YAxis {...ax} tickFormatter={v=>money(v)} />
              <Tooltip {...tip} formatter={v=>money(v)} /><Legend wrapperStyle={{fontSize:11}} />
              <Line type="monotone" dataKey="cash" name="Cash" stroke="#facc15" strokeWidth={2} dot={{r:2}} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="chart-card">
          <h4>🚢 Fleet size (ships)</h4>
          <ResponsiveContainer width="100%" height={150}>
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="#bfdbfe" />
              <XAxis dataKey="year" {...ax} /><YAxis {...ax} allowDecimals={false} />
              <Tooltip {...tip} /><Legend wrapperStyle={{fontSize:11}} />
              <Line type="monotone" dataKey="fleet" name="Ships" stroke="#f97316" strokeWidth={2} dot={{r:2}} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="chart-card">
          <h4>📈 Investor valuation ($)</h4>
          <ResponsiveContainer width="100%" height={150}>
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="#bfdbfe" />
              <XAxis dataKey="year" {...ax} /><YAxis {...ax} tickFormatter={v=>money(v)} />
              <Tooltip {...tip} formatter={v=>money(v)} /><Legend wrapperStyle={{fontSize:11}} />
              <Line type="monotone" dataKey="valuation" name="Valuation" stroke="#a78bfa" strokeWidth={2} dot={{r:2}} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

// ── Auction panel ─────────────────────────────────────────────────────────────
function AuctionPanel({ state, token }) {
  const { auction, listings, myListing, team, myResults } = state;
  const lastResult = myResults && myResults.length>0 ? myResults[myResults.length-1] : null;
  const [bid,setBid]         = useState(auction.minimumNextBidPerShip||0);
  const [listQty,setListQty] = useState(0);
  const [listRes,setListRes] = useState(300);
  const [tradeBids,setTradeBids] = useState({});
  const [tradeDone,setTradeDone] = useState({});
  const [bidDone,setBidDone] = useState(false);

  useEffect(()=>{ setBid(auction.minimumNextBidPerShip||0); setBidDone(false); },[auction.minimumNextBidPerShip]);

  useEffect(()=>{
    setTradeBids(prev=>{
      const upd={...prev};
      listings.forEach(l=>{ if(!(l.id in upd)||upd[l.id]<l.minNextBid) upd[l.id]=l.minNextBid; });
      return upd;
    });
  },[listings]);

  async function post(url,body) {
    const r = await fetch(API+url,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify(body)});
    const j = await r.json(); if(j.error) alert(j.error); return j;
  }

  return (
    <div>
      {/* Last year's catch breakdown */}
      {lastResult && (lastResult.coastalCatch>0||lastResult.deepCatch>0) && (
        <div className="card" style={{padding:'10px 16px',background:'rgba(14,165,233,0.07)',borderColor:'rgba(14,165,233,0.3)'}}>
          <h4 style={{marginBottom:6,fontSize:'0.85rem'}}>🐟 Your catch last year (Year {lastResult.year})</h4>
          <div style={{display:'flex',gap:20,fontSize:'0.82rem',color:'var(--text)'}}>
            {lastResult.coastalCatch>0 && <span>🌿 Coastal: <strong>{Math.round(lastResult.coastalCatch)} fish</strong></span>}
            {lastResult.deepCatch>0    && <span>🌊 Deep Sea: <strong>{Math.round(lastResult.deepCatch)} fish</strong></span>}
            <span style={{color:'var(--muted)'}}>Total: <strong>{Math.round(lastResult.catch||0)} fish</strong></span>
          </div>
        </div>
      )}
      {/* Bank auction */}
      <div className="card">
        <h3>🏦 Bank Auction — 5 ships available</h3>
        <div className="auction-hi">
          {auction.currentHighBidPerShip>0
            ? <><p>Current high bid: <strong>{money(auction.currentHighBidPerShip)}/unit</strong> by <strong>{auction.currentHighBidderName}</strong></p>
                 <p>Minimum next bid: <strong>{money(auction.minimumNextBidPerShip)}/unit</strong> · Total for 5: <strong>{money(auction.minimumNextBidPerShip*5)}</strong></p></>
            : <><p>No bids yet. Reserve: <strong>{money(auction.reservePrice)}/unit</strong></p>
                 <p>Win all 5 ships for <strong>{money(auction.reservePrice*5)}</strong></p></>}
        </div>
        <div className="row">
          <input type="number" step="10" value={bid} onChange={e=>setBid(Math.max(0,Number(e.target.value)))} />
          <button className="btn primary" onClick={async()=>{const j=await post('/api/team/bank-bid',{bidPerShip:bid});if(j&&!j.error)setBidDone(true);}}>Place bid</button>
          {bidDone && <span className="submitted">✓ Bid placed</span>}
        </div>
      </div>

      {/* Seller: your own listing status */}
      <div className="card">
        <h3>🤝 Sell your ships</h3>
        {myListing && (
          <div className="my-listing-card">
            <p>📋 Your listing: <strong>{myListing.quantity} ships</strong> · Reserve {money(myListing.reservePricePerShip)}/unit</p>
            {myListing.currentBid
              ? <p>🏆 Highest bid: <strong>{money(myListing.currentBid)}/unit</strong> by <strong>{myListing.currentBidder}</strong> · Total: {money(myListing.currentBid*myListing.quantity)}</p>
              : <p style={{color:'var(--muted)'}}>No bids yet.</p>}
          </div>
        )}
        <p className="muted">You have {team.ships} ships. List some for other companies to bid on (highest bid wins when auction closes).</p>
        <div className="row">
          <label>Qty <input type="number" min="0" max={team.ships} value={listQty} onChange={e=>setListQty(Math.max(0,Number(e.target.value)))} /></label>
          <label>Reserve $/unit <input type="number" min="0" step="10" value={listRes} onChange={e=>setListRes(Math.max(0,Math.round(Number(e.target.value)/10)*10))} /></label>
          <button className="btn" onClick={async()=>{const j=await post('/api/team/listing',{quantity:listQty,reservePricePerShip:listRes});if(j&&!j.error)alert('Listed '+listQty+' ships at reserve $'+listRes+'/unit.');}}>List for sale</button>
        </div>
      </div>

      {/* Buyers: listings from other teams */}
      {listings.length>0 && (
        <div className="card">
          <h3>🛒 Ships for sale — bid now (highest bid wins at close)</h3>
          {listings.map(l=>(
            <div key={l.id} className="listing-row">
              <div>
                <div><strong>{l.sellerName}</strong>: {l.quantity} ships · reserve {money(l.reservePricePerShip)}/unit</div>
                <div className={'listing-bid-info'+(l.currentBid?' has-bid':'')}>
                  {l.currentBid
                    ? `🏆 Current high: ${money(l.currentBid)}/unit by ${l.currentBidder} — min next bid: ${money(l.minNextBid)}/unit`
                    : `No bids yet — min bid: ${money(l.minNextBid)}/unit`}
                </div>
              </div>
              <div className="row">
                <input type="number" step="10" value={tradeBids[l.id]??l.minNextBid} onChange={e=>setTradeBids(p=>({...p,[l.id]:Math.max(0,Number(e.target.value))}))} />
                <button className="btn" onClick={async()=>{const j=await post('/api/team/trade-bid',{listingId:l.id,bidPerShip:tradeBids[l.id]??l.minNextBid});if(j&&!j.error)setTradeDone(p=>({...p,[l.id]:true}));}}>Bid</button>
                {tradeDone[l.id] && <span className="submitted">✓ Bid placed</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Deploy panel ──────────────────────────────────────────────────────────────
function DeployPanel({ state, token }) {
  const { team, game, myResults } = state;
  const avail = team.availableShips || 0;
  const maxBuild = Math.ceil(avail / 2);

  function calcDefaults(a) {
    const lr = myResults && myResults.length > 0 ? myResults[myResults.length-1] : null;
    if (!lr) return { harbor:a, coastal:0, deep:0 };
    const c = Math.min(lr.shipsCoastal||0, a);
    const d = Math.min(lr.shipsDeepSea||0, a-c);
    return { harbor: a-c-d, coastal:c, deep:d };
  }

  const init = calcDefaults(avail);
  const [harbor,setHarbor]   = useState(init.harbor);
  const [coastal,setCoastal] = useState(init.coastal);
  const [deep,setDeep]       = useState(init.deep);
  const [build,setBuild]     = useState(0);
  const [done,setDone]       = useState(false);
  const prevYear = useRef(game.currentYear);

  useEffect(()=>{
    if(game.currentYear!==prevYear.current||avail!==harbor+coastal+deep){
      prevYear.current=game.currentYear;
      const d=calcDefaults(avail); setHarbor(d.harbor); setCoastal(d.coastal); setDeep(d.deep); setBuild(0); setDone(false);
    }
  },[avail,game.currentYear]);

  const total = harbor+coastal+deep;
  const opex  = harbor*50+coastal*150+deep*250;
  const ok    = total===avail;

  async function submit() {
    if (!ok){ alert('Harbor + Coastal + Deep Sea must equal '+avail+' ships.'); return; }
    if (build>maxBuild){ alert('Max ships to order: '+maxBuild); return; }
    const r = await fetch(API+'/api/team/deploy',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({shipsToConstruct:build,shipsHarbor:harbor,shipsCoastal:coastal,shipsDeepSea:deep})});
    const j = await r.json(); if(j.error) alert(j.error); else setDone(true);
  }

  return (
    <div className="card">
      <h3>🎣 Deploy your fleet — Year {game.currentYear}</h3>
      <p className="muted">You have <strong>{avail} ships</strong> available. Assign every one to a zone.</p>
      <div className="deploy-grid">
        <div className="zone harbor">
          <div className="zone-title">🏠 Harbor</div>
          <div className="zone-sub">$50/unit · No catching</div>
          <input type="number" min="0" max={avail} value={harbor} onChange={e=>setHarbor(Math.max(0,+e.target.value))} />
        </div>
        <div className="zone coastal">
          <div className="zone-title">🌿 Coastal</div>
          <div className="zone-sub">$150/unit · Moderate yield</div>
          <input type="number" min="0" max={avail} value={coastal} onChange={e=>setCoastal(Math.max(0,+e.target.value))} />
        </div>
        <div className="zone deep">
          <div className="zone-title">🌊 Deep Sea</div>
          <div className="zone-sub">$250/unit · Higher yield</div>
          <input type="number" min="0" max={avail} value={deep} onChange={e=>setDeep(Math.max(0,+e.target.value))} />
        </div>
      </div>
      <div className={'tally '+(ok?'ok':'bad')}>{total} / {avail} ships assigned{ok?' ✓':' — assign all to proceed'}</div>
      <div className="cost-row">
        <span>Operating costs: <strong>{money(opex)}</strong></span>
        <span>Cash: <strong>{money(team.cash)}</strong></span>
        <span>Ship value: <strong>{money(game.shipValue)}/unit</strong></span>
        {opex>team.cash && <span style={{color:'var(--orange)'}}>⚠ Will borrow at 5% interest</span>}
      </div>
      <div className="card-inner">
        <h4>🔨 Order new ships — paid &amp; delivered at start of next year (max {maxBuild})</h4>
        <div className="row" style={{marginBottom:14}}>
          <input type="number" min="0" max={maxBuild} value={build} onChange={e=>setBuild(Math.max(0,Math.min(+e.target.value,maxBuild)))} />
          <span style={{color:'var(--muted)'}}>× $300 = {money(build*300)} due next year</span>
        </div>
        {build>maxBuild && <p style={{color:'var(--red)',fontSize:'0.82rem'}}>Max {maxBuild} ships (half your fleet)</p>}
      </div>
      {done
        ? <div className="tally ok">✓ Deployment submitted! Waiting for other companies…</div>
        : <button className="btn primary wide" onClick={submit} disabled={!ok}>Confirm deployment</button>}
    </div>
  );
}

// ── P&L card ──────────────────────────────────────────────────────────────────
function PLCard({ myResults }) {
  if (!myResults || myResults.length === 0) return null;
  const idx = myResults.length - 1;
  const r = myResults[idx];
  const prev = idx > 0 ? myResults[idx - 1] : null;

  const prevCash          = prev ? prev.cashEnd : 600;
  const cashBeforeAuction = r.cashBeforeAuction ?? prevCash;
  const postAuction       = r.cashStart ?? prevCash;

  const shipyardCost  = cashBeforeAuction - prevCash;
  const auctionCost   = postAuction - cashBeforeAuction;

  const hasCatchDetail = r.coastalCatch != null && (r.coastalCatch > 0 || r.deepCatch > 0);
  const harborOpex    = (r.shipsHarbor||0) * 50;
  const coastalOpex   = (r.shipsCoastal||0) * 150;
  const deepOpex      = (r.shipsDeepSea||0) * 250;
  const interest      = r.interest || 0;
  const preInterestBal = postAuction + (r.revenue||0) - (r.opex||0);
  const interestRate  = interest >= 0 ? 2 : 5;

  return (
    <div className="card">
      <h3>📋 Year {r.year} — Cash flow &amp; P&amp;L</h3>
      <table className="detail-table">
        <tbody>
          <tr className="section-header"><td colSpan="3">Cash position</td></tr>
          <tr><td>Opening cash</td><td></td><td className={'num '+(prevCash>=0?'':'neg')}>{money(prevCash)}</td></tr>
          {shipyardCost < 0 && <tr><td>🔨 Ship delivery — units paid &amp; received</td><td></td><td className="num neg">{money(shipyardCost)}</td></tr>}
          {auctionCost !== 0 && <tr><td>{auctionCost<0?'🐟 Ships purchased (auction / trade)':'🤝 Ships sold (trade)'}</td><td></td><td className={'num '+(auctionCost>=0?'pos':'neg')}>{auctionCost>=0?'+':''}{money(auctionCost)}</td></tr>}

          <tr className="section-header"><td colSpan="3">Catch revenue</td></tr>
          {hasCatchDetail
            ? <><tr><td>🌿 Coastal catch</td><td className="num">{Math.round(r.coastalCatch)} fish</td><td className="num pos">+{money(r.coastalCatch*20)}</td></tr>
                  <tr><td>🌊 Deep Sea catch</td><td className="num">{Math.round(r.deepCatch||0)} fish</td><td className="num pos">+{money((r.deepCatch||0)*20)}</td></tr></>
            : <tr><td>🐟 Total catch</td><td className="num">{Math.round(r.catch||0)} fish</td><td className="num pos">+{money(r.revenue)}</td></tr>}
          <tr className="subtotal"><td colSpan="2"><strong>Total revenue</strong> ({Math.round(r.catch||0)} fish × $20)</td><td className="num pos"><strong>+{money(r.revenue)}</strong></td></tr>

          <tr className="section-header"><td colSpan="3">Operating costs</td></tr>
          {(r.shipsHarbor||0)>0 && <tr><td>🏠 Harbor ({r.shipsHarbor} × $50)</td><td></td><td className="num neg">−{money(harborOpex)}</td></tr>}
          {(r.shipsCoastal||0)>0 && <tr><td>🌿 Coastal ({r.shipsCoastal} × $150)</td><td></td><td className="num neg">−{money(coastalOpex)}</td></tr>}
          {(r.shipsDeepSea||0)>0 && <tr><td>🌊 Deep Sea ({r.shipsDeepSea} × $250)</td><td></td><td className="num neg">−{money(deepOpex)}</td></tr>}
          <tr className="subtotal"><td colSpan="2"><strong>Total operating costs</strong></td><td className="num neg"><strong>−{money(r.opex)}</strong></td></tr>

          {(r.shipsToConstruct||0)>0 && <tr><td colSpan="2" style={{color:'var(--muted)',fontStyle:'italic'}}>🔨 {r.shipsToConstruct} ships ordered — {money(r.shipsToConstruct*300)} due next year</td><td></td></tr>}

          <tr className="subtotal"><td colSpan="2">Balance before interest</td><td className={'num '+(preInterestBal>=0?'':'neg')}>{money(preInterestBal)}</td></tr>
          <tr><td>{interest>=0?`💰 Interest earned (${interestRate}% on ${money(preInterestBal)}):`:`💸 Interest paid (${interestRate}% on ${money(preInterestBal)}):`}</td><td></td><td className={'num '+(interest>=0?'pos':'neg')}>{interest>=0?'+':'−'}{money(Math.abs(interest))}</td></tr>

          <tr className="total-row"><td colSpan="2"><strong>Closing cash</strong></td><td className={'num '+(r.cashEnd>=0?'pos':'neg')}><strong>{money(r.cashEnd)}</strong></td></tr>

          <tr className="section-header"><td colSpan="3">Investor valuation</td></tr>
          <tr><td>Cash</td><td></td><td className={'num '+(r.cashEnd>=0?'':'neg')}>{money(r.cashEnd)}</td></tr>
          <tr><td>Fleet ({r.shipsEnd} ships × {money(r.investorValuation-r.cashEnd>0?(r.investorValuation-r.cashEnd)/r.shipsEnd:0)}/unit)</td><td></td><td className="num">{money(r.investorValuation-r.cashEnd)}</td></tr>
          <tr className="total-row"><td colSpan="2"><strong>Total investor valuation</strong></td><td className="num pos"><strong>{money(r.investorValuation)}</strong></td></tr>
        </tbody>
      </table>
      <p className="muted" style={{marginTop:8,fontSize:'0.77rem'}}>Ship market value set each round by auction prices, capped by estimated future earnings, floored at reserve.</p>
    </div>
  );
}

// ── Admin panel ───────────────────────────────────────────────────────────────
function AdminPanel({ state, token }) {
  const { game, teams, history, currentBids, auctionHistory, tradeHistory, currentListings, currentDeployments } = state;
  const sorted = [...teams].sort((a,b)=>a.teamNumber-b.teamNumber);
  const cPct = Math.round((game.coastalFishStock/1500)*100);
  const dPct = Math.round((game.deepSeaFishStock/3000)*100);
  const isPaused = !!game.pausedAt;
  async function post(url){ await fetch(API+url,{method:'POST',headers:{Authorization:'Bearer '+token}}); }

  const auctionWinners = {};
  (auctionHistory||[]).forEach(b=>{ if(!auctionWinners[b.year]||b.bidPerShip>auctionWinners[b.year].bidPerShip) auctionWinners[b.year]=b; });
  const winnerList = Object.values(auctionWinners).sort((a,b)=>a.year-b.year);

  return (
    <div>
      {/* Controls */}
      <div className="card">
        <h3>🎓 Instructor controls</h3>
        <div className="admin-btns">
          {game.phase==='SETUP' && <button className="btn primary" onClick={()=>post('/api/admin/start')}>▶ Start Year 1</button>}
          {game.phase!=='DEBRIEF' && <button className="btn" onClick={()=>post('/api/admin/close-auction')}>⏹ Close auction</button>}
          {game.phase!=='DEBRIEF' && <button className="btn" onClick={()=>post('/api/admin/close-deployment')}>⏹ Close deployment</button>}
          {game.phase!=='DEBRIEF' && (isPaused
            ? <button className="btn warn" onClick={()=>post('/api/admin/resume-timer')}>▶ Resume timer</button>
            : <button className="btn warn" onClick={()=>post('/api/admin/pause-timer')}>⏸ Pause timer</button>)}
          {game.phase!=='DEBRIEF'
            ? <button className="btn" onClick={()=>post('/api/admin/debrief')}>🔍 Open debrief</button>
            : <button className="btn primary" onClick={()=>post('/api/admin/exit-debrief')}>← Exit debrief</button>}
          <button className="btn danger" onClick={()=>{if(window.confirm('Reset the entire game?'))post('/api/admin/reset');}}>↺ Reset</button>
          <a className="btn" href={API+'/api/admin/export?token='+token} download>⬇ Export CSV</a>
        </div>
      </div>

      {/* Live auction bids */}
      {game.phase==='AUCTION_TRADE' && (
        <div className="card">
          <h3>🏦 Bank auction — live bids (Year {game.currentYear})</h3>
          {(!currentBids||currentBids.length===0)
            ? <p className="muted">No bids placed yet.</p>
            : <table className="admin-tbl">
                <thead><tr><th>#</th><th>Company</th><th>Bid/unit</th><th>Total (5 units)</th><th>Status</th></tr></thead>
                <tbody>{currentBids.map((b,i)=>(
                  <tr key={i} className={i===0?'winner-row':''}>
                    <td>{i===0?'🏆':i+1}</td><td>{b.teamName}</td>
                    <td>{money(b.bidPerShip)}</td><td>{money(b.bidPerShip*5)}</td>
                    <td>{i===0?'✓ Leading':'Outbid'}</td>
                  </tr>
                ))}</tbody>
              </table>}
        </div>
      )}

      {/* Live trade listings */}
      {game.phase==='AUCTION_TRADE' && (
        <div className="card">
          <h3>🤝 Ship trades — live listings (Year {game.currentYear})</h3>
          {(!currentListings||currentListings.length===0)
            ? <p className="muted">No ships listed for sale yet.</p>
            : <table className="admin-tbl">
                <thead><tr><th>Seller</th><th>Qty</th><th>Reserve/unit</th><th>Highest bid</th><th>Min next bid</th><th>Leading buyer</th></tr></thead>
                <tbody>{currentListings.map((l,i)=>(
                  <tr key={i}>
                    <td>{l.sellerName}</td><td>{l.quantity}</td>
                    <td>{money(l.reservePricePerShip)}</td>
                    <td>{l.currentBid?money(l.currentBid):'No bids'}</td>
                    <td>{money(l.minNextBid)}</td>
                    <td>{l.currentBidder||'—'}</td>
                  </tr>
                ))}</tbody>
                <tfoot><tr style={{fontWeight:700,borderTop:'2px solid var(--border)'}}>
                  <td>Total</td>
                  <td>{currentListings.reduce((s,l)=>s+l.quantity,0)}</td>
                  <td></td>
                  <td>{money(currentListings.reduce((s,l)=>s+(l.currentBid||0)*l.quantity,0))}</td>
                  <td></td><td></td>
                </tr></tfoot>
              </table>}
        </div>
      )}

      {/* Deployment status — visible during CONSTRUCTION_DEPLOYMENT */}
      {game.phase==='CONSTRUCTION_DEPLOYMENT' && currentDeployments && (
        <div className="card">
          <h3>🎣 Fleet deployment — Year {game.currentYear}</h3>
          <table className="admin-tbl">
            <thead>
              <tr><th>Company</th><th>Ships</th><th>Harbor</th><th>Coastal</th><th>Deep Sea</th><th>Ordering</th><th>Status</th></tr>
            </thead>
            <tbody>{currentDeployments.map(t=>(
              <tr key={t.teamId} style={{opacity:t.submittedAt?1:0.55}}>
                <td>{t.teamName}</td>
                <td>{t.ships}</td>
                <td>{t.submittedAt?t.shipsHarbor:'—'}</td>
                <td>{t.submittedAt?t.shipsCoastal:'—'}</td>
                <td>{t.submittedAt?t.shipsDeepSea:'—'}</td>
                <td>{t.submittedAt?(t.shipsToConstruct>0?`+${t.shipsToConstruct}`:'—'):'—'}</td>
                <td>{t.submittedAt?<span style={{color:'var(--green)',fontWeight:700}}>✓ Confirmed</span>:<span style={{color:'var(--orange)'}}>⏳ Pending</span>}</td>
              </tr>
            ))}</tbody>
            <tfoot><tr style={{fontWeight:700,borderTop:'2px solid var(--border)'}}>
              <td>Confirmed</td>
              <td colSpan={5}></td>
              <td>{currentDeployments.filter(t=>t.submittedAt).length} / {currentDeployments.length}</td>
            </tr></tfoot>
          </table>
        </div>
      )}

      {/* Auction history */}
      {winnerList.length>0 && (
        <div className="card">
          <h3>🏦 Auction results by year</h3>
          <table className="admin-tbl">
            <thead><tr><th>Year</th><th>Winner</th><th>Price/unit</th><th>Total paid</th></tr></thead>
            <tbody>{winnerList.map(b=>(
              <tr key={b.year}><td>Y{b.year}</td><td>{b.teamName}</td><td>{money(b.bidPerShip)}</td><td>{money(b.bidPerShip*5)}</td></tr>
            ))}</tbody>
            <tfoot><tr style={{fontWeight:700,borderTop:'2px solid var(--border)'}}>
              <td>Total</td><td></td><td></td>
              <td>{money(winnerList.reduce((s,b)=>s+b.bidPerShip*5,0))}</td>
            </tr></tfoot>
          </table>
        </div>
      )}

      {/* Trade history */}
      {tradeHistory&&tradeHistory.length>0 && (
        <div className="card">
          <h3>🤝 Ship trades by year</h3>
          <table className="admin-tbl">
            <thead><tr><th>Year</th><th>Seller</th><th>Buyer</th><th>Qty</th><th>Price/unit</th><th>Status</th></tr></thead>
            <tbody>{tradeHistory.map((t,i)=>(
              <tr key={i}><td>Y{t.year}</td><td>{t.sellerName}</td><td>{t.buyerName||'—'}</td><td>{t.quantity}</td><td>{t.winningBid?money(t.winningBid):'—'}</td><td>{t.status}</td></tr>
            ))}</tbody>
            <tfoot><tr style={{fontWeight:700,borderTop:'2px solid var(--border)'}}>
              <td>Total</td><td></td><td></td>
              <td>{tradeHistory.reduce((s,t)=>s+t.quantity,0)}</td>
              <td>{money(tradeHistory.filter(t=>t.winningBid).reduce((s,t)=>s+t.winningBid*t.quantity,0))}</td>
              <td></td>
            </tr></tfoot>
          </table>
        </div>
      )}

      {/* Fish populations */}
      <div className="card ecology">
        <h3>🌲 Fish populations — hidden from students</h3>
        <div className="stock-bars">
          <div>
            <div className="stock-lbl">Coastal: <strong>{Math.round(game.coastalFishStock)}</strong> / 1500 ({cPct}%){cPct<30?' ⚠ CRITICAL':cPct<60?' ⚡ Declining':' ✓ Healthy'}</div>
            <div className="bar-bg"><div className="bar-fill coastal" style={{width:cPct+'%'}} /></div>
          </div>
          <div>
            <div className="stock-lbl">Deep Sea: <strong>{Math.round(game.deepSeaFishStock)}</strong> / 3000 ({dPct}%){dPct<30?' ⚠ CRITICAL':dPct<60?' ⚡ Declining':' ✓ Healthy'}</div>
            <div className="bar-bg"><div className="bar-fill deep" style={{width:dPct+'%'}} /></div>
          </div>
        </div>
        <p className="muted" style={{marginBottom:12}}>Ship market value: <strong>{money(game.shipValue)}/unit</strong></p>
        {history.length>0 && (
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={history}>
              <CartesianGrid strokeDasharray="3 3" stroke="#bfdbfe" />
              <XAxis dataKey="year" stroke="#4b6384" tick={{fontSize:11}} />
              <YAxis stroke="#4b6384" tick={{fontSize:11}} />
              <Tooltip contentStyle={{background:'#ffffff',border:'1px solid #bfdbfe',borderRadius:6}} />
              <Legend />
              <Line type="monotone" dataKey="coastalFishEnd" name="Coastal fish" stroke="#4ade80" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="deepSeaFishEnd" name="Deep Sea fish" stroke="#38bdf8" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="totalShips" name="Total ships" stroke="#f97316" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* All companies */}
      <div className="card">
        <h3>🏢 All companies — current status</h3>
        <table className="admin-tbl">
          <thead><tr><th>Company</th><th>Ships</th><th>Cash</th><th>Valuation</th></tr></thead>
          <tbody>{sorted.map(t=>(
            <tr key={t.id}>
              <td>{t.name}</td><td>{t.ships}</td>
              <td style={{color:t.cash<0?'var(--red)':''}}>{money(t.cash)}</td>
              <td><strong>{money(t.investorValuation)}</strong></td>
            </tr>
          ))}</tbody>
          <tfoot><tr style={{fontWeight:700,borderTop:'2px solid var(--border)'}}>
            <td>Total</td>
            <td>{sorted.reduce((s,t)=>s+t.ships,0)}</td>
            <td style={{color:sorted.reduce((s,t)=>s+t.cash,0)<0?'var(--red)':''}}>{money(sorted.reduce((s,t)=>s+t.cash,0))}</td>
            <td><strong>{money(sorted.reduce((s,t)=>s+t.investorValuation,0))}</strong></td>
          </tr></tfoot>
        </table>
        <p className="muted" style={{marginTop:8,fontSize:'0.77rem'}}>Ship market value: <strong>{money(game.shipValue)}/unit</strong></p>
      </div>
    </div>
  );
}

// ── Debrief ────────────────────────────────────────────────────────────────────
function DebriefView({ state, token, isAdmin }) {
  const { history, teams, allTeamResults } = state;
  async function exitDebrief(){ await fetch(API+'/api/admin/exit-debrief',{method:'POST',headers:{Authorization:'Bearer '+token}}); }
  const sorted = [...teams].sort((a,b)=>b.investorValuation-a.investorValuation);
  const tip = { contentStyle:{background:'#ffffff',border:'1px solid #bfdbfe',borderRadius:6} };
  const ax  = { stroke:'#4b6384', tick:{fontSize:11} };

  const valByYear={}, catchByYear={};
  (allTeamResults||[]).forEach(r=>{
    if(!valByYear[r.year]) valByYear[r.year]={year:r.year};
    valByYear[r.year]['t'+r.teamNumber]=Math.round(r.investorValuation||0);
    if(!catchByYear[r.year]) catchByYear[r.year]={year:r.year};
    catchByYear[r.year]['t'+r.teamNumber]=Math.round((r.coastalCatch||0)+(r.deepCatch||r.catch||0));
  });
  // Year 0 baseline: initial fish stocks (from first round's start values), initial fleet, initial valuations
  const year0Val={year:0}, year0Catch={year:0};
  teams.forEach(t=>{ year0Val['t'+t.teamNumber]=1500; year0Catch['t'+t.teamNumber]=0; });
  const valData   = [year0Val, ...Object.values(valByYear).sort((a,b)=>a.year-b.year)];
  const catchData = [year0Catch, ...Object.values(catchByYear).sort((a,b)=>a.year-b.year)];
  const histWithBase = history.length>0
    ? [{year:0, coastalFishEnd:history[0].coastalFishStart, deepSeaFishEnd:history[0].deepSeaFishStart, totalShips:teams.length*3}, ...history]
    : [];

  // Aggregate system metrics by year
  const systemByYear = {};
  (allTeamResults||[]).forEach(r=>{
    if(!systemByYear[r.year]) systemByYear[r.year]={year:r.year, totalValue:0, totalLiabilities:0};
    systemByYear[r.year].totalValue += Math.round(r.investorValuation||0);
    if((r.cashEnd||0)<0) systemByYear[r.year].totalLiabilities += Math.round(-(r.cashEnd||0));
  });
  const systemRows = Object.values(systemByYear).sort((a,b)=>a.year-b.year);
  const finalSystemRow = systemRows.length>0 ? systemRows[systemRows.length-1] : null;

  return (
    <div>
      <div className="card debrief-banner">
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:10}}>
          <div>
            <h2>📋 The full picture</h2>
            <p>The fish populations were hidden during the game. Here is what actually happened in the forest.</p>
          </div>
          {isAdmin && (
            <button className="btn" onClick={exitDebrief} style={{whiteSpace:'nowrap'}}>← Exit debrief</button>
          )}
        </div>
      </div>

      {/* System-level value & liabilities summary */}
      {finalSystemRow && (
        <div className="card">
          <h3>🏦 System-level outcomes</h3>
          <div style={{display:'flex',gap:16,flexWrap:'wrap',marginBottom:20}}>
            <div style={{flex:1,minWidth:180,background:'var(--bg3)',borderRadius:10,padding:'16px 20px',textAlign:'center'}}>
              <div style={{fontSize:'0.8rem',color:'var(--muted)',marginBottom:4}}>Total value in system (final year)</div>
              <div style={{fontSize:'1.7rem',fontWeight:700,color:'var(--green)'}}>{money(finalSystemRow.totalValue)}</div>
              <div style={{fontSize:'0.75rem',color:'var(--muted)',marginTop:2}}>sum of all investor valuations</div>
            </div>
            <div style={{flex:1,minWidth:180,background:'var(--bg3)',borderRadius:10,padding:'16px 20px',textAlign:'center'}}>
              <div style={{fontSize:'0.8rem',color:'var(--muted)',marginBottom:4}}>Total liabilities in system (final year)</div>
              <div style={{fontSize:'1.7rem',fontWeight:700,color:finalSystemRow.totalLiabilities>0?'var(--red)':'var(--green)'}}>{money(finalSystemRow.totalLiabilities)}</div>
              <div style={{fontSize:'0.75rem',color:'var(--muted)',marginTop:2}}>sum of negative cash balances</div>
            </div>
          </div>
          {systemRows.length>0 && (
            <div style={{overflowX:'auto'}}>
              <table className="lb-table">
                <thead>
                  <tr>
                    <th>Year</th>
                    <th style={{textAlign:'right'}}>Total system value</th>
                    <th style={{textAlign:'right'}}>Total liabilities</th>
                    <th style={{textAlign:'right'}}>Net</th>
                  </tr>
                </thead>
                <tbody>
                  {systemRows.map(row=>(
                    <tr key={row.year}>
                      <td><strong>Y{row.year}</strong></td>
                      <td style={{textAlign:'right',color:'var(--green)',fontVariantNumeric:'tabular-nums'}}>{money(row.totalValue)}</td>
                      <td style={{textAlign:'right',color:row.totalLiabilities>0?'var(--red)':'var(--muted)',fontVariantNumeric:'tabular-nums'}}>{row.totalLiabilities>0?money(row.totalLiabilities):'—'}</td>
                      <td style={{textAlign:'right',fontVariantNumeric:'tabular-nums',fontWeight:600,color:(row.totalValue-row.totalLiabilities)>=0?'':'var(--red)'}}>{money(row.totalValue-row.totalLiabilities)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Fish populations vs fleet */}
      {histWithBase.length>0 && (
        <div className="card">
          <h3>Fish populations vs. total ships over time</h3>
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={histWithBase}>
              <CartesianGrid strokeDasharray="3 3" stroke="#bfdbfe" />
              <XAxis dataKey="year" {...ax} />
              <YAxis yAxisId="fish" {...ax} />
              <YAxis yAxisId="catchers" orientation="right" stroke="#f97316" tick={{fontSize:11}} />
              <Tooltip {...tip} /><Legend />
              <Line yAxisId="fish" type="monotone" dataKey="coastalFishEnd" name="Coastal fish" stroke="#4ade80" strokeWidth={2} />
              <Line yAxisId="fish" type="monotone" dataKey="deepSeaFishEnd" name="Deep Sea fish" stroke="#38bdf8" strokeWidth={2} />
              <Line yAxisId="catchers" type="monotone" dataKey="totalShips" name="Total ships (right)" stroke="#f97316" strokeWidth={2} strokeDasharray="5 5" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* All-team valuation chart */}
      {history.length>0 && (
        <div className="card">
          <h3>📈 Investor valuation — all companies over time</h3>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={valData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#bfdbfe" />
              <XAxis dataKey="year" {...ax} tickFormatter={v=>'Y'+v} />
              <YAxis {...ax} tickFormatter={v=>money(v)} />
              <Tooltip {...tip} formatter={v=>money(v)} /><Legend />
              {teams.map((t,i)=>(
                <Line key={t.id} type="monotone" dataKey={'t'+t.teamNumber} name={t.name} stroke={TEAM_COLORS[i%TEAM_COLORS.length]} strokeWidth={2} dot={{r:3}} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* All-team catch chart */}
      {history.length>0 && (
        <div className="card">
          <h3>🐟 Total fish catch — all companies over time</h3>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={catchData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#bfdbfe" />
              <XAxis dataKey="year" {...ax} tickFormatter={v=>'Y'+v} />
              <YAxis {...ax} />
              <Tooltip {...tip} /><Legend />
              {teams.map((t,i)=>(
                <Line key={t.id} type="monotone" dataKey={'t'+t.teamNumber} name={t.name} stroke={TEAM_COLORS[i%TEAM_COLORS.length]} strokeWidth={2} dot={{r:3}} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="card">
        <h3>Final rankings</h3>
        <table className="lb-table">
          <thead><tr><th>#</th><th>Company</th>{isAdmin&&<th>Ships</th>}{isAdmin&&<th>Cash</th>}<th>Valuation</th></tr></thead>
          <tbody>{sorted.map((t,i)=><tr key={t.id}><td>{i===0&&sorted[0].investorValuation>=1500?'🏆 1':i+1}</td><td>{t.name}</td>{isAdmin&&<td>{t.ships}</td>}{isAdmin&&<td>{money(t.cash)}</td>}<td><strong>{money(t.investorValuation)}</strong></td></tr>)}</tbody>
        </table>
      </div>

      {history.length>0 && (
        <div className="card">
          <h3>📊 Investor valuation by year — all companies</h3>
          <div style={{overflowX:'auto'}}>
            <table className="lb-table">
              <thead>
                <tr>
                  <th>Year</th>
                  {[...teams].sort((a,b)=>a.teamNumber-b.teamNumber).map(t=><th key={t.id}>{t.name}</th>)}
                </tr>
              </thead>
              <tbody>
                {valData.map(row=>(
                  <tr key={row.year}>
                    <td><strong>Y{row.year}</strong></td>
                    {[...teams].sort((a,b)=>a.teamNumber-b.teamNumber).map(t=>(
                      <td key={t.id} style={{textAlign:'right',fontVariantNumeric:'tabular-nums',color:row['t'+t.teamNumber]>=1500?'var(--green)':row['t'+t.teamNumber]<0?'var(--red)':''}}>
                        {row['t'+t.teamNumber]!=null?money(row['t'+t.teamNumber]):'—'}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Team view ──────────────────────────────────────────────────────────────────
function TeamView({ state, token }) {
  const { game, team, teams, myResults } = state;

  const hasAction = game.phase==='AUCTION_TRADE'||game.phase==='CONSTRUCTION_DEPLOYMENT';
  const isWaiting = ['SETUP','FINISHED'].includes(game.phase);

  return (
    <div>
      {/* Stats always at top */}
      <div className="stats-row">
        <div className="stat-card"><div className="stat-label">Cash</div><div className="stat-value" style={{color:team.cash<0?'var(--red)':''}}>{money(team.cash)}</div>{team.cash<0&&<div className="stat-sub">5% interest on debt</div>}</div>
        <div className="stat-card"><div className="stat-label">Fleet size</div><div className="stat-value">{team.ships} 🚢</div>{team.availableShips!==team.ships&&<div className="stat-sub">+{team.availableShips-team.ships} arriving</div>}</div>
        <div className="stat-card"><div className="stat-label">Ship value</div><div className="stat-value">{money(game.shipValue)}</div><div className="stat-sub">per unit</div></div>
        <div className="stat-card hi"><div className="stat-label">My valuation</div><div className="stat-value">{money(team.investorValuation)}</div><div className="stat-sub">fleet + cash</div></div>
      </div>

      {/* Decision panels first */}
      {game.phase==='AUCTION_TRADE'          && <AuctionPanel state={state} token={token} />}
      {game.phase==='CONSTRUCTION_DEPLOYMENT' && <DeployPanel  state={state} token={token} />}
      {isWaiting && (
        <div className="card waiting"><p>{game.phase==='FINISHED'?'🏁 Game over! Waiting for instructor to open debrief.':'⏳ Waiting for the instructor to start the game…'}</p></div>
      )}

      {/* Historical data below */}
      <PLCard myResults={myResults} />
      <HistoryCharts myResults={myResults} />
      <Leaderboard teams={teams} myId={team?.id} shipValue={game.shipValue} />
    </div>
  );
}

// ── Super-admin panel ─────────────────────────────────────────────────────────
function SuperAdminPanel({ token, onLogout }) {
  const [sessions,setSessions] = useState(null);
  const [msg,setMsg]           = useState('');
  const [busy,setBusy]         = useState(false);
  // create-session form
  const [newCode,setNewCode]   = useState('');
  const [newName,setNewName]   = useState('');
  const [showCreate,setShowCreate] = useState(false);
  // add-instructor form keyed by gameId
  const [instrForm,setInstrForm]   = useState({});   // { [gameId]: {username:'',password:''} }

  const hdr = { Authorization:'Bearer '+token };

  async function loadSessions() {
    try {
      const r = await fetch(API+'/api/superadmin/sessions',{headers:hdr});
      const j = await r.json();
      if(Array.isArray(j)) setSessions(j); else setMsg(j.error||'Error loading sessions');
    } catch { setMsg('Cannot reach server'); }
  }
  useEffect(()=>{ loadSessions(); },[]);

  async function createSession() {
    if(!newCode.trim()){ setMsg('Code is required'); return; }
    setBusy(true); setMsg('');
    const r = await fetch(API+'/api/superadmin/sessions',{method:'POST',headers:{...hdr,'Content-Type':'application/json'},body:JSON.stringify({code:newCode.trim().toUpperCase(),name:newName.trim()||newCode.trim().toUpperCase()})});
    const j = await r.json(); setBusy(false);
    if(j.error){ setMsg(j.error); return; }
    setNewCode(''); setNewName(''); setShowCreate(false); loadSessions();
  }

  async function deleteSession(id,code) {
    if(!window.confirm(`Delete session "${code}" and ALL its data? This cannot be undone.`)) return;
    setBusy(true);
    await fetch(API+'/api/superadmin/sessions/'+id,{method:'DELETE',headers:hdr});
    setBusy(false); loadSessions();
  }

  async function addInstructor(gameId) {
    const f = instrForm[gameId]||{};
    if(!f.username||!f.password){ setMsg('Username and password are required'); return; }
    setBusy(true); setMsg('');
    const r = await fetch(API+'/api/superadmin/instructors',{method:'POST',headers:{...hdr,'Content-Type':'application/json'},body:JSON.stringify({gameId,username:f.username,password:f.password,startDate:f.startDate||'',endDate:f.endDate||''})});
    const j = await r.json(); setBusy(false);
    if(j.error){ setMsg(j.error); return; }
    setInstrForm(prev=>({...prev,[gameId]:{username:'',password:'',startDate:'',endDate:''}}));
    loadSessions();
  }

  async function removeInstructor(id) {
    if(!window.confirm('Remove this instructor?')) return;
    await fetch(API+'/api/superadmin/instructors/'+id,{method:'DELETE',headers:hdr});
    loadSessions();
  }

  const phaseLabel = { SETUP:'Setup', AUCTION_TRADE:'Auction', CONSTRUCTION_DEPLOYMENT:'Deploy', RESULTS:'Processing', FINISHED:'Finished', DEBRIEF:'Debrief' };

  return (
    <div className="app">
      <div className="app-header">
        <span className="logo">🐟 SalmonRush</span>
        <span className="phase-label">Super Admin</span>
        <button className="btn-sm" onClick={onLogout}>Log out</button>
      </div>
      <main className="app-main">
        {msg && <p className="flash" style={{marginBottom:12}}>{msg}</p>}

        {/* Create session */}
        <div className="card" style={{marginBottom:16}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
            <h3>Sessions</h3>
            <button className="btn primary" onClick={()=>setShowCreate(v=>!v)}>+ New session</button>
          </div>
          {showCreate && (
            <div style={{marginTop:14,display:'flex',gap:10,flexWrap:'wrap',alignItems:'flex-end'}}>
              <label style={{display:'flex',flexDirection:'column',gap:4,fontSize:'0.85rem',color:'var(--muted)'}}>
                Code
                <input value={newCode} onChange={e=>setNewCode(e.target.value.toUpperCase())} placeholder="e.g. MBA26A" style={{padding:'8px 10px',borderRadius:6,border:'1px solid var(--border)',background:'var(--bg3)',color:'var(--text)',fontSize:'0.9rem',width:120}} onKeyDown={e=>e.key==='Enter'&&createSession()} />
              </label>
              <label style={{display:'flex',flexDirection:'column',gap:4,fontSize:'0.85rem',color:'var(--muted)'}}>
                Display name (optional)
                <input value={newName} onChange={e=>setNewName(e.target.value)} placeholder="e.g. MBA 2026 Section A" style={{padding:'8px 10px',borderRadius:6,border:'1px solid var(--border)',background:'var(--bg3)',color:'var(--text)',fontSize:'0.9rem',width:220}} onKeyDown={e=>e.key==='Enter'&&createSession()} />
              </label>
              <button className="btn primary" onClick={createSession} disabled={busy}>Create</button>
              <button className="btn" onClick={()=>setShowCreate(false)}>Cancel</button>
            </div>
          )}
        </div>

        {/* Sessions list */}
        {sessions===null ? <p className="muted">Loading…</p> : sessions.length===0 ? <p className="muted">No sessions yet. Create one above.</p> : sessions.map(s=>(
          <div key={s.id} className="card" style={{marginBottom:12}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',flexWrap:'wrap',gap:8}}>
              <div>
                <span style={{fontWeight:700,fontSize:'1rem'}}>{s.code}</span>
                {s.name!==s.code && <span style={{color:'var(--muted)',marginLeft:8,fontSize:'0.9rem'}}>{s.name}</span>}
                <span className="year-badge" style={{marginLeft:10}}>{phaseLabel[s.phase]||s.phase}</span>
                {s.phase!=='SETUP'&&s.phase!=='DEBRIEF'&&s.phase!=='FINISHED'&&<span style={{color:'var(--muted)',fontSize:'0.8rem',marginLeft:8}}>Year {s.currentYear}</span>}
              </div>
              <button className="btn danger" onClick={()=>deleteSession(s.id,s.code)} disabled={busy}>Delete session</button>
            </div>

            {/* Instructors */}
            <div style={{marginTop:14,borderTop:'1px solid var(--border)',paddingTop:12}}>
              <h4 style={{marginBottom:8}}>Instructors</h4>
              {s.instructors.length===0
                ? <p className="muted" style={{fontSize:'0.82rem',marginBottom:8}}>No instructors assigned — only master admin password works.</p>
                : <table className="admin-tbl" style={{marginBottom:10}}>
                    <thead><tr><th>Username</th><th>Password</th><th>Start date</th><th>End date</th><th></th></tr></thead>
                    <tbody>{s.instructors.map(ins=>{
                      const today=new Date().toISOString().slice(0,10);
                      const notYet=ins.startDate&&today<ins.startDate;
                      const expired=ins.endDate&&today>ins.endDate;
                      const status=expired?'⛔ expired':notYet?'⏳ pending':'✓ active';
                      const statusColor=expired?'var(--red)':notYet?'var(--muted)':'var(--green)';
                      return (
                      <tr key={ins.id}>
                        <td><strong>{ins.username}</strong> <span style={{fontSize:'0.75rem',color:statusColor}}>{status}</span></td>
                        <td style={{fontFamily:'monospace'}}>{ins.password}</td>
                        <td style={{color:'var(--muted)',fontSize:'0.8rem'}}>{ins.startDate||'—'}</td>
                        <td style={{color:'var(--muted)',fontSize:'0.8rem'}}>{ins.endDate||'—'}</td>
                        <td><button className="btn-sm" style={{color:'var(--red)',borderColor:'var(--red)'}} onClick={()=>removeInstructor(ins.id)}>Remove</button></td>
                      </tr>
                    )})}</tbody>
                  </table>
              }
              {/* Add instructor form */}
              <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'flex-end'}}>
                <input
                  placeholder="Username"
                  value={(instrForm[s.id]||{}).username||''}
                  onChange={e=>setInstrForm(prev=>({...prev,[s.id]:{...(prev[s.id]||{}),username:e.target.value}}))}
                  style={{padding:'6px 10px',borderRadius:6,border:'1px solid var(--border)',background:'var(--bg3)',color:'var(--text)',fontSize:'0.85rem',width:140}}
                />
                <input
                  placeholder="Password"
                  type="password"
                  value={(instrForm[s.id]||{}).password||''}
                  onChange={e=>setInstrForm(prev=>({...prev,[s.id]:{...(prev[s.id]||{}),password:e.target.value}}))}
                  style={{padding:'6px 10px',borderRadius:6,border:'1px solid var(--border)',background:'var(--bg3)',color:'var(--text)',fontSize:'0.85rem',width:140}}
                />
                <label style={{display:'flex',flexDirection:'column',gap:2,fontSize:'0.75rem',color:'var(--muted)'}}>
                  Start date
                  <input
                    type="date"
                    value={(instrForm[s.id]||{}).startDate||''}
                    onChange={e=>setInstrForm(prev=>({...prev,[s.id]:{...(prev[s.id]||{}),startDate:e.target.value}}))}
                    style={{padding:'6px 8px',borderRadius:6,border:'1px solid var(--border)',background:'var(--bg3)',color:'var(--text)',fontSize:'0.85rem'}}
                  />
                </label>
                <label style={{display:'flex',flexDirection:'column',gap:2,fontSize:'0.75rem',color:'var(--muted)'}}>
                  End date
                  <input
                    type="date"
                    value={(instrForm[s.id]||{}).endDate||''}
                    onChange={e=>setInstrForm(prev=>({...prev,[s.id]:{...(prev[s.id]||{}),endDate:e.target.value}}))}
                    style={{padding:'6px 8px',borderRadius:6,border:'1px solid var(--border)',background:'var(--bg3)',color:'var(--text)',fontSize:'0.85rem'}}
                  />
                </label>
                <button className="btn" onClick={()=>addInstructor(s.id)} disabled={busy}>+ Add instructor</button>
              </div>
            </div>

            {/* Team login reference */}
            <div style={{marginTop:12,borderTop:'1px solid var(--border)',paddingTop:10,fontSize:'0.78rem',color:'var(--muted)'}}>
              Team passwords — Group 1: lugano · Group 2: anelka · Group 3: alex · Group 4: deivid · Group 5: anderson · Group 6: kante · Group 7: kocaman · Group 8: guendouzi · Group 9: aurelio · Group 10: asencio
            </div>
          </div>
        ))}
      </main>
    </div>
  );
}

// helper — decode JWT payload without verifying signature (safe: used only for routing)
function tokenRole(token){ try{ return JSON.parse(atob(token.split('.')[1])).role; }catch{ return null; } }

// ── Chat box ──────────────────────────────────────────────────────────────────
function ChatBox({ state, token, socket }) {
  const [open,setOpen]       = useState(false);
  const [msg,setMsg]         = useState('');
  const [toTeamId,setToTeam] = useState('all');
  const [messages,setMessages] = useState([]);
  const [unread,setUnread]   = useState(0);
  const endRef = useRef(null);
  const isAdmin = state.user.role==='admin';
  const sorted  = [...state.teams].sort((a,b)=>a.teamNumber-b.teamNumber);

  // Load history once on mount
  useEffect(()=>{
    fetch(API+'/api/chat',{headers:{Authorization:'Bearer '+token}})
      .then(r=>r.json()).then(data=>{ if(Array.isArray(data)) setMessages(data); });
  },[]);

  // Listen for incoming chat messages over socket
  useEffect(()=>{
    if(!socket) return;
    const handler=(m)=>{
      setMessages(prev=>[...prev,m]);
      if(!open) setUnread(u=>u+1);
    };
    socket.on('chat_msg',handler);
    return ()=>socket.off('chat_msg',handler);
  },[socket,open]);

  // Scroll to bottom + clear unread when panel opens
  useEffect(()=>{
    if(open){ setUnread(0); setTimeout(()=>endRef.current?.scrollIntoView({behavior:'smooth'}),50); }
  },[open]);
  useEffect(()=>{ if(open) endRef.current?.scrollIntoView({behavior:'smooth'}); },[messages,open]);

  async function send(){
    if(!msg.trim()) return;
    const toId   = toTeamId==='all'?null:toTeamId;
    const toName = toId ? sorted.find(t=>t.id===toId)?.name||null : null;
    await fetch(API+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({message:msg.trim(),toTeamId:toId,toTeamName:toName})});
    setMsg('');
  }

  const btnStyle={position:'fixed',bottom:24,right:24,zIndex:2000};
  const panelStyle={position:'fixed',bottom:24,right:24,zIndex:2000,width:310,height:400,background:'var(--bg2)',border:'1px solid var(--border)',borderRadius:14,display:'flex',flexDirection:'column',boxShadow:'0 8px 32px rgba(0,0,0,0.35)'};

  if(!open) return (
    <div style={btnStyle}>
      <button className="btn primary" style={{borderRadius:'50%',width:50,height:50,fontSize:'1.2rem',padding:0,position:'relative'}} onClick={()=>setOpen(true)}>
        💬
        {unread>0 && <span style={{position:'absolute',top:-5,right:-5,background:'var(--red)',color:'#fff',borderRadius:'50%',width:18,height:18,fontSize:'0.62rem',display:'flex',alignItems:'center',justifyContent:'center',fontWeight:700}}>{unread}</span>}
      </button>
    </div>
  );

  return (
    <div style={panelStyle}>
      {/* Header */}
      <div style={{padding:'9px 14px',borderBottom:'1px solid var(--border)',display:'flex',alignItems:'center',justifyContent:'space-between'}}>
        <span style={{fontWeight:700,fontSize:'0.88rem'}}>💬 Chat</span>
        <button style={{background:'none',border:'none',cursor:'pointer',color:'var(--muted)',fontSize:'1rem',lineHeight:1}} onClick={()=>setOpen(false)}>✕</button>
      </div>
      {/* Recipient selector — admin only */}
      {isAdmin && (
        <div style={{padding:'5px 10px',borderBottom:'1px solid var(--border)'}}>
          <select value={toTeamId} onChange={e=>setToTeam(e.target.value)} style={{width:'100%',fontSize:'0.75rem',padding:'3px 5px',background:'var(--bg3)',border:'1px solid var(--border)',borderRadius:4,color:'var(--text)'}}>
            <option value="all">📢 Broadcast to all</option>
            {sorted.map(t=><option key={t.id} value={t.id}>Private → {t.name}</option>)}
          </select>
        </div>
      )}
      {/* Messages */}
      <div style={{flex:1,overflowY:'auto',padding:'8px 10px',display:'flex',flexDirection:'column',gap:5}}>
        {messages.length===0 && <p style={{color:'var(--muted)',fontSize:'0.78rem',textAlign:'center',marginTop:20}}>No messages yet.</p>}
        {messages.map(m=>(
          <div key={m.id} style={{background:m.fromRole==='admin'?'rgba(14,165,233,0.13)':'var(--bg3)',borderRadius:8,padding:'5px 9px',fontSize:'0.79rem'}}>
            <div style={{fontWeight:700,fontSize:'0.7rem',color:'var(--muted)',marginBottom:2}}>
              {m.fromRole==='admin'?'🎓 Instructor':m.fromName}
              {m.toTeamName && <span style={{color:'var(--orange)',fontWeight:400}}> → {m.toTeamName}</span>}
            </div>
            <div style={{wordBreak:'break-word'}}>{m.message}</div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      {/* Input */}
      <div style={{padding:'7px 10px',borderTop:'1px solid var(--border)',display:'flex',gap:6}}>
        <input style={{flex:1,padding:'5px 8px',borderRadius:6,border:'1px solid var(--border)',background:'var(--bg3)',color:'var(--text)',fontSize:'0.82rem'}}
          value={msg} onChange={e=>setMsg(e.target.value)}
          onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}}}
          placeholder="Type a message…" />
        <button className="btn primary" style={{padding:'5px 11px',fontSize:'0.78rem'}} onClick={send}>Send</button>
      </div>
    </div>
  );
}

// ── App root ──────────────────────────────────────────────────────────────────
function App() {
  const [token,setToken] = useState(localStorage.getItem('salmonrushToken'));
  const [state,setState] = useState(null);
  const [tick,setTick]   = useState(0);
  const role = tokenRole(token);
  const isSuperAdmin = role === 'superadmin';
  // Only open a socket for non-superadmin sessions
  const socket = useMemo(()=>(token&&!isSuperAdmin)?io(API,{auth:{token}}):null,[token,isSuperAdmin]);
  async function load() {
    if (!token || isSuperAdmin) return;
    try {
      const r = await fetch(API+'/api/state',{headers:{Authorization:'Bearer '+token}});
      const j = await r.json();
      if (j.error){ localStorage.removeItem('salmonrushToken'); setToken(null); } else setState(j);
    } catch {}
  }
  useEffect(()=>{ load(); },[token]);
  useEffect(()=>{ if(!socket) return; socket.on('state_changed',load); socket.on('connect',load); return ()=>socket.disconnect(); },[socket]);
  useEffect(()=>{ const t=setInterval(()=>setTick(x=>x+1),1000); return ()=>clearInterval(t); },[]);
  function logout(){ localStorage.removeItem('salmonrushToken'); setToken(null); setState(null); }
  if (!token) return <Login onLogin={setToken} />;
  if (isSuperAdmin) return <SuperAdminPanel token={token} onLogout={logout} />;
  if (!state)  return <div className="loading">🐟 Loading…</div>;
  const isAdmin    = state.user.role==='admin';
  const isDebrief  = state.game.phase==='DEBRIEF';
  const isFinished = state.game.phase==='FINISHED';
  const showChat = !['SETUP'].includes(state.game.phase);
  return (
    <div className="app">
      <Header state={state} tick={tick} onLogout={logout} />
      <main className="app-main">
        {isDebrief                   && <DebriefView state={state} token={token} isAdmin={isAdmin} />}
        {(isFinished||!isDebrief) && isAdmin  && <AdminPanel  state={state} token={token} />}
        {!isDebrief && !isAdmin       && <TeamView    state={state} token={token} />}
      </main>
      {showChat && <ChatBox state={state} token={token} socket={socket} />}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
