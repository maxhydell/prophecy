import React, { useCallback, useEffect, useState } from 'react';

export function FileCard({ children }: { children: React.ReactNode }) {
    return <main className="ui-card">{children}</main>;
}
export function Header({ title, fact, intro }: { title: string; fact?: string; intro?: string }) {
    return <header className="ui-header">
        <div className="ui-eyebrow">Card game tool</div>
        <h1 className="ui-title">{title}</h1>
        {fact && <div className="ui-fact">{fact}</div>}
        {intro && <p className="ui-intro">{intro}</p>}
    </header>;
}
export function Group({ label, heading, children }: { label?: string; heading?: string | boolean; children: React.ReactNode }) {
    return <section className="ui-group">
        {label && <div className="ui-label">{label}</div>}
        {typeof heading === 'string' && <h2 className="ui-h2">{heading}</h2>}
        {children}
    </section>;
}
export function Text({ children }: { children: React.ReactNode }) { return <div className="ui-text">{children}</div>; }
export function Paragraph({ children }: { children: React.ReactNode }) { return <p className="ui-p">{children}</p>; }
export function Caption({ children }: { children: React.ReactNode }) { return <p className="ui-caption">{children}</p>; }
export function Heading({ sub, children }: { sub?: string; children: React.ReactNode }) {
    return <div className="ui-heading"><h3>{children}</h3>{sub && <div className="ui-sub">{sub}</div>}</div>;
}
export function KeySentence({ children }: { children: React.ReactNode }) { return <div className="ui-key">{children}</div>; }
export function Bullets({ items }: { items: React.ReactNode[] }) { return <ul className="ui-list">{items.map((t, i) => <li key={i}>{t}</li>)}</ul>; }
export function NumberedList({ items }: { items: React.ReactNode[] }) { return <ol className="ui-list">{items.map((t, i) => <li key={i}>{t}</li>)}</ol>; }
export function Facts({ items }: { items: { label: string; value: React.ReactNode }[] }) {
    return <dl className="ui-facts">{items.map((f, i) => <div key={i} className="ui-fact-row"><dt>{f.label}</dt><dd>{f.value}</dd></div>)}</dl>;
}
export function FileButton({ variant = 'secondary', compact, disabled, onClick, children }: { variant?: 'primary' | 'secondary' | 'ghost'; compact?: boolean; disabled?: boolean; onClick?: () => void; children: React.ReactNode }) {
    return <button type="button" className="ui-btn" data-variant={variant} data-compact={compact || undefined} disabled={disabled} onClick={onClick}>{children}</button>;
}
export function ChoiceRow({ label, options, value, onChange }: { label: string; options: { value: string; label: string }[]; value: string; onChange: (v: string) => void }) {
    return <div className="ui-choice" role="group" aria-label={label}>
        <div className="ui-choice-label">{label}</div>
        <div className="ui-choice-opts">
            {options.map((o) => <button key={o.value} type="button" className="ui-chip" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>)}
        </div>
    </div>;
}
export function Photos({ items }: { label?: string; items: { src: string; alt: string }[] }) {
    return <div className="ui-photos">{items.map((p, i) => <img key={i} src={p.src} alt={p.alt} />)}</div>;
}
export function Closing({ children }: { children: React.ReactNode }) { return <footer className="ui-closing">{children}</footer>; }

// Device-local state saved in localStorage. Falls back to memory if storage is blocked.
export function useLocalState<T>(key: string, initial: T): [T, (v: T) => void, { ready: boolean; message: string }] {
    const [v, setV] = useState<T>(() => {
        try { const s = localStorage.getItem(key); if (s) return JSON.parse(s) as T; } catch { /* ignore */ }
        return initial;
    });
    const set = useCallback((n: T) => {
        setV(n);
        try { localStorage.setItem(key, JSON.stringify(n)); } catch { /* ignore */ }
    }, [key]);
    return [v, set, { ready: true, message: 'Saved on this device.' }];
}
