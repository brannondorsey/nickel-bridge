import React from 'react';
/* Bottom tabs — Besley caps, inset 3px ink top bar marks the active tab. */
export function TabBar({tabs=['CROSSINGS','STATS','RANKINGS'], active='CROSSINGS', onSelect, style}) {
  return (
    <div style={{display:'flex', borderTop:'1px solid var(--ink,#141414)', fontFamily:'Besley,serif', fontWeight:700, fontSize:9.5, letterSpacing:'.16em', textAlign:'center', background:'var(--paper,#FCFBF8)', ...style}}>
      {tabs.map(t=>(
        <div key={t} onClick={()=>onSelect && onSelect(t)} style={{flex:1, padding:'13px 0', cursor:'pointer', color:t===active?'var(--ink,#141414)':'var(--muted,#6E6A62)', boxShadow:t===active?'inset 0 3px 0 var(--ink,#141414)':'none'}}>{t}</div>
      ))}
    </div>
  );
}