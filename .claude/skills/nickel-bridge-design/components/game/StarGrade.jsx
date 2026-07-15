import React from 'react';
/* 3-star call grade — filled ink stars + line-color remainders. */
export function StarGrade({stars=3, size=12, style}) {
  return <span style={{letterSpacing:2, fontSize:size, color:'var(--ink,#141414)', ...style}}>
    {'★★★'.slice(0,stars)}<span style={{color:'var(--line,#D8D5CE)'}}>{'★★★'.slice(stars)}</span>
  </span>;
}