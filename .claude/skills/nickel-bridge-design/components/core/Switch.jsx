import React from 'react';
export function Switch({label, checked, defaultChecked, onChange, style}) {
  const [on, setOn] = React.useState(!!defaultChecked);
  const isOn = checked!==undefined ? checked : on;
  return (
    <label onClick={()=>{ if(checked===undefined) setOn(!on); onChange && onChange(!isOn); }} style={{display:'inline-flex', alignItems:'center', gap:10, cursor:'pointer', ...style}}>
      <span style={{width:38, height:20, border:'1.5px solid var(--ink,#141414)', background:isOn?'var(--ink,#141414)':'var(--panel,#fff)', position:'relative', boxSizing:'border-box', transition:'background .15s'}}>
        <span style={{position:'absolute', top:2, left:isOn?19:2, width:13, height:13, background:isOn?'#fff':'var(--ink,#141414)', transition:'left .15s'}}/>
      </span>
      <span style={{fontFamily:'"Crimson Pro",serif', fontSize:15, color:'var(--ink,#141414)'}}>{label}</span>
    </label>
  );
}