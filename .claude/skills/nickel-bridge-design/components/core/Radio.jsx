import React from 'react';
export function Radio({options=[], value, defaultValue, onChange, style}) {
  const [val, setVal] = React.useState(defaultValue);
  const cur = value!==undefined ? value : val;
  return (
    <div style={{display:'flex', flexDirection:'column', gap:8, ...style}}>
      {options.map(o=>(
        <label key={o} onClick={()=>{ if(value===undefined) setVal(o); onChange && onChange(o); }} style={{display:'inline-flex', alignItems:'center', gap:10, cursor:'pointer'}}>
          <span style={{width:18, height:18, borderRadius:'50%', border:'1.5px solid var(--ink,#141414)', display:'inline-flex', alignItems:'center', justifyContent:'center', boxSizing:'border-box'}}>{cur===o ? <span style={{width:9, height:9, borderRadius:'50%', background:'var(--ink,#141414)'}}/> : null}</span>
          <span style={{fontFamily:'"Crimson Pro",serif', fontSize:15, color:'var(--ink,#141414)'}}>{o}</span>
        </label>
      ))}
    </div>
  );
}