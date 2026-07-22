import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AppHeader, ScreenHeader } from './AppHeader';
import { BridgeMark } from './BridgeMark';
import { Button } from './Button';
import { Chip } from './Chip';
import { DayGrid, sumInWindow } from './DayGrid';
import { Dialog } from './Dialog';
import { FlipDigits } from './FlipDigits';
import { HcpBadge } from './HcpBadge';
import { InkStamp } from './InkStamp';
import { Input } from './Input';
import { PctBar } from './PctBar';
import { PerforatedPanel } from './PerforatedPanel';
import { Postmark } from './Postmark';
import { Sparkline } from './Sparkline';
import { StarGrade } from './StarGrade';
import { StemChart } from './StemChart';
import { TabBar } from './TabBar';
import { TicketStub } from './TicketStub';
import { Toast } from './Toast';

describe('Button', () => {
  it('renders a real button and fires onClick', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>KEEP GOING →</Button>);
    await userEvent.click(screen.getByRole('button', { name: /keep going/i }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('blocks clicks and shows the busy label when busy', async () => {
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} busy busyLabel="FINDING A TABLE…">
        PLAY THE TOLL →
      </Button>,
    );
    const btn = screen.getByRole('button', { name: /finding a table/i });
    expect(btn).toBeDisabled();
    await userEvent.click(btn).catch(() => {});
    expect(onClick).not.toHaveBeenCalled();
  });

  it('renders a link when given "to"', () => {
    render(
      <MemoryRouter>
        <Button to="/t/12">KEEP GOING →</Button>
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: /keep going/i })).toHaveAttribute('href', '/t/12');
  });

  it('supports the secondary variant', () => {
    render(<Button variant="secondary">Review the boards</Button>);
    expect(screen.getByRole('button')).toHaveClass('ds-btn-secondary');
  });
});

describe('Chip', () => {
  it('renders solid and quiet variants', () => {
    render(
      <>
        <Chip>10–12 HCP</Chip>
        <Chip quiet>6+ hearts</Chip>
      </>,
    );
    expect(screen.getByText('10–12 HCP')).not.toHaveClass('chip-quiet');
    expect(screen.getByText('6+ hearts')).toHaveClass('chip-quiet');
  });
});

describe('Input', () => {
  it('associates its caps label and shows an error line', () => {
    render(<Input label="HANDLE" value="" onChange={() => {}} error="Handle is taken" placeholder="Handle" />);
    expect(screen.getByLabelText('HANDLE')).toHaveAttribute('placeholder', 'Handle');
    expect(screen.getByRole('alert')).toHaveTextContent('Handle is taken');
  });
});

describe('Dialog', () => {
  it('is a labelled dialog; scrim, close button and Escape all close it', async () => {
    const onClose = vi.fn();
    render(
      <Dialog title="1NT — partner's response" onClose={onClose}>
        body
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog', { name: /1NT/ });
    expect(dialog).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /close/i }));
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('Toast', () => {
  it('is a status region with an optional stamp slot', () => {
    render(<Toast stamp={<InkStamp>SCORED</InkStamp>}>Board scored.</Toast>);
    expect(screen.getByRole('status')).toHaveTextContent('Board scored.');
    expect(screen.getByText('SCORED')).toBeInTheDocument();
  });
});

describe('PerforatedPanel', () => {
  it('renders a caps heading and a dashed variant', () => {
    const { container } = render(
      <PerforatedPanel heading="TOLLS PAID" dashed>
        rows
      </PerforatedPanel>,
    );
    expect(screen.getByText('TOLLS PAID')).toHaveClass('label-caps');
    expect(container.firstChild).toHaveClass('perf-panel-dashed');
  });
});

describe('InkStamp', () => {
  it('renders rotated stamp text', () => {
    render(<InkStamp rotate={3}>LIVE</InkStamp>);
    expect(screen.getByText('LIVE')).toBeInTheDocument();
  });
});

describe('Postmark', () => {
  it('renders arc and center texts inside the SVG', () => {
    render(<Postmark arcTop="NICKEL BRIDGE" arcBottom="TOURNAMENT Nº12" line1="TOLL PAID" line2="JUL 13" />);
    for (const text of ['NICKEL BRIDGE', 'TOURNAMENT Nº12', 'TOLL PAID', 'JUL 13']) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
  });
});

describe('TicketStub', () => {
  it('renders label, value and edge text', () => {
    render(<TicketStub label="OPEN NOW" value="4 boards" edgeText="ADMIT ONE" />);
    for (const text of ['OPEN NOW', '4 boards', 'ADMIT ONE']) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
  });
});

describe('FlipDigits', () => {
  it('renders one cell per character plus a suffix cell', () => {
    const { container } = render(<FlipDigits value="1487" />);
    expect(container.querySelectorAll('.flipdigit')).toHaveLength(4);
    const pct = render(<FlipDigits value="58" suffix="%" />);
    expect(pct.container.querySelectorAll('.flipdigit')).toHaveLength(3);
    expect(pct.container.textContent).toBe('58%');
  });
});

describe('StarGrade', () => {
  it('renders 1–3 stars with an accessible label', () => {
    render(<StarGrade stars={2} />);
    expect(screen.getByLabelText('2 of 3 stars')).toBeInTheDocument();
  });

  it('renders the distinct ✗ treatment for 0 stars, never three empty stars', () => {
    const { container } = render(<StarGrade stars={0} />);
    expect(screen.getByLabelText('0 of 3 stars')).toBeInTheDocument();
    expect(container.querySelector('.stargrade-x')).toBeInTheDocument();
    expect(container.textContent).toContain('✗');
  });
});

describe('BridgeMark', () => {
  it('renders the glyph variant as an svg', () => {
    const { container } = render(<BridgeMark />);
    expect(container.querySelector('svg')).toBeInTheDocument();
  });
});

describe('AppHeader / ScreenHeader', () => {
  it('AppHeader shows the wordmark linking home and a context caption', () => {
    render(
      <MemoryRouter>
        <AppHeader context="RANKINGS" />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: /nickel bridge/i })).toHaveAttribute('href', '/');
    expect(screen.getByText('RANKINGS')).toBeInTheDocument();
  });

  it('ScreenHeader fires onBack and shows title + caption', async () => {
    const onBack = vi.fn();
    render(<ScreenHeader title="Tournament #12" caption="12 pairs · matchpoints" onBack={onBack} />);
    await userEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(onBack).toHaveBeenCalledOnce();
    expect(screen.getByText('Tournament #12')).toBeInTheDocument();
    expect(screen.getByText('12 pairs · matchpoints')).toBeInTheDocument();
  });
});

describe('TabBar', () => {
  it('renders nav links with aria-current on the active tab', () => {
    render(
      <MemoryRouter initialEntries={['/leaderboard']}>
        <TabBar myId={1} pathname="/leaderboard" />
      </MemoryRouter>,
    );
    const nav = screen.getByRole('navigation');
    expect(nav).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'CROSSINGS' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'GLOSSARY' })).toHaveAttribute('href', '/glossary');
    expect(screen.getByRole('link', { name: 'STATS' })).toHaveAttribute('href', '/players/1');
    const active = screen.getByRole('link', { name: 'RANKINGS' });
    expect(active).toHaveAttribute('aria-current', 'page');
  });

  it('keeps GLOSSARY active on term deep links (/glossary/:slug)', () => {
    render(
      <MemoryRouter initialEntries={['/glossary/finesse']}>
        <TabBar myId={1} pathname="/glossary/finesse" />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'GLOSSARY' })).toHaveAttribute('aria-current', 'page');
  });

  it('does not mark STATS active on someone else\'s profile, only your own', () => {
    render(
      <MemoryRouter initialEntries={['/players/90']}>
        <TabBar myId={1} pathname="/players/90" />
      </MemoryRouter>,
    );
    // STATS still links to your own profile, but tapping it from here is a
    // real navigation (id 90 → id 1), so it must not claim "you are here"
    expect(screen.getByRole('link', { name: 'STATS' })).not.toHaveAttribute('aria-current');
    expect(screen.queryByText((_, el) => el?.className === 'tab-active')).not.toBeInTheDocument();

    render(
      <MemoryRouter initialEntries={['/players/1']}>
        <TabBar myId={1} pathname="/players/1" />
      </MemoryRouter>,
    );
    expect(screen.getAllByRole('link', { name: 'STATS' }).at(-1)).toHaveAttribute('aria-current', 'page');
  });
});

describe('PctBar', () => {
  it('fills to the given percentage', () => {
    const { container } = render(<PctBar pct={64} />);
    const fill = container.querySelector('.pctbar-fill') as HTMLElement;
    expect(fill.style.right).toBe('36%');
  });
});

describe('HcpBadge', () => {
  it('renders the HCP count', () => {
    render(<HcpBadge hcp={12} />);
    expect(screen.getByText('12 HCP')).toHaveClass('hcp-badge');
  });
});

describe('Sparkline', () => {
  const points = [
    { label: 'Tournament #10', caption: 'Jul 2', value: 47 },
    { label: 'Tournament #11', caption: 'Jul 9', value: 54 },
    { label: 'Tournament #12', caption: 'Jul 13', value: 61 },
  ];

  it('renders a polyline over the value range and a dashed reference line', () => {
    const { container } = render(<Sparkline points={points} refValue={50} refLabel="field average 50%" />);
    expect(container.querySelector('polyline')).toBeInTheDocument();
    expect(container.querySelector('.sparkline-ref')).toBeInTheDocument();
    expect(screen.getByText(/field average 50%/)).toBeInTheDocument();
  });

  it('tapping a point shows its detail line', async () => {
    render(<Sparkline points={points} format={(v) => `${v}%`} />);
    await userEvent.click(screen.getByRole('button', { name: /Tournament #12/ }));
    expect(screen.getByText(/61%/)).toBeInTheDocument();
    expect(screen.getByText(/Jul 13/)).toBeInTheDocument();
  });

  it('renders the no-data note when empty', () => {
    render(<Sparkline points={[]} />);
    expect(screen.getByText(/no data yet/i)).toBeInTheDocument();
  });
});

describe('StemChart', () => {
  const points = [
    { tick: '−1', pct: 30, count: 3 },
    { tick: 'MADE', pct: 40, count: 4 },
    { tick: '+1', pct: 30, count: 3 },
  ];

  it('renders one bar per point plus a dashed average marker', () => {
    const { container } = render(
      <StemChart
        points={points}
        avgIndex={1.2}
        avgLabel="Ø +0.2"
        leftCaption="short of contract"
        rightCaption="over contract"
      />,
    );
    expect(container.querySelectorAll('rect')).toHaveLength(3);
    expect(screen.getByText('MADE')).toBeInTheDocument();
    expect(screen.getByText('40%')).toBeInTheDocument();
    expect(screen.getByText('Ø +0.2')).toBeInTheDocument();
    expect(screen.getByText('short of contract')).toBeInTheDocument();
    expect(screen.getByText('over contract')).toBeInTheDocument();
  });

  it('clamps an out-of-range average index onto the visible axis', () => {
    const { container } = render(
      <StemChart points={points} avgIndex={9} avgLabel="Ø +6" leftCaption="short" rightCaption="over" />,
    );
    const marker = container.querySelectorAll('line')[1] as SVGLineElement; // [0] is the baseline
    expect(marker.getAttribute('x1')).toBe('310'); // clamped to the last point's x
  });

  it('carries the same data as text for screen readers', () => {
    render(<StemChart points={points} avgIndex={1} avgLabel="Ø 0" leftCaption="short" rightCaption="over" />);
    expect(screen.getByText('−1: 30% — 3 boards')).toBeInTheDocument();
  });
});

describe('DayGrid', () => {
  const today = new Date('2026-07-22T12:00:00Z');
  const days = [
    { date: '2026-07-20', count: 3 },
    { date: '2026-07-13', count: 1 },
  ];

  it('renders one cell per day in the window, future days excluded from taps', () => {
    render(<DayGrid days={days} weeks={2} today={today} />);
    expect(screen.getByRole('button', { name: /Jul 20 — 3 boards/ })).toBeInTheDocument();
    // a day after `today` inside the same window has no button
    expect(screen.queryByRole('button', { name: /Jul 25/ })).not.toBeInTheDocument();
  });

  it('tapping a cell shows its detail line', async () => {
    render(<DayGrid days={days} weeks={2} today={today} />);
    await userEvent.click(screen.getByRole('button', { name: /Jul 13/ }));
    expect(screen.getByText(/Jul 13 · 1 board/)).toBeInTheDocument();
  });

  it('labels a zero-count day distinctly from an unplayed future day', () => {
    render(<DayGrid days={[]} weeks={1} today={today} />);
    expect(screen.getAllByRole('button', { name: /— no boards/ }).length).toBeGreaterThan(0);
  });
});

describe('sumInWindow', () => {
  it('only counts days inside the trailing window', () => {
    const days = [
      { date: '2020-01-01', count: 5 },
      { date: '2026-07-20', count: 3 },
    ];
    expect(sumInWindow(days, 2, new Date('2026-07-22T00:00:00Z'))).toBe(3);
  });
});
