"use client";

import { useEffect, useRef, useState } from "react";
import { X, LogOut, Trash2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";

export default function SettingsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [email, setEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    fetch("/api/account")
      .then((r) => r.json())
      .then((d) => setEmail(d.email ?? null))
      .catch(() => toast("Couldn’t load your account.", "error"))
      .finally(() => setLoading(false));
  }, [open, toast]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && dialogRef.current) {
        const list = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(
            'a,button,input,select,textarea,[tabindex]:not([tabindex="-1"])',
          ),
        ).filter((el) => !el.hasAttribute("disabled"));
        if (list.length === 0) return;
        const first = list[0];
        const last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function signOut() {
    await fetch("/api/account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "signout" }),
    });
    window.location.href = "/login";
  }

  async function deleteAccount() {
    setBusy(true);
    const r = await fetch("/api/account", { method: "DELETE" });
    const d = await r.json();
    setBusy(false);
    if (!r.ok) return toast(d.error ?? "Deletion failed.", "error");
    toast(d.message ?? "Account deleted.", "success");
    window.location.href = "/login";
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Account"
        className="relative w-[min(560px,94vw)] rounded-2xl border border-border bg-background p-8 shadow-2xl"
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute right-5 top-5 rounded-md p-1.5 text-muted hover:bg-[var(--brand-soft)] hover:text-foreground"
        >
          <X size={18} />
        </button>

        <div className="mb-6">
          <h2 className="text-lg font-semibold tracking-tight">Account</h2>
          <p className="text-sm text-muted">Manage your account</p>
        </div>

        {loading ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : (
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">Email</label>
              <input
                value={email ?? "— (local dev, no account email)"}
                disabled
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm opacity-70"
              />
            </div>

            <div className="flex items-center justify-between rounded-lg border border-border p-4">
              <div>
                <p className="text-sm font-medium">Sign out</p>
                <p className="text-xs text-muted">Sign out on this device</p>
              </div>
              <Button variant="ghost" size="sm" onClick={signOut}>
                <LogOut size={15} /> Sign out
              </Button>
            </div>

            <div>
              <h3 className="mb-1 text-sm font-semibold text-red-600">Danger Zone</h3>
              <p className="mb-3 text-xs text-muted">Irreversible actions for your account</p>
              <div className="rounded-lg border border-red-500/40 bg-red-500/5 p-4">
                <div className="mb-3 flex items-start gap-2">
                  <AlertTriangle size={16} className="mt-0.5 text-red-600" />
                  <div>
                    <p className="text-sm font-medium text-red-600">Delete Account</p>
                    <p className="text-xs text-muted">
                      Permanently delete your account and all data. This cannot be undone.
                    </p>
                  </div>
                </div>

                {!confirming ? (
                  <Button
                    size="sm"
                    className="!bg-red-600 !text-white hover:!bg-red-700"
                    onClick={() => setConfirming(true)}
                  >
                    <Trash2 size={15} /> Delete Account
                  </Button>
                ) : (
                  <div className="flex flex-col gap-2">
                    <p className="text-xs font-medium text-red-600">
                      This permanently deletes <strong>everything</strong> — your account,
                      mailbox analysis, history and chats. There is no recovery. Type{" "}
                      <code>DELETE</code> to confirm.
                    </p>
                    <input
                      value={typed}
                      onChange={(e) => setTyped(e.target.value)}
                      placeholder="DELETE"
                      className="w-40 rounded-md border border-input bg-background px-3 py-2 text-sm"
                    />
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        className="!bg-red-600 !text-white hover:!bg-red-700"
                        disabled={typed !== "DELETE" || busy}
                        onClick={deleteAccount}
                      >
                        {busy ? "Deleting…" : "Permanently delete"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setConfirming(false);
                          setTyped("");
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
