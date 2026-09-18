import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Harness Control Surface · Compiled Runtime POC",
  description:
    "Desktop-first control surface for inspecting admitted compiled HarnessPlan contracts, live execution runs, and Capability Gateway receipts.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-[#F7F8F4] text-[#26312B] antialiased">
        {children}
      </body>
    </html>
  );
}
