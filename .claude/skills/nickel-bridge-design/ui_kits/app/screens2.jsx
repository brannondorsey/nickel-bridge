import React from 'react';
import { ScreenHeader } from '../../components/navigation/AppHeader.jsx';
import { Button } from '../../components/core/Button.jsx';
import { Chip } from '../../components/core/Chip.jsx';
import { Dialog } from '../../components/core/Dialog.jsx';
import { TicketStub } from '../../components/brand/TicketStub.jsx';
import { FlipDigits } from '../../components/brand/FlipDigits.jsx';
import { InkStamp } from '../../components/brand/InkStamp.jsx';
import { Postmark } from '../../components/brand/Postmark.jsx';
import { PerforatedPanel } from '../../components/brand/PerforatedPanel.jsx';
const LBL = {fontFamily:'Besley,serif', fontWeight:700, fontSize:10, letterSpacing:'.2em', color:'var(--muted)'};
const SCREEN = {width:390, background:'var(--paper)', fontFamily:'"Crimson Pro",serif', color:'var(--ink)', display:'flex', flexDirection:'column', minHeight:620, position:'relative'};
const NUM = {fontVariantNumeric:'tabular-nums'};

function BoardRow({n, main, sub, stamp, state}) {
  const sealed = state==='sealed', live = state==='live';
  const border = sealed ? '1px dashed var(--line-dashed)' : (live ? '1.5px solid var(--ink)' : '1px solid var(--ink)');
  return (
    <div style={{border, background:sealed?'transparent':'#fff', display:'flex', alignItems:'stretch', color:sealed?'var(--muted)':'var(--ink)', boxShadow:live?'var(--ticket-shadow)':'none'}}>
      <div style={{width:74, borderRight:'2px dashed '+(sealed?'var(--line-dashed)':'var(--ink)'), display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'10px 0'}}>
        <span style={{fontFamily:'Besley,serif', fontWeight:700, fontSize:9, letterSpacing:'.18em', color:'var(--muted)'}}>BOARD</span>
        <span style={{fontFamily:'Besley,serif', fontWeight:800, fontSize:22}}>{n}</span>
      </div>
      <div style={{flex:1, padding:'10px 12px', display:'flex', alignItems:'center', gap:10}}>
        {sub ? <div style={{flex:1}}><div style={{fontWeight:600, fontSize:15}}>{main}</div><div style={{fontSize:12.5, color:'var(--muted)', ...NUM}}>{sub}</div></div>
             : <div style={{fontSize:14, fontStyle:'italic'}}>{main}</div>}
        {stamp}
      </div>
    </div>
  );
}

export function TournamentSheetScreen({go}) {
  return (
    <div style={SCREEN} data-screen-label="Tournament sheet">
      <ScreenHeader title="Tournament #12" caption="12 pairs · matchpoints" onBack={()=>go && go('HOME')}/>
      <div style={{padding:'14px 16px 0', display:'flex', flexDirection:'column', gap:10}}>
        <BoardRow n="1" main="4♠= by S · +620" sub="58% matchpoints" state="scored" stamp={<InkStamp size={10} rotate={-5}>SCORED</InkStamp>}/>
        <BoardRow n="2" main="Bidding — your call" sub="Dealer N · NS vul" state="live" stamp={<InkStamp color="var(--suit-h)" rotate={3} fade="left" size={10}>LIVE</InkStamp>}/>
        <BoardRow n="3" main="Sealed — deals when board 2 is scored" state="sealed"/>
        <BoardRow n="4" main="Sealed" state="sealed"/>
      </div>
      <PerforatedPanel heading="THE FIELD — AFTER BOARD 1" style={{margin:'14px 16px 0'}}>
        <div style={{display:'grid', gridTemplateColumns:'auto 1fr auto', gap:'6px 12px', fontSize:14, ...NUM, alignItems:'baseline'}}>
          <b style={{fontFamily:'Besley,serif', fontSize:12}}>1</b><div>Alice</div><b>83%</b>
          <b style={{fontFamily:'Besley,serif', fontSize:12, background:'var(--surface)', margin:'0 -4px', padding:'0 4px'}}>2</b>
          <div style={{fontWeight:600, background:'var(--surface)', margin:'0 -12px', padding:'0 12px'}}>You</div>
          <b style={{background:'var(--surface)', margin:'0 -4px', padding:'0 4px'}}>58%</b>
          <b style={{fontFamily:'Besley,serif', fontSize:12}}>3</b><div>Bob</div><b>33%</b>
        </div>
      </PerforatedPanel>
      <div style={{padding:'14px 16px 18px', marginTop:'auto'}}><Button onClick={()=>go && go('board')}>CONTINUE BOARD 2 →</Button></div>
    </div>
  );
}

export function CallInspectorScreen({go}) {
  return (
    <div style={{...SCREEN, height:620, overflow:'hidden'}} data-screen-label="Call inspector">
      <div style={{padding:12, filter:'grayscale(.2)'}}>
        <div style={{border:'1px solid var(--ink)', padding:2}}><div style={{border:'1px solid var(--ink)', padding:'10px 12px 12px', fontFamily:'Besley,serif'}}>
          <div style={{display:'grid', gridTemplateColumns:'repeat(4,1fr)', textAlign:'center', fontSize:10.5, fontWeight:700, letterSpacing:'.14em', color:'var(--muted)', paddingBottom:6, borderBottom:'1px solid var(--line)'}}>
            <div>N</div><div>E</div><div style={{color:'var(--ink)'}}>S ★</div><div>W</div>
          </div>
          <div style={{display:'grid', gridTemplateColumns:'repeat(4,1fr)', textAlign:'center', fontSize:15, fontWeight:600, rowGap:7, paddingTop:8, ...NUM}}>
            <div style={{color:'var(--muted)'}}>—</div><div style={{color:'var(--muted)'}}>—</div>
            <div style={{borderBottom:'2px dotted var(--ink)', justifySelf:'center', padding:'0 5px'}}>1<span style={{color:'var(--suit-h)'}}>♥</span></div><div>Pass</div>
            <div style={{outline:'2px solid var(--ink)', outlineOffset:3, justifySelf:'center', padding:'0 5px', fontWeight:800}}>1NT</div><div>Pass</div>
            <div style={{color:'var(--muted)'}}>?</div><div></div>
          </div>
        </div></div>
      </div>
      <Dialog title="1NT — partner's response" onClose={()=>go && go('sheet')}>
        <div style={{display:'flex', gap:6, margin:'10px 0 12px', flexWrap:'wrap'}}>
          <Chip>6–9 HCP</Chip><Chip>NO 4-CARD MAJOR TO BID</Chip><Chip quiet>DENIES 3 HEARTS</Chip>
        </div>
        <div style={{fontSize:15, lineHeight:1.5}}>A catch-all response: partner has enough to keep the auction open but cannot raise hearts or bid a suit at the one level. Not a balanced-hand promise — this is SAYC's "I have something, but nothing to say."</div>
        <PerforatedPanel heading="WHAT YOU KNOW ABOUT PARTNER" style={{marginTop:14, background:'var(--paper)'}} padding="10px 12px 10px 18px">
          <div style={{fontSize:13.5, lineHeight:1.7}}>6–9 points, fewer than three hearts<br/>No four spades — would have bid 1♠<br/>Minors still unknown</div>
        </PerforatedPanel>
        <div style={{fontSize:12.5, color:'var(--muted)', marginTop:12, fontStyle:'italic'}}>With 3+ hearts and 6–9, partner raises to 2<span style={{color:'var(--suit-h)'}}>♥</span> instead.</div>
      </Dialog>
    </div>
  );
}

export function TournamentResultScreen({go}) {
  const bar = (pct) => <div style={{width:52, height:6, background:'var(--chart-track)', position:'relative'}}><div style={{position:'absolute', inset:0, right:(100-pct)+'%', background:'var(--ink)'}}/></div>;
  return (
    <div style={SCREEN} data-screen-label="Tournament result">
      <ScreenHeader title="Tournament #12" caption="Complete · 12 pairs"/>
      <div style={{display:'flex', flexDirection:'column', alignItems:'center', padding:'22px 16px 0'}}>
        <Postmark size={118} arcBottom="TOURNAMENT Nº12" line1="TOLL PAID" line2="JUL 13 1926"/>
        <div style={{marginTop:16}}><FlipDigits value="61" suffix="%" size={54}/></div>
        <div style={{fontFamily:'Besley,serif', fontSize:11, fontWeight:700, letterSpacing:'.16em', color:'var(--muted)', marginTop:8}}>MATCHPOINTS · 2ND OF 12 PAIRS</div>
        <div style={{display:'flex', alignItems:'baseline', gap:8, marginTop:10}}>
          <span style={{...LBL, letterSpacing:'.18em'}}>NICKEL RATING</span>
          <span style={{fontFamily:'Besley,serif', fontWeight:800, fontSize:16, ...NUM}}>1487</span>
          <span style={{fontFamily:'Besley,serif', fontWeight:700, fontSize:13, color:'var(--positive)'}}>+12</span>
        </div>
      </div>
      <PerforatedPanel heading="BOARD BY BOARD" style={{margin:'16px 16px 0'}}>
        <div style={{display:'grid', gridTemplateColumns:'auto 1fr auto auto', gap:'7px 12px', fontSize:13.5, ...NUM, alignItems:'center'}}>
          {[['1','4♠= by S','+620',58],['2','3NT+1 by N','+630',74],['3','2♥−1 by S','−100',41],['4','4♥= by W','−420',71]].map(([n,c,s,p])=>[
            <b key={n+'a'} style={{fontFamily:'Besley,serif', fontSize:12}}>{n}</b>,
            <div key={n+'b'}>{c}</div>,
            <div key={n+'c'} style={{color:'var(--muted)'}}>{s}</div>,
            <div key={n+'d'} style={{display:'flex', alignItems:'center', gap:6}}>{bar(p)}<b>{p}</b></div>
          ])}
        </div>
      </PerforatedPanel>
      <div style={{padding:'16px 16px 18px', display:'flex', flexDirection:'column', gap:8, marginTop:'auto'}}>
        <Button onClick={()=>go && go('HOME')}>BACK TO THE BRIDGE →</Button>
        <Button variant="secondary">Review the boards</Button>
      </div>
    </div>
  );
}

/* Intro: splash (6c) pays the toll, crosses into Home — approved 7a sequence, coin removed. */
export function SplashIntro({onDone, riverSrc='../../assets/bridge-river-scene.svg', children}) {
  const [k, setK] = React.useState(0);
  React.useEffect(()=>{ const t = setTimeout(()=>onDone && onDone(), 3300); return ()=>clearTimeout(t); }, [k]);
  return (
    <div style={{width:390, height:620, background:'var(--paper)', position:'relative', overflow:'hidden'}} data-screen-label="Splash intro">
      <style>{'@keyframes nbWordIn{from{opacity:0;letter-spacing:.34em}to{opacity:1;letter-spacing:.16em}}@keyframes nbSubIn{from{opacity:0}to{opacity:1}}@keyframes nbBridgeRise{from{transform:translateY(150px)}to{transform:translateY(0)}}@keyframes nbSplashOut{to{opacity:0;transform:translateY(-26px)}}@keyframes nbBridgeOut{to{transform:translateY(170px)}}@keyframes nbHomeIn{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}'}</style>
      <div key={'s'+k} style={{position:'absolute', inset:0, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:24, paddingBottom:130, animation:'nbSplashOut .55s ease-in 2.1s forwards'}}>
        <div style={{textAlign:'center'}}>
          <div style={{fontFamily:'"Poiret One",cursive', fontSize:32, letterSpacing:'.16em', color:'var(--ink)', animation:'nbWordIn .9s ease-out both'}}>NICKEL BRIDGE</div>
          <div style={{fontFamily:'Besley,serif', fontSize:10.5, letterSpacing:'.42em', color:'var(--ink)', marginTop:6, animation:'nbSubIn .6s ease-out .5s both'}}>DUPLICATE · SAYC</div>
        </div>
        <div style={{width:280, background:'var(--ink)', color:'#fff', textAlign:'center', fontFamily:'Besley,serif', fontWeight:800, fontSize:15, letterSpacing:'.06em', padding:13, borderRadius:2, animation:'nbSubIn .6s ease-out .8s both'}}>PLAY THE TOLL →</div>
      </div>
      <div key={'b'+k} style={{position:'absolute', bottom:0, left:0, width:390, height:146, animation:'nbBridgeRise .9s cubic-bezier(.2,.7,.2,1) both, nbBridgeOut .6s ease-in 2.1s forwards'}}>
        <img src={riverSrc} width="390" height="146" style={{display:'block', objectFit:'cover', objectPosition:'bottom'}} alt=""/>
      </div>
      <div key={'h'+k} style={{position:'absolute', inset:0, animation:'nbHomeIn .7s cubic-bezier(.2,.7,.2,1) 2.45s both'}}>
        {children}
      </div>
      <div onClick={()=>setK(k+1)} style={{position:'absolute', right:8, top:8, zIndex:20, cursor:'pointer', border:'1px solid var(--line)', borderRadius:4, padding:'4px 10px', font:'600 11px system-ui,sans-serif', color:'var(--muted)', background:'rgba(255,255,255,.85)'}}>↻</div>
    </div>
  );
}
