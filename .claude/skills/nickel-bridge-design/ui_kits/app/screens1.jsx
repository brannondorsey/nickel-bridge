import React from 'react';
import { AppHeader, ScreenHeader } from '../../components/navigation/AppHeader.jsx';
import { TabBar } from '../../components/navigation/TabBar.jsx';
import { Button } from '../../components/core/Button.jsx';
import { Chip } from '../../components/core/Chip.jsx';
import { TicketStub } from '../../components/brand/TicketStub.jsx';
import { FlipDigits } from '../../components/brand/FlipDigits.jsx';
import { InkStamp } from '../../components/brand/InkStamp.jsx';
import { Postmark } from '../../components/brand/Postmark.jsx';
import { PerforatedPanel } from '../../components/brand/PerforatedPanel.jsx';
import { BridgeMark } from '../../components/brand/BridgeMark.jsx';
import { PlayingCard } from '../../components/game/PlayingCard.jsx';
import { StarGrade } from '../../components/game/StarGrade.jsx';
const LBL = {fontFamily:'Besley,serif', fontWeight:700, fontSize:10, letterSpacing:'.2em', color:'var(--muted)'};
const SCREEN = {width:390, background:'var(--paper)', fontFamily:'"Crimson Pro",serif', color:'var(--ink)', display:'flex', flexDirection:'column', minHeight:620, position:'relative'};
const NUM = {fontVariantNumeric:'tabular-nums'};

export function HomeScreen({go}) {
  const gateRow = (n, main, sub, stamp, dashed) => (
    <div style={{border:dashed?'1px dashed var(--line-dashed)':'1.5px solid var(--ink)', background:dashed?'transparent':'#fff', display:'flex', alignItems:'stretch', color:dashed?'var(--muted)':'var(--ink)', boxShadow:dashed?'none':'var(--ticket-shadow)'}}>
      <div style={{width:74, borderRight:'2px dashed '+(dashed?'var(--line-dashed)':'var(--ink)'), display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'10px 0'}}>
        <span style={{fontFamily:'Besley,serif', fontWeight:700, fontSize:9, letterSpacing:'.18em', color:'var(--muted)'}}>TOURNEY</span>
        <span style={{fontFamily:'Besley,serif', fontWeight:800, fontSize:22}}>{n}</span>
      </div>
      <div style={{flex:1, padding:'10px 12px', display:'flex', alignItems:'center', gap:10}}>
        {sub ? <div style={{flex:1}}><div style={{fontWeight:600, fontSize:15}}>{main}</div><div style={{fontSize:12.5, color:'var(--muted)'}}>{sub}</div></div>
             : <div style={{fontSize:14, fontStyle:'italic'}}>{main}</div>}
        {stamp}
      </div>
    </div>
  );
  return (
    <div style={SCREEN} data-screen-label="Home">
      <AppHeader/>
      <div style={{padding:'20px 16px 0'}}>
        <div style={{fontWeight:600, fontSize:21}}>Good evening, Margaret</div>
        <div style={{fontSize:14.5, color:'var(--muted)', marginTop:2}}>The bridge is open.</div>
      </div>
      <div style={{margin:'16px 16px 0', background:'var(--surface)', border:'1px solid var(--surface-line)', padding:'16px 14px', display:'flex', flexDirection:'column', gap:12}}>
        <div style={{display:'flex', alignItems:'center', gap:12}}>
          <TicketStub label="OPEN NOW" value="4 boards" width={132}/>
          <div style={{flex:1, fontSize:14.5, lineHeight:1.45}}>Tournament #12<br/><span style={{color:'var(--muted)', fontSize:13}}>Board 2 of 4 in progress — your call</span></div>
        </div>
        <Button onClick={()=>go && go('sheet')}>KEEP GOING →</Button>
      </div>
      <div style={{padding:'14px 16px 0', display:'flex', flexDirection:'column', gap:10}}>
        {gateRow('13','Opens when you finish #12 — one crossing at a time',null,null,true)}
      </div>
      <div style={{padding:'20px 16px 0'}}>
        <div style={LBL}>TOLLS PAID</div>
        <PerforatedPanel padding="2px 14px 2px 20px" style={{marginTop:10}}>
          <div style={{display:'grid', gridTemplateColumns:'auto 1fr auto auto', gap:'0 12px', fontSize:14.5, ...NUM, alignItems:'center'}}>
            {[['11','Jul 9 · 14 pairs','54%','6TH','var(--muted)'],['10','Jul 6 · 11 pairs','63%','1ST','var(--positive)'],['9','Jul 2 · 16 pairs','47%','9TH','var(--muted)'],['8','Jun 28 · 12 pairs','59%','3RD','var(--positive)']].map(([n,d,p,r,c],i,arr)=>{
              const bb = i<arr.length-1 ? '1px solid var(--line-quiet)' : 'none';
              return [
                <b key={n+'a'} style={{fontFamily:'Besley,serif', fontSize:12, padding:'10px 0'}}>{n}</b>,
                <div key={n+'b'} style={{padding:'10px 0', borderBottom:bb}}>{d}</div>,
                <b key={n+'c'} style={{padding:'10px 0', borderBottom:bb}}>{p}</b>,
                <span key={n+'d'} style={{fontFamily:'Besley,serif', fontWeight:700, fontSize:11, color:c, padding:'10px 0', borderBottom:bb}}>{r}</span>
              ];
            })}
          </div>
        </PerforatedPanel>
        <div style={{fontSize:12.5, color:'var(--muted)', marginTop:10, fontStyle:'italic', textAlign:'center'}}>Every crossing since June — tap a row for its postmark.</div>
      </div>
      <div style={{marginTop:'auto'}}><TabBar active="CROSSINGS" onSelect={t=>go && go(t)}/></div>
    </div>
  );
}

export function RankingsScreen({go}) {
  const rows = [['1','Alice Whitmore','1642','▲2','var(--positive)'],['2','Henry Chu','1601','▼1','var(--negative)'],['3','Dot Pemberton','1583','▼1','var(--negative)'],['4','Sam Okafor','1540','—','var(--muted)'],['5','Margaret — you','1487','▲3','var(--positive)',1],['6','Ruth Adler','1466','▼2','var(--negative)'],['7','Leo Marsh','1421','—','var(--muted)']];
  return (
    <div style={SCREEN} data-screen-label="Rankings">
      <AppHeader context="RANKINGS"/>
      <div style={{padding:'18px 16px 0', display:'flex', alignItems:'baseline', justifyContent:'space-between'}}>
        <div style={{fontWeight:600, fontSize:19}}>The field</div>
        <div style={{...LBL, letterSpacing:'.16em'}}>ALL-TIME · 54 PLAYERS</div>
      </div>
      <PerforatedPanel padding="6px 14px 6px 20px" style={{margin:'12px 16px 0'}}>
        <div style={{display:'grid', gridTemplateColumns:'auto 1fr auto auto', gap:'0 12px', fontSize:14.5, ...NUM, alignItems:'center'}}>
          {rows.map(([n,name,elo,d,c,you],i)=>{
            const bb = i<rows.length-1 ? '1px solid var(--line-quiet)' : 'none';
            const hl = you ? {background:'var(--surface)'} : {};
            return [
              <b key={n+'a'} style={{fontFamily:'Besley,serif', fontSize:12, padding:'9px 0', ...hl, ...(you?{marginLeft:-6, paddingLeft:6}:{})}}>{n}</b>,
              <div key={n+'b'} style={{padding:'9px 0', borderBottom:you?'none':bb, fontWeight:you?600:400, ...hl, ...(you?{margin:'0 -12px', paddingLeft:12, paddingRight:12}:{})}}>{name}</div>,
              <b key={n+'c'} style={{padding:'9px 0', borderBottom:you?'none':bb, ...hl, ...(you?{margin:'0 -4px', paddingLeft:4, paddingRight:4}:{})}}>{elo}</b>,
              <span key={n+'d'} style={{fontFamily:'Besley,serif', fontWeight:700, fontSize:11, color:c, padding:'9px 0', borderBottom:you?'none':bb, ...hl, ...(you?{marginRight:-6, paddingRight:6}:{})}}>{d}</span>
            ];
          })}
        </div>
      </PerforatedPanel>
      <div style={{margin:'12px 16px 0', background:'var(--surface)', border:'1px solid var(--surface-line)', padding:'12px 14px', display:'flex', alignItems:'center', gap:12}}>
        <BridgeMark width={34}/>
        <div style={{fontSize:13.5, lineHeight:1.45}}>Rankings update after every game played on the site. <span style={{color:'var(--muted)'}}>54 players crossed this week.</span></div>
      </div>
      <div style={{marginTop:'auto'}}><TabBar active="RANKINGS" onSelect={t=>go && go(t)}/></div>
    </div>
  );
}

export function StatsScreen({go}) {
  const bar = (pct) => (
    <div style={{height:8, background:'var(--chart-track)', position:'relative'}}><div style={{position:'absolute', inset:0, right:(100-pct)+'%', background:'var(--ink)'}}/></div>
  );
  return (
    <div style={SCREEN} data-screen-label="Stats">
      <AppHeader context="STATS"/>
      <div style={{display:'flex', flexDirection:'column', alignItems:'center', padding:'20px 16px 0'}}>
        <FlipDigits value="1487" suffix="" size={46}/>
        <div style={{display:'flex', alignItems:'baseline', gap:8, marginTop:8}}>
          <span style={{...LBL, letterSpacing:'.18em'}}>NICKEL RATING</span>
          <span style={{fontFamily:'Besley,serif', fontWeight:700, fontSize:12, color:'var(--positive)'}}>+34 THIS MONTH</span>
        </div>
      </div>
      <div style={{margin:'16px 16px 0', border:'1px solid var(--ink)', background:'#fff', padding:14}}>
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:10}}>
          <span style={{...LBL, letterSpacing:'.16em'}}>MATCHPOINTS — LAST 10 TOURNAMENTS</span>
          <span style={{fontFamily:'Besley,serif', fontWeight:800, fontSize:14, ...NUM}}>Ø 57%</span>
        </div>
        <svg width="100%" height="86" viewBox="0 0 326 86" preserveAspectRatio="none">
          <line x1="0" y1="14" x2="326" y2="14" stroke="var(--line)" strokeWidth="1" strokeDasharray="3 4"/>
          <line x1="0" y1="44" x2="326" y2="44" stroke="var(--accent)" strokeWidth="1.5" strokeDasharray="5 4"/>
          <line x1="0" y1="76" x2="326" y2="76" stroke="var(--line)" strokeWidth="1"/>
          <polyline points="6,66 41,54 76,60 111,38 146,46 181,30 216,42 251,24 286,34 320,22" fill="none" stroke="var(--ink)" strokeWidth="2.5"/>
          <circle cx="320" cy="22" r="3.5" fill="var(--ink)"/>
        </svg>
        <div style={{display:'flex', justifyContent:'space-between', fontFamily:'Besley,serif', fontSize:9.5, color:'var(--muted)', marginTop:4}}>
          <span>10 tournaments ago</span><span style={{color:'var(--accent)'}}>- - field average 50%</span><span>latest</span>
        </div>
      </div>
      <PerforatedPanel heading="BIDDING — 214 CALLS GRADED" style={{margin:'12px 16px 0'}}>
        <div style={{display:'grid', gridTemplateColumns:'auto 1fr auto', gap:'7px 12px', fontSize:13.5, alignItems:'center', ...NUM}}>
          <StarGrade stars={3}/>{bar(64)}<b>64%</b>
          <StarGrade stars={2}/>{bar(27)}<b>27%</b>
          <StarGrade stars={1}/>{bar(9)}<b>9%</b>
        </div>
        <div style={{fontSize:12.5, color:'var(--muted)', marginTop:10, fontStyle:'italic'}}>Most-missed call: invitational raises after 1NT rebids.</div>
      </PerforatedPanel>
      <div style={{margin:'12px 16px 0', display:'flex', gap:10}}>
        {[['DECLARING','61%','88 boards'],['DEFENDING','52%','126 boards']].map(([l,v,s])=>(
          <div key={l} style={{flex:1, border:'1px solid var(--ink)', background:'#fff', padding:'12px 14px'}}>
            <div style={{...LBL, fontSize:9.5, letterSpacing:'.16em'}}>{l}</div>
            <div style={{fontFamily:'Besley,serif', fontWeight:800, fontSize:21, ...NUM, marginTop:4}}>{v}</div>
            <div style={{fontSize:12, color:'var(--muted)'}}>{s}</div>
          </div>
        ))}
      </div>
      <div style={{marginTop:'auto'}}><TabBar active="STATS" onSelect={t=>go && go(t)}/></div>
    </div>
  );
}
