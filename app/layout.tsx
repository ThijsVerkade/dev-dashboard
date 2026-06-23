import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { TooltipProvider } from "@/components/ui/tooltip";

const terminalMono = JetBrains_Mono({
  variable: "--font-terminal-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "dev-dashboard",
  description: "GitLab pipelines, CloudWatch logs, and Claude activity — one terminal.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`dark ${terminalMono.variable} h-full antialiased scanlines`}
    >
      <body className="min-h-full flex flex-col">
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
