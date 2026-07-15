import React from 'react';
import { BridgeMark } from '../brand/BridgeMark.jsx';
/* Top chrome: glyph + Poiret wordmark, right-side tracked-caps context. */
export function AppHeader({context='DUPLICATE · SAYC', showMark=true, style}) {
  return (
    <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', padding:'14px 16px', borderBottom:'1px solid var(--ink,#141414)', background:'var(--paper,#FCFBF8)', ...style}}>
      <div style={{display:'flex', alignItems:'center', gap:9}}>
        {showMark ? <BridgeMark width={26}/> : null}
        <span style={{fontFamily:'"Poiret One",cursive', fontSize:17, letterSpacing:'.14em', color:'var(--ink,#141414)'}}>NICKEL BRIDGE</span>
      </div>
      <span style={{fontFamily:'Besley,serif', fontSize:8.5, letterSpacing:'.3em', color:'var(--muted,#6E6A62)'}}>{context}</span>
    </div>
  );
}
/* Sub-screen header: back chevron + Besley title, right-side caption. */
export function ScreenHeader({title, caption, onBack, style}) {
  return (
    <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', padding:'12px 16px', borderBottom:'1px solid var(--ink,#141414)', background:'var(--paper,#FCFBF8)', ...style}}>
      <div style={{display:'flex', alignItems:'baseline', gap:10}}>
        {onBack ? <span onClick={onBack} style={{fontFamily:'Besley,serif', fontWeight:700, fontSize:14, cursor:'pointer'}}>‹</span> : null}
        <span style={{fontFamily:'Besley,serif', fontWeight:700, fontSize:13.5, color:'var(--ink,#141414)'}}>{title}</span>
      </div>
      <span style={{fontFamily:'"Crimson Pro",serif', fontSize:12.5, color:'var(--muted,#6E6A62)'}}>{caption}</span>
    </div>
  );
}