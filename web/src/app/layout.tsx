import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { ChatDock } from "@/app/chat-dock";
import { CookieConsent } from "@/app/cookie-consent";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Chez.Trading - Trade CS2 skins fast",
  description: "Ручной обмен скинами CS2",
  icons: {
    icon: [{ url: "/favicon.jpg", type: "image/jpeg" }],
    apple: "/favicon.jpg",
    shortcut: "/favicon.jpg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ru"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-screen flex-col">
        {children}
        <ChatDock />
        <CookieConsent />
      </body>
    </html>
  );
}
