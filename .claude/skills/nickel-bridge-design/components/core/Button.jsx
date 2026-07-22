import React from 'react';
/* Josefin Sans 600 tracked caps — the action voice (approved 8d/9b; Besley caps
   stay the static-label voice). Trailing arrow supplied by caller. Josefin's
   baseline sits high, so bottom padding is deliberately ~3px less than top on
   both variants — do not equalize. */
export function Button({children, variant='primary', disabled=false, onClick, style}) {
  const base = {display:'block', width:'100%', textAlign:'center', fontFamily:"'Josefin Sans',sans-serif", fontWeight:600, textTransform:'uppercase', borderRadius:2, cursor:disabled?'default':'pointer', boxSizing:'border-box', opacity:disabled?0.4:1, userSelect:'none'};
  const kind = variant==='primary'
    ? {background:'var(--ink,#141414)', color:'#fff', fontSize:12.5, letterSpacing:'.22em', padding:'14px 12px 11px', border:'none'}
    : {background:'var(--panel,#fff)', color:'var(--ink,#141414)', fontSize:11, letterSpacing:'.18em', padding:'11px 12px 9px', border:'1px solid var(--ink,#141414)'};
  return <div role="button" aria-disabled={disabled} onClick={disabled?undefined:onClick} style={{...base, ...kind, ...style}}>{children}</div>;
}
