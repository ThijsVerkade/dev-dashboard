import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import "../globals.css";

const terminalMono = JetBrains_Mono({
  variable: "--font-terminal-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "dev-dashboard — mobile",
  description: "Trigger and monitor agents from your phone.",
};

export default function MobileRootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`dark ${terminalMono.variable} h-full antialiased scanlines`}>
      <body className="min-h-full p-4">{children}</body>
    </html>
  );
}
