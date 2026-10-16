import type { Metadata } from "next";
import AuthRecoveryForm from "../auth-recovery-forms";
import "../auth-recovery.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Potwierdź adres · Goldis", robots: { index: false, follow: false } };

export default function VerifyRecoveryEmailPage() { return <AuthRecoveryForm mode="verify" />; }
