import type { Metadata } from "next";
import AuthRecoveryForm from "../auth-recovery-forms";
import "../auth-recovery.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Ustaw nowe hasło · Goldis", robots: { index: false, follow: false } };

export default function ResetPasswordPage() { return <AuthRecoveryForm mode="reset" />; }
