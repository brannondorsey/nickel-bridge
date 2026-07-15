import React from 'react';
/* Primary = ink slab, Besley 800 tracked caps, trailing arrow supplied by caller. */
export function Button({children, variant='primary', disabled=false, onClick, style}) {
  const base = {display:'block', width:'100%', textAlign:'center', fontFamily:'Besley,serif', letterSpacing:'.06em', borderRadius:2, cursor:disabled?'default':'pointer', boxSizing:'border-box', opacity:disabled?0.4:1, userSelect:'none'};
  const kind = variant==='primary'
    ? {background:'var(--ink,#141414)', color:'#fff', fontWeight:800, fontSize:15, padding:13, border:'none'}
    : {background:'var(--panel,#fff)', color:'var(--ink,#141414)', fontWeight:700, fontSize:13, padding:11, border:'1px solid var(--ink,#141414)'};
  return <div role="button" aria-disabled={disabled} onClick={disabled?undefined:onClick} style={{...base, ...kind, ...style}}>{children}</div>;
}