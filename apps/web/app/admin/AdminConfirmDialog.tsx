"use client";

import { useEffect, useRef } from "react";

export type AdminConfirmation = {
  title: string;
  description: string;
  confirmLabel: string;
  action: () => Promise<unknown>;
};

type AdminConfirmDialogProps = {
  confirmation: AdminConfirmation | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export function AdminConfirmDialog({ confirmation, busy, onCancel, onConfirm }: AdminConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (confirmation && !dialog.open) dialog.showModal();
    else if (!confirmation && dialog.open) dialog.close();
  }, [confirmation]);

  return <dialog ref={dialogRef} className="admin-confirm-dialog" role="alertdialog" aria-labelledby="admin-confirm-title" aria-describedby="admin-confirm-description"
    onCancel={(event) => { event.preventDefault(); onCancel(); }} onClick={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    {confirmation && <>
      <h2 id="admin-confirm-title">{confirmation.title}</h2>
      <p id="admin-confirm-description">{confirmation.description}</p>
      <div className="admin-confirm-actions">
        <button type="button" className="admin-quiet" disabled={busy} onClick={onCancel}>Anuluj</button>
        <button type="button" className="admin-button danger-button" disabled={busy} onClick={onConfirm}>{busy ? "Zapisywanie…" : confirmation.confirmLabel}</button>
      </div>
    </>}
  </dialog>;
}
