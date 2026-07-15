import React from 'react';
/* Bottom sheet over a scrim — matches the approved call-inspector treatment. */
export function Dialog({open=true, title, onClose, children, footer, style}) {
  if (!open) return null;
  return (
    <div style={{position:'absolute', inset:0, zIndex:10}}>
      <div onClick={onClose} style={{position:'absolute', inset:0, background:'rgba(20,20,20,.34)'}}/>
      <div style={{position:'absolute', left:0, right:0, bottom:0, background:'#fff', borderTop:'2px solid var(--ink,#141414)', padding:'10px 16px 18px', ...style}}>
        <div style={{width:40, height:4, background:'var(--line,#D8D5CE)', borderRadius:2, margin:'0 auto 12px'}}/>
        <div style={{display:'flex', alignItems:'baseline', justifyContent:'space-between'}}>
          <div style={{fontFamily:'Besley,serif', fontWeight:800, fontSize:19, color:'var(--ink,#141414)'}}>{title}</div>
          <div onClick={onClose} style={{fontFamily:'Besley,serif', fontWeight:700, fontSize:16, color:'var(--muted,#6E6A62)', cursor:'pointer'}}>✕</div>
        </div>
        <div style={{fontFamily:'"Crimson Pro",serif', color:'var(--ink,#141414)'}}>{children}</div>
        {footer}
      </div>
    </div>
  );
}