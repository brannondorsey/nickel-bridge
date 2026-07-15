import React from 'react';
/* Fact chip (HCP ranges, constraints). solid = 1px ink; quiet = gray, muted. */
export function Chip({children, quiet=false, color, style}) {
  return <span style={{display:'inline-block', border:'1px solid '+(color||(quiet?'var(--line,#D8D5CE)':'var(--ink,#141414)')), color:color||(quiet?'var(--muted,#6E6A62)':'var(--ink,#141414)'), fontFamily:'Besley,serif', fontWeight:quiet?600:700, fontSize:11, padding:'3px 8px', borderRadius:3, ...style}}>{children}</span>;
}