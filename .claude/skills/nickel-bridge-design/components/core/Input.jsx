import React from 'react';
export function Input({label, value, defaultValue, placeholder, onChange, type='text', style}) {
  return (
    <label style={{display:'flex', flexDirection:'column', gap:6, ...style}}>
      {label ? <span style={{fontFamily:'Besley,serif', fontWeight:700, fontSize:10, letterSpacing:'.2em', color:'var(--muted,#6E6A62)', textTransform:'uppercase'}}>{label}</span> : null}
      <input type={type} value={value} defaultValue={defaultValue} placeholder={placeholder} onChange={onChange}
        style={{fontFamily:'"Crimson Pro",serif', fontSize:16, color:'var(--ink,#141414)', background:'var(--panel,#fff)', border:'1px solid var(--ink,#141414)', borderRadius:0, padding:'10px 12px', outline:'none', boxSizing:'border-box', width:'100%'}}/>
    </label>
  );
}