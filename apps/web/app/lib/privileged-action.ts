"use client";

import styles from "./privileged-action.module.css";

type PrivilegedMutation = Readonly<{
  csrfToken: string;
  action: string;
  targetId: string | null;
  url: string;
  method: string;
  payload: Record<string, unknown>;
}>;

const actionLabels: Readonly<Record<string, string>> = {
  "team.user.create": "utworzenie konta pracownika",
  "team.user.status": "zmianę statusu konta pracownika",
  "team.user.password": "reset hasła pracownika",
  "team.user.access": "zmianę dostępu do automatyzacji",
  "admin.user.create": "utworzenie konta użytkownika",
  "admin.user.grant.set": "zmianę uprawnień użytkownika",
  "admin.user.grant.revoke": "cofnięcie dostępu do narzędzia",
  "admin.user.deletion-grant": "zmianę uprawnienia kasowania danych",
  "admin.user.session.revoke": "cofnięcie sesji użytkownika",
  "admin.user.sessions.revoke": "cofnięcie sesji użytkownika",
  "admin.user.status": "zmianę statusu konta użytkownika",
  "admin.user.role": "zmianę roli użytkownika",
  "admin.user.password": "reset hasła użytkownika",
};

function askForCurrentPassword(action: string): Promise<string | null> {
  if (typeof document === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = styles.dialog;
    dialog.setAttribute("aria-labelledby", "privileged-action-title");
    const form = document.createElement("form");
    form.method = "dialog";
    const heading = document.createElement("h2");
    heading.id = "privileged-action-title";
    heading.textContent = "Potwierdź swoją tożsamość";
    const description = document.createElement("p");
    description.textContent = `Wpisz obecne hasło, aby potwierdzić ${actionLabels[action] ?? "tę zmianę"}. Potwierdzenie będzie ważne przez 5 minut tylko dla tej operacji.`;
    const label = document.createElement("label");
    label.textContent = "Obecne hasło";
    const input = document.createElement("input");
    input.type = "password";
    input.name = "currentPassword";
    input.autocomplete = "current-password";
    input.maxLength = 1024;
    input.required = true;
    label.append(input);
    const actions = document.createElement("div");
    actions.className = styles.actions;
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Anuluj";
    cancel.addEventListener("click", () => dialog.close());
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Potwierdź i wykonaj";
    actions.append(cancel, submit);
    form.append(heading, description, label, actions);
    dialog.append(form);
    document.body.append(dialog);
    let settled = false;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!input.reportValidity()) return;
      const password = input.value;
      input.value = "";
      settled = true;
      dialog.close();
      resolve(password);
    });
    dialog.addEventListener("close", () => {
      input.value = "";
      dialog.remove();
      if (!settled) resolve(null);
    }, { once: true });
    dialog.showModal();
    input.focus();
  });
}

async function jsonResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({})) as T & { message?: string };
  if (!response.ok) throw new Error(payload.message || `Żądanie nie powiodło się (${response.status})`);
  return payload;
}

export async function performPrivilegedMutation<T>(input: PrivilegedMutation): Promise<T> {
  let currentPassword = await askForCurrentPassword(input.action);
  if (currentPassword === null) throw new Error("Operacja została anulowana.");
  const idempotencyKey = crypto.randomUUID();
  let challenge: { token: string };
  let challengeResponse: Response;
  try {
    challengeResponse = await fetch("/api/admin/privileged-confirmations", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": input.csrfToken },
      body: JSON.stringify({ action: input.action, targetId: input.targetId, payload: input.payload, currentPassword, idempotencyKey }),
    });
  } finally {
    currentPassword = null;
  }
  challenge = await jsonResponse(challengeResponse);
  const requestBody = JSON.stringify({ ...input.payload, confirmationToken: challenge.token, idempotencyKey });
  let response: Response;
  try {
    response = await fetch(`/api${input.url}`, {
      method: input.method, credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": input.csrfToken }, body: requestBody,
    });
  } catch {
    response = await fetch(`/api${input.url}`, {
      method: input.method, credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": input.csrfToken }, body: requestBody,
    });
  }
  if (response.status >= 500 && response.status <= 599) {
    response = await fetch(`/api${input.url}`, {
      method: input.method, credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": input.csrfToken }, body: requestBody,
    });
  }
  return jsonResponse<T>(response);
}
