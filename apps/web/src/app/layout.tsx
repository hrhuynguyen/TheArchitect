import type { Metadata } from "next";
import type { ReactNode } from "react";
import { APP_NAME } from "@architect/contracts";
import "./globals.css";

export const metadata: Metadata = {
  title: APP_NAME,
  description: "Plan and visualize software architecture.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
