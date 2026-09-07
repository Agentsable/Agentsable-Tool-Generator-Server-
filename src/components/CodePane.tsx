type Props = {
  value: string;
  onChange?: (v: string) => void;
  readOnly?: boolean;
  minRows?: number;
};

export function CodePane({ value, onChange, readOnly, minRows = 18 }: Props) {
  const lines = value.split("\n");

  if (readOnly) {
    return (
      <div className="code-surface flex overflow-auto rounded-md border border-border">
        <div className="select-none border-r border-border px-3 py-3 text-right text-gutter">
          {lines.map((_, i) => (
            <div key={i}>{i + 1}</div>
          ))}
        </div>
        <pre className="flex-1 overflow-x-auto px-4 py-3">{value}</pre>
      </div>
    );
  }

  return (
    <div className="code-surface flex overflow-hidden rounded-md border border-border">
      <div className="select-none border-r border-border px-3 py-3 text-right text-gutter">
        {lines.map((_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <textarea
        spellCheck={false}
        rows={Math.max(minRows, lines.length)}
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        className="code-surface flex-1 resize-none px-4 py-3 text-foreground outline-none"
      />
    </div>
  );
}
