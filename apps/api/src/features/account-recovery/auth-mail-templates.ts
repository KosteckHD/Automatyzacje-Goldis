import { containsControlCharacters } from "../../shared/control-characters";
import type { AuthMailConfig } from "./auth-mail-config";

export type AuthMailContent = Readonly<{
  from: string;
  to: string;
  replyTo: string | null;
  subject: string;
  html: string;
  text: string;
}>;

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

function wrap(
  heading: string,
  paragraph: string,
  action?: Readonly<{ label: string; url: string }>,
): Readonly<{ html: string; text: string }> {
  const button = action ? `<p><a href="${escapeHtml(action.url)}">${escapeHtml(action.label)}</a></p>` : "";
  return {
    html: `<!doctype html><html lang="pl"><body><main><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(paragraph)}</p>${button}<p>Jeśli nie zlecałeś tej operacji, zignoruj tę wiadomość i skontaktuj się z administratorem platformy.</p></main></body></html>`,
    text: `${heading}\n\n${paragraph}${action ? `\n\n${action.label}: ${action.url}` : ""}\n\nJeśli nie zlecałeś tej operacji, zignoruj tę wiadomość i skontaktuj się z administratorem platformy.`,
  };
}

function link(origin: string, route: string, rawToken: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(rawToken)) throw new Error("AUTH_MAIL_TOKEN_INVALID");
  return `${origin}${route}#token=${rawToken}`;
}

function create(
  config: AuthMailConfig,
  to: string,
  subject: string,
  body: Readonly<{ html: string; text: string }>,
): AuthMailContent {
  if (!config.enabled || !config.from || !to || containsControlCharacters(to))
    throw new Error("AUTH_MAIL_CONFIGURATION_INVALID");
  return { from: config.from, to, replyTo: config.replyTo, subject, ...body };
}

export function passwordResetMail(config: AuthMailConfig, to: string, rawToken: string): AuthMailContent {
  const body = wrap(
    "Ustaw nowe hasło do Goldis",
    "Otrzymaliśmy prośbę o ustawienie nowego hasła. Link wygaśnie za 15 minut.",
    { label: "Ustaw nowe hasło", url: link(config.publicOrigin, "/reset-hasla", rawToken) },
  );
  return create(config, to, "Link do ustawienia nowego hasła w Goldis", body);
}

export function verifyRecoveryEmailMail(config: AuthMailConfig, to: string, rawToken: string): AuthMailContent {
  const body = wrap(
    "Potwierdź adres odzyskiwania konta",
    "Aby używać tego adresu do odzyskiwania konta Goldis, potwierdź go w ciągu 24 godzin.",
    { label: "Potwierdź adres e-mail", url: link(config.publicOrigin, "/potwierdz-email", rawToken) },
  );
  return create(config, to, "Potwierdź adres odzyskiwania w Goldis", body);
}

export function passwordChangedNoticeMail(config: AuthMailConfig, to: string): AuthMailContent {
  return create(
    config,
    to,
    "Hasło do Goldis zostało zmienione",
    wrap(
      "Hasło zostało zmienione",
      "Hasło do Twojego konta Goldis zostało ustawione. Jeśli nie rozpoznajesz tej operacji, skontaktuj się z administratorem.",
    ),
  );
}

export function recoveryEmailChangedNoticeMail(config: AuthMailConfig, to: string): AuthMailContent {
  return create(
    config,
    to,
    "Zmieniono adres odzyskiwania konta Goldis",
    wrap(
      "Zmieniono adres odzyskiwania",
      "Adres używany do odzyskiwania konta Goldis został zmieniony. Jeśli nie rozpoznajesz tej operacji, skontaktuj się z administratorem.",
    ),
  );
}
