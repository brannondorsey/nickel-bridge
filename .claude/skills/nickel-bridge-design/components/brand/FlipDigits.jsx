import React from 'react';
/* Flip-digit numerals (approved 1m) — turnstile counter for hero numbers only. */
export function FlipDigits({value='58', suffix='%', size=44, style}) {
  const w = Math.round(size*30/44), fs = Math.round(size*26/44), sfs = Math.round(size*22/44);
  const cell = {width:w, height:size, fontFamily:'Besley,serif', fontWeight:800, display:'flex', alignItems:'center', justifyContent:'center', borderRadius:3, position:'relative', overflow:'hidden'};
  return (
    <div style={{display:'flex', gap:3, ...style}}>
      {String(value).split('').map((ch,i)=>(
        <div key={i} style={{...cell, background:'var(--ink,#141414)', color:'#fff', fontSize:fs}}>
          {ch}
          <div style={{position:'absolute', left:0, right:0, top:'50%', height:1.5, background:'rgba(255,255,255,.35)'}}/>
        </div>
      ))}
      {suffix ? <div style={{...cell, background:'#fff', color:'var(--ink,#141414)', border:'2px solid var(--ink,#141414)', fontSize:sfs, boxSizing:'border-box'}}>{suffix}</div> : null}
    </div>
  );
}