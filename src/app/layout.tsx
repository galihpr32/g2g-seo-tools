import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "G2G SEO Tools",
  description: "G2G Marketing — SEO Automation Dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col font-sans">{children}</body>
    </html>
  );
}
