import type { Metadata } from "next";
import localFont from "next/font/local";
import "./styles/tokens.css";
import "./globals.css";
import "./admin.css";
import "./styles/theme.css";
import "./history.css";

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

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="pl"><body className={`${newsreader.variable} ${hankenGrotesk.variable} ${ibmPlexMono.variable}`}>{children}</body></html>;
}
