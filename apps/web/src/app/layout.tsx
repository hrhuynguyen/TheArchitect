import type { Metadata } from "next";
import type { ReactNode } from "react";
import { APP_NAME } from "@architect/contracts";
import "@architect/ui/tokens.css";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: APP_NAME,
    template: `%s · ${APP_NAME}`,
  },
  description: "Sketch, architect, and deploy software systems in one guided workspace.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
