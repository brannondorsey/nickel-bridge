import React from 'react';
/* Perforated panel (approved 1n) — the base "card"; dashed tear line inside the left edge. */
export function PerforatedPanel({children, heading, dashed=false, padding='12px 14px 12px 20px', style}) {
  const border = dashed ? '1px dashed var(--line-dashed,#B9B4A9)' : '1px solid var(--ink,#141414)';
  return (
    <div style={{border, background:'var(--panel,#fff)', position:'relative', padding, color:dashed?'var(--muted)':undefined, ...style}}>
      <div style={{position:'absolute', left:7, top:0, bottom:0, borderLeft:'1.5px dashed '+(dashed?'var(--line-dashed,#B9B4A9)':'var(--ink,#141414)')}}/>
      {heading ? <div style={{fontFamily:'Besley,serif', fontWeight:700, fontSize:10, letterSpacing:'.16em', color:'var(--muted,#6E6A62)', marginBottom:8}}>{heading}</div> : null}
      {children}
    </div>
  );
}