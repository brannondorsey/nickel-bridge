import React from 'react';
/* Oval ink stamp (approved treatment for statuses). Rotation + ink-fade mask are mandatory. */
export function InkStamp({children='SCORED', color='var(--ink)', rotate=-5, fade='right', size=10, style}) {
  const mask = fade==='left'
    ? 'linear-gradient(75deg,rgba(0,0,0,.55) 0%,#000 45%)'
    : 'linear-gradient(105deg,#000 50%,rgba(0,0,0,.45) 100%)';
  return (
    <div style={{display:'inline-block', border:'2px solid '+color, borderRadius:'50%', padding:'4px '+Math.round(size*1.1)+'px', transform:'rotate('+rotate+'deg)', WebkitMaskImage:mask, maskImage:mask, ...style}}>
      <span style={{fontFamily:'"Josefin Sans",sans-serif', fontWeight:600, fontSize:size, letterSpacing:'.22em', color}}>{children}</span>
    </div>
  );
}