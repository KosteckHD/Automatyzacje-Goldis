export const AUTH_MAIL_PROVIDER = "GOLDIS_AUTH_MAIL_PROVIDER";

export type AuthMailMessage = Readonly<{
  idempotencyKey: string;
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
}>;

export type AuthMailSendResult =
  | Readonly<{ kind: "submitted"; providerMessageId: string }>
  | Readonly<{ kind: "retry"; errorCode: string; retryAfterSeconds?: number }>
  | Readonly<{ kind: "failed"; errorCode: string }>;

export interface AuthMailProvider {
  send(message: AuthMailMessage): Promise<AuthMailSendResult>;
}
