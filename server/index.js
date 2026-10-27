import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { nanoid } from 'nanoid';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import { randomBytes, timingSafeEqual } from 'crypto';

const PORT = Number(process.env.PORT || 8787);
// Secrets come only from the environment. A missing password disables that login instead of falling back to a default.
const JWT_SECRET = process.env.JWT_SECRET || randomBytes(32).toString('hex'); // random fallback: tokens just expire on restart
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''; // master admin — bypasses instructor table
const SUPERADMIN_PASSWORD = process.env.SUPERADMIN_PASSWORD || '';
if(!process.env.JWT_SECRET) console.warn('JWT_SECRET not set — using a random secret; logins reset on restart');
if(!ADMIN_PASSWORD) console.warn('ADMIN_PASSWORD not set — master admin login disabled');
if(!SUPERADMIN_PASSWORD) console.warn('SUPERADMIN_PASSWORD not set — super-admin login disabled');
function passwordMatches(given,expected){ if(!expected) return false; const a=Buffer.from(String(given??'')), b=Buffer.from(expected); return a.length===b.length&&timingSafeEqual(a,b); }
const TEAM_PASSWORDS = ['lugano','anelka','alex','deivid','anderson','kante','kocaman','guendouzi','aurelio','asencio'];
const TEAM_NAMES = ['Group 1','Group 2','Group 3','Group 4','Group 5','Group 6','Group 7','Group 8','Group 9','Group 10'];
const DB_PATH = process.env.DATABASE_PATH || './salmonrush.sqlite';
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
// Ensure the directory for the DB file exists (important for persistent disk on Render)
const dbDir = path.dirname(path.resolve(DB_PATH));
mkdirSync(dbDir, { recursive: true });
const db = new Database(DB_PATH);
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });
app.use(cors({ origin: '*' })); app.use(express.json());

// Auto-close timers keyed by gameId
const phaseTimers = new Map();

const SETTINGS = { maxYears:10, teams:10, initialShips:3, initialCash:600, coastalK:1500, deepK:3000, coastalInitial:1400, deepInitial:2700, fishPrice:20, harborOpex:50, coastalOpex:150, deepOpex:250, buildCost:300, positiveRate:0.02, negativeRate:0.05, auctionQty:5, auctionSeconds:150, deploySeconds:150, bidIncrement:10, threshold:0.20};
function reserve(year){ return [300,300,300,300,300,200,100,100,1,1][year-1] ?? 1; }
function effectiveness(stock,k){ const d=Math.max(0,stock/k); const th=SETTINGS.threshold; return Math.min(1,(d*d)/(th*th+d*d)*(1+th*th)); }
function cps(region,stock){ return (region==='coastal'?15:25)*effectiveness(stock, region==='coastal'?SETTINGS.coastalK:SETTINGS.deepK); }
function growth(stock,k){
  const d=Math.max(0,Math.min(1,stock/k));
  const rate=Math.min(1,Math.pow(d/0.6,2)); // alpha=2; peaks at 1 when d=0.6; stays 1 for d>=0.6
  const potential=rate*stock;               // eggs laid = rate * current stock
  return Math.max(0,Math.min(k-stock,potential)); // matured = min(eggs, room left in ocean)
}
function nowIso(){ return new Date().toISOString(); }
function sign(payload){ return jwt.sign(payload, JWT_SECRET, { expiresIn:'8h' }); }
function auth(req,res,next){ try{ let token=(req.headers.authorization||'').replace('Bearer ','') || req.query.token; req.user=jwt.verify(token,JWT_SECRET); next(); }catch(e){ res.status(401).json({error:'Unauthorized'}); } }
function superauth(req,res,next){ try{ const token=(req.headers.authorization||'').replace('Bearer ',''); req.user=jwt.verify(token,JWT_SECRET); if(req.user.role!=='superadmin') return res.status(403).json({error:'Super admin only'}); next(); }catch(e){ res.status(401).json({error:'Unauthorized'}); } }
function emitGame(gameId){ io.to(gameId).emit('state_changed'); }

function migrate(){
 db.exec(`CREATE TABLE IF NOT EXISTS games(id TEXT PRIMARY KEY, code TEXT UNIQUE, name TEXT, phase TEXT, currentYear INTEGER, coastalFishStock REAL, deepSeaFishStock REAL, shipValue REAL, phaseEndsAt TEXT, createdAt TEXT);
 CREATE TABLE IF NOT EXISTS instructors(id TEXT PRIMARY KEY, gameId TEXT, username TEXT, password TEXT, createdAt TEXT, UNIQUE(gameId,username));
 CREATE TABLE IF NOT EXISTS teams(id TEXT PRIMARY KEY, gameId TEXT, teamNumber INTEGER, name TEXT, ships INTEGER, cash REAL, investorValuation REAL);
 CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, gameId TEXT, teamId TEXT, orderedYear INTEGER, deliveryYear INTEGER, quantity INTEGER, delivered INTEGER DEFAULT 0);
 CREATE TABLE IF NOT EXISTS bank_bids(serverSequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, gameId TEXT, teamId TEXT, year INTEGER, bidPerShip REAL, submittedAt TEXT, isValid INTEGER, rejectionReason TEXT);
 CREATE TABLE IF NOT EXISTS trade_listings(id TEXT PRIMARY KEY, gameId TEXT, sellerTeamId TEXT, year INTEGER, quantity INTEGER, reservePricePerShip REAL, status TEXT, createdAt TEXT);
 CREATE TABLE IF NOT EXISTS trade_bids(id TEXT PRIMARY KEY, gameId TEXT, listingId TEXT, buyerTeamId TEXT, year INTEGER, bidPerShip REAL, submittedAt TEXT, isValid INTEGER);
 CREATE TABLE IF NOT EXISTS deployments(id TEXT PRIMARY KEY, gameId TEXT, teamId TEXT, year INTEGER, shipsToConstruct INTEGER, shipsHarbor INTEGER, shipsCoastal INTEGER, shipsDeepSea INTEGER, submittedAt TEXT, UNIQUE(gameId,teamId,year));
 CREATE TABLE IF NOT EXISTS round_results(id TEXT PRIMARY KEY, gameId TEXT, year INTEGER, coastalFishStart REAL, deepSeaFishStart REAL, coastalFishEnd REAL, deepSeaFishEnd REAL, coastalCatch REAL, deepSeaCatch REAL, coastalGrowth REAL, deepSeaGrowth REAL, totalShips INTEGER, shipValue REAL);
 CREATE TABLE IF NOT EXISTS team_results(id TEXT PRIMARY KEY, gameId TEXT, teamId TEXT, year INTEGER, catch REAL, revenue REAL, opex REAL, capex REAL, interest REAL, annualProfit REAL, cashEnd REAL, shipsEnd INTEGER, investorValuation REAL);
 CREATE TABLE IF NOT EXISTS valuations(id TEXT PRIMARY KEY, gameId TEXT, year INTEGER, marketImplied REAL, futureCap REAL, floor REAL, validated REAL, createdAt TEXT);
 CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY, gameId TEXT, year INTEGER, phase TEXT, eventType TEXT, payload TEXT, createdAt TEXT);
 CREATE TABLE IF NOT EXISTS chat_messages(id TEXT PRIMARY KEY, gameId TEXT, fromRole TEXT, fromName TEXT, toTeamId TEXT, toTeamName TEXT, message TEXT, createdAt TEXT);`);
}
migrate();
function addCol(t,c,tp){try{db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${tp}`);}catch(e){}}
addCol('team_results','coastalCatch','REAL');
addCol('team_results','deepCatch','REAL');
addCol('team_results','cashStart','REAL');
addCol('team_results','cashBeforeAuction','REAL');
addCol('games','previousPhase','TEXT');
addCol('games','pausedAt','TEXT');
addCol('games','phaseRemainingSeconds','REAL');
addCol('instructors','startDate','TEXT');
addCol('instructors','endDate','TEXT');
// Rename legacy team names to Group 1–10
const OLD_NAMES=['fener','bahce','sari','kanarya','papaz','cayir','aziz','yildirim','sukru','saracoglu'];
const upd=db.prepare('UPDATE teams SET name=? WHERE name=? AND teamNumber=?');
OLD_NAMES.forEach((old,i)=>upd.run(TEAM_NAMES[i],old,i+1));
function gameByCode(code){ return db.prepare('SELECT * FROM games WHERE code=?').get(code); }
function gameById(id){ return db.prepare('SELECT * FROM games WHERE id=?').get(id); }
function teams(gameId){ return db.prepare('SELECT * FROM teams WHERE gameId=? ORDER BY teamNumber').all(gameId); }
function currentHighBid(gameId,year){ return db.prepare('SELECT b.*, t.name teamName FROM bank_bids b JOIN teams t ON t.id=b.teamId WHERE b.gameId=? AND b.year=? AND b.isValid=1 ORDER BY b.bidPerShip DESC, b.serverSequence ASC LIMIT 1').get(gameId,year); }
function audit(game,event,payload={}){ db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?)').run(nanoid(),game.id,game.currentYear,game.phase,event,JSON.stringify(payload),nowIso()); }

// ── Auto-close helpers ──────────────────────────────────────────────────────
function scheduleAutoClose(gameId, phase, seconds){
  if(phaseTimers.has(gameId)) clearTimeout(phaseTimers.get(gameId));
  const t=setTimeout(()=>{
    phaseTimers.delete(gameId);
    const g=gameById(gameId);
    if(!g||g.phase!==phase||g.pausedAt) return;
    if(phase==='AUCTION_TRADE') doCloseAuction(gameId);
    else if(phase==='CONSTRUCTION_DEPLOYMENT') doCloseDeployment(gameId);
  }, (seconds+1)*1000);
  phaseTimers.set(gameId,t);
}

function setPhase(g,phase,seconds){
  const ends=seconds?new Date(Date.now()+seconds*1000).toISOString():null;
  db.prepare('UPDATE games SET phase=?,phaseEndsAt=?,pausedAt=NULL,phaseRemainingSeconds=NULL WHERE id=?').run(phase,ends,g.id);
  audit({...g,phase},'phase_started',{phase,ends});
  if(seconds) scheduleAutoClose(g.id,phase,seconds);
  else if(phaseTimers.has(g.id)){ clearTimeout(phaseTimers.get(g.id)); phaseTimers.delete(g.id); }
  emitGame(g.id);
}

function calculateShipValue(g,marketPrices){
  // Step 1: DCF — average best-zone annual earnings over last 3 years × remaining years
  const completed=db.prepare('SELECT * FROM round_results WHERE gameId=? ORDER BY year DESC LIMIT 3').all(g.id);
  let avgEarnings=0;
  if(completed.length){
    let sum=0;
    for(const row of completed){
      const coastalShips=Math.max(1,row.coastalCatch/Math.max(0.01,cps('coastal',row.coastalFishStart)));
      const deepShips=Math.max(1,row.deepSeaCatch/Math.max(0.01,cps('deep',row.deepSeaFishStart)));
      sum+=Math.max(0,(row.coastalCatch/coastalShips)*20-150,(row.deepSeaCatch/deepShips)*20-250);
    }
    avgEarnings=sum/completed.length;
  } else {
    avgEarnings=Math.max(0,cps('coastal',SETTINGS.coastalInitial)*20-150,cps('deep',SETTINGS.deepInitial)*20-250);
  }
  const dcf=Math.max(0,SETTINGS.maxYears-g.currentYear+1)*avgEarnings;
  // Step 2: pool trade prices from this year and last year to get a 2-year window
  const allPrices=[...marketPrices];
  const lastYearVal=db.prepare('SELECT marketImplied FROM valuations WHERE gameId=? AND year=? AND marketImplied>0').get(g.id,g.currentYear-1);
  if(lastYearVal) allPrices.push(lastYearVal.marketImplied);
  // Step 3: if any trades in the 2-year window, use min(avgTradePrice, DCF); otherwise halve the DCF
  const market=marketPrices.length?marketPrices.reduce((s,p)=>s+p,0)/marketPrices.length:0;
  let validated;
  if(allPrices.length>0){
    const avgTradePrice=allPrices.reduce((s,p)=>s+p,0)/allPrices.length;
    validated=Math.min(avgTradePrice,dcf);
  } else {
    validated=dcf/2;
  }
  validated=Math.max(0,validated);
  db.prepare('INSERT INTO valuations VALUES(?,?,?,?,?,?,?,?)').run(nanoid(),g.id,g.currentYear,market,dcf,0,validated,nowIso());
  db.prepare('UPDATE games SET shipValue=? WHERE id=?').run(validated,g.id);
  return validated;
}

function doCloseAuction(gameId){
  let g=gameById(gameId); if(!g||g.phase!=='AUCTION_TRADE') return;
  const tx=db.transaction(()=>{
    const prices=[]; const high=currentHighBid(g.id,g.currentYear);
    if(high){ const pay=high.bidPerShip*SETTINGS.auctionQty; db.prepare('UPDATE teams SET ships=ships+?,cash=cash-? WHERE id=?').run(SETTINGS.auctionQty,pay,high.teamId); prices.push(high.bidPerShip); audit(g,'bank_auction_cleared',{winner:high.teamName,bid:high.bidPerShip}); }
    const listings=db.prepare(`SELECT * FROM trade_listings WHERE gameId=? AND year=? AND status='OPEN'`).all(g.id,g.currentYear);
    for(const l of listings){ const b=db.prepare('SELECT * FROM trade_bids WHERE listingId=? AND isValid=1 ORDER BY bidPerShip DESC, submittedAt ASC LIMIT 1').get(l.id); if(b){ const pay=b.bidPerShip*l.quantity; db.prepare('UPDATE teams SET ships=ships-?,cash=cash+? WHERE id=?').run(l.quantity,pay,l.sellerTeamId); db.prepare('UPDATE teams SET ships=ships+?,cash=cash-? WHERE id=?').run(l.quantity,pay,b.buyerTeamId); db.prepare('UPDATE trade_listings SET status=? WHERE id=?').run('SOLD',l.id); prices.push(b.bidPerShip); } else db.prepare('UPDATE trade_listings SET status=? WHERE id=?').run('UNSOLD',l.id); }
    g=gameById(g.id); const v=calculateShipValue(g,prices); db.prepare('UPDATE teams SET investorValuation=cash+ships*? WHERE gameId=?').run(v,g.id);
    db.prepare('UPDATE games SET phase=?,phaseEndsAt=?,pausedAt=NULL,phaseRemainingSeconds=NULL WHERE id=?').run('CONSTRUCTION_DEPLOYMENT',new Date(Date.now()+SETTINGS.deploySeconds*1000).toISOString(),g.id);
  }); tx();
  scheduleAutoClose(gameId,'CONSTRUCTION_DEPLOYMENT',SETTINGS.deploySeconds);
  emitGame(gameId);
}

function doCloseDeployment(gameId){
  const g=gameById(gameId); if(!g||g.phase!=='CONSTRUCTION_DEPLOYMENT') return;
  const tx=db.transaction(()=>{
    const teamRows=teams(g.id);
    for(const t of teamRows){
      const updated=db.prepare('SELECT * FROM teams WHERE id=?').get(t.id);
      let dep=db.prepare('SELECT * FROM deployments WHERE gameId=? AND teamId=? AND year=?').get(g.id,t.id,g.currentYear);
      if(!dep){
        // Default: repeat last year's deployment; any new ships go to harbor
        const prevDep=db.prepare('SELECT * FROM deployments WHERE gameId=? AND teamId=? AND year=?').get(g.id,t.id,g.currentYear-1);
        let defCoastal=0, defDeep=0, defHarbor=updated.ships;
        if(prevDep){
          const prevActive=prevDep.shipsCoastal+prevDep.shipsDeepSea;
          if(prevActive<=updated.ships){
            // Ships equal or more than last year — keep same active allocation, harbour the rest
            defCoastal=prevDep.shipsCoastal; defDeep=prevDep.shipsDeepSea; defHarbor=updated.ships-defCoastal-defDeep;
          } else {
            // Fewer ships than last year (sold some) — scale down active allocation proportionally
            const scale=updated.ships/prevActive;
            defCoastal=Math.floor(prevDep.shipsCoastal*scale); defDeep=Math.floor(prevDep.shipsDeepSea*scale); defHarbor=updated.ships-defCoastal-defDeep;
          }
        }
        db.prepare('INSERT INTO deployments VALUES(?,?,?,?,?,?,?,?,?)').run(nanoid(),g.id,t.id,g.currentYear,0,defHarbor,defCoastal,defDeep,nowIso());
      }
    }
    const deps=db.prepare('SELECT d.*,t.cash,t.ships FROM deployments d JOIN teams t ON t.id=d.teamId WHERE d.gameId=? AND d.year=?').all(g.id,g.currentYear);
    const totalCoastal=deps.reduce((s,d)=>s+d.shipsCoastal,0), totalDeep=deps.reduce((s,d)=>s+d.shipsDeepSea,0);
    const cpC=cps('coastal',g.coastalFishStock), cpD=cps('deep',g.deepSeaFishStock);
    const desiredC=totalCoastal*cpC, desiredD=totalDeep*cpD;
    const actualC=Math.min(g.coastalFishStock,desiredC), actualD=Math.min(g.deepSeaFishStock,desiredD);
    const rationC=desiredC?actualC/desiredC:0, rationD=desiredD?actualD/desiredD:0;
    let totalShips=0;
    for(const d of deps){
      const coastalCatch=d.shipsCoastal*cpC*rationC; const deepCatch=d.shipsDeepSea*cpD*rationD; const catchAmt=coastalCatch+deepCatch;
      const revenue=catchAmt*SETTINGS.fishPrice; const opex=d.shipsHarbor*SETTINGS.harborOpex+d.shipsCoastal*SETTINGS.coastalOpex+d.shipsDeepSea*SETTINGS.deepOpex;
      const capex=0; if(d.shipsToConstruct>0) db.prepare('INSERT INTO orders VALUES(?,?,?,?,?,?,0)').run(nanoid(),g.id,d.teamId,g.currentYear,g.currentYear+1,d.shipsToConstruct);
      let cashBefore=d.cash+revenue-opex; const interest=cashBefore>=0?cashBefore*SETTINGS.positiveRate:cashBefore*SETTINGS.negativeRate; const cashEnd=cashBefore+interest;
      const prevResult=db.prepare('SELECT cashEnd FROM team_results WHERE gameId=? AND teamId=? AND year=?').get(g.id,d.teamId,g.currentYear-1); const prevCash=prevResult?prevResult.cashEnd:SETTINGS.initialCash;
      const deliveredQty=db.prepare('SELECT COALESCE(SUM(quantity),0) q FROM orders WHERE teamId=? AND deliveryYear=? AND delivered=1').get(d.teamId,g.currentYear).q; const cashBeforeAuction=prevCash-deliveredQty*SETTINGS.buildCost;
      const investor=cashEnd+d.ships*g.shipValue; db.prepare('UPDATE teams SET cash=?,investorValuation=? WHERE id=?').run(cashEnd,investor,d.teamId);
      db.prepare('INSERT INTO team_results(id,gameId,teamId,year,catch,revenue,opex,capex,interest,annualProfit,cashEnd,shipsEnd,investorValuation,coastalCatch,deepCatch,cashStart,cashBeforeAuction) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(nanoid(),g.id,d.teamId,g.currentYear,catchAmt,revenue,opex,capex,interest,revenue-opex+interest,cashEnd,d.ships,investor,coastalCatch,deepCatch,d.cash,cashBeforeAuction);
      totalShips+=d.ships;
    }
    const postFishC=Math.max(0,g.coastalFishStock-actualC), postFishD=Math.max(0,g.deepSeaFishStock-actualD);
    const grC=growth(postFishC,SETTINGS.coastalK), grD=growth(postFishD,SETTINGS.deepK);
    const endC=Math.min(SETTINGS.coastalK,postFishC+grC), endD=Math.min(SETTINGS.deepK,postFishD+grD);
    db.prepare('INSERT INTO round_results VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(nanoid(),g.id,g.currentYear,g.coastalFishStock,g.deepSeaFishStock,endC,endD,actualC,actualD,grC,grD,totalShips,g.shipValue);
    const nextYear=g.currentYear+1;
    if(nextYear>SETTINGS.maxYears){
      db.prepare('UPDATE games SET coastalFishStock=?,deepSeaFishStock=?,currentYear=?,phase=?,shipValue=0,phaseEndsAt=NULL,pausedAt=NULL,phaseRemainingSeconds=NULL WHERE id=?').run(endC,endD,nextYear,'FINISHED',g.id);
      // Ships have no resale value at end of simulation — valuation = cash only
      for(const t of db.prepare('SELECT * FROM teams WHERE gameId=?').all(g.id)) db.prepare('UPDATE teams SET investorValuation=cash WHERE id=?').run(t.id);
    } else {
      // Deliver frogcatchers ordered for next year
      for(const t of teams(g.id)){
        const qty=db.prepare('SELECT COALESCE(SUM(quantity),0) q FROM orders WHERE teamId=? AND deliveryYear=? AND delivered=0').get(t.id,nextYear).q;
        if(qty>0){ db.prepare('UPDATE teams SET ships=ships+?,cash=cash-? WHERE id=?').run(qty,qty*SETTINGS.buildCost,t.id); db.prepare('UPDATE orders SET delivered=1 WHERE teamId=? AND deliveryYear=?').run(t.id,nextYear); }
      }
      // Refresh investor valuations after delivery
      const sv=g.shipValue||300;
      for(const t of db.prepare('SELECT * FROM teams WHERE gameId=?').all(g.id)) db.prepare('UPDATE teams SET investorValuation=cash+ships*? WHERE id=?').run(sv,t.id);
      // Auto-start next year's auction immediately
      const ends=new Date(Date.now()+SETTINGS.auctionSeconds*1000).toISOString();
      db.prepare('UPDATE games SET coastalFishStock=?,deepSeaFishStock=?,currentYear=?,phase=?,phaseEndsAt=?,pausedAt=NULL,phaseRemainingSeconds=NULL WHERE id=?').run(endC,endD,nextYear,'AUCTION_TRADE',ends,g.id);
    }
  }); tx();
  if(gameById(gameId).phase==='AUCTION_TRADE') scheduleAutoClose(gameId,'AUCTION_TRADE',SETTINGS.auctionSeconds);
  emitGame(gameId);
}

// ── Public state ────────────────────────────────────────────────────────────
app.post('/api/instances',(req,res)=>{ if(!passwordMatches(req.body.password,ADMIN_PASSWORD)) return res.status(401).json({error:'Admin password required'}); const code=String(req.body.code||'CLASS1').toUpperCase(); const name=req.body.name||code; let g=gameByCode(code); if(g) return res.json({id:g.id,code:g.code}); const id=nanoid(); db.prepare('INSERT INTO games(id,code,name,phase,currentYear,coastalFishStock,deepSeaFishStock,shipValue,phaseEndsAt,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,code,name,'SETUP',1,SETTINGS.coastalInitial,SETTINGS.deepInitial,300,null,nowIso()); const ins=db.prepare('INSERT INTO teams VALUES(?,?,?,?,?,?,?)'); for(let i=1;i<=10;i++) ins.run(nanoid(),id,i,TEAM_NAMES[i-1],SETTINGS.initialShips,SETTINGS.initialCash,SETTINGS.initialShips*300+SETTINGS.initialCash); res.json({id,code}); });
app.post('/api/login',(req,res)=>{
  const role=req.body.role;
  // Super-admin login — no game instance needed
  if(role==='superadmin'){
    if(!passwordMatches(req.body.password,SUPERADMIN_PASSWORD)) return res.status(401).json({error:'Bad password'});
    return res.json({token:sign({role:'superadmin'})});
  }
  const g=gameByCode(String(req.body.instanceCode||'').toUpperCase());
  if(!g) return res.status(404).json({error:'Instance not found'});
  if(role==='admin'){
    // Check instructor table first (username + password)
    const uname=String(req.body.username||'').trim();
    if(uname){
      const instr=db.prepare('SELECT * FROM instructors WHERE gameId=? AND username=?').get(g.id,uname);
      if(!instr||req.body.password!==instr.password) return res.status(401).json({error:'Bad instructor credentials'});
      const today=new Date().toISOString().slice(0,10);
      if(instr.startDate&&today<instr.startDate) return res.status(403).json({error:`Access not available until ${instr.startDate}`});
      if(instr.endDate&&today>instr.endDate) return res.status(403).json({error:`Access expired on ${instr.endDate}`});
      return res.json({token:sign({role:'admin',gameId:g.id})});
    }
    // Fall back to master admin password (no username supplied)
    if(!passwordMatches(req.body.password,ADMIN_PASSWORD)) return res.status(401).json({error:'Bad password'});
    return res.json({token:sign({role:'admin',gameId:g.id})});
  }
  const n=Number(String(role||'').split('-')[1]);
  const t=db.prepare('SELECT * FROM teams WHERE gameId=? AND teamNumber=?').get(g.id,n);
  if(!t||req.body.password!==TEAM_PASSWORDS[n-1]) return res.status(401).json({error:'Bad team/password'});
  res.json({token:sign({role:'team',gameId:g.id,teamId:t.id,teamName:t.name})});
});

const LISTING_Q = `SELECT l.*,t.name sellerName,(SELECT MAX(tb.bidPerShip) FROM trade_bids tb WHERE tb.listingId=l.id AND tb.isValid=1) currentBid,(SELECT name FROM teams WHERE id=(SELECT buyerTeamId FROM trade_bids WHERE listingId=l.id AND isValid=1 ORDER BY bidPerShip DESC LIMIT 1)) currentBidder FROM trade_listings l JOIN teams t ON t.id=l.sellerTeamId WHERE l.gameId=? AND l.year=? AND l.status='OPEN'`;

function publicState(user){ const g=gameById(user.gameId);
 const high=currentHighBid(g.id,g.currentYear);
 const teamRows=teams(g.id).map(t=>({...t,cash:Math.round(t.cash),investorValuation:Math.round(t.investorValuation)}));
 const hist=db.prepare('SELECT * FROM round_results WHERE gameId=? ORDER BY year').all(g.id);

 // Listings with live auction data (currentBid, currentBidder, minNextBid)
 const allListings=db.prepare(LISTING_Q).all(g.id,g.currentYear).map(l=>({...l,minNextBid:l.currentBid?l.currentBid+SETTINGS.bidIncrement:l.reservePricePerShip}));
 const listings=allListings.filter(l=>l.sellerTeamId!==user.teamId);
 const myListing=user.role==='team'?allListings.find(l=>l.sellerTeamId===user.teamId)||null:null;

 let team=null;
 if(user.role==='team'){ team=db.prepare('SELECT * FROM teams WHERE id=?').get(user.teamId); const delivered=db.prepare('SELECT COALESCE(SUM(quantity),0) q FROM orders WHERE teamId=? AND deliveryYear=? AND delivered=0').get(user.teamId,g.currentYear).q; team.availableShips=team.ships+delivered; }

 let myResults=[];
 if(user.role==='team'){ myResults=db.prepare('SELECT tr.*,d.shipsCoastal,d.shipsDeepSea,d.shipsHarbor,d.shipsToConstruct FROM team_results tr LEFT JOIN deployments d ON d.gameId=tr.gameId AND d.teamId=tr.teamId AND d.year=tr.year WHERE tr.gameId=? AND tr.teamId=? ORDER BY tr.year').all(g.id,user.teamId); if(myResults.length>0&&myResults[0].cashStart==null){myResults=myResults.map((r,i)=>({...r,cashStart:i===0?SETTINGS.initialCash:myResults[i-1].cashEnd}));} }

 let currentBids=[],auctionHistory=[],tradeHistory=[],currentListings=[];
 if(user.role==='admin'){
   currentBids=db.prepare('SELECT MAX(b.bidPerShip) bidPerShip,t.name teamName FROM bank_bids b JOIN teams t ON t.id=b.teamId WHERE b.gameId=? AND b.year=? AND b.isValid=1 GROUP BY b.teamId ORDER BY bidPerShip DESC').all(g.id,g.currentYear);
   auctionHistory=db.prepare('SELECT b.year,b.bidPerShip,t.name teamName FROM bank_bids b JOIN teams t ON t.id=b.teamId WHERE b.gameId=? AND b.isValid=1 ORDER BY b.year,b.bidPerShip DESC').all(g.id);
   tradeHistory=db.prepare(`SELECT l.year,l.quantity,ts.name sellerName,l.status,(SELECT MAX(tb.bidPerShip) FROM trade_bids tb WHERE tb.listingId=l.id AND tb.isValid=1) winningBid,(SELECT name FROM teams WHERE id=(SELECT buyerTeamId FROM trade_bids WHERE listingId=l.id AND isValid=1 ORDER BY bidPerShip DESC LIMIT 1)) buyerName FROM trade_listings l JOIN teams ts ON ts.id=l.sellerTeamId WHERE l.gameId=? ORDER BY l.year`).all(g.id);
   currentListings=db.prepare(LISTING_Q).all(g.id,g.currentYear).map(l=>({...l,minNextBid:l.currentBid?l.currentBid+SETTINGS.bidIncrement:l.reservePricePerShip}));
 }

 // All teams' historical results — exposed in debrief for charting
 const allTeamResults=['DEBRIEF','FINISHED'].includes(g.phase)?db.prepare('SELECT tr.*,t.name teamName,t.teamNumber FROM team_results tr JOIN teams t ON t.id=tr.teamId WHERE tr.gameId=? ORDER BY tr.year,t.teamNumber').all(g.id):[];

 // Deployment status for admin during CONSTRUCTION_DEPLOYMENT (shows who confirmed)
 let currentDeployments=[];
 if(user.role==='admin'&&g.phase==='CONSTRUCTION_DEPLOYMENT'){
   currentDeployments=db.prepare('SELECT t.id teamId,t.name teamName,t.teamNumber,t.ships,d.shipsHarbor,d.shipsCoastal,d.shipsDeepSea,d.shipsToConstruct,d.submittedAt FROM teams t LEFT JOIN deployments d ON d.teamId=t.id AND d.gameId=? AND d.year=? WHERE t.gameId=? ORDER BY t.teamNumber').all(g.id,g.currentYear,g.id);
 }

 const state={ user:{role:user.role,teamName:user.teamName,teamId:user.teamId||null}, game:{...g,coastalFishStock:(user.role==='admin'||g.phase==='DEBRIEF')?g.coastalFishStock:undefined,deepSeaFishStock:(user.role==='admin'||g.phase==='DEBRIEF')?g.deepSeaFishStock:undefined}, team,teams:teamRows,history:hist,myResults,listings,myListing,currentBids,auctionHistory,tradeHistory,currentListings,allTeamResults,currentDeployments, auction:{reservePrice:reserve(g.currentYear),quantity:SETTINGS.auctionQty,currentHighBidPerShip:high?.bidPerShip||0,currentHighBidderName:high?.teamName||null,minimumNextBidPerShip:high?high.bidPerShip+SETTINGS.bidIncrement:reserve(g.currentYear)} };
 return state;
}
app.get('/api/state',auth,(req,res)=>{ const g=gameById(req.user.gameId); if(!g) return res.status(404).json({error:'Game not found — please log in again'}); res.json(publicState(req.user)); });

// ── Admin controls ───────────────────────────────────────────────────────────
app.post('/api/admin/start',auth,(req,res)=>{ if(req.user.role!=='admin') return res.status(403).json({error:'Admin only'}); const g=gameById(req.user.gameId); if(g.phase==='SETUP'){ const tx=db.transaction(()=>{ for(const t of teams(g.id)){ const qty=db.prepare('SELECT COALESCE(SUM(quantity),0) q FROM orders WHERE teamId=? AND deliveryYear=? AND delivered=0').get(t.id,g.currentYear).q; if(qty>0){ db.prepare('UPDATE teams SET ships=ships+?,cash=cash-? WHERE id=?').run(qty,qty*SETTINGS.buildCost,t.id); db.prepare('UPDATE orders SET delivered=1 WHERE teamId=? AND deliveryYear=?').run(t.id,g.currentYear); } } }); tx(); setPhase(g,'AUCTION_TRADE',SETTINGS.auctionSeconds); } res.json({ok:true}); });

app.post('/api/admin/pause-timer',auth,(req,res)=>{ if(req.user.role!=='admin') return res.status(403).json({error:'Admin only'}); const g=gameById(req.user.gameId); if(!g.phaseEndsAt||g.pausedAt) return res.json({ok:true,paused:!!g.pausedAt}); const remaining=Math.max(0,(new Date(g.phaseEndsAt)-Date.now())/1000); db.prepare('UPDATE games SET pausedAt=?,phaseRemainingSeconds=?,phaseEndsAt=NULL WHERE id=?').run(nowIso(),remaining,g.id); if(phaseTimers.has(g.id)){clearTimeout(phaseTimers.get(g.id));phaseTimers.delete(g.id);} emitGame(g.id); res.json({ok:true}); });

app.post('/api/admin/resume-timer',auth,(req,res)=>{ if(req.user.role!=='admin') return res.status(403).json({error:'Admin only'}); const g=gameById(req.user.gameId); if(!g.pausedAt) return res.json({ok:true}); const remaining=g.phaseRemainingSeconds||0; const newEndsAt=new Date(Date.now()+remaining*1000).toISOString(); db.prepare('UPDATE games SET phaseEndsAt=?,pausedAt=NULL,phaseRemainingSeconds=NULL WHERE id=?').run(newEndsAt,g.id); scheduleAutoClose(g.id,g.phase,remaining); emitGame(g.id); res.json({ok:true}); });

app.post('/api/admin/reset',auth,(req,res)=>{ if(req.user.role!=='admin') return res.status(403).json({error:'Admin only'}); const g=gameById(req.user.gameId); if(phaseTimers.has(g.id)){clearTimeout(phaseTimers.get(g.id));phaseTimers.delete(g.id);} const tx=db.transaction(()=>{ db.prepare('UPDATE games SET phase=?,currentYear=1,coastalFishStock=?,deepSeaFishStock=?,shipValue=300,phaseEndsAt=NULL,pausedAt=NULL,phaseRemainingSeconds=NULL WHERE id=?').run('SETUP',SETTINGS.coastalInitial,SETTINGS.deepInitial,g.id); db.prepare('UPDATE teams SET ships=?,cash=?,investorValuation=? WHERE gameId=?').run(SETTINGS.initialShips,SETTINGS.initialCash,SETTINGS.initialShips*300+SETTINGS.initialCash,g.id); for(const table of ['orders','bank_bids','trade_listings','trade_bids','deployments','round_results','team_results','valuations','audit']) db.prepare(`DELETE FROM ${table} WHERE gameId=?`).run(g.id); }); tx(); emitGame(g.id); res.json({ok:true}); });

app.post('/api/admin/close-auction',auth,(req,res)=>{ if(req.user.role!=='admin') return res.status(403).json({error:'Admin only'}); const g=gameById(req.user.gameId); if(g.phase!=='AUCTION_TRADE') return res.status(400).json({error:'Not auction phase'}); doCloseAuction(g.id); res.json({ok:true}); });
app.post('/api/admin/close-deployment',auth,(req,res)=>{ if(req.user.role!=='admin') return res.status(403).json({error:'Admin only'}); const g=gameById(req.user.gameId); if(g.phase!=='CONSTRUCTION_DEPLOYMENT') return res.status(400).json({error:'Not deployment phase'}); doCloseDeployment(g.id); res.json({ok:true}); });
app.post('/api/admin/debrief',auth,(req,res)=>{ if(req.user.role!=='admin') return res.status(403).json({error:'Admin only'}); const g=gameById(req.user.gameId); db.prepare('UPDATE games SET phase=?,previousPhase=?,phaseEndsAt=NULL,pausedAt=NULL,phaseRemainingSeconds=NULL WHERE id=?').run('DEBRIEF',g.phase,g.id); emitGame(g.id); res.json({ok:true}); });
app.post('/api/admin/exit-debrief',auth,(req,res)=>{ if(req.user.role!=='admin') return res.status(403).json({error:'Admin only'}); const g=gameById(req.user.gameId); if(g.phase!=='DEBRIEF'&&g.phase!=='FINISHED') return res.status(400).json({error:'Not in debrief'}); const restore=g.previousPhase||'FINISHED'; db.prepare('UPDATE games SET phase=?,previousPhase=NULL WHERE id=?').run(restore,g.id); emitGame(g.id); res.json({ok:true}); });
app.get('/api/admin/export',auth,(req,res)=>{ if(req.user.role!=='admin') return res.status(403).send('Admin only'); const g=gameById(req.user.gameId); const rounds=db.prepare('SELECT * FROM round_results WHERE gameId=?').all(g.id); const results=db.prepare('SELECT tr.*,t.name FROM team_results tr JOIN teams t ON t.id=tr.teamId WHERE tr.gameId=?').all(g.id); let csv='RESOURCE_HISTORY\n'+Object.keys(rounds[0]||{}).join(',')+'\n'+rounds.map(r=>Object.values(r).join(',')).join('\n')+'\n\nTEAM_RESULTS\n'+Object.keys(results[0]||{}).join(',')+'\n'+results.map(r=>Object.values(r).join(',')).join('\n'); res.header('Content-Type','text/csv'); res.attachment(`${g.code}-salmonrush-export.csv`); res.send(csv); });

// ── Team actions ─────────────────────────────────────────────────────────────
app.post('/api/team/bank-bid',auth,(req,res)=>{ const g=gameById(req.user.gameId); if(req.user.role!=='team'||g.phase!=='AUCTION_TRADE') return res.status(400).json({error:'Auction not open'}); const bid=Math.max(0,Number(req.body.bidPerShip)); const high=currentHighBid(g.id,g.currentYear); const min=high?high.bidPerShip+SETTINGS.bidIncrement:reserve(g.currentYear); const valid=bid>=min; db.prepare('INSERT INTO bank_bids(id,gameId,teamId,year,bidPerShip,submittedAt,isValid,rejectionReason) VALUES(?,?,?,?,?,?,?,?)').run(nanoid(),g.id,req.user.teamId,g.currentYear,bid,nowIso(),valid?1:0,valid?null:`Minimum bid is ${min}`); if(!valid) return res.status(400).json({error:`Minimum bid is ${min}`}); io.to(g.id).emit('state_changed'); res.json({ok:true}); });
app.post('/api/team/listing',auth,(req,res)=>{ const g=gameById(req.user.gameId); if(req.user.role!=='team'||g.phase!=='AUCTION_TRADE') return res.status(400).json({error:'Trade not open'}); const team=db.prepare('SELECT * FROM teams WHERE id=?').get(req.user.teamId); const q=Math.max(0,Number(req.body.quantity)); if(q>team.ships) return res.status(400).json({error:'Invalid quantity'}); db.prepare(`DELETE FROM trade_listings WHERE gameId=? AND sellerTeamId=? AND year=? AND status='OPEN'`).run(g.id,req.user.teamId,g.currentYear); if(q>0) db.prepare('INSERT INTO trade_listings VALUES(?,?,?,?,?,?,?,?)').run(nanoid(),g.id,req.user.teamId,g.currentYear,q,Math.max(0,Number(req.body.reservePricePerShip)),'OPEN',nowIso()); emitGame(g.id); res.json({ok:true}); });
app.post('/api/team/trade-bid',auth,(req,res)=>{ const g=gameById(req.user.gameId); if(req.user.role!=='team'||g.phase!=='AUCTION_TRADE') return res.status(400).json({error:'Trade not open'}); const l=db.prepare('SELECT * FROM trade_listings WHERE id=?').get(req.body.listingId); if(!l||l.sellerTeamId===req.user.teamId) return res.status(400).json({error:'Invalid listing'}); const bid=Math.max(0,Number(req.body.bidPerShip)); const minBid=l.reservePricePerShip; const curBid=db.prepare('SELECT MAX(bidPerShip) v FROM trade_bids WHERE listingId=? AND isValid=1').get(l.id).v||0; const minNext=curBid?curBid+SETTINGS.bidIncrement:minBid; const valid=bid>=minNext; db.prepare('INSERT INTO trade_bids VALUES(?,?,?,?,?,?,?,?)').run(nanoid(),g.id,l.id,req.user.teamId,g.currentYear,bid,nowIso(),valid?1:0); if(!valid) return res.status(400).json({error:`Minimum bid is $${minNext}/ship`}); emitGame(g.id); res.json({ok:true}); });

app.post('/api/team/deploy',auth,(req,res)=>{
  const g=gameById(req.user.gameId); if(req.user.role!=='team'||g.phase!=='CONSTRUCTION_DEPLOYMENT') return res.status(400).json({error:'Deployment not open'});
  const team=db.prepare('SELECT * FROM teams WHERE id=?').get(req.user.teamId);
  const delivered=db.prepare('SELECT COALESCE(SUM(quantity),0) q FROM orders WHERE teamId=? AND deliveryYear=? AND delivered=0').get(req.user.teamId,g.currentYear).q;
  const avail=team.ships+delivered;
  const h=Math.max(0,Number(req.body.shipsHarbor)),c=Math.max(0,Number(req.body.shipsCoastal)),d=Math.max(0,Number(req.body.shipsDeepSea)),build=Math.max(0,Number(req.body.shipsToConstruct));
  if(h+c+d!==avail) return res.status(400).json({error:`Deployment must sum to ${avail}`});
  const maxBuild=Math.ceil(avail/2);
  if(build>maxBuild) return res.status(400).json({error:`Max ships to order: ${maxBuild} (half your fleet, rounded up)`});
  db.prepare('INSERT OR REPLACE INTO deployments VALUES(?,?,?,?,?,?,?,?,?)').run(nanoid(),g.id,req.user.teamId,g.currentYear,build,h,c,d,nowIso());
  emitGame(g.id); res.json({ok:true});
});

// ── Super-admin routes ───────────────────────────────────────────────────────
app.get('/api/superadmin/sessions',superauth,(req,res)=>{
  const games=db.prepare('SELECT * FROM games ORDER BY createdAt DESC').all();
  res.json(games.map(g=>({
    ...g,
    instructors:db.prepare('SELECT id,username,password,createdAt,startDate,endDate FROM instructors WHERE gameId=? ORDER BY createdAt').all(g.id),
    teamCount:db.prepare('SELECT COUNT(*) c FROM teams WHERE gameId=?').get(g.id).c,
  })));
});

app.post('/api/superadmin/sessions',superauth,(req,res)=>{
  const code=String(req.body.code||'').toUpperCase().trim();
  const name=String(req.body.name||code).trim();
  if(!code) return res.status(400).json({error:'Code is required'});
  let g=gameByCode(code);
  if(g) return res.status(409).json({error:'Session code already exists'});
  const id=nanoid();
  db.prepare('INSERT INTO games(id,code,name,phase,currentYear,coastalFishStock,deepSeaFishStock,shipValue,phaseEndsAt,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,code,name,'SETUP',1,SETTINGS.coastalInitial,SETTINGS.deepInitial,300,null,nowIso());
  const ins=db.prepare('INSERT INTO teams VALUES(?,?,?,?,?,?,?)');
  for(let i=1;i<=10;i++) ins.run(nanoid(),id,i,TEAM_NAMES[i-1],SETTINGS.initialShips,SETTINGS.initialCash,SETTINGS.initialShips*300+SETTINGS.initialCash);
  res.json({id,code,name});
});

app.delete('/api/superadmin/sessions/:id',superauth,(req,res)=>{
  const id=req.params.id;
  if(phaseTimers.has(id)){clearTimeout(phaseTimers.get(id));phaseTimers.delete(id);}
  for(const tbl of ['instructors','teams','orders','bank_bids','trade_listings','trade_bids','deployments','round_results','team_results','valuations','audit','chat_messages'])
    db.prepare(`DELETE FROM ${tbl} WHERE gameId=?`).run(id);
  db.prepare('DELETE FROM games WHERE id=?').run(id);
  res.json({ok:true});
});

app.post('/api/superadmin/instructors',superauth,(req,res)=>{
  const {gameId,username,password,startDate,endDate}=req.body;
  if(!gameId||!username||!password) return res.status(400).json({error:'gameId, username and password are required'});
  if(!gameById(gameId)) return res.status(404).json({error:'Session not found'});
  const sd=startDate||null, ed=endDate||null;
  try{
    db.prepare('INSERT INTO instructors(id,gameId,username,password,createdAt,startDate,endDate) VALUES(?,?,?,?,?,?,?)').run(nanoid(),gameId,String(username).trim(),String(password),nowIso(),sd,ed);
    res.json({ok:true});
  }catch(e){ res.status(409).json({error:'Username already exists for this session'}); }
});

app.delete('/api/superadmin/instructors/:id',superauth,(req,res)=>{
  db.prepare('DELETE FROM instructors WHERE id=?').run(req.params.id);
  res.json({ok:true});
});

// ── Chat ─────────────────────────────────────────────────────────────────────
app.get('/api/chat',auth,(req,res)=>{
  const g=gameById(req.user.gameId); if(!g) return res.status(404).json({error:'Game not found'});
  const msgs=req.user.role==='admin'
    ?db.prepare('SELECT * FROM chat_messages WHERE gameId=? ORDER BY createdAt').all(g.id)
    :db.prepare('SELECT * FROM chat_messages WHERE gameId=? AND (toTeamId IS NULL OR toTeamId=?) ORDER BY createdAt').all(g.id,req.user.teamId);
  res.json(msgs);
});
app.post('/api/chat',auth,(req,res)=>{
  const g=gameById(req.user.gameId); if(!g) return res.status(404).json({error:'Game not found'});
  const message=String(req.body.message||'').trim().slice(0,500); if(!message) return res.status(400).json({error:'Message required'});
  const toTeamId=req.body.toTeamId||null; const toTeamName=req.body.toTeamName||null;
  const fromName=req.user.teamName||(req.user.role==='admin'?'Instructor':req.user.role);
  const id=nanoid(); const createdAt=nowIso();
  db.prepare('INSERT INTO chat_messages VALUES(?,?,?,?,?,?,?,?)').run(id,g.id,req.user.role,fromName,toTeamId,toTeamName,message,createdAt);
  const msg={id,gameId:g.id,fromRole:req.user.role,fromName,toTeamId,toTeamName,message,createdAt};
  if(toTeamId){ io.to(`team:${toTeamId}`).emit('chat_msg',msg); io.to(`admin:${g.id}`).emit('chat_msg',msg); }
  else{ io.to(g.id).emit('chat_msg',msg); }
  res.json({ok:true,id});
});

io.use((socket,next)=>{ try{ socket.user=jwt.verify(socket.handshake.auth.token,JWT_SECRET); next(); }catch(e){ next(new Error('unauthorized')); }});
io.on('connection',s=>{
  s.join(s.user.gameId);
  if(s.user.teamId) s.join(`team:${s.user.teamId}`);
  if(s.user.role==='admin') s.join(`admin:${s.user.gameId}`);
});
const __filename=fileURLToPath(import.meta.url); const __dirname=path.dirname(__filename); const dist=path.join(__dirname,'../dist'); app.use(express.static(dist)); app.get(/\/.*/,(req,res,next)=>{ if(req.path.startsWith('/api')) return next(); res.sendFile(path.join(dist,'index.html'),err=>err&&res.status(404).send('Build frontend first with npm run build')); });
app.get("/api/health",(_req,res)=>res.json({ok:true, dbPath:DB_PATH, dbDir}));
httpServer.listen(PORT,()=>console.log(`SalmonRush backend listening on ${PORT}`));
