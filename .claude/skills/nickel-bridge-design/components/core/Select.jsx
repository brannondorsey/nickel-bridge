import React from 'react';
export function Select({label, value, defaultValue, onChange, options=[], style}) {
  return (
    <label style={{display:'flex', flexDirection:'column', gap:6, ...style}}>
      {label ? <span style={{fontFamily:'Besley,serif', fontWeight:700, fontSize:10, letterSpacing:'.2em', color:'var(--muted,#6E6A62)', textTransform:'uppercase'}}>{label}</span> : null}
      <select value={value} defaultValue={defaultValue} onChange={onChange}
        style={{fontFamily:'"Crimson Pro",serif', fontSize:16, color:'var(--ink,#141414)', background:'var(--panel,#fff)', border:'1px solid var(--ink,#141414)', borderRadius:0, padding:'10px 12px', outline:'none', appearance:'none', backgroundImage:'linear-gradient(45deg,transparent 50%,#141414 50%),linear-gradient(135deg,#141414 50%,transparent 50%)', backgroundPosition:'calc(100% - 18px) 50%,calc(100% - 12px) 50%', backgroundSize:'6px 6px', backgroundRepeat:'no-repeat'}}>
        {options.map(o=><option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}