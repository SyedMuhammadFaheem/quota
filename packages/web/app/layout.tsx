import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Claude Quota",
  description: "Local Claude usage/cooldown dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
