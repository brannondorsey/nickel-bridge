import React from 'react';
export function Checkbox({label, checked, defaultChecked, onChange, style}) {
  const [on, setOn] = React.useState(!!defaultChecked);
  const isOn = checked!==undefined ? checked : on;
  return (
    <label onClick={()=>{ if(checked===undefined) setOn(!on); onChange && onChange(!isOn); }} style={{display:'inline-flex', alignItems:'center', gap:10, cursor:'pointer', ...style}}>
      <span style={{width:18, height:18, border:'1.5px solid var(--ink,#141414)', background:isOn?'var(--ink,#141414)':'var(--panel,#fff)', display:'inline-flex', alignItems:'center', justifyContent:'center', color:'#fff', fontSize:12, fontWeight:700, boxSizing:'border-box'}}>{isOn?'✓':''}</span>
      <span style={{fontFamily:'"Crimson Pro",serif', fontSize:15, color:'var(--ink,#141414)'}}>{label}</span>
    </label>
  );
}