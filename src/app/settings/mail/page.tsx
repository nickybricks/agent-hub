"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";

type Provider = "imap" | "gmail" | "outlook";

interface MailSettings {
  provider: Provider;
  imap?: { host?: string; port?: number; user?: string; password?: string };
  gmail?: { clientId?: string; clientSecret?: string };
  outlook?: { clientId?: string; clientSecret?: string; tenantId?: string };
  _status?: {
    imapPassword: boolean;
    googleRefreshToken: boolean;
    microsoftRefreshToken: boolean;
  };
}

const PROVIDERS: { id: Provider; label: string }[] = [
  { id: "imap", label: "IMAP (IONOS, generic)" },
  { id: "gmail", label: "Gmail" },
  { id: "outlook", label: "Outlook / Microsoft 365" },
];

export default function MailSettingsPage() {
  const [settings, setSettings] = useState<MailSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const load = useCallback(async () => {
    const res = await fetch("/api/settings/mail");
    setSettings(await res.json());
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    if (!settings) return;
    setSaving(true);
    try {
      const res = await fetch("/api/settings/mail", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      if (!res.ok) throw new Error("save failed");
      setSettings(await res.json());
      toast("Mail settings saved", "success");
    } catch {
      toast("Couldn't save settings. Try again.", "error");
    } finally {
      setSaving(false);
    }
  }

  if (!settings) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-8">
        <div className="animate-pulse text-muted">Loading mail settings…</div>
      </div>
    );
  }

  const provider = settings.provider;

  return (
    <div className="max-w-3xl mx-auto px-6 py-8">
      <div className="flex items-center gap-2 text-sm text-muted mb-6">
        <Link href="/" className="hover:text-foreground">Dashboard</Link>
        <span>/</span>
        <span className="text-foreground">Mail settings</span>
      </div>

      <h1 className="text-2xl font-bold mb-2 tracking-tight">Mail Provider</h1>
      <p className="text-sm text-muted mb-6">
        Choose which mail account the analyzer and newsletter agent talk to. Save before connecting.
      </p>

      <section className="card p-5 mb-6">
        <h2 className="text-sm font-semibold mb-3">Provider</h2>
        <div className="flex flex-wrap gap-2">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              onClick={() => setSettings({ ...settings, provider: p.id })}
              className={`px-4 py-2 rounded-[0.625rem] text-sm font-medium transition-colors border ${
                provider === p.id
                  ? "bg-accent text-white border-transparent"
                  : "bg-background-secondary border-border text-muted hover:border-accent hover:text-foreground"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </section>

      {provider === "imap" && (
        <div className="card p-5 space-y-4">
          <h3 className="font-medium">IMAP credentials</h3>
          <Field
            label="Host"
            value={settings.imap?.host ?? ""}
            onChange={(v) => setSettings({ ...settings, imap: { ...settings.imap, host: v } })}
            placeholder="imap.ionos.de"
          />
          <Field
            label="Port"
            type="number"
            value={String(settings.imap?.port ?? 993)}
            onChange={(v) =>
              setSettings({ ...settings, imap: { ...settings.imap, port: parseInt(v) || 993 } })
            }
          />
          <Field
            label="User"
            value={settings.imap?.user ?? ""}
            onChange={(v) => setSettings({ ...settings, imap: { ...settings.imap, user: v } })}
            placeholder="you@example.com"
          />
          <Field
            label="Password"
            type="password"
            value={settings.imap?.password ?? ""}
            onChange={(v) => setSettings({ ...settings, imap: { ...settings.imap, password: v } })}
            placeholder={settings._status?.imapPassword ? "•••••• (set)" : "App password"}
            help="Prefer setting IMAP_PASSWORD in .env.local instead."
          />
        </div>
      )}

      {provider === "gmail" && (
        <div className="card p-5 space-y-4">
          <h3 className="font-medium">Gmail (OAuth 2.0)</h3>
          <p className="text-sm text-muted">
            Register an OAuth client in <code>console.cloud.google.com</code> (type:
            Web application) and add <code className="text-xs">/api/auth/google/callback</code> as a
            redirect URI. Enable the Gmail API on the project.
          </p>
          <Field
            label="Client ID"
            value={settings.gmail?.clientId ?? ""}
            onChange={(v) => setSettings({ ...settings, gmail: { ...settings.gmail, clientId: v } })}
            placeholder="12345-abc.apps.googleusercontent.com"
          />
          <Field
            label="Client Secret"
            type="password"
            value={settings.gmail?.clientSecret ?? ""}
            onChange={(v) =>
              setSettings({ ...settings, gmail: { ...settings.gmail, clientSecret: v } })
            }
            placeholder="GOCSPX-…"
          />
          <ConnectRow
            connected={!!settings._status?.googleRefreshToken}
            onConnect={async () => {
              await save();
              window.location.href = "/api/auth/google/start";
            }}
            label="Gmail"
          />
        </div>
      )}

      {provider === "outlook" && (
        <div className="card p-5 space-y-4">
          <h3 className="font-medium">Outlook / Microsoft 365 (OAuth 2.0)</h3>
          <p className="text-sm text-muted">
            Register an app in <code>portal.azure.com</code> → App registrations. Add
            <code className="text-xs"> /api/auth/microsoft/callback</code> as a redirect URI and
            grant delegated <code className="text-xs">Mail.Read</code> permission.
          </p>
          <Field
            label="Client ID"
            value={settings.outlook?.clientId ?? ""}
            onChange={(v) =>
              setSettings({ ...settings, outlook: { ...settings.outlook, clientId: v } })
            }
          />
          <Field
            label="Client Secret"
            type="password"
            value={settings.outlook?.clientSecret ?? ""}
            onChange={(v) =>
              setSettings({ ...settings, outlook: { ...settings.outlook, clientSecret: v } })
            }
          />
          <Field
            label="Tenant ID"
            value={settings.outlook?.tenantId ?? "common"}
            onChange={(v) =>
              setSettings({ ...settings, outlook: { ...settings.outlook, tenantId: v } })
            }
            help='Use "common" for multi-tenant / personal accounts.'
          />
          <ConnectRow
            connected={!!settings._status?.microsoftRefreshToken}
            onConnect={async () => {
              await save();
              window.location.href = "/api/auth/microsoft/start";
            }}
            label="Outlook"
          />
        </div>
      )}

      <div className="flex items-center gap-3 mt-6">
        <Button onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  help,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  help?: string;
}) {
  return (
    <div>
      <label className="text-sm text-muted block mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-input-bg border border-border rounded-[0.625rem] px-3 py-2 text-sm focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 font-mono transition-colors"
      />
      {help && <p className="text-xs text-muted mt-1">{help}</p>}
    </div>
  );
}

function ConnectRow({
  connected,
  onConnect,
  label,
}: {
  connected: boolean;
  onConnect: () => void;
  label: string;
}) {
  return (
    <div className="flex items-center justify-between pt-2 border-t border-border">
      <div className="flex items-center gap-2 text-sm">
        <span className={`h-2 w-2 rounded-full ${connected ? "bg-success" : "bg-muted opacity-50"}`} />
        {connected ? (
          <span className="text-success font-medium">{label} connected</span>
        ) : (
          <span className="text-muted">Not connected</span>
        )}
      </div>
      <Button variant="ghost" size="sm" onClick={onConnect}>
        {connected ? `Reconnect ${label}` : `Connect ${label}`}
      </Button>
    </div>
  );
}
