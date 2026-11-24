"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

/** Copies `value` to the clipboard and briefly confirms with a check mark. */
export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={copy} aria-label={`${label}: ${copied ? "copied" : "copy to clipboard"}`}>
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      <span aria-live="polite">{copied ? "Copied" : label}</span>
    </Button>
  );
}

/** A key or other secret-looking value in monospace, with a copy button. */
export function KeyField({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 font-mono text-sm">{value}</code>
      <CopyButton value={value} label={label} />
    </div>
  );
}
