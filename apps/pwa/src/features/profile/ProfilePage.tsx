"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import StatusBar from "@/components/StatusBar";
import PageHeader from "@/components/PageHeader";
import BottomSheet from "@/components/BottomSheet";
import { ConfirmActionDialog } from "@/components/ConfirmActionDialog";
import Badge from "@/components/ui/Badge";
import NotificationsSheet from "./NotificationsSheet";
import { useAppState } from "@/lib/state/app-state-context";
import { useSession } from "@/lib/auth/session-context";
import { signOut } from "@/lib/api/auth";
import { ApiError } from "@/lib/api/client";
import { useFormDirtySafe } from "@/lib/unsaved-changes";
import { useTheme } from "@/lib/theme/use-theme";
import { useEffectiveProfile } from "./hooks";
import { Sun, Moon, Laptop, LogOut, ChevronRight, ChevronLeft, User, Bell, Shield, FolderOpen } from "lucide-react";

export { AgentTranscript } from "./AgentTranscript";

type ProfileSheet = "edit" | "notifications" | null;

const BASE_PROFILE_ITEMS = [
  {
    key: "edit" as const,
    label: "Editar perfil",
    icon: <User size={18} className="text-text-muted" />,
  },
  {
    key: "notifications" as const,
    label: "Notificações",
    icon: <Bell size={18} className="text-text-muted" />,
  },
  {
    key: "workspaces" as const,
    label: "Meus Espaços",
    icon: <FolderOpen size={18} className="text-text-muted" />,
  },
];

const AVATAR_COLORS = [
  "#0E8C5A",
  "#820AD1",
  "#EC7000",
  "#3E6FB0",
  "#C8483B",
  "#1F2937",
];

export default function ProfilePage() {
  const router = useRouter();
  const [open, setOpen] = useState<ProfileSheet>(null);
  const [editKey, setEditKey] = useState(0);
  const profile = useEffectiveProfile();
  const { saveProfile } = useAppState();
  const { expireSession } = useSession();
  const { theme, setTheme } = useTheme();
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  function handleItem(key: string) {
    if (key === "edit") {
      setOpen("edit");
      setEditKey((k) => k + 1);
    } else if (key === "notifications") setOpen("notifications");
    else if (key === "workspaces") router.push("/workspaces");
  }

  async function handleLogout() {
    if (loggingOut) return;
    setLogoutError(null);
    setLoggingOut(true);
    try {
      // Cookie-first: revoke the server-side session BEFORE dropping local
      // state — clearing only the client would leave the HttpOnly cookie
      // session alive (POST /auth/sign-out, credentials: include).
      await signOut();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        // The server already rejected/ended the session. apiFetch dispatched
        // UNAUTHORIZED_EVENT on this 401, so the global listener may already
        // have run cleanup — expireSession is idempotent, complete it here.
        await expireSession();
        router.push("/");
        return;
      }
      // Network/timeout/5xx/403: the server never confirmed revocation —
      // preserve the local session, stay on the page, show a fixed generic
      // message (never surface raw upstream detail to the UI).
      setLogoutError("Não foi possível sair. Verifique a conexão e tente novamente.");
      setLoggingOut(false);
      return;
    }
    await expireSession();
    router.push("/");
  }

  return (
    <div className="flex min-h-dvh flex-col bg-bg pb-[var(--tab-bar-height)]">
      <StatusBar />
      <PageHeader title="Perfil" />

      <main className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-4 sm:px-8 lg:px-12">
        {/* User Card */}
        <div className="flex items-center gap-3.5 rounded-[20px] border border-border-subtle bg-surface-1 p-4 shadow-card">
          <Badge label={profile.name} size="lg" color={profile.avatarColor} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[18px] font-bold text-text-primary">
              {profile.name}
            </div>
            <div className="truncate text-[13px] font-medium text-text-muted">
              {profile.email ||
                profile.phone ||
                "Atualize seus dados de contato"}
            </div>
          </div>
        </div>

        {/* Theme Preference Card */}
        <div className="rounded-[18px] border border-border-subtle bg-surface-1 p-4 shadow-card">
          <div className="mb-2.5 text-[11px] font-bold uppercase tracking-wider text-text-muted">
            Aparência
          </div>
          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={() => setTheme("dark")}
              className={`flex flex-col items-center gap-1.5 rounded-[14px] border p-3 text-center transition-all ${
                theme === "dark"
                  ? "border-primary bg-primary-tint/30 text-primary font-bold shadow-xs"
                  : "border-border-subtle bg-surface-2 text-text-secondary hover:bg-surface-3"
              }`}
            >
              <Moon size={18} />
              <span className="text-[12px]">Escuro</span>
            </button>
            <button
              type="button"
              onClick={() => setTheme("light")}
              className={`flex flex-col items-center gap-1.5 rounded-[14px] border p-3 text-center transition-all ${
                theme === "light"
                  ? "border-primary bg-primary-tint/30 text-primary font-bold shadow-xs"
                  : "border-border-subtle bg-surface-2 text-text-secondary hover:bg-surface-3"
              }`}
            >
              <Sun size={18} />
              <span className="text-[12px]">Claro</span>
            </button>
            <button
              type="button"
              onClick={() => setTheme("system")}
              className={`flex flex-col items-center gap-1.5 rounded-[14px] border p-3 text-center transition-all ${
                theme === "system"
                  ? "border-primary bg-primary-tint/30 text-primary font-bold shadow-xs"
                  : "border-border-subtle bg-surface-2 text-text-secondary hover:bg-surface-3"
              }`}
            >
              <Laptop size={18} />
              <span className="text-[12px]">Sistema</span>
            </button>
          </div>
        </div>

        {/* Navigation items */}
        <div className="rounded-[18px] border border-border-subtle bg-surface-1 px-4 py-1 shadow-card">
          {BASE_PROFILE_ITEMS.map((item, idx) => (
            <button
              key={item.key}
              type="button"
              onClick={() => handleItem(item.key)}
              className={`flex w-full items-center gap-3 py-3.5 transition-colors hover:bg-surface-2/40 ${
                idx < BASE_PROFILE_ITEMS.length - 1 ? "border-b border-border-subtle" : ""
              }`}
            >
              {item.icon}
              <span className="flex-1 text-left text-[14px] font-bold text-text-primary">
                {item.label}
              </span>
              <ChevronRight size={16} className="text-text-muted" />
            </button>
          ))}
        </div>

        <div className="rounded-[18px] border border-border-subtle bg-surface-1 px-4 py-1 opacity-50 shadow-card">
          <div className="flex w-full items-center gap-3 py-3.5">
            <Shield size={18} className="text-text-muted" />
            <span className="flex-1 text-left text-[14px] font-semibold text-text-muted">
              Segurança
            </span>
            <span className="rounded-full bg-surface-2 px-2.5 py-0.5 text-[10px] font-bold text-text-muted">
              Em breve
            </span>
          </div>
        </div>

        {logoutError && (
          <div
            role="alert"
            className="w-full rounded-[14px] border border-danger/30 bg-danger-tint px-4 py-3 text-[13px] font-semibold text-danger"
          >
            {logoutError}
          </div>
        )}
        <button
          type="button"
          onClick={handleLogout}
          disabled={loggingOut}
          className="flex items-center justify-center gap-2 w-full rounded-[14px] border border-danger/30 bg-danger-tint px-4 py-3.5 text-[14px] font-bold text-danger transition-all hover:bg-danger-tint/80 active:scale-[0.98] disabled:opacity-50"
        >
          <LogOut size={16} />
          Sair da conta
        </button>
      </main>

      <EditProfileSheet
        key={editKey}
        open={open === "edit"}
        profile={profile}
        onClose={() => setOpen(null)}
        onSave={async (input) => {
          await saveProfile(input);
          setOpen(null);
        }}
      />
      <NotificationsSheet
        open={open === "notifications"}
        onClose={() => setOpen(null)}
      />
    </div>
  );
}

// ── Sub-sheets ──────────────────────────────────────────────────

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="rounded-full p-1.5 text-text-primary hover:bg-surface-2 transition-colors"
      aria-label="Voltar"
    >
      <ChevronLeft size={20} />
    </button>
  );
}

function EditProfileSheet({
  open,
  profile,
  onClose,
  onSave,
}: {
  open: boolean;
  profile: {
    name: string;
    email: string;
    phone: string;
    avatarColor: string;
    greetingStyle: "auto" | "minimal" | "verbose";
  };
  onClose: () => void;
  onSave: (input: {
    name: string;
    email: string;
    phone: string;
    avatarColor: string;
    greetingStyle: "auto" | "minimal" | "verbose";
  }) => Promise<void>;
}) {
  const { isDirty, markDirty, markClean } = useFormDirtySafe();
  const [discardOpen, setDiscardOpen] = useState(false);
  const [name, setName] = useState(profile.name ?? "");
  const [email, setEmail] = useState(profile.email ?? "");
  const [phone, setPhone] = useState(profile.phone ?? "");
  const [avatarColor, setAvatarColor] = useState(
    profile.avatarColor ?? "#0E8C5A",
  );
  const [greetingStyle, setGreetingStyle] = useState<
    "auto" | "minimal" | "verbose"
  >(
    profile.greetingStyle === "minimal" || profile.greetingStyle === "verbose"
      ? profile.greetingStyle
      : "auto",
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setName(profile.name ?? "");
    setEmail(profile.email ?? "");
    setPhone(profile.phone ?? "");
    setAvatarColor(profile.avatarColor ?? "#0E8C5A");
    setGreetingStyle(
      profile.greetingStyle === "minimal" || profile.greetingStyle === "verbose"
        ? profile.greetingStyle
        : "auto",
    );
    setError(null);
    markClean();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function requestClose() {
    if (isDirty) {
      setDiscardOpen(true);
      return;
    }
    onClose();
  }

  function confirmDiscard() {
    markClean();
    setDiscardOpen(false);
    onClose();
  }

  return (
    <>
      <BottomSheet open={open} onClose={requestClose} title="Editar perfil">
        <div className="flex items-center gap-3 pb-4">
          <BackButton onClick={requestClose} />
        </div>
        <div className="flex flex-col gap-4" onChangeCapture={markDirty}>
          <fieldset>
            <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">
              Nome
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              className="w-full rounded-[14px] border border-border-subtle bg-surface-2 px-3.5 py-3 text-[14px] font-medium text-text-primary outline-none transition-colors focus:border-primary"
            />
          </fieldset>

          <fieldset>
            <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">
              E-mail
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              maxLength={120}
              className="w-full rounded-[14px] border border-border-subtle bg-surface-2 px-3.5 py-3 text-[14px] font-medium text-text-primary outline-none transition-colors focus:border-primary"
            />
          </fieldset>

          <fieldset>
            <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">
              Telefone
            </label>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              maxLength={40}
              className="w-full rounded-[14px] border border-border-subtle bg-surface-2 px-3.5 py-3 text-[14px] font-medium text-text-primary outline-none transition-colors focus:border-primary"
            />
          </fieldset>

          <fieldset>
            <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">
              Cor do avatar
            </label>
            <div className="flex flex-wrap gap-2.5">
              {AVATAR_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Cor ${c}`}
                  onClick={() => {
                    markDirty();
                    setAvatarColor(c);
                  }}
                  className={`h-9 w-9 rounded-full transition-transform ${
                    avatarColor === c
                      ? "ring-2 ring-primary ring-offset-2 ring-offset-surface-1 scale-105"
                      : "hover:scale-105"
                  }`}
                  style={{ background: c }}
                />
              ))}
            </div>
          </fieldset>

          <fieldset>
            <label className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-text-muted">
              Estilo da saudação
            </label>
            <div className="flex gap-1 rounded-[14px] bg-surface-2 p-1 border border-border-subtle">
              {(["auto", "minimal", "verbose"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => {
                    markDirty();
                    setGreetingStyle(s);
                  }}
                  className={`flex-1 rounded-[10px] py-2 text-center text-[12px] font-bold transition-all ${
                    greetingStyle === s
                      ? "bg-surface-1 text-text-primary shadow-sm"
                      : "text-text-muted hover:text-text-secondary"
                  }`}
                >
                  {s === "auto"
                    ? "Automática"
                    : s === "minimal"
                      ? "Curta"
                      : "Detalhada"}
                </button>
              ))}
            </div>
          </fieldset>

          {error && (
            <div className="rounded-[12px] bg-danger-tint px-3 py-2 text-[12px] font-semibold text-danger">
              ⚠ {error}
            </div>
          )}

          <button
            type="button"
            disabled={submitting || name.trim().length === 0}
            onClick={async () => {
              setError(null);
              setSubmitting(true);
              try {
                await onSave({
                  name: name.trim(),
                  email: email.trim(),
                  phone: phone.trim(),
                  avatarColor,
                  greetingStyle,
                });
                markClean();
              } catch (e) {
                setError((e as Error).message || "Falha ao salvar");
              } finally {
                setSubmitting(false);
              }
            }}
            className="mt-2 w-full rounded-[14px] bg-primary py-3.5 text-center text-[15px] font-bold text-white shadow-fab transition-all hover:bg-primary-hover active:scale-[0.98] disabled:opacity-50"
          >
            {submitting ? "Salvando…" : "Salvar alterações"}
          </button>
        </div>
      </BottomSheet>
      <ConfirmActionDialog
        open={discardOpen}
        title="Descartar alterações?"
        message="Você tem alterações não salvas. Deseja sair sem salvar?"
        confirmLabel="Descartar"
        cancelLabel="Continuar editando"
        danger
        onConfirm={confirmDiscard}
        onCancel={() => setDiscardOpen(false)}
      />
    </>
  );
}
