"use client";

import { loginHref } from "../../app/lib/return-to";

export default function SessionRequired({ returnTo, title, description }: {
  returnTo: string;
  title: string;
  description: string;
}) {
  const href = typeof window === "undefined" ? "/" : loginHref(returnTo, window.location.origin);
  return <main className="lead-auth-required">
    <h1>{title}</h1>
    <p>{description}</p>
    <a className="lead-primary" href={href}>Zaloguj się i wróć do tej strony</a>
  </main>;
}
