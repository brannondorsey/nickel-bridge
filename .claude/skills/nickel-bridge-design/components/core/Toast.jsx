import React from 'react';
/* Ticket-style toast; slides up from the bottom. */
export function Toast({children, stamp, open=true, style}) {
  if (!open) return null;
  return (
    <div style={{display:'flex', alignItems:'center', gap:12, background:'#fff', border:'1.5px solid var(--ink,#141414)', boxShadow:'3px 3px 0 rgba(20,20,20,.12)', padding:'10px 14px', position:'relative', ...style}}>
      <div style={{position:'absolute', left:7, top:0, bottom:0, borderLeft:'1.5px dashed var(--ink,#141414)'}}/>
      <div style={{fontFamily:'"Crimson Pro",serif', fontSize:14.5, color:'var(--ink,#141414)', paddingLeft:8, flex:1}}>{children}</div>
      {stamp}
    </div>
  );
}