"use client";

import type { AgentMessage } from "@/lib/api/agent-client";
import { TedMarkdown } from "./TedMarkdown";

/**
 * SPEC §19.1: local optimistic delivery lifecycle of a user message.
 * `sent` renders no indicator; the authoritative history replaces the
 * bubble after a successful turn.
 */
export type TedDeliveryState = "sending" | "sent" | "failed";

interface TedMessageProps {
  message: AgentMessage;
  isCurrentUser: boolean;
  senderName?: string;
  delivery?: TedDeliveryState;
  /** SPEC §19.3: offered only for failed messages (retry keeps the draft). */
  onRetry?: () => void;
}

function avatarColor(actorId: string, role: string): string {
  if (role === "assistant") return "linear-gradient(135deg, #0E8C5A 0%, #0A5E3A 100%)";
  let hash = 0;
  for (let i = 0; i < actorId.length; i++) hash = (hash * 31 + actorId.charCodeAt(i)) >>> 0;
  const hues = [210, 262, 32, 12, 172, 152];
  const hue = hues[hash % hues.length]!;
  return `hsl(${hue} 58% 42%)`;
}

export function TedMessage({ message, isCurrentUser, senderName, delivery, onRetry }: TedMessageProps) {
  const isAssistant = message.role === "assistant";
  const displayName = isCurrentUser ? "Você" : isAssistant ? "TED" : (senderName || "Membro");
  const initial = isCurrentUser ? "V" : isAssistant ? "T" : (senderName || "M").charAt(0).toUpperCase();

  return (
    <div className={`flex w-full gap-2.5 ${isCurrentUser ? "justify-end" : "justify-start"} my-3`}>
      {!isCurrentUser && (
        <span
          className="flex h-7 w-7 flex-none items-center justify-center rounded-full text-[11px] font-bold text-white shadow-xs"
          style={{ background: avatarColor(message.actorId, message.role) }}
          aria-hidden="true"
        >
          {initial}
        </span>
      )}
      <div className={`flex max-w-[80%] flex-col ${isCurrentUser ? "items-end" : "items-start"}`}>
        <div className="mb-1 flex items-center gap-1.5">
          <span className={`text-[11px] font-bold tracking-tight ${isCurrentUser ? "text-primary" : isAssistant ? "text-primary" : "text-text-muted"}`}>
            {displayName}
          </span>
          <span className="text-[10px] text-text-muted font-medium">
            {message.createdAt ? new Date(message.createdAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : ""}
          </span>
          {isAssistant && <span className="inline-flex items-center rounded-full bg-primary-tint px-1.5 py-0.2 text-[9px] font-bold tracking-wide text-primary">IA</span>}
        </div>
        <div
          className={`relative rounded-[16px] px-3.5 py-2.5 text-[13.5px] leading-relaxed shadow-xs ${
            isCurrentUser
              ? "rounded-br-[4px] bg-primary text-white shadow-fab"
              : isAssistant
                ? "rounded-bl-[4px] border border-border-subtle bg-surface-2 text-text-primary"
                : "rounded-bl-[4px] border border-border-subtle bg-surface-3 text-text-secondary"
          }`}
        >
          {/* R05/AC11: markdown restrito SÓ para o assistente; usuário e
              membro continuam texto literal (nada de interpretá-los). */}
          <div className="whitespace-pre-wrap break-words">
            {isAssistant ? <TedMarkdown content={message.content} /> : message.content}
          </div>
          {Array.isArray((message as unknown as { attachments?: Array<{ type: string; url: string; name?: string }> }).attachments) &&
            (message as unknown as { attachments: Array<{ type: string; url: string; name?: string }> }).attachments.length > 0 && (
              <div className="mt-2 flex flex-col gap-2">
                {(message as unknown as { attachments: Array<{ type: string; url: string; name?: string }> }).attachments.map((att, idx) => {
                  if (att.type === "image") {
                    return (
                      <img
                        key={`${att.url}-${idx}`}
                        src={att.url}
                        alt={att.name || "imagem anexada"}
                        className="max-h-[220px] max-w-full rounded-[10px] border border-border-subtle object-cover"
                      />
                    );
                  }
                  if (att.type === "audio") {
                    return (
                      <audio
                        key={`${att.url}-${idx}`}
                        controls
                        src={att.url}
                        className="w-full max-w-[260px] rounded-[10px]"
                      />
                    );
                  }
                  if (att.type === "pdf") {
                    return (
                      <a
                        key={`${att.url}-${idx}`}
                        href={att.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 rounded-[10px] border border-border-subtle bg-surface-1 px-3 py-2 text-xs font-semibold text-primary hover:bg-surface-2"
                      >
                        <span>📄</span>
                        <span>{att.name || "documento.pdf"}</span>
                      </a>
                    );
                  }
                  return null;
                })}
              </div>
            )}
        </div>
        {delivery === "sending" && (
          <span className="mt-1 inline-flex items-center gap-1 text-[10px] font-semibold text-text-muted">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-text-muted" aria-hidden="true" />
            enviando…
          </span>
        )}
        {delivery === "failed" && (
          <span className="mt-1 inline-flex items-center gap-2 text-[10px] font-semibold text-danger">
            Falha no envio.
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-danger/40 bg-danger-tint px-2 py-0.5 text-[10px] font-bold text-danger transition-colors hover:bg-danger/10"
              >
                Tentar novamente
              </button>
            )}
          </span>
        )}
      </div>
      {isCurrentUser && (
        <span
          className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-surface-3 text-[11px] font-bold text-text-primary shadow-xs border border-border-subtle"
          aria-hidden="true"
        >
          {initial}
        </span>
      )}
    </div>
  );
}
