import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { ModelOption } from '@gb/shared';

function price(m: ModelOption): string {
  if (m.free) return 'free';
  if (m.promptPrice === undefined || m.completionPrice === undefined) return '';
  return `$${m.promptPrice.toFixed(2)} / $${m.completionPrice.toFixed(2)}`;
}

export type PriceTier = 'all' | 'free' | 'low' | 'medium' | 'high';

/**
 * Tiers go by input price: every move sends the game transcript so far, so
 * prompts cost far more than the short replies. Rough costs are for four seats.
 */
const TIERS: { id: PriceTier; label: string; title: string }[] = [
  { id: 'all', label: 'All', title: 'Every model' },
  { id: 'free', label: 'Free', title: 'No charge, but rate-limited' },
  { id: 'low', label: 'Low', title: 'Up to $0.50 per million input tokens: about $0.20 a game or less' },
  { id: 'medium', label: 'Medium', title: '$0.50 to $3 per million input tokens: about $0.20 to $1 a game' },
  { id: 'high', label: 'High', title: 'Over $3 per million input tokens: $1 or more a game' },
];

export function tierOf(m: ModelOption): Exclude<PriceTier, 'all'> | null {
  if (m.free) return 'free';
  if (m.promptPrice === undefined) return null;
  return m.promptPrice <= 0.5 ? 'low' : m.promptPrice <= 3 ? 'medium' : 'high';
}

/**
 * Searchable model list. Click to open, type to filter (every word must match the
 * name or id), arrows and Enter to choose. Any full model id can be typed in too.
 */
export function ModelPicker({
  value,
  models,
  onChange,
  label,
  tier,
  onTier,
}: {
  value: string;
  models: ModelOption[];
  onChange: (id: string) => void;
  label: string;
  /** Price filter, shared by all the seats. */
  tier: PriceTier;
  onTier: (tier: PriceTier) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listId = useId();
  const current = models.find((m) => m.id === value);

  const matches = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return models.filter((m) => {
      if (tier !== 'all' && tierOf(m) !== tier) return false;
      const text = `${m.id} ${m.name}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
  }, [models, query, tier]);
  const typed = query.trim();
  const offerTyped = typed.includes('/') && !models.some((m) => m.id === typed);
  const count = matches.length + (offerTyped ? 1 : 0);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, listId]);

  const show = () => {
    setQuery('');
    const inTier = models.filter((m) => tier === 'all' || tierOf(m) === tier);
    setActive(Math.max(0, inTier.findIndex((m) => m.id === value)));
    setOpen(true);
  };
  const choose = (id: string) => {
    onChange(id);
    setOpen(false);
    button.current?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (count) setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : count - 1)) % count);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active < matches.length) choose(matches[active]!.id);
      else if (offerTyped) choose(typed);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      button.current?.focus();
    }
  };

  return (
    <div
      className="picker"
      ref={root}
      onBlur={(e) => {
        if (!root.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={button}
        type="button"
        className="picker__button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : show())}
      >
        <span className="picker__name">{current?.name ?? (value || 'Choose a model')}</span>
        {value && <span className="picker__id">{value}</span>}
        <span className="picker__caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div
          className="picker__pop"
          // Keep focus in the search box while clicking around the panel, so it doesn't blur shut.
          onMouseDown={(e) => {
            if (e.target !== search.current) e.preventDefault();
          }}
        >
          <input
            ref={search}
            autoFocus
            className="picker__search"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={count ? `${listId}-${active}` : undefined}
            aria-label={`Search models for ${label.toLowerCase()}`}
            placeholder="Search by name or id, or paste any model id"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKey}
          />
          <div className="picker__tiers" role="group" aria-label="Filter by price">
            {TIERS.map((t) => (
              <button
                key={t.id}
                type="button"
                className="picker__tier"
                aria-pressed={tier === t.id}
                title={t.title}
                onClick={() => {
                  onTier(t.id);
                  setActive(0);
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
          <ul className="picker__list" id={listId} role="listbox">
            {matches.map((m, i) => (
              <li
                key={m.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={m.id === value}
                className={`picker__opt${i === active ? ' picker__opt--active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(m.id)}
              >
                <span className="picker__main">
                  <span className="picker__opt-name">{m.name}</span>
                  <span className="picker__opt-id">{m.id}</span>
                </span>
                <span className="picker__side">
                  {m.featured && <span className="picker__tag">Suggested</span>}
                  {price(m)}
                </span>
              </li>
            ))}
            {offerTyped && (
              <li
                id={`${listId}-${matches.length}`}
                role="option"
                aria-selected={false}
                className={`picker__opt${active === matches.length ? ' picker__opt--active' : ''}`}
                onMouseEnter={() => setActive(matches.length)}
                onClick={() => choose(typed)}
              >
                <span className="picker__main">
                  <span className="picker__opt-name">Use “{typed}”</span>
                  <span className="picker__opt-id">Not in OpenRouter's list; it will be tried as typed</span>
                </span>
              </li>
            )}
            {count === 0 && (
              <li className="picker__empty">
                No models match{tier !== 'all' ? ' at this price' : ''}. Paste a full id like provider/model to use it anyway.
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
