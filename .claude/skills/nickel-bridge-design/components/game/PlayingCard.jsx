import React from 'react';
const SUITS = {S:{g:'♠',c:'var(--suit-s,#141414)',dim:'#141414'},H:{g:'♥',c:'var(--suit-h,#C22F21)',dim:'#DCA9A2'},D:{g:'♦',c:'var(--suit-d,#9E6A00)',dim:'#CFBC93'},C:{g:'♣',c:'var(--suit-c,#00775A)',dim:'#9CC2B6'}};
/* Corner-indexed playing card. Fan by overlapping with negative margins. */
export function PlayingCard({rank='A', suit='S', size=66, dimmed=false, selected=false, placeholder=false, style}) {
  const w = Math.round(size*46/66);
  const s = SUITS[suit]||SUITS.S;
  if (placeholder) return <div style={{width:w, height:size, border:'1.5px dashed var(--line-dashed,#B9B4A9)', borderRadius:3, boxSizing:'border-box', ...style}}/>;
  const color = dimmed ? (suit==='S'?'#141414':s.dim) : s.c;
  return (
    <div style={{width:w, height:size, background:'#fff', border:selected?'2px solid var(--ink,#141414)':'1px solid var(--line-dashed,#B9B4A9)', borderRadius:4, boxShadow:selected?'0 3px 6px rgba(0,0,0,.2)':'0 1px 2px rgba(0,0,0,.14)', padding:'3px 0 0 5px', fontFamily:'Besley,serif', fontWeight:800, color, boxSizing:'border-box', transform:selected?'translateY(-12px)':'none', flex:'none', ...style}}>
      <div style={{fontSize:Math.round(size*15/66), lineHeight:1, letterSpacing:rank==='10'?'-.09em':0}}>{rank}</div>
      <div style={{fontSize:Math.round(size*14/66)}}>{s.g}</div>
    </div>
  );
}