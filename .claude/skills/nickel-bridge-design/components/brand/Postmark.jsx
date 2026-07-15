import React from 'react';
/* Circular postmark + wave cancel (approved 3b). Result screens only. */
export function Postmark({arcTop='NICKEL BRIDGE', arcBottom='BOARD 2 · TOLL PAID', line1='SCORED', line2='JUL 13 1926', size=104, style}) {
  const l1fs = String(line1).length > 6 ? 12 : 13;
  const id = React.useId ? React.useId().replace(/[:]/g,'') : Math.random().toString(36).slice(2);
  return (
    <div style={{display:'flex', alignItems:'center', transform:'rotate(-4deg)', WebkitMaskImage:'linear-gradient(100deg,#000 50%,rgba(0,0,0,.4) 100%)', maskImage:'linear-gradient(100deg,#000 50%,rgba(0,0,0,.4) 100%)', ...style}}>
      <svg width={size} height={size} viewBox="0 0 104 104">
        <circle cx="52" cy="52" r="49" fill="none" stroke="var(--ink,#141414)" strokeWidth="3"/>
        <circle cx="52" cy="52" r="36" fill="none" stroke="var(--ink,#141414)" strokeWidth="1.5"/>
        <defs><path id={'pmT'+id} d="M 14 52 A 38 38 0 0 1 90 52"/><path id={'pmB'+id} d="M 12 52 A 40 40 0 0 0 92 52"/></defs>
        <text fontFamily='"Josefin Sans",sans-serif' fontWeight="600" fontSize="10.5" letterSpacing="2.5" fill="var(--ink,#141414)"><textPath href={'#pmT'+id} startOffset="50%" textAnchor="middle">{arcTop}</textPath></text>
        <text fontFamily='"Josefin Sans",sans-serif' fontWeight="600" fontSize="8.5" letterSpacing="2" fill="var(--ink,#141414)"><textPath href={'#pmB'+id} startOffset="50%" textAnchor="middle">{arcBottom}</textPath></text>
        <text x="52" y="49" textAnchor="middle" fontFamily='"Josefin Sans",sans-serif' fontWeight="600" fontSize={l1fs} letterSpacing="1" fill="var(--ink,#141414)">{line1}</text>
        <text x="52" y="63" textAnchor="middle" fontFamily='"Crimson Pro",serif' fontSize="10" fill="var(--ink,#141414)">{line2}</text>
      </svg>
      <svg width={Math.round(size*0.62)} height={Math.round(size*0.58)} viewBox="0 0 64 60" style={{marginLeft:-8}}>
        <g stroke="var(--ink,#141414)" strokeWidth="2.5" fill="none"><path d="M0 8 Q16 2 32 8 T64 8"/><path d="M0 22 Q16 16 32 22 T64 22"/><path d="M0 36 Q16 30 32 36 T64 36"/><path d="M0 50 Q16 44 32 50 T64 50"/></g>
      </svg>
    </div>
  );
}