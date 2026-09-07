import { useRef, useState } from "react";
import { Download, Eye, EyeOff, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { useTool } from "@/state/toolStore";

export function SecretsScreen() {
  const { config, secretValues, setSecretValue, mergeEnv } = useTool();
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = async (file: File) => {
    const text = await file.text();
    const parsed: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m) parsed[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
    }
    const filled = mergeEnv(parsed);
    toast.success(`Filled ${filled} empty field${filled === 1 ? "" : "s"}, kept existing values`);
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <KeyRound className="h-4 w-4 text-primary" />
        <span>Secrets Configuration</span>
        <button className="btn ml-auto" onClick={() => fileRef.current?.click()}>
          <Download className="h-4 w-4" /> Load .env file
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".env,text/plain"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onFile(f);
            e.target.value = "";
          }}
        />
      </div>

      <div className="space-y-3 p-4">
        <p className="text-xs text-muted-foreground">
          Loading a file only fills empty fields — typed keys are never overwritten.
        </p>
        {config.secrets.map((s) => {
          const show = revealed[s.name];
          const value = secretValues[s.name] ?? "";
          return (
            <div key={s.name} className="rounded-md border border-border bg-code p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm text-primary">{s.name}</span>
                <span className="chip">{s.required ? "Required" : "Optional"}</span>
                <span
                  className={`chip ${value ? "text-success" : s.required ? "text-destructive" : "text-muted-foreground"}`}
                >
                  {value ? "set" : "empty"}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{s.description}</p>
              <div className="mt-2 flex items-center gap-2">
                <input
                  className="field"
                  type={show ? "text" : "password"}
                  value={value}
                  placeholder="paste value"
                  onChange={(e) => setSecretValue(s.name, e.target.value)}
                />
                <button
                  className="btn"
                  onClick={() => setRevealed((r) => ({ ...r, [s.name]: !r[s.name] }))}
                  aria-label={show ? `Hide ${s.name}` : `Show ${s.name}`}
                >
                  {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
