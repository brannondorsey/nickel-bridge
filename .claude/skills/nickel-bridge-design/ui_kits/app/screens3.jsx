import React from 'react';
import { Button } from '../../components/core/Button.jsx';
import { Chip } from '../../components/core/Chip.jsx';
import { InkStamp } from '../../components/brand/InkStamp.jsx';
import { FlipDigits } from '../../components/brand/FlipDigits.jsx';
import { PerforatedPanel } from '../../components/brand/PerforatedPanel.jsx';
import { PlayingCard } from '../../components/game/PlayingCard.jsx';
import { StarGrade } from '../../components/game/StarGrade.jsx';
const NUM = {fontVariantNumeric:'tabular-nums'};
const SCREEN = {width:390, background:'var(--paper)', fontFamily:'Besley,serif', color:'var(--ink)', display:'flex', flexDirection:'column', position:'relative'};
const SUIT = {S:'var(--suit-s)',H:'var(--suit-h)',D:'var(--suit-d)',C:'var(--suit-c)'};
const Sym = ({s,dim}) => s==='NT'||!s ? null : <span style={{color:dim||SUIT[s]}}>{{S:'♠',H:'♥',D:'♦',C:'♣'}[s]}</span>;
function Fan({cards, size=66}) {
  return (
    <div style={{display:'flex', justifyContent:'center', alignItems:'flex-end', padding:'0 8px'}}>
      {cards.map((c,i)=>{
        const prev = cards[i-1];
        const ml = i===0 ? 0 : (prev && prev.suit!==c.suit ? -Math.round(size*20/66) : -Math.round(size*26/66));
        return <PlayingCard key={i} rank={c.r} suit={c.suit} size={size} dimmed={c.dim} selected={c.sel} style={{marginLeft:ml}}/>;
      })}
    </div>
  );
}
function HCP({n, style}) { return <span style={{background:'var(--ink)', color:'#fff', fontWeight:800, fontSize:12, padding:'2px 9px', borderRadius:3, ...NUM, ...style}}>{n} HCP</span>; }
function SeatLabel({children, style}) { return <span style={{fontSize:11, fontWeight:700, letterSpacing:'.14em', color:'var(--muted)', ...style}}>{children}</span>; }

export function BoardBiddingScreen({go}) {
  const hand = [{r:'A',suit:'S'},{r:'Q',suit:'S'},{r:'10',suit:'S'},{r:'K',suit:'H'},{r:'J',suit:'H'},{r:'9',suit:'H'},{r:'6',suit:'H'},{r:'3',suit:'H'},{r:'8',suit:'D'},{r:'2',suit:'D'},{r:'Q',suit:'C'},{r:'9',suit:'C'},{r:'5',suit:'C'}];
  const bids = [];
  for (let lvl=1; lvl<=4; lvl++) for (const s of ['C','D','H','S','NT']) bids.push({lvl, s});
  const isDisabled = (b) => b.lvl<2 || (b.lvl===2 && ['C','D'].includes(b.s));
  const isSel = (b) => b.lvl===2 && b.s==='H';
  return (
    <div style={SCREEN} data-screen-label="Board — bidding">
      <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', padding:'12px 16px 10px', borderBottom:'1px solid var(--ink)'}}>
        <div style={{fontFamily:'"Poiret One",cursive', fontSize:15, letterSpacing:'.14em'}}>NICKEL BRIDGE</div>
        <div style={{display:'flex', gap:14, fontSize:12, fontWeight:600}}><span>Stats</span><span>Rankings</span></div>
      </div>
      <div style={{display:'flex', alignItems:'center', gap:10, padding:'10px 16px', borderBottom:'1px solid var(--line)'}}>
        <svg width="92" height="34" viewBox="0 0 92 34"><rect x="1.5" y="1.5" width="89" height="31" fill="#fff" stroke="var(--ink)" strokeWidth="2.5"/><line x1="64" y1="1" x2="64" y2="33" stroke="var(--ink)" strokeWidth="1.5" strokeDasharray="2.5 4"/><text x="8" y="13" fontFamily="Besley,serif" fontWeight="700" fontSize="7.5" letterSpacing="1.5" fill="var(--ink)">BOARD</text><text x="8" y="27" fontFamily="Besley,serif" fontWeight="800" fontSize="13" fill="var(--ink)">2 of 4</text><text x="82" y="8" fontFamily="Besley,serif" fontWeight="700" fontSize="6" letterSpacing="1" fill="var(--ink)" transform="rotate(90 82 8)">ADMIT</text></svg>
        <div style={{flex:1, minWidth:0}}><div style={{fontWeight:700, fontSize:13.5, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis'}}>Tournament #12</div><div style={{fontSize:12, color:'var(--muted)'}}>Dealer N</div></div>
        <Chip color="var(--suit-h)" style={{fontWeight:800, fontSize:10.5, letterSpacing:'.12em', border:'1.5px solid var(--suit-h)'}}>NS VUL</Chip>
      </div>
      <div style={{margin:'12px 12px 0', border:'1px solid var(--ink)', padding:2}}><div style={{border:'1px solid var(--ink)', padding:'10px 12px 12px'}}>
        <div style={{display:'grid', gridTemplateColumns:'repeat(4,1fr)', textAlign:'center', fontSize:10.5, fontWeight:700, letterSpacing:'.14em', color:'var(--muted)', paddingBottom:6, borderBottom:'1px solid var(--line)'}}>
          <div>N</div><div>E</div><div style={{color:'var(--ink)'}}>S ★</div><div>W</div>
        </div>
        <div style={{display:'grid', gridTemplateColumns:'repeat(4,1fr)', textAlign:'center', fontSize:15, fontWeight:600, rowGap:7, paddingTop:8, ...NUM}}>
          <div style={{color:'var(--muted)'}}>—</div><div style={{color:'var(--muted)'}}>—</div>
          <div style={{borderBottom:'2px dotted var(--ink)', justifySelf:'center', padding:'0 5px'}}>1<Sym s="H"/></div><div>Pass</div>
          <div style={{borderBottom:'2px dotted var(--ink)', justifySelf:'center', padding:'0 5px'}}>1NT</div><div>Pass</div>
          <div style={{outline:'1.5px solid var(--ink)', outlineOffset:2, justifySelf:'center', padding:'0 5px', fontWeight:800}}>?</div><div></div>
        </div>
        <div style={{fontSize:10.5, color:'var(--muted)', textAlign:'center', marginTop:9, letterSpacing:'.06em'}}>dotted = has a SAYC meaning · tap any call to inspect</div>
      </div></div>
      <PerforatedPanel style={{margin:'10px 12px 0'}} padding="11px 14px 12px 20px">
        <div style={{fontWeight:800, fontSize:14.5}}>Your 2<Sym s="H"/> — Rebid, invitational</div>
        <div style={{display:'flex', gap:6, margin:'6px 0 7px'}}><Chip style={{padding:'2px 7px'}}>10–12 HCP</Chip><Chip quiet style={{padding:'2px 7px'}}>6+ hearts</Chip></div>
        <div style={{fontSize:13.5, lineHeight:1.5, fontWeight:400}}>Shows a long heart suit worth rebidding and invitational values opposite partner's 1NT. Partner passes with a minimum.</div>
      </PerforatedPanel>
      <div style={{paddingTop:14}}><Fan cards={hand}/></div>
      <div style={{display:'flex', justifyContent:'center', alignItems:'center', gap:8, marginTop:8}}>
        <SeatLabel>SOUTH — YOU</SeatLabel><HCP n={12}/>
      </div>
      <div style={{padding:'12px 12px 0'}}>
        <div style={{display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:5, ...NUM}}>
          {bids.map((b,i)=>{
            const sel = isSel(b), dis = isDisabled(b);
            return (
              <div key={i} style={{border:sel?'none':'1px solid '+(dis?'var(--line)':'var(--ink)'), background:sel?'var(--ink)':'#fff', color:sel?'#fff':'var(--ink)', minHeight:44, display:'flex', alignItems:'center', justifyContent:'center', fontWeight:sel?800:700, fontSize:16, opacity:dis?.25:1, borderRadius:2}}>
                {b.lvl}{b.s==='NT'?'NT':<Sym s={b.s} dim={sel&&b.s==='H'?'#FF9D94':undefined}/>}
              </div>
            );
          })}
        </div>
        <div style={{textAlign:'center', fontSize:11, color:'var(--muted)', padding:'6px 0 2px', letterSpacing:'.08em'}}>▾ levels 5–7 below the fold ▾</div>
        <div style={{display:'grid', gridTemplateColumns:'2fr 1fr 1fr', gap:5, marginTop:2}}>
          <div style={{border:'1px solid var(--ink)', background:'#fff', minHeight:44, display:'flex', alignItems:'center', justifyContent:'center', fontWeight:700, fontSize:15, borderRadius:2}}>Pass</div>
          <div style={{border:'1px solid var(--ink)', background:'#fff', minHeight:44, display:'flex', alignItems:'center', justifyContent:'center', fontWeight:700, fontSize:15, borderRadius:2, color:'var(--suit-h)'}}>X</div>
          <div style={{border:'1px solid var(--line)', background:'#fff', minHeight:44, display:'flex', alignItems:'center', justifyContent:'center', fontWeight:700, fontSize:15, opacity:.25, borderRadius:2}}>XX</div>
        </div>
      </div>
      <div style={{padding:'12px 12px 16px'}}><Button onClick={()=>go && go('play')} style={{fontSize:17, padding:14}}>BID 2♥ →</Button></div>
    </div>
  );
}

export function BoardPlayScreen({go}) {
  const dummy = [{r:'K',suit:'S'},{r:'J',suit:'S'},{r:'4',suit:'S'},{r:'8',suit:'H',dim:1},{r:'2',suit:'H',dim:1},{r:'A',suit:'D',dim:1},{r:'Q',suit:'D',dim:1},{r:'7',suit:'D',dim:1},{r:'K',suit:'C',dim:1},{r:'8',suit:'C',dim:1}];
  const hand = [{r:'A',suit:'S'},{r:'Q',suit:'S',sel:1},{r:'10',suit:'S'},{r:'6',suit:'S'},{r:'K',suit:'H',dim:1},{r:'J',suit:'H',dim:1},{r:'8',suit:'D',dim:1},{r:'Q',suit:'C',dim:1},{r:'5',suit:'C',dim:1}];
  const seat = (label, card, pos) => (
    <div style={{position:'absolute', ...pos, display:'flex', flexDirection:'column', alignItems:'center', gap:3}}>
      <SeatLabel style={{fontSize:10, letterSpacing:'.12em'}}>{label}</SeatLabel>
      {card}
    </div>
  );
  return (
    <div style={SCREEN} data-screen-label="Board — card play">
      <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', padding:'10px 16px', borderBottom:'1px solid var(--ink)'}}>
        <div style={{display:'flex', alignItems:'baseline', gap:10}}><span style={{fontWeight:700, fontSize:13.5}}>Tournament #12</span><span style={{fontSize:12, color:'var(--muted)'}}>Board 2/4</span></div>
        <div style={{display:'flex', alignItems:'center', gap:8}}><span style={{fontWeight:800, fontSize:14}}>4♠ by S</span><Chip color="var(--suit-h)" style={{fontWeight:800, fontSize:10, letterSpacing:'.1em', border:'1.5px solid var(--suit-h)', padding:'2px 6px'}}>NS VUL</Chip></div>
      </div>
      <div style={{display:'flex', justifyContent:'center', alignItems:'center', gap:8, padding:'12px 0 2px'}}>
        <SeatLabel>NORTH — DUMMY</SeatLabel><HCP n={10}/>
      </div>
      <div style={{padding:'6px 0 0'}}><Fan cards={dummy} size={58}/></div>
      <div style={{textAlign:'center', fontSize:10.5, color:'var(--muted)', padding:'2px 0 6px', letterSpacing:'.06em'}}>spades are live — you must follow suit</div>
      <div style={{margin:'4px 12px 0', border:'1px solid var(--ink)', background:'var(--paper)', position:'relative', height:230}}>
        {seat('N · DUMMY', <PlayingCard rank="4" suit="S" size={52}/>, {top:10, left:'50%', transform:'translateX(-50%)'})}
        {seat('E', <PlayingCard rank="9" suit="H" size={52}/>, {right:14, top:'50%', transform:'translateY(-50%)'})}
        {seat('W', <PlayingCard rank="Q" suit="H" size={52}/>, {left:14, top:'50%', transform:'translateY(-50%)'})}
        <div style={{position:'absolute', bottom:10, left:'50%', transform:'translateX(-50%)', display:'flex', flexDirection:'column', alignItems:'center', gap:3}}>
          <PlayingCard placeholder size={52}/>
          <SeatLabel style={{fontSize:10, fontWeight:800, color:'var(--ink)'}}>S · DECL — YOU</SeatLabel>
        </div>
        <div style={{position:'absolute', top:'50%', left:'50%', transform:'translate(-50%,-50%)', textAlign:'center'}}>
          <div style={{display:'flex', gap:2, justifyContent:'center'}}>
            <div style={{width:22, height:32, background:'var(--ink)', color:'#fff', fontWeight:800, fontSize:17, display:'flex', alignItems:'center', justifyContent:'center', borderRadius:2}}>3</div>
            <div style={{width:22, height:32, background:'#fff', border:'1.5px solid var(--ink)', fontWeight:800, fontSize:15, display:'flex', alignItems:'center', justifyContent:'center', borderRadius:2, boxSizing:'border-box'}}>1</div>
          </div>
          <div style={{fontSize:9.5, fontWeight:700, letterSpacing:'.1em', color:'var(--muted)', marginTop:4}}>DECL · DEF<br/>TRICK 5 OF 13</div>
        </div>
      </div>
      <div style={{paddingTop:12}}><Fan cards={hand}/></div>
      <div style={{display:'flex', justifyContent:'center', alignItems:'center', gap:8, padding:'8px 0 6px'}}>
        <SeatLabel style={{color:'var(--ink)'}}>SOUTH — YOU · YOUR TURN</SeatLabel><HCP n={12}/>
      </div>
      <div onClick={()=>go && go('result')} style={{textAlign:'center', fontStyle:'italic', fontSize:13, color:'var(--muted)', padding:'0 0 16px', cursor:'pointer'}}>Q♠ selected — tap again to play</div>
    </div>
  );
}

export function BoardResultScreen({go}) {
  const bar = (pct) => <div style={{width:56, height:6, background:'var(--chart-track)', position:'relative'}}><div style={{position:'absolute', inset:0, right:(100-pct)+'%', background:'var(--ink)'}}/></div>;
  const hand = (label, cards, strong) => (
    <div style={{border:strong?'1.5px solid var(--ink)':'1px solid var(--line)', padding:'6px 8px'}}>
      <b style={{fontSize:10, letterSpacing:'.1em', color:strong?'var(--ink)':'var(--muted)'}}>{label}</b><br/>
      <span>♠ {cards[0]}</span><br/><span style={{color:'var(--suit-h)'}}>♥ {cards[1]}</span><br/><span style={{color:'var(--suit-d)'}}>♦ {cards[2]}</span><br/><span style={{color:'var(--suit-c)'}}>♣ {cards[3]}</span>
    </div>
  );
  return (
    <div style={SCREEN} data-screen-label="Board — result">
      <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', padding:'10px 16px', borderBottom:'1px solid var(--ink)'}}>
        <div style={{display:'flex', alignItems:'baseline', gap:10}}><span style={{fontWeight:700, fontSize:13.5}}>Tournament #12</span><span style={{fontSize:12, color:'var(--muted)'}}>Board 2/4</span></div>
        <div style={{border:'2px solid var(--ink)', borderRadius:5, padding:'2px 9px', transform:'rotate(-4deg)'}}><span style={{fontWeight:800, fontSize:11, letterSpacing:'.18em'}}>SCORED</span></div>
      </div>
      <div style={{textAlign:'center', padding:'20px 16px 6px'}}>
        <div style={{fontWeight:800, fontSize:23}}>4♠= by S</div>
        <div style={{fontSize:13.5, color:'var(--muted)', marginTop:2, fontWeight:400}}>+620 for N–S · NS vul</div>
        <div style={{display:'flex', justifyContent:'center', marginTop:14}}>
          <FlipDigits value="58" suffix="%" size={54}/>
        </div>
        <div style={{fontSize:11, fontWeight:700, letterSpacing:'.16em', color:'var(--muted)', marginTop:8}}>MATCHPOINTS · VS 3 OTHER PLAYERS · BIDDING 89%</div>
      </div>
      <PerforatedPanel heading="THE FIELD — BOARD 2" style={{margin:'14px 12px 0'}}>
        <div style={{display:'grid', gridTemplateColumns:'1fr auto auto', gap:'6px 14px', fontSize:13, ...NUM, alignItems:'center', fontWeight:400}}>
          <div>Alice</div><div style={{color:'var(--muted)'}}>4♠+1 · +650</div><div style={{display:'flex', alignItems:'center', gap:6, justifyContent:'flex-end'}}>{bar(83)}<b>83</b></div>
          <div style={{fontWeight:800, background:'var(--surface)', margin:'0 -6px', padding:'2px 6px'}}>You</div><div style={{color:'var(--muted)', background:'var(--surface)', margin:'0 -14px', padding:'2px 14px'}}>4♠= · +620</div><div style={{display:'flex', alignItems:'center', gap:6, justifyContent:'flex-end', background:'var(--surface)', margin:'0 -6px', padding:'2px 6px'}}>{bar(58)}<b>58</b></div>
          <div>Bob</div><div style={{color:'var(--muted)'}}>3♠+1 · +170</div><div style={{display:'flex', alignItems:'center', gap:6, justifyContent:'flex-end'}}>{bar(33)}<b>33</b></div>
          <div>Cara</div><div style={{color:'var(--muted)'}}>4♠−1 · −100</div><div style={{display:'flex', alignItems:'center', gap:6, justifyContent:'flex-end'}}>{bar(8)}<b>8</b></div>
        </div>
      </PerforatedPanel>
      <div style={{margin:'12px 12px 0', border:'1px solid var(--ink)', background:'#fff', padding:14}}>
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:10}}>
          <span style={{fontWeight:700, fontSize:11, letterSpacing:'.16em', color:'var(--muted)'}}>THE DEAL</span>
          <span style={{fontSize:11, color:'var(--muted)', fontWeight:400}}>Dealer N · NS vul</span>
        </div>
        <div style={{display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:4, fontSize:11.5, lineHeight:1.55, ...NUM, fontWeight:400}}>
          <div></div>{hand('NORTH · DUMMY',['K J 4','8 2','A Q 7 4','K 8 6 3'])}<div></div>
          {hand('WEST',['8 3','Q 10 7 5','K J 9','J 10 7 2'])}
          <div style={{display:'flex', alignItems:'center', justifyContent:'center'}}>
            <svg width="48" height="48" viewBox="0 0 48 48"><line x1="24" y1="14" x2="24" y2="34" stroke="var(--line)" strokeWidth="1.5"/><line x1="14" y1="24" x2="34" y2="24" stroke="var(--line)" strokeWidth="1.5"/><text x="24" y="10" textAnchor="middle" fontFamily="Besley,serif" fontWeight="700" fontSize="10" fill="var(--ink)">N</text><text x="24" y="45" textAnchor="middle" fontFamily="Besley,serif" fontSize="10" fill="var(--muted)">S</text><text x="7" y="27.5" textAnchor="middle" fontFamily="Besley,serif" fontSize="10" fill="var(--muted)">W</text><text x="41" y="27.5" textAnchor="middle" fontFamily="Besley,serif" fontSize="10" fill="var(--muted)">E</text></svg>
          </div>
          {hand('EAST',['9 7 5 2','A 9 4','10 6 5 3','A 4'])}
          <div></div>{hand('SOUTH · YOU',['A Q 10 6','K J 6 3','8 2','Q 9 5'], true)}<div></div>
        </div>
      </div>
      <div style={{margin:'12px 12px 0', border:'1px solid var(--ink)', background:'#fff', padding:14}}>
        <div style={{fontWeight:700, fontSize:11, letterSpacing:'.16em', color:'var(--muted)', marginBottom:8}}>YOUR BIDDING</div>
        <div style={{display:'flex', flexDirection:'column', gap:7, fontSize:13, fontWeight:400}}>
          <div style={{display:'flex', alignItems:'baseline', gap:10}}><b style={{minWidth:38}}>1<Sym s="H"/></b><StarGrade stars={3}/><span>Excellent</span></div>
          <div style={{display:'flex', alignItems:'baseline', gap:10}}><b style={{minWidth:38}}>2<Sym s="H"/></b><StarGrade stars={2}/><span>Good — AI preferred 3<Sym s="H"/></span></div>
          <div style={{display:'flex', alignItems:'baseline', gap:10}}><b style={{minWidth:38}}>4♠</b><StarGrade stars={3}/><span>Excellent — the AI's choice too</span></div>
        </div>
      </div>
      <div style={{padding:'14px 12px 18px', display:'flex', flexDirection:'column', gap:8}}>
        <Button onClick={()=>go && go('sheet')} style={{fontSize:16, padding:14}}>NEXT BOARD — 3 OF 4 →</Button>
        <Button variant="secondary" onClick={()=>go && go('HOME')}>Back to lobby</Button>
      </div>
    </div>
  );
}
