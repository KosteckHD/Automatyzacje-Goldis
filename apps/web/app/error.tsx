"use client";

import Link from "next/link";
import styles from "./error.module.css";

export default function ErrorPage({ retry }: { error: unknown; retry: () => void }) {
  return (
    <main className={styles.page}>
      <div className={styles.content} role="alert">
        <h1>Nie udało się wyświetlić strony</h1>
        <p>Spróbuj ponownie. Jeśli problem nadal występuje, wróć do przeglądu i otwórz tę stronę ponownie.</p>
        <div className={styles.actions}>
          <button type="button" onClick={retry}>Spróbuj ponownie</button>
          <Link href="/dashboard">Wróć do przeglądu</Link>
        </div>
      </div>
    </main>
  );
}
