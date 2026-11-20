import type { Metadata } from "next";
import localFont from "next/font/local";
import { connection } from "next/server";
import { ActivitySignal } from "./activity-signal";
import PlatformRouteFrame from "./platform-route-frame";
import MainContentTarget from "./main-content-target";
import "./styles/tokens.css";
import "./globals.css";
import "./admin.css";
import "./styles/theme.css";
import "./history.css";
import "./review.css";
import "./enrichment-jobs.css";
import "./run-submissions.css";
import "./import-preparations.css";
import "./legacy-platform-frame.css";
import "./styles/light-theme.css";

const newsreader = localFont({
  src: "./fonts/Newsreader.ttf",
  variable: "--font-display",
  display: "swap",
  weight: "300 700",
  style: "normal",
});

const hankenGrotesk = localFont({
  src: "./fonts/HankenGrotesk.ttf",
  variable: "--font-body",
  display: "swap",
  weight: "100 900",
  style: "normal",
});

const ibmPlexMono = localFont({
  src: "./fonts/IBMPlexMono-Regular.ttf",
  variable: "--font-data",
  display: "swap",
  weight: "400",
  style: "normal",
  preload: false,
});

export const metadata: Metadata = {
  title: "Goldis · Narzędzia",
  description: "Panel automatyzacji Goldis Ubezpieczenia",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  await connection();
  return <html lang="pl"><body className={`${newsreader.variable} ${hankenGrotesk.variable} ${ibmPlexMono.variable}`}>
    <a className="skip-link" href="#main-content">Przejdź do głównej treści</a>
    <div className="skip-target"><ActivitySignal /><PlatformRouteFrame>{children}</PlatformRouteFrame><MainContentTarget /></div>
  </body></html>;
}
