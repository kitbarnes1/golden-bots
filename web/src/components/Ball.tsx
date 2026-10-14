import { formatMoney, type Ball as BallT, type ClaimValue } from '@gb/shared';

type Size = 'xs' | 'sm' | 'md' | 'lg';

interface BallProps {
  /** null = face down / hidden. */
  ball: BallT | null;
  size?: Size;
  /** What the owner says is inside (shown under hidden balls). */
  claim?: ClaimValue;
  /** Show the real value of a hidden ball (god mode / your own back row). */
  peek?: boolean;
  dim?: boolean;
  label?: string;
  onClick?: () => void;
  title?: string;
}

function shortMoney(v: number): string {
  if (v >= 1000) return `£${(v / 1000).toLocaleString('en-GB', { maximumFractionDigits: 1 })}k`;
  return formatMoney(v);
}

export function Ball({ ball, size = 'md', claim, peek, dim, label, onClick, title }: BallProps) {
  const open = ball !== null && !peek;
  const killer = ball?.kind === 'killer';
  const classes = ['ball', `ball--${size}`, open ? 'ball--open' : 'ball--closed'];
  if (killer && (open || peek)) classes.push('ball--killer');
  if (dim) classes.push('ball--dim');
  if (onClick) classes.push('ball--clickable');

  const content =
    ball && (open || peek) ? (killer ? (size === 'xs' ? '☠' : 'KILLER') : shortMoney(ball.value)) : (label ?? '');
  const inner = (
    <>
      <span className={peek ? 'ball__face ball__face--peek' : 'ball__face'}>{content}</span>
      {claim !== undefined && (
        <span className={`ball__claim ${claim === 'killer' ? 'ball__claim--killer' : ''}`} title="Claimed">
          {claim === 'killer' ? 'Killer' : shortMoney(claim)}
        </span>
      )}
    </>
  );
  const tip =
    title ??
    (ball && (open || peek) ? (killer ? 'Killer ball' : formatMoney(ball.value)) : claim !== undefined ? 'Hidden ball' : undefined);

  if (onClick) {
    return (
      <button type="button" className={classes.join(' ')} onClick={onClick} title={tip} aria-label={tip ?? label}>
        {inner}
      </button>
    );
  }
  return (
    <span className={classes.join(' ')} title={tip}>
      {inner}
    </span>
  );
}

export function ChoiceBall({ choice, revealed, size = 'lg' }: { choice: 'split' | 'steal'; revealed: boolean; size?: Size }) {
  return (
    <span className={`ball ball--${size} ${revealed ? `ball--open ball--${choice}` : 'ball--closed'}`}>
      <span className="ball__face">{revealed ? choice.toUpperCase() : ''}</span>
    </span>
  );
}
